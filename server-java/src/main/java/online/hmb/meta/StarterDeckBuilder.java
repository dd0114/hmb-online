package online.hmb.meta;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.TreeMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 보유 선수만으로 <b>기본 덱 1개</b>를 짜는 순수 로직 (#209 AC2 — 튜토리얼 완료 지급용).
 *
 * <p><b>왜 서버에 또 있나</b>: web 의 "Auto 구성"(`apps/web/src/deck/auto-lineup.ts`)은 유저가
 * 편집기에서 누르는 기능이라 브라우저 안에서만 산다. 여기서 필요한 것은 유저가 화면을 열기 전에
 * 서버가 지급해 두는 덱이다(도메인 경계상 서버가 web 코드를 부를 수 없다). 대신 <b>기준은 같은
 * 계보</b>를 쓴다 — 능력치 평균(overall) × 포지션 적합 가중, 동점은 playerId 사전순.
 *
 * <p>web 판은 헝가리안으로 전역 최적을 보장하지만 여기서는 <b>정포지션 우선 2패스 그리디</b>다:
 * 지급 덱은 "바로 뛸 수 있는 정상 스쿼드"면 충분하고, 더 좋은 배치를 원하면 유저가 덱 화면에서
 * Auto 구성을 다시 돌리면 된다(그 경로가 전역 최적을 준다). 그리디라도 <b>결정론</b>은 동일하게
 * 지킨다 — RNG·시계 의존 0, 같은 입력이면 항상 같은 덱.
 */
final class StarterDeckBuilder {

    /** 정포지션 일치 가중(= auto-lineup EXACT_WEIGHT). */
    private static final double EXACT_WEIGHT = 1.0;
    /** GK↔필드 교차 가중 — GK 역할은 비교환적이라 큰 감점(= auto-lineup GK_CROSS_WEIGHT). */
    private static final double GK_CROSS_WEIGHT = 0.2;
    /** 필드 포지션 rank 1칸 차이당 감점. */
    private static final double STEP_PENALTY = 0.15;
    /** 필드 포지션 불일치 가중 하한. */
    private static final double MIN_OUTFIELD_WEIGHT = 0.2;

    private static final Map<String, Integer> POSITION_RANK =
            Map.of("GK", 0, "DF", 1, "MF", 2, "FW", 3);

    /**
     * 포메이션별 선발 슬롯 배치(= web `deck-logic.FORMATION_LAYOUTS`, 엔진 `config.formations` 순서와 동일).
     * 인덱스 = slot_index, 값 = 그 슬롯의 역할 포지션.
     */
    private static final Map<String, List<String>> FORMATION_SLOTS = Map.of(
            "4-3-3", List.of("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW"),
            "4-4-2", List.of("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"));

    private StarterDeckBuilder() {
    }

    /** 보유 카드 1장 — 배치에 필요한 최소 정보. */
    record OwnedPlayer(String id, String position, double overall) {
    }

    static boolean supportsFormation(String formation) {
        return FORMATION_SLOTS.containsKey(formation);
    }

    /** 지원 포메이션 목록(부팅 검증 메시지용). */
    static Set<String> supportedFormations() {
        return FORMATION_SLOTS.keySet();
    }

    /** 그 포메이션이 요구하는 선발 인원(항상 11). 미지원 포메이션이면 빈 목록. */
    static List<String> slotsOf(String formation) {
        return FORMATION_SLOTS.getOrDefault(formation, List.of());
    }

    /**
     * 선발 11 + 벤치(최대 {@code benchMax})를 배치해 슬롯 목록을 만든다.
     * 보유 인원이 11명 미만이면 빈 목록(= 지급 불가 — 호출자가 건너뛴다).
     */
    static List<DeckService.SlotDto> build(List<OwnedPlayer> owned, String formation, int benchMax) {
        List<String> slots = slotsOf(formation);
        if (slots.isEmpty() || owned.size() < slots.size()) {
            return List.of();
        }

        // 후보 정렬을 먼저 고정한다 — 동점 tie-break(playerId 사전순)이 여기서 결정된다.
        List<OwnedPlayer> pool = new ArrayList<>(owned);
        pool.sort(Comparator.comparing(OwnedPlayer::id));

        // TreeMap = slotIndex 오름차순 — 2패스로 채워도 출력 순서가 슬롯 순서로 고정된다(결정론).
        Map<Integer, OwnedPlayer> assigned = new TreeMap<>();
        Set<String> taken = new HashSet<>();

        /*
         * 2패스로 채운다. 1패스는 **정포지션 후보만** 보고, 남은 자리를 2패스가 적합도로 메운다.
         *
         * 슬롯 순서대로 한 번에 훑는 그리디였을 때 실제로 이런 일이 났다: LEGEND 의 overall 이
         * SILVER 보다 30 가까이 높아서 포지션 감점(0.7~0.85)을 먹고도 앞 라인의 DF 슬롯을 이겼고,
         * 지급된 펠레(FW)·마라도나(MF)가 **센터백으로** 서고 진짜 수비수가 벤치로 밀렸다
         * (독립검증 실측: pool 4명 중 2명). 지급 덱의 첫인상이 그 그림이면 곤란하다.
         * 정포지션을 먼저 확정하면 최상위는 자기 자리에 서고, 그래도 남는 슬롯에서만 겸업이 생긴다.
         */
        for (int pass = 0; pass < 2; pass++) {
            boolean exactOnly = pass == 0;
            for (int slotIndex = 0; slotIndex < slots.size(); slotIndex++) {
                if (assigned.containsKey(slotIndex)) {
                    continue;
                }
                String want = slots.get(slotIndex);
                OwnedPlayer best = null;
                double bestFit = Double.NEGATIVE_INFINITY;
                for (OwnedPlayer p : pool) {
                    if (taken.contains(p.id()) || (exactOnly && !p.position().equals(want))) {
                        continue;
                    }
                    double fit = fit(p, want);
                    if (fit > bestFit) {   // > 라서 동점이면 먼저 온 후보(=playerId 사전순 앞)가 남는다
                        bestFit = fit;
                        best = p;
                    }
                }
                if (best == null) {
                    if (exactOnly) {
                        continue;   // 그 포지션 재고 소진 — 2패스에서 겸업으로 메운다
                    }
                    return List.of();
                }
                assigned.put(slotIndex, best);
                taken.add(best.id());
            }
        }

        List<DeckService.SlotDto> result = new ArrayList<>();
        assigned.forEach((slotIndex, player) ->
                result.add(new DeckService.SlotDto(player.id(), DeckService.ROLE_STARTER, slotIndex, null)));

        // 벤치: 남은 보유 선수를 overall 내림차순(동점 playerId 오름차순)으로 상한까지.
        List<OwnedPlayer> rest = new ArrayList<>(pool.stream().filter(p -> !taken.contains(p.id())).toList());
        rest.sort(Comparator.comparingDouble(OwnedPlayer::overall).reversed()
                .thenComparing(OwnedPlayer::id));
        for (int i = 0; i < Math.min(benchMax, rest.size()); i++) {
            result.add(new DeckService.SlotDto(rest.get(i).id(), DeckService.ROLE_BENCH, i, null));
        }
        return List.copyOf(result);
    }

    /** 적합도 = overall × 포지션 가중(= auto-lineup 의 fit). */
    private static double fit(OwnedPlayer player, String slotPosition) {
        return player.overall() * positionWeight(player.position(), slotPosition);
    }

    private static double positionWeight(String from, String to) {
        if (from.equals(to)) {
            return EXACT_WEIGHT;
        }
        if ("GK".equals(from) || "GK".equals(to)) {
            return GK_CROSS_WEIGHT;
        }
        int distance = Math.abs(POSITION_RANK.getOrDefault(from, 0) - POSITION_RANK.getOrDefault(to, 0));
        return Math.max(MIN_OUTFIELD_WEIGHT, EXACT_WEIGHT - STEP_PENALTY * distance);
    }
}
