package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.io.File;
import java.util.List;
import java.util.Map;
import online.hmb.common.Hashes;
import online.hmb.match.MatchOrchestrator;
import online.hmb.match.MatchService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * AC-M2(서버측 스텁 풀 E2E): 로그인→덱→매치→프롬프트→킥오프→(가짜 서번트)→H1_BREAK→하프타임→
 * 재개→FINISHED→결과+보상+전적. + AC-M3(로그 verbatim) + AC-M5(재현 번들) + AC-M6(보상 멱등)
 * + prevSummary 정확성.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchFlowE2ETest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 이 테스트의 주제는 시계가 아니다 — 레거시(즉시 전개) 흐름으로 고정한다(§7.7 롤백 경로).
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchOrchestrator orchestrator;

    @Resource
    private MatchService matchService;

    @Resource
    private ObjectMapper objectMapper;

    @Test
    void fullFlowWithoutSubsReachesFinishedWithRewards() throws Exception {
        String token = setupUserWithDeck("m_e2e");
        String matchId = createMatch(token, "BOT_BAL");

        // BRIEFING — 상대 분석
        ResponseEntity<Map> briefing = authGet("/api/matches/" + matchId, token, Map.class);
        Map<?, ?> opponent = (Map<?, ?>) briefing.getBody().get("opponent");
        assertThat(opponent.get("name")).isEqualTo("Balanced FC");
        assertThat((String) opponent.get("analysisText")).isNotBlank();
        List<Map<String, Object>> oppDeck = (List<Map<String, Object>>) opponent.get("deck");
        assertThat(oppDeck).hasSize(11);
        assertThat(oppDeck.stream().filter(p -> Boolean.TRUE.equals(p.get("hasPrompt"))).count())
                .isEqualTo(1); // BOT_BAL P011만 promptText

        // 프롬프트 (pre: 팀 + 선수)
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "점유 중심으로 운영해"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "player", "playerId", "P003", "text", "오버랩 자주"),
                Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        // 킥오프 → GEN1 → (가짜 서번트) → H1_BREAK
        ResponseEntity<Map> kickoff = authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        assertThat(kickoff.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(kickoff.getBody().get("state")).isEqualTo("GEN1");

        int processed = fakeServants.drain();
        // A 프리페치(#95): 브리핑에 유저 A + 봇 A 2개 enqueue. 킥오프 전 A 미완이라 h1 은 풀생성 폴백
        // (home h1 + away h1). 드레인은 A 2개 + 풀생성 side 2개 = 4개를 처리한다(h2 는 별도 A-잡 없음).
        assertThat(processed).isEqualTo(4);

        ResponseEntity<Map> afterH1 = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(afterH1.getBody().get("state")).isEqualTo("HALFTIME");
        assertThat(afterH1.getBody().get("scoreH1Home")).isEqualTo(1); // fixture h1 finalScore 1-0
        assertThat(afterH1.getBody().get("scoreH1Away")).isEqualTo(0);

        // h1 로그 verbatim (AC-M3 서버측)
        ResponseEntity<String> h1Log = authGet("/api/matches/" + matchId + "/halves/1/log", token, String.class);
        JsonNode h1 = objectMapper.readTree(h1Log.getBody());
        assertThat(h1.path("tickSnapshots")).hasSize(120);
        assertThat(h1.path("finalScore").path("home").asInt()).isEqualTo(1);
        assertThat(h1.path("configVersion").asText()).isEqualTo("engine@0.9.0-fixture-short");

        // 하프타임: 추가 프롬프트 + 교체 없음
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", "리드 지켜, 라인 내려"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        // 재개 → GEN2 → FINISHED
        ResponseEntity<Map> resume = authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        assertThat(resume.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(resume.getBody().get("state")).isEqualTo("GEN2");

        // away h2 는 h1 처리 중 #1 프리페치로 이미 완료 → 재개 후엔 home h2 만 처리(1).
        assertThat(fakeServants.drain()).isEqualTo(1);

        ResponseEntity<Map> finished = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(finished.getBody().get("state")).isEqualTo("FINISHED");
        assertThat(finished.getBody().get("scoreHome")).isEqualTo(1); // 1+0
        assertThat(finished.getBody().get("scoreAway")).isEqualTo(0); // 0+0
        assertThat(finished.getBody().get("result")).isEqualTo("WIN");
        assertThat(finished.getBody().get("finishedAt")).isNotNull();

        // 교체 없음 → h2 러너 요청에 resumeState 승계 (LLD §5.4)
        JsonNode h2Request = RUNNER.lastRequestForHalf(2);
        assertThat(h2Request.has("resumeState")).isTrue();

        // 결과 API + 보상
        ResponseEntity<Map> result = authGet("/api/matches/" + matchId + "/result", token, Map.class);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(result.getBody().get("result")).isEqualTo("WIN");
        assertThat(((Number) result.getBody().get("pointsAwarded")).longValue()).isEqualTo(500L); // fixture win
        assertThat((Map<?, ?>) result.getBody().get("teamStats")).isNotEmpty();

        // 전적·지갑 반영
        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        assertThat(((Number) ((Map<?, ?>) me.getBody().get("records")).get("wins")).longValue()).isEqualTo(1L);
        assertThat(((Number) ((Map<?, ?>) me.getBody().get("wallet")).get("points")).longValue())
                .isEqualTo(3000L + 500L);

        ResponseEntity<List> myMatches = authGet("/api/me/matches", token, List.class);
        assertThat(myMatches.getBody()).hasSize(1);
        Map<?, ?> item = (Map<?, ?>) myMatches.getBody().get(0);
        assertThat(item.get("opponentName")).isEqualTo("Balanced FC");
        assertThat(item.get("result")).isEqualTo("WIN");

        // ── 재현 번들 완전성 (AC-M5 W3 범위) ──
        String matchSeed = jdbcClient.sql("SELECT seed FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        String engineVersion = jdbcClient.sql("SELECT engine_version FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(engineVersion).isEqualTo("engine@0.9.0-fixture-short"); // h1 응답으로 갱신됨

        for (int half = 1; half <= 2; half++) {
            int h = half;
            Map<String, Object> bundle = jdbcClient.sql("""
                            SELECT select_data_json, home_input_json, away_input_json, half_seed,
                                   match_log_json, resume_state_json, last_hash
                            FROM match_halves WHERE match_id = ? AND half = ?
                            """)
                    .params(matchId, half)
                    .query((rs, n) -> {
                        Map<String, Object> m = new java.util.HashMap<>();
                        m.put("selectData", rs.getString("select_data_json"));
                        m.put("home", rs.getString("home_input_json"));
                        m.put("away", rs.getString("away_input_json"));
                        m.put("halfSeed", rs.getString("half_seed"));
                        m.put("log", rs.getString("match_log_json"));
                        m.put("resume", rs.getString("resume_state_json"));
                        m.put("lastHash", rs.getString("last_hash"));
                        return m;
                    })
                    .single();
            assertThat((String) bundle.get("selectData")).isNotBlank();
            assertThat((String) bundle.get("home")).isNotBlank();
            assertThat((String) bundle.get("away")).isNotBlank();
            assertThat((String) bundle.get("log")).isNotBlank();
            assertThat((String) bundle.get("lastHash")).isNotBlank();
            // halfSeed 파생 결정론: 저장값 == 재계산값
            assertThat(bundle.get("halfSeed")).isEqualTo(Hashes.halfSeed(matchSeed, h));
        }
        // h1은 resumeState 보존(h2 승계용)
        String h1Resume = jdbcClient.sql(
                        "SELECT resume_state_json FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single();
        assertThat(h1Resume).isNotBlank();

        // ── prevSummary 정확성 (h2 잡 컨텍스트 vs h1 fixture 이벤트) ──
        JsonNode h1Fixture = objectMapper.readTree(new File("../docs/plan-v2/fixtures/matchlog-h1.json"))
                .path("response").path("matchLog");
        long expectedShots = 0;
        long homePasses = 0;
        long awayPasses = 0;
        for (JsonNode event : h1Fixture.path("events")) {
            if ("shot".equals(event.path("type").asText())) {
                expectedShots++;
            }
            if ("pass".equals(event.path("type").asText())) {
                if ("home".equals(event.path("team").asText())) {
                    homePasses++;
                } else if ("away".equals(event.path("team").asText())) {
                    awayPasses++;
                }
            }
        }
        double homeShare = (double) homePasses / (homePasses + awayPasses);
        String expectedHint = homeShare > 0.55 ? "home" : homeShare < 0.45 ? "away" : "balanced";

        String h2ContextJson = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs WHERE match_id = ? AND half = 2 AND side = 'home'
                        """)
                .param(matchId).query(String.class).single();
        JsonNode prevSummary = objectMapper.readTree(h2ContextJson).path("prevSummary");
        assertThat(prevSummary.path("scoreHome").asInt()).isEqualTo(1);
        assertThat(prevSummary.path("scoreAway").asInt()).isEqualTo(0);
        assertThat(prevSummary.path("shots").asLong()).isEqualTo(expectedShots);
        assertThat(prevSummary.path("possessionHint").asText()).isEqualTo(expectedHint);

        // ── 보상 멱등 (AC-M6): 완료 처리 강제 재실행 → 원장 1행 유지 ──
        String h2HomeJobId = objectMapper.readTree(h2ContextJson) != null
                ? jdbcClient.sql("SELECT id FROM ai_jobs WHERE match_id = ? AND half = 2 AND side = 'home'")
                        .param(matchId).query(String.class).single()
                : null;
        orchestrator.onJobDone(h2HomeJobId); // 이미 FINISHED — no-op이어야 함

        long rewardRows = jdbcClient.sql("""
                        SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'
                        """)
                .param(matchId).query(Long.class).single();
        assertThat(rewardRows).isEqualTo(1L);
        long points = jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userIdOf("m_e2e")).query(Long.class).single();
        assertThat(points).isEqualTo(3500L);
    }

    @Test
    void promptOnNonRosterPlayerRejected() {
        String token = setupUserWithDeck("m_prompt_bad");
        String matchId = createMatch(token, "BOT_BAL");
        ResponseEntity<Map> response = authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "player", "playerId", "P016", "text", "x"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void randomBotAssignedWhenBotIdOmitted() {
        String token = setupUserWithDeck("m_random_bot");
        String matchId = createMatch(token, null);
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(botId).isIn("BOT_BAL", "BOT_ATK");
    }

    /**
     * F2(carried, AC-M6 최내곽 가드): FINISHED 후 state를 GEN2로 강제(테스트 스캐폴딩) + h2 halfRow
     * 존재 상태에서 종료 처리(finishMatch)를 직접 재호출 → CAS는 다시 통과하지만 원장 유니크 인덱스
     * (INSERT OR IGNORE)가 이중 보상을 막아 reward 원장은 정확히 1행 유지.
     */
    @Test
    void finishHandlingReinvokedKeepsExactlyOneRewardRow() {
        String token = setupUserWithDeck("m_reward_guard");
        String matchId = driveToFinished(token);
        String userId = userIdOf("m_reward_guard");

        assertThat(rewardRows(matchId)).isEqualTo(1L);
        long pointsBefore = jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();

        MatchService.MatchRow row = matchService.find(matchId).orElseThrow();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        // h2 halfRow가 실제로 존재하는지 확인(가드 전제)
        long h2Rows = jdbcClient.sql("SELECT COUNT(*) FROM match_halves WHERE match_id = ? AND half = 2")
                .param(matchId).query(Long.class).single();
        assertThat(h2Rows).isEqualTo(1L);

        // state를 GEN2로 되돌린 뒤 finishMatch를 직접(reflection) 재호출 — 최내곽 보상 가드만 겨냥.
        // P4-E2(#170)로 fromState 인자가 붙었다(시계 꺼짐=GEN2 / 켜짐=SECOND_HALF 에서 CAS).
        forceState(matchId, "GEN2");
        ReflectionTestUtils.invokeMethod(orchestrator, "finishMatch", row, 0, 0, "GEN2");

        assertThat(matchState(matchId)).isEqualTo("FINISHED"); // CAS 재통과로 다시 FINISHED
        assertThat(rewardRows(matchId)).isEqualTo(1L);         // 원장은 여전히 1행
        long pointsAfter = jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
        assertThat(pointsAfter).isEqualTo(pointsBefore);       // 지갑 무변화
    }

    /**
     * F3(carried, AC-M): team-scope 프롬프트 UPSERT dedupe — 같은 {phase, scope:team}로 두 번 POST하면
     * match_prompts에 1행만 남고 text는 두 번째 값으로 갱신(player_id NULL의 NULL-유니크 함정 회귀 가드).
     */
    @Test
    void teamScopePromptUpsertsToSingleRow() {
        String token = setupUserWithDeck("m_prompt_upsert");
        String matchId = createMatch(token, "BOT_BAL");

        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "첫 번째 지시"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "두 번째 지시"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        long rows = jdbcClient.sql("""
                        SELECT COUNT(*) FROM match_prompts
                        WHERE match_id = ? AND phase = 'pre' AND scope = 'team' AND player_id IS NULL
                        """)
                .param(matchId).query(Long.class).single();
        assertThat(rows).isEqualTo(1L);
        String text = jdbcClient.sql("""
                        SELECT text FROM match_prompts
                        WHERE match_id = ? AND phase = 'pre' AND scope = 'team' AND player_id IS NULL
                        """)
                .param(matchId).query(String.class).single();
        assertThat(text).isEqualTo("두 번째 지시");
    }

    /** 매치를 FINISHED까지 몰고 간다(교체 없음, 가짜 서번트/러너). */
    private String driveToFinished(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        return matchId;
    }

    private long rewardRows(String matchId) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'
                        """)
                .param(matchId).query(Long.class).single();
    }
}
