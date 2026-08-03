package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * <b>남에게 보이는 선수 카드</b>의 형태를 <b>한 곳</b>에서 얼린다 — {@code /api/users/{id}/squad} 의
 * 슬롯과 {@code MatchDetail.opponent.deck[]} 은 같은 것(hero 결정 ③ 공개 범위)을 그리는 두 표면이다.
 * 상수를 각자 두면 <b>한쪽만 갱신되는 드리프트</b>가 생기고, 그 순간 한 표면이 조용히 넓어진다.
 *
 * <p><b>왜 "정확집합"이어야 하나</b>: 누설 계약의 다른 겹(센티넬 문자열 대조)은 <b>문자열 축만</b>
 * 지킨다. hero A안 비공개 4축 중 <b>컨디션·팀 전술은 숫자</b>라 어떤 문자열 대조에도 안 걸린다.
 * 독립검증이 두 번 연속 이 사각으로 뚫었다:
 * <ol>
 *   <li>1R — 슬롯 record 에 {@code condition} 필드를 더했더니 전 계약 green.</li>
 *   <li>2R — 필드 이름을 얼렸더니 이번엔 <b>{@code attributes} 맵 안에</b>
 *       {@code attributes.put("condition", …)} 로 들어와 또 green. 맵의 키가 자유였고, 심지어
 *       {@code size() >= 9} 라고 적혀 있어 <b>여분 키를 명시적으로 허용</b>하고 있었다.</li>
 * </ol>
 * 그래서 <b>바깥 키 + 맵 안쪽 키 + 값의 모양</b>까지 전부 얼린다. {@code attributes} 는 다음 additive
 * 필드가 가장 앉기 쉬운 자리다("능력치 옆에 컨디션도 같이 주자").
 *
 * <p>⚠️ <b>능력치가 하나 늘면 이 계약은 깨진다 — 그게 의도다.</b> 유저 대면 응답에 새 키가 생기는
 * 것은 <b>비공개 범위에 비춰 검토돼야 할 결정</b>이지 조용히 통과할 일이 아니다. 깨졌다면 "낡은
 * 테스트"가 아니라 <b>검토 요청</b>으로 읽고, 그 키가 공개 범위 안인지 판단한 뒤 여기를 고쳐라
 * ({@code MatchService.toDetailFor} 의 "지울 것을 열거하지 않고 허용할 것을 열거한다"와 같은 규율).
 *
 * <p>버린 대안: <b>"카탈로그 능력치 이름의 부분집합"</b> 으로 걸면 스탯이 늘 때 자동으로 따라가지만,
 * <b>새 능력치가 아무 검토 없이 유저 응답에 실린다</b> — 자동 갱신은 편의지 계약이 아니다.
 *
 * <p><b>이 계약의 한계(알고 수용한 것)</b>: 이것은 <b>형태(shape)를 얼리지 값의 의미(semantics)를
 * 얼리지 않는다</b>. 정당한 키·정당한 스칼라 자리에 <b>다른 뜻</b>을 실어 보내는 것은 못 막는다 —
 * 독립검증이 눈금까지 쟀다: {@code ovr} 의 하위 소수에 컨디션을 숨기거나(예 {@code + cond/1000}),
 * 컨디션을 {@code stamina} 같은 정당한 능력치 이름으로 위장해 <b>핀 안 된 슬롯에만</b> 싣는 경로가
 * 남는다. 다만 {@code /api/growth/card} 와의 <b>OVR 교차대조가 은닉 대역폭을 ±0.01 로 묶고</b>,
 * 전 슬롯에 위장하면 그 교차대조에 걸린다. 이걸 마저 막으려면 13슬롯 × 9능력치 전 값을 독립
 * 소스로 핀해야 하는데 그건 계약이 아니라 <b>응답 복제본</b>이고 정당한 성장 변화마다 깨진다.
 * 남은 둘은 <b>실수로 쓰는 코드가 아니라 의도적 스테가노그래피</b>다. 이 계약이 죽여야 할 것은
 * {@code attributes.put("condition", …)} 처럼 <b>실수로 쓰기 쉬운 형태</b>이고, 그건 전부 죽는다.
 */
final class PublicCardContract {

    private PublicCardContract() {
    }

    /**
     * 공개 능력치 9종 — <b>정확집합</b>. SoT 는 {@code GrowthTuning.STATS}(= shared PlayerAttributes)이나
     * 여기서는 <b>일부러 값을 적어 둔다</b>: 프로덕션 상수를 그대로 읽으면 그 목록이 늘어날 때 계약이
     * 같이 늘어나 "검토 없이 통과"가 된다.
     */
    static final Set<String> ATTRIBUTE_KEYS = Set.of(
            "technical", "mental", "physical", "passing", "shooting",
            "tackling", "pace", "stamina", "positioning");

    /** {@code /api/users/{targetUserId}/squad} 슬롯 1인. */
    static final Set<String> SQUAD_SLOT_KEYS = Set.of(
            "playerId", "role", "slotIndex", "name", "position", "grade",
            "star", "ovr", "attributes", "hasPrompt");

    /** {@code MatchDetail.opponent.deck[]} 1인 — 슬롯에서 덱 배치(role·slotIndex)만 빠진다. */
    static final Set<String> OPPONENT_PLAYER_KEYS = Set.of(
            "playerId", "name", "position", "grade", "star", "ovr", "attributes", "hasPrompt");

    static Set<String> keysOf(JsonNode node) {
        Set<String> keys = new LinkedHashSet<>();
        node.fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    /**
     * 공개 카드 1인의 형태를 통째로 단언한다: 바깥 키 정확집합 · {@code attributes} 키 정확집합 ·
     * <b>값의 모양</b>까지.
     *
     * <p>값 모양을 왜 보나: 키를 얼려도 <b>값 자리에 객체·배열을 넣으면</b> 그 안은 다시 자유다
     * ({@code "attributes": {"pace": {"v": 82, "condition": 0.7}}} 같은 모양). 스칼라만 허용하면
     * 그 경로가 닫힌다.
     */
    static void assertPublicCardShape(JsonNode player, Set<String> allowedKeys) {
        assertThat(keysOf(player))
                .as("공개 카드의 키를 얼린다(새 필드는 기본 차단) — %s", player)
                .isEqualTo(allowedKeys);

        JsonNode attributes = player.path("attributes");
        assertThat(keysOf(attributes))
                .as("능력치 맵 **안쪽**까지 얼린다 — 컨디션이 여기로 들어오는 것이 2R 실증 경로였다")
                .isEqualTo(ATTRIBUTE_KEYS);

        attributes.properties().forEach(e -> assertThat(e.getValue().isNumber())
                .as("능력치 값은 수 하나다(객체·배열이면 그 안이 다시 자유가 된다): %s", e)
                .isTrue());

        player.properties().forEach(e -> {
            if (!"attributes".equals(e.getKey())) {
                // ⚠️ {@code isValueNode()} 만으로는 부족하다 — Jackson {@code NullNode} 도 스칼라다.
                //    그래서 {@code "name": null} 이 통과했다(3R minor-1). 누설이 아니라 **표시 결함**
                //    축이지만("이름 없는 카드"를 그린다), 계약이 "값이 있다"고 말하는 이상 값은 있어야 한다.
                assertThat(e.getValue().isValueNode() && !e.getValue().isNull())
                        .as("공개 카드 필드 값은 **비어 있지 않은** 스칼라다 — 중첩·null 을 허용하면"
                                + " 키 동결이 무의미해진다: %s", e)
                        .isTrue();
            }
        });
    }

    /**
     * <b>OVR 은 소수다</b>(#432 정정 코멘트 #2 — pstat 이 그 전제로 반올림한다).
     *
     * <p>정수로 절단하는 변경({@code (int) ovr})을 잡는 유일한 축이다. "&gt; 0" 같은 단언은 절단을
     * 통과시킨다.
     *
     * <p>⚠️ 표본을 <b>스캔해서 고르지 마라</b>("소수인 항목이 하나라도 있으면 통과"는 전부 정수가 된
     * 순간 조용한 항진명제가 된다). 특정 선수를 <b>핀</b>하고, 그 값이 정수가 되면 <b>계약이 실패해서
     * 알린다</b> — 그때는 표본을 다시 고를 일이지 계약을 지울 일이 아니다.
     */
    static void assertOvrKeepsItsFraction(double ovr, String where) {
        assertThat(ovr)
                .as("%s 의 OVR 은 소수여야 한다(정수 절단 금지 — 계약 스키마 #432 #2). 실측 %s",
                        where, ovr)
                .isNotEqualTo(Math.rint(ovr));
    }
}
