// @vitest-environment jsdom
/**
 * #403 W4 R3 — **`useTeamSegment` 세터 자체의 계약** (독립검증 minor-2).
 *
 * 훅의 *동작*(따라간다 / 유저 선택이 이긴다 / 안 바뀌는 탭은 안 친다)은 이미 세 곳에 있다
 * (`stage/PlayerStatsPanel.test.ts` 유닛 3건 + `e2e/p403-result-players.spec.ts` 4건).
 * 여기 있는 것은 그 계약들이 **원리적으로 못 보는 축**이다 — 세터의 **신원**과 **배치 안 두 번 호출**.
 *
 * ⚠️ 왜 필요한가: R2 는 `team` 을 클로저로 잡는 화살표를 매 렌더 새로 만들어 반환했다. 화면 동작이
 * 같아서 e2e·패널 유닛 7건이 **전부 통과했고**(R3 이 그 형태로 되돌리는 변이를 실제로 돌려
 * **SURVIVED** 를 확인했다), 그래서 이 축은 계약이 없으면 조용히 되돌아간다. 이 훅은 머리말이
 * *"두 패널의 단일 출처"* 라고 선언한 자리이므로 그 선언과 정합하게 **신원을 고정**한다.
 */
import { createElement as h, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useTeamSegment } from "./PlayerStatsTable";
import type { TeamSide } from "./player-stats";

interface Probe {
  team: TeamSide;
  setTeam: (side: TeamSide) => void;
  /** 이 마운트에서 지금까지 본 **서로 다른** 세터 신원의 수. */
  identities: number;
  renders: number;
}
let probe: Probe;

function Harness({ mine }: { mine: "home" | "away" | null }) {
  const [team, setTeam] = useTeamSegment(mine);
  const seen = useRef<Set<unknown>>(new Set());
  const renders = useRef(0);
  seen.current.add(setTeam);
  renders.current += 1;
  probe = { team, setTeam, identities: seen.current.size, renders: renders.current };
  return null;
}

const mount = (mine: "home" | "away" | null) => render(h(Harness, { mine }));

afterEach(cleanup);

describe("useTeamSegment — 세터 계약", () => {
  it("같은 `myTeamSide` 로 여러 번 리렌더돼도 세터 신원이 하나다", () => {
    const view = mount(null);
    for (let i = 0; i < 3; i += 1) view.rerender(h(Harness, { mine: null }));
    expect(probe.renders, "리렌더가 실제로 일어나야 이 계약이 무언가를 잰다").toBeGreaterThan(3);
    expect(probe.identities, "세터가 매 렌더 새 신원이 됐다 — memo 소비자가 생기면 불필요 리렌더").toBe(1);
  });

  it("선택이 바뀌어도 세터 신원은 그대로다 (`fallback` 만 신원을 움직인다)", () => {
    mount(null);
    act(() => probe.setTeam("away"));
    expect(probe.team).toBe("away");
    expect(probe.identities, "선택이 바뀌었다고 세터까지 갈아치우지 않는다").toBe(1);
  });

  /**
   * ⚠️ **한 배치 안에서 두 번 부르면 두 번째가 낡은 값과 비교하던 자리다.**
   * R2 형태(`side === team ? undefined : setPicked(side)`)에서는 두 호출 다 마운트 시점의
   * `team`(= `"home"`)과 비교해 **두 번째가 no-op 가드에 잘못 걸린다** → 유저의 최종 의도가
   * `"home"` 인데 `"away"` 에 앉는다. 함수형 갱신은 커밋 시점 `picked` 를 읽어 그 함정이 없다.
   */
  it("한 배치 안 두 번 호출 — 두 번째가 최신 값 기준으로 판정된다", () => {
    mount(null);
    expect(probe.team).toBe("home");
    act(() => {
      probe.setTeam("away");
      probe.setTeam("home");
    });
    expect(probe.team, "두 번째 호출이 낡은 `team` 과 비교돼 삼켜졌다").toBe("home");
  });

  it("가드는 그대로다 — 지금 값과 같은 선택은 `picked` 를 굳히지 않는다", () => {
    const view = mount(null);
    act(() => probe.setTeam("home")); // 화면이 안 바뀌는 탭
    view.rerender(h(Harness, { mine: "away" })); // 늦게 온 myTeamSide
    expect(probe.team, "안 바뀌는 탭이 `picked` 를 굳혀 상대 팀에 가뒀다").toBe("away");
  });
});
