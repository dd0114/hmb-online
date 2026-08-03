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

    /**
     * SKIP 이 <b>둘</b>인 이유(#421): 스킵은 바디 {@code phase} 를 CAS {@code WHERE state=?} 에 넣는다.
     * 액션을 하나로 두면 "전반이 도는데 후반 스킵이 왔다"는 경합 셀이 전이표에서 관측되지 않는다 —
     * 그 셀이 정확히 이 API 의 위험(다음 단계를 통째로 삼키기)이다.
     */
    enum MatchAction {
        PROMPTS_PRE, PROMPTS_HALFTIME, KICKOFF, HALFTIME, RESUME, RETRY, RESULT, LOG1, LOG2,
        SKIP_H1, SKIP_H2
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
            case SKIP_H1 -> post.apply("/skip", Map.of("phase", "FIRST_HALF"));
            case SKIP_H2 -> post.apply("/skip", Map.of("phase", "SECOND_HALF"));
        };
    }

    /**
     * §5.1 전이표의 "허용" 집합 — 그 외 전부 409 대상. P4-E2(#170)로 라이브 단계가 들어오면서:
     * <ul>
     *   <li>FIRST_HALF — 전반을 보면서 후반 지시·교체를 <b>미리</b> 넣을 수 있다. 단 RESUME 은 금지
     *       (후반 앞당기기 금지, P4-D1).</li>
     *   <li>HALFTIME — 구 H1_BREAK 자리. 여기서만 RESUME 이 열린다.</li>
     *   <li>GEN2·SECOND_HALF — 후반 생성/재생 중에도 전반 다시보기(LOG1)는 계속 가능.</li>
     *   <li><b>SKIP</b>(#421) — <b>재생 중인 그 하프에서만</b>. 라이브 단계가 아니면 409(창이 없다),
     *       라이브여도 <b>바디 phase 가 지금 도는 단계와 다르면</b> 409 — 그래서 FIRST_HALF 행은
     *       {@code SKIP_H1} 만, SECOND_HALF 행은 {@code SKIP_H2} 만 허용이다. RESUME 과 달리
     *       FIRST_HALF 에서 열려 있는 이유: 스킵은 후반을 <b>앞당기는 전이</b>가 아니라 재생 창을
     *       닫는 것이고, 그 뒤는 기존 만료 전이가 그대로 밟는다(hero 지시로 P4-D1 을 뒤집는다 —
     *       롤백 스위치 {@code hmb.match.skip.enabled}).</li>
     * </ul>
     */
    private static final Map<String, List<MatchAction>> ALLOWED = Map.of(
            "BRIEFING", List.of(MatchAction.PROMPTS_PRE, MatchAction.KICKOFF),
            "GEN1", List.of(),
            "FIRST_HALF", List.of(MatchAction.PROMPTS_HALFTIME, MatchAction.HALFTIME, MatchAction.LOG1,
                    MatchAction.SKIP_H1),
            "HALFTIME", List.of(MatchAction.PROMPTS_HALFTIME, MatchAction.HALFTIME,
                    MatchAction.RESUME, MatchAction.LOG1),
            "H1_BREAK", List.of(MatchAction.PROMPTS_HALFTIME, MatchAction.HALFTIME,
                    MatchAction.RESUME, MatchAction.LOG1), // 레거시 행(V8 이전 배포본)도 같은 대우
            "GEN2", List.of(MatchAction.LOG1),
            "SECOND_HALF", List.of(MatchAction.LOG1, MatchAction.LOG2, MatchAction.SKIP_H2),
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
