// @vitest-environment jsdom
/**
 * `TradeResultModal` 의 **이탈 선수 이름 사다리** 계약 (#406 W1c — 4차 독립검증 MAJOR-1).
 *
 * <p>W1b 가 이 줄을 초크포인트로 옮겼는데 <b>계약이 없었다</b> — `result.released.name` 직독으로
 * 되돌리는 변이가 전 스위트를 통과했다. 스캐너가 못 잡는 이유는 `TradePlayerCard` 와 같다:
 * 조회(`catalog.get(...)`)는 <b>인자 자리에서 바로 소비</b>되고 `.name` 은 프롭 접근이라,
 * 되돌린 코드(`result.released.name`)에는 스캐너가 볼 <b>조회가 없다</b>.
 *
 * <h3>이 표면이 지금은 "차이 0" 이라는 것이 함정이다</h3>
 * 오늘 라이브에서는 카탈로그 이름 == 서버 `PlayerRef.name` 이라 어느 쪽을 읽어도 화면이 같다.
 * 갈리는 순간은 둘이다 — ①어드민 개명(카탈로그만 바뀐다) ②#411 스위치. 그때 이 한 줄만
 * 옛 이름으로 남는다. <b>차이가 0인 동안 박아 두는 것이 이 계약의 존재 이유다.</b>
 *
 * <p>작성 규칙: root vitest include 가 `apps/**\/*.test.ts` 라 JSX 대신 createElement.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradeResultModal } from "./TradeResultModal";
import { resetCharAssetsCache } from "../common/char-assets-store";
import { UNKNOWN_PLAYER_NAME } from "../common/player-names";
import type { CatalogPlayer } from "../api/hooks";
import type { PlayerRef, TradeResolveResponse } from "../api/v2";

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

/** 영입된 선수 — 이 계약의 대상이 아니다(카드 쪽 계약은 `TradePlayerCard.names.test.ts`). */
const ACQUIRED: PlayerRef = {
  playerId: "P200", name: "영입선수", position: "FW", grade: "GOLD",
} as PlayerRef;

/** 서버가 실어 보낸 이탈 선수 참조 — **옛 영어 이름**이 박제돼 있을 수 있다. */
const RELEASED: PlayerRef = {
  playerId: "P077", name: "Kvaratskhelia", position: "FW", grade: "DIA",
} as PlayerRef;

/** 카탈로그 행 — SoT. `shortName` 은 #411 스위치 후 모양(축 계약을 여기서 잰다). */
const RELEASED_IN_CATALOG = {
  id: "P077", name: "크바라츠헬리아", shortName: "크바라츠", position: "FW", grade: "DIA",
  owned: true, ownedCount: 1, attributes: attrs(85), personality: "CALM",
} as unknown as CatalogPlayer;

function renderResult(released: PlayerRef | null, catalogRows: CatalogPlayer[] = []) {
  const catalog = new Map<string, CatalogPlayer>(catalogRows.map((p) => [p.id, p]));
  const result = {
    result: "SUCCESS",
    acquired: ACQUIRED,
    released,
    slot: {},
  } as unknown as TradeResolveResponse;
  render(h(TradeResultModal, { result, catalog, onClose: () => {} }));
  return screen.getByTestId("trade-result-released").textContent ?? "";
}

describe("TradeResultModal 이탈 선수 이름 사다리 (#406)", () => {
  it("1단 — 카탈로그가 아는 선수면 **서버가 준 이름을 덮는다**", () => {
    const text = renderResult(RELEASED, [RELEASED_IN_CATALOG]);
    expect(text).toContain("크바라츠헬리아");
    // ★ 변이: `result.released.name` 직독으로 되돌리면 옛 이름이 남는다.
    expect(text).not.toContain("Kvaratskhelia");
  });

  it("2단 — 카탈로그가 모르면 서버가 준 이름으로 떨어진다 (폴백이 죽어 있지 않다)", () => {
    expect(renderResult(RELEASED)).toContain("Kvaratskhelia");
  });

  it("3단 — 둘 다 없으면 `미상 선수`. **`P077` 이 아니다**", () => {
    const text = renderResult({ ...RELEASED, name: "" } as PlayerRef);
    expect(text).toContain(UNKNOWN_PLAYER_NAME);
    expect(text).not.toContain("P077");
  });

  /**
   * ★ 변이 킬 — 축이 `short` 로 바뀌면 죽는다. 이 줄은 **문장 한 줄을 통째로 쓰는 자리**
   * ("… 선수가 팀을 떠났습니다")라 풀네임이다. 오늘은 서버가 `shortName` 을 안 줘서 두 축이
   * 같지만(#411), 스위치가 켜지면 이 문장만 짧은 이름으로 갈린다.
   */
  it("축은 full — 문장 안이므로 짧은 이름이 아니다 (#411 스위치 후)", () => {
    const text = renderResult(RELEASED, [RELEASED_IN_CATALOG]);
    expect(text).toContain("크바라츠헬리아");
    expect(text).not.toMatch(/크바라츠\s*선수가/); // 짧은 축이면 이 모양이 된다
  });

  it("이탈이 없으면 그 줄 자체가 없다 (FA 영입 등)", () => {
    const catalog = new Map<string, CatalogPlayer>();
    const result = {
      result: "SUCCESS", acquired: ACQUIRED, released: null, slot: {},
    } as unknown as TradeResolveResponse;
    render(h(TradeResultModal, { result, catalog, onClose: () => {} }));
    expect(screen.queryByTestId("trade-result-released")).toBeNull();
  });
});
