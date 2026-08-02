// @vitest-environment jsdom
/**
 * `PlayerAvatar` 의 **이름 사다리** 계약 (#406 W1c — 4차 독립검증 MAJOR-1 의 셋 중 하나).
 *
 * <p>W1b 가 이 파일을 초크포인트(`playerNameOf`)로 옮겼는데 <b>계약이 하나도 없었다</b> —
 * `player.name` 직독으로 되돌리는 변이가 <b>전 스위트 1691건을 통과</b>했다. 스캐너
 * (`common/player-names.test.ts`)도 못 잡는다: 이 파일엔 <b>조회가 없고</b>(행을 프롭으로 받는다)
 * `player.name` 은 그냥 프롭 접근이라 걸릴 것이 없다(스캐너 머리말 "파일을 넘는 프롭").
 * <b>그래서 여기에 직접 박는다</b>(선례 = `trade/TradePlayerCard.names.test.ts`).
 *
 * <h3>무엇이 계약인가</h3>
 * <ol>
 *   <li><b>사다리</b> — 손에 든 행 → (given) → `미상 선수`. <b>`P001` 이 나오지 않는다.</b></li>
 *   <li><b>축 = full</b> — 이니셜 규칙(`avatarInitial`/`initialsOf`)이 풀네임 전제다. `shortName` 이
 *       실려 와도(#411 스위치 후) 이 자리는 풀네임이어야 한다.</li>
 *   <li>그 이름이 <b>실제로 화면 두 곳</b>(aria-label · 이니셜)에 흐른다 — 하나만 재면 다른 쪽이
 *       조용히 다른 값을 쓸 수 있다.</li>
 * </ol>
 *
 * <p>⚠️ 이 부품은 **지금 제품 화면에 소비자가 0**이다(`PlayerAvatar.tsx` 주석 참조). 그래서
 * e2e 로는 영영 못 재고 <b>여기가 유일한 방어선</b>이다 — 되살리는 사람이 "여긴 원래 이랬으니까"로
 * 우회를 부활시키는 자리가 정확히 이런 파일이다.
 *
 * <p>작성 규칙: root vitest include 가 `apps/**\/*.test.ts` 라 JSX 대신 createElement.
 */
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlayerAvatar } from "./PlayerAvatar";
import { UNKNOWN_PLAYER_NAME } from "./player-names";
import { __clearLegendDotAssets, type AvatarPlayer } from "./char-assets";

afterEach(() => {
  cleanup();
  __clearLegendDotAssets();
});

/** 서버가 `shortName` 을 싣기 시작한 뒤의 행(#411 스위치 후). 타입엔 아직 그 필드가 없다. */
const WITH_SHORT = {
  id: "P001",
  grade: "LEGEND",
  name: "레프 야신",
  shortName: "야신",
} as unknown as AvatarPlayer;

function labelOf(player: AvatarPlayer): string {
  const { getByTestId } = render(h(PlayerAvatar, { player }));
  return getByTestId(`player-avatar-${player.id}`).getAttribute("aria-label") ?? "";
}

describe("PlayerAvatar 이름 사다리 (#406 요구 6)", () => {
  it("1단 — 손에 든 행의 이름을 쓴다", () => {
    expect(labelOf({ id: "P001", grade: "LEGEND", name: "레프 야신" })).toBe("레프 야신");
  });

  /**
   * ★ 변이 킬 — `player.name` 직독으로 되돌리면 **빈 aria-label** 이 남는다(`role="img"` 인데
   * 이름이 없는 상태 = 스크린리더에 아무것도 안 읽힌다). 사다리 3단이 그걸 막는 이유다.
   */
  it("3단 — 이름이 비면 `미상 선수`. **id 가 아니고 빈 문자열도 아니다**", () => {
    for (const name of ["", "   "]) {
      cleanup();
      const label = labelOf({ id: "P001", grade: "LEGEND", name });
      expect(label).toBe(UNKNOWN_PLAYER_NAME);
      expect(label).not.toBe("");
      expect(label).not.toBe("P001"); // `?? player.id` 로 되돌리는 변이
    }
  });

  /**
   * ★ 변이 킬 — 축을 `short` 로 바꾸면 죽는다. 오늘은 서버가 `shortName` 을 안 줘서(#411)
   * 두 축의 값이 같아 **화면 차이가 0** 이다 — 그래서 지금 박아 두지 않으면 스위치가 켜지는 날
   * 이니셜 규칙(풀네임 전제)만 조용히 어긋난다.
   */
  it("축은 full — `shortName` 이 실려 와도 풀네임을 쓴다 (#411 스위치 후)", () => {
    expect(labelOf(WITH_SHORT)).toBe("레프 야신");
  });

  it("이니셜도 **같은 이름**에서 나온다 — 두 자리가 갈리지 않는다", () => {
    // `initialsOf` 한글 규칙 = 마지막 조각 2글자. 사다리를 지운 변이는 여기서도 갈린다.
    const { getByTestId, rerender } = render(h(PlayerAvatar, { player: WITH_SHORT }));
    expect(getByTestId("player-avatar-P001").textContent).toContain("야신"); // 레프 **야신**
    rerender(h(PlayerAvatar, { player: { id: "P001", grade: "LEGEND", name: "" } }));
    // `미상 선수` → `선수`. 직독 변이면 `?`(빈 이름) 가 뜬다.
    expect(getByTestId("player-avatar-P001").textContent).toContain("선수");
  });
});
