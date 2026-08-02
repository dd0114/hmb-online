package online.hmb.growth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.TxRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * <b>라이브 이관 — "하향 + 소급 지급"</b>(#405 W2b, 설계 §2.7 안 C, hero 확정 Q3).
 *
 * <p><b>무엇을 하나</b>: 구 모델(V10)에서 쌓인 <b>스탯 레벨 합</b>을 신 모델의 <b>선택권 수</b>로
 * 환산해 한 번 지급한다. 라이브 실측으로 대상 451장 · 총레벨 p50 1 · p90 15 · max 59 라,
 * {@code legacy.levelGrantCap}(39)과 만렙(40)에 걸리는 카드는 극소수다.
 *
 * <p><b>왜 이 자리인가</b>: {@code players} 는 <b>부팅 임포트가 매번 덮어쓴다</b>
 * ({@code PlayerCatalogService}, {@code @Order(0)}). 그래서 이 러너는 {@code @Order(50)} —
 * 카탈로그 임포트 <b>뒤</b>, 계정 부트스트랩({@code AdminBootstrap}, 100) <b>앞</b>이다.
 *
 * <h2>⚠️ 하향 전 base 스냅샷을 어떻게 다루나 (이 클래스에서 가장 틀리기 쉬운 지점)</h2>
 *
 * {@code growth_legacy_base}(V39 가 채운다)는 <b>Flyway 시점</b>의 {@code players.attributes_json}
 * 이고, Flyway 는 ApplicationRunner 보다 먼저 도므로 그 값은 <b>직전 부팅이 임포트한 것</b>이다.
 * 두 경우가 생긴다:
 * <ul>
 *   <li><b>의도한 원자 배포</b>(W1 v2.5 + W2a + W2b 한 배) → 스냅샷 = <b>v2.4</b>(하향 전).
 *       현재 {@code players} 와 다르다.</li>
 *   <li><b>v2.5 가 이미 임포트된 뒤</b> 이 마이그레이션만 뜨는 경우 → 스냅샷 = v2.5 = 현재와 <b>동일</b>.
 *       이건 설계 §2.7 이 "이 에픽 최대 리스크"로 적어 둔 <b>부분 배포</b>가 실제로 일어났다는 신호다
 *       (유저 카드가 깎인 채로 소급 지급 없이 굴러갔다).</li>
 * </ul>
 *
 * <b>판단: 두 경우 모두 지급 수는 같고, 하향분 Δ 를 {@code stat_add_json} 으로 되메우지 않는다.</b>
 * 근거는 셋이다.
 * <ol>
 *   <li>Δ 되메우기는 설계가 <b>이름 붙여 기각한 안 A</b>(무손실 백필)다 — hero 가 §4 Q3 에서 C 를
 *       확정하며 A 를 명시적으로 버렸다. 이유도 적혀 있다: Δ 를 add 로 채우면 그 카드는 감쇠 곡선의
 *       꼭대기에 앉아 앞으로의 gain 이 영원히 {@code gainMin}(0.3)이 된다 = <b>기존 유저만 성장이
 *       멈춘다</b>. 손해를 막으려는 보정이 정확히 손해를 만든다.</li>
 *   <li>"손해 보지 않는다"는 <b>선택권으로</b> 갚는다. 구 모델의 1레벨 = +1 이었고 신 모델의 선택권
 *       1장은 낮은 스탯에서 +3 을 넘는다(GOLD 시작 55 기준 +3.20). 즉 같은 수의 선택권이 잃은
 *       스탯보다 <b>더 많은</b> 성장을 돌려준다. 게다가 천장이 열려(1★ 도 등급 천장까지) 도달
 *       가능한 최대치가 구 모델보다 높다.</li>
 *   <li>Δ 는 <b>모든 카드에 똑같이</b> 적용된 밸런스 재설정이다 — 유저 카드도 봇 로스터도 같은
 *       카탈로그를 쓰므로 상대적 전력은 보존된다. 절대값만 내려가는 것을 개인 자산 손실로 보정하면
 *       재설정 자체가 무효가 된다.</li>
 * </ol>
 * 스냅샷의 실제 쓸모는 <b>감사와 롤백</b>이다: 카드별 Δ 합계를 마커에 남겨 "얼마나 깎였고 몇 장을
 * 갚았나"에 숫자로 답할 수 있게 하고, 되돌려야 하면 v2.4 원본이 DB 안에 남아 있게 한다.
 * 스냅샷 = 현재값인 경우(부분 배포 신호)는 <b>경고 로그</b>로 올린다 — 조용히 지나가면 그 사고를
 * 아무도 모른다.
 *
 * <p><b>멱등</b>은 두 겹이다: ①완료 마커({@code meta_kv}) 로 재부팅 시 통째로 건너뛰고
 * ②그 마커가 없어도 {@code UNIQUE(user_id, player_id, level)} 때문에 재실행이 선택권을 늘리지 않는다.
 * 마커만 믿으면 마커 쓰기 직전에 죽은 배포가 두 배로 지급한다.
 */
@Component
@org.springframework.core.annotation.Order(50)
public class GrowthLegacyBackfillService implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(GrowthLegacyBackfillService.class);

    /** 완료 마커 키. 값은 실행 요약 JSON — "언제 무엇을 했나"가 이 한 줄에 남는다. */
    public static final String MARKER_KEY = "growth_legacy_backfill_v1";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final GrowthService growthService;
    private final LiveGrowthConfigService growthConfig;

    public GrowthLegacyBackfillService(JdbcClient jdbcClient, TxRunner txRunner, ObjectMapper objectMapper,
                                       GrowthService growthService, LiveGrowthConfigService growthConfig) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.growthService = growthService;
        this.growthConfig = growthConfig;
    }

    @Override
    public void run(ApplicationArguments args) {
        try {
            backfillOnce();
        } catch (RuntimeException e) {
            // 백필 실패가 <b>부팅을 막지 않는다</b> — 서비스 정지 ≫ 소급 지급 지연. 마커를 쓰지
            // 않았으므로 다음 부팅이 다시 시도한다.
            log.error("성장 소급 이관 실패 — 다음 부팅에서 재시도한다: {}", e.toString(), e);
        }
    }

    /** @return 이번 호출이 실제로 백필했으면 요약, 이미 끝났으면 {@code null}. */
    public Summary backfillOnce() {
        if (marker() != null) {
            return null;
        }
        Summary summary = txRunner.run(this::doBackfill);
        try {
            jdbcClient.sql("INSERT OR REPLACE INTO meta_kv(key, value) VALUES (?, ?)")
                    .params(MARKER_KEY, objectMapper.writeValueAsString(summary))
                    .update();
        } catch (Exception e) {
            log.warn("성장 소급 이관 마커 기록 실패(멱등은 UNIQUE 로 유지된다): {}", e.toString());
        }
        log.info("성장 소급 이관 완료 — 대상 {}장 · 선택권 {}개 · base 하향 감지 {}장 (스냅샷=현재 {}장)",
                summary.cards(), summary.choicesGranted(), summary.loweredCards(), summary.unchangedCards());
        return summary;
    }

    private Summary doBackfill() {
        GrowthTuning tuning = growthConfig.effective();
        int cap = Math.min(tuning.legacy().levelGrantCap(), Math.max(0, tuning.xp().maxLevel() - 1));

        record Row(String userId, String playerId, String statLevelsJson, String legacyBaseJson,
                   String currentBaseJson) {
        }
        // 성장 이력이 있는 카드만 대상이다 — 이력이 없으면 갚을 것도 없다.
        List<Row> rows = jdbcClient.sql("""
                        SELECT up.user_id, up.player_id, up.stat_levels_json,
                               lb.attributes_json AS legacy_base, p.attributes_json AS current_base
                        FROM user_players up
                        JOIN players p ON p.id = up.player_id
                        LEFT JOIN growth_legacy_base lb
                               ON lb.user_id = up.user_id AND lb.player_id = up.player_id
                        WHERE up.stat_levels_json IS NOT NULL
                        ORDER BY up.user_id, up.player_id
                        """)
                .query((rs, n) -> new Row(rs.getString("user_id"), rs.getString("player_id"),
                        rs.getString("stat_levels_json"), rs.getString("legacy_base"),
                        rs.getString("current_base")))
                .list();

        int cards = 0;
        int granted = 0;
        int lowered = 0;
        int unchanged = 0;
        double droppedTotal = 0.0;
        for (Row row : rows) {
            Map<String, Integer> levels = statLevels(row.statLevelsJson());
            int levelSum = levels.values().stream().mapToInt(Integer::intValue).sum();
            if (levelSum <= 0) {
                continue;
            }
            cards++;
            double drop = baseDrop(row.legacyBaseJson(), row.currentBaseJson());
            if (drop > 0) {
                lowered++;
                droppedTotal += drop;
            } else if (row.legacyBaseJson() != null) {
                unchanged++;
            }
            int grantCount = Math.min(levelSum, cap);
            granted += growthService.grantLegacyChoices(row.userId(), row.playerId(), grantCount,
                    historyScore(levels));
        }
        if (cards > 0 && lowered == 0) {
            // 설계 §2.7 의 "배포 원자성" 리스크가 실제로 터진 형태 — 조용히 넘기면 아무도 모른다.
            log.warn("성장 소급 이관: 하향 전 스냅샷이 현재 base 와 전부 같다 — v2.5 하향이 이미 "
                    + "소급 지급 없이 배포됐을 수 있다(설계 §2.7 배포 원자성). 지급은 그대로 진행한다.");
        }
        return new Summary(Instant.now().toString(), cards, granted, lowered, unchanged,
                Math.round(droppedTotal * 100.0) / 100.0);
    }

    /**
     * 스탯 XP 이력 → 후보 가중 점수. 값 자체가 아니라 <b>모양</b>만 쓰이므로(추첨이 정규화한다)
     * 레벨을 그대로 넘긴다 — "많이 올린 스탯이 다시 나올 확률이 높다".
     */
    private Map<String, Double> historyScore(Map<String, Integer> levels) {
        Map<String, Double> out = new LinkedHashMap<>();
        levels.forEach((stat, lv) -> out.put(stat, (double) lv));
        return out;
    }

    private Map<String, Integer> statLevels(String json) {
        Map<String, Integer> out = new LinkedHashMap<>();
        if (json == null || json.isBlank()) {
            return out;
        }
        try {
            Map<String, Map<String, Object>> raw = objectMapper.readValue(json,
                    new TypeReference<Map<String, Map<String, Object>>>() { });
            raw.forEach((stat, lvXp) -> {
                Object lv = lvXp == null ? null : lvXp.get("lv");
                if (lv instanceof Number num && num.intValue() > 0) {
                    out.put(stat, num.intValue());
                }
            });
        } catch (Exception e) {
            log.warn("stat_levels_json 파싱 실패 — 이 카드는 소급 지급에서 제외한다: {}", json);
        }
        return out;
    }

    /** 스냅샷 대비 현재 base 가 얼마나 내려갔나(양수 = 하향분 합). 스냅샷이 없으면 0. */
    private double baseDrop(String legacyJson, String currentJson) {
        if (legacyJson == null || currentJson == null) {
            return 0.0;
        }
        try {
            Map<String, Object> before = objectMapper.readValue(legacyJson,
                    new TypeReference<Map<String, Object>>() { });
            Map<String, Object> after = objectMapper.readValue(currentJson,
                    new TypeReference<Map<String, Object>>() { });
            double drop = 0.0;
            for (Map.Entry<String, Object> e : before.entrySet()) {
                if (!(e.getValue() instanceof Number b) || !(after.get(e.getKey()) instanceof Number a)) {
                    continue;
                }
                drop += Math.max(0.0, b.doubleValue() - a.doubleValue());
            }
            return drop;
        } catch (Exception e) {
            return 0.0;
        }
    }

    public String marker() {
        return jdbcClient.sql("SELECT value FROM meta_kv WHERE key = ?")
                .param(MARKER_KEY).query(String.class).optional().orElse(null);
    }

    /**
     * @param loweredCards   스냅샷보다 현재 base 가 낮은 카드 수(= 이 배포가 하향을 실었다는 증거)
     * @param unchangedCards 스냅샷 == 현재인 카드 수(= 하향이 이전 배포에서 이미 나갔다는 신호)
     * @param droppedTotal   하향분 총합(9스탯 합계의 합) — 감사용, 보정에 쓰지 않는다
     */
    public record Summary(String finishedAt, int cards, int choicesGranted, int loweredCards,
                          int unchangedCards, double droppedTotal) {
    }
}
