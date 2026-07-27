package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchLockService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #217 AC3 — <b>영구 잠금 금지</b>. 진행 중 매치가 새 매치를 막는 이상, 고아 매치를 끝낼 길이 없으면
 * 계정이 통째로 잠긴다. 여기서 박제하는 계약은 둘이고 서로 반대 방향이다:
 *
 * <ul>
 *   <li><b>열려 있어야 한다</b> — 킥오프 전(BRIEFING)·생성 실패(FAILED)·시계가 멈춘 라이브는 포기 가능.
 *       자동 백스톱(방치 스윕)도 돈다.</li>
 *   <li><b>닫혀 있어야 한다</b> — <b>정상 재생 중</b>에는 포기 불가. 열어두면 지고 있는 경기를 버리고
 *       다시 뽑는 리롤이 되고, 리그는 픽스처 리롤까지 된다.</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MatchAbandonTest extends MatchTestBase {

    private static final long STUCK_GRACE_MS = 300_000;
    private static final long GEN_STUCK_MS = 900_000;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 스윕은 이 테스트가 직접 호출한다(스케줄러가 끼면 판정이 흔들린다).
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.abandon.stuck-grace-ms", () -> String.valueOf(STUCK_GRACE_MS));
        registry.add("hmb.match.abandon.gen-stuck-ms", () -> String.valueOf(GEN_STUCK_MS));
        registry.add("hmb.match.abandon.stale-after-min", () -> "720");
    }

    @Resource
    private MatchLockService lockService;

    private String token;

    @BeforeEach
    void setup() {
        jdbcClient.sql("UPDATE matches SET state = 'FINISHED' WHERE state NOT IN ('FINISHED','ABANDONED')")
                .update();
        token = setupUserWithDeck("m_abandon");
    }

    private ResponseEntity<Map> abandon(String matchId) {
        return authPost("/api/matches/" + matchId + "/abandon", token, Map.of(), Map.class);
    }

    // ── 열려 있어야 한다 ────────────────────────────────────────────────

    @ParameterizedTest(name = "state={0} 은 포기할 수 있다")
    @ValueSource(strings = {"BRIEFING", "FAILED"})
    void abandonIsAllowedBeforeKickoffAndAfterGenerationFailure(String state) {
        String matchId = createMatch(token, null);
        forceState(matchId, state);

        ResponseEntity<Map> res = abandon(matchId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody().get("state")).isEqualTo("ABANDONED");
        assertThat(matchState(matchId)).isEqualTo("ABANDONED");
    }

    /** 포기의 목적은 잠금 해제다 — 포기했는데 새 매치를 못 만들면 아무 것도 고치지 못한 것이다. */
    @Test
    void abandoningClearsTheLockSoTheUserCanStartAgain() {
        String matchId = createMatch(token, null);
        assertThat(authPost("/api/matches", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> created = authPost("/api/matches", token, Map.of(), Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody().get("id")).isNotEqualTo(matchId);
    }

    /**
     * 시계가 멈춘 라이브 = 플레이가 아니라 사고다. 단계 종료 예정 시각이 유예를 넘겨 지났는데도
     * 상태가 그대로면 스위퍼가 죽은 것이므로 유저에게 탈출구를 연다.
     */
    @Test
    void abandonOpensWhenTheClockIsDemonstrablyStuck() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FIRST_HALF");
        setPhaseEndsAt(matchId, Instant.now().minusMillis(STUCK_GRACE_MS + 60_000));

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(matchState(matchId)).isEqualTo("ABANDONED");
    }

    /**
     * <b>독립검증 MAJOR-1 회귀 가드</b>: 잡이 <b>전부 done</b> 인데 후속 전이가 커밋되기 전에
     * 프로세스가 죽으면 매치는 GEN* 에 {@code phase_ends_at IS NULL} 로 남는다. 이 조합은
     * {@code JobLeaseSweeper}(미완 잡만 본다)·시계 스위퍼(창이 없다)·{@code retry}(FAILED 가 아니다)
     * 어디에도 걸리지 않아, 원래는 방치 스윕(12h)까지 계정이 통째로 잠겼다.
     */
    @Test
    void abandonOpensWhenGenerationIsStuckWithNoOutstandingJobs() {
        String matchId = createMatch(token, null);
        forceState(matchId, "GEN1");
        // 잡은 전부 done — 어떤 스위퍼도 이 매치를 집어가지 않는다.
        insertJob(matchId, "J_GEN_DONE", "done", Instant.now().minusMillis(GEN_STUCK_MS + 60_000));

        // 다른 복구 경로가 전부 닫혀 있다는 것부터 박제한다(그래서 포기가 유일한 탈출구다).
        assertThat(authPost("/api/matches/" + matchId + "/retry", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(lockService.sweepStale()).as("방치 스윕은 아직 12시간이 안 됐다").isZero();

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(matchState(matchId)).isEqualTo("ABANDONED");
    }

    /** 정상 생성 중(잡이 방금 움직였다)에는 닫혀 있어야 한다 — 열리면 하프타임 리롤 창이 된다. */
    @Test
    void abandonStaysClosedWhileGenerationIsProgressing() {
        String matchId = createMatch(token, null);
        forceState(matchId, "GEN2");
        insertJob(matchId, "J_GEN_FRESH", "done", Instant.now().minusSeconds(5));

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(matchState(matchId)).isEqualTo("GEN2");
    }

    /** 자동 백스톱 — 유저가 아예 안 돌아와도 계정이 영원히 잠기지는 않는다. */
    @Test
    void staleSweepReclaimsMatchesNobodyCameBackTo() {
        String matchId = createMatch(token, null);
        jdbcClient.sql("UPDATE matches SET created_at = ? WHERE id = ?")
                .params(Instant.now().minusSeconds(721 * 60).toString(), matchId)
                .update();

        assertThat(lockService.sweepStale()).isEqualTo(1);
        assertThat(matchState(matchId)).isEqualTo("ABANDONED");

        // 아직 어린 매치는 건드리지 않는다(정상 플레이를 회수하면 그게 더 큰 사고다).
        String fresh = createMatch(token, null);
        assertThat(lockService.sweepStale()).isZero();
        assertThat(matchState(fresh)).isEqualTo("BRIEFING");
    }

    /** 포기한 매치의 미완 잡을 닫는다 — 안 닫으면 아무도 안 보는 경기의 AI 콜 값을 계속 낸다. */
    @Test
    void abandonClosesTheMatchesOpenAiJobs() {
        String matchId = createMatch(token, null);
        jdbcClient.sql("""
                        INSERT INTO ai_jobs(id, match_id, side, half, status, context_json, created_at, updated_at)
                        VALUES (?, ?, 'home', 1, 'queued', '{}', ?, ?)
                        """)
                .params("J_ABANDON", matchId, Instant.now().toString(), Instant.now().toString())
                .update();

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(jdbcClient.sql("SELECT status FROM ai_jobs WHERE id = 'J_ABANDON'")
                .query(String.class).single()).isEqualTo("failed");
    }

    // ── 닫혀 있어야 한다 ────────────────────────────────────────────────

    @ParameterizedTest(name = "정상 진행 중인 state={0} 은 포기할 수 없다")
    @ValueSource(strings = {"GEN1", "GEN2", "SECOND_HALF"})
    void abandonIsRefusedWhileTheMatchIsActuallyRunning(String state) {
        String matchId = createMatch(token, null);
        forceState(matchId, state);

        ResponseEntity<Map> res = abandon(matchId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("INVALID_STATE");
        assertThat(matchState(matchId)).isEqualTo(state);
    }

    /** 창 안에서 정상 재생 중인 라이브 단계도 마찬가지 — "멈췄다"의 기준은 유예 초과지 라이브 자체가 아니다. */
    @Test
    void abandonIsRefusedWhileTheLiveWindowIsStillOpen() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FIRST_HALF");
        setPhaseEndsAt(matchId, Instant.now().plusSeconds(120));

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
    }

    /** 유예 경계 직전(=아직 사고가 아님)도 닫혀 있어야 한다 — 열리면 리롤 창이 상시로 열린다. */
    @Test
    void abandonStaysClosedJustInsideTheStuckGrace() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FIRST_HALF");
        setPhaseEndsAt(matchId, Instant.now().minusMillis(STUCK_GRACE_MS - 30_000));

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void abandonIsRefusedForTerminalMatches() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FINISHED");

        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void abandonRefusesSomebodyElsesMatch() {
        String otherToken = login("m_abandon_thief");
        String matchId = createMatch(token, null);

        ResponseEntity<Map> res = authPost("/api/matches/" + matchId + "/abandon", otherToken,
                Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND); // 소유권 비노출
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
    }

    /**
     * 회수된 매치는 <b>부활하지 않는다</b>. 이걸 새 가드로 막지 않았다는 게 요점이다 — 전이가 전부
     * CAS(`WHERE state = ?`)라 ABANDONED 가 되는 순간 전 액션이 자동으로 거부된다.
     */
    @Test
    void anAbandonedMatchCannotBeResurrected() {
        String matchId = createMatch(token, null);
        assertThat(abandon(matchId).getStatusCode()).isEqualTo(HttpStatus.OK);

        for (String action : new String[] {"kickoff", "resume", "retry"}) {
            ResponseEntity<Map> res = authPost("/api/matches/" + matchId + "/" + action, token,
                    Map.of(), Map.class);
            assertThat(res.getStatusCode()).as(action + " 은 ABANDONED 에서 거부돼야 한다")
                    .isEqualTo(HttpStatus.CONFLICT);
        }
        ResponseEntity<Map> prompt = authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "x"), Map.class);
        assertThat(prompt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(matchState(matchId)).isEqualTo("ABANDONED");
    }

    private void insertJob(String matchId, String jobId, String status, Instant updatedAt) {
        jdbcClient.sql("""
                        INSERT INTO ai_jobs(id, match_id, side, half, status, context_json,
                                            created_at, updated_at)
                        VALUES (?, ?, 'home', 1, ?, '{}', ?, ?)
                        """)
                .params(jobId, matchId, status, updatedAt.toString(), updatedAt.toString())
                .update();
    }

    private void setPhaseEndsAt(String matchId, Instant instant) {
        jdbcClient.sql("UPDATE matches SET phase_start_at = ?, phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(instant.minusSeconds(240)),
                        MatchClockService.format(instant), matchId)
                .update();
    }
}
