package online.hmb.meta;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * 지급 덱 배치 계약 (#209 AC2).
 *
 * <p>핵심은 <b>"압도적인 최상위 1장이 남의 자리를 뺏지 않는다"</b>이다. 첫 구현(슬롯 순차 그리디)은
 * LEGEND 의 overall 이 워낙 높아 포지션 감점을 먹고도 앞 라인 슬롯을 이겼고, 지급된 FW/MF 가
 * <b>센터백으로</b> 서고 진짜 수비수가 벤치로 밀렸다(독립검증 실측). 그 회귀를 여기서 박제한다.
 */
class StarterDeckBuilderTest {

    /** 기본팩 미러 — GK1/DF5/MF5/FW3, 전원 평범한 능력치. */
    private static List<StarterDeckBuilder.OwnedPlayer> basics() {
        List<StarterDeckBuilder.OwnedPlayer> owned = new ArrayList<>();
        owned.add(new StarterDeckBuilder.OwnedPlayer("B01", "GK", 60));
        for (int i = 0; i < 5; i++) {
            owned.add(new StarterDeckBuilder.OwnedPlayer("B1" + i, "DF", 62));
        }
        for (int i = 0; i < 5; i++) {
            owned.add(new StarterDeckBuilder.OwnedPlayer("B2" + i, "MF", 61));
        }
        for (int i = 0; i < 3; i++) {
            owned.add(new StarterDeckBuilder.OwnedPlayer("B3" + i, "FW", 63));
        }
        return owned;
    }

    private static Map<Integer, String> starterSlots(List<DeckService.SlotDto> deck) {
        return deck.stream()
                .filter(s -> DeckService.ROLE_STARTER.equals(s.role()))
                .collect(Collectors.toMap(DeckService.SlotDto::slotIndex, DeckService.SlotDto::playerId));
    }

    @Test
    void topUnitIsPlacedInItsOwnPosition_forEveryPosition() {
        for (String position : List.of("GK", "DF", "MF", "FW")) {
            List<StarterDeckBuilder.OwnedPlayer> owned = basics();
            // 최상위 1장 — 기본팩보다 압도적으로 강하다(실데이터 LEGEND 93 vs SILVER 62 재현).
            owned.add(new StarterDeckBuilder.OwnedPlayer("TOP", position, 93));

            List<DeckService.SlotDto> deck = StarterDeckBuilder.build(owned, "4-3-3", 7);
            Map<Integer, String> starters = starterSlots(deck);
            int slot = starters.entrySet().stream()
                    .filter(e -> "TOP".equals(e.getValue()))
                    .map(Map.Entry::getKey)
                    .findFirst()
                    .orElseThrow(() -> new AssertionError(position + " 최상위가 선발에 없다"));

            assertThat(StarterDeckBuilder.slotsOf("4-3-3").get(slot))
                    .as(position + " 최상위는 자기 포지션 슬롯에 선다 (slot " + slot + ")")
                    .isEqualTo(position);
        }
    }

    @Test
    void everyStarterSlotGetsItsOwnPositionWhenStockAllows() {
        List<StarterDeckBuilder.OwnedPlayer> owned = basics();
        owned.add(new StarterDeckBuilder.OwnedPlayer("TOP", "FW", 93));
        Map<Integer, String> starters = starterSlots(StarterDeckBuilder.build(owned, "4-3-3", 7));
        Map<String, String> positionOf = owned.stream()
                .collect(Collectors.toMap(StarterDeckBuilder.OwnedPlayer::id,
                        StarterDeckBuilder.OwnedPlayer::position));

        List<String> layout = StarterDeckBuilder.slotsOf("4-3-3");
        for (int slot = 0; slot < layout.size(); slot++) {
            assertThat(positionOf.get(starters.get(slot)))
                    .as("slot " + slot + " (" + layout.get(slot) + ") 겸업 없음")
                    .isEqualTo(layout.get(slot));
        }
        // 남는 정포지션 수비수가 벤치로 밀리지 않는지 = 선발 11 + 벤치 4(15명 보유).
        assertThat(starters).hasSize(11);
    }

    @Test
    void fillsShortPositionsWithTheBestAvailable() {
        // FW 재고 0 — 겸업이 필요한 상황. 1패스가 못 채운 자리를 2패스가 적합도로 메운다.
        List<StarterDeckBuilder.OwnedPlayer> owned = new ArrayList<>();
        owned.add(new StarterDeckBuilder.OwnedPlayer("B01", "GK", 60));
        for (int i = 0; i < 5; i++) {
            owned.add(new StarterDeckBuilder.OwnedPlayer("B1" + i, "DF", 62));
        }
        for (int i = 0; i < 8; i++) {
            owned.add(new StarterDeckBuilder.OwnedPlayer("B2" + i, "MF", 61));
        }

        Map<Integer, String> starters = starterSlots(StarterDeckBuilder.build(owned, "4-3-3", 7));
        assertThat(starters).hasSize(11);
        // GK 는 여전히 진짜 GK — 겸업 페널티가 가장 큰 자리라 마지막까지 지켜진다.
        assertThat(starters.get(0)).isEqualTo("B01");
        // FW 슬롯은 MF 가 메운다(GK 를 끌어다 쓰지 않는다).
        assertThat(starters.get(8)).startsWith("B2");
    }

    @Test
    void isDeterministic() {
        List<StarterDeckBuilder.OwnedPlayer> owned = basics();
        owned.add(new StarterDeckBuilder.OwnedPlayer("TOP", "MF", 93));
        List<DeckService.SlotDto> first = StarterDeckBuilder.build(owned, "4-3-3", 7);
        for (int i = 0; i < 20; i++) {
            assertThat(StarterDeckBuilder.build(owned, "4-3-3", 7)).isEqualTo(first);
        }
    }

    @Test
    void refusesToBuildWhenThereAreNotEnoughPlayersOrTheFormationIsUnknown() {
        List<StarterDeckBuilder.OwnedPlayer> tooFew = basics().subList(0, 10);
        assertThat(StarterDeckBuilder.build(tooFew, "4-3-3", 7)).isEmpty();
        assertThat(StarterDeckBuilder.build(basics(), "3-5-2", 7)).isEmpty();
        assertThat(StarterDeckBuilder.supportsFormation("3-5-2")).isFalse();
        assertThat(StarterDeckBuilder.supportsFormation("4-4-2")).isTrue();
    }

    @Test
    void benchTakesTheBestLeftoversUpToTheCap() {
        List<StarterDeckBuilder.OwnedPlayer> owned = basics();
        owned.add(new StarterDeckBuilder.OwnedPlayer("TOP", "MF", 93));
        List<DeckService.SlotDto> deck = StarterDeckBuilder.build(owned, "4-3-3", 2);
        List<DeckService.SlotDto> bench = deck.stream()
                .filter(s -> DeckService.ROLE_BENCH.equals(s.role())).toList();

        assertThat(bench).hasSize(2);   // 상한이 잘린다
        assertThat(bench.stream().map(DeckService.SlotDto::slotIndex)).containsExactly(0, 1);
        // 벤치도 선발과 겹치지 않는다.
        List<String> starters = deck.stream()
                .filter(s -> DeckService.ROLE_STARTER.equals(s.role()))
                .map(DeckService.SlotDto::playerId).toList();
        assertThat(bench.stream().map(DeckService.SlotDto::playerId)).doesNotContainAnyElementsOf(starters);
    }
}
