package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import online.hmb.growth.GrowthCandidates;
import online.hmb.growth.GrowthMath;
import online.hmb.growth.GrowthTuning;
import org.junit.jupiter.api.Test;

/**
 * <b>확정 판정 기준의 회귀 가드</b>(#405 BL-1) — 에픽의 헤드라인 목표("2단계 역전")를 <b>서버가 실제로
 * 하는 일 그대로</b> 잰다.
 *
 * <p><b>기준 네 가지가 전부 "실물"이다</b>:
 * <ol>
 *   <li><b>발행물 실측</b> — {@code application.yml} 이 가리키는 그 {@code players.v*.json} 을 읽는다
 *       (밴드 중앙 같은 대용값이 아니다. 실제 카드는 주스탯·trait 바이어스를 갖고 있고 그게 마진을
 *       바꾼다).</li>
 *   <li><b>실제 3지선다 추첨</b> — 매 레벨 {@link GrowthCandidates#draw} 를 그대로 호출한다.
 *       "핵심 4스탯 균등 배분" 같은 <b>배분 가정을 세우지 않는다</b>.</li>
 *   <li><b>OVR 최선 선택</b> — 뽑힌 3개 중 <b>1번</b>을 고른다. 서버가 이미
 *       {@code positionBaseline × gain} 내림차순으로 정렬해 내리므로(#405 W3c) 1번이 곧 OVR 최선이고,
 *       그것이 <b>이 목표의 성립 전제</b>다({@link #theTargetOnlyHoldsForOvrFirstPicking} 참조).</li>
 *   <li><b>OVR 로 비교</b> — 게임이 전력으로 쓰는 축이다.</li>
 * </ol>
 *
 * <p><b>왜 이 계약이 따로 필요한가</b>: {@code GrowthProgressionContractTest} 는 밴드 중앙 + 배분
 * 가정으로 재는 <b>구조 가드</b>라, 가장 타이트한 쌍의 마진이 얇을 때 <b>초록인 채로 헤드라인 목표가
 * 뒤집힐 수</b> 있다. 확정 기준에는 자기 가드가 있어야 한다.
 *
 * <p>⚠️ <b>자기참조 금지</b>: 기대값을 {@link GrowthTuning} 에서 다시 읽지 않는다. 전부 부등식이다.
 */
class GrowthShippedProgressionTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final GrowthTuning TUNING = GrowthTuning.CODE_DEFAULTS;

    /**
     * 시드 표본 수. 추첨이 걸린 계약이라 단일 시드는 운을 계약이라고 부르는 것과 같다 —
     * 카드마다 서로 다른 시드 계열 {@code N} 개를 돌려 평균낸다(등급당 카드 36장 × 5 = 표본 180).
     * 줄이면 등급 평균이 추첨 운에 흔들린다.
     */
    private static final int SEED_SAMPLES = 5;

    // ── 확정 기준: 세 쌍 전부 역전 ────────────────────────────────────────

    @Test
    void aMaxedCardBeatsAnUngrownCardTwoGradesAboveOnTheShippedRoster() {
        Roster roster = Roster.load();
        Map<String, Double> ungrown = roster.ungrownOvrByGrade();
        Map<String, Double> grown = roster.grownOvrByGrade(TUNING, Pick.OVR_FIRST);

        for (int i = 0; i + 2 < GrowthTuning.GRADES.size(); i++) {
            String lower = GrowthTuning.GRADES.get(i);
            String twoUp = GrowthTuning.GRADES.get(i + 2);
            assertThat(grown.get(lower))
                    .as("%s 만렙(발행물 실측 · 실제 추첨 · OVR 최선)이 미성장 %s 를 못 이긴다 "
                            + "— grown %.2f vs ungrown %.2f. 에픽의 헤드라인 목표가 뒤집혔다.",
                            lower, twoUp, grown.get(lower), ungrown.get(twoUp))
                    .isGreaterThan(ungrown.get(twoUp));
        }
    }

    /** 역전 폭은 위로 갈수록 좁아진다 — 사다리가 평평해지거나 뒤집히면 여기서 걸린다. */
    @Test
    void theUpsetMarginNarrowsTowardTheTopOfTheLadder() {
        Roster roster = Roster.load();
        Map<String, Double> ungrown = roster.ungrownOvrByGrade();
        Map<String, Double> grown = roster.grownOvrByGrade(TUNING, Pick.OVR_FIRST);
        double bronze = grown.get("BRONZE") - ungrown.get("GOLD");
        double silver = grown.get("SILVER") - ungrown.get("DIA");
        double gold = grown.get("GOLD") - ungrown.get("LEGEND");
        assertThat(bronze).isGreaterThan(silver);
        assertThat(silver).isGreaterThan(gold);
    }

    /**
     * <b>성립 전제를 정확히 적어 둔다</b>: 이 목표는 <b>"매 레벨 OVR 최선을 고른다"</b>는 전제에서만
     * 성립한다. 화면이 유도하기 쉬운 <b>gain 최대</b> 선택으로는 가장 타이트한 쌍이 <b>뒤집힌다</b>
     * (감쇠 곡선상 gain 이 큰 쪽은 낮은 스탯이라 OVR 기여가 작다).
     *
     * <p>그래서 서버가 후보를 OVR 기여 내림차순으로 <b>정렬해서</b> 내리고 `core` 배지를 붙인다
     * (#405 W3c) — 그 UX 가 이 계약의 전제를 실제로 지탱하는 장치다. 정렬을 되돌리면 이 테스트는
     * 통과한 채로 <b>게임이 목표를 잃는다</b>는 사실이 여기 적혀 있다.
     */
    @Test
    void theTargetOnlyHoldsForOvrFirstPicking() {
        Roster roster = Roster.load();
        Map<String, Double> ungrown = roster.ungrownOvrByGrade();
        Map<String, Double> best = roster.grownOvrByGrade(TUNING, Pick.OVR_FIRST);
        Map<String, Double> byGain = roster.grownOvrByGrade(TUNING, Pick.MAX_GAIN);

        assertThat(byGain.get("GOLD"))
                .as("gain 최대 선택이 OVR 최선보다 좋아졌다 — 정렬·핵심 배지 UX 의 존재 이유가 사라진다")
                .isLessThan(best.get("GOLD"));
        assertThat(byGain.get("GOLD") - ungrown.get("LEGEND"))
                .as("gain 최대 선택으로도 G>L 이 성립한다면 이 '전제' 기록을 지워라(목표가 더 튼튼해진 것)")
                .isLessThan(0.0);
    }

    // ── 계산기 ──────────────────────────────────────────────────────────

    /** 매 레벨 무엇을 고르는가. */
    private enum Pick { OVR_FIRST, MAX_GAIN }

    /**
     * 발행물 로스터. <b>경로를 코드에 박지 않고</b> {@code application.yml} 이 가리키는 파일을 읽는다 —
     * 그래야 data 가 새 버전을 발행하고 서버가 그걸 로드하는 순간 이 계약도 <b>그 로스터</b>를 잰다
     * (박아 두면 계약만 옛 발행물을 재며 초록이 된다).
     */
    private record Roster(List<Card> cards) {

        record Card(String id, String grade, String position, Map<String, Double> attributes) {
        }

        static Roster load() {
            Path path = playersFile();
            try {
                JsonNode root = MAPPER.readTree(Files.readString(path));
                JsonNode array = root.isArray() ? root : root.get("players");
                List<Card> cards = new ArrayList<>();
                for (JsonNode node : array) {
                    Map<String, Double> attributes = new LinkedHashMap<>();
                    for (String stat : GrowthTuning.STATS) {
                        attributes.put(stat, node.get("attributes").get(stat).asDouble());
                    }
                    cards.add(new Card(node.get("id").asText(), node.get("grade").asText(),
                            node.get("position").asText(), attributes));
                }
                assertThat(cards).as("발행물이 비면 이 계약이 공허해진다").isNotEmpty();
                return new Roster(cards);
            } catch (IOException e) {
                throw new IllegalStateException("발행물을 읽지 못했다: " + path.toAbsolutePath(), e);
            }
        }

        private static Path playersFile() {
            try {
                String yml = Files.readString(Path.of("src/main/resources/application.yml"));
                Matcher m = Pattern.compile("players-file:\\s*(\\S+)").matcher(yml);
                assertThat(m.find()).as("application.yml 에서 players-file 을 찾지 못했다").isTrue();
                return Path.of(m.group(1));
            } catch (IOException e) {
                throw new IllegalStateException("application.yml 을 읽지 못했다", e);
            }
        }

        Map<String, Double> ungrownOvrByGrade() {
            Map<String, List<Double>> byGrade = new LinkedHashMap<>();
            for (Card card : cards) {
                byGrade.computeIfAbsent(card.grade(), k -> new ArrayList<>())
                        .add(ovr(card.attributes(), card.position()));
            }
            return means(byGrade);
        }

        Map<String, Double> grownOvrByGrade(GrowthTuning tuning, Pick pick) {
            Map<String, List<Double>> byGrade = new LinkedHashMap<>();
            for (Card card : cards) {
                for (int sample = 0; sample < SEED_SAMPLES; sample++) {
                    byGrade.computeIfAbsent(card.grade(), k -> new ArrayList<>())
                            .add(ovr(growToMaxLevel(tuning, card, sample, pick), card.position()));
                }
            }
            return means(byGrade);
        }

        /**
         * 만렙까지 키운다 — 매 레벨 <b>실제 추첨</b> 후 {@code pick} 규칙으로 하나 고른다.
         *
         * <p>매치 컨텍스트(이벤트·behavior·승패)는 <b>비운다</b>. 소급 지급과 같은 중립 조건이고,
         * 활약·역할 가중이 유리하게 실렸다고 가정하지 않는 <b>보수적</b> 표본이다.
         */
        private static Map<String, Double> growToMaxLevel(GrowthTuning tuning, Card card, int sample,
                                                          Pick pick) {
            Map<String, Double> current = new LinkedHashMap<>(card.attributes());
            double ceiling = GrowthMath.ceiling(tuning, card.grade(), 1);   // 1★ — 승급 없이 성립해야 한다
            for (int level = 1; level <= tuning.xp().maxLevel() - 1; level++) {
                String seed = GrowthCandidates.seed("shipped-progression-" + sample,
                        "sample" + sample, card.id(), level);
                GrowthCandidates.Draw draw = GrowthCandidates.draw(tuning, seed, card.position(),
                        card.grade(), 1, current, Map.of(), Map.of(), null, level,
                        GrowthCandidates.Evidence.ofLegacy());
                if (draw.choices().isEmpty()) {
                    break;   // 전 스탯 천장
                }
                GrowthCandidates.Choice chosen = switch (pick) {
                    // 서버가 OVR 기여 내림차순으로 정렬해 내린다 → 1번이 곧 OVR 최선이다.
                    case OVR_FIRST -> draw.choices().get(0);
                    case MAX_GAIN -> draw.choices().stream()
                            .max(java.util.Comparator.comparingDouble(GrowthCandidates.Choice::gain))
                            .orElseThrow();
                };
                current.put(chosen.stat(), Math.min(ceiling, current.get(chosen.stat()) + chosen.gain()));
            }
            return current;
        }

        private static double ovr(Map<String, Double> attributes, String position) {
            Map<String, Double> baseline = TUNING.positionBaseline().getOrDefault(position, Map.of());
            return attributes.entrySet().stream()
                    .mapToDouble(e -> e.getValue() * baseline.getOrDefault(e.getKey(), 0.0))
                    .sum();
        }

        private static Map<String, Double> means(Map<String, List<Double>> byGrade) {
            Map<String, Double> out = new LinkedHashMap<>();
            byGrade.forEach((grade, values) ->
                    out.put(grade, values.stream().mapToDouble(Double::doubleValue).average().orElseThrow()));
            return out;
        }
    }
}
