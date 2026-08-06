import { describe, expect, it } from "vitest";
import { attributeAverage, compareByStrength, sortByStrength, type SortablePlayer } from "./codex-sort";

/**
 * "좋은 카드 순" 계약 (#457 D).
 *
 * ⚠️ **표본이 계약의 절반이다** — 각 단(段)을 재려면 *그 단만* 다른 두 장이 있어야 한다.
 * 한 표본에 등급·OVR·중복을 같이 흔들어 두면 아래 단을 지우는 변이가 전부 통과한다
 * (루트 §초록으로 거짓말하는 방식 ④).
 */

/** 9축 전부 채운 기본 능력치 — 부분 객체는 카탈로그 타입이 아니다(형태를 흉내내면 계약이 헐거워진다). */
const ATTRS = {
  technical: 70, mental: 70, physical: 70, passing: 70, shooting: 70,
  tackling: 70, pace: 70, stamina: 70, positioning: 70,
};

const P = (over: Partial<SortablePlayer> & { id: string }): SortablePlayer =>
  ({
    name: over.id,
    position: "MF",
    grade: "GOLD",
    owned: true,
    ownedCount: 1,
    attributes: ATTRS,
    active: true,
    ...over,
  }) as SortablePlayer;

const ids = (rows: SortablePlayer[]) => sortByStrength(rows).map((r) => r.id);

describe("codex-sort — 획득한 좋은 카드 순", () => {
  it("① 보유가 미보유보다 먼저다 — 등급이 낮아도", () => {
    const rows = [P({ id: "A", owned: false, grade: "LEGEND" }), P({ id: "B", owned: true, grade: "BRONZE" })];
    expect(ids(rows)).toEqual(["B", "A"]);
  });

  it("② 같은 보유 상태면 등급 높은 쪽이 먼저다", () => {
    const rows = ["BRONZE", "LEGEND", "SILVER", "DIA", "GOLD"].map((g, i) => P({ id: `G${i}`, grade: g as never }));
    expect(ids(rows)).toEqual(["G1", "G3", "G4", "G2", "G0"]);
  });

  it("③ 등급이 같으면 성(★)이 높은 쪽 — #458 이 실어 주면 켜진다", () => {
    const rows = [P({ id: "A", star: 2 }), P({ id: "B", star: 5 })];
    expect(ids(rows)).toEqual(["B", "A"]);
  });

  it("④ 성이 같으면 OVR — 없으면 능력치 평균으로 폴백한다", () => {
    const byOvr = [P({ id: "A", ovr: 60 }), P({ id: "B", ovr: 82 })];
    expect(ids(byOvr)).toEqual(["B", "A"]);
    const byAttrs = [
      P({ id: "A", attributes: { ...ATTRS, pace: 50, shooting: 50 } }),
      P({ id: "B", attributes: { ...ATTRS, pace: 90, shooting: 80 } }),
    ];
    expect(ids(byAttrs)).toEqual(["B", "A"]);
  });

  it("⑤ 거기까지 같으면 중복 보유 수 — 승급 재료가 쌓인 카드가 위로", () => {
    const rows = [P({ id: "A", ownedCount: 1 }), P({ id: "B", ownedCount: 4 })];
    expect(ids(rows)).toEqual(["B", "A"]);
  });

  it("⑥ 전부 같으면 id 로 고정한다 — 목록이 리렌더마다 흔들리지 않게", () => {
    const rows = [P({ id: "P020" }), P({ id: "P003" }), P({ id: "P011" })];
    expect(ids(rows)).toEqual(["P003", "P011", "P020"]);
    // 입력 순서를 뒤집어도 같은 결과 = 안정적이다.
    expect(ids([...rows].reverse())).toEqual(["P003", "P011", "P020"]);
  });

  /**
   * ⚠️ **모르는 값을 0 으로 채우면 순서가 거꾸로 선다.** `star ?? 0` 을 넣는 순간, 성이 실린
   * 카드(#458 이후)와 아직 안 실린 카드가 섞인 과도기에 **성 있는 카드가 아래로** 간다.
   * 그래서 "한쪽만 아는" 표본을 계약으로 박는다 — 그 단은 **건너뛰고** 다음 단이 정한다.
   */
  it("⑦ 한쪽만 아는 값은 그 단을 건너뛴다 (0 폴백 금지)", () => {
    const rows = [P({ id: "A", star: undefined, ownedCount: 9 }), P({ id: "B", star: 5, ownedCount: 1 })];
    expect(ids(rows), "성을 모르는 A 가 중복 수로 이겨야 한다").toEqual(["A", "B"]);
  });

  it("⑧ 원본 배열을 건드리지 않는다", () => {
    const rows = [P({ id: "B", grade: "BRONZE" }), P({ id: "A", grade: "LEGEND" })];
    sortByStrength(rows);
    expect(rows.map((r) => r.id)).toEqual(["B", "A"]);
  });

  it("⑨ 능력치가 없거나 형태가 이상하면 평균은 null 이다 (구 서버 `{}` 방어)", () => {
    expect(attributeAverage(undefined)).toBeNull();
    expect(attributeAverage({})).toBeNull();
    expect(attributeAverage({ a: "x" })).toBeNull();
    expect(attributeAverage({ a: 10, b: 20 })).toBe(15);
    // 비교자도 그 상태에서 던지지 않는다.
    expect(
      compareByStrength(
        P({ id: "A", attributes: {} as never }),
        P({ id: "B", attributes: {} as never }),
      ),
    ).toBeLessThan(0);
  });
});
