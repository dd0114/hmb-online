import { describe, expect, it } from "vitest";
import { assignPlayer, emptyDraft, getSlot, findPlayerSlot, type DeckDraft } from "./deck-logic";
import {
  DEFAULT_TEAM_TACTICS,
  editorToSaveRequest,
  firstEmptyBench,
  movePlayerToSlot,
  snapshotSaveable,
  snapshotToEditor,
  starterCoords,
} from "./tactics-logic";
import type { TeamSnapshot } from "../api/v2";

function fullStarters(): DeckDraft {
  let draft = emptyDraft("4-4-2");
  draft = assignPlayer(draft, "starter", 0, "GK1");
  for (let i = 1; i <= 10; i++) draft = assignPlayer(draft, "starter", i, `P${i}`);
  return draft;
}

describe("starterCoords", () => {
  it("returns one coord per starter slot (11) for 4-4-2 and 4-3-3", () => {
    expect(starterCoords("4-4-2")).toHaveLength(11);
    expect(starterCoords("4-3-3")).toHaveLength(11);
  });

  it("GK row sits lower (higher y) than the FW row", () => {
    const coords = starterCoords("4-4-2");
    const gk = coords.find((c) => c.slotIndex === 0)!;
    const fw = coords.find((c) => c.label === "FW")!;
    expect(gk.y).toBeGreaterThan(fw.y);
  });

  it("keeps all coords within the pitch box (0..1)", () => {
    for (const c of starterCoords("4-3-3")) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(1);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to the default formation for an unknown key", () => {
    expect(starterCoords("weird-9-9")).toHaveLength(11);
  });
});

describe("movePlayerToSlot", () => {
  it("moves a player to an empty target slot, freeing the source", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "P001");
    draft = movePlayerToSlot(draft, "P001", "bench", 0);
    expect(getSlot(draft, "starter", 5)).toBeUndefined();
    expect(getSlot(draft, "bench", 0)?.playerId).toBe("P001");
  });

  it("swaps two on-board players (bench↔starter)", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "STARTER");
    draft = assignPlayer(draft, "bench", 0, "BENCHIE");
    draft = movePlayerToSlot(draft, "BENCHIE", "starter", 5);
    expect(getSlot(draft, "starter", 5)?.playerId).toBe("BENCHIE");
    expect(getSlot(draft, "bench", 0)?.playerId).toBe("STARTER");
  });

  it("carries prompt text with the swapped players", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "A");
    draft = assignPlayer(draft, "bench", 0, "B");
    draft = { ...draft, slots: draft.slots.map((s) => (s.playerId === "A" ? { ...s, promptText: "keep me" } : s)) };
    draft = movePlayerToSlot(draft, "B", "starter", 5);
    expect(findPlayerSlot(draft, "A")?.promptText).toBe("keep me");
    expect(findPlayerSlot(draft, "A")?.role).toBe("bench");
  });

  it("is a no-op when dropped on its own slot", () => {
    const draft = assignPlayer(emptyDraft(), "starter", 5, "P001");
    expect(movePlayerToSlot(draft, "P001", "starter", 5)).toBe(draft);
  });
});

/**
 * #442 R4-B — **밀려난 선수는 벤치 자리가 있으면 벤치로 내려간다**
 * (hero: *"벤치 자리있으면 벤치, 벤치 자리없으면 빼자"*).
 *
 * 구 동작은 **무조건 덱에서 뺐다** — 빈 벤치 칸이 13개 남아 있어도 그 선수의 **프롬프트까지**
 * 통째로 사라졌고(되돌리기 없음), 화면은 그걸 "명단을 바꿨다"로 안내하고 있었다(#442 minor-2).
 *
 * ⚠️ **이 판정은 `movePlayerToSlot` 한 곳에만 있다.** 그 함수가 "맞바꾸기냐 밀어냄이냐"를 이미
 * 소유하고 있고(드래그 드롭 · 슬롯 탭 · 시트 선택이 전부 그리로 온다), `assignPlayer` 는 그 아래
 * **저수준 원시연산**이다 — 거기에 적으면 `fill-empty` 같은 다른 소비자까지 규칙을 상속받아
 * 같은 규칙이 두 곳에서 해석된다(#439 major-2 가 정확히 그 사고였다).
 *
 * ⚠️ 밀려나는 것은 **풀(스쿼드 밖) 선수가 찬 자리로 들어올 때뿐**이다. 보드 위 선수끼리는
 * 맞바꾸기라 애초에 밀려나는 사람이 없다(위 describe 가 그걸 지킨다).
 */
describe("#442 R4-B — 밀려난 선수의 행선지", () => {
  /** 선발 5 에 OLD, 벤치는 `benchIds` 로 채운다. */
  function seated(benchIds: string[], occupantPrompt: string | null = null): DeckDraft {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "OLD");
    if (occupantPrompt !== null) {
      draft = { ...draft, slots: draft.slots.map((s) => (s.playerId === "OLD" ? { ...s, promptText: occupantPrompt } : s)) };
    }
    benchIds.forEach((id, i) => {
      draft = assignPlayer(draft, "bench", i, id);
    });
    return draft;
  }

  it("벤치에 여유가 있으면 — 밀려난 선수는 **첫 빈 벤치 자리**로 내려간다(덱에 남는다)", () => {
    const draft = movePlayerToSlot(seated(["B0", "B1"]), "NEW_FROM_POOL", "starter", 5);
    expect(getSlot(draft, "starter", 5)?.playerId).toBe("NEW_FROM_POOL");
    expect(getSlot(draft, "bench", 2)?.playerId, "빈 벤치가 있는데 사라지면 안 된다").toBe("OLD");
    expect(getSlot(draft, "bench", 0)?.playerId, "이미 앉은 벤치는 안 밀린다").toBe("B0");
    expect(draft.slots.filter((s) => s.playerId === "NEW_FROM_POOL")).toHaveLength(1);
  });

  it("밀려난 선수의 **지시(프롬프트)가 따라 내려간다** — 이게 hero 결정의 취지다", () => {
    const draft = movePlayerToSlot(seated([], "왼쪽으로 벌려"), "NEW_FROM_POOL", "starter", 5);
    expect(findPlayerSlot(draft, "OLD")?.role).toBe("bench");
    expect(findPlayerSlot(draft, "OLD")?.promptText).toBe("왼쪽으로 벌려");
  });

  it("벤치가 만석이면 — 지금처럼 덱에서 빠진다(중복 없음)", () => {
    const full = seated(["B0", "B1", "B2", "B3", "B4", "B5", "B6"]);
    expect(firstEmptyBench(full), "전제: 벤치가 꽉 찼다").toBeNull();
    const draft = movePlayerToSlot(full, "NEW_FROM_POOL", "starter", 5);
    expect(getSlot(draft, "starter", 5)?.playerId).toBe("NEW_FROM_POOL");
    expect(findPlayerSlot(draft, "OLD"), "벤치가 없으면 빼는 것이 hero 결정이다").toBeUndefined();
    expect(draft.slots.filter((s) => s.playerId === "NEW_FROM_POOL")).toHaveLength(1);
  });

  // ⚠️ **마지막 한 자리** — hero 결정("자리있으면 벤치, 자리없으면 빼자")의 경첩이 정확히 여기다.
  // 여유(0~2명)와 만석(7명) 표본만 있으면 그 사이 경계가 한 번도 안 밟혀, 정원 off-by-one 이
  // 들어와도 전 스위트가 green 이다(독립검증이 `i < BENCH_MAX - 1` 변이를 실제로 살려 보였다:
  // deck 유닛 247/247 + p442 e2e 11/11 통과). 자리가 **있는데** 제거하는 것이 바로 그 버그다.
  it("벤치에 **마지막 한 자리**만 남아도 — 빼지 않고 그 자리에 앉힌다(경계)", () => {
    const nearlyFull = seated(["B0", "B1", "B2", "B3", "B4", "B5"]);
    expect(firstEmptyBench(nearlyFull), "전제: 딱 한 자리(index 6) 남았다").toBe(6);
    const draft = movePlayerToSlot(nearlyFull, "NEW_FROM_POOL", "starter", 5);
    expect(getSlot(draft, "bench", 6)?.playerId, "자리가 있는데 제거하면 안 된다").toBe("OLD");
    expect(findPlayerSlot(draft, "OLD")?.role).toBe("bench");
  });

  it("**찬 벤치 자리**에 풀 선수를 넣어도 같다 — 그 벤치 선수는 다른 빈 벤치로 내려간다", () => {
    const draft = movePlayerToSlot(seated(["B0"]), "NEW_FROM_POOL", "bench", 0);
    expect(getSlot(draft, "bench", 0)?.playerId).toBe("NEW_FROM_POOL");
    expect(getSlot(draft, "bench", 1)?.playerId).toBe("B0");
    expect(getSlot(draft, "starter", 5)?.playerId, "관계 없는 선발은 그대로다").toBe("OLD");
  });

  it("⛔ 맞바꾸기는 무회귀 — 보드 위 선수끼리는 벤치 강등 경로를 타지 않는다", () => {
    // 선발↔선발: 서로 자리만 바꾼다(벤치가 비어 있어도 벤치로 안 간다).
    let draft = assignPlayer(emptyDraft(), "starter", 5, "A");
    draft = assignPlayer(draft, "starter", 6, "B");
    const swapped = movePlayerToSlot(draft, "A", "starter", 6);
    expect(getSlot(swapped, "starter", 6)?.playerId).toBe("A");
    expect(getSlot(swapped, "starter", 5)?.playerId, "B 는 A 가 있던 자리로 간다").toBe("B");
    expect(swapped.slots.filter((s) => s.role === "bench"), "아무도 벤치로 내려가지 않는다").toEqual([]);

    // 벤치↔선발: 위와 같은 맞바꾸기(#442 R1 경기전 동선의 본체).
    let mixed = assignPlayer(emptyDraft(), "starter", 5, "STARTER");
    mixed = assignPlayer(mixed, "bench", 0, "BENCHIE");
    mixed = assignPlayer(mixed, "bench", 1, "SPARE");
    const up = movePlayerToSlot(mixed, "BENCHIE", "starter", 5);
    expect(getSlot(up, "starter", 5)?.playerId).toBe("BENCHIE");
    expect(getSlot(up, "bench", 0)?.playerId, "밀려난 선발은 **올라온 선수가 있던** 자리로 간다").toBe("STARTER");
    expect(getSlot(up, "bench", 1)?.playerId, "다른 벤치는 안 건드린다").toBe("SPARE");
  });
});

describe("firstEmptyBench", () => {
  it("returns 0 for an empty bench and null when full", () => {
    let draft = emptyDraft();
    expect(firstEmptyBench(draft)).toBe(0);
    for (let i = 0; i < 7; i++) draft = assignPlayer(draft, "bench", i, `B${i}`);
    expect(firstEmptyBench(draft)).toBeNull();
  });
});

describe("snapshot serialization round-trip", () => {
  const snap: TeamSnapshot = {
    formation: "4-3-3",
    starters: [
      { playerId: "GK1", slotIndex: 0, promptText: null },
      { playerId: "P5", slotIndex: 5, promptText: "press high" },
    ],
    bench: [{ playerId: "B1", slotIndex: 0, promptText: null }],
    teamTactics: { line: 0.7, press: 0.8, tempo: 0.4, width: 0.6 },
    teamPrompt: "counter-attack",
  };

  it("snapshotToEditor maps starters/bench into draft slots + tactics + teamPrompt", () => {
    const editor = snapshotToEditor(snap);
    expect(editor.draft.formation).toBe("4-3-3");
    expect(getSlot(editor.draft, "starter", 5)?.promptText).toBe("press high");
    expect(getSlot(editor.draft, "bench", 0)?.playerId).toBe("B1");
    expect(editor.tactics.press).toBe(0.8);
    expect(editor.teamPrompt).toBe("counter-attack");
  });

  it("editorToSaveRequest reproduces the snapshot body (sorted by slotIndex)", () => {
    const editor = snapshotToEditor(snap);
    const req = editorToSaveRequest(editor, "my-team");
    expect(req.name).toBe("my-team");
    expect(req.formation).toBe("4-3-3");
    expect(req.starters.map((s) => s.slotIndex)).toEqual([0, 5]);
    expect(req.starters.find((s) => s.slotIndex === 5)?.promptText).toBe("press high");
    expect(req.bench).toHaveLength(1);
    expect(req.teamTactics).toEqual(snap.teamTactics);
    expect(req.teamPrompt).toBe("counter-attack");
  });

  it("defaults tactics/prompt when the snapshot omits them", () => {
    const editor = snapshotToEditor({ formation: "4-4-2", starters: [], bench: [] });
    expect(editor.tactics).toEqual(DEFAULT_TEAM_TACTICS);
    expect(editor.teamPrompt).toBe("");
  });

  it("editorToSaveRequest sends teamPrompt=null when empty", () => {
    const editor = snapshotToEditor({ formation: "4-4-2", starters: [], bench: [] });
    expect(editorToSaveRequest(editor, "x").teamPrompt).toBeNull();
  });
});

describe("snapshotSaveable", () => {
  it("is true only with exactly 11 starters", () => {
    expect(snapshotSaveable(fullStarters())).toBe(true);
    expect(snapshotSaveable(emptyDraft())).toBe(false);
  });
});
