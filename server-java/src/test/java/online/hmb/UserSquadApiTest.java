package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.away.AwayService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>타 유저 선수단 조회</b> {@code GET /api/users/{targetUserId}/squad} (#432).
 *
 * <p>공개 범위는 hero 확정(2026-08-02 결정 ③ A안) — 이름·포지션·등급·★·OVR·능력치 + <b>"지시 있음"
 * 여부만</b>. 지시문 내용·팀 프롬프트는 어떤 경로로도 나가지 않는다.
 *
 * <p><b>누설 계약의 모양이 중요하다</b>: 필드 이름을 열거해 막으면 <b>나중에 추가되는 필드를 못
 * 막는다</b>. 그래서 대상 유저 덱에 고유 센티넬 문자열을 심고 <b>응답 본문 전체(raw JSON)</b> 에 그
 * 문자열이 없다고 단언한다 — 필드를 하나 더 흘리든 중첩 객체로 새든 죽는다.
 *
 * <p>자격은 <b>DB 행</b>으로 표현한다({@code AwayViewAccess} 관례): 현재 유효한 원정 후보 제시 ∪
 * 나를 친 원정 기록(복수 큐) ∪ 랭킹보드 등재. 자격 밖·없는 유저는 <b>404</b>(403 이 아니다 — 이
 * 리포는 {@code MatchService.getViewable} 처럼 존재 자체를 숨긴다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class UserSquadApiTest extends MatchTestBase {

    /** 대상 유저의 <b>선수</b> 지시문에만 존재하는 문자열. 응답 어디에도 나오면 안 된다. */
    private static final String PLAYER_SENTINEL = "SENTINEL-PROMPT-9f2a";
    /** 대상 유저의 <b>팀</b> 지시문에만 존재하는 문자열. */
    private static final String TEAM_SENTINEL = "SENTINEL-TEAM-4c1b";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private AwayService awayService;

    @BeforeEach
    void clearPrewarmLedger() {
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 선발 11 + 벤치 2. P002 에만 선수 지시, 덱에 팀 지시 — 둘 다 센티넬이다. */
    private String setupTargetWithSentinelDeck(String nickname) {
        String token = login(nickname);
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 2
                    ? slot("P002", "starter", 1, PLAYER_SENTINEL)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, PLAYER_SENTINEL + "-bench"));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("formation", "4-4-2");
        body.put("teamPrompt", TEAM_SENTINEL);
        body.put("slots", slots);
        assertThat(authPut("/api/deck", token, body, Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        return token;
    }

    private ResponseEntity<String> squad(String viewerToken, String targetUserId) {
        return authGet("/api/users/" + targetUserId + "/squad", viewerToken, String.class);
    }

    private JsonNode json(String body) {
        try {
            return MAPPER.readTree(body);
        } catch (Exception e) {
            throw new IllegalStateException("bad json: " + body, e);
        }
    }

    private long aiJobRows() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs").query(Long.class).single();
    }

    /** 완료(result 있는) 경기 수 — 랭킹보드 자격의 근거. 자격 절을 격리 검증할 때 쓴다. */
    private long finishedWithResult(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM matches WHERE user_id = ? AND result IS NOT NULL")
                .param(userId).query(Long.class).single();
    }

    // ── 핵심: 누설 0 ────────────────────────────────────────────────────

    /**
     * 랭킹보드에 오른 유저의 선수단은 보이되, <b>지시문은 한 글자도 나가지 않는다</b>.
     *
     * <p>raw 본문 대조라 새 필드가 늘어도 계약이 유지된다. 함께 거는 것: 성장 <b>진행도</b>
     * ({@code caps}/{@code statAdd}/{@code startLo})는 "능력치 공개"가 아니라 hero 결정 ③ 범위 밖이다.
     */
    @Test
    void rankedUsersSquadIsVisibleButLeaksNoPromptText() {
        setupTargetWithSentinelDeck("squad_target");
        String targetId = userIdOf("squad_target");
        markPlayedOnce(targetId);                       // 랭킹보드 등재 자격(#296 완료 경기 1판)
        String viewer = login("squad_viewer");

        ResponseEntity<String> res = squad(viewer, targetId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        String raw = res.getBody();

        // ① 누설 0 — 본문 전체 대조(필드명 열거로는 새 필드를 못 막는다).
        assertThat(raw).as("선수 지시문이 새면 안 된다").doesNotContain(PLAYER_SENTINEL);
        assertThat(raw).as("팀 지시문이 새면 안 된다").doesNotContain(TEAM_SENTINEL);
        // ② 성장 진행도는 공개 범위 밖(#431 코멘트) — 이름으로도 값으로도.
        assertThat(raw).doesNotContain("statAdd").doesNotContain("caps").doesNotContain("startLo")
                .doesNotContain("prePotential").doesNotContain("promptText").doesNotContain("teamPrompt");

        // ③ 화면이 그릴 것은 다 있다(계약 스키마 #432 코멘트).
        JsonNode body = json(raw);
        assertThat(body.path("userId").asText()).isEqualTo(targetId);
        assertThat(body.path("nickname").asText()).isEqualTo("squad_target");
        assertThat(body.path("formation").asText()).isEqualTo("4-4-2");
        assertThat(body.has("rating")).isTrue();
        assertThat(body.has("streak")).isTrue();

        JsonNode slots = body.path("slots");
        assertThat(slots.isArray()).isTrue();
        assertThat(slots.size()).as("벤치 포함 = 선수단 구경").isEqualTo(13);

        JsonNode withPrompt = slotOf(slots, "P002");
        assertThat(withPrompt.path("hasPrompt").asBoolean()).as("있음/없음만 말한다").isTrue();
        assertThat(withPrompt.path("name").asText()).isNotBlank();
        assertThat(withPrompt.path("position").asText()).isNotBlank();
        assertThat(withPrompt.path("grade").asText()).isNotBlank();
        assertThat(withPrompt.path("star").asInt()).isGreaterThanOrEqualTo(1);
        assertThat(withPrompt.path("ovr").asDouble()).isGreaterThan(0.0);
        assertThat(withPrompt.path("attributes").isObject()).isTrue();
        assertThat(withPrompt.path("attributes").size()).isGreaterThanOrEqualTo(9);
        assertThat(withPrompt.path("role").asText()).isEqualTo("starter");
        assertThat(withPrompt.path("slotIndex").asInt()).isEqualTo(1);

        assertThat(slotOf(slots, "P003").path("hasPrompt").asBoolean())
                .as("지시가 없는 선수는 false").isFalse();
        assertThat(slotOf(slots, "P013").path("role").asText()).isEqualTo("bench");
    }

    /**
     * <b>능력치는 성장 반영 유효치</b>다(카탈로그 기본치가 아니다) — 스탯을 올린 뒤 값이 따라 움직인다.
     *
     * <p>계약을 "값이 존재한다"로만 걸면 카탈로그 원본을 실어도 통과한다. 성장분을 심고 <b>차이</b>를
     * 본다.
     */
    @Test
    void attributesReflectGrowthNotCatalogBase() {
        setupTargetWithSentinelDeck("squad_grown");
        String targetId = userIdOf("squad_grown");
        markPlayedOnce(targetId);
        String viewer = login("sq_grow_viewer");

        double before = slotOf(json(squad(viewer, targetId).getBody()).path("slots"), "P003")
                .path("attributes").path("pace").asDouble();

        jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id = ? AND player_id = 'P003'")
                .params("{\"pace\":5.0}", targetId)
                .update();

        JsonNode after = slotOf(json(squad(viewer, targetId).getBody()).path("slots"), "P003");
        assertThat(after.path("attributes").path("pace").asDouble())
                .as("성장분이 응답에 반영돼야 한다(카탈로그 기본치를 실으면 안 움직인다)")
                .isGreaterThan(before);
    }

    // ── 자격: DB 행이 근거 ──────────────────────────────────────────────

    /** 자격 밖이면 <b>404</b> — 존재를 숨긴다(403 팩토리가 이 리포에 없다). */
    @Test
    void userWithoutAnyRelationIsNotFound() {
        setupTargetWithSentinelDeck("squad_hidden");     // 덱은 있지만 완료 경기 0 = 보드 밖
        String hiddenId = userIdOf("squad_hidden");
        String viewer = login("squad_stranger");

        assertThat(finishedWithResult(hiddenId)).as("자격 절 격리 — 랭킹 자격이 없어야 한다").isZero();
        ResponseEntity<String> res = squad(viewer, hiddenId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody()).doesNotContain(PLAYER_SENTINEL).doesNotContain(TEAM_SENTINEL);
    }

    @Test
    void unknownUserIsNotFound() {
        String viewer = login("sq_unk_viewer");
        assertThat(squad(viewer, "01NOPE0000000000000000000").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /** 서버가 방금 제시한 원정 후보는 볼 수 있다(클라가 이미 그 userId 를 서버에서 받았다). */
    @Test
    void offeredAwayCandidateIsVisible() {
        setupOpponentWithDeck("squad_cand_a");
        setupOpponentWithDeck("squad_cand_b");
        String viewer = setupUserWithDeck("sq_cand_viewer");
        String viewerId = userIdOf("sq_cand_viewer");

        List<AwayService.Candidate> offered = awayService.offerCandidates(viewerId);
        assertThat(offered).isNotEmpty();
        assertThat(squad(viewer, offered.get(0).userId()).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /**
     * 나를 친 상대(복수 큐의 그 사람)는 볼 수 있다 — 근거는 {@code away_reports} 행이다.
     *
     * <p>⚠️ 이 절을 <b>격리</b>해 검증한다: 공격자는 완료(result 있는) 경기가 0 이라 랭킹보드
     * 자격이 없다. 그래도 200 이면 통과시킨 것은 리포트 행뿐이다.
     */
    @Test
    void attackerWhoRaidedMeIsVisible() {
        setupUserWithDeck("squad_raider");
        String raiderId = userIdOf("squad_raider");
        String viewer = setupUserWithDeck("squad_victim");
        String viewerId = userIdOf("squad_victim");

        awayService.settle(seedAwayChallenge(raiderId, viewerId), raiderId, "WIN", 2, 0);

        assertThat(finishedWithResult(raiderId)).as("자격 절 격리 — 랭킹 자격은 없어야 한다").isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND attacker_id = ?")
                .params(viewerId, raiderId).query(Long.class).single()).isEqualTo(1);
        assertThat(squad(viewer, raiderId).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** 정산은 매치·도전장이 있어야 한다 — 시뮬을 돌리지 않고 그 상태만 만든다(AwayV2Test 와 같은 방식). */
    private String seedAwayChallenge(String attackerId, String defenderId) {
        String matchId = online.hmb.common.Ulid.next();
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', 'away', ?)
                        """)
                .params(matchId, attackerId, now).update();
        jdbcClient.sql("""
                        INSERT INTO away_challenges(match_id, defender_id, ghost_bot_id, created_at)
                        VALUES (?, ?, 'BOT_BAL', ?)
                        """)
                .params(matchId, defenderId, now).update();
        return matchId;
    }

    // ── 읽기 전용 ───────────────────────────────────────────────────────

    /**
     * <b>남의 화면을 보는 것만으로 AI 예산이 나가면 안 된다</b>(#432 §4-5 · 판단 ③).
     * {@code GET /api/deck} 의 프리워밍 부수효과({@code DeckController:41-43})를 옮겨오지 않았다는 계약.
     */
    @Test
    void squadReadEnqueuesNoAiJob() {
        setupTargetWithSentinelDeck("squad_nojob");
        String targetId = userIdOf("squad_nojob");
        markPlayedOnce(targetId);
        String viewer = login("sq_nojob_viewer");

        // 프리워밍이 붙었다면 "만들 것이 있는" 상태여야 관측된다 — 큐와 원장을 비우고 본다.
        jdbcClient.sql("DELETE FROM ai_jobs").update();
        jdbcClient.sql("DELETE FROM deck_prewarm").update();

        assertThat(squad(viewer, targetId).getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(aiJobRows()).as("읽기 전용 API 가 AI 잡을 만들면 안 된다").isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM deck_prewarm").query(Long.class).single())
                .as("프리워밍 원장도 건드리지 않는다").isZero();
    }

    private JsonNode slotOf(JsonNode slots, String playerId) {
        for (JsonNode slot : slots) {
            if (playerId.equals(slot.path("playerId").asText())) {
                return slot;
            }
        }
        throw new AssertionError(playerId + " 슬롯이 응답에 없다: " + slots);
    }
}
