// @vitest-environment jsdom
/**
 * W3 트레이드 슬롯 상태별 렌더 스모크(AC-D) — 라이브 스택 없이 jsdom 에서 TradePage 를 실제로
 * 렌더해 4가지 상태(IDLE/WAITING/OPEN-FA/OPEN-TRADE)가 각기 다른 UI 로 그려지는지 본다.
 * #149 능동화: IDLE=[장 시작!], WAITING=등급만 공개(선수 정체 마스킹), OPEN=[거래 안함].
 * 훅은 wholesale mock(라우팅/데이터흐름 아님 — 순수 로직은 trade-logic·propose-builder 가 박제).
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradeSlot, TradeSlotsResponse } from "../api/v2";
import type { CatalogPlayer } from "../api/hooks";

const attrs = {
  technical: 70, mental: 70, physical: 70, passing: 70, shooting: 70,
  tackling: 70, pace: 70, stamina: 70, positioning: 70,
};
const cat = (id: string, over: Partial<CatalogPlayer> = {}): CatalogPlayer => ({
  id, name: `선수-${id}`, position: "MF", grade: "GOLD", owned: false, ownedCount: 0, attributes: attrs, ...over,
});

const waitingSlot: TradeSlot = {
  slot: 1, state: "WAITING", remainingSec: 125, speedupCost: 300,
  // #149: 등급만 공개 — 선수 정체(target/demand/targetValue)는 서버가 null 로 감춘다.
  targetGrade: "GOLD", offerKind: null, target: null, demand: null,
};
const faSlot: TradeSlot = {
  slot: 2, state: "OPEN", offerKind: "FA",
  target: { playerId: "FA9", name: "FA-스트라이커", position: "FW", grade: "DIA" },
  demand: null, targetValue: 88, targetGrade: "DIA",
};
const tradeSlot: TradeSlot = {
  slot: 3, state: "OPEN", offerKind: "TRADE",
  target: { playerId: "TR7", name: "대가-미드", position: "MF", grade: "GOLD" },
  demand: { playerId: "MINE1", name: "내-수비수", position: "DF", grade: "SILVER" },
  acceptProbability: 0.8, targetGrade: "GOLD",
};
/** WAITING 인데 이미 공개됐던 오퍼(FA 제안 실패 후 재제안 쿨타임) — 서버가 target 을 계속 채워 보낸다. */
const waitingRevealedSlot: TradeSlot = {
  slot: 2, state: "WAITING", remainingSec: 60, speedupCost: 120,
  offerKind: "FA", targetGrade: "DIA", targetValue: 88, demand: null,
  target: { playerId: "FA9", name: "FA-스트라이커", position: "FW", grade: "DIA" },
};
const slots: TradeSlot[] = [waitingSlot, faSlot, tradeSlot];

/** IDLE(장 닫힘) — 모든 오퍼 필드 null, [장 시작!] 대기. */
const idleSlot: TradeSlot = {
  slot: 1, state: "IDLE", offerKind: null, target: null, demand: null,
  targetGrade: null, speedupCost: null,
};

const fx = vi.hoisted(() => ({
  tradeData: undefined as unknown,
  players: undefined as unknown,
  startMutate: vi.fn(),
}));

vi.mock("../api/hooks-v2", () => ({
  useTradeSlots: () => ({ data: fx.tradeData, isLoading: false, isError: false }),
  useStartTrade: () => ({ mutate: fx.startMutate, isPending: false }),
  useSpeedupTrade: () => ({ mutate: vi.fn(), isPending: false }),
  useProposeFa: () => ({ mutate: vi.fn(), isPending: false }),
  useAcceptTrade: () => ({ mutate: vi.fn(), isPending: false }),
  useDeclineTrade: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/hooks")>();
  return { ...actual, usePlayers: () => ({ data: fx.players, isLoading: false, isError: false }) };
});

async function renderPage() {
  const { TradePage } = await import("./TradePage");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: ["/trade"] }, h(TradePage))),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TradePage 슬롯 상태별 렌더", () => {
  it("renders 3 slots with their distinct views", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [cat("MINE1", { owned: true, ownedCount: 1, grade: "SILVER", position: "DF" }), cat("FA9", { grade: "DIA" })];
    await renderPage();

    expect(screen.getByTestId("trade-slot-1").getAttribute("data-view")).toBe("WAITING");
    expect(screen.getByTestId("trade-slot-2").getAttribute("data-view")).toBe("OPEN_FA");
    expect(screen.getByTestId("trade-slot-3").getAttribute("data-view")).toBe("OPEN_TRADE");
  });

  it("WAITING shows a countdown + speedup button with cost", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [];
    await renderPage();

    const cd = screen.getByTestId("trade-slot-1-countdown");
    // 125s → 2:0x (초 단위는 tick 오차 허용). 최소 "2:" 로 시작.
    expect(cd.textContent).toMatch(/2:\d\d/);
    expect(screen.getByTestId("trade-slot-1-speedup")).toBeTruthy();
  });

  it("OPEN-FA shows the target card + propose builder, and NO pre-probability", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [cat("MINE1", { owned: true, ownedCount: 1 })];
    await renderPage();

    expect(screen.getByTestId("trade-slot-2-target")).toBeTruthy();
    expect(screen.getByTestId("propose-builder")).toBeTruthy();
    // 확률은 결과 전 표시 생략 — 안내 노트만.
    expect(screen.getByTestId("propose-prob-note")).toBeTruthy();
    expect(within(screen.getByTestId("trade-slot-2")).queryByTestId("trade-slot-2-prob")).toBeNull();
    // FA 오퍼 칩에 내 보유선수가 뜬다.
    expect(screen.getByTestId("propose-chip-MINE1")).toBeTruthy();
  });

  it("OPEN-TRADE shows demand↔target + server accept probability + accept/decline", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [];
    await renderPage();

    expect(screen.getByTestId("trade-slot-3-demand")).toBeTruthy();
    expect(screen.getByTestId("trade-slot-3-target")).toBeTruthy();
    expect(screen.getByTestId("trade-slot-3-prob").textContent).toContain("80%");
    expect(screen.getByTestId("trade-slot-3-accept")).toBeTruthy();
    // #149: 액션은 [수락] + [거래 안함] 둘뿐 — [거절] 은 제거됐다(start 와 구분 불가라 인지 부하).
    expect(within(screen.getByTestId("trade-slot-3")).queryByTestId("trade-slot-3-decline")).toBeNull();
    expect(screen.getByTestId("trade-slot-3-skip")).toBeTruthy();
  });
});

describe("TradePage 능동화 (#149)", () => {
  it("IDLE renders an empty market with a [장 시작!] button (no offer content)", async () => {
    fx.tradeData = { slots: [idleSlot, faSlot, tradeSlot], wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [];
    await renderPage();

    const card = screen.getByTestId("trade-slot-1");
    expect(card.getAttribute("data-view")).toBe("IDLE");
    expect(screen.getByTestId("trade-slot-1-badge").textContent).toContain("장 닫힘");
    expect(screen.getByTestId("trade-slot-1-start").textContent).toContain("장 시작!");
    // IDLE 에는 카운트다운·단축·오퍼 카드가 없다.
    expect(within(card).queryByTestId("trade-slot-1-countdown")).toBeNull();
    expect(within(card).queryByTestId("trade-slot-1-speedup")).toBeNull();
    expect(within(card).queryByTestId("trade-slot-1-target")).toBeNull();
  });

  it("[장 시작!] click calls the start mutation with the slot number", async () => {
    fx.tradeData = { slots: [idleSlot, faSlot, tradeSlot], wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [];
    await renderPage();

    fireEvent.click(screen.getByTestId("trade-slot-1-start"));
    expect(fx.startMutate).toHaveBeenCalledTimes(1);
    expect(fx.startMutate).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("WAITING reveals the grade only — the player identity stays masked", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [cat("FA9", { grade: "DIA" })];
    await renderPage();

    const card = screen.getByTestId("trade-slot-1");
    expect(screen.getByTestId("trade-slot-1-grade").textContent).toContain("골드");
    // 마스킹 회귀 가드: 대기 중에는 어떤 선수 카드/이름도 노출되지 않는다.
    expect(within(card).queryByTestId("trade-slot-1-target")).toBeNull();
    expect(within(card).queryByTestId("trade-slot-1-demand")).toBeNull();
    expect(card.textContent).not.toMatch(/선수-/);
    // WAITING 에는 장 시작/거래 안함 버튼이 없다(서버 400).
    expect(within(card).queryByTestId("trade-slot-1-start")).toBeNull();
    expect(within(card).queryByTestId("trade-slot-1-skip")).toBeNull();
  });

  it("WAITING(공개된 채 쿨타임) keeps the player card instead of the mask", async () => {
    fx.tradeData = {
      slots: [idleSlot, waitingRevealedSlot, tradeSlot], wallet: { points: 1000 },
    } satisfies TradeSlotsResponse;
    fx.players = [];
    await renderPage();

    const card = screen.getByTestId("trade-slot-2");
    expect(card.getAttribute("data-view")).toBe("WAITING");
    expect(card.getAttribute("data-reveal")).toBe("REVEALED");
    // 이미 본 선수를 도로 가리지 않는다 — 마스크 티저 대신 선수 카드.
    expect(within(card).queryByTestId("trade-slot-2-grade")).toBeNull();
    expect(screen.getByTestId("trade-slot-2-target")).toBeTruthy();
    expect(card.textContent).toContain("FA-스트라이커");
    // 쿨타임도 카운트다운 + 포인트 단축 대상.
    expect(screen.getByTestId("trade-slot-2-countdown").textContent).toContain("재제안까지");
    expect(screen.getByTestId("trade-slot-2-speedup")).toBeTruthy();
    // 대기 중이므로 제안/거래안함은 불가.
    expect(within(card).queryByTestId("propose-builder")).toBeNull();
    expect(within(card).queryByTestId("trade-slot-2-skip")).toBeNull();
  });

  it("WAITING(가려짐) still masks — data-reveal 로 두 분기를 구분한다", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [];
    await renderPage();

    const card = screen.getByTestId("trade-slot-1");
    expect(card.getAttribute("data-reveal")).toBe("MASKED");
    expect(screen.getByTestId("trade-slot-1-countdown").textContent).toContain("공개까지");
  });

  it("OPEN slots keep their offer UI and add a [거래 안함] button wired to start", async () => {
    fx.tradeData = { slots, wallet: { points: 1000 } } satisfies TradeSlotsResponse;
    fx.players = [cat("MINE1", { owned: true, ownedCount: 1 })];
    await renderPage();

    // FA: 기존 대상 카드/제안 빌더 유지 + 거래 안함.
    expect(screen.getByTestId("trade-slot-2-target")).toBeTruthy();
    expect(screen.getByTestId("propose-builder")).toBeTruthy();
    const faSkip = screen.getByTestId("trade-slot-2-skip");
    expect(faSkip.textContent).toContain("거래 안함");
    // TRADE: 기존 수락/거절 유지 + 거래 안함.
    expect(screen.getByTestId("trade-slot-3-accept")).toBeTruthy();
    expect(screen.getByTestId("trade-slot-3-skip")).toBeTruthy();

    fireEvent.click(faSkip);
    expect(fx.startMutate).toHaveBeenCalledTimes(1);
    expect(fx.startMutate).toHaveBeenCalledWith(2, expect.any(Object));
  });
});
