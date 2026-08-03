// @vitest-environment jsdom
/**
 * 선수 상세 모달 **헤더 이름**의 사다리·축 계약 (#406 요구 6, W8).
 *
 * <p>옮기기 전:
 * <pre>
 *   const name = meta?.name ?? catalogPlayer?.name ?? playerId;
 * </pre>
 * 사다리 3단이 <b>`playerId`</b> 였다 — 카탈로그에 행이 없는 선수(발행 사고·은퇴)를 열면 모달
 * 제목에 <b>`P077` 이 그대로</b> 떴다. 지금은 `playerNameOf(catalogPlayer, "full")` 하나다.
 *
 * <h3>축 = `full`</h3>
 * 모달 헤더 `<h2>` 는 한 줄을 통째로 쓰는 자리다(apps/web CLAUDE.md 두 축 표 = 카드 상세·헤더는
 * `full`). 같은 경기의 <b>선수 탭 표 행</b>은 `short` 다 — 한 화면 안에서 자리에 따라 축이 갈리는 것이
 * 설계이고, 오늘은 두 축의 값이 같아 <b>화면 차이가 0</b>이라 계약 없이는 #411 스위치 날에야 드러난다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다.
 */
import { createElement as h } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_PLAYER_NAME } from "../common/player-names";
import { resetCharAssetsCache } from "../common/char-assets-store";
import type { MatchPlayerStats } from "./usePlayerStats";

const mocks = vi.hoisted(() => ({ players: [] as unknown }));

vi.mock("../api/hooks", () => ({
  usePlayers: () => ({ data: mocks.players }),
  useDeck: () => ({ data: null }),
}));
vi.mock("../api/growth-hooks", () => ({ useCardEffective: () => ({ data: undefined }) }));
/** 능력치 레이어는 이 계약의 대상이 아니다(자기 계약이 따로 있다) — 스텁으로 끊는다. */
vi.mock("../growth/AttributeLayers", () => ({ AttributeLayers: () => null }));

import { PlayerDetailModal } from "./PlayerDetailModal";

/** `shortName` 이 풀네임과 다른 표본 = #411 스위치 후. `P900` 은 카탈로그에 **없다**. */
const CATALOG = [
  {
    id: "P077",
    name: "크바라츠헬리아",
    shortName: "흐비차",
    position: "FW",
    grade: "DIA",
    owned: false,
    ownedCount: 0,
    attributes: {},
  },
];

const STATS: MatchPlayerStats = {
  result: null,
  roster: new Map(),
  coverage: null,
  window: { kind: "settled", uptoTick: null, caption: null, shortLabel: null },
  isLoading: false,
  isError: false,
};

function headerTextFor(playerId: string): string {
  render(
    h(PlayerDetailModal, {
      selection: { team: "home", playerId },
      stats: STATS,
      teamName: "우리팀",
      mine: false,
      onClose: () => {},
    }),
  );
  return document.getElementById(`pdetail-title-home-${playerId}`)?.textContent ?? "";
}

beforeEach(() => {
  resetCharAssetsCache();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.players = [];
});

describe("헤더 이름 — 넓은 축(`full`)", () => {
  it("카탈로그가 아는 선수는 **풀네임**이다", () => {
    mocks.players = CATALOG;
    const text = headerTextFor("P077");
    expect(text).toContain("크바라츠헬리아");
    // ★ 변이: `short` 로 축을 바꾸면 죽는다(`흐비차` 는 풀네임의 부분문자열이 아니다).
    expect(text).not.toContain("흐비차");
  });

  /** ★ 이 웨이브의 본체 — 3단이 `playerId` 였다. */
  it("카탈로그가 모르는 선수는 `미상 선수` — **`P900` 이 아니다**", () => {
    mocks.players = CATALOG;
    const text = headerTextFor("P900");
    expect(text).toContain(UNKNOWN_PLAYER_NAME);
    expect(text).not.toContain("P900");
  });

  /** `/api/players` 가 배열이 아닐 수 있다(구 서버·목의 `200 {}`) — 모달이 살아 있고 id 도 안 샌다. */
  it("카탈로그 응답이 배열이 아니어도 모달이 뜨고 id 가 새지 않는다", () => {
    mocks.players = {};
    const text = headerTextFor("P077");
    expect(text).toContain(UNKNOWN_PLAYER_NAME);
    expect(text).not.toContain("P077");
  });
});
