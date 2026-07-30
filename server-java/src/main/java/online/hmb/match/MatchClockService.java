package online.hmb.match;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import online.hmb.common.TxRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 서버 권위 시계 (P4-D1/D2, #170 — docs/plan-v5/LLD-e2-flow-clock.md §3·§4·§7).
 *
 * <p><b>역할 경계</b>: 서버는 "지금 어느 단계이고 그 단계가 언제 시작해 언제 끝나는가"(=창)만 소유한다.
 * 재생 위치(틱)는 클라가 그 창 안에서 계산한다({@code packages/shared/src/match-clock.ts}). 덕분에
 * 서버는 로그의 틱 수를 몰라도 되고(엔진 config 가 바뀌어도 무변경), 같은 로그+같은 창이면 어느 클라가
 * 언제 열어도 같은 틱이 나온다(AC-W3-1).
 *
 * <p><b>재현·멱등(AC-W2-3)</b>: 만료 전이는 판정도 기록도 <b>{@code now} 가 아니라 직전 경계값
 * ({@code phase_ends_at})</b>을 쓴다. 스위퍼가 늦게 돌든 서버가 죽었다 살아나든
 * {@code HALFTIME.phase_start_at == kickoffAt + halfRealMs} 가 항상 성립한다(누적 오차 0).
 * 전이는 전부 CAS(state + 읽었던 경계값 동시 일치)라 스위퍼 N개와 GET M개가 동시에 들어와도 1회만 성공한다.
 *
 * <p><b>시각 표기</b>: 시계 컬럼은 밀리초 3자리 고정 ISO-8601 로 쓴다({@link #format}).
 * {@code Instant.toString()} 은 뒤따르는 0 을 생략해(`...:00Z` vs `...:00.500Z`) 문자열 비교가
 * 뒤집히기 때문이다 — 만료 후보 스캔이 SQL 문자열 비교이므로 이 고정 포맷이 정확성의 전제다.
 */
@Service
public class MatchClockService {

    private static final Logger log = LoggerFactory.getLogger(MatchClockService.class);

    /** 밀리초 3자리 고정 — 문자열 비교 = 시각 비교가 성립하는 유일한 표기(위 주석 참고). */
    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** 라이브 단계(시계가 도는 상태) — 만료 후보 스캔 대상. */
    private static final List<String> LIVE_STATES =
            List.of(MatchService.S_FIRST_HALF, MatchService.S_HALFTIME, MatchService.S_SECOND_HALF);

    /** 한 번의 advanceDue 가 밟을 수 있는 최대 전이 수(FIRST_HALF→HALFTIME→GEN2 = 2). 무한루프 가드. */
    private static final int MAX_CHAIN = 4;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final MatchClockProperties props;
    private final MatchAutoProperties autoProps;
    private final Clock clock;
    private final org.springframework.beans.factory.ObjectProvider<MatchOrchestrator> orchestrator;
    /** 만료 스윕 실행 풀 — 매치 간 head-of-line 블로킹 방지(스케줄러 스레드와 분리). */
    private final java.util.concurrent.ExecutorService sweepPool;

    public MatchClockService(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             MatchClockProperties props,
                             MatchAutoProperties autoProps,
                             Clock clock,
                             org.springframework.beans.factory.ObjectProvider<MatchOrchestrator> orchestrator) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.props = props;
        this.autoProps = autoProps;
        this.clock = clock;
        this.orchestrator = orchestrator;
        this.sweepPool = java.util.concurrent.Executors.newFixedThreadPool(
                Math.max(1, props.getSweepParallelism()),
                r -> {
                    Thread t = new Thread(r, "match-clock-sweep");
                    t.setDaemon(true);
                    return t;
                });
    }

    @jakarta.annotation.PreDestroy
    public void shutdown() {
        sweepPool.shutdownNow();
    }

    /** openapi {@code MatchClock} — MatchDetail 에 실리는 시계 블록. */
    public record MatchClock(String phase, String kickoffAt, String phaseStartAt, String phaseEndsAt,
                             String serverNow, long halfRealMs, long halftimeMs,
                             boolean seekForwardBlocked, long seekGraceMs) {
    }

    private record ClockRow(String state, String kickoffAt, String phaseStartAt, String phaseEndsAt) {
    }

    // ── 시각 유틸 ───────────────────────────────────────────────────────

    public static String format(Instant instant) {
        return ISO_MILLIS.format(instant.truncatedTo(ChronoUnit.MILLIS));
    }

    public Instant now() {
        return clock.instant();
    }

    public String nowText() {
        return format(now());
    }

    /** 진입 시각 + 하프 재생 길이 = 그 단계 종료 예정 시각. */
    public String liveWindowEnd(Instant start) {
        return format(start.plusMillis(props.getHalfRealMs()));
    }

    public boolean enabled() {
        return props.isEnabled();
    }

    // ── 조회 ────────────────────────────────────────────────────────────

    /** 라이브 단계가 아니거나 시계 미적용(레거시·롤백)이면 null. */
    public MatchClock clockOf(String matchId) {
        return clockRow(matchId).map(this::toClock).orElse(null);
    }

    public MatchClock clockOf(MatchService.MatchRow row) {
        if (row == null) {
            return null;
        }
        return toClock(new ClockRow(row.state(), row.kickoffAt(), row.phaseStartAt(), row.phaseEndsAt()));
    }

    private MatchClock toClock(ClockRow row) {
        if (!LIVE_STATES.contains(row.state()) || row.phaseEndsAt() == null) {
            return null; // 생성/종료 단계이거나 시계 미적용 매치
        }
        return new MatchClock(row.state(), row.kickoffAt(), row.phaseStartAt(), row.phaseEndsAt(),
                nowText(), props.getHalfRealMs(), props.getHalftimeMs(),
                props.getSeek().isForwardBlocked(), props.getSeek().getGraceMs());
    }

    private Optional<ClockRow> clockRow(String matchId) {
        return jdbcClient.sql("""
                        SELECT state, kickoff_at, phase_start_at, phase_ends_at
                        FROM matches WHERE id = ?
                        """)
                .param(matchId)
                .query((rs, n) -> new ClockRow(rs.getString("state"), rs.getString("kickoff_at"),
                        rs.getString("phase_start_at"), rs.getString("phase_ends_at")))
                .optional();
    }

    // ── 만료 전이 ───────────────────────────────────────────────────────

    /**
     * 이 매치의 만료된 단계를 <b>연쇄로</b> 진행시킨다(멱등). 서버가 오래 죽어 있었으면 한 호출에서
     * FIRST_HALF→HALFTIME→GEN2 까지 따라잡는다. 만료 전이가 없으면 아무 것도 하지 않는다.
     *
     * <p>후반 시작(HALFTIME→GEN2)은 <b>무거운</b> 전이다 — 인풋 승계(AI 콜 0)면 그 자리에서 엔진 RPC 로
     * 후반 한 하프를 통째로 시뮬한다. 그래서 이 메서드는 <b>스위퍼(백그라운드)</b> 전용이고,
     * 요청 스레드(GET)는 {@link #advanceDueForRead} 를 쓴다(독립검증 major: 1초 폴링이 시뮬 동안 블록됨).
     */
    public void advanceDue(String matchId) {
        advanceChain(matchId, true);
    }

    /**
     * 조회 경로용 — <b>가벼운 만료 전이만</b> 반영한다(전반 종료→감독시간, 후반 종료→정산).
     * 후반 시작처럼 엔진 RPC 가 딸린 전이는 스위퍼(≤ sweep-interval-ms)에 맡겨 요청을 붙잡지 않는다.
     */
    public void advanceDueForRead(String matchId) {
        advanceChain(matchId, false);
    }

    private void advanceChain(String matchId, boolean allowHeavy) {
        for (int i = 0; i < MAX_CHAIN; i++) {
            if (!advanceOnce(matchId, allowHeavy)) {
                return;
            }
        }
        log.warn("clock advance chain 상한 도달 — match {} (설정 오류 의심)", matchId);
    }

    /**
     * 만료 판정 — 경계 <b>동치도 만료</b>다(`now == phaseEndsAt` 이면 그 단계는 끝났다).
     * 두 값 모두 {@link #format} 의 고정 폭 표기라 문자열 비교 = 시각 비교다(클래스 주석 참고).
     */
    public static boolean isDue(String now, String phaseEndsAt) {
        return phaseEndsAt != null && now.compareTo(phaseEndsAt) >= 0;
    }

    /** @return 전이가 1회 일어났으면 true. */
    private boolean advanceOnce(String matchId, boolean allowHeavy) {
        ClockRow row = clockRow(matchId).orElse(null);
        if (row == null || row.phaseEndsAt() == null) {
            return false; // 시계 미적용(레거시·롤백) 또는 생성/종료 단계
        }
        if (!isDue(nowText(), row.phaseEndsAt())) {
            return false; // 아직 창 안
        }

        return switch (row.state()) {
            // 오토(#249)는 감독시간을 0초로 열고 같은 체인에서 GEN2 까지 잇는다 = 후반 시작이 딸려온다.
            // 그래서 **조회 경로에서는 시작조차 하지 않는다** — 0초 하프타임만 열어놓고 멈추면 만료된
            // 감독시간이 화면에 노출된다(≤1s). 스위퍼가 두 전이를 한 호출에 밟게 통째로 미룬다.
            case MatchService.S_FIRST_HALF ->
                    (allowHeavy || !autoOf(matchId)) && openHalftime(matchId, row.phaseEndsAt());
            // 후반 시작은 엔진 RPC 를 물고 있다 — 조회 경로에서는 하지 않는다(스위퍼가 곧 집어간다).
            case MatchService.S_HALFTIME -> allowHeavy && resumeOnExpiry(matchId, row.phaseEndsAt());
            case MatchService.S_SECOND_HALF ->
                    orchestrator.getObject().settleFinishedIfDue(matchId, row.phaseEndsAt());
            default -> false;
        };
    }

    /**
     * 전반 종료 → 감독시간 오픈. 시작은 <b>경계(=전반 종료 예정 시각)</b>다 — 스위퍼가 늦게 돌았다고
     * 감독시간이 길어지지 않는다.
     */
    private boolean openHalftime(String matchId, String boundary) {
        // 오토(#249)면 감독시간 길이가 **0** 이다 — 열자마자 만료라 같은 advanceChain 루프의 다음 바퀴가
        // 곧바로 GEN2 로 잇는다(새 전이 엣지 0, hero 컨펌 Q1). 아니면 현행 halftimeMs 그대로.
        //
        // ⚠️ 플래그를 SELECT 해서 분기하지 않는다 — 읽기와 전이 사이에 유저가 토글하면 **찢어진 읽기**가
        // 난다(오토인데 3분 감독시간이 열리거나 그 반대). 두 UPDATE 를 순서대로 시도하고 auto_mode 를
        // WHERE 절에 넣어 **플래그 판정과 전이를 원자적으로** 묶는다. 정확히 하나만 성공한다.
        // 둘 다 0행 = 그 찰나에 토글이 뒤집힌 것 → false 반환 → 다음 스위프(≤1s)가 새 값으로 재판정한다.
        if (autoProps.isEnabled() && casOpenHalftime(matchId, boundary, boundary, 1)) {
            return true;
        }
        String deadline = format(Instant.parse(boundary).plusMillis(props.getHalftimeMs()));
        // 킬스위치가 내려가 있으면 플래그를 아예 보지 않는다(이미 켜 둔 매치도 정상 감독시간으로 복귀).
        Integer autoFilter = autoProps.isEnabled() ? 0 : null;
        return casOpenHalftime(matchId, boundary, deadline, autoFilter);
    }

    /** @param autoMode WHERE 절에 요구할 auto_mode 값. null = 플래그를 보지 않는다(킬스위치). */
    private boolean casOpenHalftime(String matchId, String boundary, String deadline, Integer autoMode) {
        String autoClause = autoMode == null ? "" : " AND auto_mode = " + autoMode;
        return jdbcClient.sql("""
                        UPDATE matches SET state = ?, phase_start_at = ?, phase_ends_at = ?
                        WHERE id = ? AND state = ? AND phase_ends_at = ?
                        """ + autoClause)
                .params(MatchService.S_HALFTIME, boundary, deadline, matchId,
                        MatchService.S_FIRST_HALF, boundary)
                .update() == 1;
    }

    /** 이 매치가 오토 모드인가 — 킬스위치가 내려가 있으면 항상 false(플래그를 보지 않는다). */
    private boolean autoOf(String matchId) {
        if (!autoProps.isEnabled()) {
            return false;
        }
        return Boolean.TRUE.equals(jdbcClient.sql("SELECT auto_mode FROM matches WHERE id = ?")
                .param(matchId)
                .query((rs, n) -> rs.getInt("auto_mode") == 1)
                .optional()
                .orElse(false));
    }

    /**
     * 감독시간 만료 → 후반 시뮬 트리거(AC-W2-1). 하프타임 프롬프트를 아무것도 안 냈으면 후반 인풋은
     * <b>전반 인풋 그대로 승계</b>된다(AI 콜 0) — 그 분기는 {@link MatchOrchestrator#enqueueHalf} 소관이다.
     */
    private boolean resumeOnExpiry(String matchId, String boundary) {
        // 오토(#249)는 이 운영 스위치의 예외다. 오토가 여는 감독시간은 길이가 0 이라 "대기"라는 개념이
        // 없고, 여기서 막으면 매치가 **만료된 0초 감독시간에 영구히 갇힌다**(스위퍼가 후보에서 빼므로
        // 되살릴 경로도 없다). 스위치의 의도는 "유저에게 지시할 시간을 강제로 준다"인데, 오토는 유저가
        // 그 시간을 명시적으로 포기한 상태다.
        if (!props.isAutoResumeOnExpiry() && !autoOf(matchId)) {
            return false; // 만료해도 대기(운영 스위치) — 유저 제출만이 후반을 연다
        }
        boolean moved = txRunner.run(() -> jdbcClient.sql("""
                        UPDATE matches SET state = ?, phase_start_at = NULL, phase_ends_at = NULL
                        WHERE id = ? AND state = ? AND phase_ends_at = ?
                        """)
                .params(MatchService.S_GEN2, matchId, MatchService.S_HALFTIME, boundary)
                .update() == 1);
        if (moved) {
            orchestrator.getObject().enqueueHalf(matchId, 2);
        }
        return moved;
    }

    // ── 스위퍼 진입점 ───────────────────────────────────────────────────

    /** 만료된 라이브 매치를 전부 진행시킨다. @return 진행시킨 매치 수. */
    public int advanceAllDue() {
        String now = nowText();
        // auto-resume 이 꺼져 있으면 감독시간은 유저 제출로만 끝난다 → 후보에서 빼서 매초 헛도는
        // 재선택(만료된 채 영원히 남는 행)을 만들지 않는다.
        String halftimeCandidate = props.isAutoResumeOnExpiry() ? MatchService.S_HALFTIME : "";
        // ⚠️ 오토 매치(#249)는 스위치가 내려가 있어도 HALFTIME 후보에 남겨야 한다. 오토가 여는
        // 감독시간은 0초라 그 상태를 지나가는 중일 뿐인데, 후보에서 빼면 **만료된 0초 감독시간에
        // 영구히 갇힌다**. 두 전이 사이에 프로세스가 죽었을 때의 복구 경로도 이 항이 겸한다.
        int autoCandidate = autoProps.isEnabled() ? 1 : -1;
        List<String> due = jdbcClient.sql("""
                        SELECT id FROM matches
                        WHERE (state IN ('FIRST_HALF','SECOND_HALF', ?)
                               OR (state = 'HALFTIME' AND auto_mode = ?))
                          AND phase_ends_at IS NOT NULL AND phase_ends_at <= ?
                        """)
                .params(halftimeCandidate, autoCandidate, now)
                .query(String.class)
                .list();
        // 무거운 전이(후반 시작 = 동기 엔진 RPC)가 하나 끼면 순차 처리로는 그 시간만큼 **다른 모든 매치의
        // 시계가 멈춘다**(독립검증 major). 매치별로 병렬 실행하되 완료를 기다려 semantics 는 동기로 둔다
        // (테스트가 sweep() 반환 후 상태를 그대로 단정할 수 있어야 한다).
        List<java.util.concurrent.Future<?>> pending = new java.util.ArrayList<>(due.size());
        for (String matchId : due) {
            pending.add(sweepPool.submit(() -> {
                try {
                    advanceDue(matchId);
                } catch (Exception e) {
                    // 한 매치의 실패가 나머지 매치의 시계를 멈추게 두지 않는다.
                    log.error("clock advance 실패 — match {}: {}", matchId, e.toString());
                }
            }));
        }
        for (java.util.concurrent.Future<?> f : pending) {
            try {
                f.get();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                log.error("clock sweep 작업 실패: {}", e.toString());
            }
        }
        return due.size();
    }
}
