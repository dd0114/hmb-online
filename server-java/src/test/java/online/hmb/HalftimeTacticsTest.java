package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 감독시간 팀 전술 변경 — #254 (hero 결정 = <b>허용</b>).
 *
 * <p><b>공백이었던 것</b>: 팀 전술(라인·압박·템포·폭)은 {@code POST /kickoff} 에서만 서버로 왔고
 * 감독시간이 받는 것은 {@code prompts(halftime)} 와 {@code halftime(substitutions)} 뿐이라 전술을
 * 실을 자리가 없었다. 그래서 web 은 감독시간 화면의 팀 전술 다이얼을 감출 수밖에 없었다.
 * hero 판단은 <b>허용</b> — 후반에 "라인 내려"가 되는 게 방식1(자연어 → 전술 파라미터)의 설계 취지다.
 *
 * <p><b>배관은 새로 놓지 않는다</b>: #215 W2 가 전술을 A(베이스) 키 밖으로 빼고 <b>B 패치 입력</b>으로
 * 옮겨 뒀다. 그래서 후반 실효 스냅샷의 {@code teamTactics} 만 갈아끼우면 기존 패치 경로가 그대로
 * {@code manualTactics} 로 AI 에 전달한다. 매치 스냅샷({@code user_deck_json})은 <b>건드리지 않는다</b> —
 * 거기 있는 전술은 이미 끝난 전반의 기록이라 덮으면 소급 변조다.
 *
 * <p>박제하는 불변식:
 * <ol>
 *   <li>감독시간 전술 변경 → 후반이 <b>B 패치</b>로 가고 컨텍스트에 바뀐 manualTactics 가 실린다.</li>
 *   <li>전술을 안 보내면 종전대로 <b>재사용(콜0)</b> — 기존 동작 무회귀.</li>
 *   <li>전반과 <b>같은 값</b>을 보내면 변경이 아니다 → 콜0 유지(예산 가드 P2-D8 정합).</li>
 *   <li>전반 기록({@code user_deck_json}의 teamTactics)은 후반 전술로 덮이지 않는다.</li>
 *   <li>범위 밖 값은 400 — 전술 검증은 킥오프와 같은 규칙이다.</li>
 *   <li>전술만 바꾸고 교체만 재제출해도 앞서 낸 전술이 지워지지 않는다.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class HalftimeTacticsTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    private static final Map<String, Object> AGGRESSIVE =
            Map.of("line", 0.9, "press", 0.8, "tempo", 0.75, "width", 0.6);

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 킥오프 전술 {@code kickoffTactics} 로 전반을 마치고 감독시간(HALFTIME)에 세운다. */
    private String toHalftime(String nickname, Map<String, Object> kickoffTactics) {
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain(); // A done
        Map<String, Object> body = kickoffTactics == null ? Map.of() : Map.of("teamTactics", kickoffTactics);
        authPost("/api/matches/" + matchId + "/kickoff", token, body, Map.class);
        fakeServants.drain(); // h1 생성 + 시뮬
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        return matchId;
    }

    private long patchJobCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND effective = 1
                          AND context_json LIKE '%"kind":"team-input-patch"%'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    private long materializedCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = 'done'
                          AND effective = 1 AND context_json = '{"kind":"materialized"}'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    /** 유저(home) 후반 유효 잡의 컨텍스트. */
    private String userSecondHalfContext(String matchId) {
        return jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 2 AND side = 'home' AND effective = 1
                        """)
                .param(matchId).query(String.class).single();
    }

    private String snapshotJson(String matchId) {
        return jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    // ── 1: 변경 → 후반 입력에 반영 ──────────────────────────────────────

    @Test
    void halftimeTacticsChangeReachesSecondHalfInput() {
        String token = setupUserWithDeck("ht_change");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/kickoff", token,
                Map.of("teamTactics", Map.of("line", 0.2, "press", 0.2, "tempo", 0.3, "width", 0.4)),
                Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 감독시간: 지시 문장은 한 자도 안 쓰고 **전술만** 바꾼다. 이게 #254 이전엔 갈 데가 없었다.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "teamTactics", AGGRESSIVE), Map.class);

        // 유저는 B 패치로 다시 만든다(재사용이면 후반이 전반 전술 그대로 돈다 = 조용한 무시).
        assertThat(patchJobCount(matchId, 2)).isEqualTo(1L);
        String context = userSecondHalfContext(matchId);
        assertThat(context).contains("manualTactics");
        assertThat(context).contains("\"line\":0.9");
        assertThat(context).contains("\"press\":0.8");

        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    // ── 2~3: 무변경은 콜0 유지 ──────────────────────────────────────────

    @Test
    void noTacticsSubmittedKeepsCall0() {
        String matchId = toHalftime("ht_none", null);
        String token = login("ht_none");

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);

        assertThat(patchJobCount(matchId, 2)).isZero();
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    @Test
    void resubmittingTheSameTacticsIsNotAChange() {
        String token = setupUserWithDeck("ht_same");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/kickoff", token,
                Map.of("teamTactics", AGGRESSIVE), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // web 은 다이얼 현재값을 그대로 실어 보낸다 — 안 건드렸는데 재생성되면 감독시간마다 AI 콜이
        // 한 번씩 늘어난다(예산 가드 P2-D8 위반). "같은 값 = 무변경"이어야 한다.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "teamTactics", AGGRESSIVE), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);

        assertThat(patchJobCount(matchId, 2)).isZero();
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    // ── 4: 전반 기록 불변 ───────────────────────────────────────────────

    @Test
    void firstHalfRecordIsNotRewritten() {
        String token = setupUserWithDeck("ht_record");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/kickoff", token,
                Map.of("teamTactics", Map.of("line", 0.2, "press", 0.2, "tempo", 0.3, "width", 0.4)),
                Map.class);
        fakeServants.drain();

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "teamTactics", AGGRESSIVE), Map.class);

        // "나는 전반에 라인을 내렸다"가 후반 지시로 사라지면 안 된다 — 스냅샷은 전반의 박제다.
        assertThat(snapshotJson(matchId)).contains("\"line\":0.2");
        assertThat(snapshotJson(matchId)).doesNotContain("\"line\":0.9");
        assertThat(jdbcClient.sql("SELECT h2_tactics_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).contains("\"line\":0.9");
    }

    // ── 5~6: 검증·재제출 ───────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void outOfRangeTacticsAreRejected() {
        String matchId = toHalftime("ht_range", null);
        String token = login("ht_range");

        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(),
                        "teamTactics", Map.of("line", 1.4, "press", 0.5, "tempo", 0.5, "width", 0.5)),
                Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(jdbcClient.sql("SELECT h2_tactics_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).optional().orElse(null)).isNull();
    }

    @Test
    void tacticsSurviveASubsOnlyResubmit() {
        String matchId = toHalftime("ht_resubmit", null);
        String token = login("ht_resubmit");

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "teamTactics", AGGRESSIVE), Map.class);
        // 교체만 고쳐 다시 제출 — 전술 미첨부다. 여기서 null 로 덮이면 유저가 낸 전술이 조용히 사라진다.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012"))), Map.class);

        assertThat(jdbcClient.sql("SELECT h2_tactics_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).contains("\"line\":0.9");
    }
}
