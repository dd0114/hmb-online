package online.hmb.shop;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;
import java.util.TreeMap;
import online.hmb.catalog.CatalogPlayer;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.Josa;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.meta.WalletService;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 뽑기 (LLD §4.1, AC-S6~S8).
 *
 * 1. 비용 차감(잔액 부족 → 400 INSUFFICIENT_POINTS, 전체 롤백) + 원장(ref=pullId) — 한 트랜잭션.
 * 2. seed = GachaRandomSource(프로덕션 SecureRandom 128bit hex)를 gacha_pulls에 저장.
 *    추첨은 seed 해시 기반 SplittableRandom 결정론: 등급 롤(확률표) → 등급 내 균등 선수 롤.
 * 3. 10연: tenCount(11)회 롤 후 pity — tenPityMinGrade(GOLD)+ 없으면 마지막 롤을
 *    pity 등급 이상으로 제한해 재롤.
 * 4. user_players upsert(count+1) → 응답 {results:[{player,isNew}], wallet}.
 *
 * 모든 수치(비용·확률·pity·tenCount)는 economy.v1.json에서만(AC-S5).
 * previewDraw/previewRaw는 저장된 seed로 결과를 재현하는 감사(audit) 경로 — 같은 카탈로그
 * 버전이면 같은 seed → 같은 결과가 보장된다(ERD 설계 노트 "뽑기 결정론").
 */
@Service
public class GachaService {

    public static final String KIND_SINGLE = "single";
    public static final String KIND_TEN = "ten";
    /** 등급 서열(낮→높). 확률표 순회·pity 비교 모두 이 순서 기준 — 카탈로그 스키마 상수. */
    static final List<String> GRADE_ORDER = List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND");

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final EconomyService economyService;
    private final WalletService walletService;
    private final GachaRandomSource randomSource;
    private final ObjectMapper objectMapper;
    private final online.hmb.rewards.UxActionRewardService uxActionRewardService;

    public GachaService(JdbcClient jdbcClient,
                        TxRunner txRunner,
                        EconomyService economyService,
                        WalletService walletService,
                        GachaRandomSource randomSource,
                        ObjectMapper objectMapper,
                        online.hmb.rewards.UxActionRewardService uxActionRewardService) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.economyService = economyService;
        this.walletService = walletService;
        this.randomSource = randomSource;
        this.objectMapper = objectMapper;
        this.uxActionRewardService = uxActionRewardService;
    }

    // ── API ──────────────────────────────────────────────────────────────

    public GachaResponse pull(String userId, String kind) {
        EconomyService.Gacha gacha = gachaConfig();
        boolean ten = switch (String.valueOf(kind)) {
            case KIND_TEN -> true;
            case KIND_SINGLE -> false;
            default -> throw ApiException.validation("kind는 single|ten만 허용됩니다");
        };
        int cost = ten ? gacha.tenCost() : gacha.singleCost();
        int count = ten ? gacha.tenCount() : 1;
        String reason = ten ? "gacha_ten" : "gacha_single";

        // #212: 결제 재화는 config(gacha.currency) — hero 확정 "뽑기 = 유상재화".
        boolean gems = gacha.paysWithGems();
        String errorCode = gems ? "INSUFFICIENT_GEMS" : "INSUFFICIENT_POINTS";
        // #232: 재화 이름은 config 표기 메타에서 — 문구에 이름을 박으면 표기 변경이 배포가 된다.
        String errorMessage = Josa.iga(economyService.currency(gacha.currency()).name()) + " 부족합니다";

        return txRunner.run(() -> {
            long balance = gems ? walletService.gems(userId) : walletService.points(userId);
            if (balance < cost) {
                throw new ApiException(HttpStatus.BAD_REQUEST, errorCode, errorMessage,
                        Map.of("balance", balance, "cost", cost));
            }

            String pullId = Ulid.next();
            String seed = randomSource.newSeed();
            String now = Instant.now().toString();

            try {
                if (gems) {
                    walletService.applyGems(userId, -cost, reason, pullId);
                } else {
                    walletService.apply(userId, -cost, reason, pullId);
                }
            } catch (DataAccessException e) {
                // 동시 뽑기 경합: 둘 다 사전 잔액검사를 통과해도 wallets CHECK(points>=0 / gems>=0)가
                // 늦은 쪽을 막는다 → 500이 아니라 400 INSUFFICIENT_* (W2 검증 이월사항)
                if (SqliteErrors.isCheckViolation(e)) {
                    throw new ApiException(HttpStatus.BAD_REQUEST, errorCode, errorMessage,
                            Map.of("balance", balance, "cost", cost));
                }
                throw e;
            }
            jdbcClient.sql("""
                            INSERT INTO gacha_pulls(id, user_id, kind, cost, seed, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """)
                    .params(pullId, userId, ten ? KIND_TEN : KIND_SINGLE, cost, seed, now)
                    .update();

            List<String> playerIds = draw(seed, count, ten, gacha);

            List<Boolean> isNewFlags = new ArrayList<>(playerIds.size());
            for (int ordinal = 0; ordinal < playerIds.size(); ordinal++) {
                String playerId = playerIds.get(ordinal);
                jdbcClient.sql("INSERT INTO gacha_results(pull_id, ordinal, player_id) VALUES (?, ?, ?)")
                        .params(pullId, ordinal, playerId)
                        .update();
                isNewFlags.add(upsertOwned(userId, playerId, now));
            }

            // #493 W3 ④: 첫 뽑기 행동 보상(우편 GEM) — 결제·지급이 성공한 같은 tx 안. 멱등이라 2회차부터 no-op.
            uxActionRewardService.grantOnce(userId, online.hmb.rewards.UxActionRewardService.UxAction.FIRST_GACHA);

            return buildResponse(userId, playerIds, isNewFlags);
        });
    }

    /** 저장된 seed로 결과 재현(감사·리플레이). 실제 pull과 동일 알고리즘(pity 포함). */
    public List<String> previewDraw(String seed, String kind) {
        EconomyService.Gacha gacha = gachaConfig();
        boolean ten = KIND_TEN.equals(kind);
        return draw(seed, ten ? gacha.tenCount() : 1, ten, gacha);
    }

    /** pity 미적용 원본 롤(테스트에서 pity 트리거 시드 탐색용). */
    public List<String> previewRaw(String seed, int count) {
        EconomyService.Gacha gacha = gachaConfig();
        Pools pools = loadPools();
        SplittableRandom rng = rngFromSeed(seed);
        List<String> ids = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            ids.add(drawOne(rng, pools, gacha.rates(), null));
        }
        return ids;
    }

    // ── 추첨 알고리즘 (결정론) ───────────────────────────────────────────

    private List<String> draw(String seed, int count, boolean ten, EconomyService.Gacha gacha) {
        Pools pools = loadPools();
        SplittableRandom rng = rngFromSeed(seed);

        List<String> ids = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            ids.add(drawOne(rng, pools, gacha.rates(), null));
        }

        if (ten) {
            int pityRank = gradeRank(gacha.tenPityMinGrade());
            boolean hasPityGrade = ids.stream()
                    .anyMatch(id -> gradeRank(pools.gradeOf().get(id)) >= pityRank);
            // #207: pity 등급 **이상이 전부 비활성**이면 교체할 대상 자체가 없다. 그대로 drawOne 을
            // 부르면 "추첨 가능한 등급이 없습니다" 로 터져 **10연차가 통째로 500** 이 된다(운영자가
            // 상위 등급을 비활성화한 순간 상점이 죽는다). 이 경우 pity 보정을 건너뛴다 —
            // 보정은 상한 보장이지 필수 조건이 아니고, 카탈로그에 없는 등급을 줄 방법도 없다.
            if (!hasPityGrade && hasDrawableGrade(pools, gacha.rates(), gacha.tenPityMinGrade())) {
                // 같은 PRNG 스트림을 이어서, pity 등급 이상으로 제한해 마지막 롤 교체 (LLD §4.1-3)
                String pityId = drawOne(rng, pools, gacha.rates(), gacha.tenPityMinGrade());
                ids.set(ids.size() - 1, pityId);
            }
        }
        return ids;
    }

    /**
     * 1회 추첨: 등급 롤(확률표 가중, minGrade 제한 시 해당 등급 이상으로 정규화) →
     * 등급 내 균등 선수 롤. 카탈로그에 선수가 없는 등급은 후보에서 제외(가중치 자동 정규화).
     */
    private String drawOne(SplittableRandom rng, Pools pools, Map<String, Double> rates, String minGrade) {
        List<String> grades = new ArrayList<>();
        List<Double> weights = new ArrayList<>();
        double total = 0;
        for (String grade : drawableGrades(pools, rates, minGrade)) {
            grades.add(grade);
            weights.add(rates.getOrDefault(grade, 0.0));
            total += rates.getOrDefault(grade, 0.0);
        }
        if (grades.isEmpty()) {
            throw new IllegalStateException("추첨 가능한 등급이 없습니다 (rates/카탈로그 확인)");
        }

        double roll = rng.nextDouble() * total;
        String chosen = grades.get(grades.size() - 1);
        double acc = 0;
        for (int i = 0; i < grades.size(); i++) {
            acc += weights.get(i);
            if (roll < acc) {
                chosen = grades.get(i);
                break;
            }
        }

        List<String> pool = pools.byGrade().get(chosen);
        return pool.get(rng.nextInt(pool.size()));
    }

    /**
     * 실제로 뽑을 수 있는 등급 = 가중치 &gt; 0 <b>이고</b> 카탈로그 풀이 비어 있지 않은 등급
     * ({@code minGrade} 이상). 비활성화(#207)로 어떤 등급이 통째로 사라져도 그 등급만 빠지고
     * 나머지 가중치가 자동 정규화된다 — 확률표를 손댈 필요가 없다.
     */
    private static List<String> drawableGrades(Pools pools, Map<String, Double> rates, String minGrade) {
        int minRank = minGrade == null ? 0 : gradeRank(minGrade);
        List<String> out = new ArrayList<>();
        for (String grade : GRADE_ORDER) {
            if (gradeRank(grade) < minRank) {
                continue;
            }
            List<String> pool = pools.byGrade().get(grade);
            if (rates.getOrDefault(grade, 0.0) <= 0 || pool == null || pool.isEmpty()) {
                continue;
            }
            out.add(grade);
        }
        return out;
    }

    private static boolean hasDrawableGrade(Pools pools, Map<String, Double> rates, String minGrade) {
        return !drawableGrades(pools, rates, minGrade).isEmpty();
    }

    /** seed 문자열 → SHA-256 → 첫 8바이트 long → SplittableRandom (결정론). */
    static SplittableRandom rngFromSeed(String seed) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(seed.getBytes(StandardCharsets.UTF_8));
            long value = 0;
            for (int i = 0; i < 8; i++) {
                value = (value << 8) | (digest[i] & 0xFF);
            }
            return new SplittableRandom(value);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static int gradeRank(String grade) {
        int idx = GRADE_ORDER.indexOf(grade);
        if (idx < 0) {
            throw new IllegalStateException("알 수 없는 등급: " + grade);
        }
        return idx;
    }

    // ── 보유/응답 ────────────────────────────────────────────────────────

    /** user_players upsert — 신규면 insert(true), 중복이면 count+1(false). */
    private boolean upsertOwned(String userId, String playerId, String now) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, 1, ?)
                        """)
                .params(userId, playerId, now)
                .update();
        if (inserted == 0) {
            jdbcClient.sql("UPDATE user_players SET count = count + 1 WHERE user_id = ? AND player_id = ?")
                    .params(userId, playerId)
                    .update();
            return false;
        }
        return true;
    }

    private GachaResponse buildResponse(String userId, List<String> playerIds, List<Boolean> isNewFlags) {
        // 최종 ownedCount/선수 정보를 한 번에 조회 (중복 뽑기 반영 후 값)
        Map<String, CatalogPlayer> players = new LinkedHashMap<>();
        for (String playerId : playerIds) {
            if (players.containsKey(playerId)) {
                continue;
            }
            CatalogPlayer p = jdbcClient.sql("""
                            SELECT p.id, p.name, p.short_name, p.position, p.grade, p.attributes_json,
                                   p.active, COALESCE(up.count, 0) AS owned_count
                            FROM players p
                            LEFT JOIN user_players up ON up.player_id = p.id AND up.user_id = ?
                            WHERE p.id = ?
                            """)
                    .params(userId, playerId)
                    .query((rs, rowNum) -> new CatalogPlayer(
                            rs.getString("id"), rs.getString("name"), rs.getString("short_name"),
                            rs.getString("position"),
                            rs.getString("grade"), parseAttributes(rs.getString("attributes_json")),
                            rs.getInt("owned_count") > 0, rs.getInt("owned_count"),
                            rs.getInt("active") == 1))
                    .single();
            players.put(playerId, p);
        }

        List<GachaResultItem> results = new ArrayList<>(playerIds.size());
        for (int i = 0; i < playerIds.size(); i++) {
            results.add(new GachaResultItem(players.get(playerIds.get(i)), isNewFlags.get(i)));
        }
        // #212: 뽑기가 젬 결제로 바뀌어 응답에도 젬 잔액이 필요하다(additive — points 는 불변).
        return new GachaResponse(results,
                new WalletInfo(walletService.points(userId), walletService.gems(userId)));
    }

    /**
     * #492 계측용 — 이 {@code kind} 의 결제 금액(economy config). 뽑기 자체가 이미 성공한 뒤에
     * <b>이벤트 props 를 채우려고</b> 부른다.
     *
     * <p>값을 응답에 새로 싣지 않는 이유: {@code GachaResponse} 는 web 이 소비하는 계약이라
     * 계측 편의로 넓히면 계약이 계측을 따라 움직인다. 대신 config 를 한 번 더 읽는다(캐시된 스냅샷).
     * economy 가 없으면 여기서 던지지만, 호출부가 {@code BusinessEventRecorder} 의 supplier 안이라
     * 뽑기 응답에는 영향이 없다.
     */
    public int costOf(String kind) {
        EconomyService.Gacha gacha = gachaConfig();
        return KIND_TEN.equals(kind) ? gacha.tenCost() : gacha.singleCost();
    }

    /** #492 계측용 — 결제 재화 코드(POINT|GEM). 위와 같은 규율. */
    public String currencyCode() {
        return gachaConfig().currency();
    }

    private EconomyService.Gacha gachaConfig() {
        return economyService.get()
                .map(EconomyService.Economy::gacha)
                .orElseThrow(() -> new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                        "economy 설정이 로딩되지 않아 뽑기를 사용할 수 없습니다"));
    }

    private Pools loadPools() {
        Map<String, List<String>> byGrade = new TreeMap<>();
        Map<String, String> gradeOf = new LinkedHashMap<>();
        // #207: active=0 유닛은 **추첨 풀에서 제외**(신규 획득 경로 차단). 이미 보유한 카드는
        // 건드리지 않는다 — buildResponse 의 조회는 id 로 직접 읽으므로 비활성 카드도 정상 표시된다.
        jdbcClient.sql("SELECT id, grade FROM players WHERE active = 1 ORDER BY id")
                .query((rs, rowNum) -> Map.entry(rs.getString("id"), rs.getString("grade")))
                .list()
                .forEach(e -> {
                    byGrade.computeIfAbsent(e.getValue(), g -> new ArrayList<>()).add(e.getKey());
                    gradeOf.put(e.getKey(), e.getValue());
                });
        return new Pools(byGrade, gradeOf);
    }

    private Map<String, Object> parseAttributes(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
            });
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("players.attributes_json 파싱 실패: " + e.getMessage(), e);
        }
    }

    private record Pools(Map<String, List<String>> byGrade, Map<String, String> gradeOf) {
    }

    // ── DTO (openapi GachaResponse/GachaResultItem) ──────────────────────

    public record GachaResultItem(CatalogPlayer player, boolean isNew) {
    }

    /** 뽑기 응답 지갑 — points 는 기존 계약 그대로, gems 는 #212 additive 확장. */
    public record WalletInfo(long points, long gems) {
    }

    public record GachaResponse(List<GachaResultItem> results, WalletInfo wallet) {
    }
}
