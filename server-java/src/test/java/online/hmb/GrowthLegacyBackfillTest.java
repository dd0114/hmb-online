package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.growth.GrowthLegacyBackfillService;
import online.hmb.growth.GrowthService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>소급 이관</b>(#405 W2b, 설계 §2.7 안 C) — 구 모델의 스탯 레벨 합을 신 모델의 선택권으로 갚는다.
 *
 * <p>계약 7(멱등)이 핵심이다: 재부팅마다 지급하면 유저 스탯이 무한히 늘고, 그건 되돌릴 수 없다.
 * 멱등은 두 겹으로 본다 — <b>마커가 있을 때</b>(건너뛴다)와 <b>마커를 지웠을 때</b>
 * (UNIQUE 백스톱이 여전히 막는다). 마커만 검사하면 "마커 쓰기 직전에 죽은 배포"가 통과한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthLegacyBackfillTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private GrowthLegacyBackfillService backfill;

    @Resource
    private GrowthService growthService;

    /** 부팅 러너가 이미 한 번 돌았다 — 각 메서드를 "아직 안 돈" 상태에서 시작시킨다. */
    @BeforeEach
    void clearMarker() {
        jdbcClient.sql("DELETE FROM meta_kv WHERE key = ?")
                .param(GrowthLegacyBackfillService.MARKER_KEY).update();
    }

    @Test
    void legacyStatLevelsBecomeChoiceGrantsAndCardLevel() {
        String userId = onboard("gl_grant");
        setStatLevels(userId, "P001", Map.of("shooting", 3, "passing", 2));

        backfill.backfillOnce();

        assertThat(legacyChoiceCount(userId, "P001"))
                .as("스탯 레벨 합(5)이 선택권 수가 돼야 한다").isEqualTo(5);
        assertThat(cardLevel(userId, "P001"))
                .as("card_level = 1 + 지급 선택권 수").isEqualTo(6);
        // 지급은 **선택권**이지 스탯이 아니다 — 고르기 전까지 아무것도 안 오른다.
        assertThat(statAddJson(userId, "P001")).isNull();
        // 소급분은 매치 출처가 없다(§2.7).
        assertThat(jdbcClient.sql("""
                        SELECT COUNT(*) FROM growth_level_choices
                        WHERE user_id=? AND player_id='P001' AND source_match_id IS NOT NULL
                        """).param(userId).query(Long.class).single()).isZero();
    }

    /** 계약 7 — 두 번 돌려도 선택권이 늘지 않는다(마커 경로). */
    @Test
    void runningTwiceGrantsNothingExtra_markerPath() {
        String userId = onboard("gl_idem_marker");
        setStatLevels(userId, "P001", Map.of("shooting", 4));

        backfill.backfillOnce();
        long after1 = legacyChoiceCount(userId, "P001");
        assertThat(backfill.backfillOnce()).as("마커가 있으면 두 번째 호출은 아무것도 안 한다").isNull();
        assertThat(legacyChoiceCount(userId, "P001")).isEqualTo(after1);
    }

    /**
     * 계약 7 — <b>마커를 지워도</b> 선택권이 늘지 않는다. 마커 쓰기 직전에 프로세스가 죽는
     * 시나리오가 실제 배포에서 가능하므로, 멱등의 뿌리는 마커가 아니라
     * {@code UNIQUE(user_id, player_id, level)} 여야 한다.
     */
    @Test
    void runningTwiceGrantsNothingExtra_evenWithoutTheMarker() {
        String userId = onboard("gl_idem_unique");
        setStatLevels(userId, "P001", Map.of("shooting", 4, "tackling", 3));

        backfill.backfillOnce();
        long after1 = legacyChoiceCount(userId, "P001");
        int level1 = cardLevel(userId, "P001");
        assertThat(after1).isEqualTo(7);

        clearMarker();
        backfill.backfillOnce();

        assertThat(legacyChoiceCount(userId, "P001")).isEqualTo(after1);
        assertThat(cardLevel(userId, "P001")).isEqualTo(level1);
    }

    /** 재실행이 후보를 <b>다시 뽑지 않는다</b> — 결정론이라 같은 시드지만, 행 자체가 그대로여야 한다. */
    @Test
    void rerunKeepsTheAlreadyFrozenCandidates() {
        String userId = onboard("gl_frozen");
        setStatLevels(userId, "P001", Map.of("passing", 3));

        backfill.backfillOnce();
        List<String> before = candidatesJson(userId, "P001");
        clearMarker();
        backfill.backfillOnce();

        assertThat(candidatesJson(userId, "P001")).isEqualTo(before);
    }

    /** 성장 이력이 없는 카드는 대상이 아니다 — 갚을 것이 없다. */
    @Test
    void cardsWithoutAnyLegacyGrowthGetNothing() {
        String userId = onboard("gl_none");
        backfill.backfillOnce();
        assertThat(legacyChoiceCount(userId, "P002")).isZero();
        assertThat(cardLevel(userId, "P002")).isEqualTo(1);
    }

    /** 지급은 {@code legacy.levelGrantCap}·만렙에 걸린다(라이브 max 59 → 39). */
    @Test
    void grantsAreCappedSoTheCardCannotExceedMaxLevel() {
        String userId = onboard("gl_cap");
        setStatLevels(userId, "P001", Map.of("shooting", 59));

        backfill.backfillOnce();

        int level = cardLevel(userId, "P001");
        int maxLevel = ((Number) growthService.cardEffective(userId, "P001").get("maxLevel")).intValue();
        assertThat(level).isLessThanOrEqualTo(maxLevel);
        assertThat(legacyChoiceCount(userId, "P001")).isEqualTo(level - 1L);
    }

    /**
     * <b>하향 전 스냅샷은 감사용이지 보정용이 아니다.</b> 스냅샷 base 가 현재보다 높아도(=하향이
     * 이 배포에 실렸어도) {@code stat_add_json} 에 Δ 를 되메우지 않는다 — 그건 설계가 이름 붙여
     * 기각한 안 A(무손실 백필)이고, 그 카드의 앞으로의 gain 을 영원히 {@code gainMin} 으로 만든다.
     */
    @Test
    void theLegacyBaseSnapshotIsNeverBackfilledIntoStatAdd() {
        String userId = onboard("gl_nodelta");
        setStatLevels(userId, "P001", Map.of("shooting", 2));
        // 스냅샷을 현재보다 훨씬 높은 값으로 바꾼다(= v2.4 원본이 남아 있는 상태를 재현).
        jdbcClient.sql("""
                        INSERT INTO growth_legacy_base(user_id, player_id, attributes_json, captured_at)
                        VALUES (?, 'P001', ?, ?)
                        ON CONFLICT(user_id, player_id) DO UPDATE SET attributes_json = excluded.attributes_json
                        """)
                .params(userId, "{\"shooting\": 99, \"positioning\": 99}",
                        java.time.Instant.now().toString())
                .update();

        GrowthLegacyBackfillService.Summary summary = backfill.backfillOnce();

        assertThat(statAddJson(userId, "P001"))
                .as("하향분 Δ 를 add 로 되메웠다 — 설계가 기각한 안 A 다")
                .isNull();
        assertThat(summary.loweredCards()).as("하향 감지는 요약에 남아야 한다(감사)").isGreaterThan(0);
        assertThat(summary.droppedTotal()).isGreaterThan(0.0);
        assertThat(legacyChoiceCount(userId, "P001")).isEqualTo(2);
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private String onboard(String nickname) {
        login(nickname);
        return userIdOf(nickname);
    }

    private void setStatLevels(String userId, String playerId, Map<String, Integer> levels) {
        Map<String, Object> json = new java.util.LinkedHashMap<>();
        levels.forEach((stat, lv) -> json.put(stat, Map.of("lv", lv, "xp", 0)));
        try {
            jdbcClient.sql("UPDATE user_players SET stat_levels_json = ? WHERE user_id=? AND player_id=?")
                    .params(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(json),
                            userId, playerId)
                    .update();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private long legacyChoiceCount(String userId, String playerId) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM growth_level_choices
                        WHERE user_id=? AND player_id=? AND source_match_id IS NULL
                        """)
                .params(userId, playerId).query(Long.class).single();
    }

    private List<String> candidatesJson(String userId, String playerId) {
        return jdbcClient.sql("""
                        SELECT candidates_json FROM growth_level_choices
                        WHERE user_id=? AND player_id=? ORDER BY level
                        """)
                .params(userId, playerId).query(String.class).list();
    }

    private int cardLevel(String userId, String playerId) {
        return jdbcClient.sql("SELECT card_level FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    private String statAddJson(String userId, String playerId) {
        return jdbcClient.sql("SELECT stat_add_json FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(String.class).optional().orElse(null);
    }
}
