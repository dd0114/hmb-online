// @vitest-environment jsdom
/**
 * W3 트레이드 슬롯 상태별 렌더 스모크(AC-D) — 라이브 스택 없이 jsdom 에서 TradePage 를 실제로
 * 렌더해 3슬롯(WAITING/OPEN-FA/OPEN-TRADE)이 각기 다른 UI 로 그려지는지 본다. 훅은 wholesale
 * mock(라우팅/데이터흐름 아님 — 순수 로직은 trade-logic·propose-builder 테스트가 박제).
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
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

const slots: TradeSlot[] = [
  { slot: 1, state: "WAITING", remainingSec: 125, speedupCost: 300, offerKind: null, target: null, demand: null },
  {
    slot: 2, state: "OPEN", offerKind: "FA",
    target: { playerId: "FA9", name: "FA-스트라이커", position: "FW", grade: "DIA" },
    demand: null, targetValue: 88,
  },
  {
    slot: 3, state: "OPEN", offerKind: "TRADE",
    target: { playerId: "TR7", name: "대가-미드", position: "MF", grade: "GOLD" },
    demand: { playerId: "MINE1", name: "내-수비수", position: "DF", grade: "SILVER" },
    acceptProbability: 0.8,
  },
];

const fx = vi.hoisted(() => ({
  tradeData: undefined as unknown,
  players: undefined as unknown,
}));

vi.mock("../api/hooks-v2", () => ({
  useTradeSlots: () => ({ data: fx.tradeData, isLoading: false, isError: false }),
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
    expect(screen.getByTestId("trade-slot-3-decline")).toBeTruthy();
  });
});
