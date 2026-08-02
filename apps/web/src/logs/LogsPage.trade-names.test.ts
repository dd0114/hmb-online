// @vitest-environment jsdom
/**
 * 트레이드 이력 줄의 **선수 이름** 계약 (#406 W1c — 4차 독립검증 MINOR-2 "죽은 표현").
 *
 * <p>이 줄은 `detail.target as {name?: string}` → `target?.name` 이었고, 서버는 그 자리에
 * **문자열 playerId** 를 넣는다(`TradeService.logTrade`). 즉 <b>항상 undefined</b> — 트레이드
 * 이력에 선수 이름이 한 번도 뜬 적이 없다. 캐스트가 컴파일을 통과시켜 타입 게이트도 조용했다.
 *
 * <p>그래서 이 계약의 표본은 **서버 모양 그대로**(`detail.target` = `"P077"` 문자열)다 —
 * 목이 서버와 다른 모양을 흉내내면 그 테스트는 자기가 만든 세계를 검증한다
 * (`apps/web/CLAUDE.md` admin #342 가 같은 방식으로 라이브 결함을 3개월 덮었다).
 *
 * <p>작성 규칙: root vitest include 가 `apps/**\/*.test.ts` 라 JSX 대신 createElement.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogPlayer } from "../api/hooks";
import type { TradeLogItem } from "../api/v2";

/** 서버가 실제로 쓰는 detail 모양 — `target` 은 **문자열 playerId** 다. */
const TRADE_LOGS: TradeLogItem[] = [
  {
    id: 11,
    kind: "FA",
    result: "SUCCESS",
    detail: { target: "P077", offered: [], points: 300, probability: 0.4, roll: 0.2 },
    createdAt: "2026-08-02T09:00:00Z",
  } as unknown as TradeLogItem,
  {
    // 카탈로그가 모르는 선수(회수된 유닛 / 카탈로그 미도착) — 이름 조각은 생략되지만 **id 는 안 샌다**.
    id: 12,
    kind: "TRADE",
    result: "FAIL",
    detail: { target: "P900", offered: ["P001"], points: 0 },
    createdAt: "2026-08-02T10:00:00Z",
  } as unknown as TradeLogItem,
  {
    // 손상/구 detail — 던지지 않는다.
    id: 13,
    kind: "FA",
    result: "EXPIRED",
    detail: {},
    createdAt: "2026-08-02T11:00:00Z",
  } as unknown as TradeLogItem,
];

/**
 * 카탈로그 행 — `shortName` 은 **#411 스위치 후** 모양이다(축 계약을 여기서 잰다).
 *
 * <p>⚠️ 이 필드가 없으면 `full`/`short` 두 축의 값이 **같아져** 축을 바꾸는 변이가 통과한다
 * (4차 리뷰 시점의 이 파일이 정확히 그 상태였다 — `"full"` → `"short"` 변이가 3건 전부 생존).
 * 형제 계약 3개(`PlayerAvatar` · `TradeResultModal` · `ProposeBuilder`)는 이미 이 모양이다.
 */
const PLAYERS: CatalogPlayer[] = [
  {
    id: "P077",
    name: "크바라츠헬리아",
    shortName: "크바라츠",
    position: "FW",
    grade: "DIA",
    owned: true,
    ownedCount: 1,
    attributes: {
      technical: 80, mental: 80, physical: 80, passing: 80, shooting: 90,
      tackling: 50, pace: 85, stamina: 80, positioning: 88,
    },
  } as unknown as CatalogPlayer,
];

const useTradeLogs = vi.fn(() => ({ data: TRADE_LOGS, isLoading: false, isError: false }));
const usePlayers = vi.fn(() => ({ data: PLAYERS }));

vi.mock("../api/hooks-v2", () => ({
  useMatchLogs: () => ({ data: [], isLoading: false, isError: false }),
  useTradeLogs: () => useTradeLogs(),
  useRankings: () => ({ data: undefined, isLoading: true, isError: false }),
}));
vi.mock("../api/hooks", () => ({
  usePlayers: () => usePlayers(),
}));

import { LogsPage } from "./LogsPage";

function openTradeTab() {
  render(h(MemoryRouter, { initialEntries: ["/logs"] }, h(LogsPage)));
  fireEvent.click(screen.getByTestId("logs-tab-trades"));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("트레이드 이력 — 선수 이름 (#406)", () => {
  it("★ `detail.target`(문자열 id)을 카탈로그 이름으로 옮긴다 — 죽은 표현 회귀 가드", () => {
    openTradeTab();
    // 신선도 — 표본이 서버 모양(문자열)이고, 카탈로그가 그 선수를 실제로 안다.
    expect(typeof (TRADE_LOGS[0]!.detail as Record<string, unknown>).target).toBe("string");
    expect(PLAYERS.some((p) => p.id === "P077")).toBe(true);

    const row = screen.getByTestId("trade-log-target-11").textContent ?? "";
    expect(row).toContain("FA 영입");
    // ★ 변이: `detail.target as {name}` 로 되돌리면 이름 조각이 통째로 사라진다.
    expect(row).toContain("크바라츠헬리아");
    // ★ 변이: `· ${detail.target}` 로 id 를 그대로 그리면 죽는다.
    expect(row).not.toContain("P077");
  });

  /**
   * ★ 변이 킬 — `names.resolve(targetId, "short")` 로 바꾸면 죽는다. 이 줄은 `[FA 영입 · 이름]`
   * 한 덩어리로 행의 주 텍스트를 통째로 쓰는 자리라 <b>full</b> 이다(옆 결과 뱃지는 이름과 폭을
   * 다투지 않는다). 오늘은 서버가 `shortName` 을 안 줘서 두 축이 같지만(#411), 스위치가 켜지면
   * 이 줄만 짧은 이름으로 갈린다.
   */
  it("축은 full — 행의 주 텍스트라 짧은 이름이 아니다 (#411 스위치 후)", () => {
    // 신선도 — 픽스처에서 두 축이 **실제로 다른 값**이다(같으면 이 계약이 공허하다).
    const row0 = PLAYERS[0] as unknown as { name: string; shortName: string };
    expect(row0.shortName).not.toBe(row0.name);

    openTradeTab();
    const row = screen.getByTestId("trade-log-target-11").textContent ?? "";
    expect(row).toContain("FA 영입 · 크바라츠헬리아");
    expect(row.trim()).not.toBe("FA 영입 · 크바라츠"); // 짧은 축이면 이 모양이 된다
  });

  it("카탈로그가 모르면 이름 조각을 생략한다 — **id 를 대신 그리지 않는다**", () => {
    openTradeTab();
    const row = screen.getByTestId("trade-log-target-12").textContent ?? "";
    expect(row).toContain("트레이드");
    expect(row).not.toContain("P900");
    expect(row.trim()).toBe("트레이드"); // 로딩·미상 상태에서 화면이 흔들리지 않는다
  });

  it("`detail` 이 비거나 target 이 없어도 줄이 그려진다(던지지 않는다)", () => {
    openTradeTab();
    expect(screen.getByTestId("trade-log-target-13").textContent?.trim()).toBe("FA 영입");
    expect(screen.getByTestId("trade-log-13")).toBeTruthy();
  });
});
