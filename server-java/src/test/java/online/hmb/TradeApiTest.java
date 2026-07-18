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
 * AC-D1~D5 트레이드. 오퍼 생성·판정은 seed 결정론이므로 {@link TradeSeedSource}를 고정 시드 큐로
 * 교체하고, 원하는 오퍼(kind)·롤(성공/실패)을 만드는 seed 를 서비스의 public 헬퍼로 탐색해 주입한다.
 * fixture 카탈로그 17명(BRONZE~LEGEND 전 등급), 스타터 P001..P014 보유, 초기 3000 포인트.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class TradeApiTest extends ApiTestBase {

    /** 다음 슬롯/재생성이 소비할 시드 큐 — 비면 랜덤(다른 테스트 간섭 방지). */
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

    private void forceOpen(String userId, int slotNo) {
        jdbcClient.sql("UPDATE trade_slots SET state='OPEN', opens_at=? WHERE user_id=? AND slot_no=?")
                .params(Instant.now().minusSeconds(60).toString(), userId, slotNo).update();
    }

    private String slotSeed(String userId, int slotNo) {
        return jdbcClient.sql("SELECT seed FROM trade_slots WHERE user_id=? AND slot_no=?")
                .params(userId, slotNo).query(String.class).single();
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

    // ── AC-D1: 슬롯 3개 lazy 생성, 전부 WAITING ─────────────────────────

    @Test
    void lazilyCreatesThreeWaitingSlots() {
        String token = login("trade_slots");
        ResponseEntity<Map> res = authGet("/api/trade", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> slots = (List<Map<String, Object>>) res.getBody().get("slots");
        assertThat(slots).hasSize(3);
        for (Map<String, Object> s : slots) {
            assertThat(s.get("state")).isEqualTo("WAITING");
            assertThat(((Number) s.get("remainingSec")).intValue()).isGreaterThan(0);
            assertThat(((Number) s.get("speedupCost")).intValue()).isGreaterThanOrEqualTo(20); // minPoints
            assertThat(s.get("offerKind")).isIn("FA", "TRADE");
            assertThat(s.get("target")).isNotNull(); // 등장/대가 선수 확정
        }
        Map<?, ?> wallet = (Map<?, ?>) res.getBody().get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(3000L);
        // DB: 슬롯 3행, 전부 WAITING + seed 저장
        long rows = jdbcClient.sql("SELECT COUNT(*) FROM trade_slots WHERE user_id=?")
                .param(userId("trade_slots")).query(Long.class).single();
        assertThat(rows).isEqualTo(3L);
    }

    // ── AC-D1: 오퍼 생성 결정론(같은 시드 → 같은 오퍼) + 저장 시드 재현 ──

    @Test
    void offerGenerationIsSeedDeterministic() {
        login("trade_det");
        String uid = userId("trade_det");
        TradeService.Offer a = tradeService.deriveOffer(uid, "fixed-seed-42");
        TradeService.Offer b = tradeService.deriveOffer(uid, "fixed-seed-42");
        assertThat(a).isEqualTo(b);

        // 저장된 슬롯 시드 → 저장된 오퍼(kind/target/demand) 재현(감사)
        SEEDS.addAll(List.of("audit-seed-1", "audit-seed-2", "audit-seed-3"));
        authGet("/api/trade", loginTokenReuse(uid), Map.class);
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

    /** 이 클래스는 유저 재사용(같은 nickname 재로그인 → 같은 userId). */
    private String loginTokenReuse(String uid) {
        String nickname = jdbcClient.sql("SELECT nickname FROM users WHERE id=?")
                .param(uid).query(String.class).single();
        return login(nickname);
    }

    // ── AC-D4: speedup 비용·시간 단축·멱등 ──────────────────────────────

    @Test
    void speedupChargesProportionalPointsShortensAndIsIdempotent() {
        String token = login("trade_speed");
        String uid = userId("trade_speed");
        // 슬롯1 대상이 LEGEND(waitHours=72 → 비용 3600 > 잔액 3000)면 402 로 플래키하므로, 저비용
        // 대상(비-LEGEND) 시드를 주입해 speedup 비용이 잔액 이하가 되도록 결정론 고정(회귀 가드).
        String seed = findSeed(s -> !"LEGEND".equals(gradeOf(tradeService.deriveOffer(uid, s).targetPlayerId())));
        SEEDS.addAll(List.of(seed, "sp2", "sp3"));
        authGet("/api/trade", token, Map.class); // 슬롯 생성

        long before = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        ResponseEntity<Map> res = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        int spent = ((Number) res.getBody().get("spent")).intValue();
        assertThat(spent).isGreaterThanOrEqualTo(20);
        Map<String, Object> slot = (Map<String, Object>) res.getBody().get("slot");
        assertThat(((Number) slot.get("remainingSec")).intValue()).isEqualTo(0); // 대기 소거
        assertThat(slot.get("state")).isEqualTo("OPEN");
        long after = jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
        assertThat(after).isEqualTo(before - spent);

        // 원장 멱등: trade_speedup 1행 (ref=slotId:seed)
        long ledgerRows = jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='trade_speedup'")
                .param(uid).query(Long.class).single();
        assertThat(ledgerRows).isEqualTo(1L);

        // 이미 OPEN → 재단축 400 TRADE_INVALID
        ResponseEntity<Map> again = authPost("/api/trade/1/speedup", token, null, Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(again.getBody().get("code")).isEqualTo("TRADE_INVALID");
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

    // ── AC-D2: FA 성공 경로(자원 이동·보유·원장·재생성) ─────────────────

    @Test
    void faSuccessTransfersResourcesAndRegenerates() {
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
        SEEDS.addAll(List.of(seed, "x2", "x3", "regen-1")); // slot1 + slot2/3 + 성공 후 재생성
        authGet("/api/trade", token, Map.class);
        forceOpen(uid, 1);

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
        String logResult = jdbcClient.sql(
                        "SELECT result FROM trade_log WHERE user_id=? ORDER BY id DESC LIMIT 1")
                .param(uid).query(String.class).single();
        assertThat(logResult).isEqualTo("SUCCESS");
        // 슬롯 재생성: 새 시드 + WAITING
        assertThat(r.slot().state()).isEqualTo("WAITING");
        assertThat(slotSeed(uid, 1)).isNotEqualTo(capturedSeed).isEqualTo("regen-1");
        // 감사: 저장 시드로 roll 재현 == 판정 roll
        assertThat(tradeService.faRoll(capturedSeed, List.of(offeredPlayer), 0)).isEqualTo(r.roll());
    }

    // ── AC-D2: FA 실패 경로(자원 무손실 + 쿨타임) ──────────────────────

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
        SEEDS.addAll(List.of(seed, "y2", "y3"));
        authGet("/api/trade", token, Map.class);
        forceOpen(uid, 1);

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
        // trade_log FAIL
        assertThat(jdbcClient.sql("SELECT result FROM trade_log WHERE user_id=? ORDER BY id DESC LIMIT 1")
                .param(uid).query(String.class).single()).isEqualTo("FAIL");
    }

    // ── AC-D3: TRADE 수락 성공(demand 이탈 + target 영입) ───────────────

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
        SEEDS.addAll(List.of(seed, "t2", "t3", "regen-acc"));
        authGet("/api/trade", token, Map.class);
        forceOpen(uid, 1);

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
        assertThat(r.slot().state()).isEqualTo("WAITING");
        assertThat(slotSeed(uid, 1)).isEqualTo("regen-acc").isNotEqualTo(capturedSeed);
        assertThat(tradeService.acceptRoll(capturedSeed)).isEqualTo(r.roll());
        assertThat(jdbcClient.sql("SELECT result FROM trade_log WHERE user_id=? ORDER BY id DESC LIMIT 1")
                .param(uid).query(String.class).single()).isEqualTo("SUCCESS");
    }

    // ── AC-D3: TRADE 수락 실패(무손실 + 재생성) ─────────────────────────

    @Test
    void tradeAcceptFailKeepsHoldingsAndRegenerates() {
        String token = login("trade_acc_no");
        String uid = userId("trade_acc_no");
        TradeService.TradeConfig cfg = tradeService.config();
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "TRADE".equals(o.kind()) && o.demandPlayerId() != null
                    && tradeService.acceptRoll(s) >= cfg.tradeAcceptProb();
        });
        SEEDS.addAll(List.of(seed, "u2", "u3", "regen-accno"));
        authGet("/api/trade", token, Map.class);
        forceOpen(uid, 1);

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
        assertThat(r.slot().state()).isEqualTo("WAITING");
        assertThat(slotSeed(uid, 1)).isEqualTo("regen-accno");
    }

    // ── AC-D3/D5: TRADE 거절 → 재대기 + DECLINED 로그 ──────────────────

    @Test
    void tradeDeclineRegeneratesAndLogs() {
        String token = login("trade_dec");
        String uid = userId("trade_dec");
        String seed = findSeed(s -> {
            TradeService.Offer o = tradeService.deriveOffer(uid, s);
            return "TRADE".equals(o.kind()) && o.demandPlayerId() != null;
        });
        SEEDS.addAll(List.of(seed, "d2", "d3", "regen-dec"));
        authGet("/api/trade", token, Map.class);
        forceOpen(uid, 1);
        String capturedSeed = slotSeed(uid, 1);

        TradeService.TradeResolveResponse r = tradeService.decline(uid, 1);
        assertThat(r.result()).isEqualTo("DECLINED");
        assertThat(r.slot().state()).isEqualTo("WAITING");
        assertThat(slotSeed(uid, 1)).isEqualTo("regen-dec").isNotEqualTo(capturedSeed);
        assertThat(jdbcClient.sql("SELECT result FROM trade_log WHERE user_id=? ORDER BY id DESC LIMIT 1")
                .param(uid).query(String.class).single()).isEqualTo("DECLINED");
    }

    // ── 검증: 미보유 선수 제안 거부 / FA 오퍼 아닌 슬롯 propose 거부 ──────

    @Test
    void proposeRejectsUnownedAndWrongKind() {
        String token = login("trade_val");
        String uid = userId("trade_val");
        // FA 오퍼 seed 주입
        String seed = findSeed(s -> "FA".equals(tradeService.deriveOffer(uid, s).kind()));
        SEEDS.addAll(List.of(seed, "v2", "v3"));
        authGet("/api/trade", token, Map.class);
        forceOpen(uid, 1);
        // 미보유 선수(P099 없음) 제안 → TRADE_INVALID
        ResponseEntity<Map> res = authPost("/api/trade/1/propose", token,
                Map.of("playerIds", List.of("P099"), "points", 0), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("TRADE_INVALID");

        // 잘못된 슬롯 번호 → VALIDATION_ERROR
        ResponseEntity<Map> bad = authPost("/api/trade/9/decline", token, null, Map.class);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bad.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }
}
