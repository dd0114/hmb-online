package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;
import online.hmb.trade.TradeSeedSource;
import online.hmb.trade.TradeService;
import org.junit.jupiter.api.BeforeEach;
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
 * AC-D1~D5 트레이드 + #149 능동화("장 시작!") 상태머신.
 *
 * <p>전이표(계약 = openapi-v2 trade):
 * <pre>
 *   IDLE   --start-->        WAITING(등급만 공개)
 *   WAITING--(만료|speedup)-> OPEN(전면 공개)
 *   WAITING--start-->        400 TRADE_INVALID (카운트다운 중 재시작 불가)
 *   OPEN   --start-->        WAITING(새 시드) + trade_log DECLINED(action=skip)  [= 거래 안함]
 *   OPEN   --accept/decline/FA성공--> IDLE
 *   OPEN   --FA실패-->       WAITING(같은 오퍼, reproposalCooldownHours 재대기)
 *   IDLE   --propose/accept/decline/speedup--> 400 TRADE_INVALID
 * </pre>
 *
 * <p>오퍼 생성·판정은 seed 결정론이므로 {@link TradeSeedSource}를 고정 시드 큐로 교체하고, 원하는
 * 오퍼(kind)·롤(성공/실패)을 만드는 seed 를 서비스의 public 헬퍼로 탐색해 주입한다. 슬롯 생성은
 * 더 이상 시드를 소비하지 않는다(IDLE 로 생성) — start 마다 1개씩 소비.
 * fixture 카탈로그 17명(BRONZE~LEGEND 전 등급), 스타터 P001..P014 보유, 초기 3000 포인트.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class TradeApiTest extends ApiTestBase {

    /** 다음 start 가 소비할 시드 큐 — 비면 랜덤(다른 테스트 간섭 방지). */
    static final Deque<String> SEEDS = new ArrayDeque<>();

    @TestConfiguration
    static class FixedSeedConfig {
        @Bean
        @Primary
        TradeSeedSource fixedSeedSource() {
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
    private TradeService tradeService;

    @BeforeEach
    void clearSeeds() {
        SEEDS.clear();
    }

    private String userId(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }

    private String gradeOf(String playerId) {
        return jdbcClient.sql("SELECT grade FROM players WHERE id=?")
                .param(playerId).query(String.class).single();
    }

    private long ownedCount(String userId, String playerId) {
        return jdbcClient.sql("SELECT COALESCE(count,0) FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId).query(Long.class).optional().orElse(0L);
    }

    /**
     * 카운트다운 만료 시뮬 — opens_at 만 과거로 민다(state 는 건드리지 않는다). 다음 서비스 접근이
     * 실제 lazy 전이(openIfDue: WAITING→OPEN + revealed=1)를 태우게 해, 테스트가 공개 이력 플래그를
     * 우회하지 않도록 한다.
     */
    private void forceOpen(String userId, int slotNo) {
        jdbcClient.sql("UPDATE trade_slots SET opens_at=? WHERE user_id=? AND slot_no=?")
                .params(Instant.now().minusSeconds(60).toString(), userId, slotNo).update();
    }

    private String slotSeed(String userId, int slotNo) {
        return jdbcClient.sql("SELECT seed FROM trade_slots WHERE user_id=? AND slot_no=?")
                .params(userId, slotNo).query(String.class).optional().orElse(null);
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(userId).query(Long.class).single();
    }

    private long speedupLedgerRows(String userId) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='trade_speedup'")
                .param(userId).query(Long.class).single();
    }

    private String slotState(String userId, int slotNo) {
        return jdbcClient.sql("SELECT state FROM trade_slots WHERE user_id=? AND slot_no=?")
                .params(userId, slotNo).query(String.class).single();
    }

    /** [장 시작!] — 200 이어야 하며 응답의 slot 뷰를 돌려준다. */
    @SuppressWarnings("unchecked")
    private Map<String, Object> startSlot(String token, int slotNo) {
        ResponseEntity<Map> res = authPost("/api/trade/" + slotNo + "/start", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsKeys("slot", "wallet");
        return (Map<String, Object>) res.getBody().get("slot");
    }

    /** 시작 후 즉시 OPEN 으로(만료 시뮬) — 판정 경로 테스트용. */
    private void startAndOpen(String token, String uid, int slotNo) {
        startSlot(token, slotNo);
        forceOpen(uid, slotNo);
    }

    /** predicate 를 만족하는 첫 seed 를 결정론적으로 탐색(브루트포스, 시드 주입 재현용). */
    private String findSeed(Predicate<String> ok) {
        for (int i = 0; i < 200000; i++) {
            String seed = "seed-" + i;
            if (ok.test(seed)) {
                return seed;
            }
        }
        throw new IllegalStateException("predicate 만족 seed 미발견");
    }

    private Map<String, Object> lastTradeLog(String uid) {
        return jdbcClient.sql("""
                        SELECT kind, result, detail_json FROM trade_log
                        WHERE user_id=? ORDER BY id DESC LIMIT 1
                        """)
                .param(uid).query((rs, n) -> Map.<String, Object>of(
                        "kind", rs.getString("kind"),
                        "result", rs.getString("result"),
                        "detail", rs.getString("detail_json")))
                .single();
    }

    // ── #149 (a): 신규 유저 슬롯 3개는 IDLE(오퍼 없음) ────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void lazilyCreatesThreeIdleSlots() {
        String token = login("trade_slots");
        ResponseEntity<Map> res = authGet("/api/trade", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> slots = (List<Map<String, Object>>) res.getBody().get("slots");
        assertThat(slots).hasSize(3);
        for (Map<String, Object> s : slots) {
            assertThat(s.get("state")).isEqualTo("IDLE");
            assertThat(s.get("offerKind")).isNull();
            assertThat(s.get("target")).isNull();
            assertThat(s.get("demand")).isNull();
            assertThat(s.get("targetGrade")).isNull();
            assertThat(s.get("targetValue")).isNull();
            assertThat(s.get("speedupCost")).isNull();
            assertThat(((Number) s.get("remainingSec")).intValue()).isEqualTo(0);
        }
        Map<?, ?> wallet = (Map<?, ?>) res.getBody().get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(3000L);
        // DB: 슬롯 3행, 전부 IDLE + 오퍼 필드 NULL
        long idleRows = jdbcClient.sql("""
                        SELECT COUNT(*) FROM trade_slots
                        WHERE user_id=? AND state='IDLE' AND offer_kind IS NULL AND target_player_id IS NULL
                          AND demand_player_id IS NULL AND seed IS NULL AND opens_at IS NULL
                        """)
                .param(userId("trade_slots")).query(Long.class).single();
        assertThat(idleRows).isEqualTo(3L);
    }

    // ── #149 (b): start → WAITING + 등급만 공개(선수 정체 마스킹) ─────────

    @Test
    void startOpensCountdownRevealingOnlyGrade() {
        String token = login("trade_start");
        String uid = userId("trade_start");
        String seed = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class); // 슬롯 lazy 생성(IDLE)

        Map<String, Object> slot = startSlot(token, 1);
        TradeService.Offer offer = tradeService.deriveOffer(uid, seed);
        assertThat(slot.get("state")).isEqualTo("WAITING");
        // 등급만 공개
        assertThat(slot.get("targetGrade")).isEqualTo(gradeOf(offer.targetPlayerId()));
        // 선수 정체는 비공개(마스킹)
        assertThat(slot.get("target")).isNull();
        assertThat(slot.get("demand")).isNull();
        assertThat(slot.get("targetValue")).isNull();
        // 카운트다운 + 단축 비용
        assertThat(((Number) slot.get("remainingSec")).intValue()).isGreaterThan(0);
        assertThat(((Number) slot.get("speedupCost")).intValue()).isGreaterThanOrEqualTo(20);

        // 마스킹은 뷰에서만 — DB 에는 오퍼가 확정 저장돼 있어야 한다(시드 재현·감사)
        Map<String, Object> row = jdbcClient.sql("""
                        SELECT state, seed, offer_kind, target_player_id FROM trade_slots
                        WHERE user_id=? AND slot_no=1
                        """)
                .param(uid).query((rs, n) -> Map.<String, Object>of(
                        "state", rs.getString("state"),
                        "seed", rs.getString("seed"),
                        "kind", rs.getString("offer_kind"),
                        "target", rs.getString("target_player_id")))
                .single();
        assertThat(row.get("state")).isEqualTo("WAITING");
        assertThat(row.get("seed")).isEqualTo(seed);
        assertThat(row.get("kind")).isEqualTo(offer.kind());
        assertThat(row.get("target")).isEqualTo(offer.targetPlayerId());

        // 다른 슬롯은 여전히 IDLE(start 는 해당 슬롯만 연다)
        assertThat(slotState(uid, 2)).isEqualTo("IDLE");
        assertThat(slotState(uid, 3)).isEqualTo("IDLE");
    }

    // ── #149 (c): WAITING 에서 start → 400 TRADE_INVALID ─────────────────

    @Test
    void startRejectedWhileWaiting() {
        String token = login("trade_start_busy");
        String uid = userId("trade_start_busy");
        SEEDS.add(findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId()))));
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);

        ResponseEntity<Map> again = authPost("/api/trade/1/start", token, null, Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(again.getBody().get("code")).isEqualTo("TRADE_INVALID");
        assertThat(slotState(uid, 1)).isEqualTo("WAITING");
    }

    // ── #149 (d): 만료(=speedup) → OPEN + 전면 공개 ──────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void openRevealsFullOfferAfterCountdown() {
        String token = login("trade_reveal");
        String uid = userId("trade_reveal");
        String seed = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);
        forceOpen(uid, 1); // 카운트다운 만료

        ResponseEntity<Map> res = authGet("/api/trade", token, Map.class);
        List<Map<String, Object>> slots = (List<Map<String, Object>>) res.getBody().get("slots");
        Map<String, Object> slot = slots.get(0);
        TradeService.Offer offer = tradeService.deriveOffer(uid, seed);
        assertThat(slot.get("state")).isEqualTo("OPEN");
        assertThat(slot.get("offerKind")).isEqualTo(offer.kind());
        assertThat(((Map<String, Object>) slot.get("target")).get("playerId")).isEqualTo(offer.targetPlayerId());
        assertThat(slot.get("targetGrade")).isEqualTo(gradeOf(offer.targetPlayerId()));
        assertThat(((Number) slot.get("targetValue")).longValue())
                .isEqualTo(tradeService.valueOf(offer.targetPlayerId()));
        if ("TRADE".equals(offer.kind())) {
            assertThat(((Map<String, Object>) slot.get("demand")).get("playerId")).isEqualTo(offer.demandPlayerId());
            assertThat(slot.get("acceptProbability")).isNotNull();
        }
        assertThat(((Number) slot.get("remainingSec")).intValue()).isEqualTo(0);
        assertThat(slot.get("speedupCost")).isNull();
    }

    // ── #149 (e): OPEN 에서 start = [거래 안함] → 새 시드 + DECLINED(skip) ─

    @Test
    void startOnOpenSkipsOfferAndRerolls() {
        String token = login("trade_skip");
        String uid = userId("trade_skip");
        String first = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.add(first);
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);
        forceOpen(uid, 1);
        String openKind = tradeService.deriveOffer(uid, first).kind();

        long logsBefore = jdbcClient.sql("SELECT COUNT(*) FROM trade_log WHERE user_id=?")
                .param(uid).query(Long.class).single();
        SEEDS.add("skip-reroll");
        Map<String, Object> slot = startSlot(token, 1);

        // 새 오퍼로 WAITING 재진입 + 시드 교체
        assertThat(slot.get("state")).isEqualTo("WAITING");
        assertThat(slot.get("target")).isNull(); // 다시 마스킹
        assertThat(slot.get("targetGrade")).isNotNull();
        assertThat(slotSeed(uid, 1)).isEqualTo("skip-reroll").isNotEqualTo(first);

        // trade_log: DECLINED 1건(action=skip, 기존 offerKind 유지)
        long logsAfter = jdbcClient.sql("SELECT COUNT(*) FROM trade_log WHERE user_id=?")
                .param(uid).query(Long.class).single();
        assertThat(logsAfter).isEqualTo(logsBefore + 1);
        Map<String, Object> log = lastTradeLog(uid);
        assertThat(log.get("result")).isEqualTo("DECLINED");
        assertThat(log.get("kind")).isEqualTo(openKind);
        assertThat((String) log.get("detail")).contains("\"action\":\"skip\"");
    }

    // ── #149 (h): IDLE 에서 propose/accept/decline/speedup → 400 ─────────

    @Test
    void idleSlotRejectsAllOfferActions() {
        String token = login("trade_idle_guard");
        authGet("/api/trade", token, Map.class); // IDLE 슬롯 3개

        for (String path : List.of("/api/trade/1/speedup", "/api/trade/1/accept", "/api/trade/1/decline")) {
            ResponseEntity<Map> res = authPost(path, token, null, Map.class);
            assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(res.getBody().get("code")).as(path).isEqualTo("TRADE_INVALID");
        }
        ResponseEntity<Map> propose = authPost("/api/trade/1/propose", token,
                Map.of("playerIds", List.of("P001"), "points", 0), Map.class);
        assertThat(propose.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(propose.getBody().get("code")).isEqualTo("TRADE_INVALID");
    }

    // ── AC-D1: 오퍼 생성 결정론(같은 시드 → 같은 오퍼) + 저장 시드 재현 ──

    @Test
    void offerGenerationIsSeedDeterministic() {
        String token = login("trade_det");
        String uid = userId("trade_det");
        TradeService.Offer a = tradeService.deriveOffer(uid, "fixed-seed-42");
        TradeService.Offer b = tradeService.deriveOffer(uid, "fixed-seed-42");
        assertThat(a).isEqualTo(b);

        // 저장된 슬롯 시드 → 저장된 오퍼(kind/target/demand) 재현(감사)
        SEEDS.add("audit-seed-1");
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);
        Map<String, Object> row = jdbcClient.sql("""
                        SELECT seed, offer_kind, target_player_id, demand_player_id
                        FROM trade_slots WHERE user_id=? AND slot_no=1
                        """)
                .param(uid).query((rs, n) -> Map.<String, Object>of(
                        "seed", rs.getString("seed"),
                        "kind", rs.getString("offer_kind"),
                        "target", rs.getString("target_player_id"),
                        "demand", rs.getString("demand_player_id") == null ? "" : rs.getString("demand_player_id")))
                .single();
        assertThat(row.get("seed")).isEqualTo("audit-seed-1");
        TradeService.Offer replay = tradeService.deriveOffer(uid, "audit-seed-1");
        assertThat(replay.kind()).isEqualTo(row.get("kind"));
        assertThat(replay.targetPlayerId()).isEqualTo(row.get("target"));
        assertThat(replay.demandPlayerId() == null ? "" : replay.demandPlayerId()).isEqualTo(row.get("demand"));
    }

    // ── AC-D4: speedup 비용·시간 단축·멱등 ──────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void speedupChargesProportionalPointsShortensAndIsIdempotent() {
        String token = login("trade_speed");
        String uid = userId("trade_speed");
        // 대상이 LEGEND(waitHours=72 → 비용 3600 > 잔액 3000)면 402 로 플래키하므로, 저비용
        // 대상(비-LEGEND) 시드를 주입해 speedup 비용이 잔액 이하가 되도록 결정론 고정(회귀 가드).
        String seed = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);

        long before = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        ResponseEntity<Map> res = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        int spent = ((Number) res.getBody().get("spent")).intValue();
        assertThat(spent).isGreaterThanOrEqualTo(20);
        Map<String, Object> slot = (Map<String, Object>) res.getBody().get("slot");
        assertThat(((Number) slot.get("remainingSec")).intValue()).isEqualTo(0); // 대기 소거
        assertThat(slot.get("state")).isEqualTo("OPEN");
        assertThat(slot.get("target")).isNotNull(); // OPEN 이면 전면 공개
        long after = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        assertThat(after).isEqualTo(before - spent);

        // 원장 멱등: trade_speedup 1행 (ref=slotId:seed:opensAt — 대기 회차 단위)
        assertThat(speedupLedgerRows(uid)).isEqualTo(1L);

        // 같은 대기 창 더블클릭 → 이미 OPEN 이라 400 TRADE_INVALID + 재과금 없음(#151 멱등 무회귀)
        ResponseEntity<Map> again = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(again.getBody().get("code")).isEqualTo("TRADE_INVALID");
        assertThat(speedupLedgerRows(uid)).isEqualTo(1L);
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single()).isEqualTo(after);
    }

    // ── #151: FA 재제안 쿨타임 단축은 회차마다 과금된다(0P 우회 금지) ────

    @Test
    @SuppressWarnings("unchecked")
    void cooldownSpeedupChargesEveryRound() {
        String token = login("trade_cool_pay");
        String uid = userId("trade_cool_pay");
        TradeService.TradeConfig cfg = tradeService.config();
        // 빈 제안(offerValue 0 → p=minProb)으로 항상 FAIL 하는 FA 오퍼 + 잔액 내 비용(저등급 대상)
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "FA".equals(o.kind())
                    && List.of("BRONZE", "SILVER", "GOLD").contains(gradeOf(o.targetPlayerId()))
                    && tradeService.faRoll(s, List.of(), 0) >= cfg.faMinProb();
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);

        long balance = points(uid);
        long totalSpent = 0;
        for (int round = 1; round <= 3; round++) {
            // 대기 단축 — 매 회차 실제로 과금돼야 한다(현행 버그: 2회차부터 spent=0)
            ResponseEntity<Map> res = authPost("/api/trade/1/speedup", token, null, Map.class);
            assertThat(res.getStatusCode()).as("round " + round).isEqualTo(HttpStatus.OK);
            int spent = ((Number) res.getBody().get("spent")).intValue();
            assertThat(spent).as("round " + round + " 과금액").isGreaterThan(0);
            totalSpent += spent;
            long now = points(uid);
            assertThat(now).as("round " + round + " 잔액").isEqualTo(balance - spent);
            balance = now;
            assertThat(((Map<String, Object>) res.getBody().get("slot")).get("state")).isEqualTo("OPEN");
            assertThat(speedupLedgerRows(uid)).as("round " + round + " 원장 행수").isEqualTo(round);

            if (round < 3) {
                // FA 실패 → 같은 오퍼로 쿨타임 재대기(= 다음 회차)
                assertThat(tradeService.proposeFa(uid, 1, List.of(), 0).result()).isEqualTo("FAIL");
                assertThat(slotSeed(uid, 1)).isEqualTo(seed); // 시드는 그대로(회차 구분은 opens_at)
            }
        }
        // 원장 합계 == 실제 차감 총액
        long ledgerSum = jdbcClient.sql(
                        "SELECT COALESCE(SUM(delta),0) FROM point_ledger WHERE user_id=? AND reason='trade_speedup'")
                .param(uid).query(Long.class).single();
        assertThat(ledgerSum).isEqualTo(-totalSpent);
    }

    // ── #151 백스톱: 이번 회차 원장이 이미 있으면 단축하지 않는다 ────────

    @Test
    void speedupRefusesWhenAlreadyChargedForThisWaitWindow() {
        String token = login("trade_cool_dup");
        String uid = userId("trade_cool_dup");
        String seed = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);

        // 이번 대기 회차의 원장 키를 미리 선점(동시 요청/충돌 잔여 케이스 시뮬)
        Map<String, Object> row = jdbcClient.sql("SELECT id, seed, opens_at FROM trade_slots WHERE user_id=? AND slot_no=1")
                .param(uid).query((rs, n) -> Map.<String, Object>of(
                        "id", rs.getString("id"), "seed", rs.getString("seed"),
                        "opensAt", rs.getString("opens_at")))
                .single();
        jdbcClient.sql("""
                        INSERT INTO point_ledger(user_id, delta, reason, ref_id, created_at)
                        VALUES (?, 0, 'trade_speedup', ?, ?)
                        """)
                .params(uid, row.get("id") + ":" + row.get("seed") + ":" + row.get("opensAt"),
                        java.time.Instant.now().toString())
                .update();
        long before = points(uid);

        ResponseEntity<Map> res = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("TRADE_INVALID");
        // 단축되지 않았다: 여전히 WAITING + 잔액 불변
        assertThat(slotState(uid, 1)).isEqualTo("WAITING");
        assertThat(points(uid)).isEqualTo(before);
    }

    // ── #151 무회귀: 잔액 부족이면 402 + 단축·과금 없음 ─────────────────

    @Test
    void speedupRejectedWhenInsufficientPoints() {
        String token = login("trade_cool_poor");
        String uid = userId("trade_cool_poor");
        String seed = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startSlot(token, 1);
        jdbcClient.sql("UPDATE wallets SET points = 0 WHERE user_id = ?").param(uid).update();

        ResponseEntity<Map> res = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.PAYMENT_REQUIRED);
        assertThat(res.getBody().get("code")).isEqualTo("INSUFFICIENT_POINTS");
        assertThat(slotState(uid, 1)).isEqualTo("WAITING");
        assertThat(points(uid)).isEqualTo(0L);
        assertThat(speedupLedgerRows(uid)).isEqualTo(0L);
    }

    // ── AC-D2: FA 확률 경계(공식 = LLD SoT) ─────────────────────────────

    @Test
    void faProbabilityBoundaries() {
        login("trade_prob");
        TradeService.TradeConfig cfg = tradeService.config();
        // offerValue == targetValue → base (delta 0)
        assertThat(tradeService.faProbability(1000, 1000, cfg)).isEqualTo(cfg.faBase());
        // offerValue == 0 → clamp 하한(minProb)
        assertThat(tradeService.faProbability(0, 1000, cfg)).isEqualTo(cfg.faMinProb());
        // 대상가치 대폭 초과 → clamp 상한(maxProb)
        assertThat(tradeService.faProbability(100000, 1000, cfg)).isEqualTo(cfg.faMaxProb());
    }

    // ── AC-D2 + #149(f): FA 성공(자원 이동) → 슬롯 IDLE ──────────────────

    @Test
    void faSuccessTransfersResourcesAndClosesSlot() {
        String token = login("trade_fa_ok");
        String uid = userId("trade_fa_ok");
        TradeService.TradeConfig cfg = tradeService.config();
        String offeredPlayer = "P010"; // 보유 GOLD
        long offeredValue = tradeService.valueOf(offeredPlayer);

        // FA 오퍼 + target 가치가 제안보다 낮아 p 큼 + roll<p(성공) 인 seed 탐색
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            if (!"FA".equals(o.kind())) {
                return false;
            }
            long tv = tradeService.valueOf(o.targetPlayerId());
            if (tv >= offeredValue || o.targetPlayerId().equals(offeredPlayer)) {
                return false; // 성공 쉬운 케이스로 제한 + 자기 자신 target 회피
            }
            double p = tradeService.faProbability(offeredValue, tv, cfg);
            return tradeService.faRoll(s, List.of(offeredPlayer), 0) < p;
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);

        String targetId = tradeService.deriveOffer(uid, seed).targetPlayerId();
        long targetOwnedBefore = ownedCount(uid, targetId);
        long offeredOwnedBefore = ownedCount(uid, offeredPlayer);
        long pointsBefore = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        String capturedSeed = slotSeed(uid, 1);

        TradeService.TradeResolveResponse r = tradeService.proposeFa(uid, 1, List.of(offeredPlayer), 0);
        assertThat(r.result()).isEqualTo("SUCCESS");
        assertThat(r.acquired().playerId()).isEqualTo(targetId);
        // 보유 정합: 제안 선수 이탈(-1), 대상 영입(+1)
        assertThat(ownedCount(uid, offeredPlayer)).isEqualTo(offeredOwnedBefore - 1);
        assertThat(ownedCount(uid, targetId)).isEqualTo(targetOwnedBefore + 1);
        // 포인트 미제안 → 지갑 불변
        long pointsAfter = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        assertThat(pointsAfter).isEqualTo(pointsBefore);
        // trade_log SUCCESS
        assertThat(lastTradeLog(uid).get("result")).isEqualTo("SUCCESS");
        // #149: 판정 후 슬롯은 IDLE(다음 장은 유저가 [장 시작!] 로 연다)
        assertThat(r.slot().state()).isEqualTo("IDLE");
        assertThat(r.slot().target()).isNull();
        assertThat(r.slot().offerKind()).isNull();
        assertThat(slotSeed(uid, 1)).isNull();
        // 감사: 저장 시드로 roll 재현 == 판정 roll
        assertThat(tradeService.faRoll(capturedSeed, List.of(offeredPlayer), 0)).isEqualTo(r.roll());
    }

    // ── AC-D2 + #149(g): FA 실패 → 같은 오퍼 유지 + 쿨타임 WAITING ───────

    @Test
    void faFailKeepsResourcesAndSetsCooldown() {
        String token = login("trade_fa_no");
        String uid = userId("trade_fa_no");
        TradeService.TradeConfig cfg = tradeService.config();
        // 제안 없음(offerValue 0 → p=minProb) + roll>=p(실패) 인 FA seed
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "FA".equals(o.kind()) && tradeService.faRoll(s, List.of(), 0) >= cfg.faMinProb();
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);

        String targetId = tradeService.deriveOffer(uid, seed).targetPlayerId();
        long targetOwnedBefore = ownedCount(uid, targetId);
        long pointsBefore = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        long ownedTotalBefore = jdbcClient.sql("SELECT COALESCE(SUM(count),0) FROM user_players WHERE user_id=?")
                .param(uid).query(Long.class).single();

        TradeService.TradeResolveResponse r = tradeService.proposeFa(uid, 1, List.of(), 0);
        assertThat(r.result()).isEqualTo("FAIL");
        assertThat(r.acquired()).isNull();
        // 자원 무손실
        assertThat(ownedCount(uid, targetId)).isEqualTo(targetOwnedBefore);
        assertThat(jdbcClient.sql("SELECT COALESCE(SUM(count),0) FROM user_players WHERE user_id=?")
                .param(uid).query(Long.class).single()).isEqualTo(ownedTotalBefore);
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single()).isEqualTo(pointsBefore);
        // 쿨타임: 같은 오퍼 유지(seed·target 불변) + WAITING 재대기(≈ reproposalCooldownHours)
        assertThat(r.slot().state()).isEqualTo("WAITING");
        assertThat(slotSeed(uid, 1)).isEqualTo(seed);
        assertThat(tradeService.deriveOffer(uid, slotSeed(uid, 1)).targetPlayerId()).isEqualTo(targetId);
        int remaining = r.slot().remainingSec();
        int cooldownSec = cfg.faReproposalCooldownHours() * 3600;
        assertThat(remaining).isBetween(cooldownSec - 120, cooldownSec);
        // #149 후속: 이미 공개됐던 오퍼는 쿨타임 WAITING 에서도 계속 공개(도로 가리지 않는다)
        assertThat(r.slot().target()).isNotNull();
        assertThat(r.slot().target().playerId()).isEqualTo(targetId); // 실패 전과 같은 선수
        assertThat(r.slot().targetGrade()).isEqualTo(gradeOf(targetId));
        assertThat(r.slot().targetValue()).isEqualTo(tradeService.valueOf(targetId));
        // 쿨타임도 speedup 으로 줄일 수 있어야 한다(허용 상태가 WAITING)
        assertThat(r.slot().speedupCost()).isNotNull().isGreaterThanOrEqualTo(20);
        // trade_log FAIL
        assertThat(lastTradeLog(uid).get("result")).isEqualTo("FAIL");
    }

    // ── #149 후속: 쿨타임 재대기(공개 유지)는 GET 에서도 공개 + speedup 가능 ─

    @Test
    @SuppressWarnings("unchecked")
    void revealedOfferStaysVisibleDuringCooldownAndCanBeSpeduUp() {
        String token = login("trade_fa_cool");
        String uid = userId("trade_fa_cool");
        TradeService.TradeConfig cfg = tradeService.config();
        // 실패하는 FA(제안 없음) + speedup 비용이 잔액 이하가 되도록 비-LEGEND 대상
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "FA".equals(o.kind()) && !"LEGEND".equals(gradeOf(o.targetPlayerId()))
                    && tradeService.faRoll(s, List.of(), 0) >= cfg.faMinProb();
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);
        String targetId = tradeService.deriveOffer(uid, seed).targetPlayerId();

        assertThat(tradeService.proposeFa(uid, 1, List.of(), 0).result()).isEqualTo("FAIL");

        // GET 응답에서도 공개 유지(뷰 일관성)
        ResponseEntity<Map> res = authGet("/api/trade", token, Map.class);
        Map<String, Object> slot = ((List<Map<String, Object>>) res.getBody().get("slots")).get(0);
        assertThat(slot.get("state")).isEqualTo("WAITING");
        assertThat(((Map<String, Object>) slot.get("target")).get("playerId")).isEqualTo(targetId);
        assertThat(slot.get("targetValue")).isNotNull();

        // 쿨타임 speedup → 즉시 OPEN(같은 오퍼 유지)
        ResponseEntity<Map> sp = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(sp.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> after = (Map<String, Object>) sp.getBody().get("slot");
        assertThat(after.get("state")).isEqualTo("OPEN");
        assertThat(((Map<String, Object>) after.get("target")).get("playerId")).isEqualTo(targetId);
        assertThat(slotSeed(uid, 1)).isEqualTo(seed);
    }

    // ── #149 후속: 판정 후 IDLE 로 닫히면 공개이력도 리셋 → 다음 장은 다시 마스킹 ─

    @Test
    void revealFlagResetsSoNextRoundIsMaskedAgain() {
        String token = login("trade_rv_reset");
        String uid = userId("trade_rv_reset");
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "TRADE".equals(o.kind()) && o.demandPlayerId() != null;
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1); // 공개됨(revealed=1)

        // 거절 → IDLE (revealed 리셋)
        assertThat(tradeService.decline(uid, 1).slot().state()).isEqualTo("IDLE");
        assertThat(jdbcClient.sql("SELECT revealed FROM trade_slots WHERE user_id=? AND slot_no=1")
                .param(uid).query(Integer.class).single()).isEqualTo(0);

        // 다음 장은 다시 가려진 채 시작
        SEEDS.add(findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId()))));
        Map<String, Object> slot = startSlot(token, 1);
        assertThat(slot.get("state")).isEqualTo("WAITING");
        assertThat(slot.get("target")).isNull();
        assertThat(slot.get("targetValue")).isNull();
        assertThat(slot.get("targetGrade")).isNotNull();
    }

    // ── AC-D3 + #149(f): TRADE 수락 성공(스왑) → IDLE ───────────────────

    @Test
    void tradeAcceptSuccessSwapsPlayers() {
        String token = login("trade_acc_ok");
        String uid = userId("trade_acc_ok");
        TradeService.TradeConfig cfg = tradeService.config();
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "TRADE".equals(o.kind()) && o.demandPlayerId() != null
                    && tradeService.acceptRoll(s) < cfg.tradeAcceptProb();
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);

        TradeService.Offer offer = tradeService.deriveOffer(uid, seed);
        String targetId = offer.targetPlayerId();
        String demandId = offer.demandPlayerId();
        long targetBefore = ownedCount(uid, targetId);
        long demandBefore = ownedCount(uid, demandId);
        String capturedSeed = slotSeed(uid, 1);

        TradeService.TradeResolveResponse r = tradeService.accept(uid, 1);
        assertThat(r.result()).isEqualTo("SUCCESS");
        assertThat(r.acquired().playerId()).isEqualTo(targetId);
        assertThat(r.released().playerId()).isEqualTo(demandId);
        assertThat(ownedCount(uid, demandId)).isEqualTo(demandBefore - 1);
        // target==demand 는 없음(demand 는 보유선수, target 는 카탈로그 임의) — 일반적으로 +1
        assertThat(ownedCount(uid, targetId)).isEqualTo(targetId.equals(demandId)
                ? targetBefore : targetBefore + 1);
        assertThat(r.slot().state()).isEqualTo("IDLE");
        assertThat(slotSeed(uid, 1)).isNull();
        assertThat(tradeService.acceptRoll(capturedSeed)).isEqualTo(r.roll());
        assertThat(lastTradeLog(uid).get("result")).isEqualTo("SUCCESS");
    }

    // ── AC-D3 + #149(f): TRADE 수락 실패(무손실) → IDLE ─────────────────

    @Test
    void tradeAcceptFailKeepsHoldingsAndClosesSlot() {
        String token = login("trade_acc_no");
        String uid = userId("trade_acc_no");
        TradeService.TradeConfig cfg = tradeService.config();
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "TRADE".equals(o.kind()) && o.demandPlayerId() != null
                    && tradeService.acceptRoll(s) >= cfg.tradeAcceptProb();
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);

        TradeService.Offer offer = tradeService.deriveOffer(uid, seed);
        long demandBefore = ownedCount(uid, offer.demandPlayerId());
        long total = jdbcClient.sql("SELECT COALESCE(SUM(count),0) FROM user_players WHERE user_id=?")
                .param(uid).query(Long.class).single();

        TradeService.TradeResolveResponse r = tradeService.accept(uid, 1);
        assertThat(r.result()).isEqualTo("FAIL");
        assertThat(r.acquired()).isNull();
        assertThat(ownedCount(uid, offer.demandPlayerId())).isEqualTo(demandBefore);
        assertThat(jdbcClient.sql("SELECT COALESCE(SUM(count),0) FROM user_players WHERE user_id=?")
                .param(uid).query(Long.class).single()).isEqualTo(total);
        assertThat(r.slot().state()).isEqualTo("IDLE");
        assertThat(slotSeed(uid, 1)).isNull();
    }

    // ── AC-D3/D5 + #149(f): TRADE 거절 → IDLE + DECLINED 로그 ───────────

    @Test
    void tradeDeclineClosesSlotAndLogs() {
        String token = login("trade_dec");
        String uid = userId("trade_dec");
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "TRADE".equals(o.kind()) && o.demandPlayerId() != null;
        });
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);

        TradeService.TradeResolveResponse r = tradeService.decline(uid, 1);
        assertThat(r.result()).isEqualTo("DECLINED");
        assertThat(r.slot().state()).isEqualTo("IDLE");
        assertThat(slotSeed(uid, 1)).isNull();
        Map<String, Object> log = lastTradeLog(uid);
        assertThat(log.get("result")).isEqualTo("DECLINED");
        // [거래 안함](start)과 구분: decline 은 action=skip 이 아니다
        assertThat((String) log.get("detail")).doesNotContain("\"action\":\"skip\"");
    }

    // ── 검증: 미보유 선수 제안 거부 / 잘못된 슬롯 번호 ───────────────────

    @Test
    void proposeRejectsUnownedAndWrongKind() {
        String token = login("trade_val");
        String uid = userId("trade_val");
        // FA 오퍼 seed 주입
        String seed = findSeed(s -> "FA".equals(tradeService.deriveOffer(uid, s).kind()));
        SEEDS.add(seed);
        authGet("/api/trade", token, Map.class);
        startAndOpen(token, uid, 1);
        // 미보유 선수(P099 없음) 제안 → TRADE_INVALID
        ResponseEntity<Map> res = authPost("/api/trade/1/propose", token,
                Map.of("playerIds", List.of("P099"), "points", 0), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("TRADE_INVALID");

        // 잘못된 슬롯 번호 → VALIDATION_ERROR (start 포함)
        for (String path : List.of("/api/trade/9/decline", "/api/trade/9/start")) {
            ResponseEntity<Map> bad = authPost(path, token, null, Map.class);
            assertThat(bad.getStatusCode()).as(path).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(bad.getBody().get("code")).as(path).isEqualTo("VALIDATION_ERROR");
        }
    }
}
