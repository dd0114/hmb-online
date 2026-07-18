package online.hmb.trade;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.SplittableRandom;
import java.util.TreeMap;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.meta.WalletService;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 트레이드 (AC-D1~D5, LLD-p2-server §5).
 *
 * <p><b>슬롯</b>: 유저별 {@code slots}(=3)개 보장 — 로그인/조회 시 lazy 생성({@link #ensureSlots}).
 * 각 슬롯은 생성 시 시드로 오퍼(kind·target·demand·대기)를 <b>즉시 확정</b>하고 {@code opens_at}만
 * 미래로 둔다(LLD §5: "생성 시 시드로 즉시 확정"). WAITING→OPEN 전이는 스케줄러 없이 접근 시
 * lazy 하게({@code opens_at ≤ now} 이면 OPEN) 처리한다.
 *
 * <p><b>오퍼 생성(시드 결정론)</b> — 저장된 seed에서 파생된 PRNG로 재현 가능:
 * <ol>
 *   <li>kind: economy {@code kindWeights}(FA/TRADE) 가중 롤</li>
 *   <li>target 레어도: {@code targetRarityWeights} 가중 롤 → 해당 등급 풀에서 균등 선수 롤
 *       (등급별 풀이 비면 가중치 정규화로 자동 제외 — Gacha와 동일)</li>
 *   <li>TRADE 면 demand = 내 보유 중 <b>가치 근접</b> 선수(|value − targetValue| 최소, 동률은 id 오름차순)</li>
 *   <li>opens_at = now + {@code waitHours[targetGrade]}h</li>
 * </ol>
 *
 * <p><b>가치함수</b>(문서화, economy {@code trade.value}에서만 — 하드코딩 금지):
 * {@code value(player) = byGrade[grade] + attrSumCoeff × Σ(능력치 9종)}. 제안가치(FA) =
 * {@code Σ value(제안 선수) + 제안 포인트}. 포인트는 byGrade 값과 같은 포인트 단위이므로 1:1 합산한다.
 *
 * <p><b>FA 판정</b>: {@code p = clamp(base + k×(offerValue/targetValue − 1), minProb, maxProb)},
 * roll = seed+제안해시 파생 [0,1). 성공 시 제안 자원(선수·포인트) 소비 + 대상 영입, <b>실패 시 자원
 * 무손실</b>(AC-D2) + 재제안 쿨타임({@code reproposalCooldownHours} 동안 같은 오퍼 유지·WAITING 재대기).
 *
 * <p><b>TRADE 판정</b>: accept = {@code acceptProb}(0.8) 롤 → 성공 시 demand 이탈 + target 영입,
 * 실패/거절은 슬롯 재생성(새 시드·새 대기). 모든 결과는 trade_log 기록.
 *
 * <p><b>멱등</b>: speedup 지출은 point_ledger(reason='trade_speedup', ref=slotId:seed) — 같은 오퍼
 * 회차 내 중복 차감 방지(uq_ledger 재사용). FA 성공 포인트 지출도 ref=slotId:seed.
 */
@Service
public class TradeService {

    /** 등급 서열(낮→높) — 확률표 순회·풀 정규화 기준. 카탈로그 스키마 상수(튜닝값 아님). */
    static final List<String> GRADE_ORDER = List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND");
    private static final int SECONDS_PER_HOUR = 3600;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final EconomyService economyService;
    private final WalletService walletService;
    private final TradeSeedSource seedSource;
    private final ObjectMapper objectMapper;

    public TradeService(JdbcClient jdbcClient,
                        TxRunner txRunner,
                        EconomyService economyService,
                        WalletService walletService,
                        TradeSeedSource seedSource,
                        ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.economyService = economyService;
        this.walletService = walletService;
        this.seedSource = seedSource;
        this.objectMapper = objectMapper;
    }

    // ── config (economy.v2 trade 블록 — 수치 SoT) ────────────────────────

    /**
     * economy {@code trade} 블록 파싱본. 모든 확률·시간·가치 수치는 여기서만 온다(AC-S5,
     * 하드코딩 grep 0). 슬롯 개수/가중치/대기/스피드업/FA 곡선/수락확률/가치표.
     */
    public record TradeConfig(int slots,
                              Map<String, Double> kindWeights,
                              Map<String, Integer> waitHours,
                              Map<String, Double> targetRarityWeights,
                              int speedupPointsPerHour, int speedupMinPoints,
                              double faBase, double faK, double faMinProb, double faMaxProb,
                              int faReproposalCooldownHours,
                              double tradeAcceptProb,
                              Map<String, Integer> valueByGrade, int valueAttrSumCoeff) {
    }

    public TradeConfig config() {
        JsonNode t = economyService.get().map(EconomyService.Economy::trade).orElse(null);
        if (t == null || t.isMissingNode() || t.isNull()) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "economy trade 설정이 로딩되지 않아 트레이드를 사용할 수 없습니다");
        }
        Map<String, Double> kindWeights = new LinkedHashMap<>();
        t.path("kindWeights").properties().forEach(e -> kindWeights.put(e.getKey(), e.getValue().asDouble()));
        Map<String, Integer> waitHours = new LinkedHashMap<>();
        t.path("waitHours").properties().forEach(e -> waitHours.put(e.getKey(), e.getValue().asInt()));
        Map<String, Double> rarity = new LinkedHashMap<>();
        t.path("targetRarityWeights").properties().forEach(e -> rarity.put(e.getKey(), e.getValue().asDouble()));
        Map<String, Integer> byGrade = new LinkedHashMap<>();
        t.path("value").path("byGrade").properties().forEach(e -> byGrade.put(e.getKey(), e.getValue().asInt()));

        JsonNode speedup = t.path("speedup");
        JsonNode fa = t.path("fa");
        return new TradeConfig(
                t.path("slots").asInt(),
                kindWeights, waitHours, rarity,
                speedup.path("pointsPerHour").asInt(), speedup.path("minPoints").asInt(),
                fa.path("base").asDouble(), fa.path("k").asDouble(),
                fa.path("minProb").asDouble(), fa.path("maxProb").asDouble(),
                fa.path("reproposalCooldownHours").asInt(),
                t.path("tradeOffer").path("acceptProb").asDouble(),
                byGrade, t.path("value").path("attrSumCoeff").asInt());
    }

    // ── 슬롯 보장 (lazy 생성) ────────────────────────────────────────────

    /** 유저별 슬롯 {@code slots}개 보장. 없는 slot_no 만 새 시드로 생성(UNIQUE(user,slot_no) 경합 안전). */
    public void ensureSlots(String userId) {
        TradeConfig cfg = config();
        List<Integer> existing = jdbcClient.sql("SELECT slot_no FROM trade_slots WHERE user_id = ?")
                .param(userId).query(Integer.class).list();
        for (int slotNo = 1; slotNo <= cfg.slots(); slotNo++) {
            if (existing.contains(slotNo)) {
                continue;
            }
            createSlot(userId, slotNo, cfg);
        }
    }

    private void createSlot(String userId, int slotNo, TradeConfig cfg) {
        String seed = seedSource.newSeed();
        Offer offer = deriveOffer(userId, seed, cfg);
        Instant now = Instant.now();
        String opensAt = now.plusSeconds((long) offer.waitHours() * SECONDS_PER_HOUR).toString();
        try {
            jdbcClient.sql("""
                            INSERT OR IGNORE INTO trade_slots
                              (id, user_id, slot_no, state, offer_kind, target_player_id,
                               demand_player_id, seed, opens_at, created_at)
                            VALUES (?, ?, ?, 'WAITING', ?, ?, ?, ?, ?, ?)
                            """)
                    .params(Ulid.next(), userId, slotNo, offer.kind(), offer.targetPlayerId(),
                            offer.demandPlayerId(), seed, opensAt, now.toString())
                    .update();
        } catch (DataAccessException e) {
            if (!SqliteErrors.isUniqueViolation(e)) {
                throw e; // 경합으로 다른 요청이 먼저 만든 경우만 무시
            }
        }
    }

    // ── 오퍼 생성 (시드 결정론) ──────────────────────────────────────────

    /** 오퍼 성분(kind/target/demand/대기시간) — 저장 seed 로 재현 가능(감사 테스트). */
    public record Offer(String kind, String targetPlayerId, String demandPlayerId, int waitHours) {
    }

    /** public 오버로드(테스트/감사용) — config 를 내부 로드. 같은 (userId, seed) → 같은 오퍼. */
    public Offer deriveOffer(String userId, String seed) {
        return deriveOffer(userId, seed, config());
    }

    Offer deriveOffer(String userId, String seed, TradeConfig cfg) {
        SplittableRandom rng = rngFromSeed(seed);
        String kind = weightedPick(rng, cfg.kindWeights(), List.of("FA", "TRADE"));

        Map<String, List<String>> pools = loadPools();
        String targetGrade = pickGradeWithPool(rng, cfg.targetRarityWeights(), pools);
        List<String> pool = pools.get(targetGrade);
        String targetPlayerId = pool.get(rng.nextInt(pool.size()));
        int waitHours = cfg.waitHours().getOrDefault(targetGrade, 1);

        String demandPlayerId = null;
        if ("TRADE".equals(kind)) {
            long targetValue = valueOf(targetPlayerId, cfg);
            // demand = 내 보유 중 가치 근접 선수(단, target 본인은 제외 — 자기-자신 트레이드 금지).
            demandPlayerId = closestOwnedByValue(userId, targetValue, targetPlayerId, cfg);
            if (demandPlayerId == null) {
                // 보유 선수가 없어 TRADE 성립 불가 → FA 로 폴백(스타터 팩 보유면 발생하지 않음).
                kind = "FA";
            }
        }
        return new Offer(kind, targetPlayerId, demandPlayerId, waitHours);
    }

    /** 지정 후보를 고정 순서로 순회하는 가중 롤(결정론). */
    private static String weightedPick(SplittableRandom rng, Map<String, Double> weights, List<String> order) {
        double total = 0;
        for (String key : order) {
            total += weights.getOrDefault(key, 0.0);
        }
        double roll = rng.nextDouble() * total;
        double acc = 0;
        for (String key : order) {
            acc += weights.getOrDefault(key, 0.0);
            if (roll < acc) {
                return key;
            }
        }
        return order.get(order.size() - 1);
    }

    /** 풀이 있는 등급만 가중 정규화해 롤(빈 등급 자동 제외 — Gacha drawOne 과 동일 원리). */
    private static String pickGradeWithPool(SplittableRandom rng, Map<String, Double> rarity,
                                            Map<String, List<String>> pools) {
        List<String> grades = new ArrayList<>();
        List<Double> weights = new ArrayList<>();
        double total = 0;
        for (String grade : GRADE_ORDER) {
            double w = rarity.getOrDefault(grade, 0.0);
            List<String> pool = pools.get(grade);
            if (w <= 0 || pool == null || pool.isEmpty()) {
                continue;
            }
            grades.add(grade);
            weights.add(w);
            total += w;
        }
        if (grades.isEmpty()) {
            throw new IllegalStateException("트레이드 대상 등급 없음 (targetRarityWeights/카탈로그 확인)");
        }
        double roll = rng.nextDouble() * total;
        double acc = 0;
        for (int i = 0; i < grades.size(); i++) {
            acc += weights.get(i);
            if (roll < acc) {
                return grades.get(i);
            }
        }
        return grades.get(grades.size() - 1);
    }

    // ── 조회 (GET /api/trade) ───────────────────────────────────────────

    public TradeSlotsResponse getSlots(String userId) {
        return txRunner.run(() -> {
            ensureSlots(userId);
            TradeConfig cfg = config();
            List<TradeSlot> slots = new ArrayList<>();
            for (SlotRow row : slotRows(userId)) {
                openIfDue(row);
                slots.add(viewOf(refresh(row.id()), cfg));
            }
            return new TradeSlotsResponse(slots, new WalletInfo(walletService.points(userId)));
        });
    }

    // ── 대기 단축 (POST /{slot}/speedup) ────────────────────────────────

    public TradeSpeedupResponse speedup(String userId, int slotNo) {
        return txRunner.run(() -> {
            ensureSlots(userId);
            TradeConfig cfg = config();
            SlotRow row = requireSlot(userId, slotNo);
            openIfDue(row);
            row = refresh(row.id());
            if (!"WAITING".equals(row.state())) {
                throw tradeInvalid("대기(WAITING) 상태가 아닌 슬롯은 단축할 수 없습니다");
            }
            long remainingSec = remainingSec(row);
            int cost = speedupCost(remainingSec, cfg);

            long balance = walletService.points(userId);
            if (balance < cost) {
                throw new ApiException(HttpStatus.PAYMENT_REQUIRED, "INSUFFICIENT_POINTS",
                        "포인트가 부족합니다", Map.of("balance", balance, "cost", cost));
            }
            String refId = row.id() + ":" + row.seed();
            boolean charged;
            try {
                charged = walletService.apply(userId, -cost, "trade_speedup", refId);
            } catch (DataAccessException e) {
                if (SqliteErrors.isCheckViolation(e)) {
                    throw new ApiException(HttpStatus.PAYMENT_REQUIRED, "INSUFFICIENT_POINTS",
                            "포인트가 부족합니다", Map.of("balance", balance, "cost", cost));
                }
                throw e;
            }
            int spent = charged ? cost : 0; // 멱등: 같은 오퍼 회차에 이미 지불했으면 재차감 없음
            // opens_at 을 now 로 앞당겨 즉시 OPEN (남은시간 비례 비용을 지불하고 대기 전량 소거).
            String now = Instant.now().toString();
            jdbcClient.sql("UPDATE trade_slots SET opens_at = ?, state = 'OPEN' WHERE id = ?")
                    .params(now, row.id())
                    .update();
            SlotRow updated = refresh(row.id());
            return new TradeSpeedupResponse(viewOf(updated, cfg),
                    new WalletInfo(walletService.points(userId)), spent);
        });
    }

    /** 남은시간 비례 단축 비용: {@code ceil(remainingHours × pointsPerHour)}, 최소 {@code minPoints}. */
    static int speedupCost(long remainingSec, TradeConfig cfg) {
        if (remainingSec <= 0) {
            return 0;
        }
        double hours = remainingSec / (double) SECONDS_PER_HOUR;
        int raw = (int) Math.ceil(hours * cfg.speedupPointsPerHour());
        return Math.max(cfg.speedupMinPoints(), raw);
    }

    // ── FA 제안 (POST /{slot}/propose) ──────────────────────────────────

    public TradeResolveResponse proposeFa(String userId, int slotNo, List<String> playerIds, int points) {
        if (playerIds == null) {
            playerIds = List.of();
        }
        if (points < 0) {
            throw tradeInvalid("제안 포인트는 0 이상이어야 합니다");
        }
        final List<String> offered = List.copyOf(playerIds);
        final int offeredPoints = points;
        return txRunner.run(() -> {
            ensureSlots(userId);
            TradeConfig cfg = config();
            SlotRow row = requireSlot(userId, slotNo);
            openIfDue(row);
            row = refresh(row.id());
            if (!"OPEN".equals(row.state()) || !"FA".equals(row.offerKind())) {
                throw tradeInvalid("OPEN 상태의 FA 오퍼가 아닙니다");
            }
            claimOpen(row); // W2 이월(b): 상태-CAS(OPEN→RESOLVING) — 동시 중복 판정 차단
            // 제안 선수는 모두 현재 보유 중이어야 한다(중복 포함 개수 검증).
            Map<String, Long> need = new LinkedHashMap<>();
            for (String pid : offered) {
                need.merge(pid, 1L, Long::sum);
            }
            for (Map.Entry<String, Long> e : need.entrySet()) {
                if (ownedCount(userId, e.getKey()) < e.getValue()) {
                    throw tradeInvalid("보유하지 않은 선수를 제안할 수 없습니다: " + e.getKey());
                }
            }
            long balance = walletService.points(userId);
            if (balance < offeredPoints) {
                throw new ApiException(HttpStatus.PAYMENT_REQUIRED, "INSUFFICIENT_POINTS",
                        "제안 포인트가 잔액을 초과합니다", Map.of("balance", balance, "points", offeredPoints));
            }

            String targetId = row.targetPlayerId();
            long targetValue = valueOf(targetId, cfg);
            long offerValue = offeredPoints;
            for (String pid : offered) {
                offerValue += valueOf(pid, cfg);
            }
            double p = faProbability(offerValue, targetValue, cfg);
            double roll = faRoll(row.seed(), offered, offeredPoints);
            boolean success = roll < p;

            PlayerRef acquired = null;
            if (success) {
                // 제안 자원 소비: 선수 이탈 + 포인트 차감(원장 멱등 ref=slotId:seed).
                for (String pid : offered) {
                    decrementOwned(userId, pid);
                }
                if (offeredPoints > 0) {
                    // W2 이월(a): apply 반환값 확인 — 미차감(멱등 충돌 등)이면 영입 전 방어 예외(→ 롤백).
                    boolean charged = walletService.apply(userId, -offeredPoints, "trade_fa",
                            row.id() + ":" + row.seed());
                    if (!charged) {
                        throw new ApiException(HttpStatus.CONFLICT, "TRADE_CONFLICT",
                                "제안 포인트가 차감되지 않았습니다(중복 처리 감지) — 트레이드를 취소합니다");
                    }
                }
                acquireOwned(userId, targetId);
                acquired = refOf(targetId);
                logTrade(userId, "FA", "SUCCESS", targetId, offered, offeredPoints, p, roll);
                regenerate(userId, row, cfg);
            } else {
                // 실패: 자원 무손실 + 재제안 쿨타임(같은 오퍼 유지, WAITING 재대기).
                logTrade(userId, "FA", "FAIL", targetId, offered, offeredPoints, p, roll);
                String reopen = Instant.now().plusSeconds(
                        (long) cfg.faReproposalCooldownHours() * SECONDS_PER_HOUR).toString();
                jdbcClient.sql("UPDATE trade_slots SET state = 'WAITING', opens_at = ? WHERE id = ?")
                        .params(reopen, row.id())
                        .update();
            }
            SlotRow after = refresh(row.id());
            return new TradeResolveResponse(success ? "SUCCESS" : "FAIL", p, roll,
                    acquired, null, new WalletInfo(walletService.points(userId)), viewOf(after, cfg));
        });
    }

    /** FA 성공 확률 {@code clamp(base + k×(offerValue/targetValue − 1), minProb, maxProb)}. */
    public double faProbability(long offerValue, long targetValue, TradeConfig cfg) {
        double ratio = targetValue <= 0 ? 1.0 : (double) offerValue / targetValue;
        double p = cfg.faBase() + cfg.faK() * (ratio - 1.0);
        return Math.max(cfg.faMinProb(), Math.min(cfg.faMaxProb(), p));
    }

    /** FA 롤 [0,1) — seed + 정렬된 제안(선수·포인트) 파생 결정론. 같은 제안 → 같은 롤(감사 재현). */
    public double faRoll(String seed, List<String> playerIds, int points) {
        List<String> sorted = new ArrayList<>(playerIds);
        sorted.sort(String::compareTo);
        String salt = seed + ":fa:" + String.join(",", sorted) + ":" + points;
        return rngFromSeed(salt).nextDouble();
    }

    // ── TRADE 수락/거절 (POST /{slot}/accept | decline) ─────────────────

    public TradeResolveResponse accept(String userId, int slotNo) {
        return txRunner.run(() -> {
            ensureSlots(userId);
            TradeConfig cfg = config();
            SlotRow row = requireSlot(userId, slotNo);
            openIfDue(row);
            row = refresh(row.id());
            if (!"OPEN".equals(row.state()) || !"TRADE".equals(row.offerKind())) {
                throw tradeInvalid("OPEN 상태의 TRADE 오퍼가 아닙니다");
            }
            claimOpen(row); // W2 이월(b): 상태-CAS(OPEN→RESOLVING)
            String demandId = row.demandPlayerId();
            String targetId = row.targetPlayerId();
            if (demandId == null || ownedCount(userId, demandId) < 1) {
                throw tradeInvalid("지목된 내 선수를 더는 보유하지 않습니다: " + demandId);
            }
            double p = cfg.tradeAcceptProb();
            double roll = acceptRoll(row.seed());
            boolean success = roll < p;

            PlayerRef acquired = null;
            PlayerRef released = null;
            if (success) {
                decrementOwned(userId, demandId);
                acquireOwned(userId, targetId);
                acquired = refOf(targetId);
                released = refOf(demandId);
                logTrade(userId, "TRADE", "SUCCESS", targetId, List.of(demandId), 0, p, roll);
            } else {
                logTrade(userId, "TRADE", "FAIL", targetId, List.of(demandId), 0, p, roll);
            }
            regenerate(userId, row, cfg);
            SlotRow after = refresh(row.id());
            return new TradeResolveResponse(success ? "SUCCESS" : "FAIL", p, roll,
                    acquired, released, new WalletInfo(walletService.points(userId)), viewOf(after, cfg));
        });
    }

    public TradeResolveResponse decline(String userId, int slotNo) {
        return txRunner.run(() -> {
            ensureSlots(userId);
            TradeConfig cfg = config();
            SlotRow row = requireSlot(userId, slotNo);
            openIfDue(row);
            row = refresh(row.id());
            if (!"OPEN".equals(row.state()) || !"TRADE".equals(row.offerKind())) {
                throw tradeInvalid("OPEN 상태의 TRADE 오퍼가 아닙니다");
            }
            claimOpen(row); // W2 이월(b): 상태-CAS(OPEN→RESOLVING)
            logTrade(userId, "TRADE", "DECLINED", row.targetPlayerId(),
                    row.demandPlayerId() == null ? List.of() : List.of(row.demandPlayerId()), 0, null, null);
            regenerate(userId, row, cfg);
            SlotRow after = refresh(row.id());
            return new TradeResolveResponse("DECLINED", null, null, null, null,
                    new WalletInfo(walletService.points(userId)), viewOf(after, cfg));
        });
    }

    /** TRADE 수락 롤 [0,1) — seed 파생 결정론(감사 재현). */
    public double acceptRoll(String seed) {
        return rngFromSeed(seed + ":accept").nextDouble();
    }

    // ── 슬롯 재생성 (판정 후 새 시드·새 대기) ────────────────────────────

    private void regenerate(String userId, SlotRow row, TradeConfig cfg) {
        String seed = seedSource.newSeed();
        Offer offer = deriveOffer(userId, seed, cfg);
        Instant now = Instant.now();
        String opensAt = now.plusSeconds((long) offer.waitHours() * SECONDS_PER_HOUR).toString();
        jdbcClient.sql("""
                        UPDATE trade_slots SET state = 'WAITING', offer_kind = ?, target_player_id = ?,
                          demand_player_id = ?, seed = ?, opens_at = ?, created_at = ?
                        WHERE id = ?
                        """)
                .params(offer.kind(), offer.targetPlayerId(), offer.demandPlayerId(), seed,
                        opensAt, now.toString(), row.id())
                .update();
    }

    // ── 보유 풀 반영 (count 정합) ────────────────────────────────────────

    private long ownedCount(String userId, String playerId) {
        return jdbcClient.sql("SELECT COALESCE(count, 0) FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId).query(Long.class).optional().orElse(0L);
    }

    /** 보유 1 감소 — count 1 이면 행 삭제(중복 보유면 count-1). */
    private void decrementOwned(String userId, String playerId) {
        jdbcClient.sql("""
                        UPDATE user_players SET count = count - 1
                        WHERE user_id = ? AND player_id = ? AND count >= 1
                        """)
                .params(userId, playerId).update();
        jdbcClient.sql("DELETE FROM user_players WHERE user_id = ? AND player_id = ? AND count <= 0")
                .params(userId, playerId).update();
    }

    /** 영입 — 신규면 insert(count 1), 중복이면 count+1. */
    private void acquireOwned(String userId, String playerId) {
        String now = Instant.now().toString();
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, 1, ?)
                        """)
                .params(userId, playerId, now).update();
        if (inserted == 0) {
            jdbcClient.sql("UPDATE user_players SET count = count + 1 WHERE user_id = ? AND player_id = ?")
                    .params(userId, playerId).update();
        }
    }

    // ── 가치함수 / 선수 참조 ─────────────────────────────────────────────

    /** 가치함수 public 오버로드(감사/표시용) — {@code byGrade[grade] + attrSumCoeff × Σ능력치}. */
    public long valueOf(String playerId) {
        return valueOf(playerId, config());
    }

    private long valueOf(String playerId, TradeConfig cfg) {
        PlayerMeta m = metaOf(playerId);
        return cfg.valueByGrade().getOrDefault(m.grade(), 0) + (long) cfg.valueAttrSumCoeff() * m.attrSum();
    }

    private String closestOwnedByValue(String userId, long targetValue, String excludeId, TradeConfig cfg) {
        List<String> owned = jdbcClient.sql(
                        "SELECT player_id FROM user_players WHERE user_id = ? ORDER BY player_id")
                .param(userId).query(String.class).list();
        String best = null;
        long bestDiff = Long.MAX_VALUE;
        for (String pid : owned) {
            if (pid.equals(excludeId)) {
                continue; // target 본인은 demand 후보에서 제외
            }
            long diff = Math.abs(valueOf(pid, cfg) - targetValue);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = pid; // id 오름차순이라 동률은 첫(작은 id) 유지
            }
        }
        return best;
    }

    private record PlayerMeta(String name, String position, String grade, int attrSum) {
    }

    private PlayerMeta metaOf(String playerId) {
        return jdbcClient.sql("SELECT name, position, grade, attributes_json FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> new PlayerMeta(rs.getString("name"), rs.getString("position"),
                        rs.getString("grade"), attrSum(rs.getString("attributes_json"))))
                .optional()
                .orElseThrow(() -> ApiException.notFound("선수를 찾을 수 없습니다: " + playerId));
    }

    private PlayerRef refOf(String playerId) {
        PlayerMeta m = metaOf(playerId);
        return new PlayerRef(playerId, m.name(), m.position(), m.grade());
    }

    private int attrSum(String attributesJson) {
        try {
            JsonNode node = objectMapper.readTree(attributesJson);
            int sum = 0;
            for (JsonNode v : node) {
                if (v.isNumber()) {
                    sum += v.asInt();
                }
            }
            return sum;
        } catch (Exception e) {
            throw new IllegalStateException("attributes_json 파싱 실패: " + e.getMessage(), e);
        }
    }

    private Map<String, List<String>> loadPools() {
        Map<String, List<String>> byGrade = new TreeMap<>();
        jdbcClient.sql("SELECT id, grade FROM players ORDER BY id")
                .query((rs, n) -> Map.entry(rs.getString("id"), rs.getString("grade")))
                .list()
                .forEach(e -> byGrade.computeIfAbsent(e.getValue(), g -> new ArrayList<>()).add(e.getKey()));
        return byGrade;
    }

    // ── 슬롯 로우 / 뷰 ───────────────────────────────────────────────────

    record SlotRow(String id, int slotNo, String state, String offerKind, String targetPlayerId,
                   String demandPlayerId, String seed, String opensAt) {
    }

    private List<SlotRow> slotRows(String userId) {
        return jdbcClient.sql("""
                        SELECT id, slot_no, state, offer_kind, target_player_id, demand_player_id, seed, opens_at
                        FROM trade_slots WHERE user_id = ? ORDER BY slot_no
                        """)
                .param(userId).query(SLOT_MAPPER).list();
    }

    private SlotRow refresh(String slotId) {
        return jdbcClient.sql("""
                        SELECT id, slot_no, state, offer_kind, target_player_id, demand_player_id, seed, opens_at
                        FROM trade_slots WHERE id = ?
                        """)
                .param(slotId).query(SLOT_MAPPER).single();
    }

    private SlotRow requireSlot(String userId, int slotNo) {
        return jdbcClient.sql("""
                        SELECT id, slot_no, state, offer_kind, target_player_id, demand_player_id, seed, opens_at
                        FROM trade_slots WHERE user_id = ? AND slot_no = ?
                        """)
                .params(userId, slotNo).query(SLOT_MAPPER).optional()
                .orElseThrow(() -> ApiException.notFound("트레이드 슬롯을 찾을 수 없습니다: " + slotNo));
    }

    private static final org.springframework.jdbc.core.RowMapper<SlotRow> SLOT_MAPPER =
            (rs, n) -> new SlotRow(rs.getString("id"), rs.getInt("slot_no"), rs.getString("state"),
                    rs.getString("offer_kind"), rs.getString("target_player_id"),
                    rs.getString("demand_player_id"), rs.getString("seed"), rs.getString("opens_at"));

    /**
     * W2 이월(b): 판정 진입 상태-CAS. OPEN→RESOLVING 을 원자적으로 claim 해 동시 요청의 이중 판정을
     * 막는다(claim 실패 = 다른 요청이 선점 → TRADE_INVALID). 판정 종료 시 regenerate/fail 이 상태를
     * WAITING 으로 되돌리며, 판정 중 예외는 트랜잭션 롤백으로 claim 이 무효화된다.
     */
    private void claimOpen(SlotRow row) {
        int claimed = jdbcClient.sql(
                        "UPDATE trade_slots SET state = 'RESOLVING' WHERE id = ? AND state = 'OPEN'")
                .param(row.id())
                .update();
        if (claimed != 1) {
            throw tradeInvalid("이미 처리 중이거나 OPEN 상태가 아닌 오퍼입니다");
        }
    }

    /** WAITING + opens_at≤now → OPEN 으로 lazy 전이(스케줄러 없이 접근 시). */
    private void openIfDue(SlotRow row) {
        if (!"WAITING".equals(row.state())) {
            return;
        }
        jdbcClient.sql("""
                        UPDATE trade_slots SET state = 'OPEN'
                        WHERE id = ? AND state = 'WAITING' AND opens_at <= ?
                        """)
                .params(row.id(), Instant.now().toString())
                .update();
    }

    private long remainingSec(SlotRow row) {
        long diff = Instant.parse(row.opensAt()).getEpochSecond() - Instant.now().getEpochSecond();
        return Math.max(0, diff);
    }

    private TradeSlot viewOf(SlotRow row, TradeConfig cfg) {
        long remainingSec = remainingSec(row);
        boolean waiting = "WAITING".equals(row.state());
        boolean open = "OPEN".equals(row.state());
        Integer speedupCost = waiting ? speedupCost(remainingSec, cfg) : null;
        PlayerRef target = row.targetPlayerId() != null ? refOf(row.targetPlayerId()) : null;
        PlayerRef demand = row.demandPlayerId() != null ? refOf(row.demandPlayerId()) : null;
        Long targetValue = row.targetPlayerId() != null ? valueOf(row.targetPlayerId(), cfg) : null;
        Double acceptProbability = (open && "TRADE".equals(row.offerKind())) ? cfg.tradeAcceptProb() : null;
        return new TradeSlot(row.slotNo(), row.state(), row.offerKind(), target, demand,
                row.opensAt(), (int) remainingSec, speedupCost, targetValue, acceptProbability);
    }

    // ── trade_log ────────────────────────────────────────────────────────

    private void logTrade(String userId, String kind, String result, String targetId,
                          List<String> offered, int points, Double probability, Double roll) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("target", targetId);
        detail.put("offered", offered);
        detail.put("points", points);
        detail.put("probability", probability);
        detail.put("roll", roll);
        String detailJson;
        try {
            detailJson = objectMapper.writeValueAsString(detail);
        } catch (Exception e) {
            throw new IllegalStateException("trade_log detail 직렬화 실패", e);
        }
        jdbcClient.sql("""
                        INSERT INTO trade_log(user_id, kind, result, detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(userId, kind, result, detailJson, Instant.now().toString())
                .update();
    }

    // ── 유틸 ─────────────────────────────────────────────────────────────

    private static ApiException tradeInvalid(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "TRADE_INVALID", message);
    }

    /** seed 문자열 → SHA-256 첫 8바이트 long → SplittableRandom (Gacha 와 동일 결정론 규약). */
    static SplittableRandom rngFromSeed(String seed) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8));
            long value = 0;
            for (int i = 0; i < 8; i++) {
                value = (value << 8) | (digest[i] & 0xFF);
            }
            return new SplittableRandom(value);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ── DTO (openapi-v2 스키마 대응) ─────────────────────────────────────

    public record PlayerRef(String playerId, String name, String position, String grade) {
    }

    public record WalletInfo(long points) {
    }

    public record TradeSlot(int slot, String state, String offerKind, PlayerRef target, PlayerRef demand,
                            String opensAt, int remainingSec, Integer speedupCost, Long targetValue,
                            Double acceptProbability) {
    }

    public record TradeSlotsResponse(List<TradeSlot> slots, WalletInfo wallet) {
    }

    public record TradeSpeedupResponse(TradeSlot slot, WalletInfo wallet, int spent) {
    }

    public record TradeResolveResponse(String result, Double probability, Double roll,
                                       PlayerRef acquired, PlayerRef released, WalletInfo wallet,
                                       TradeSlot slot) {
    }

    public record FaProposeRequest(List<String> playerIds, Integer points) {
    }
}
