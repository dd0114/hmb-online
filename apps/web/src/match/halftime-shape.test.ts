/**
 * 감독시간 라인업 diff — 순수 계약 (#276 W2 웹).
 *
 * 보드는 덱과 **같은 제스처**(tap-place / movePlayerToSlot swap)를 쓰는데, 서버가 받는 것은
 * 제스처가 아니라 **두 개의 독립 필드**다: `substitutions`(교체)와 `formation+starters`(배치).
 * 그 분해를 컴포넌트 안에 묻으면 검증할 수 없으므로 여기 순수 함수로 못 박는다.
 *
 * 핵심 두 가지:
 *   ① 교체 짝맞춤은 **벤치 슬롯 기준**이다 — `movePlayerToSlot` 이 swap 이라 나간 선수는
 *      들어온 선수가 앉아 있던 벤치 슬롯에 앉는다. 그 성질을 역으로 읽으면 결정론적으로 짝이 난다.
 *   ② 배치 변경 판정의 기준선은 **"교체만 적용한 스냅샷"**이다. 교체로 들어온 선수가 나간 선수의
 *      슬롯을 물려받았을 뿐이면 배치는 안 바뀐 것이고, 그때 formation/starters 를 실어 보내면
 *      서버가 유저 사이드 AI 풀 생성(콜 1회)을 하게 된다(#215 콜0 계약 훼손).
 */
import { describe, expect, it } from "vitest";
import type { TeamSnapshot } from "../api/v2";
import { findPlayerSlot, type DeckDraft } from "../deck/deck-logic";
import { movePlayerToSlot } from "../deck/tactics-logic";
import {
  boardUsable,
  diffSubstitutions,
  halftimeShapePayload,
  lineupIssues,
  revertSub,
  snapshotToDraft,
  starterSlotMap,
} from "./halftime-shape";

const STARTERS: Array<[string, number]> = [
  ["GK1", 0],
  ["D1", 1],
  ["D2", 2],
  ["D3", 3],
  ["D4", 4],
  ["M1", 5],
  ["M2", 6],
  ["M3", 7],
  ["M4", 8],
  ["F1", 9],
  ["F2", 10],
];

const BENCH: Array<[string, number]> = [
  ["B1", 0],
  ["B2", 1],
  ["B3", 2],
  ["B4", 3],
];

function snapshot(formation = "4-4-2"): TeamSnapshot {
  return {
    formation,
    starters: STARTERS.map(([playerId, slotIndex]) => ({ playerId, slotIndex })),
    bench: BENCH.map(([playerId, slotIndex]) => ({ playerId, slotIndex })),
  };
}

const base = (): DeckDraft => snapshotToDraft(snapshot());

/** 포지션 — GK1 만 GK, B4 도 GK(교체 GK 검증용). */
const posOf = (id: string): string | undefined =>
  id === "GK1" || id === "B4" ? "GK" : id.startsWith("D") ? "DF" : id.startsWith("F") ? "FW" : "MF";

describe("snapshotToDraft / boardUsable", () => {
  it("매치 스냅샷을 덱 보드 draft 로 옮긴다(선발/벤치 역할 + 포메이션)", () => {
    const d = snapshotToDraft(snapshot("4-3-3"));
    expect(d.formation).toBe("4-3-3");
    expect(findPlayerSlot(d, "F2")).toMatchObject({ role: "starter", slotIndex: 10 });
    expect(findPlayerSlot(d, "B2")).toMatchObject({ role: "bench", slotIndex: 1 });
  });

  it("null 스냅샷(구 매치)은 보드를 열 수 없다 — 폴백 경로로 가야 한다", () => {
    expect(boardUsable(null)).toBe(false);
    expect(boardUsable(undefined)).toBe(false);
  });

  it("선발이 11명이 아닌 깨진 스냅샷도 보드를 열지 않는다", () => {
    expect(boardUsable({ ...snapshot(), starters: [] })).toBe(false);
    expect(boardUsable(snapshot())).toBe(true);
  });
});

describe("diffSubstitutions — 벤치 슬롯 기준 짝맞춤", () => {
  it("벤치 선수를 선발 슬롯에 놓으면 교체 1건(out/in 정확)", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "B1", "starter", 10); // B1 ↔ F2 swap
    expect(diffSubstitutions(b, cur)).toEqual([{ out: "F2", in: "B1" }]);
  });

  it("선발끼리 슬롯을 바꾸면 교체는 0건이다", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "F1", "starter", 10); // F1 ↔ F2
    expect(diffSubstitutions(b, cur)).toEqual([]);
  });

  it("교체 2건도 벤치 슬롯으로 결정론적으로 짝이 난다(교차 오배정 금지)", () => {
    const b = base();
    let cur = movePlayerToSlot(b, "B1", "starter", 10); // F2 → bench0
    cur = movePlayerToSlot(cur, "B2", "starter", 9); // F1 → bench1
    const subs = diffSubstitutions(b, cur);
    expect(subs).toHaveLength(2);
    expect(subs).toContainEqual({ out: "F2", in: "B1" });
    expect(subs).toContainEqual({ out: "F1", in: "B2" });
  });

  it("교체 후 투입 선수를 다른 슬롯으로 옮겨도 교체 짝은 그대로다", () => {
    const b = base();
    let cur = movePlayerToSlot(b, "B1", "starter", 10); // out F2 / in B1
    cur = movePlayerToSlot(cur, "B1", "starter", 5); // B1 ↔ M1 (선발끼리)
    expect(diffSubstitutions(b, cur)).toEqual([{ out: "F2", in: "B1" }]);
  });
});

describe("halftimeShapePayload — 배치는 '교체만 적용한 스냅샷' 과 비교한다", () => {
  it("아무것도 안 건드리면 세 필드 중 배치는 아예 안 실린다(콜0)", () => {
    const b = base();
    const p = halftimeShapePayload(b, b);
    expect(p.substitutions).toEqual([]);
    expect(p.formation).toBeUndefined();
    expect(p.starters).toBeUndefined();
  });

  it("교체만 하고 슬롯은 그대로면 배치를 안 보낸다 (나간 선수 슬롯을 물려받았을 뿐)", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "B1", "starter", 10);
    const p = halftimeShapePayload(b, cur);
    expect(p.substitutions).toEqual([{ out: "F2", in: "B1" }]);
    expect(p.formation).toBeUndefined();
    expect(p.starters).toBeUndefined();
  });

  it("선발 슬롯을 바꾸면 배치가 실린다(11명, 교체는 빈 채로)", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "F1", "starter", 10);
    const p = halftimeShapePayload(b, cur);
    expect(p.substitutions).toEqual([]);
    expect(p.formation).toBe("4-4-2");
    expect(p.starters).toHaveLength(11);
    expect(p.starters).toContainEqual({ playerId: "F1", slotIndex: 10 });
    expect(p.starters).toContainEqual({ playerId: "F2", slotIndex: 9 });
  });

  it("포메이션만 바꿔도 배치가 실린다(둘 다 또는 둘 다 아님)", () => {
    const b = base();
    const p = halftimeShapePayload(b, { ...b, formation: "4-3-3" });
    expect(p.formation).toBe("4-3-3");
    expect(p.starters).toHaveLength(11);
  });

  it("교체 + 배치 동시 — starters 는 **투입 선수 기준**으로 실린다", () => {
    const b = base();
    let cur = movePlayerToSlot(b, "B1", "starter", 10); // out F2 / in B1(10번 자리)
    cur = movePlayerToSlot(cur, "B1", "starter", 5); // B1 을 5번으로, M1 은 10번으로
    const p = halftimeShapePayload(b, cur);
    expect(p.substitutions).toEqual([{ out: "F2", in: "B1" }]);
    expect(p.starters).toContainEqual({ playerId: "B1", slotIndex: 5 });
    expect(p.starters).toContainEqual({ playerId: "M1", slotIndex: 10 });
    // 나간 선수는 배치에 있으면 안 된다.
    expect(p.starters?.some((s) => s.playerId === "F2")).toBe(false);
  });

  it("배치는 slotIndex 오름차순으로 결정론 직렬화된다", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "F1", "starter", 10);
    const idx = halftimeShapePayload(b, cur).starters!.map((s) => s.slotIndex);
    expect(idx).toEqual([...idx].sort((a, z) => a - z));
  });
});

describe("revertSub — 확정된 교체를 텍스트 목록에서 취소", () => {
  it("취소하면 스냅샷 배치로 정확히 되돌아간다", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "B1", "starter", 10);
    const back = revertSub(cur, { out: "F2", in: "B1" });
    expect(diffSubstitutions(b, back)).toEqual([]);
    expect(starterSlotMap(back)).toEqual(starterSlotMap(b));
  });
});

describe("lineupIssues — 검증은 기존 validateSubs 를 그대로 쓴다", () => {
  it("교체 3건까지는 이슈 없음, 4건이면 SUBS_MAX", () => {
    const b = base();
    let cur = b;
    const pairs: Array<[string, number]> = [
      ["B1", 10],
      ["B2", 9],
      ["B3", 8],
    ];
    for (const [id, slot] of pairs) cur = movePlayerToSlot(cur, id, "starter", slot);
    expect(lineupIssues(b, cur, posOf)).toEqual([]);
    cur = movePlayerToSlot(cur, "B4", "starter", 7);
    expect(lineupIssues(b, cur, posOf).map((i) => i.rule)).toContain("SUBS_MAX");
  });

  it("GK 를 빼고 필드 선수를 넣으면 GK_REQUIRED", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "B1", "starter", 0); // GK1 out, B1(FW/MF) in
    expect(lineupIssues(b, cur, posOf).map((i) => i.rule)).toContain("GK_REQUIRED");
  });

  it("선발이 11명이 아니게 되면 STARTER_COUNT 로 막는다(빈 벤치칸으로 끌어낸 경우)", () => {
    const b = base();
    const cur = movePlayerToSlot(b, "F2", "bench", 6); // 빈 벤치칸 → 선발 10명
    expect(lineupIssues(b, cur, posOf).map((i) => i.rule)).toContain("STARTER_COUNT");
    // 형상이 깨진 상태에서는 서버가 400 낼 배치를 만들지 않는다.
    expect(halftimeShapePayload(b, cur).starters).toBeUndefined();
  });
});
