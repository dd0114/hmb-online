// @vitest-environment jsdom
/**
 * 트레이드 카드의 **이름 사다리** 계약 (#406 W1b — 4번째 발견).
 *
 * <p>이 표면만 우선순위가 <b>반대로</b> 돌고 있었다: 부모(`TradeSlotCard`)는
 * `catalog.get(playerId)` 로 카탈로그 행을 조인해 `detail` 로 넘기는데, 카드는 이름을
 * <b>서버 `PlayerRef.name`</b> 에서 읽었다. 사다리는 <b>카탈로그 → given → `미상 선수`</b> 다
 * (W0 결정: 과거 스냅샷에 박제된 옛 영어 이름을 카탈로그 한글 이름이 이긴다).
 *
 * <p>⚠️ 선수명 스캐너(`common/player-names.test.ts`)는 이 결함을 <b>구조적으로 못 잡는다</b> —
 * 조회는 부모 파일에 있고 이 파일은 프롭으로 행을 받을 뿐이라, 파일 단위 평면 집합에 걸릴 것이
 * 없다(스캐너 머리말 "파일을 넘는 프롭"). <b>그래서 여기에 직접 계약을 박는다.</b>
 *
 * <p>작성 규칙: root vitest include 가 `apps/**\/*.test.ts` 라 JSX 대신 createElement.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradePlayerCard } from "./TradePlayerCard";
import { resetCharAssetsCache } from "../common/char-assets-store";
import type { CatalogPlayer } from "../api/hooks";
import type { PlayerRef } from "../api/v2";

beforeEach(() => {
  resetCharAssetsCache();
  // 아트 축은 이 계약의 관심사가 아니다 — 매니페스트를 못 받아도 이름은 그려져야 한다.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

/** 서버가 실어 보낸 참조 — 과거 이름이 박제돼 있을 수 있다. */
const REF: PlayerRef = {
  playerId: "P077",
  name: "Kvaratskhelia",
  position: "FW",
  grade: "DIA",
} as PlayerRef;

/** 카탈로그 행 — SoT. 이름을 고치면 여기부터 바뀐다. */
const CATALOG = {
  id: "P077", name: "크바라츠헬리아", position: "FW", grade: "DIA",
  owned: true, ownedCount: 1, attributes: attrs(85), personality: "CALM",
} as unknown as CatalogPlayer;

describe("TradePlayerCard 이름 사다리 (#406)", () => {
  it("1단 — 카탈로그가 아는 선수면 **서버가 준 이름을 덮는다**", () => {
    render(h(TradePlayerCard, { player: REF, detail: CATALOG, testId: "c" }));
    expect(screen.getByText("크바라츠헬리아")).toBeTruthy();
    // ★ 변이: `player.name` 직독으로 되돌리면 옛 이름이 남는다.
    expect(screen.queryByText("Kvaratskhelia")).toBeNull();
  });

  it("2단 — 카탈로그가 모르면 서버가 준 이름으로 떨어진다(폴백이 죽어 있지 않다)", () => {
    render(h(TradePlayerCard, { player: REF, testId: "c" }));
    expect(screen.getByText("Kvaratskhelia")).toBeTruthy();
  });

  it("3단 — 둘 다 없으면 `미상 선수`. **playerId 가 아니다**", () => {
    render(h(TradePlayerCard, { player: { ...REF, name: "" } as PlayerRef, testId: "c" }));
    expect(screen.getByText("미상 선수")).toBeTruthy();
    expect(screen.queryByText("P077")).toBeNull();
  });

  it("풀아트 경로도 같은 이름을 쓴다 — 두 분기가 갈리지 않는다", () => {
    render(h(TradePlayerCard, { player: REF, detail: CATALOG, testId: "c", fullArt: true }));
    expect(screen.getByText("크바라츠헬리아")).toBeTruthy();
    expect(screen.queryByText("Kvaratskhelia")).toBeNull();
  });
});
