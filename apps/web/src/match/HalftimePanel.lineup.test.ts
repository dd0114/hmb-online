// @vitest-environment jsdom
/**
 * 감독시간 라인업 보드 — #276 W2 웹 (hero 결정: **덱 구성과 같은 조작으로 통일**).
 *
 * 그전까지 이 화면의 교체는 OUT/IN 셀렉트 2개 + [추가] 였다 — 덱에서 손가락으로 옮기던 사람이
 * 감독시간엔 드롭다운을 뒤지는, 같은 일에 다른 손잡이였다. 이제 **덱 보드를 그대로 가져다** 쓰고
 * (TacticsBoard · tap-place · movePlayerToSlot · formation-select) 제스처 하나를 서버의 두 필드
 * (`substitutions` / `formation+starters`)로 분해한다.
 *
 * 박제하는 것:
 *   ① 보드 시작 상태 = **매치 스냅샷**(현재 덱이 아니다 — 전반 시작 후 덱을 고쳐도 경기와 같은 라인업)
 *   ② 벤치→선발 탭 = 교체 1건 · 선발↔선발 탭 = 배치만(교체 0건)
 *   ③ 포메이션 셀렉트 = formation
 *   ④ **안 건드리면 배치를 아예 안 보낸다**(#215 콜0) · 교체만 했으면 배치도 안 보낸다
 *   ⑤ ≤3·GK≥1 위반은 기존 validateSubs 이슈 + [후반 시작] 잠금
 *   ⑥ 스냅샷 null(구 매치) → 보드를 숨기고 기존 셀렉트 폴백(기능 소실 금지)
 *   ⑦ 세 필드가 **한 번의 /halftime 호출**에 함께 실린다
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const fx = vi.hoisted(() => {
  const starters: Array<[string, number]> = [
    ["GK1", 0], ["D1", 1], ["D2", 2], ["D3", 3], ["D4", 4],
    ["M1", 5], ["M2", 6], ["M3", 7], ["M4", 8], ["F1", 9], ["F2", 10],
  ];
  const bench: Array<[string, number]> = [["B1", 0], ["B2", 1], ["B3", 2], ["B4", 3]];
  const posOf = (id: string) =>
    id === "GK1" || id === "B4" ? "GK" : id.startsWith("D") ? "DF" : id.startsWith("F") ? "FW" : "MF";
  const ids = [...starters, ...bench].map(([id]) => id);
  // ⚠️ 덱(useDeck)은 **일부러 다른 라인업**이다 — 전반 시작 후 덱을 고친 유저를 재현한다.
  // 보드가 스냅샷이 아니라 덱에서 출발하면 여기서 잡힌다.
  const deckIds = ["GK1", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10"];
  return {
    posOf,
    deck: {
      id: "d1",
      formation: "4-3-3",
      teamPrompt: null,
      slots: [
        ...deckIds.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
        { playerId: "B1", role: "bench", slotIndex: 0, promptText: null },
        { playerId: "B2", role: "bench", slotIndex: 1, promptText: null },
      ],
    },
    players: [...ids, ...deckIds.filter((id) => id !== "GK1")].map((id) => ({
      id,
      name: `이름${id}`,
      position: posOf(id),
      grade: "SILVER",
      owned: true,
      ownedCount: 1,
    })),
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

type Body = {
  substitutions: Array<{ out: string; in: string }>;
  teamTactics?: Record<string, number>;
  formation?: string;
  starters?: Array<{ playerId: string; slotIndex: number }>;
};

function snapshot(formation = "4-4-2") {
  return {
    formation,
    starters: STARTERS.map(([playerId, slotIndex]) => ({ playerId, slotIndex })),
    bench: BENCH.map(([playerId, slotIndex]) => ({ playerId, slotIndex })),
    teamTactics: { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 },
  };
}

function renderPanel(userDeckSnapshot: ReturnType<typeof snapshot> | null = snapshot()) {
  const match = { id: "m1", state: "HALFTIME", clock: null, userDeckSnapshot };
  return render(h(HalftimePanel, { match: match as never }));
}

/** 보드 슬롯 탭(탭-투-플레이스 = 1급 배치 수단, #106). */
function tap(role: "starter" | "bench", slotIndex: number) {
  fireEvent.click(screen.getByTestId(`board-slot-${role}-${slotIndex}`));
}

/** role/slotIndex 자리에 서 있는 선수 id (없으면 null). */
function occupantOf(role: "starter" | "bench", slotIndex: number): string | null {
  const cell = screen.getByTestId(`board-slot-${role}-${slotIndex}`);
  const token = cell.querySelector("[data-testid^='token-']");
  return token ? token.getAttribute("data-testid")!.replace("token-", "") : null;
}

async function submit(): Promise<Body> {
  fireEvent.click(screen.getByTestId("resume-button"));
  await waitFor(() => expect(fx.halftime).toHaveBeenCalled());
  const calls = fx.halftime.mock.calls as unknown as Array<[Body]>;
  return calls[calls.length - 1]![0];
}

afterEach(() => {
  cleanup();
  fx.halftime.mockClear();
  fx.resume.mockClear();
  fx.submitPrompt.mockClear();
});

describe("① 보드 시작 상태 = 매치 스냅샷", () => {
  it("현재 덱이 아니라 스냅샷의 라인업·포메이션을 그린다", () => {
    renderPanel();
    // 스냅샷(4-4-2 / F2@10)이 이긴다 — 덱은 4-3-3 이고 10번에 X10 이 서 있다.
    expect(occupantOf("starter", 10)).toBe("F2");
    expect(occupantOf("bench", 0)).toBe("B1");
    expect((screen.getByTestId("halftime-formation-select") as HTMLSelectElement).value).toBe("4-4-2");
    expect(screen.queryByTestId("token-X10")).toBeNull();
  });

  it("덱 보드를 그대로 쓴다 — 피치·벤치가 한 카드(board-card) 안에 있다", () => {
    renderPanel();
    const card = screen.getByTestId("board-card");
    expect(card.contains(screen.getByTestId("tactics-board"))).toBe(true);
    expect(card.contains(screen.getByTestId("board-bench"))).toBe(true);
  });
});

describe("② 제스처 하나 → 두 필드", () => {
  it("벤치 선수를 선발 슬롯에 탭하면 교체 1건으로 잡힌다", async () => {
    renderPanel();
    tap("bench", 0); // B1 집기
    tap("starter", 10); // F2 자리에 놓기 → swap
    expect(occupantOf("starter", 10)).toBe("B1");
    expect(occupantOf("bench", 0)).toBe("F2");

    const list = screen.getByTestId("sub-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list.textContent).toContain("이름F2");
    expect(list.textContent).toContain("이름B1");

    const body = await submit();
    expect(body.substitutions).toEqual([{ out: "F2", in: "B1" }]);
  });

  it("확정된 교체는 텍스트 목록에서 취소할 수 있다(보드도 되돌아간다)", async () => {
    renderPanel();
    tap("bench", 0);
    tap("starter", 10);
    fireEvent.click(screen.getByTestId("sub-remove-0"));
    expect(occupantOf("starter", 10)).toBe("F2");
    const body = await submit();
    expect(body.substitutions).toEqual([]);
  });

  it("선발끼리 슬롯을 옮기면 배치만 바뀌고 교체는 빈 채로 남는다", async () => {
    renderPanel();
    tap("starter", 9); // F1 선택
    tap("starter", 10); // F2 와 자리 교환
    const body = await submit();
    expect(body.substitutions).toEqual([]);
    expect(body.formation).toBe("4-4-2");
    expect(body.starters).toContainEqual({ playerId: "F1", slotIndex: 10 });
    expect(body.starters).toContainEqual({ playerId: "F2", slotIndex: 9 });
    expect(body.starters).toHaveLength(11);
  });

  it("포메이션 셀렉트를 바꾸면 formation 이 실린다(덱과 같은 셀렉트)", async () => {
    renderPanel();
    fireEvent.change(screen.getByTestId("halftime-formation-select"), { target: { value: "4-3-3" } });
    const body = await submit();
    expect(body.formation).toBe("4-3-3");
    expect(body.starters).toHaveLength(11);
  });
});

describe("③ 무변경이면 안 보낸다 (#215 콜0)", () => {
  it("아무것도 안 건드리면 formation·starters 를 아예 보내지 않는다", async () => {
    renderPanel();
    const body = await submit();
    expect(body.substitutions).toEqual([]);
    expect(body.formation).toBeUndefined();
    expect(body.starters).toBeUndefined();
  });

  it("교체만 하고 슬롯은 그대로면 배치를 보내지 않는다(나간 선수 슬롯을 물려받았을 뿐)", async () => {
    renderPanel();
    tap("bench", 1); // B2
    tap("starter", 9); // F1 자리
    const body = await submit();
    expect(body.substitutions).toEqual([{ out: "F1", in: "B2" }]);
    expect(body.formation).toBeUndefined();
    expect(body.starters).toBeUndefined();
  });
});

describe("④ 검증 — 기존 validateSubs 이슈 + 후반 시작 잠금", () => {
  it("교체 4건이면 SUBS_MAX 이슈가 뜨고 [후반 시작]이 잠긴다", () => {
    renderPanel();
    const moves: Array<[number, number]> = [
      [0, 10],
      [1, 9],
      [2, 8],
      [3, 7],
    ];
    for (const [benchIdx, starterIdx] of moves) {
      tap("bench", benchIdx);
      tap("starter", starterIdx);
    }
    expect(screen.getByTestId("sub-issue-SUBS_MAX")).toBeTruthy();
    expect((screen.getByTestId("resume-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("GK 를 빼고 필드 선수를 넣으면 GK_REQUIRED 로 잠긴다", () => {
    renderPanel();
    tap("bench", 0); // B1 = MF
    tap("starter", 0); // GK1 자리
    expect(screen.getByTestId("sub-issue-GK_REQUIRED")).toBeTruthy();
    expect((screen.getByTestId("resume-button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("⑤ 스냅샷 없는 구 매치 — 폴백(기능 소실 금지)", () => {
  it("보드를 숨기고 기존 OUT/IN 셀렉트로 교체할 수 있다", async () => {
    renderPanel(null);
    expect(screen.queryByTestId("board-card")).toBeNull();
    expect(screen.queryByTestId("halftime-formation-select")).toBeNull();

    fireEvent.change(screen.getByTestId("sub-out-select"), { target: { value: "X1" } });
    fireEvent.change(screen.getByTestId("sub-in-select"), { target: { value: "B1" } });
    fireEvent.click(screen.getByTestId("sub-add"));
    expect(within(screen.getByTestId("sub-list")).getAllByRole("listitem")).toHaveLength(1);

    const body = await submit();
    expect(body.substitutions).toEqual([{ out: "X1", in: "B1" }]);
    expect(body.formation).toBeUndefined();
    expect(body.starters).toBeUndefined();
  });
});

describe("⑥ 제출 — 세 필드가 한 요청에", () => {
  it("교체·전술·배치를 한 번의 /halftime 호출에 함께 싣는다(왕복 1회)", async () => {
    renderPanel();
    // 교체 1건
    tap("bench", 0);
    tap("starter", 10);
    // 배치 변경(투입 선수를 다른 자리로)
    tap("starter", 10);
    tap("starter", 5);
    // 전술 1축
    fireEvent.click(screen.getByTestId("halftime-tactics-line-step-4"));

    const body = await submit();
    expect(fx.halftime).toHaveBeenCalledTimes(1);
    expect(body.substitutions).toEqual([{ out: "F2", in: "B1" }]);
    expect(body.teamTactics).toMatchObject({ line: 1 });
    expect(body.formation).toBe("4-4-2");
    expect(body.starters).toContainEqual({ playerId: "B1", slotIndex: 5 });
    expect(body.starters?.some((s) => s.playerId === "F2")).toBe(false);
    expect(fx.resume).toHaveBeenCalledTimes(1);
  });
});

describe("⑦ 서버 거절(400 SHAPE_INVALID)은 사람이 읽을 수 있게 뜬다", () => {
  it("배치 검증 실패 메시지가 ErrorToast 로 나온다(조용한 실패 금지)", async () => {
    renderPanel();
    fireEvent.change(screen.getByTestId("halftime-formation-select"), { target: { value: "4-3-3" } });
    const api = Object.assign(new Error("배치의 선발이 교체 결과와 다릅니다"), {
      name: "ApiError",
      status: 400,
      code: "SHAPE_INVALID",
      detail: { rule: "ROSTER_MISMATCH" },
    });
    fx.halftime.mockRejectedValueOnce(api);

    fireEvent.click(screen.getByTestId("resume-button"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("배치의 선발이 교체 결과와 다릅니다"));
    // 실패했으면 후반을 시작하지 않는다.
    expect(fx.resume).not.toHaveBeenCalled();
  });
});

describe("⑧ 감독시간 종료 — 보드도 잠근다", () => {
  it("expired 면 보드 탭이 먹지 않는다(전술 스텝 disabled 와 같은 규칙)", () => {
    const match = {
      id: "m1",
      state: "HALFTIME",
      // 이미 지난 마감 → useCountdown 이 0 을 돌려준다(phaseRemainingMs).
      clock: {
        phase: "HALFTIME",
        phaseEndsAt: new Date(Date.now() - 60_000).toISOString(),
        serverNow: new Date().toISOString(),
      },
      userDeckSnapshot: snapshot(),
    };
    render(h(HalftimePanel, { match: match as never }));
    tap("bench", 0);
    tap("starter", 10);
    expect(occupantOf("starter", 10)).toBe("F2");
  });
});
