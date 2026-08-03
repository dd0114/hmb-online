package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.away.AwayService;
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

    /** 지시 조회 응답의 허용 키 — <b>정확집합</b>. */
    private static final Set<String> PROMPTS_KEYS = Set.of("teamPrompt", "players");
    private static final Set<String> PROMPT_ENTRY_KEYS = Set.of("playerId", "text", "phase");
    /**
     * 상대 선수 1인의 허용 키 — <b>정확집합</b>. 센티넬(문자열)만으로는 <b>컨디션·전술처럼 숫자로
     * 새는 축</b>을 못 막는다(독립검증 blocker-1: 슬롯에 condition 을 실어도 초판 계약은 green).
     */
    private static final Set<String> OPPONENT_PLAYER_KEYS =
            Set.of("playerId", "name", "position", "grade", "star", "ovr", "attributes", "hasPrompt");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private AwayService awayService;

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

    private static Set<String> keysOf(JsonNode node) {
        Set<String> keys = new LinkedHashSet<>();
        node.fieldNames().forEachRemaining(keys::add);
        return keys;
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
        assertThat(keysOf(deckOnly)).as("응답 키를 얼린다").isEqualTo(PROMPTS_KEYS);
        for (JsonNode entry : deckOnly.path("players")) {
            assertThat(keysOf(entry)).as("항목 키를 얼린다").isEqualTo(PROMPT_ENTRY_KEYS);
        }
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

    /**
     * <b>원정 수비자</b>(= 이 매치를 볼 수 있는 유일한 비소유자)도 지시는 못 읽는다 — 404.
     *
     * <p>⚠️ 이게 <b>실제 위험 경로</b>다. 아무 관계 없는 stranger 는 {@code getViewable} 로도 404 라,
     * stranger 만으로 계약을 세우면 <b>{@code getOwned} → {@code getViewable} 로 낮추는 변경이 통과</b>
     * 한다(독립검증 major-2). 그런데 getViewable 이 여는 그 사람이 바로 수비자이고, 수비자가 공격자
     * 지시문을 읽는 것이 #245 BL-1 이 막았던 정확히 그 유출이다(일방적 스카우팅).
     *
     * <p>그래서 <b>관전 권한이 실재함을 먼저 단언</b>한다(매치 GET 200) — 그 사람이 위험한 자리에
     * 서 있다는 사실이 증명된 뒤라야 404 가 뜻을 갖는다.
     */
    @Test
    void awayDefenderCanWatchTheMatchButCannotReadPrompts() {
        String owner = setupWithSentinelDeck("mp_pr_atk");
        String ownerId = userIdOf("mp_pr_atk");
        String defender = setupWithSentinelDeck("mp_pr_def", DEFENDER_SENTINEL, DEFENDER_TEAM_SENTINEL);
        String defenderId = userIdOf("mp_pr_def");
        String matchId = createMatch(owner, null);

        // 정산된 피침공 기록 = 수비자 관전 권한의 근거(AwayViewAccess.canWatch).
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT INTO away_challenges(match_id, defender_id, ghost_bot_id, created_at)
                        VALUES (?, ?, 'BOT_BAL', ?)
                        """)
                .params(matchId, defenderId, now).update();
        awayService.settle(matchId, ownerId, "WIN", 2, 0);

        // ① 수비자는 이 매치를 실제로 열 수 있다(= getViewable 이 여는 자리에 서 있다).
        ResponseEntity<String> watched = authGet("/api/matches/" + matchId, defender, String.class);
        assertThat(watched.getStatusCode()).as(watched.getBody()).isEqualTo(HttpStatus.OK);
        assertThat(watched.getBody()).as("관전 응답에도 공격자 지시문은 없다(#245 BL-1)")
                .doesNotContain(DECK_SENTINEL).doesNotContain(TEAM_SENTINEL);

        // ② 그래도 지시 조회는 404 다 — 관전 권한은 조작·열람 권한이 아니다.
        ResponseEntity<String> prompts =
                authGet("/api/matches/" + matchId + "/prompts", defender, String.class);
        assertThat(prompts.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(prompts.getBody()).doesNotContain(DECK_SENTINEL).doesNotContain(TEAM_SENTINEL);
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
            // 키 동결 — 컨디션·전술처럼 **숫자로 새는 축**은 문자열 대조에 안 걸린다(blocker-1).
            assertThat(keysOf(p)).as("상대 선수 키를 얼린다").isEqualTo(OPPONENT_PLAYER_KEYS);
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
    void awayGhostOpponentShowsStarsAndFrozenStatsButLeaksNoPromptText() {
        setupWithSentinelDeck("mp_ghost_def", DEFENDER_SENTINEL, DEFENDER_TEAM_SENTINEL);
        String defenderId = userIdOf("mp_ghost_def");
        markPlayedOnce(defenderId);
        // 수비자에게 성장을 심는다 — 그래야 "얼린 스탯"과 "카탈로그 원본"이 **갈린다**.
        // 안 그러면 얼린 값 분기를 죽여도 값이 같아 계약이 통과한다(독립검증 minor-3).
        jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id = ? AND player_id = 'P002'")
                .params("{\"pace\":5.0}", defenderId).update();
        int catalogPace = catalogAttribute("P002", "pace");
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
        // ④ **표시 = 실제로 뛰는 값**: 고스트에 얼린 수비자 유효스탯이지 카탈로그 원본이 아니다.
        //    (이 단언이 그 분기의 존재 이유다 — 상대가 약화판으로 서면 계산이 틀린 것이다, #245 MAJ-3.)
        assertThat(p002.path("attributes").path("pace").asDouble())
                .as("얼린 유효스탯(성장 반영)이어야 한다 — 카탈로그 원본 %d 가 아니다", catalogPace)
                .isGreaterThan(catalogPace);
        // OVR 도 그 값으로 계산됐는지(표시와 계산이 같은 값을 쓰는지) 함께 본다.
        assertThat(p002.path("ovr").asDouble()).isGreaterThan(0.0);
    }

    /** 카탈로그 원본 능력치 1개 — "얼린 값"과 갈리는지 볼 기준선. */
    private int catalogAttribute(String playerId, String stat) {
        String json = jdbcClient.sql("SELECT attributes_json FROM players WHERE id = ?")
                .param(playerId).query(String.class).single();
        return json(json).path(stat).asInt();
    }
}
