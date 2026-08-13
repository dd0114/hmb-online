package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.tutorial.TutorialMatchAsset;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #493 W6-v3 — <b>튜토리얼 고정 매치</b>.
 *
 * <p>hero 요구 넷을 그대로 계약으로 건다: ①AI 호출 0 ②대기 0(러너 호출 0) ③모든 유저가 같은 결과
 * ④반드시 유저 승리. 그리고 다섯 번째 — <b>기존 플로우를 그대로 지나간다</b>(관전 로그 서빙·결과·
 * 보상 봉투). 별도 뷰 경로를 만들지 않았다는 것이 이 클래스가 {@code /api/matches/**} 만으로
 * 끝까지 갈 수 있다는 사실로 관측된다.
 *
 * <p>⚠️ <b>엔진 러너를 등록하지 않는다.</b> {@code hmb.servant.engine-runner-url} 은 아무도 듣지 않는
 * 주소로 둔다 — 튜토리얼이 러너를 부르면 이 테스트는 연결 실패로 죽는다. 즉 "러너 호출 0" 이
 * 단언이 아니라 <b>환경</b>으로 강제된다({@code FakeEngineRunner} 를 쓰면 그 성질이 사라진다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class TutorialMatchTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 이 테스트의 주제는 시계가 아니다 — 즉시 전개(§7.7 롤백 경로)로 고정한다.
        TestDbSupport.disableMatchClock(registry);
        // 듣는 사람이 없는 포트. 튜토리얼이 러너를 부르면 여기서 죽는다(= 그게 계약이다).
        registry.add("hmb.servant.engine-runner-url", () -> "http://127.0.0.1:1");
    }

    @Resource
    ObjectMapper objectMapper;

    @Resource
    TutorialMatchAsset asset;

    private String createTutorialMatch(String token) {
        ResponseEntity<Map> res = authPost("/api/matches", token, Map.of("tutorial", true), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(res.getBody().get("tutorial")).as("web 의 온레일 가이드가 이 값으로 켜진다").isEqualTo(true);
        return (String) res.getBody().get("id");
    }

    /** 킥오프 → (AI 없음) → 감독시간 → 재개 → 종료. 드레인도 러너도 없다. */
    private void playToFinish(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).as("AI 를 기다리지 않는다 — 킥오프 응답 시점에 전반이 이미 있다")
                .isEqualTo("HALFTIME");
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    @Test
    void theTutorialMatchNeedsNoAiAndNoRunnerAndTheUserWins() throws Exception {
        String token = setupUserWithDeck("tut-match");
        // ⚠️ 기준선을 0 으로 두지 않는다 — 덱 저장이 이미 A(베이스)를 예열한다(#215, 이 웨이브와
        //    무관한 기존 기능). 재는 것은 <b>매치 생성이 A 를 더 만드는가</b>다.
        int baseBefore = baseJobs();
        String matchId = createTutorialMatch(token);

        // ① AI 호출 0 — 생성 시점의 A(베이스) 프리페치조차 하지 않는다.
        assertThat(baseJobs()).as("구운 인풋을 쓰는 매치에 A 를 미리 만드는 것은 안 쓸 AI 호출이다")
                .isEqualTo(baseBefore);

        playToFinish(token, matchId);

        // 이 매치의 잡은 전부 '이미 done 인 materialize' 다 = 서번트가 한 번도 불리지 않았다.
        List<String> contexts = jdbcClient.sql(
                        "SELECT context_json FROM ai_jobs WHERE match_id = ? ORDER BY half, side")
                .param(matchId).query(String.class).list();
        assertThat(contexts).hasSize(4);   // (home|away) × (h1|h2)
        assertThat(contexts).allMatch(c -> c.contains("materialized"));
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND status <> 'done'")
                .param(matchId).query(Integer.class).single()).isZero();

        // ④ 유저 승리 — 자산이 들고 있는 스코어 그대로.
        ResponseEntity<Map> finished = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(finished.getBody().get("result")).isEqualTo("WIN");
        assertThat(finished.getBody().get("scoreHome")).isEqualTo(asset.finalHome());
        assertThat(finished.getBody().get("scoreAway")).isEqualTo(asset.finalAway());
        assertThat(asset.finalHome()).as("자산 자체가 '유저가 이긴다'를 만족해야 한다")
                .isGreaterThan(asset.finalAway());
    }

    @Test
    void theBakedLogIsServedThroughTheOrdinaryViewingPath() throws Exception {
        String token = setupUserWithDeck("tut-log");
        String matchId = createTutorialMatch(token);
        playToFinish(token, matchId);

        for (int half = 1; half <= 2; half++) {
            ResponseEntity<String> log = authGet(
                    "/api/matches/" + matchId + "/halves/" + half + "/log", token, String.class);
            assertThat(log.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode served = objectMapper.readTree(log.getBody());
            JsonNode baked = asset.half(half).matchLog();
            assertThat(served).as("로그는 구운 것 그대로다(verbatim)").isEqualTo(baked);
        }

        // 저장된 하프 시드가 자산과 같다 = "이 로그는 이 시드로 재현된다"가 참이다.
        List<String> seeds = jdbcClient.sql(
                        "SELECT half_seed FROM match_halves WHERE match_id = ? ORDER BY half")
                .param(matchId).query(String.class).list();
        assertThat(seeds).containsExactly(asset.half(1).halfSeed(), asset.half(2).halfSeed());

        // 결과·보상 봉투도 평소 경로다(별도 뷰 없음) — 봉투 확인이 ② 행동 보상을 낳는다.
        ResponseEntity<Map> result = authGet("/api/matches/" + matchId + "/result", token, Map.class);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> bundle = (Map<String, Object>) result.getBody().get("rewardBundle");
        assertThat(bundle).as("정산이 돌았다 = 보상 봉투가 있다").isNotNull();
        assertThat(authPost("/api/rewards/" + bundle.get("bundleId") + "/ack", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM user_mails WHERE user_id = ? AND campaign_id = ?")
                .params(userIdOf("tut-log"), "uxa_first_result").query(Integer.class).single())
                .isEqualTo(1);
    }

    /**
     * #493 W10 — <b>상대 카드는 실제로 뛴 로스터다</b>(봇 덱이 아니다).
     *
     * <p>W10 이 튜토리얼 로스터를 "얼굴 캐릭터가 있는 선수"로 갈면서 away 로스터가 시드봇 덱에서
     * 떨어져 나왔다({@code data/**} 는 이 모듈 밖이라 봇 덱을 못 고친다). 그 순간부터 상대 분석
     * 카드가 <b>경기에 나오지도 않는 선수</b>를 보여줄 수 있는 자리가 생겼고, 이 테스트가 그 자리를
     * 막는다.
     *
     * <p>⚠️ <b>공허하지 않다는 근거를 같이 단언한다</b>: 봇 덱과 자산 로스터가 실제로 <b>다르다</b>는
     * 것을 먼저 확인한다 — 두 배열이 같으면 어느 쪽을 읽든 통과해서 계약이 아무것도 안 지킨다.
     */
    @Test
    void theOpponentCardShowsTheRosterThatActuallyPlayed() {
        String token = setupUserWithDeck("tut-opp");
        String matchId = createTutorialMatch(token);

        List<String> baked = new java.util.ArrayList<>();
        asset.selectData().path("away").path("players")
                .forEach(p -> baked.add(p.path("playerId").asText()));
        assertThat(baked).hasSize(11);

        List<String> botDeck = new java.util.ArrayList<>();
        String deckJson = jdbcClient.sql("SELECT b.deck_json FROM bots b JOIN matches m ON m.bot_id = b.id "
                + "WHERE m.id = ?").param(matchId).query(String.class).single();
        try {
            objectMapper.readTree(deckJson).path("starters")
                    .forEach(s -> botDeck.add(s.path("playerId").asText()));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        assertThat(botDeck).as("봇 덱과 자산 로스터가 같으면 이 계약은 아무것도 지키지 않는다")
                .isNotEqualTo(baked);

        ResponseEntity<Map> detail = authGet("/api/matches/" + matchId, token, Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> opponent = (Map<String, Object>) detail.getBody().get("opponent");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> shown = (List<Map<String, Object>>) opponent.get("deck");
        assertThat(shown.stream().map(p -> (String) p.get("playerId")).toList())
                .as("상대 카드 = 구운 자산의 away 로스터").isEqualTo(baked);
        assertThat(shown).allSatisfy(p -> {
            assertThat(p.get("name")).as("카탈로그에 있는 선수여야 이름이 뜬다").isNotNull();
            assertThat(p.get("grade")).as("등급이 없으면 web 아트 정책이 fail-closed 로 닫힌다").isNotNull();
        });
        // 이름은 봇 덱이 아니라 카탈로그에서 왔다 = 상대 팀 이름은 여전히 봇 행의 것이다(#322 축).
        assertThat(opponent.get("name")).isNotNull();
    }

    /** ③ 모든 유저가 같은 결과 — 서로 다른 덱·계정이라도 바이트가 같다. */
    @Test
    void everyUserSeesTheSameBytes() {
        String a = setupUserWithDeck("tut-same-a");
        String matchA = createTutorialMatch(a);
        playToFinish(a, matchA);

        String b = setupUserWithDeck("tut-same-b");
        // b 의 덱을 일부러 다르게 만든다 — 그래도 경기는 같아야 한다(고정 로스터).
        jdbcClient.sql("UPDATE deck_slots SET player_id = 'P014' WHERE player_id = 'P011' "
                        + "AND deck_id IN (SELECT id FROM decks WHERE user_id = ?)")
                .param(userIdOf("tut-same-b")).update();
        String matchB = createTutorialMatch(b);
        playToFinish(b, matchB);

        for (int half = 1; half <= 2; half++) {
            String logA = halfLog(matchA, half);
            String logB = halfLog(matchB, half);
            assertThat(logA).isEqualTo(logB);
        }
        assertThat(jdbcClient.sql("SELECT seed FROM matches WHERE id = ?").param(matchA)
                .query(String.class).single())
                .isEqualTo(jdbcClient.sql("SELECT seed FROM matches WHERE id = ?").param(matchB)
                        .query(String.class).single());
    }

    /**
     * #493 W9 — <b>완주 보상은 서버가 완료를 관측한 자리에서 발화한다</b>(클라 신고가 아니다).
     *
     * <p>고친 결함: 보상이 {@code POST /api/me/tutorial-complete} 호출 시점에 나갔다 — 완료 모달을
     * 스킵해도, 클라가 임의로 불러도 GEM 300 이 나가는 구조였다. 이제 근거는 서버가 CAS 로 쓴 사실
     * (FINISHED 인 튜토리얼 매치)이고, 그래서 <b>클라 호출이 한 번도 없어도</b> 지급되고
     * <b>몇 번을 불러도</b> 늘지 않는다.
     */
    @Test
    void theCompletionRewardFiresOnTheServersOwnJudgementAndOnlyOnce() {
        String token = setupUserWithDeck("tut-reward");
        String userId = userIdOf("tut-reward");

        // ① 경기를 끝내기 전에는 클라가 완료를 신고해도 지급되지 않는다(= 스킵·임의 호출 차단).
        assertThat(authPost("/api/me/tutorial-complete", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(tutorialRewardMails(userId)).as("클라 신고만으로는 근거가 없다").isZero();

        // ② 서버가 완료를 만드는 순간 지급된다 — 이 경로엔 tutorial-complete 호출이 없다.
        String matchId = createTutorialMatch(token);
        playToFinish(token, matchId);
        assertThat(tutorialRewardMails(userId)).as("완료의 근거는 FINISHED 인 튜토리얼 매치다").isEqualTo(1);

        // ③ 이후 클라가 몇 번을 신고해도 늘지 않는다(멱등 축은 우편 유니크 그대로).
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat(tutorialRewardMails(userId)).isEqualTo(1);
    }

    private int tutorialRewardMails(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM user_mails WHERE user_id = ? AND campaign_id = ?")
                .params(userId, "uxa_tutorial_done").query(Integer.class).single();
    }

    /** 반복 생성 차단 — 구운 로그는 언제나 크게 이기므로 열어 두면 승리 보상이 무한 발행된다. */
    @Test
    void aSecondTutorialMatchIsRefusedAfterTheFirstOneFinished() {
        String token = setupUserWithDeck("tut-once");
        String matchId = createTutorialMatch(token);
        playToFinish(token, matchId);

        ResponseEntity<Map> again = authPost("/api/matches", token, Map.of("tutorial", true), Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(again.getBody().get("code")).isEqualTo("TUTORIAL_ALREADY_PLAYED");

        // 일반 연습경기는 계속 만들 수 있다(막은 것은 튜토리얼뿐이다).
        ResponseEntity<Map> normal = authPost("/api/matches", token, Map.of(), Map.class);
        assertThat(normal.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(normal.getBody().get("tutorial")).isEqualTo(false);
    }

    /** A(베이스) 잡 = 매치에 매이지 않은 크로스매치 캐시 행(#95). 이게 늘면 AI 를 부르겠다는 뜻이다. */
    private int baseJobs() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Integer.class).single();
    }

    private String halfLog(String matchId, int half) {
        return jdbcClient.sql("SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(String.class).single();
    }
}
