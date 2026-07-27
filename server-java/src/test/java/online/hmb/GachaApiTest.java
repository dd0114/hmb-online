package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import online.hmb.shop.GachaRandomSource;
import online.hmb.shop.GachaService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-S6~S8 뽑기. 추첨은 seed 결정론이므로 GachaRandomSource를 고정 시드 큐로 교체해
 * 결과를 통제한다(프로덕션 = SecureRandom 시드 생성만, 추첨은 결정론 — ERD 설계 노트).
 * fixture economy gacha: single 300 / ten 3000 / tenCount 11 / pity GOLD+.
 * fixture 카탈로그 17명(스타터 P001..P014 보유, GOLD=P010,P011,P014 / DIA=P017 / LEGEND=P016).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GachaApiTest extends ApiTestBase {

    /** 다음 뽑기가 소비할 시드 큐 — 비어 있으면 랜덤(다른 테스트 간섭 방지). */
    static final Deque<String> SEEDS = new ArrayDeque<>();

    @TestConfiguration
    static class FixedSeedConfig {
        @Bean
        @Primary
        GachaRandomSource fixedSeedSource() {
            return () -> {
                String next = SEEDS.poll();
                return next != null ? next : "rand-" + UUID.randomUUID();
            };
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private GachaService gachaService;

    private static final Set<String> GOLD_PLUS = Set.of("GOLD", "DIA", "LEGEND");

    // ── AC-S6/S8: 단뽑 성공 경로 ─────────────────────────────────────────

    @Test
    void singlePullDebitsBalanceAndGrantsPlayer() {
        String token = login("gacha_single");
        ResponseEntity<Map> response = authPost("/api/shop/gacha", token,
                Map.of("kind", "single"), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> results = (List<Map<String, Object>>) response.getBody().get("results");
        assertThat(results).hasSize(1);
        Map<String, Object> player = (Map<String, Object>) results.get(0).get("player");
        assertThat((Boolean) player.get("owned")).isTrue();
        assertThat(((Number) player.get("ownedCount")).intValue()).isGreaterThanOrEqualTo(1);

        // #212: 뽑기 결제 재화 = 젬(economy gacha.currency=GEM). P 는 손대지 않는다.
        Map<?, ?> wallet = (Map<?, ?>) response.getBody().get("wallet");
        assertThat(((Number) wallet.get("gems")).longValue()).isEqualTo(6000L - 300L);
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(3000L);

        // DB: 원장 gacha_single(ref=pullId, delta=-300) — gem_ledger 에 기록 + gacha_pulls/results
        String userId = userId("gacha_single");
        assertThat(count("point_ledger", userId, "gacha_single")).isZero(); // P 원장은 무개입
        String pullId = jdbcClient.sql("SELECT id FROM gacha_pulls WHERE user_id = ?")
                .param(userId).query(String.class).single();
        Map<String, Object> ledger = jdbcClient.sql(
                        "SELECT delta, ref_id FROM gem_ledger WHERE user_id = ? AND reason = 'gacha_single'")
                .param(userId)
                .query((rs, n) -> Map.<String, Object>of("delta", rs.getLong("delta"), "ref", rs.getString("ref_id")))
                .single();
        assertThat(ledger.get("delta")).isEqualTo(-300L);
        assertThat(ledger.get("ref")).isEqualTo(pullId);
        long resultRows = jdbcClient.sql("SELECT COUNT(*) FROM gacha_results WHERE pull_id = ?")
                .param(pullId).query(Long.class).single();
        assertThat(resultRows).isEqualTo(1L);
    }

    // ── AC-S6: 잔액 부족 → 400 + 완전 롤백 ──────────────────────────────

    @Test
    void insufficientBalanceRejectsAndRollsBack() {
        String token = login("gacha_poor");
        // #212: 결제 재화 = 젬. 가입 6000 → ten(3000) ×2 → 0 젬.
        for (int i = 0; i < 2; i++) {
            ResponseEntity<Map> ten = authPost("/api/shop/gacha", token, Map.of("kind", "ten"), Map.class);
            assertThat(ten.getStatusCode()).isEqualTo(HttpStatus.OK);
        }
        assertThat(gems(userId("gacha_poor"))).isZero();

        String userId = userId("gacha_poor");
        long ledgerBefore = count("gem_ledger", userId);
        long pullsBefore = count("gacha_pulls", userId);
        long ownedBefore = count("user_players", userId);

        ResponseEntity<Map> single = authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class);
        assertThat(single.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(single.getBody().get("code")).isEqualTo("INSUFFICIENT_GEMS");

        // 지갑·원장·풀 전부 무변동 (트랜잭션 롤백, AC-S6)
        assertThat(gems(userId)).isZero();
        assertThat(count("gem_ledger", userId)).isEqualTo(ledgerBefore);
        assertThat(count("gacha_pulls", userId)).isEqualTo(pullsBefore);
        assertThat(count("user_players", userId)).isEqualTo(ownedBefore);
        // P 는 뽑기에 전혀 관여하지 않으므로 가입 지급분 그대로다.
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single()).isEqualTo(3000L);
    }

    private long gems(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    // ── AC-S7: 10연 = 11개 + pity(GOLD+) ────────────────────────────────

    @Test
    void tenPullGivesElevenResultsWithPity() {
        // pity가 실제로 발동하는 시드 탐색: 원본 11롤에 GOLD+가 없는 시드
        String pitySeed = null;
        for (int i = 0; i < 2000; i++) {
            String candidate = "pity-search-" + i;
            List<String> raw = gachaService.previewRaw(candidate, 11);
            if (raw.stream().noneMatch(id -> GOLD_PLUS.contains(gradeOf(id)))) {
                pitySeed = candidate;
                break;
            }
        }
        assertThat(pitySeed).as("pity 트리거 시드(원본 11롤에 GOLD+ 없음)").isNotNull();
        List<String> raw = gachaService.previewRaw(pitySeed, 11);

        String token = login("gacha_pity");
        SEEDS.add(pitySeed);
        ResponseEntity<Map> response = authPost("/api/shop/gacha", token, Map.of("kind", "ten"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> results = (List<Map<String, Object>>) response.getBody().get("results");
        assertThat(results).hasSize(11);

        List<String> grades = results.stream()
                .map(r -> (String) ((Map<?, ?>) r.get("player")).get("grade"))
                .toList();
        assertThat(grades.stream().anyMatch(GOLD_PLUS::contains))
                .as("pity로 GOLD+ 최소 1명 보장").isTrue();

        // pity는 마지막 롤만 교체: 앞 10개는 원본 롤과 동일, 11번째는 GOLD+
        List<String> resultIds = results.stream()
                .map(r -> (String) ((Map<?, ?>) r.get("player")).get("id"))
                .toList();
        assertThat(resultIds.subList(0, 10)).isEqualTo(raw.subList(0, 10));
        assertThat(GOLD_PLUS.contains(grades.get(10))).isTrue();
    }

    // ── 감사/재현: 저장된 seed → 동일 결과 ──────────────────────────────

    @Test
    void storedSeedReplaysIdenticalResults() {
        String token = login("gacha_replay");
        ResponseEntity<Map> response = authPost("/api/shop/gacha", token, Map.of("kind", "ten"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        String userId = userId("gacha_replay");
        Map<String, Object> pull = jdbcClient.sql(
                        "SELECT id, seed, kind FROM gacha_pulls WHERE user_id = ?")
                .param(userId)
                .query((rs, n) -> Map.<String, Object>of(
                        "id", rs.getString("id"), "seed", rs.getString("seed"), "kind", rs.getString("kind")))
                .single();
        List<String> stored = jdbcClient.sql(
                        "SELECT player_id FROM gacha_results WHERE pull_id = ? ORDER BY ordinal")
                .param(pull.get("id"))
                .query(String.class)
                .list();

        List<String> replayed = gachaService.previewDraw((String) pull.get("seed"), (String) pull.get("kind"));
        assertThat(replayed).isEqualTo(stored);
    }

    // ── AC-S8: 중복 뽑기 → ownedCount 증가 ──────────────────────────────

    @Test
    void duplicatePullIncrementsOwnedCount() {
        // 스타터 팩(P001..P014) 소속 선수가 나오는 단뽑 시드 탐색
        String dupSeed = null;
        String dupPlayer = null;
        for (int i = 0; i < 500; i++) {
            String candidate = "dup-search-" + i;
            String drawn = gachaService.previewRaw(candidate, 1).get(0);
            int num = Integer.parseInt(drawn.substring(1));
            if (num <= 14) {
                dupSeed = candidate;
                dupPlayer = drawn;
                break;
            }
        }
        assertThat(dupSeed).as("스타터 보유 선수를 뽑는 시드").isNotNull();

        String token = login("gacha_dup");
        SEEDS.add(dupSeed);
        ResponseEntity<Map> response = authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        Map<String, Object> result = ((List<Map<String, Object>>) response.getBody().get("results")).get(0);
        assertThat((Boolean) result.get("isNew")).isFalse(); // 이미 스타터 팩으로 보유
        Map<?, ?> player = (Map<?, ?>) result.get("player");
        assertThat(player.get("id")).isEqualTo(dupPlayer);
        assertThat(((Number) player.get("ownedCount")).intValue()).isEqualTo(2);

        // /api/players에도 반영 (AC-S8)
        List<Map<String, Object>> catalog = authGet("/api/players", token, List.class).getBody();
        String finalDupPlayer = dupPlayer;
        Map<String, Object> inCatalog = catalog.stream()
                .filter(p -> finalDupPlayer.equals(p.get("id"))).findFirst().orElseThrow();
        assertThat(((Number) inCatalog.get("ownedCount")).intValue()).isEqualTo(2);
    }

    @Test
    void invalidKindRejected() {
        String token = login("gacha_kind");
        ResponseEntity<Map> response = authPost("/api/shop/gacha", token, Map.of("kind", "hundred"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private String userId(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }

    private long count(String table, String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM " + table + " WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    private long count(String table, String userId, String reason) {
        return jdbcClient.sql("SELECT COUNT(*) FROM " + table + " WHERE user_id = ? AND reason = ?")
                .params(userId, reason).query(Long.class).single();
    }

    private String gradeOf(String playerId) {
        return jdbcClient.sql("SELECT grade FROM players WHERE id = ?")
                .param(playerId).query(String.class).single();
    }
}
