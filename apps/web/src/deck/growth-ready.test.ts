import { describe, expect, it } from "vitest";
import { growthReadyIdsOf } from "./growth-ready";
import type { PendingChoice } from "../api/growth";

const c = (choiceId: string, playerId: string, level = 2): PendingChoice => ({
  choiceId,
  playerId,
  level,
  candidates: [{ stat: "pace", gain: 1 }],
});

describe("growthReadyIdsOf — 선택 대기가 있는 선수 id 집합 (#455 A2-2)", () => {
  it("대기가 있는 선수만 담는다 — 양성/음성", () => {
    const ids = growthReadyIdsOf([c("c1", "MF1"), c("c2", "FW3")]);
    expect(ids.has("MF1")).toBe(true);
    expect(ids.has("FW3")).toBe(true);
    // 음성 표본이 없으면 "전원 true" 를 돌려주는 구현이 산다.
    expect(ids.has("FW2")).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("한 선수에 여러 레벨이 밀려 있어도 **한 명**이다 — 뱃지는 개수가 아니라 유무다", () => {
    const ids = growthReadyIdsOf([c("c1", "MF1", 2), c("c2", "MF1", 3), c("c3", "MF1", 4)]);
    expect([...ids]).toEqual(["MF1"]);
  });

  /**
   * ⚠️ **`undefined` 는 "없다"가 아니라 "아직 모른다"다** — `usePendingChoices` 는 `retry:false`
   * 라 구 서버·조회 실패에서 그대로 `undefined` 로 남는다. 이 앱은 그 상태를 '없음'으로 읽어
   * 사고를 낸 전력이 있다(`deckMissing(undefined)`, apps/web/CLAUDE.md). 여기서는 **뱃지를
   * 안 그리는 쪽**(fail-closed)이 옳다 — 없는 사실을 화면에 그리는 것보다 낫다.
   */
  it("아직 안 왔으면(undefined) 빈 집합 — 화면을 죽이지도, 없는 사실을 그리지도 않는다", () => {
    expect(growthReadyIdsOf(undefined).size).toBe(0);
    expect(growthReadyIdsOf([]).size).toBe(0);
  });

  /**
   * 서버가 `{}` 를 주면 훅이 `[]` 로 눕히지만, 배열 **안쪽**은 아무도 안 본다. `playerId` 가
   * 문자열이 아닌 항목이 섞이면 `Set` 에 `undefined` 가 들어가 `has(undefined as any)` 같은
   * 사고 표면이 생긴다 — 여기서 자른다.
   */
  it("playerId 가 문자열이 아닌 항목은 버린다", () => {
    const dirty = [
      c("c1", "MF1"),
      { choiceId: "c2", level: 2, candidates: [] } as unknown as PendingChoice,
      { choiceId: "c3", playerId: "", level: 2, candidates: [] } as PendingChoice,
      null as unknown as PendingChoice,
    ];
    expect([...growthReadyIdsOf(dirty)]).toEqual(["MF1"]);
  });
});
