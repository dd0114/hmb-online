// @vitest-environment jsdom
/**
 * 보상 성장 목록의 **선수명 사다리·두 축** 계약 (#406 요구 6, W8).
 *
 * <p>이 행은 <b>두 화면이 공유</b>한다 — 보상 시트 `성장` 탭과 <b>결과 화면의 성장 리포트</b>
 * (`match/GrowthReportSection` 이 `GrowthRows` 를 그대로 재사용한다). 그래서 여기 한 줄이
 * 경기 직후 화면과 결과 화면 <b>둘 다</b>를 정한다.
 *
 * <h3>스캐너가 이 파일을 구조적으로 못 본다</h3>
 * 옮기기 전 코드는 `entry.name` <b>직독</b>이었고, 이 파일엔 <b>조회(`find`/`get`)가 없다</b> —
 * AST 스캐너는 "컬렉션에서 찾은 행의 `name`"을 금지하는 것이라 조회 없는 프롭 접근은
 * 기재된 미탐 경계(파일을 넘는 프롭)다. 그래서 <b>되돌리는 변이가 전 스위트를 통과</b>했다
 * (apps/web CLAUDE.md "#423 축은 각 파일이 자기 계약을 박는다").
 *
 * <h3>왜 `entry.name` 직독이 틀렸나 — 값이 <b>정산 시점 스냅샷</b>이다</h3>
 * 서버가 정산할 때 박아 보낸 이름이라 그 뒤의 카탈로그 개명(어드민 개명 · #411 스위치)을
 * 따라오지 않는다. 사다리 규율 그대로 <b>카탈로그가 이기고, 카탈로그가 모를 때만</b> 이 값을 쓴다.
 *
 * <p>표본은 <b>#411 스위치 후</b> 모양이다(`shortName ≠ name`) — 오늘 라이브처럼 두 축이 같은
 * 표본으로 재면 축 변이가 전부 생존한다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_PLAYER_NAME } from "../../common/player-names";
import { resetCharAssetsCache } from "../../common/char-assets-store";
import type { RewardGrowthEntry } from "../types";

const mocks = vi.hoisted(() => ({ players: [] as unknown }));

/** 훅 하나만 목으로 — 이름 사다리 본체(`buildPlayerNames`)는 **진짜를 쓴다**. */
vi.mock("../../api/hooks", () => ({ usePlayers: () => ({ data: mocks.players }) }));

import { GrowthRows } from "./GrowthSection";

/**
 * `shortName` 이 풀네임과 다르고 **이니셜까지 갈리는** 표본.
 * ⚠️ 흔한 shortName(예: `레프 야신` → `야신`)은 `initialsOf` 가 둘 다 `야신` 으로 접어서
 * **아바타 축 계약이 공허해진다**(한글 규칙 = 마지막 토큰 2자). 실제 표기 중 그렇지 않은 쌍을 쓴다.
 */
const CATALOG = [{ id: "P077", name: "크바라츠헬리아", shortName: "흐비차", position: "FW", grade: "DIA" }];

const entry = (over: Partial<RewardGrowthEntry> & { playerId: string }): RewardGrowthEntry =>
  ({
    name: "SERVER SNAPSHOT NAME",
    position: "FW",
    // 등급을 **모르는** 값으로 둬서 아트 정책(#285 fail-closed)이 CSS 이니셜 폴백을 타게 한다 —
    // 아바타가 받은 이름을 `initialsOf` 결과로 **눈에 보이게** 만드는 것이 이 표본의 목적이다.
    grade: null,
    xpGained: 120,
    minutes: "starter",
    ...over,
  }) as RewardGrowthEntry;

function draw(entries: RewardGrowthEntry[]) {
  render(h(GrowthRows, { entries }));
}

beforeEach(() => {
  resetCharAssetsCache();
  // 아트 축은 이 계약의 관심사가 아니다 — 매니페스트를 못 받아도 이름은 그려져야 한다.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.players = [];
});

describe("행 이름 — 밀집 축(`short`)이고, 카탈로그가 서버 스냅샷을 이긴다", () => {
  it("1단 — 카탈로그가 아는 선수면 **서버가 준 이름을 덮는다**", () => {
    mocks.players = CATALOG;
    draw([entry({ playerId: "P077" })]);
    const row = screen.getByTestId("growth-row-name-P077").textContent;
    expect(row).toBe("흐비차");
    // ★ 변이: `entry.name` 직독으로 되돌리면 죽는다.
    expect(row).not.toBe("SERVER SNAPSHOT NAME");
    // ★ 변이: `names.full` 로 축을 바꾸면 죽는다.
    expect(row).not.toBe("크바라츠헬리아");
  });

  it("2단 — 카탈로그가 모르면 서버가 준 이름으로 떨어진다 (폴백이 죽어 있지 않다)", () => {
    mocks.players = [];
    draw([entry({ playerId: "P900", name: "은퇴한 선수" })]);
    expect(screen.getByTestId("growth-row-name-P900").textContent).toBe("은퇴한 선수");
  });

  it("3단 — 둘 다 없으면 `미상 선수`. **playerId 가 새지 않는다**", () => {
    mocks.players = [];
    draw([entry({ playerId: "P900", name: "" })]);
    const row = screen.getByTestId("growth-row-name-P900").textContent ?? "";
    expect(row).toBe(UNKNOWN_PLAYER_NAME);
    expect(row).not.toBe("P900");
    expect(row).not.toMatch(/^[A-Za-z]{1,2}\d+$/);
  });

  /** 서버가 옛 습관대로 id 를 이름 자리에 실어 보내도 화면엔 안 나온다(초크포인트 백스톱). */
  it("서버가 이름 자리에 id 를 실어 보내도 화면엔 `미상 선수` 다", () => {
    mocks.players = [];
    draw([entry({ playerId: "P900", name: "P900" })]);
    expect(screen.getByTestId("growth-row-name-P900").textContent).toBe(UNKNOWN_PLAYER_NAME);
  });
});

describe("아바타 — **넓은 축**(`full`). 이니셜은 풀네임 전제다", () => {
  /**
   * `initialsOf` 는 풀네임 전제(apps/web CLAUDE.md 두 축 표)라 짧은 축을 넘기면 규칙이 어긋난다.
   * 등급을 모르는 표본이라 아트 정책이 CSS 이니셜 폴백을 타고, 그 글자가 곧 관측점이다.
   */
  it("이니셜이 풀네임에서 나온다 (`흐비차` 가 아니다)", () => {
    mocks.players = CATALOG;
    draw([entry({ playerId: "P077" })]);
    const fallback = document.querySelector('[data-art-policy="hidden"]');
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toBe("크바"); // initialsOf("크바라츠헬리아")
    // ★ 변이: 아바타에 `short` 를 넘기면 `흐비` 가 되어 죽는다.
    expect(fallback!.textContent).not.toBe("흐비");
  });

  /** 한 행이 두 축을 **동시에** 쓴다는 것이 계약이다 — 하나로 합치면 이 단언이 죽는다. */
  it("같은 행에서 이름은 short, 아바타는 full 이다", () => {
    mocks.players = CATALOG;
    draw([entry({ playerId: "P077" })]);
    expect(screen.getByTestId("growth-row-name-P077").textContent).toBe("흐비차");
    expect(document.querySelector('[data-art-policy="hidden"]')!.textContent).toBe("크바");
  });
});
