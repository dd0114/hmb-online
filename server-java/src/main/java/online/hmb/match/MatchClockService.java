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
    private final Clock clock;
    private final org.springframework.beans.factory.ObjectProvider<MatchOrchestrator> orchestrator;

    public MatchClockService(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             MatchClockProperties props,
                             Clock clock,
                             org.springframework.beans.factory.ObjectProvider<MatchOrchestrator> orchestrator) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.props = props;
        this.clock = clock;
        this.orchestrator = orchestrator;
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
     */
    public void advanceDue(String matchId) {
        for (int i = 0; i < MAX_CHAIN; i++) {
            if (!advanceOnce(matchId)) {
                return;
            }
        }
        log.warn("clock advance chain 상한 도달 — match {} (설정 오류 의심)", matchId);
    }

    /** @return 전이가 1회 일어났으면 true. */
    private boolean advanceOnce(String matchId) {
        ClockRow row = clockRow(matchId).orElse(null);
        if (row == null || row.phaseEndsAt() == null) {
            return false; // 시계 미적용(레거시·롤백) 또는 생성/종료 단계
        }
        String now = nowText();
        if (now.compareTo(row.phaseEndsAt()) < 0) {
            return false; // 아직 창 안
        }

        return switch (row.state()) {
            case MatchService.S_FIRST_HALF -> openHalftime(matchId, row.phaseEndsAt());
            case MatchService.S_HALFTIME -> resumeOnExpiry(matchId, row.phaseEndsAt());
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
        String deadline = format(Instant.parse(boundary).plusMillis(props.getHalftimeMs()));
        int updated = jdbcClient.sql("""
                        UPDATE matches SET state = ?, phase_start_at = ?, phase_ends_at = ?
                        WHERE id = ? AND state = ? AND phase_ends_at = ?
                        """)
                .params(MatchService.S_HALFTIME, boundary, deadline, matchId,
                        MatchService.S_FIRST_HALF, boundary)
                .update();
        return updated == 1;
    }

    /**
     * 감독시간 만료 → 후반 시뮬 트리거(AC-W2-1). 하프타임 프롬프트를 아무것도 안 냈으면 후반 인풋은
     * <b>전반 인풋 그대로 승계</b>된다(AI 콜 0) — 그 분기는 {@link MatchOrchestrator#enqueueHalf} 소관이다.
     */
    private boolean resumeOnExpiry(String matchId, String boundary) {
        if (!props.isAutoResumeOnExpiry()) {
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
        List<String> due = jdbcClient.sql("""
                        SELECT id FROM matches
                        WHERE state IN ('FIRST_HALF','HALFTIME','SECOND_HALF')
                          AND phase_ends_at IS NOT NULL AND phase_ends_at <= ?
                        """)
                .param(now)
                .query(String.class)
                .list();
        for (String matchId : due) {
            try {
                advanceDue(matchId);
            } catch (Exception e) {
                // 한 매치의 실패가 나머지 매치의 시계를 멈추게 두지 않는다.
                log.error("clock advance 실패 — match {}: {}", matchId, e.toString());
            }
        }
        return due.size();
    }
}
