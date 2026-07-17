package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.BiFunction;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-M1: §5.1 전이표 전수 — 각 상태에서 허용되지 않는 (state, action) 조합 전부 409 INVALID_STATE.
 * (허용 조합의 효과는 MatchFlowE2ETest/MatchSubsTest/MatchFailureTest가 검증)
 * + 동시 kickoff CAS 증명(정확히 1개만 GEN1 진입).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MatchTransitionMatrixTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private String token;

    @BeforeEach
    void setup() {
        token = setupUserWithDeck("m_matrix");
    }

    // ── 액션 정의 (전이표의 상태 의존 액션 9종; GET match는 전 상태 허용이라 제외) ──

    enum MatchAction {
        PROMPTS_PRE, PROMPTS_HALFTIME, KICKOFF, HALFTIME, RESUME, RETRY, RESULT, LOG1, LOG2
    }

    private ResponseEntity<Map> execute(MatchAction action, String matchId) {
        BiFunction<String, Object, ResponseEntity<Map>> post =
                (path, body) -> authPost("/api/matches/" + matchId + path, token, body, Map.class);
        return switch (action) {
            case PROMPTS_PRE -> post.apply("/prompts",
                    Map.of("phase", "pre", "scope", "team", "text", "x"));
            case PROMPTS_HALFTIME -> post.apply("/prompts",
                    Map.of("phase", "halftime", "scope", "team", "text", "x"));
            case KICKOFF -> post.apply("/kickoff", Map.of());
            case HALFTIME -> post.apply("/halftime", Map.of("substitutions", List.of()));
            case RESUME -> post.apply("/resume", Map.of());
            case RETRY -> post.apply("/retry", Map.of());
            case RESULT -> authGet("/api/matches/" + matchId + "/result", token, Map.class);
            case LOG1 -> authGet("/api/matches/" + matchId + "/halves/1/log", token, Map.class);
            case LOG2 -> authGet("/api/matches/" + matchId + "/halves/2/log", token, Map.class);
        };
    }

    /** §5.1 전이표의 "허용" 집합 — 그 외 전부 409 대상. */
    private static final Map<String, List<MatchAction>> ALLOWED = Map.of(
            "BRIEFING", List.of(MatchAction.PROMPTS_PRE, MatchAction.KICKOFF),
            "GEN1", List.of(),
            "H1_BREAK", List.of(MatchAction.PROMPTS_HALFTIME, MatchAction.HALFTIME,
                    MatchAction.RESUME, MatchAction.LOG1),
            "GEN2", List.of(),
            "FINISHED", List.of(MatchAction.RESULT, MatchAction.LOG1, MatchAction.LOG2),
            "FAILED", List.of(MatchAction.RETRY));

    static List<Object[]> deniedCells() {
        List<Object[]> cells = new ArrayList<>();
        for (Map.Entry<String, List<MatchAction>> entry : ALLOWED.entrySet()) {
            for (MatchAction action : MatchAction.values()) {
                if (!entry.getValue().contains(action)) {
                    cells.add(new Object[]{entry.getKey(), action});
                }
            }
        }
        return cells;
    }

    @ParameterizedTest(name = "{0} × {1} → 409")
    @MethodSource("deniedCells")
    void deniedStateActionPairsReturn409(String state, MatchAction action) {
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, state);

        ResponseEntity<Map> response = execute(action, matchId);

        assertThat(response.getStatusCode())
                .as("state=%s action=%s", state, action)
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().get("code")).isEqualTo("INVALID_STATE");
    }

    @Test
    void concurrentKickoffOnlyOneWins() throws Exception {
        String matchId = createMatch(token, "BOT_BAL");

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> futures = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            futures.add(pool.submit(() -> {
                start.await();
                return authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                        .getStatusCode().value();
            }));
        }
        start.countDown();
        List<Integer> codes = new ArrayList<>();
        for (Future<Integer> f : futures) {
            codes.add(f.get());
        }
        pool.shutdown();

        assertThat(codes).containsExactlyInAnyOrder(202, 409); // CAS: 정확히 하나만 성공
        assertThat(matchState(matchId)).isEqualTo("GEN1");
        long jobs = jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = 1")
                .param(matchId).query(Long.class).single();
        assertThat(jobs).isEqualTo(2L); // home+away — 멱등 enqueue라 중복 없음
    }
}
