// @vitest-environment jsdom
/**
 * 감독시간 **포메이션 + 선발 배치** — #276 (hero 결정으로 #244 의 전제 하나가 뒤집혔다).
 *
 * #244 는 감독시간을 덱과 같은 `DeckEditor` 로 통일하면서 `placementLocked` 에 *"자리 바꾸기가
 * 없다"* 까지 묶어 뒀다. #276 hero 결정 = **감독시간에 포메이션과 선발 배치를 바꿀 수 있다** —
 * 그래서 잠금을 **쪼갠다**:
 *   · `placementLocked` = **스쿼드 밖에서 선수를 데려오지 않는다**(보유 선수 시트·Auto·초기화·제거)
 *   · `lineupEditable`  = 포메이션 변경 + **선발끼리** 자리 바꾸기를 연다
 * 통째로 풀면 경기 스쿼드 밖 선수를 후반에 투입할 수 있게 되고(서버는 400 으로 막지만 **화면이
 * 거짓말을 한다**), 통째로 잠그면 hero 결정을 못 지킨다.
 *
 * 박제하는 것:
 *   ① 포메이션을 바꾸면 `formation` 이 실린다
 *   ② 선발끼리 자리를 바꾸면 `starters` 배치가 바뀐다
 *   ③ 교체 + 배치 동시 → **집합 불변식**(전반 선발 − outs + ins)
 *   ④ 아무것도 안 건드려도 전반과 같은 배치를 **그대로 전송**(콜0 판정은 서버)
 *   ⑤ 재마운트 후 제출도 배치를 포함 — 1R blocker-1 회귀 가드
 *   ⑥ 스냅샷 없는 구 매치 → 배치 미전송 + #244 현행 교체 동작 유지
 *   ⑦ 만료 시 포메이션 셀렉트·보드가 잠긴다
 *   ⑧ 스쿼드 밖 선수를 데려올 수 없다(#244 계약 유지)
 *   ⑨ 세 필드가 **한 번의** `/halftime` 호출에 함께 실린다
 *   ⑩ 기준 라인업은 **매치 스냅샷**이다 — `useDeck()` 이 아니다(서버 ROSTER_MISMATCH 계약)
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 전반에 실제로 쓴 라인업(매치 스냅샷) — 서버가 `starters` 를 대조하는 기준. */
const SNAP_STARTERS = ["GK1", "D1", "D2", "D3", "D4", "M1", "M2", "M3", "M4", "F1", "F2"];
const SNAP_BENCH = ["B1", "B2"];

const fx = vi.hoisted(() => {
  const SNAP = ["GK1", "D1", "D2", "D3", "D4", "M1", "M2", "M3", "M4", "F1", "F2"];
  return {
    /**
     * **현재 덱은 스냅샷과 다르다** — 전반 시작 후 유저가 덱을 고친 상황. 기준을 덱으로 잡으면
     * 서버가 400 `ROSTER_MISMATCH` 를 낸다(변이체 킬 ③이 여기서 죽는다).
     */
    deck: {
      id: "d1",
      formation: "4-3-3",
      teamPrompt: null,
      slots: [
        ...SNAP.slice(0, 10).map((playerId, i) => ({
          playerId, role: "starter", slotIndex: i, promptText: null,
        })),
        { playerId: "X9", role: "starter", slotIndex: 10, promptText: null },
        { playerId: "B1", role: "bench", slotIndex: 0, promptText: null },
      ],
    },
    players: [
      { id: "GK1", name: "골리", position: "GK", grade: "GOLD", owned: true, ownedCount: 1 },
      ...["D1", "D2", "D3", "D4"].map((id) => ({
        id, name: `수비${id}`, position: "DF", grade: "SILVER", owned: true, ownedCount: 1,
      })),
      ...["M1", "M2", "M3", "M4"].map((id) => ({
        id, name: `미드${id}`, position: "MF", grade: "SILVER", owned: true, ownedCount: 1,
      })),
      ...["F1", "F2"].map((id) => ({
        id, name: `공격${id}`, position: "FW", grade: "GOLD", owned: true, ownedCount: 1,
      })),
      { id: "B1", name: "벤치하나", position: "FW", grade: "BRONZE", owned: true, ownedCount: 1 },
      { id: "B2", name: "벤치둘", position: "MF", grade: "BRONZE", owned: true, ownedCount: 1 },
      { id: "X9", name: "덱에만있는선수", position: "FW", grade: "BRONZE", owned: true, ownedCount: 1 },
    ],
    submitPrompt: vi.fn(async () => ({})),
    halftime: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
  };
});

vi.mock("../api/hooks", () => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  return {
    useDeck: () => query(fx.deck),
    usePlayers: () => query(fx.players),
    useSubmitMatchPrompt: () => ({ mutateAsync: fx.submitPrompt, isPending: false }),
    useHalftime: () => ({ mutateAsync: fx.halftime, isPending: false }),
    useResume: () => ({ mutateAsync: fx.resume, isPending: false }),
  };
});

// eslint-disable-next-line import/first
import { HalftimePanel } from "./HalftimePanel";
// eslint-disable-next-line import/first
import { stubDraftHandle } from "./halftime-draft-fixture";

interface Body {
  substitutions: Array<{ out: string; in: string }>;
  teamTactics?: Record<string, number>;
  formation?: string;
  starters?: Array<{ playerId: string; slotIndex: number }>;
}

function clock(remainingMs = 47_000) {
  const now = Date.now();
  return {
    phase: "HALFTIME",
    kickoffAt: new Date(now - 600_000).toISOString(),
    phaseStartAt: new Date(now - (60_000 - remainingMs)).toISOString(),
    phaseEndsAt: new Date(now + remainingMs).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: 180_000,
    halftimeMs: 60_000,
    seekForwardBlocked: true,
    seekGraceMs: 1_500,
  };
}

const snapshot = () => ({
  formation: "4-4-2",
  starters: SNAP_STARTERS.map((playerId, i) => ({ playerId, slotIndex: i, promptText: null })),
  bench: SNAP_BENCH.map((playerId, i) => ({ playerId, slotIndex: i, promptText: null })),
  teamTactics: { line: 0.25, press: 0.5, tempo: 0.5, width: 0.5 },
});

function renderPanel(opts: { snapshot?: unknown; remainingMs?: number } = {}) {
  const match = {
    id: "m1",
    state: "HALFTIME",
    clock: clock(opts.remainingMs ?? 47_000),
    userDeckSnapshot: "snapshot" in opts ? opts.snapshot : snapshot(),
  };
  return render(h(HalftimePanel, { match: match as never, draft: stubDraftHandle() }));
}

function body(): Body {
  const calls = fx.halftime.mock.calls as unknown as Array<[Body]>;
  return calls[calls.length - 1]![0];
}

/** 서버 계약과 **같은 식**: 전반 선발 − outs + ins. */
function expectedSet(subs: Array<{ out: string; in: string }> = []): Set<string> {
  const set = new Set(SNAP_STARTERS);
  for (const s of subs) {
    set.delete(s.out);
    set.add(s.in);
  }
  return set;
}

async function submit() {
  fireEvent.click(screen.getByTestId("resume-button"));
  await waitFor(() => expect(fx.halftime).toHaveBeenCalled());
}

/** 자리 바꾸기 = 보드 모드 탭 → 선발 두 명 탭(교체와 **같은 두 번 탭** 제스처). */
function swap(aId: string, bId: string) {
  fireEvent.click(screen.getByTestId("halftime-mode-move"));
  fireEvent.click(screen.getByTestId(`token-${aId}`));
  fireEvent.click(screen.getByTestId(`token-${bId}`));
}

/** 교체 = #244 의 교체 모드(보드에서 뺄 선수 → 벤치에서 넣을 선수). */
function sub(outId: string, inId: string) {
  fireEvent.click(screen.getByTestId("halftime-mode-sub"));
  fireEvent.click(screen.getByTestId(`token-${outId}`));
  fireEvent.click(screen.getByTestId(`token-${inId}`));
}

function slotOf(starters: Body["starters"], playerId: string): number | undefined {
  return starters?.find((s) => s.playerId === playerId)?.slotIndex;
}

afterEach(() => {
  cleanup();
  fx.halftime.mockClear();
  fx.resume.mockClear();
  fx.submitPrompt.mockClear();
});

describe("HalftimePanel — 감독시간 배치 (#276)", () => {
  it("⑩ 기준 라인업은 매치 스냅샷이다 — 현재 덱이 아니다(서버 ROSTER_MISMATCH 계약)", async () => {
    renderPanel();
    // 덱에만 있는 X9 는 보드에 없고, 스냅샷의 F2 가 있다.
    expect(screen.queryByTestId("token-X9")).toBeNull();
    expect(screen.getByTestId("token-F2")).toBeTruthy();

    await submit();
    expect(new Set(body().starters!.map((s) => s.playerId))).toEqual(expectedSet());
    // 포메이션도 스냅샷(4-4-2)이지 덱(4-3-3)이 아니다.
    expect(body().formation).toBe("4-4-2");
  });

  it("④ 아무것도 안 건드려도 전반과 **같은 배치를 그대로 전송**한다(콜0 판정은 서버)", async () => {
    renderPanel();
    await submit();
    const b = body();
    expect(b.substitutions).toEqual([]);
    expect(b.formation).toBe("4-4-2");
    expect(b.starters).toHaveLength(11);
    expect(slotOf(b.starters, "GK1")).toBe(0);
    expect(slotOf(b.starters, "F2")).toBe(10);
  });

  it("① 포메이션을 바꾸면 formation 이 실린다", async () => {
    renderPanel();
    fireEvent.change(screen.getByTestId("formation-select"), { target: { value: "4-3-3" } });
    await submit();
    expect(body().formation).toBe("4-3-3");
    expect(body().starters).toHaveLength(11);
  });

  it("② 선발끼리 자리를 바꾸면 starters 배치가 바뀐다", async () => {
    renderPanel();
    swap("F1", "F2"); // 9번 ↔ 10번
    await submit();
    const b = body();
    expect(slotOf(b.starters, "F1")).toBe(10);
    expect(slotOf(b.starters, "F2")).toBe(9);
    // 사람은 그대로 — 자리만 바뀐다.
    expect(new Set(b.starters!.map((s) => s.playerId))).toEqual(expectedSet());
  });

  it("③⑨ 교체 + 배치 + 전술이 한 번의 호출에 함께 실린다(집합 불변식 유지)", async () => {
    renderPanel();
    swap("F1", "F2");
    sub("M1", "B2"); // out M1(5번) / in B2
    fireEvent.click(screen.getByTestId("halftime-mode-say"));
    fireEvent.click(screen.getByTestId("team-tune-toggle"));
    fireEvent.click(screen.getByTestId("tactics-line-step-4"));

    await submit();
    expect(fx.halftime).toHaveBeenCalledTimes(1); // 한 번의 /halftime 에 세 필드
    const b = body();
    expect(b.substitutions).toEqual([{ out: "M1", in: "B2" }]);
    expect(b.teamTactics).toEqual({ line: 1, press: 0.5, tempo: 0.5, width: 0.5 });
    expect(b.formation).toBe("4-4-2");
    // 집합 불변식: 투입 선수 포함 · out 선수 제외
    expect(new Set(b.starters!.map((s) => s.playerId))).toEqual(expectedSet([{ out: "M1", in: "B2" }]));
    // 투입 선수는 나간 선수가 서 있던 슬롯을 물려받는다
    expect(slotOf(b.starters, "B2")).toBe(5);
    // 자리 바꾸기도 살아 있다
    expect(slotOf(b.starters, "F1")).toBe(10);
  });

  it("⑤ 재마운트(state 초기화) 후 제출도 배치를 포함한다 — blocker-1 회귀 가드", async () => {
    const first = renderPanel();
    swap("F1", "F2");
    await submit();
    expect(slotOf(body().starters, "F1")).toBe(10);

    // /resume 이 완료되지 않아 화면을 다시 연 상태 = 보드가 스냅샷 원본에서 재시작.
    first.unmount();
    fx.halftime.mockClear();
    renderPanel();
    await submit();
    const b = body();
    // 배치를 빼면 서버에 남은 이전 배치가 substitutions:[] 와 어긋나 400 고착이다.
    expect(b.formation).toBe("4-4-2");
    expect(b.starters).toHaveLength(11);
    expect(slotOf(b.starters, "F1")).toBe(9);
  });

  it("⑥ 스냅샷 없는 구 매치 → 배치 미전송 + #244 현행 교체 동작 유지", async () => {
    renderPanel({ snapshot: null });
    // 보낼 데가 없는 손잡이는 만들지 않는다.
    expect(screen.queryByTestId("formation-select")).toBeNull();
    expect(screen.queryByTestId("halftime-mode-move")).toBeNull();
    // 보드는 덱에서 파생된다(#244 현행) — 덱에만 있는 X9 가 보인다.
    expect(screen.getByTestId("token-X9")).toBeTruthy();

    sub("M1", "B1");
    expect(screen.getByTestId("sub-chip-0")).toBeTruthy();
    await submit();
    const b = body();
    expect(b.substitutions).toEqual([{ out: "M1", in: "B1" }]);
    expect(b.formation).toBeUndefined();
    expect(b.starters).toBeUndefined();
  });

  it("⑦ 만료되면 포메이션 셀렉트·보드가 잠긴다", () => {
    renderPanel({ remainingMs: -1_000 });
    expect(screen.getByTestId("halftime-countdown").textContent).toContain("감독시간 종료");
    expect((screen.getByTestId("formation-select") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("halftime-mode-move") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("halftime-mode-sub") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("resume-button") as HTMLButtonElement).disabled).toBe(true);

    // 모드 탭이 잠겼어도 보드 탭 자체가 배치를 바꾸면 안 된다(잠금은 한 겹이 아니다).
    fireEvent.click(screen.getByTestId("token-F1"));
    fireEvent.click(screen.getByTestId("token-F2"));
    expect(screen.getByTestId("board-slot-starter-9").textContent).toContain("공격F1");
  });

  it("⑧ 스쿼드 밖 선수를 데려올 수 없다 — 배치가 열려도 #244 계약은 그대로", () => {
    renderPanel();
    for (const id of ["pool-sheet-open", "auto-fill", "auto-fill-top", "board-reset", "board-empty-auto"]) {
      expect(screen.queryByTestId(id), `${id} 는 감독시간에 없어야 한다`).toBeNull();
    }
    // 자리 바꾸기 모드에서도 벤치 줄은 펴지지 않는다(선발끼리만 바꾼다 — 벤치는 교체 소관).
    fireEvent.click(screen.getByTestId("halftime-mode-move"));
    expect(screen.queryByTestId("board-bench-section")).toBeNull();
    // 선수를 골라도 [이 자리 선수 바꾸기](= 보유 선수 시트)는 없다.
    fireEvent.click(screen.getByTestId("halftime-mode-say"));
    fireEvent.click(screen.getByTestId("token-M1"));
    expect(screen.queryByTestId("rail-swap-player")).toBeNull();
    expect(screen.queryByTestId("rail-remove-player")).toBeNull();
  });

  it("자리 바꾸기 모드에서 벤치 선수는 보드에 없다 → 교체는 subs 만 만든다", async () => {
    renderPanel();
    swap("F1", "F2");
    await submit();
    expect(body().substitutions).toEqual([]); // 자리 바꾸기는 교체가 아니다
  });
});
