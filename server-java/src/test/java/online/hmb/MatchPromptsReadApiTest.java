package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>매치에 실제 반영된 지시 조회</b> {@code GET /api/matches/{id}/prompts} (#431) +
 * {@code MatchDetail.opponent.deck[]} additive 4필드.
 *
 * <p>#431 의 문제: 쓰기({@code POST .../prompts})만 있고 읽기가 없어 <b>후반에 선수 상세를 열면
 * 방금 바꾼 지시가 아니라 덱에 저장된 옛 지시</b>가 떴다. 그래서 이 API 는 "덱에 뭐라고 썼나"가
 * 아니라 <b>덱 ← pre ← halftime 병합 결과</b>(= {@code PromptContextBuilder.userPromptSet} 의 규칙)를
 * 돌려주고, 값이 확정된 단계를 {@code phase} 로 말한다.
 *
 * <p><b>소유자 전용</b>. 비소유자는 404 이고, 그 응답에도 지시문 원문이 없다(센티넬 대조).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchPromptsReadApiTest extends MatchTestBase {

    private static final String DECK_SENTINEL = "SENTINEL-DECK-71ab";
    private static final String PRE_SENTINEL = "SENTINEL-PRE-33cd";
    private static final String HALFTIME_SENTINEL = "SENTINEL-HALFTIME-90ef";
    private static final String TEAM_SENTINEL = "SENTINEL-TEAM-4c1b";
    /**
     * <b>수비자(고스트가 될 유저)만</b> 쓰는 센티넬. 공격자와 같은 문자열을 쓰면 공격자 자신의
     * {@code userDeckSnapshot}(자기 덱이라 정당하게 나간다)이 대조에 걸려 <b>계약이 자기 데이터를
     * 누설로 오인</b>한다 — 실제로 그렇게 걸렸다. 누구 것인지로 갈라야 계약이 참말을 한다.
     */
    private static final String DEFENDER_SENTINEL = "SENTINEL-DEF-5a7c";
    private static final String DEFENDER_TEAM_SENTINEL = "SENTINEL-DEFTEAM-6b8d";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** P002 에 덱 지시(센티넬) + 팀 지시(센티넬). 나머지는 지시 없음. */
    private String setupWithSentinelDeck(String nickname) {
        return setupWithSentinelDeck(nickname, DECK_SENTINEL, TEAM_SENTINEL);
    }

    private String setupWithSentinelDeck(String nickname, String playerPrompt, String teamPrompt) {
        String token = login(nickname);
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 2
                    ? slot("P002", "starter", 1, playerPrompt)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("formation", "4-4-2");
        body.put("teamPrompt", teamPrompt);
        body.put("slots", slots);
        assertThat(authPut("/api/deck", token, body, Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        return token;
    }

    private JsonNode json(String body) {
        try {
            return MAPPER.readTree(body);
        } catch (Exception e) {
            throw new IllegalStateException("bad json: " + body, e);
        }
    }

    private JsonNode promptsOf(String token, String matchId) {
        ResponseEntity<String> res = authGet("/api/matches/" + matchId + "/prompts", token, String.class);
        assertThat(res.getStatusCode()).as(res.getBody()).isEqualTo(HttpStatus.OK);
        return json(res.getBody());
    }

    private JsonNode playerEntry(JsonNode prompts, String playerId) {
        for (JsonNode entry : prompts.path("players")) {
            if (playerId.equals(entry.path("playerId").asText())) {
                return entry;
            }
        }
        throw new AssertionError(playerId + " 항목이 응답에 없다: " + prompts);
    }

    private void submitPrompt(String token, String matchId, String phase, String playerId, String text) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("phase", phase);
        body.put("scope", playerId == null ? "team" : "player");
        if (playerId != null) {
            body.put("playerId", playerId);
        }
        body.put("text", text);
        ResponseEntity<String> res = authPost("/api/matches/" + matchId + "/prompts", token, body, String.class);
        assertThat(res.getStatusCode()).as(res.getBody()).isEqualTo(HttpStatus.OK);
    }

    // ── 소유자: 매치에 실제 반영된 값 ───────────────────────────────────

    /**
     * 덱 지시밖에 없으면 그 값이 <b>매치에 걸린 지시</b>다 — 단계는 {@code pre}(경기 전부터 유효).
     * 그 위에 pre 를 쓰면 pre 가 이기고, 감독시간에 쓰면 halftime 이 이긴다(뒤가 이긴다).
     */
    @Test
    void effectivePromptsMergeDeckThenPreThenHalftime() {
        String token = setupWithSentinelDeck("mp_owner");
        String matchId = createMatch(token, null);

        // ① 덱만 — 덱 문장이 그대로 유효하고 팀 문장도 덱값이다.
        JsonNode deckOnly = promptsOf(token, matchId);
        assertThat(deckOnly.path("teamPrompt").asText()).isEqualTo(TEAM_SENTINEL);
        assertThat(playerEntry(deckOnly, "P002").path("text").asText()).isEqualTo(DECK_SENTINEL);
        assertThat(playerEntry(deckOnly, "P002").path("phase").asText()).isEqualTo("pre");

        // ② pre 제출 — 덱값을 덮는다.
        submitPrompt(token, matchId, "pre", "P002", PRE_SENTINEL);
        submitPrompt(token, matchId, "pre", null, "팀 " + PRE_SENTINEL);
        JsonNode afterPre = promptsOf(token, matchId);
        assertThat(afterPre.path("teamPrompt").asText()).isEqualTo("팀 " + PRE_SENTINEL);
        assertThat(playerEntry(afterPre, "P002").path("text").asText()).isEqualTo(PRE_SENTINEL);
        assertThat(playerEntry(afterPre, "P002").path("phase").asText()).isEqualTo("pre");

        // ③ 감독시간 제출 — pre 를 덮고, 단계가 halftime 으로 바뀐다(#431 이 못 읽던 그 값).
        forceState(matchId, "HALFTIME");
        submitPrompt(token, matchId, "halftime", "P002", HALFTIME_SENTINEL);
        submitPrompt(token, matchId, "halftime", "P003", HALFTIME_SENTINEL + "-new");
        JsonNode afterHalftime = promptsOf(token, matchId);
        assertThat(playerEntry(afterHalftime, "P002").path("text").asText()).isEqualTo(HALFTIME_SENTINEL);
        assertThat(playerEntry(afterHalftime, "P002").path("phase").asText()).isEqualTo("halftime");
        // 덱에 없던 선수에게 감독시간에 처음 준 지시도 읽힌다.
        assertThat(playerEntry(afterHalftime, "P003").path("phase").asText()).isEqualTo("halftime");
        // 지시가 없는 선수는 아예 항목이 없다(빈 문자열로 있는 척하지 않는다).
        assertThat(afterHalftime.path("players")).noneSatisfy(
                e -> assertThat(e.path("playerId").asText()).isEqualTo("P004"));
    }

    /** 벤치 선수의 덱 지시도 읽힌다 — 선수 상세는 벤치도 연다(로스터 11명으로 좁히면 사라진다). */
    @Test
    void benchPlayerPromptIsIncluded() {
        String token = login("mp_bench");
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0, DECK_SENTINEL + "-bench"));
        assertThat(authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        String matchId = createMatch(token, null);

        assertThat(playerEntry(promptsOf(token, matchId), "P012").path("text").asText())
                .isEqualTo(DECK_SENTINEL + "-bench");
    }

    // ── 비소유자 ────────────────────────────────────────────────────────

    /** 남의 매치 지시는 <b>404</b>(존재를 숨긴다) — 그리고 본문에 원문이 없다. */
    @Test
    void nonOwnerGetsNotFoundAndNoPromptText() {
        String owner = setupWithSentinelDeck("mp_owner2");
        String matchId = createMatch(owner, null);
        String stranger = setupWithSentinelDeck("mp_stranger");

        ResponseEntity<String> res = authGet("/api/matches/" + matchId + "/prompts", stranger, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody())
                .doesNotContain(DECK_SENTINEL)
                .doesNotContain(TEAM_SENTINEL);
    }

    @Test
    void unknownMatchIsNotFound() {
        String token = setupWithSentinelDeck("mp_unknown");
        assertThat(authGet("/api/matches/01NOPE0000000000000000000/prompts", token, String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── #431 곁가지: opponent.deck[] additive ───────────────────────────

    /**
     * 상대 선수에 {@code playerId}·{@code star}·{@code ovr}·{@code attributes} 가 실린다 —
     * 기존 4필드({@code name}/{@code position}/{@code grade}/{@code hasPrompt})는 그대로(구 클라 무해).
     */
    @Test
    void opponentDeckCarriesIdStarOvrAndAttributes() {
        String token = setupWithSentinelDeck("mp_opp");
        String matchId = createMatch(token, null);

        ResponseEntity<String> res = authGet("/api/matches/" + matchId, token, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode deck = json(res.getBody()).path("opponent").path("deck");
        assertThat(deck.isArray()).isTrue();
        assertThat(deck.size()).isEqualTo(11);

        for (JsonNode p : deck) {
            assertThat(p.path("playerId").asText()).as("선수와 이을 수 있어야 한다").isNotBlank();
            assertThat(p.path("name").asText()).isNotBlank();
            assertThat(p.path("position").asText()).isNotBlank();
            assertThat(p.path("grade").asText()).isNotBlank();
            assertThat(p.has("hasPrompt")).isTrue();
            assertThat(p.path("ovr").asDouble()).as("OVR 을 못 그려서 자리를 비우던 것을 채운다").isGreaterThan(0.0);
            assertThat(p.path("attributes").isObject()).isTrue();
            assertThat(p.path("attributes").size()).isGreaterThanOrEqualTo(9);
            assertThat(p.has("star")).isTrue();
        }
        // 성장 진행도는 상대에게도 나가지 않는다(#431 코멘트 — 공개 범위가 한 칸 넓어진다).
        assertThat(res.getBody()).doesNotContain("statAdd").doesNotContain("caps").doesNotContain("startLo");
    }

    /**
     * 원정 고스트(= 실유저 팀)를 상대할 때: <b>★ 는 그 유저 카드의 값</b>이고, <b>지시문은 안 나간다</b>.
     *
     * <p>이 경로가 진짜 누설 경로다 — 고스트 덱은 수비자의 실제 덱(선수별 지시 포함)을 구운 것이다.
     */
    @Test
    void awayGhostOpponentShowsStarsButLeaksNoPromptText() {
        setupWithSentinelDeck("mp_ghost_def", DEFENDER_SENTINEL, DEFENDER_TEAM_SENTINEL);
        String defenderId = userIdOf("mp_ghost_def");
        markPlayedOnce(defenderId);
        String attacker = setupWithSentinelDeck("mp_ghost_atk");

        ResponseEntity<String> candidates = authGet("/api/away/candidates", attacker, String.class);
        assertThat(candidates.getStatusCode()).as(candidates.getBody()).isEqualTo(HttpStatus.OK);
        String offered = json(candidates.getBody()).path("candidates").get(0).path("userId").asText();
        assertThat(offered).isEqualTo(defenderId);

        ResponseEntity<String> created = authPost("/api/away/matches", attacker,
                Map.of("defenderId", offered), String.class);
        assertThat(created.getStatusCode()).as(created.getBody()).isEqualTo(HttpStatus.CREATED);
        String matchId = json(created.getBody()).path("id").asText();

        ResponseEntity<String> detail = authGet("/api/matches/" + matchId, attacker, String.class);
        assertThat(detail.getStatusCode()).isEqualTo(HttpStatus.OK);
        // ① 누설 0 — **수비자** 덱의 지시문·팀 문장이 응답 본문 어디에도 없다.
        //    (공격자 자신의 지시는 userDeckSnapshot 으로 정당하게 나가므로 센티넬을 갈라 뒀다.)
        assertThat(detail.getBody())
                .doesNotContain(DEFENDER_SENTINEL)
                .doesNotContain(DEFENDER_TEAM_SENTINEL);

        JsonNode deck = json(detail.getBody()).path("opponent").path("deck");
        JsonNode p002 = null;
        for (JsonNode p : deck) {
            if ("P002".equals(p.path("playerId").asText())) {
                p002 = p;
            }
        }
        assertThat(p002).as("고스트 상대의 선수를 id 로 짚을 수 있어야 한다").isNotNull();
        // ② "지시 있음"은 말한다(내용은 아니다) — W3 이 `🔒 지시 있음` 을 복원할 근거.
        assertThat(p002.path("hasPrompt").asBoolean()).isTrue();
        // ③ ★ 는 그 유저 카드의 값이다(봇처럼 0 이 아니다).
        assertThat(p002.path("star").asInt()).as("실유저 카드의 ★").isGreaterThanOrEqualTo(1);
    }
}
