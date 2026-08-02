package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.growth.GrowthService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>3지선다 선택 API 계약</b>(#405 W2b, 설계 §2.5·§2.10).
 *
 * <ul>
 *   <li>계약 2 — <b>후보 박제</b>: 선택을 미룬 사이 스탯이 움직여도 후보·gain 이 안 바뀐다.</li>
 *   <li>계약 5 — <b>중복 선택 차단</b>: 같은 선택권을 두 번 쓰면 두 번째는 거부되고 스탯은 한 번만 오른다.</li>
 *   <li>계약 8 — <b>경기 중 잠금</b>: 라이브 매치 중 선택은 409({@code growth.star}·{@code growth.dice}
 *       와 같은 이유 — 전·후반 사이 강화가 후반만 강하게 만든다).</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthChoiceApiTest extends MatchTestBase {

    private static final List<String> STARTERS = List.of("P001", "P002", "P003", "P004", "P005",
            "P006", "P007", "P008", "P009", "P010", "P011");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private GrowthService growthService;

    // ── 계약 2: 후보 박제 ────────────────────────────────────────────────

    /**
     * 선택을 미룬 사이 다른 경로로 스탯이 올라도 <b>후보와 gain 이 그대로</b>여야 한다.
     * 안 그러면 "화면엔 +2.9 라고 써 있었는데 +2.1 이 들어왔다"가 된다(hero 명시 요구).
     */
    @SuppressWarnings("unchecked")
    @Test
    void frozenCandidatesDoNotDriftWhenTheCardGrowsInTheMeantime() {
        String token = setupUserWithDeck("gch_freeze");
        String userId = userIdOf("gch_freeze");
        settleOnce(token, userId, "gch_freeze");

        Map<String, Object> before = firstPending(userId, "P001");
        List<Map<String, Object>> candidatesBefore = (List<Map<String, Object>>) before.get("candidates");
        String stat = (String) candidatesBefore.get(0).get("stat");
        double gainBefore = ((Number) candidatesBefore.get(0).get("gain")).doubleValue();

        // 그 사이 같은 스탯이 크게 올랐다 — 감쇠 곡선상 gain 이 줄어야 "정상"인 상황을 만든다.
        jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id=? AND player_id='P001'")
                .params("{\"" + stat + "\": 20.0}", userId).update();

        Map<String, Object> after = firstPending(userId, "P001");
        assertThat(after.get("candidates"))
                .as("후보·gain 이 박제되지 않았다 — 미뤄서 고르면 화면과 다른 값이 들어간다")
                .isEqualTo(candidatesBefore);

        // 실제로 적용되는 값도 박제본이다.
        Map<String, Object> applied = growthService.applyChoice(userId, (String) after.get("choiceId"), stat);
        assertThat(((Number) applied.get("gain")).doubleValue()).isEqualTo(gainBefore);
        assertThat(statAdd(userId, "P001", stat)).isEqualTo(20.0 + gainBefore);
    }

    /**
     * <b>이유도 gain 과 함께 박제된다</b>(목업 화면 ③ "왜 이 후보인가"). 재계산 방식이면 그 사이
     * 다음 경기를 치른 카드의 이유가 바뀌어 "슛 4회라서 나왔다"던 후보가 다른 말을 한다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void everyCandidateCarriesAFrozenReason() {
        String token = setupUserWithDeck("gch_reason");
        String userId = userIdOf("gch_reason");
        settleOnce(token, userId, "gch_reason");

        List<Map<String, Object>> before =
                (List<Map<String, Object>>) firstPending(userId, "P001").get("candidates");
        assertThat(before).allSatisfy(c -> {
            Map<String, Object> reason = (Map<String, Object>) c.get("reason");
            assertThat(reason).as("후보에 reason 이 없다 — 화면이 '왜 이 후보인가'를 못 그린다").isNotNull();
            assertThat(reason).containsKeys("kind", "detail");
            assertThat((String) reason.get("kind"))
                    .isIn("EVENT", "BEHAVIOR", "POSITION", "RESULT", "LEGACY", "BASE");
        });

        // ⚠️ **응답이 박제본과 같은지**를 DB 바이트와 대조한다. 앞뒤를 응답끼리만 비교하면 읽기
        //    경로를 <b>일관되게</b> 망가뜨리는 변이체가 통과한다 — 실제로 readReason 이 항상 BASE 를
        //    돌려주게 만든 변이체가 그 형태로 살아남았다(before == after 라 관측 불가).
        Map<String, Object> pending = firstPending(userId, "P001");
        assertThat(storedCandidates(userId, "P001", ((Number) pending.get("level")).intValue()))
                .as("응답의 후보가 candidates_json 박제본과 다르다 — 어딘가가 재계산하거나 삼키고 있다")
                .isEqualTo(pending.get("candidates"));

        // 그 사이 카드가 자라도 이유는 그대로여야 한다(gain 과 같은 계약).
        jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id=? AND player_id='P001'")
                .params("{\"shooting\": 20.0, \"tackling\": 15.0}", userId).update();
        assertThat(firstPending(userId, "P001").get("candidates"))
                .as("스탯이 움직이자 후보의 reason 이 바뀌었다 — 박제되지 않았다")
                .isEqualTo(before);
    }

    /** DB 에 실제로 박힌 후보 배열(응답이 아니라 <b>바이트</b>). */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> storedCandidates(String userId, String playerId, int level) {
        String json = jdbcClient.sql("""
                        SELECT candidates_json FROM growth_level_choices
                        WHERE user_id=? AND player_id=? AND level=?
                        """)
                .params(userId, playerId, level).query(String.class).single();
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                    .readValue(json, java.util.List.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ── 계약 5: 중복 선택 차단 ───────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void choosingTwiceIsRejectedAndTheStatRisesOnlyOnce() {
        String token = setupUserWithDeck("gch_dup");
        String userId = userIdOf("gch_dup");
        settleOnce(token, userId, "gch_dup");

        Map<String, Object> pending = firstPending(userId, "P001");
        String choiceId = (String) pending.get("choiceId");
        String stat = (String) ((List<Map<String, Object>>) pending.get("candidates")).get(0).get("stat");

        ResponseEntity<Map> first = authPost("/api/growth/choices/" + choiceId, token,
                Map.of("stat", stat), Map.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        double afterFirst = statAdd(userId, "P001", stat);
        assertThat(afterFirst).isGreaterThan(0.0);

        ResponseEntity<Map> second = authPost("/api/growth/choices/" + choiceId, token,
                Map.of("stat", stat), Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(second.getBody().get("code")).isEqualTo("CHOICE_ALREADY_MADE");
        assertThat(statAdd(userId, "P001", stat))
                .as("두 번째 선택이 거부됐는데 스탯이 또 올랐다").isEqualTo(afterFirst);
    }

    /** 후보에 없는 스탯은 400 — 아무 스탯이나 고를 수 있으면 3지선다가 아니다. */
    @SuppressWarnings("unchecked")
    @Test
    void aStatOutsideTheCandidateSetIsRejected() {
        String token = setupUserWithDeck("gch_outside");
        String userId = userIdOf("gch_outside");
        settleOnce(token, userId, "gch_outside");

        Map<String, Object> pending = firstPending(userId, "P001");
        List<String> offered = ((List<Map<String, Object>>) pending.get("candidates")).stream()
                .map(c -> (String) c.get("stat")).toList();
        String notOffered = online.hmb.growth.GrowthTuning.STATS.stream()
                .filter(s -> !offered.contains(s)).findFirst().orElseThrow();

        ResponseEntity<Map> res = authPost("/api/growth/choices/" + pending.get("choiceId"), token,
                Map.of("stat", notOffered), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(statAdd(userId, "P001", notOffered)).isEqualTo(0.0);
    }

    /** 남의 선택권은 <b>404</b> 다 — 403 은 "그 id 는 실재한다"를 흘린다. */
    @SuppressWarnings("unchecked")
    @Test
    void someoneElsesChoiceIsNotFound() {
        String ownerToken = setupUserWithDeck("gch_owner");
        String ownerId = userIdOf("gch_owner");
        settleOnce(ownerToken, ownerId, "gch_owner");
        String choiceId = (String) firstPending(ownerId, "P001").get("choiceId");

        String intruder = login("gch_intruder");
        ResponseEntity<Map> res = authPost("/api/growth/choices/" + choiceId, intruder,
                Map.of("stat", "shooting"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── 계약 8: 경기 중 잠금 ─────────────────────────────────────────────

    /**
     * 라이브 매치 중에는 409. 취향이 아니라 <b>버그 차단</b>이다 —
     * {@code buildSelectData} 가 시뮬 시점에 유효스탯을 읽으므로 전·후반 사이 강화가 후반만 올린다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void choosingDuringALiveMatchIs409() {
        String token = setupUserWithDeck("gch_lock");
        String userId = userIdOf("gch_lock");
        settleOnce(token, userId, "gch_lock");
        String choiceId = (String) firstPending(userId, "P001").get("choiceId");

        // 진행 중(LOCKED) 매치를 하나 만든다.
        releaseActiveMatches();
        String live = createMatch(token, "BOT_BAL");
        forceState(live, "FIRST_HALF");

        ResponseEntity<Map> res = authPost("/api/growth/choices/" + choiceId, token,
                Map.of("stat", "shooting"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
        // 빈 손 409 는 유저를 막다른 길에 세운다 — 어느 매치인지 실어야 한다(#217).
        assertThat(((Map<?, ?>) res.getBody().get("detail")).get("matchId")).isEqualTo(live);
    }

    // ── 목록 API ─────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void pendingListFiltersByPlayerAndDropsChosenOnes() {
        String token = setupUserWithDeck("gch_list");
        String userId = userIdOf("gch_list");
        settleOnce(token, userId, "gch_list");

        ResponseEntity<Map> all = authGet("/api/growth/choices", token, Map.class);
        assertThat(all.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> allChoices = (List<Map<String, Object>>) all.getBody().get("choices");
        assertThat(allChoices).isNotEmpty();

        ResponseEntity<Map> one = authGet("/api/growth/choices?playerId=P001", token, Map.class);
        List<Map<String, Object>> forCard = (List<Map<String, Object>>) one.getBody().get("choices");
        assertThat(forCard).isNotEmpty();
        assertThat(forCard).allSatisfy(c -> assertThat(c.get("playerId")).isEqualTo("P001"));

        String choiceId = (String) forCard.get(0).get("choiceId");
        String stat = (String) ((List<Map<String, Object>>) forCard.get(0).get("candidates")).get(0).get("stat");
        growthService.applyChoice(userId, choiceId, stat);

        List<Map<String, Object>> after = (List<Map<String, Object>>) authGet(
                "/api/growth/choices?playerId=P001", token, Map.class).getBody().get("choices");
        assertThat(after).noneSatisfy(c -> assertThat(c.get("choiceId")).isEqualTo(choiceId));
    }

    /** 카드 조회에 카드 레벨·XP·대기 선택권이 <b>additive</b> 로 실린다(설계 §3, E1 #403 공유). */
    @SuppressWarnings("unchecked")
    @Test
    void cardEndpointCarriesTheNewGrowthAxisAdditively() {
        String token = setupUserWithDeck("gch_card");
        String userId = userIdOf("gch_card");
        settleOnce(token, userId, "gch_card");

        ResponseEntity<Map> res = authGet("/api/growth/card/P001", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body).containsKeys("cardLevel", "cardXp", "xpToNext", "maxLevel",
                "pendingChoices", "statAdd", "growCeil", "starCeilBonus", "attrHardCap");
        // 기존 키가 사라지지 않았다(구 클라 무회귀).
        assertThat(body).containsKeys("attributes", "prePotential", "caps", "base", "statLevels",
                "potential", "ovr", "completion");
        assertThat(((Number) body.get("cardLevel")).intValue()).isGreaterThan(1);
        assertThat((List<?>) body.get("pendingChoices")).isNotEmpty();
    }

    /**
     * <b>천장 분해</b>(목업 화면 ⑤ "천장 73 = 72 + ★2 보너스 1"). 합쳐진 {@code caps} 만 내리면
     * 화면이 star 기여를 보여줄 수 없다. 계약은 값이 아니라 <b>관계</b>로 건다 —
     * {@code caps == min(growCeil + starCeilBonus, attrHardCap)} 이 성립해야 라벨이 거짓말을 안 한다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void cardCeilingIsDecomposedIntoGradeCeilingAndStarBonus() {
        String token = login("gch_ceiling");
        String userId = userIdOf("gch_ceiling");
        jdbcClient.sql("UPDATE user_players SET star = 3 WHERE user_id=? AND player_id='P001'")
                .param(userId).update();

        Map<String, Object> body = authGet("/api/growth/card/P001", token, Map.class).getBody();
        int growCeil = ((Number) body.get("growCeil")).intValue();
        int starBonus = ((Number) body.get("starCeilBonus")).intValue();
        int hardCap = ((Number) body.get("attrHardCap")).intValue();
        double cap = ((Number) ((Map<String, Object>) body.get("caps")).get("shooting")).doubleValue();

        assertThat(cap).isEqualTo(Math.min(growCeil + starBonus, hardCap));
        assertThat(starBonus).as("3★ 인데 승급 보너스가 0 이면 분해가 star 를 안 보고 있다").isGreaterThan(0);

        // 1★ 카드는 보너스가 없다 — 같은 응답이 star 를 실제로 반영하는지 대조군으로 본다.
        jdbcClient.sql("UPDATE user_players SET star = 1 WHERE user_id=? AND player_id='P001'")
                .param(userId).update();
        Map<String, Object> oneStar = authGet("/api/growth/card/P001", token, Map.class).getBody();
        assertThat(((Number) oneStar.get("growCeil")).intValue()).isEqualTo(growCeil);
        assertThat(((Number) oneStar.get("starCeilBonus")).intValue()).isLessThan(starBonus);
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    /** 완료된 매치 1판을 정산해 선택권을 만든다. */
    private void settleOnce(String token, String userId, String tag) {
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");
        growthService.settleMatch(matchId, userId, STARTERS, List.of(), Set.of(), Set.of(), true, "WIN");
    }

    private Map<String, Object> firstPending(String userId, String playerId) {
        List<Map<String, Object>> pending = growthService.pendingChoices(userId, playerId);
        assertThat(pending).as("선택권이 하나도 없으면 이 계약들이 공허해진다").isNotEmpty();
        return pending.get(0);
    }

    private double statAdd(String userId, String playerId, String stat) {
        String json = jdbcClient.sql("SELECT stat_add_json FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(String.class).optional().orElse(null);
        if (json == null) {
            return 0.0;
        }
        try {
            var node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
            return node.path(stat).asDouble(0.0);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
