import { describe, it, expect } from "vitest";
import { skinKeyOf, skinLookup } from "./skin-key.mjs";
import { buildAnnotations, buildStoppages } from "./playback.mjs";
import { ownerSideOf } from "./owner-side.mjs";

/**
 * #324 — **같은 playerId 가 양 팀에 있을 때** 코어가 팀을 구분하는가.
 *
 * <p>왜 이 파일이 따로 필요한가(독립검증 blocker-1): e2e 픽스처(데모·real 로그)의 선수 id 는
 * `H0/A0…` 라 **양 팀에 걸쳐 유일**하다. 그래서 코어의 팀 인지 로직을 전부 되돌려도
 * `npx playwright test` 가 62/62 통과했다 — 중복 id 경로를 **구조적으로 밟지 못하기 때문**이다.
 * 라이브는 그렇지 않다: 유저 덱과 봇 로스터가 선수 카탈로그를 공유해 **하프의 38%** 가 중복 1명
 * 이상이고, 문제의 경기는 6명이었다. 그 조건을 픽스처로 만들어 여기서 태운다.
 */

/** 라이브 01KYSQP…S0RFTD 전반의 실제 중복 구성(축약): P078 이 양 팀에 있다. */
const dupSnap = (over: Record<string, unknown> = {}) => ({
  tick: 10,
  minute: 0,
  ball: { x: 20, y: 34 },
  ballOwner: "P078",
  players: [
    { playerId: "P074", team: "home", pos: { x: 5, y: 34 } },
    { playerId: "P078", team: "home", pos: { x: 21, y: 34 } }, // 공에서 1m
    { playerId: "P078", team: "away", pos: { x: 87, y: 34 } }, // 67m
    { playerId: "P116", team: "away", pos: { x: 99, y: 34 } },
  ],
  ...over,
});

describe("스킨 조회 키 — 팀 우선, 구 페이로드 폴백", () => {
  it("팀 키가 있으면 그것을 쓴다(같은 선수라도 팀마다 다른 값)", () => {
    const nums = { "home:P078": "3", "away:P078": "5" };
    expect(skinLookup(nums, "home", "P078")).toBe("3");
    expect(skinLookup(nums, "away", "P078")).toBe("5");
  });

  it("팀 키가 없는 구 페이로드는 단독 키로 읽힌다(무회귀)", () => {
    const legacy = { P078: "9" };
    expect(skinLookup(legacy, "home", "P078")).toBe("9");
    expect(skinLookup(legacy, "away", "P078")).toBe("9");
  });

  it("팀 키가 단독 키를 이긴다 — 섞여 있어도 팀 값이 먼저다", () => {
    expect(skinLookup({ P078: "9", "away:P078": "5" }, "away", "P078")).toBe("5");
  });

  it("skinKeyOf: 팀이 없으면 단독 키로 떨어진다(팀을 모르는 소비자)", () => {
    expect(skinKeyOf("home", "P078")).toBe("home:P078");
    expect(skinKeyOf(undefined, "P078")).toBe("P078");
  });

  it("없는 값은 undefined — 남의 팀 값을 대신 돌려주지 않는다", () => {
    expect(skinLookup({ "home:P078": "3" }, "away", "P078")).toBeUndefined();
  });
});

describe("공 소유팀 — 중복 id 에서 갈린다", () => {
  it("공에 가까운 쪽이 소유자다(id 만으로는 결정 불가)", () => {
    expect(ownerSideOf(dupSnap())).toBe("home");
    expect(ownerSideOf(dupSnap({ ball: { x: 88, y: 34 } }))).toBe("away");
  });
});

describe("정지·토스트 앵커 — 팀까지 실려야 반대편 선수에 붙지 않는다", () => {
  const fouler = { type: "foul", tick: 30, minute: 0, team: "away", playerId: "P078" };

  it("파울 접촉 앵커에 팀이 실린다", () => {
    const st = buildStoppages([fouler, { type: "free_kick", tick: 34 }]);
    const s = st.find((x: { causeTick: number }) => x.causeTick === 30);
    expect(s, "파울 정지").toBeTruthy();
    expect(s!.contactAnchor).toBe("P078");
    expect(s!.contactAnchorTeam, "팀이 없으면 렌더가 양 팀 P078 중 먼저 찾은 쪽으로 줌한다").toBe("away");
  });

  it("토스트 앵커에도 팀이 실린다", () => {
    const a = buildAnnotations([fouler], [dupSnap({ tick: 30 })]);
    const toast = a.find((x: { kind: string; anchor?: string }) => x.kind === "toast" && x.anchor === "P078");
    expect(toast, "파울 토스트").toBeTruthy();
    expect(toast!.anchorTeam).toBe("away");
  });

  it("카드 토스트 앵커도 마찬가지", () => {
    const a = buildAnnotations(
      [{ type: "card", tick: 40, minute: 0, team: "home", playerId: "P078", detail: "yellow" }],
      [dupSnap({ tick: 40 })],
    );
    const toast = a.find((x: { kind: string; anchor?: string }) => x.kind === "toast" && x.anchor === "P078");
    expect(toast).toBeTruthy();
    expect(toast!.anchorTeam).toBe("home");
  });
});
