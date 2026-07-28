package online.hmb.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * economy.v1.json(data 도메인 산출물) 로더 — 경제 수치의 SoT (AC-S5: 코드 하드코딩 금지).
 * W1 소비 범위: initialPoints + starterPack(스타터 팩 14명). gacha/rewards는 W2/W3에서 소비.
 *
 * 파일이 없으면 empty — 로그인 시 스타터 팩 지급을 건너뛰고 경고만 남긴다(부팅은 계속,
 * §0.5 도메인 분할: data 에픽 산출물을 대신 생성하지 않는다).
 */
@Component
public class EconomyService {

    private static final Logger log = LoggerFactory.getLogger(EconomyService.class);

    /**
     * 경제 수치 스냅샷 (W1: initialPoints/starterPack + trade/league 블록 로드, W2: gacha·trade, W3: rewards·league).
     * trade/league 는 economy.v2.json 의 신규 블록 — W1 은 로드만(소비는 W2/W3). 구파일(블록 없음)엔 null.
     * growth/star/potential/dice = 에픽 #179 메이플 피벗(V2) — 구 enhance 블록은 폐기.
     */
    public record Economy(String version, int initialPoints, int initialGems, List<String> starterPack,
                          Gacha gacha, Rewards rewards, JsonNode trade, JsonNode league,
                          LeagueGemReward leagueGemReward,
                          Growth growth, Star star, Potential potential, Dice dice, Gems gems,
                          StarterTop starterTop, List<Currency> currencies) {

        /** 코드({@code POINT|GEM})로 표기 메타 조회 — 모르는 코드면 코드 자체를 심볼로 쓰는 최소 메타. */
        public Currency currency(String code) {
            return EconomyService.currencyOf(currencies, code);
        }
    }

    /**
     * economy.v3 `starterTop` 노드 (#209 AC1) — 가입 시 지급하는 <b>최상위 유닛 후보</b>와 장수.
     *
     * <p>목록이 코드가 아니라 데이터인 것이 요구의 핵심이다: #207(LEGEND 개편)이 랜딩하면
     * economy 파일의 id 만 갈아끼우고 서버는 손대지 않는다(#207 랜딩 때 실제로 그렇게 교체했다). 구파일(v2)엔 없어 null 이며,
     * 그때는 기본팩만 지급된다(부팅·가입 모두 계속 동작 — fail-open, 로그만 남긴다).
     */
    public record StarterTop(List<String> pool, int count) {
    }

    /**
     * economy.v1.json `gacha` 노드 — 뽑기 비용·확률표·pity (AC-S5: 여기서만 온다).
     * currency(#212) = 뽑기 결제 재화 {@code POINT|GEM} — 구파일(필드 없음)은 POINT 로 폴백.
     * singleCost/tenCost 는 그 재화 단위로 해석된다.
     */
    public record Gacha(String currency, int singleCost, int tenCost, int tenCount,
                        Map<String, Double> rates, String tenPityMinGrade) {

        public boolean paysWithGems() {
            return CURRENCY_GEM.equals(currency);
        }
    }

    public static final String CURRENCY_GEM = "GEM";
    public static final String CURRENCY_POINT = "POINT";

    /**
     * 재화 <b>표기</b> 메타 (#232) — 내부 코드({@code POINT|GEM})를 화면 문자열로 옮기는 유일한 자리다.
     *
     * <p>코드·DB 컬럼(`wallets.points/gems`)·원장·에러코드는 <b>건드리지 않는다</b>. 바뀌는 건 표기뿐이고,
     * 표기는 데이터라서 배포가 아니라 economy override + {@code POST /api/admin/economy/reload} 로 바뀐다.
     * 클라이언트는 여기서 내려간 값을 그대로 렌더한다 — 심볼·이름·아이콘을 클라가 알면 다음에 또 바뀐다.
     *
     * @param code      내부 재화 코드({@code POINT|GEM}) — 값·원장·API 가 쓰는 그 코드
     * @param symbol    금액 옆 짧은 표기(hero 확정: 골드=G, 다이아=Z)
     * @param name      풀네임(문장형 안내문·툴팁용). ⚠️ 카드 <b>등급</b> 이름과 겹칠 수 있어 화면 기본은 symbol 이다
     * @param icon      금액 앞 아이콘(한 글자 이모지/기호)
     * @param position  symbol 위치 {@code prefix|suffix}
     * @param separator 금액과 symbol 사이 구분자
     */
    public record Currency(String code, String symbol, String name, String icon,
                           String position, String separator) {
    }

    /**
     * 표기 기본값 (#232 hero 확정 — 다이아=Z, 골드=G).
     *
     * <p>업계 표준 3층 중 <b>last-known-good 폴백</b>에 해당한다: 발행 SoT(economy 파일)가 이기고,
     * 그게 없거나 일부만 있으면 여기로 메운다. 발행물에 {@code currencies} 가 실리면 이 상수는
     * 지우는 게 아니라 폴백으로 남는다.
     */
    public static final List<Currency> DEFAULT_CURRENCIES = List.of(
            new Currency(CURRENCY_POINT, "G", "골드", "●", "suffix", " "),
            new Currency(CURRENCY_GEM, "Z", "다이아", "💎", "suffix", " "));

    /** 코드로 표기 메타 조회 — 모르는 코드면 코드 자체를 심볼로 쓰는 최소 메타(문자열이 비지 않게). */
    public static Currency currencyOf(List<Currency> currencies, String code) {
        if (currencies != null) {
            for (Currency c : currencies) {
                if (c.code().equals(code)) {
                    return c;
                }
            }
        }
        return new Currency(code, code, code, "", "suffix", " ");
    }

    /**
     * economy.v1.json `rewards` 노드 — 매치 보상 승/무/패 (AC-M6, ref=matchId 멱등 지급).
     * byMode(#212) = 모드별 오버라이드 {@code {practice|league: {win,draw,loss}}} — 없으면 flat 값 폴백.
     * hero 확정 곡선: 연습 적게 &lt; 리그 매판 적당 &lt; 리그 최종성적 가파르게.
     */
    public record Rewards(int win, int draw, int loss, Map<String, Rewards> byMode) {

        /** 모드별 보상 조회 — byMode[mode] 가 있으면 그것, 없으면 자기 자신(레거시 flat). */
        public Rewards forMode(String mode) {
            if (byMode == null || mode == null) {
                return this;
            }
            return byMode.getOrDefault(mode, this);
        }

        public int by(String result) {
            return switch (String.valueOf(result)) {
                case "WIN" -> win;
                case "LOSS" -> loss;
                default -> draw;
            };
        }
    }

    /**
     * economy.v2.json `league.gemReward` 노드 (#212) — 리그 상위 입상 시 젬 지급.
     * maxRank 이내 순위에만, [min, max] 균등 랜덤(시즌 seed 결정론 — {@code Math.random} 금지).
     */
    public record LeagueGemReward(int maxRank, int min, int max) {
    }

    /**
     * economy.v2.json `growth` 노드 (에픽 #179 V2-5, 메이플 피벗 GM1) — 경기 스탯별 XP 트랙 수치.
     * baselineByPosition = {FW|MF|DF|GK: {능력치: 방향 가중치}}(합≈1) — XP 방향 가중치 + OVR 가중치 겸용.
     * eventStatMap = {이벤트타입: {능력치: 가중치}} — match-log 이벤트 카운트 × 가중치 = eventBonus.
     */
    public record Growth(int xpBase, int xpLvBase, double xpLvGrowth,
                         Map<String, Double> gradeXpMult, Map<String, Double> minutesMult,
                         Map<String, Map<String, Double>> baselineByPosition,
                         Map<String, Map<String, Double>> eventStatMap) {
    }

    /** economy.v2.json `star` 노드 (에픽 #179 V2-5) — 성★ 승급(중복 소모·스탯 천장 개방 비율). */
    public record Star(Map<Integer, Integer> copies, Map<Integer, Double> starFrac) {
    }

    /** 잠재 옵션 테이블 1행 — type(STAT_PCT|STAT_FLAT|CONDITION_RECOVERY|TEAM_MORALE), stat(STAT_* 만). */
    public record PotentialOption(String type, String stat, double value, double weight, boolean premium) {
    }

    /**
     * economy.v2.json `potential` 노드 (에픽 #179 V2-5) — 잠재능력 3줄·티어·다이스 확률.
     * cashPremiumMult = 캐시 다이스가 premium=true 옵션 weight 에 곱하는 배수(GM1 신설).
     */
    public record Potential(Map<String, Integer> linesByGrade, Map<String, String> gradeTierCap,
                            Map<Integer, String> starTierCap, Map<String, Double> tierUp,
                            double ceilingMult, double cashPremiumMult,
                            Map<String, List<PotentialOption>> tables) {
    }

    /**
     * economy.v2.json `dice` 노드 (에픽 #179 V2-5, V2.2 재화 이원화로 cashCost→cashGemCost 개정) —
     * 다이스 상점 가격. 노말=P, 캐시=젬 전용(cashGemCost).
     */
    public record Dice(int normalCost, int cashGemCost) {
    }

    /** economy.v2.json `gems` 노드 팩 1종 — 충전 목업(실결제 없음, 즉시 지급). */
    public record GemTopupPack(String id, int gems, String mockPrice) {
    }

    /**
     * economy.v2.json `gems` 노드 (V2.2 재화 이원화 GM8s) — 충전 팩 목록.
     * topupEnabled(#212) = 목업 충전 수도꼭지 스위치. hero 확정: 젬 수급원은 가입 지급 + 리그 입상
     * 둘뿐 → 기본 false. 구파일(필드 없음)은 기존 동작 유지를 위해 true 폴백.
     */
    public record Gems(boolean topupEnabled, List<GemTopupPack> topupPacks) {
    }

    /**
     * 현재 유효한 스냅샷 + 그게 어디서 왔는지. {@code volatile} 이라 리로드가 원자적으로 갈아끼운다
     * (읽는 쪽은 락 없이 항상 완성된 스냅샷 하나를 본다 — 반쯤 바뀐 상태가 관측되지 않는다).
     */
    public record Snapshot(Optional<Economy> economy, Source source, String path, String loadedAt) {
    }

    /** 스냅샷 출처. BAKED = 배포에 구워진 발행물, OVERRIDE = 운영이 얹은 파일(무배포 교체). */
    public enum Source {
        BAKED, OVERRIDE, NONE
    }

    private final ObjectMapper objectMapper;
    private final String economyFile;
    /** null = override 개념 없음(순수 로더). 스프링 경로에서는 항상 경로가 들어온다. */
    private final String overrideFile;
    private volatile Snapshot snapshot;

    @org.springframework.beans.factory.annotation.Autowired
    public EconomyService(ObjectMapper objectMapper,
                          @Value("${hmb.data.economy-file}") String economyFile,
                          @Value("${hmb.data.economy-override-file:}") String overrideFile,
                          @Value("${hmb.db.path:./.data/hmb.db}") String dbPath) {
        this.objectMapper = objectMapper;
        this.economyFile = economyFile;
        // 기본 override 경로 = **DB 파일과 같은 디렉토리**. 이유: 그 디렉토리는 어느 환경에서든
        // 쓰기 가능하고 영속이다(도커는 named volume 이 마운트돼 있고, 로컬은 ./.data). 발행물이
        // 놓인 경로는 이미지에 구워져 있어(COPY) 쓸 수 없다 — 거기에 쓰려 했으면 무배포 운영이
        // 도커에서만 조용히 실패했을 것이다. 명시 설정이 있으면 그게 이긴다.
        this.overrideFile = (overrideFile == null || overrideFile.isBlank())
                ? defaultOverridePath(dbPath)
                : overrideFile;
        // 부팅은 관대하게(strict=false) — 깨진 override 로 서버가 못 뜨는 상황을 만들지 않는다.
        this.snapshot = loadSnapshot(false);
    }

    /**
     * <b>순수 로더</b>(스프링 밖) — 파일 하나를 그대로 읽는다. override 개념이 없다.
     *
     * <p>구파일 폴백 계약({@code EconomyLegacyFallbackTest})처럼 "이 JSON 이 어떻게 해석되는가"만
     * 보는 자리를 위해 남긴다. 운영 경로(무배포 교체)는 override 를 아는 위 생성자만 쓴다 —
     * 여기로 만든 인스턴스에 {@link #reload()} 를 걸면 같은 파일을 다시 읽을 뿐이다.
     */
    public EconomyService(ObjectMapper objectMapper, String economyFile) {
        this.objectMapper = objectMapper;
        this.economyFile = economyFile;
        this.overrideFile = null;
        this.snapshot = loadSnapshot(false);
    }

    private static String defaultOverridePath(String dbPath) {
        File parent = new File(dbPath).getAbsoluteFile().getParentFile();
        return new File(parent, "economy.override.json").getPath();
    }

    /**
     * 디스크에서 다시 읽어 스냅샷을 갈아끼운다 (#209 무배포 운영). <b>실패해도 기존 스냅샷은 유지</b>한다 —
     * 손상된 파일 하나로 가입·뽑기가 통째로 죽는 것이 리로드 실패보다 훨씬 나쁘다(fail-safe).
     *
     * @return 갈아끼운 뒤의 스냅샷
     * @throws IllegalStateException 새 내용이 로드 불가일 때(호출자가 400 으로 매핑)
     */
    public synchronized Snapshot reload() {
        Snapshot next = loadSnapshot(true);
        if (next.economy().isEmpty() && snapshot.economy().isPresent()) {
            throw new IllegalStateException("새 economy 를 읽지 못했습니다(" + next.path()
                    + ") — 기존 설정을 유지합니다");
        }
        this.snapshot = next;
        log.info("economy reloaded: source={} path={} version={}", next.source(), next.path(),
                next.economy().map(Economy::version).orElse("-"));
        return next;
    }

    /**
     * override 파일이 있으면 그게 이긴다 — 없으면 배포에 구워진 발행물.
     *
     * <p>{@code strict} 는 <b>손상된 override 를 만났을 때의 태도</b>다. 부팅(strict=false)에서는
     * 발행물로 폴백한다 — 운영 실수 하나로 서버가 아예 못 뜨는 편이 훨씬 나쁘다. 반대로 운영자가
     * <b>명시적으로 리로드를 누른 경우</b>(strict=true)에는 폴백이 곧 <b>거짓말</b>이다: 화면에는
     * 200 이 뜨는데 방금 올린 내용은 반영되지 않은 상태가 되고, 운영자는 그걸 알 방법이 없다.
     * 그래서 그때는 실패로 알리고(400) 직전 스냅샷을 유지한다.
     */
    private Snapshot loadSnapshot(boolean strict) {
        File override = overrideFile == null ? null : new File(overrideFile);
        if (override != null && override.exists()) {
            Optional<Economy> loaded = load(objectMapper, override.getPath());
            if (loaded.isPresent()) {
                return new Snapshot(loaded, Source.OVERRIDE, override.getAbsolutePath(), Instant.now().toString());
            }
            if (strict) {
                throw new IllegalStateException("override 파일을 읽지 못했습니다("
                        + override.getAbsolutePath() + ") — 기존 설정을 유지합니다");
            }
            log.warn("economy override at {} is unreadable — falling back to the baked file",
                    override.getAbsolutePath());
        }
        File baked = new File(economyFile);
        Optional<Economy> loaded = load(objectMapper, baked.getPath());
        return new Snapshot(loaded, loaded.isPresent() ? Source.BAKED : Source.NONE,
                baked.getAbsolutePath(), Instant.now().toString());
    }

    public Snapshot snapshot() {
        return snapshot;
    }

    /**
     * 재화 표기 메타 (#232) — economy 파일이 없어도 <b>항상</b> 무언가를 돌려준다.
     * 화면·에러문구가 이 값을 그대로 쓰므로 여기서 비면 유저에게 빈 단위가 나간다.
     */
    public List<Currency> currencies() {
        return snapshot.economy().map(Economy::currencies).orElse(DEFAULT_CURRENCIES);
    }

    /** 코드({@code POINT|GEM}) → 표기 메타. 서버 에러 문구도 이걸 통해 재화 이름을 얻는다. */
    public Currency currency(String code) {
        return currencyOf(currencies(), code);
    }

    /** override 파일 경로(존재 여부와 무관). 운영 API 가 여기에 쓰고 지운다. */
    public String overridePath() {
        return overrideFile;
    }

    /** 배포에 구워진 발행물 경로 — override 를 만들 때의 기준 문서(base)다. */
    public String bakedPath() {
        return economyFile;
    }

    private static Optional<Economy> load(ObjectMapper objectMapper, String path) {
        File file = new File(path);
        if (!file.exists()) {
            log.warn("economy file not found at {} — starter pack / economy features disabled until published",
                    file.getAbsolutePath());
            return Optional.empty();
        }
        try {
            JsonNode root = objectMapper.readTree(file);
            String version = root.path("version").asText("v1");
            int initialPoints = root.path("initialPoints").asInt();
            int initialGems = root.path("initialGems").asInt(); // #212: 가입 젬 지급(구파일 없으면 0)
            List<String> starterPack = new ArrayList<>();
            root.path("starterPack").forEach(n -> starterPack.add(n.asText()));

            JsonNode g = root.path("gacha");
            Map<String, Double> rates = new LinkedHashMap<>();
            g.path("rates").properties().forEach(e -> rates.put(e.getKey(), e.getValue().asDouble()));
            Gacha gacha = new Gacha(
                    g.path("currency").asText(CURRENCY_POINT), // #212: 구파일은 POINT 폴백
                    g.path("singleCost").asInt(),
                    g.path("tenCost").asInt(),
                    g.path("tenCount").asInt(),
                    Map.copyOf(rates),
                    g.path("tenPityMinGrade").asText());

            Rewards rewards = parseRewards(root.path("rewards"));

            // trade/league 블록(economy.v2 신규) — W1 은 로드만, 구파일엔 없을 수 있어 null 로 둔다.
            JsonNode trade = root.has("trade") ? root.get("trade") : null;
            JsonNode league = root.has("league") ? root.get("league") : null;
            // league.gemReward(#212) — 없으면 null(리그 젬 지급 비활성).
            LeagueGemReward leagueGemReward = parseLeagueGemReward(league);

            // growth/star/potential/dice 블록(#179 V2-5, GM1 발행) — 구파일엔 없을 수 있어 null(성장 기능 비활성).
            Growth growth = parseGrowth(root.path("growth"));
            Star star = parseStar(root.path("star"));
            Potential potential = parsePotential(root.path("potential"));
            Dice dice = parseDice(root.path("dice"));
            // gems 블록(V2.2 재화 이원화 GM8s) — 구파일엔 없을 수 있어 null(충전 목업 기능 비활성).
            Gems gems = parseGems(root.path("gems"));
            // starterTop 블록(#209, economy.v3~) — 구파일엔 없어 null(그땐 기본팩만 지급).
            StarterTop starterTop = parseStarterTop(root.path("starterTop"));
            // currencies 블록(#232) — 없으면 기본 표기. 있으면 **필드 단위로** 기본값 위에 덮는다.
            List<Currency> currencies = parseCurrencies(root.path("currencies"));

            log.info("Loaded economy {} from {} (initialPoints={}, initialGems={}, starterPack={} players, "
                            + "gacha[{}] single/ten={}/{} tenCount={} pity>={}, rewards {}/{}/{} byMode={}, "
                            + "leagueGemReward={}, trade={}, league={}, growth={}, star={}, potential={}, "
                            + "dice={}, gems={}, starterTop={})",
                    version, file.getAbsolutePath(), initialPoints, initialGems, starterPack.size(),
                    gacha.currency(), gacha.singleCost(), gacha.tenCost(), gacha.tenCount(),
                    gacha.tenPityMinGrade(),
                    rewards.win(), rewards.draw(), rewards.loss(), rewards.byMode().keySet(),
                    leagueGemReward, trade != null ? "present" : "absent",
                    league != null ? "present" : "absent",
                    growth != null ? "present" : "absent", star != null ? "present" : "absent",
                    potential != null ? "present" : "absent", dice != null ? "present" : "absent",
                    gems != null ? "present" : "absent",
                    starterTop != null ? starterTop.pool().size() + " pool/" + starterTop.count() : "absent");
            return Optional.of(new Economy(version, initialPoints, initialGems, List.copyOf(starterPack),
                    gacha, rewards, trade, league, leagueGemReward, growth, star, potential, dice, gems,
                    starterTop, currencies));
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to load economy from {}: {} — continuing without economy config",
                    file.getAbsolutePath(), e.toString());
            return Optional.empty();
        }
    }

    /**
     * `currencies` 노드 파싱(#232) — <b>필드 단위 병합</b>이라 부분 override 가 성립한다.
     *
     * <p>운영이 심볼 하나만 바꾸고 싶을 때 {@code [{"code":"GEM","symbol":"D"}]} 만 올리면 되고,
     * 이름·아이콘·자리는 기본값이 유지된다. 통짜 교체만 지원하면 한 글자 바꾸려고 전체를 옮겨 적어야
     * 하고, 그러다 빠뜨린 필드가 빈 문자열로 화면에 나간다.
     *
     * <p>모르는 코드는 <b>버리지 않고 뒤에 붙인다</b> — 재화가 늘어날 때 서버 코드 수정 없이 실린다.
     */
    private static List<Currency> parseCurrencies(JsonNode node) {
        if (node == null || !node.isArray() || node.isEmpty()) {
            return DEFAULT_CURRENCIES;
        }
        Map<String, JsonNode> byCode = new LinkedHashMap<>();
        node.forEach(n -> {
            String code = n.path("code").asText("");
            if (!code.isBlank()) {
                byCode.put(code, n);
            }
        });
        List<Currency> merged = new ArrayList<>();
        for (Currency base : DEFAULT_CURRENCIES) {
            JsonNode over = byCode.remove(base.code());
            merged.add(over == null ? base : mergeCurrency(base, over));
        }
        // 기본값에 없던 코드 = 신규 재화. 이때는 덮을 기본값이 없으니 코드 자체가 최후 폴백이다.
        byCode.forEach((code, n) -> merged.add(
                mergeCurrency(new Currency(code, code, code, "", "suffix", " "), n)));
        return List.copyOf(merged);
    }

    private static Currency mergeCurrency(Currency base, JsonNode over) {
        return new Currency(
                base.code(),
                text(over, "symbol", base.symbol()),
                text(over, "name", base.name()),
                // icon 은 separator 와 같이 **빈 문자열이 의미 있는 값**(아이콘 끄기)이다.
                over.hasNonNull("icon") ? over.get("icon").asText() : base.icon(),
                text(over, "position", base.position()),
                // separator 는 " " 를 의미 있는 값으로 쓰므로 blank 검사를 하지 않는다(빈 문자열 = 붙여쓰기).
                over.hasNonNull("separator") ? over.get("separator").asText() : base.separator());
    }

    private static String text(JsonNode node, String field, String fallback) {
        String v = node.path(field).asText("");
        return v.isBlank() ? fallback : v;
    }

    /** `growth` 노드 파싱(V2-5) — 없으면 null(성장 기능 비활성, 부팅은 계속). */
    private static Growth parseGrowth(JsonNode g) {
        if (g == null || g.isMissingNode() || !g.isObject()) {
            return null;
        }
        Map<String, Map<String, Double>> baseline = new LinkedHashMap<>();
        g.path("baselineByPosition").properties().forEach(posEntry -> {
            Map<String, Double> weights = new LinkedHashMap<>();
            posEntry.getValue().properties().forEach(w -> weights.put(w.getKey(), w.getValue().asDouble()));
            baseline.put(posEntry.getKey(), Map.copyOf(weights));
        });
        Map<String, Map<String, Double>> eventStatMap = new LinkedHashMap<>();
        g.path("eventStatMap").properties().forEach(evEntry -> {
            Map<String, Double> weights = new LinkedHashMap<>();
            evEntry.getValue().properties().forEach(w -> weights.put(w.getKey(), w.getValue().asDouble()));
            eventStatMap.put(evEntry.getKey(), Map.copyOf(weights));
        });
        return new Growth(
                g.path("xpBase").asInt(100),
                g.path("xpLvBase").asInt(100),
                g.path("xpLvGrowth").asDouble(1.7),
                Map.copyOf(asDoubleMap(g.path("gradeXpMult"))),
                Map.copyOf(asDoubleMap(g.path("minutesMult"))),
                Map.copyOf(baseline),
                Map.copyOf(eventStatMap));
    }

    /** `star` 노드 파싱(V2-5) — 없으면 null. 키(2/3/4)는 목표 성(★) 정수. */
    private static Star parseStar(JsonNode s) {
        if (s == null || s.isMissingNode() || !s.isObject()) {
            return null;
        }
        Map<Integer, Integer> copies = new LinkedHashMap<>();
        s.path("copies").properties().forEach(e -> copies.put(Integer.parseInt(e.getKey()), e.getValue().asInt()));
        Map<Integer, Double> starFrac = new LinkedHashMap<>();
        s.path("starFrac").properties()
                .forEach(e -> starFrac.put(Integer.parseInt(e.getKey()), e.getValue().asDouble()));
        return new Star(Map.copyOf(copies), Map.copyOf(starFrac));
    }

    /** `potential` 노드 파싱(V2-5) — 없으면 null. tables[tier] = 옵션 리스트(고정 value·weight·premium). */
    private static Potential parsePotential(JsonNode p) {
        if (p == null || p.isMissingNode() || !p.isObject()) {
            return null;
        }
        Map<String, Integer> linesByGrade = new LinkedHashMap<>();
        p.path("linesByGrade").properties().forEach(e -> linesByGrade.put(e.getKey(), e.getValue().asInt()));
        Map<String, String> gradeTierCap = new LinkedHashMap<>();
        p.path("gradeTierCap").properties().forEach(e -> gradeTierCap.put(e.getKey(), e.getValue().asText()));
        Map<Integer, String> starTierCap = new LinkedHashMap<>();
        p.path("starTierCap").properties()
                .forEach(e -> starTierCap.put(Integer.parseInt(e.getKey()), e.getValue().asText()));
        Map<String, Double> tierUp = asDoubleMap(p.path("tierUp"));
        Map<String, List<PotentialOption>> tables = new LinkedHashMap<>();
        p.path("tables").properties().forEach(tierEntry -> {
            List<PotentialOption> options = new ArrayList<>();
            tierEntry.getValue().forEach(o -> options.add(new PotentialOption(
                    o.path("type").asText(),
                    o.hasNonNull("stat") ? o.path("stat").asText() : null,
                    o.path("value").asDouble(),
                    o.path("weight").asDouble(1.0),
                    o.path("premium").asBoolean(false))));
            tables.put(tierEntry.getKey(), List.copyOf(options));
        });
        return new Potential(Map.copyOf(linesByGrade), Map.copyOf(gradeTierCap), Map.copyOf(starTierCap),
                Map.copyOf(tierUp), p.path("ceilingMult").asDouble(1.5),
                p.path("cashPremiumMult").asDouble(1.0), Map.copyOf(tables));
    }

    /** `dice` 노드 파싱(V2-5, V2.2 로 cashCost→cashGemCost 개정) — 없으면 null. */
    private static Dice parseDice(JsonNode d) {
        if (d == null || d.isMissingNode() || !d.isObject()) {
            return null;
        }
        // #212: normalCost 기본값을 500 → 5000 으로 맞춘다. 구값이 남아 있으면 `dice` 블록은 있는데
        // `normalCost` 만 빠진 파일에서 **10배 싼 다이스가 조용히 팔린다**(경제 구멍).
        return new Dice(d.path("normalCost").asInt(5000), d.path("cashGemCost").asInt(10));
    }

    /**
     * `starterTop` 노드 파싱(#209) — 없거나 pool 이 비면 null(= 기본팩만 지급, 부팅은 계속).
     * count 는 pool 크기를 넘지 못하게 클램프한다(데이터 오타가 가입을 깨지 않도록).
     */
    private static StarterTop parseStarterTop(JsonNode s) {
        if (s == null || s.isMissingNode() || !s.isObject()) {
            return null;
        }
        List<String> pool = new ArrayList<>();
        s.path("pool").forEach(n -> pool.add(n.asText()));
        if (pool.isEmpty()) {
            return null;
        }
        int count = Math.max(0, Math.min(s.path("count").asInt(1), pool.size()));
        return new StarterTop(List.copyOf(pool), count);
    }

    /** `gems` 노드 파싱(V2.2 재화 이원화 GM8s) — 없으면 null(충전 목업 비활성). */
    private static Gems parseGems(JsonNode g) {
        if (g == null || g.isMissingNode() || !g.isObject()) {
            return null;
        }
        List<GemTopupPack> packs = new ArrayList<>();
        g.path("topupPacks").forEach(p -> packs.add(new GemTopupPack(
                p.path("id").asText(),
                p.path("gems").asInt(),
                p.path("mockPrice").asText())));
        // #212: 구파일(필드 없음)은 true 폴백 — 기존 동작을 조용히 바꾸지 않는다.
        return new Gems(g.path("topupEnabled").asBoolean(true), List.copyOf(packs));
    }

    /**
     * `rewards` 파싱 — flat {win,draw,loss} + 선택 `byMode`(#212). byMode 항목이 일부 키만 주면
     * 나머지는 flat 값으로 채운다(부분 오버라이드 허용).
     */
    private static Rewards parseRewards(JsonNode r) {
        int win = r.path("win").asInt();
        int draw = r.path("draw").asInt();
        int loss = r.path("loss").asInt();
        Map<String, Rewards> byMode = new LinkedHashMap<>();
        JsonNode modes = r.path("byMode");
        if (modes.isObject()) {
            modes.properties().forEach(e -> {
                JsonNode m = e.getValue();
                byMode.put(e.getKey(), new Rewards(
                        m.path("win").asInt(win), m.path("draw").asInt(draw), m.path("loss").asInt(loss),
                        Map.of()));
            });
        }
        return new Rewards(win, draw, loss, Map.copyOf(byMode));
    }

    /** `league.gemReward` 파싱(#212) — 블록이 없거나 max&lt;min 이면 null(비활성). */
    private static LeagueGemReward parseLeagueGemReward(JsonNode league) {
        if (league == null || !league.path("gemReward").isObject()) {
            return null;
        }
        JsonNode n = league.path("gemReward");
        int maxRank = n.path("maxRank").asInt();
        int min = n.path("min").asInt();
        int max = n.path("max").asInt();
        if (maxRank < 1 || min < 0 || max < min) {
            log.warn("league.gemReward 값이 유효하지 않아 비활성화한다: maxRank={} min={} max={}",
                    maxRank, min, max);
            return null;
        }
        return new LeagueGemReward(maxRank, min, max);
    }

    private static Map<String, Double> asDoubleMap(JsonNode node) {
        Map<String, Double> out = new LinkedHashMap<>();
        if (node != null && node.isObject()) {
            node.properties().forEach(e -> out.put(e.getKey(), e.getValue().asDouble()));
        }
        return out;
    }

    /** 현재 유효한 경제 설정. 소비자(가입·뽑기·성장…)는 출처를 알 필요가 없다. */
    public Optional<Economy> get() {
        return snapshot.economy();
    }
}
