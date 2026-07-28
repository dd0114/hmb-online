package online.hmb.match;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 매치 잠금·재입장 (#217) — <b>"유저에게 끝나지 않은 매치는 최대 하나"</b>를 강제하고, 그 하나를
 * 항상 되찾을 수 있게 하며, 영원히 갇히지 않게 회수 경로를 준다.
 *
 * <p><b>왜 서비스가 따로인가</b>: 잠금은 매치 도메인의 규칙이지만 소비자는 매치 밖이다
 * (덱·성장·트레이드·리그). {@link MatchService} 에 얹으면 그 소비자들이 매치 생성·전이·스냅샷까지
 * 다 끌고 오게 되고(=DeckService 를 무는 빈 그래프), 이 클래스는 {@code JdbcClient} 만 물어
 * 어느 도메인에서 불러도 순환이 생기지 않는다.
 *
 * <p><b>두 단계 잠금</b>(근거는 {@link MatchService#ACTIVE_STATES}·{@link MatchService#LOCKED_STATES}
 * 주석):
 * <ul>
 *   <li>{@link #assertCanCreateMatch} — ACTIVE 면 새 매치 금지(브리핑 포함). AC2 본문.</li>
 *   <li>{@link #assertNotLocked} — LOCKED 면 <b>진행 중 매치의 로스터·유효스탯을 바꿀 수 있는 쓰기</b>
 *       금지. 서버는 실제로 해가 있는 곳만 막고(과잉 409 는 stale 탭을 복구 불능으로 만든다),
 *       "경기 보러 가라"는 UX 잠금은 web 이 라우팅으로 한다.</li>
 * </ul>
 */
@Service
public class MatchLockService {

    private static final Logger log = LoggerFactory.getLogger(MatchLockService.class);

    /** openapi ErrorCode — web 이 이 코드로 "이어하기" 안내를 띄운다. */
    public static final String CODE_MATCH_IN_PROGRESS = "MATCH_IN_PROGRESS";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final MatchService matchService;
    private final MatchAbandonProperties props;
    private final Clock clock;
    /** #245 D1 — 원정 자발적 포기 = 몰수패 정산. */
    private final online.hmb.away.AwayService awayService;

    public MatchLockService(JdbcClient jdbcClient,
                            TxRunner txRunner,
                            MatchService matchService,
                            MatchAbandonProperties props,
                            Clock clock,
                            online.hmb.away.AwayService awayService) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.matchService = matchService;
        this.props = props;
        this.clock = clock;
        this.awayService = awayService;
    }

    // ── 조회 ────────────────────────────────────────────────────────────

    /**
     * 이 유저의 "끝나지 않은 매치". 계약상 최대 1개지만, 잠금 도입 이전에 만들어진 계정에는 여러 건이
     * 남아 있을 수 있다(V19 가 유저당 최신 1건만 남기고 회수하지만, 그 사이 레이스·부분 롤백을 가정한다).
     * 그래서 <b>결정론적으로 하나를 고른다</b>: 이미 킥오프한 매치(LOCKED) 우선, 그 다음 최신 —
     * 유저가 실제로 "안에 있는" 매치로 돌아가는 것이 재입장의 목적이기 때문이다.
     */
    public Optional<MatchService.MatchRow> activeMatch(String userId) {
        String id = jdbcClient.sql("""
                        SELECT id FROM matches
                        WHERE user_id = ? AND state NOT IN ('FINISHED', 'ABANDONED')
                        ORDER BY CASE WHEN state = 'BRIEFING' THEN 1 ELSE 0 END ASC,
                                 created_at DESC, id DESC
                        LIMIT 1
                        """)
                .param(userId)
                .query(String.class)
                .optional()
                .orElse(null);
        return id == null ? Optional.empty() : matchService.find(id);
    }

    /** LOCKED = 이미 킥오프해서 되돌릴 수 없는 매치(강제 재입장 + 메타 쓰기 잠금 대상). */
    public static boolean isLocked(MatchService.MatchRow row) {
        return row != null && MatchService.LOCKED_STATES.contains(row.state());
    }

    // ── 게이트 ──────────────────────────────────────────────────────────

    /** 새 매치 생성(연습·리그) 진입점. ACTIVE 매치가 있으면 409. */
    public void assertCanCreateMatch(String userId) {
        activeMatch(userId).ifPresent(row -> {
            throw inProgress(row, "createMatch",
                    "진행 중인 경기가 있습니다 — 그 경기를 마치거나 포기한 뒤 새로 시작할 수 있습니다");
        });
    }

    /**
     * 진행 중 매치의 로스터·유효스탯을 바꿀 수 있는 쓰기 진입점. LOCKED 매치가 있으면 409.
     *
     * @param action 감사·web 안내용 액션 이름(예: {@code "deck.replace"})
     */
    public void assertNotLocked(String userId, String action) {
        activeMatch(userId).filter(MatchLockService::isLocked).ifPresent(row -> {
            throw inProgress(row, action,
                    "경기가 진행 중입니다 — 경기가 끝난 뒤에 변경할 수 있습니다");
        });
    }

    private static ApiException inProgress(MatchService.MatchRow row, String action, String message) {
        return new ApiException(HttpStatus.CONFLICT, CODE_MATCH_IN_PROGRESS, message,
                Map.of("matchId", row.id(), "state", row.state(), "action", action));
    }

    // ── 회수 (AC3 — 영구 잠금 금지) ─────────────────────────────────────

    /**
     * 지금 이 매치를 유저가 포기할 수 있는가.
     *
     * <p>정상 재생 중(GEN1/FIRST_HALF/…)에는 <b>일부러 막는다</b> — 시계가 반드시 FINISHED 까지 밀기
     * 때문에 탈출구가 필요 없고, 열어두면 지고 있는 경기를 버리고 다시 뽑는 리롤이 된다(리그는 픽스처
     * 리롤까지 된다). 열어주는 경우는 셋뿐이고 전부 "유저가 결과를 아직 보지 못했거나, 시스템이 멈췄다":
     * <ol>
     *   <li>{@code BRIEFING} — 킥오프 전. 재생성해도 얻는 정보가 없다.</li>
     *   <li>{@code FAILED} — 생성 자체가 실패해 로그가 없다.</li>
     *   <li><b>멈춘 라이브</b> — {@code phase_ends_at} 가 {@code stuck-grace-ms} 넘게 지났는데도 상태가
     *       그대로. 시계·스위퍼가 죽었다는 뜻이라 이건 플레이가 아니라 사고다.</li>
     *   <li><b>멈춘 생성</b> — GEN1/GEN2 가 {@code gen-stuck-ms} 넘게 아무 진전이 없다
     *       ({@link #isGenStuck}). 원래는 {@code JobLeaseSweeper} 가 다 잡는다고 봤지만 그건
     *       <b>미완 잡이 있을 때만</b>이라, 잡이 전부 done 인데 전이가 커밋되지 않은 사고는
     *       어느 스위퍼에도 걸리지 않았다(독립검증 MAJOR-1).</li>
     * </ol>
     */
    public boolean abandonable(MatchService.MatchRow row) {
        if (row == null || !MatchService.ACTIVE_STATES.contains(row.state())) {
            return false;
        }
        if (MatchService.S_BRIEFING.equals(row.state()) || MatchService.S_FAILED.equals(row.state())) {
            return true;
        }
        return isClockStuck(row) || isGenStuck(row);
    }

    /**
     * 생성 단계가 멈췄나. 기준 시각은 <b>그 매치 잡의 마지막 갱신</b>(없으면 매치 생성 시각)이다 —
     * {@code matches} 에 "이 상태로 들어온 시각" 컬럼이 없고, 잡 타임스탬프가 곧 "생성이 마지막으로
     * 움직인 때"라 마이그레이션 없이 정확한 앵커가 된다.
     *
     * <p>정상 GEN2 는 0.3초, 정상 GEN1 은 6~14초(대변경이어도 1~2분)라 기본 15분 창에는 닿지 않는다.
     */
    private boolean isGenStuck(MatchService.MatchRow row) {
        if (!MatchService.S_GEN1.equals(row.state()) && !MatchService.S_GEN2.equals(row.state())) {
            return false;
        }
        String lastJobTouch = jdbcClient.sql("SELECT MAX(updated_at) FROM ai_jobs WHERE match_id = ?")
                .param(row.id())
                .query(String.class)
                .optional()
                .orElse(null);
        String anchor = lastJobTouch != null ? lastJobTouch : row.createdAt();
        if (anchor == null) {
            return false;
        }
        try {
            return Instant.now(clock).isAfter(Instant.parse(anchor).plusMillis(props.getGenStuckMs()));
        } catch (RuntimeException e) {
            // 앵커를 못 읽으면 열지 않는다 — 방치 스윕이 백스톱이다(리롤 창을 실수로 여는 것보다 낫다).
            log.warn("gen-stuck anchor 파싱 실패 (match={}, anchor={})", row.id(), anchor, e);
            return false;
        }
    }

    private boolean isClockStuck(MatchService.MatchRow row) {
        if (row.phaseEndsAt() == null) {
            return false; // 시계 미적용(레거시·롤백) 또는 GEN 단계 — 방치 스윕이 백스톱이다
        }
        String deadline = MatchClockService.format(
                Instant.parse(row.phaseEndsAt()).plusMillis(props.getStuckGraceMs()));
        return MatchClockService.format(clock.instant()).compareTo(deadline) > 0;
    }

    /**
     * 포기 — ACTIVE → ABANDONED (CAS). 성공 시 이 매치에 남은 미완 잡을 닫아 AI 콜 낭비를 막는다
     * (잡이 나중에 완료돼도 상태 전이 CAS 가 ABANDONED 에서 실패해 매치는 되살아나지 않는다 —
     * 잡 정리는 비용 절감이지 정합성 장치가 아니다).
     */
    /**
     * 원정 매치를 <b>자발적으로</b> 포기하면 몰수패다(#245 D1, hero 확정).
     *
     * <p>왜: 원정은 브리핑에서 상대 스쿼드가 보이고 브리핑은 포기 가능하다 → 약한 상대가 나올 때까지
     * 만들고 무르면 <b>무한 리롤</b>이 되고, ±10 이 걸린 축에서 그건 레이팅 무결성을 무너뜨린다
     * (독립검증 MAJ-4). 정찰도 리롤도 공짜가 아니게 만든다.
     *
     * <p>⚠️ <b>사고는 면제한다</b> — FAILED·GEN 멈춤·시계 멈춤에서의 포기는 #217 이 영구 잠금을 막으려고
     * 연 <b>탈출구</b>다. 거기까지 −10 을 물리면 서버 장애가 유저 레이팅을 깎는다. 자발적 포기의 정의는
     * <b>BRIEFING 에서 나간 것</b>뿐이다(브리핑은 사고 상태가 아니다).
     */
    /**
     * @param priorState 전이 <b>직전</b> 상태. 스위퍼는 이미 ABANDONED 로 바꾼 뒤에 부르므로
     *     현재 상태로 판단하면 몰수가 영영 걸리지 않는다(자기 자신을 못 알아본다).
     */
    private void forfeitIfVoluntaryAwayAbandon(MatchService.MatchRow row, String priorState) {
        if (!"away".equals(row.mode()) || !MatchService.S_BRIEFING.equals(priorState)) {
            return;
        }
        // 공격자 LOSS = 수비자 WIN. 스코어 0:0 + 비무승부 = 몰수(정상 경기의 0:0 은 언제나 DRAW 라
        // 이 조합은 몰수에서만 나온다 — 별도 컬럼 없이 구분된다).
        awayService.settle(row.id(), row.userId(), "LOSS", 0, 0);
    }

    public MatchService.MatchRow abandon(String userId, String matchId) {
        MatchService.MatchRow row = matchService.getOwned(userId, matchId);
        if (!MatchService.ACTIVE_STATES.contains(row.state())) {
            throw new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                    "이미 끝난 경기입니다: " + row.state(),
                    Map.of("state", row.state(), "action", "abandon"));
        }
        if (!abandonable(row)) {
            throw new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                    "진행 중인 경기는 포기할 수 없습니다 — 경기가 끝날 때까지 기다려 주세요",
                    Map.of("state", row.state(), "action", "abandon"));
        }
        boolean moved = txRunner.run(() -> {
            int updated = jdbcClient.sql("""
                            UPDATE matches SET state = ?, finished_at = ?
                            WHERE id = ? AND state = ?
                            """)
                    .params(MatchService.S_ABANDONED, MatchClockService.format(clock.instant()),
                            matchId, row.state())
                    .update();
            if (updated == 1) {
                closeOpenJobs(matchId, "match abandoned by user");
                // ⚠️ **같은 트랜잭션 안에서** 정산한다(독립검증 3R MAJOR-2). 밖에 두면 매치는 이미
                // 터미널인데 정산만 실패하는 창이 생기고, 그때 수비자는 리포트를 영영 못 받고
                // 공격자는 −10 을 면제받는다 = D1 이 막으려던 무한 리롤이 그대로 열린다.
                // ABANDONED 는 어느 스위퍼도 다시 고르지 않아 재시도 경로도 없다.
                forfeitIfVoluntaryAwayAbandon(row, row.state());
            }
            return updated == 1;
        });
        if (!moved) {
            // 그 사이 시계가 단계를 밀었다 — 다시 읽어 현재 상태로 판정하게 한다.
            throw new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                    "경기 상태가 바뀌었습니다 — 다시 확인해 주세요",
                    Map.of("state", matchService.getOwned(userId, matchId).state(), "action", "abandon"));
        }
        log.info("match abandoned by user: match={} from={}", matchId, row.state());
        return matchService.getOwned(userId, matchId);
    }

    private void closeOpenJobs(String matchId, String reason) {
        jdbcClient.sql("""
                        UPDATE ai_jobs SET status = 'failed', error = ?, lease_until = NULL,
                               worker_id = NULL, updated_at = ?
                        WHERE match_id = ? AND status IN ('queued', 'leased')
                        """)
                .params(reason, Instant.now(clock).toString(), matchId)
                .update();
    }

    /**
     * 방치 백스톱 — {@code stale-after-min} 넘게 안 끝난 비터미널 매치를 회수한다. 수동 포기가
     * 못 여는 구멍(스위퍼가 죽어 있고 유저도 안 돌아오는 경우)이 계정을 영구히 잠그지 않게 하는
     * 마지막 그물이다.
     *
     * @return 회수한 매치 수
     */
    public int sweepStale() {
        String cutoff = Instant.now(clock).minusSeconds(props.getStaleAfterMin() * 60).toString();
        // state 를 같이 읽는다 — 몰수 판정(#245 D1)이 "어느 상태에서 나갔나"에 달려 있다.
        record Stale(String id, String state) {
        }
        java.util.List<Stale> stale = jdbcClient.sql("""
                        SELECT id, state FROM matches
                        WHERE state NOT IN ('FINISHED', 'ABANDONED') AND created_at < ?
                        """)
                .param(cutoff)
                .query((rs, n) -> new Stale(rs.getString("id"), rs.getString("state")))
                .list();
        int swept = 0;
        for (Stale entry : stale) {
            String matchId = entry.id();
            boolean moved = txRunner.run(() -> {
                // ⚠️ CAS 에 **읽은 그 상태**를 넣는다 — 몰수 판정이 entry.state() 에 달려 있는데
                // 조건이 "터미널만 아니면"이면 그 사이 BRIEFING→GEN1 로 움직인 매치를 낡은 상태로
                // 몰수한다(독립검증 3R m9 TOCTOU). 상태가 움직였으면 이번 스윕은 건너뛴다.
                int updated = jdbcClient.sql("""
                                UPDATE matches SET state = ?, finished_at = ?,
                                       fail_reason = COALESCE(fail_reason, ?)
                                WHERE id = ? AND state = ?
                                """)
                        .params(MatchService.S_ABANDONED, MatchClockService.format(clock.instant()),
                                "abandoned: idle > " + props.getStaleAfterMin() + "min", matchId,
                                entry.state())
                        .update();
                if (updated == 1) {
                    closeOpenJobs(matchId, "match abandoned: stale");
                    // MAJOR-2 와 같은 이유로 정산도 이 트랜잭션 안이다.
                    matchService.find(matchId)
                            .ifPresent(row -> forfeitIfVoluntaryAwayAbandon(row, entry.state()));
                }
                return updated == 1;
            });
            if (moved) {
                // 포기 버튼을 누르든 방치하든 **브리핑에서 나간 것은 같다**(#245 D1, 2R major-1) —
                // 정산은 위 트랜잭션 안에서 이미 끝났다. 킥오프 이후 방치는 사고로 본다(면제).
                swept++;
            }
        }
        if (swept > 0) {
            log.info("stale match sweep: {} matches abandoned (idle > {}min)", swept, props.getStaleAfterMin());
        }
        return swept;
    }
}
