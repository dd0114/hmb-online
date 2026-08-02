package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.growth.GrowthMath;
import online.hmb.growth.GrowthService;
import online.hmb.growth.GrowthTuning;
import online.hmb.growth.LiveGrowthConfigService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>변이체 킬</b>(#405 설계 §2.8.2-4) — "API 는 200 인데 반영은 안 됨"을 잡는다.
 *
 * <p>{@link GrowthTuningRegistryTest} 는 <b>계수 객체</b>가 바뀌는지 보고, 여기서는 <b>서버가 실제로
 * 그 값을 쓰는지</b>를 본다. 둘은 다른 명제다 — 오버레이가 완벽해도 소비하는 쪽이 economy 를 직접
 * 읽고 있으면 화면 값은 그대로다(#405 이전이 정확히 그 상태였다: 밴드는 Java 하드코딩, 나머지는
 * economy 직독).
 *
 * <p>픽스처 P010 = GOLD/MF(base positioning 61), P001 = BRONZE/GK(base positioning 48).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthTuningLiveTest extends ApiTestBase {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private GrowthService growthService;

    @Resource
    private LiveGrowthConfigService liveGrowthConfig;

    /**
     * 오버레이는 <b>전역 상태</b>다 — 클래스 단위로 DB 를 공유하므로 앞 테스트가 남긴 리비전이 다음
     * 테스트의 "기본값에서 출발한다"를 무너뜨린다(그러면 실행 순서가 곧 계약이 된다). 매 메서드를
     * 리비전 0 에서 시작시킨다. 캐시는 원장을 지운 뒤 <b>빈 리비전을 한 번 써서</b> 무효화한다 —
     * 밖에서 DELETE 만 하면 서비스는 옛 값을 계속 들고 있다.
     */
    @org.junit.jupiter.api.BeforeEach
    void resetOverlay() {
        jdbcClient.sql("DELETE FROM growth_config_revisions").update();
        liveGrowthConfig.recordRevision(onboard("gt_reset"), Map.of(), "테스트 리셋", null, "reset");
    }

    // ── 변이체 1: 성장 천장을 내리면 유효스탯 천장이 실제로 내려간다 ──────

    @Test
    void loweringTheGoldGrowthCeilingActuallyLowersTheEffectiveStat() {
        String userId = onboard("gt_ceiling");
        grant(userId, "P010");
        setStatAdd(userId, "P010", "positioning", 999);   // 천장까지 밀어붙인다

        // 오버레이 없음: 천장 = bands.GOLD.growCeil(84) + star.ceilBonus[1](0)
        assertThat(positioningOf(userId, "P010")).isEqualTo(84.0);

        record(userId, Map.of("bands.GOLD.growCeil", 70), "변이체 킬 — 천장 하향");

        assertThat(positioningOf(userId, "P010"))
                .as("bands.GOLD.growCeil 을 내렸는데 유효스탯이 그대로면 그 노브는 소비되지 않는 노브다")
                .isEqualTo(70.0);
        // 다른 등급은 같이 움직이지 않는다(경로 단위 병합이 서버까지 살아 있는가).
        assertThat(bandCeil("BRONZE")).isEqualTo(72);
    }

    /** 승급 보너스도 소비된다 — 천장은 {@code growCeil + star.ceilBonus[star]} 다. */
    @Test
    void starCeilingBonusIsAddedOnTopOfTheGradeCeiling() {
        String userId = onboard("gt_starbonus");
        grant(userId, "P010");
        setStatAdd(userId, "P010", "positioning", 999);
        setStar(userId, "P010", 3);

        // star.ceilBonus[3] = 2 → 84 + 2
        assertThat(positioningOf(userId, "P010")).isEqualTo(86.0);

        record(userId, Map.of("star.ceilBonus.3", 10), "변이체 킬 — 승급 보너스");
        assertThat(positioningOf(userId, "P010")).isEqualTo(94.0);
    }

    /**
     * <b>승급 없이도 등급 천장까지 성장한다</b>(설계 §2.6 요구) — 구 모델은 1★ 이 밴드 여백의 25%
     * 밖에 못 썼다. 이 계약이 깨지면 {@code starFrac} 게이트가 되살아난 것이다.
     */
    @Test
    void aOneStarCardReachesTheFullGradeCeiling() {
        String userId = onboard("gt_onestar");
        grant(userId, "P010");
        assertThat(starOf(userId, "P010")).isEqualTo(1);
        setStatAdd(userId, "P010", "shooting", 999);

        assertThat(effectiveOf(userId, "P010", "shooting"))
                .as("1★ 이 등급 천장(84)에 못 닿으면 승급 게이트가 살아 있는 것이다")
                .isEqualTo(84.0);
    }

    /** 전역 하드 상한은 <b>잠재 적용 후</b>에 걸린다 — 지금까지 100 을 넘길 수 있었던 선존 결함. */
    @Test
    void potentialCannotPushAStatPastTheHardCap() {
        String userId = onboard("gt_hardcap");
        grant(userId, "P016");   // LEGEND, base shooting 86
        setStar(userId, "P016", 4);
        setStatAdd(userId, "P016", "shooting", 999);
        insertPotential(userId, "P016", """
                [{"slot":1,"tier":"UNIQUE","type":"STAT_PCT","stat":"shooting","value":50}]
                """);

        double capped = effectiveOf(userId, "P016", "shooting");
        assertThat(capped).as("attrHardCap 이 없으면 (95+3)×1.5 = 147 이 그대로 나간다").isEqualTo(99.0);

        record(userId, Map.of("attrHardCap", 90), "변이체 킬 — 하드 상한");
        assertThat(effectiveOf(userId, "P016", "shooting")).isEqualTo(90.0);
    }

    /**
     * <b>{@code startLo} 는 서버가 내리고, 오버레이를 따라간다</b>(#405 W3 후속).
     *
     * <p>web 은 후보 막대의 좌측 앵커로 근사치({@code min(base) − 5})를 쓰고 있었다 — 감쇠가
     * {@code r = (v − startLo)/(ceiling − startLo)} 라 앵커가 틀리면 세 후보의 gain 차이가 막대
     * 길이로 읽히지 않고, 근사치에 "시작 50" 이라는 정확한 라벨을 붙이면 <b>화면이 거짓말</b>을 한다.
     *
     * <p>값 자체보다 중요한 것은 <b>따라오는가</b>다: 클라가 밴드를 미러하면 무배포로 밴드를 돌리는
     * 순간 화면만 옛 앵커로 그린다(§2.8 이 막으려는 상태).
     */
    @Test
    void cardCarriesTheBandStartLoAndFollowsTheOverlay() {
        String userId = onboard("gt_startlo");
        grant(userId, "P010");   // GOLD

        int shipped = (int) ((Number) growthService.cardEffective(userId, "P010").get("startLo")).intValue();
        assertThat(shipped).as("발행 기본값(GOLD 시작 하한)").isEqualTo(50);

        record(userId, Map.of("bands.GOLD.startLo", 20), "앵커 이동");
        assertThat(((Number) growthService.cardEffective(userId, "P010").get("startLo")).intValue())
                .as("밴드를 무배포로 내렸는데 응답이 그대로면 클라가 미러할 수밖에 없다")
                .isEqualTo(20);
        // 다른 등급은 같이 움직이지 않는다(경로 단위 병합이 여기까지 살아 있는가).
        assertThat(liveGrowthConfig.effective().bands().byGrade().get("BRONZE").startLo()).isEqualTo(32);
    }

    // ── 스코프 표기가 사실인가 ───────────────────────────────────────────

    /**
     * <b>{@code PUBLISH} 스코프 노브는 런타임 계산을 움직이지 않는다.</b> 레지스트리가 그렇게 표기한
     * 이상 그건 <b>주석이 아니라 계약</b>이어야 한다 — 표기만 하고 실제로는 {@code compute()} 가
     * 읽고 있으면 운영자는 "다음 발행부터"라고 안내받은 값으로 <b>지금</b> 유효스탯을 바꾸게 된다.
     *
     * <p>반대 방향(= 저장·병합은 되는가)은 {@code GrowthTuningRegistryTest.everyKnobIsOverridable}
     * 이 전 경로에 대해 이미 본다. 둘을 합쳐야 "저장은 되지만 지금은 효력이 없다"가 증명된다.
     */
    @Test
    void publishScopedKnobsDoNotMoveAnyRuntimeNumber() {
        String userId = onboard("gt_publish_scope");
        grant(userId, "P010");
        setStatAdd(userId, "P010", "positioning", 5);
        Map<String, Object> before = growthService.cardEffective(userId, "P010");

        java.util.Map<String, Object> overrides = new java.util.LinkedHashMap<>();
        for (String path : GrowthTuning.knobsWithScope(GrowthTuning.KnobScope.PUBLISH)) {
            overrides.put(path, 40);   // 기본값(3/4)과 크게 다른 값 — 읽히고 있다면 티가 난다
        }
        assertThat(overrides).as("PUBLISH 노브가 하나도 없으면 이 계약이 공허해진다").isNotEmpty();
        record(userId, overrides, "스코프 계약 — 발행 시점 노브");

        // 오버레이는 실제로 실렸다(저장이 안 된 것을 '영향 없음'으로 오해하지 않게 먼저 확인).
        assertThat(liveGrowthConfig.effective().bands().primaryBias()).isEqualTo(40);
        assertThat(growthService.cardEffective(userId, "P010"))
                .as("PUBLISH 로 표기한 노브가 런타임 값을 바꿨다 — 표기가 거짓이다")
                .isEqualTo(before);
    }

    // ── 변이체 2: decay.gainMax = 0 → 상승폭 0 ───────────────────────────

    @Test
    void zeroGainMaxMakesEveryLevelUpWorthNothing() {
        String userId = onboard("gt_gain");
        double before = GrowthMath.gain(liveGrowthConfig.effective(), "GOLD", 1, 55.0, 1);
        assertThat(before).as("기본값에서 상승폭이 0 이면 이 변이체 검사가 공허해진다").isGreaterThan(0.0);

        record(userId, Map.of("decay.gainMax", 0.0), "변이체 킬 — 성장 끄기");

        assertThat(GrowthMath.gain(liveGrowthConfig.effective(), "GOLD", 1, 55.0, 1))
                .as("gainMax=0 인데 gainMin 바닥값이 상승폭을 되살리면 '반영 안 됨'이다")
                .isEqualTo(0.0);
    }

    /** 감쇠가 실제로 감쇠다 — 높은 스탯일수록 덜 오른다(공식의 방향이 뒤집히지 않았는가). */
    @Test
    void gainDecaysAsTheStatApproachesTheCeiling() {
        GrowthTuning t = liveGrowthConfig.effective();
        double low = GrowthMath.gain(t, "GOLD", 1, 55.0, 1);
        double mid = GrowthMath.gain(t, "GOLD", 1, 70.0, 1);
        double high = GrowthMath.gain(t, "GOLD", 1, 83.0, 1);
        assertThat(low).isGreaterThan(mid);
        assertThat(mid).isGreaterThan(high);
        assertThat(GrowthMath.gain(t, "GOLD", 1, 84.0, 1))
                .as("천장에 닿은 스탯은 0 이어야 한다(죽은 선택지 방지)").isEqualTo(0.0);
    }

    // ── 변이체 3: xp.maxLevel = 1 → 레벨업 없음 ──────────────────────────

    @Test
    void maxLevelOneMeansNoLevelUpEver() {
        String userId = onboard("gt_maxlevel");
        assertThat(GrowthMath.applyXp(liveGrowthConfig.effective(), 1, 0, 100_000).levelUps())
                .as("기본값에서 레벨업이 안 나면 이 변이체 검사가 공허해진다").isGreaterThan(0);

        record(userId, Map.of("xp.maxLevel", 1), "변이체 킬 — 만렙 1");

        GrowthMath.LevelState state = GrowthMath.applyXp(liveGrowthConfig.effective(), 1, 0, 100_000);
        assertThat(state.levelUps()).isEqualTo(0);
        assertThat(state.level()).isEqualTo(1);
    }

    /** XP 곡선 계수도 소비된다 — {@code lvBase} 를 올리면 첫 레벨업이 실제로 늦어진다. */
    @Test
    void xpCurveKnobsChangeHowFarTheFirstLevelIs() {
        String userId = onboard("gt_curve");
        int before = GrowthMath.xpToNext(liveGrowthConfig.effective(), 1);
        record(userId, Map.of("xp.lvBase", 400), "변이체 킬 — XP 곡선");
        assertThat(GrowthMath.xpToNext(liveGrowthConfig.effective(), 1)).isEqualTo(400).isNotEqualTo(before);
    }

    // ── 원장 성질 ────────────────────────────────────────────────────────

    /**
     * <b>같은 밀리초에 들어온 두 리비전도 삽입 순서로 정렬된다</b>(V38 {@code seq}). ULID·
     * {@code created_at} 정렬이었다면 여기서 <b>롤백이 반반 확률로 무시된다</b> — V37 이 3차 게이트에서
     * 실제로 그 결함을 발화시켰고, 같은 이유로 같은 선택을 했으니 계약도 같이 가져온다.
     */
    @Test
    void sameMillisecondRevisionsStillOrderByInsertion() {
        String userId = onboard("gt_order");
        for (int i = 0; i < 30; i++) {
            record(userId, Map.of("xp.maxLevel", 10 + i), "동일 ms 정렬 " + i);
        }
        assertThat(liveGrowthConfig.effective().xp().maxLevel())
                .as("마지막으로 넣은 리비전이 현재 값이 아니면 롤백이 무시될 수 있다").isEqualTo(39);
    }

    /** 빈 오버레이 리비전 = 기본값 복귀(롤백의 정의). */
    @Test
    void anEmptyRevisionRollsBackToDefaults() {
        String userId = onboard("gt_rollback");
        record(userId, Map.of("bands.GOLD.growCeil", 60), "낮춰 본다");
        assertThat(bandCeil("GOLD")).isEqualTo(60);
        record(userId, Map.of(), "기본값 복귀");
        assertThat(bandCeil("GOLD")).isEqualTo(84);
    }

    /**
     * 발행물({@code economy.*.json})에서 승계한 값까지 포함해 <b>모든 잎이 레지스트리 안</b>이다.
     * 데이터가 새 키를 들고 오면(예: 새 포지션) 여기서 FAIL 하고, 그건 "새 계수를 등록해라"라는
     * 정확한 신호다 — 조용히 조정 불가 계수가 생기는 것보다 낫다.
     */
    @Test
    void publishedDefaultsIntroduceNoUnregisteredKnob() {
        List<String> leaves = liveGrowthConfig.defaults().leafPaths();
        assertThat(leaves).isNotEmpty();
        assertThat(GrowthTuning.KNOBS).containsAll(leaves);
    }

    /** 승계가 실제로 발행물을 읽는가 — economy 의 baseline 값이 유효 계수에 그대로 있어야 한다. */
    @Test
    void positionBaselineIsInheritedFromThePublishedEconomy() {
        Map<String, Double> fw = liveGrowthConfig.effective().positionBaseline().get("FW");
        assertThat(fw).isNotNull();
        assertThat(fw.get("shooting")).isEqualTo(0.22);   // fixtures/economy.v1.json 의 값
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private String onboard(String nickname) {
        login(nickname);
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private void record(String actorUserId, Map<String, Object> overrides, String reason) {
        liveGrowthConfig.recordRevision(actorUserId, overrides, reason, null,
                String.valueOf(overrides.hashCode()) + reason);
    }

    private void grant(String userId, String playerId) {
        jdbcClient.sql("""
                        INSERT INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, 1, ?)
                        ON CONFLICT(user_id, player_id) DO NOTHING
                        """)
                .params(userId, playerId, java.time.Instant.now().toString())
                .update();
    }

    private void setStar(String userId, String playerId, int star) {
        jdbcClient.sql("UPDATE user_players SET star = ? WHERE user_id=? AND player_id=?")
                .params(star, userId, playerId).update();
    }

    private int starOf(String userId, String playerId) {
        return jdbcClient.sql("SELECT star FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    /**
     * 상승분 주입. #405 W2b 로 저장 형태가 {@code stat_levels_json}(정수 lv)에서
     * {@code stat_add_json}(소수 누적)으로 바뀌었다 — 검사의 주제(천장·하드캡·승급 보너스가 실제로
     * 소비되는가)는 그대로이고 주입 지점만 옮긴다.
     */
    private void setStatAdd(String userId, String playerId, String stat, double add) {
        try {
            String json = MAPPER.writeValueAsString(Map.of(stat, add));
            jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id=? AND player_id=?")
                    .params(json, userId, playerId).update();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void insertPotential(String userId, String playerId, String linesJson) {
        jdbcClient.sql("""
                        INSERT INTO card_potentials(user_id, player_id, tier, lines_json,
                                                    rolls_since_tierup, updated_at)
                        VALUES (?, ?, 'UNIQUE', ?, 0, ?)
                        ON CONFLICT(user_id, player_id) DO UPDATE SET lines_json = excluded.lines_json
                        """)
                .params(userId, playerId, linesJson, java.time.Instant.now().toString())
                .update();
    }

    private double positioningOf(String userId, String playerId) {
        return effectiveOf(userId, playerId, "positioning");
    }

    private double effectiveOf(String userId, String playerId, String stat) {
        Map<String, Object> card = growthService.cardEffective(userId, playerId);
        Map<?, ?> attributes = (Map<?, ?>) card.get("attributes");
        return ((Number) attributes.get(stat)).doubleValue();
    }

    private int bandCeil(String grade) {
        return liveGrowthConfig.effective().bands().byGrade().get(grade).growCeil();
    }
}
