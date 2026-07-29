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
 *   ④ 보드 모드면 **배치를 항상 보낸다** — #215 콜0의 본질은 "안 보낸다"가 아니라 "**AI 콜이 0**"
 *      이고 그 판정은 서버가 한다(전반과 같은 배치 = 무변경 = 콜0,
 *      `HalftimeShapeTest.resubmittingTheSameShapeIsNotAChange`). 웹이 조건부로 빼면 서버
 *      `COALESCE` 가 **이전 배치를 살려** ⓐ 400 고착 ⓑ 취소한 배치가 후반에 반영된다.
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
    /** `/api/players` 가 아직 안 온 상태를 만들 스위치(minor-2 — 로딩 중 헛경고 금지). */
    playersLoaded: true,
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
    usePlayers: () => (fx.playersLoaded ? query(fx.players) : { data: undefined, isLoading: true, isError: false, isSuccess: false }),
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
  fx.playersLoaded = true;
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

describe("③ 보드 모드는 배치를 항상 보낸다 — 콜0은 서버가 판정한다 (#215)", () => {
  it("아무것도 안 건드리면 **전반과 같은 배치**를 그대로 실어 보낸다(서버 판정 무변경 → 콜0)", async () => {
    renderPanel();
    const body = await submit();
    expect(body.substitutions).toEqual([]);
    expect(body.formation).toBe("4-4-2");
    expect(body.starters).toHaveLength(11);
    expect(body.starters).toContainEqual({ playerId: "F2", slotIndex: 10 });
  });

  it("교체만 하고 슬롯은 그대로여도 배치를 싣는다(승계 배치 = 서버 판정 무변경 → 콜0)", async () => {
    renderPanel();
    tap("bench", 1); // B2
    tap("starter", 9); // F1 자리
    const body = await submit();
    expect(body.substitutions).toEqual([{ out: "F1", in: "B2" }]);
    expect(body.formation).toBe("4-4-2");
    expect(body.starters).toContainEqual({ playerId: "B2", slotIndex: 9 });
    expect(body.starters?.some((s) => s.playerId === "F1")).toBe(false);
  });

  /**
   * blocker-1 — `POST /resume` 이 완료되지 않은 채(네트워크 끊김·탭 종료·리로드) 화면을 다시 열면
   * 보드는 `boardDraft=null` 로 재마운트되어 스냅샷 원본에서 다시 시작한다. 그때 배치를 빼면
   * 서버에 남은 이전 배치가 새 `substitutions:[]` 와 어긋나 **400 ROSTER_MISMATCH 로 고착**된다.
   */
  it("재마운트(보드 초기화) 후 제출도 배치를 포함한다 — 이전 배치가 서버에 살아남지 않게", async () => {
    const first = renderPanel();
    tap("bench", 0); // B1 → F2 자리 (교체 + 배치 저장)
    tap("starter", 10);
    const before = await submit();
    expect(before.substitutions).toEqual([{ out: "F2", in: "B1" }]);
    fx.halftime.mockClear();

    first.unmount();
    renderPanel(); // resume 미완 → 화면 재진입
    expect(occupantOf("starter", 10)).toBe("F2"); // 보드는 스냅샷 원본

    const body = await submit();
    expect(body.substitutions).toEqual([]);
    expect(body.formation).toBe("4-4-2");
    expect(body.starters).toHaveLength(11);
    expect(body.starters?.some((s) => s.playerId === "B1")).toBe(false);
  });

  /**
   * blocker-2 — 배치만 바꿔 제출한 뒤 유저가 **원상복구**하고 재제출하면, 배치를 빼는 순간 서버
   * COALESCE 가 이전 배치를 남겨 **취소한 배치로 후반이 돈다**(400 도 안 뜬다).
   */
  it("배치를 바꿨다가 원상복구하면 base 배치를 명시 전송한다(취소가 취소로 남는다)", async () => {
    renderPanel();
    tap("starter", 9);
    tap("starter", 10); // F1 ↔ F2
    expect((await submit()).starters).toContainEqual({ playerId: "F1", slotIndex: 10 });
    fx.halftime.mockClear();

    tap("starter", 10); // F1 토큰을 집어
    tap("starter", 9); // 원래 자리로 되돌린다
    expect(occupantOf("starter", 9)).toBe("F1");
    const body = await submit();
    expect(body.formation).toBe("4-4-2");
    expect(body.starters).toContainEqual({ playerId: "F1", slotIndex: 9 });
    expect(body.starters).toContainEqual({ playerId: "F2", slotIndex: 10 });
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

  /** minor-2 — 카탈로그 로딩 중엔 posOf 가 전부 undefined 라 "GK 가 없다"로 보인다(헛경고). */
  it("카탈로그 로딩 중에는 GK 경고를 띄우지 않고 [후반 시작]도 잠그지 않는다", () => {
    fx.playersLoaded = false;
    renderPanel();
    expect(screen.queryByTestId("sub-issue-GK_REQUIRED")).toBeNull();
    expect((screen.getByTestId("resume-button") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("④-b 교체 취소 — base 로의 복귀다(major-2)", () => {
  it("투입 선수를 다른 자리로 옮긴 뒤 취소해도 선발 두 명이 뒤바뀌지 않는다", async () => {
    renderPanel();
    tap("bench", 0); // B1
    tap("starter", 10); // F2 자리 → 교체
    tap("starter", 10); // B1 집어서
    tap("starter", 9); // 9번(F1)과 자리 교환
    expect(occupantOf("starter", 9)).toBe("B1");
    expect(occupantOf("starter", 10)).toBe("F1");

    fireEvent.click(screen.getByTestId("sub-remove-0"));
    // 취소는 스냅샷 복귀다 — F1@9 · F2@10 · B1 은 벤치 0 으로.
    expect(occupantOf("starter", 9)).toBe("F1");
    expect(occupantOf("starter", 10)).toBe("F2");
    expect(occupantOf("bench", 0)).toBe("B1");

    const body = await submit();
    expect(body.substitutions).toEqual([]);
    expect(body.starters).toContainEqual({ playerId: "F1", slotIndex: 9 });
    expect(body.starters).toContainEqual({ playerId: "F2", slotIndex: 10 });
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
