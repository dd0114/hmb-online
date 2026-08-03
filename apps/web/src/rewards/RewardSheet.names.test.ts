// @vitest-environment jsdom
/**
 * 보상 시트 **선택 헤드**("누구의 레벨업을 고르는 중인가")의 선수명 계약 (#406 요구 6, W8).
 *
 * <p>옮기기 전엔 `pickedPlayer.name` <b>직독</b>이었다 — 정산 시점 스냅샷이라 카탈로그 개명
 * (어드민 개명 · #411 스위치)을 따라오지 않는다. 이 파일엔 조회(`find`)가 있어서 AST 스캐너가
 * 실제로 잡아 줬지만, <b>축</b>(`full` vs `short`)은 스캐너가 어떤 형태로도 못 본다.
 *
 * <h3>축 = `full`</h3>
 * `.pickName` 은 `display:block` + 줄임표라 <b>한 줄을 통째로</b> 쓰고, 포지션·등급·★ 는
 * 아랫줄(`.pickMeta`)에 앉는다. 같은 시트의 성장 <b>목록 행</b>은 밀집이라 `short` 다
 * (`sections/GrowthSection.names.test.ts`) — <b>한 시트가 두 축을 쓰는 것이 정상</b>이고,
 * 축은 파일이 아니라 그 조각이 앉은 자리가 정한다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_PLAYER_NAME } from "../common/player-names";
import { resetCharAssetsCache } from "../common/char-assets-store";
import type { RewardBundle, RewardGrowthEntry } from "./types";

const CHOICE = {
  choiceId: "c1",
  playerId: "P077",
  level: 4,
  candidates: [{ stat: "shooting", gain: 2 }],
};

const mocks = vi.hoisted(() => ({ players: [] as unknown }));

vi.mock("../api/hooks", () => ({ usePlayers: () => ({ data: mocks.players }) }));
vi.mock("../api/growth-hooks", () => ({
  useCardEffective: () => ({ data: undefined }),
  usePendingChoices: () => ({ data: [CHOICE] }),
}));
vi.mock("./rewards-hooks", () => ({ useAckReward: () => ({ mutate: () => {}, isPending: false }) }));
/**
 * 후보 카드는 이 계약의 대상이 아니고 `useNavigate` 를 쓴다(라우터 필요) — 스텁으로 끊는다.
 * ⚠️ 이름 사다리 본체(`buildPlayerNames`)는 목으로 갈지 않는다.
 */
vi.mock("../growth/ChoiceCards", () => ({
  ChoiceCandidates: () => null,
  candidateView: () => ({ from: null, to: null }),
}));

import { RewardSheet } from "./RewardSheet";

/** `shortName` 이 풀네임과 다른 표본 = #411 스위치 후. 오늘 모양(두 축 동일)으로는 축 변이가 산다. */
const CATALOG = [{ id: "P077", name: "크바라츠헬리아", shortName: "흐비차", position: "FW", grade: "DIA" }];

const ENTRY = {
  playerId: "P077",
  name: "SERVER SNAPSHOT NAME",
  position: "FW",
  grade: null,
  xpGained: 300,
  minutes: "starter",
  levelBefore: 4,
  levelAfter: 5,
  pendingChoices: [CHOICE],
} as unknown as RewardGrowthEntry;

function bundleWith(e: RewardGrowthEntry): RewardBundle {
  return {
    bundleId: "b1",
    source: "MATCH",
    sourceRef: "m1",
    acknowledgedAt: null,
    sections: [{ kind: "GROWTH", entries: [e] }],
  };
}

/** 시트를 열고 성장 행을 눌러 **선택 헤드**까지 간다. */
function openPick(e: RewardGrowthEntry = ENTRY) {
  render(h(RewardSheet, { bundle: bundleWith(e), matchId: "m1", onClose: () => {} }));
  fireEvent.click(screen.getByTestId(`growth-row-${e.playerId}`));
  return screen.getByTestId("reward-pick-name");
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

describe("선택 헤드 이름 — 넓은 축(`full`) + 카탈로그 우선", () => {
  it("1단 — 카탈로그가 아는 선수면 서버 스냅샷 이름을 덮고, **풀네임**이다", () => {
    mocks.players = CATALOG;
    const text = openPick().textContent;
    expect(text).toBe("크바라츠헬리아");
    // ★ 변이: `pickedPlayer.name` 직독으로 되돌리면 죽는다.
    expect(text).not.toBe("SERVER SNAPSHOT NAME");
    // ★ 변이: `names.short` 로 축을 바꾸면 죽는다(목록 행과 같은 축이 아니다).
    expect(text).not.toBe("흐비차");
  });

  it("2단 — 카탈로그가 모르면 서버가 준 이름 (폴백이 죽어 있지 않다)", () => {
    mocks.players = [];
    expect(openPick().textContent).toBe("SERVER SNAPSHOT NAME");
  });

  it("3단 — 둘 다 없으면 `미상 선수`. **playerId 가 새지 않는다**", () => {
    mocks.players = [];
    const text = openPick({ ...ENTRY, name: "" } as RewardGrowthEntry).textContent ?? "";
    expect(text).toBe(UNKNOWN_PLAYER_NAME);
    expect(text).not.toBe("P077");
  });

  /**
   * 아바타는 `full` 이다(`initialsOf` 는 풀네임 전제). 등급을 모르는 표본이라 아트 정책(#285)이
   * CSS 이니셜 폴백을 타고, 그 글자가 관측점이다.
   */
  it("헤드 아바타 이니셜도 풀네임에서 나온다", () => {
    mocks.players = CATALOG;
    openPick();
    const fallbacks = [...document.querySelectorAll('[data-art-policy="hidden"]')].map((n) => n.textContent);
    expect(fallbacks).toContain("크바"); // initialsOf("크바라츠헬리아")
    expect(fallbacks).not.toContain("흐비"); // initialsOf("흐비차") = short 를 넘긴 변이
  });
});
