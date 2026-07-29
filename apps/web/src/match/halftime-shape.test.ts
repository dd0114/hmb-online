/**
 * 감독시간 배치(포메이션 + 선발 슬롯) — 순수 계약 (#276 W2 웹, #244 골격 위).
 *
 * 서버 `POST /halftime` 은 제스처가 아니라 **서로 독립인 세 필드**를 받는다:
 *   · `substitutions[{out,in}]`     — 로스터 변경(#244 가 이미 소유: `subs` state)
 *   · `formation` + `starters[11]`  — 배치(둘 다 또는 둘 다 아님, 한쪽만이면 400 SHAPE_PARTIAL)
 *   · `teamTactics`                 — 전술(#254)
 * 이 모듈이 못 박는 것은 가운데 축 하나다: **보드 상태 + 확정된 교체 → 실효 선발 11명**.
 *
 * 핵심 두 가지:
 *
 * ① **집합 불변식** — 보낼 `starters` 의 선수 집합 == 전반 선발 − outs + ins.
 *    서버가 정확히 이 식으로 검사한다(`MatchService` ROSTER_MISMATCH: h1Starters − out + in).
 *    어긋나면 400 이고 감독시간이 통째로 날아간다. 그래서 배치는 보드 슬롯을 그대로 쓰되
 *    **out 선수가 서 있던 슬롯을 in 선수가 물려받는** 치환으로 만든다 — 보드는 #244 대로
 *    OUT 뱃지만 붙이고 선수를 옮기지 않기 때문이다.
 *
 * ② **보드 모드에서는 배치를 항상 싣는다. 지금 보드 상태가 진실이다.**
 *    처음엔 "배치가 실제로 바뀐 경우에만" 실었다(#215 콜0을 웹에서 지키려던 것). 그런데
 *    `substitutions` 는 **항상** 싣고 배치는 **조건부로** 싣는 그 **비대칭**이 1R 독립검증에서
 *    blocker 2건으로 재현됐다 — 서버 `COALESCE` 는 미첨부를 "손대지 않음"으로 읽으므로
 *    `h2_shape_json` 에 **"배치를 원래대로 되돌린다"를 표현할 값이 없었다**:
 *      ⓐ 재제출 400 고착 — 배치를 낸 뒤 `POST /resume` 이 완료되지 않으면(네트워크 끊김·리로드)
 *         화면 재진입 시 보드가 스냅샷 원본에서 다시 시작하는데, 그때 배치를 빼면 **살아남은
 *         이전 배치**가 새 `substitutions:[]` 와 어긋나 400 `ROSTER_MISMATCH` 로 고착된다.
 *      ⓑ 취소한 배치가 조용히 반영 — 배치를 바꿔 낸 뒤 원상복구해도 이전 배치가 남아 후반이
 *         그걸로 돈다(400 도 안 뜬다 — 유저는 취소했다고 믿는다).
 *    📌 **`#215` 콜0 의 본질은 "필드를 안 보낸다"가 아니라 "AI 콜이 0이다"** 이고, 그 판정은
 *    **서버**(`MatchService.secondHalfShapeChanged`)가 한다 — 전반과 같은 배치를 그대로 보내도
 *    콜0이다(서버 계약 `HalftimeShapeTest.resubmittingTheSameShapeIsNotAChange`).
 *    ⚠️ 폴백 모드(`boardUsable` false, 구 매치)만 배치를 안 보낸다 — 보낼 스냅샷이 없다.
 */
import { describe, expect, it } from "vitest";
import type { TeamSnapshot } from "../api/v2";
import { findPlayerSlot, type DeckDraft } from "../deck/deck-logic";
import { movePlayerToSlot } from "../deck/tactics-logic";
import {
  boardUsable,
  effectiveStarters,
  halftimeShapePayload,
  snapshotToDraft,
  swapStarters,
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
];

function snapshot(formation = "4-4-2"): TeamSnapshot {
  return {
    formation,
    starters: STARTERS.map(([playerId, slotIndex]) => ({ playerId, slotIndex })),
    bench: BENCH.map(([playerId, slotIndex]) => ({ playerId, slotIndex })),
  };
}

const base = (): DeckDraft => snapshotToDraft(snapshot());

/** 서버 계약과 **같은 식**으로 계산한 기대 집합: 전반 선발 − outs + ins. */
function expectedSet(subs: Array<{ out: string; in: string }>): Set<string> {
  const set = new Set(STARTERS.map(([id]) => id));
  for (const s of subs) {
    set.delete(s.out);
    set.add(s.in);
  }
  return set;
}

describe("snapshotToDraft / boardUsable", () => {
  it("매치 스냅샷을 덱 보드 draft 로 옮긴다(선발/벤치 역할 + 포메이션)", () => {
    const d = snapshotToDraft(snapshot("4-3-3"));
    expect(d.formation).toBe("4-3-3");
    expect(findPlayerSlot(d, "F2")).toMatchObject({ role: "starter", slotIndex: 10 });
    expect(findPlayerSlot(d, "B2")).toMatchObject({ role: "bench", slotIndex: 1 });
  });

  /**
   * 스냅샷의 `promptText` 는 **전반에 쓴 지시**다. 그대로 draft 에 실으면 감독시간 화면이
   * 전반 문장을 채운 채로 열리고, 제출할 때 그 문장이 전부 **후반 지시로 다시** 나간다
   * (#244: 후반 지시는 빈 칸에서 시작한다). 그래서 옮기면서 지운다.
   */
  it("전반 프롬프트는 옮기지 않는다 — 후반 지시는 빈 칸에서 시작한다(#244)", () => {
    const snap = snapshot();
    snap.starters![0]!.promptText = "전반에 쓴 문장";
    const d = snapshotToDraft(snap);
    expect(findPlayerSlot(d, "GK1")?.promptText ?? null).toBeNull();
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

describe("swapStarters — 선발끼리 자리 바꾸기(덱과 같은 swap 의미)", () => {
  it("두 선발의 슬롯이 서로 맞바뀐다", () => {
    const d = swapStarters(base(), "F1", "F2");
    expect(findPlayerSlot(d, "F1")).toMatchObject({ role: "starter", slotIndex: 10 });
    expect(findPlayerSlot(d, "F2")).toMatchObject({ role: "starter", slotIndex: 9 });
  });

  /** 벤치 선수를 섞으면 그건 **교체**다 — 교체는 `subs`(#244)가 소유한다(손잡이 두 개 금지). */
  it("벤치 선수는 자리 바꾸기로 들어오지 못한다(교체는 subs 소유)", () => {
    const b = base();
    expect(swapStarters(b, "B1", "F2")).toBe(b);
    expect(swapStarters(b, "F2", "B1")).toBe(b);
    expect(swapStarters(b, "NOPE", "F2")).toBe(b);
  });
});

describe("effectiveStarters — 교체 반영 후의 실효 선발", () => {
  it("교체가 없으면 보드 선발 그대로(slotIndex 오름차순 결정론)", () => {
    const s = effectiveStarters(base(), [])!;
    expect(s).toHaveLength(11);
    expect(s.map((x) => x.slotIndex)).toEqual([...Array(11).keys()]);
    expect(new Set(s.map((x) => x.playerId))).toEqual(expectedSet([]));
  });

  /** 계약의 핵심 — **투입 선수를 그가 설 슬롯으로**, out 선수는 배열에 없어야 한다. */
  it("투입 선수가 out 선수의 슬롯을 물려받는다(out 은 배열에 없다)", () => {
    const subs = [{ out: "F2", in: "B1" }];
    const s = effectiveStarters(base(), subs)!;
    expect(s).toContainEqual({ playerId: "B1", slotIndex: 10 });
    expect(s.some((x) => x.playerId === "F2")).toBe(false);
    expect(new Set(s.map((x) => x.playerId))).toEqual(expectedSet(subs));
  });

  it("교체 3건도 집합 불변식을 지킨다(서버 ROSTER_MISMATCH 와 같은 식)", () => {
    const subs = [
      { out: "F2", in: "B1" },
      { out: "M1", in: "B2" },
      { out: "D4", in: "B3" },
    ];
    const s = effectiveStarters(base(), subs)!;
    expect(s).toHaveLength(11);
    expect(new Set(s.map((x) => x.playerId))).toEqual(expectedSet(subs));
    expect(s).toContainEqual({ playerId: "B2", slotIndex: 5 });
  });

  it("자리를 바꾼 뒤 교체해도 투입 선수는 out 선수가 **지금 서 있는** 슬롯에 선다", () => {
    const moved = swapStarters(base(), "F2", "M1"); // F2 → 5번, M1 → 10번
    const subs = [{ out: "F2", in: "B1" }];
    const s = effectiveStarters(moved, subs)!;
    expect(s).toContainEqual({ playerId: "B1", slotIndex: 5 });
    expect(s).toContainEqual({ playerId: "M1", slotIndex: 10 });
    expect(new Set(s.map((x) => x.playerId))).toEqual(expectedSet(subs));
  });

  it("선발이 11명이 아니면 배치를 만들지 않는다(서버가 400 낼 바디를 조립하지 않는다)", () => {
    const broken = movePlayerToSlot(base(), "F2", "bench", 5); // 선발 10명
    expect(effectiveStarters(broken, [])).toBeNull();
  });

  it("선발에 없는 선수를 빼는 교체는 배치를 만들지 않는다(집합이 어긋난다)", () => {
    expect(effectiveStarters(base(), [{ out: "B1", in: "B2" }])).toBeNull();
  });

  it("이미 선발인 선수를 넣는 교체는 배치를 만들지 않는다(중복)", () => {
    expect(effectiveStarters(base(), [{ out: "F2", in: "F1" }])).toBeNull();
  });
});

describe("halftimeShapePayload — 보드 모드면 배치를 **항상** 싣는다(콜0 판정은 서버)", () => {
  it("아무것도 안 건드려도 전반과 같은 배치를 명시 전송한다 (= 서버 판정 무변경 → 콜0)", () => {
    const p = halftimeShapePayload(base(), [], true);
    expect(p.substitutions).toEqual([]);
    expect(p.formation).toBe("4-4-2");
    expect(p.starters).toHaveLength(11);
  });

  /** blocker-1 회귀 가드 — 재마운트(state 초기화)로 보드가 스냅샷 원본에서 다시 시작한 상태. */
  it("재마운트 후 제출도 배치를 싣는다 — 서버에 남은 이전 배치가 살아남지 않게", () => {
    const first = halftimeShapePayload(swapStarters(base(), "F1", "M1"), [], true);
    expect(first.starters).toContainEqual({ playerId: "F1", slotIndex: 5 });

    const remounted = halftimeShapePayload(base(), [], true);
    expect(remounted.formation).toBe("4-4-2");
    expect(remounted.starters).toContainEqual({ playerId: "F1", slotIndex: 9 });
    expect(remounted.starters).toHaveLength(11);
  });

  /** blocker-2 회귀 가드 — 배치를 되돌리면 **되돌린 값**이 명시 전송돼야 취소가 취소로 남는다. */
  it("배치를 바꿨다가 원상복구해 재제출하면 base 배치를 명시 전송한다", () => {
    const moved = swapStarters(base(), "F1", "F2");
    const back = swapStarters(moved, "F1", "F2");
    const p = halftimeShapePayload(back, [], true);
    expect(p.starters).toContainEqual({ playerId: "F1", slotIndex: 9 });
    expect(p.starters).toContainEqual({ playerId: "F2", slotIndex: 10 });
  });

  it("포메이션을 바꾸면 formation 이 실린다(배치와 한 덩어리)", () => {
    const p = halftimeShapePayload({ ...base(), formation: "4-3-3" }, [], true);
    expect(p.formation).toBe("4-3-3");
    expect(p.starters).toHaveLength(11);
  });

  it("교체 + 배치 동시 — starters 가 투입 선수를 포함하고 out 선수를 제외한다", () => {
    const subs = [{ out: "F2", in: "B1" }];
    const moved = swapStarters(base(), "F2", "M1"); // out 선수를 5번으로 옮긴 뒤 교체
    const p = halftimeShapePayload(moved, subs, true);
    expect(p.substitutions).toEqual(subs);
    expect(p.starters).toContainEqual({ playerId: "B1", slotIndex: 5 });
    expect(p.starters?.some((s) => s.playerId === "F2")).toBe(false);
    expect(new Set(p.starters!.map((s) => s.playerId))).toEqual(expectedSet(subs));
  });

  /** 폴백(구 매치) — 보낼 스냅샷이 없다. #244 현행 동작(교체만) 그대로. */
  it("보드 모드가 아니면 배치를 아예 보내지 않는다(구 매치 폴백)", () => {
    const p = halftimeShapePayload(base(), [{ out: "F2", in: "B1" }], false);
    expect(p.substitutions).toEqual([{ out: "F2", in: "B1" }]);
    expect(p.formation).toBeUndefined();
    expect(p.starters).toBeUndefined();
  });

  it("형상이 깨졌으면 배치를 빼서 400 을 만들지 않는다(둘 다 또는 둘 다 아님)", () => {
    const broken = movePlayerToSlot(base(), "F2", "bench", 5);
    const p = halftimeShapePayload(broken, [], true);
    expect(p.formation).toBeUndefined();
    expect(p.starters).toBeUndefined();
  });
});
