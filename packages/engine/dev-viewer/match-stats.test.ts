import { describe, it, expect } from "vitest";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, demoHome, demoAway, demoSelect } from "../src/fixtures";
import { computeMatchStats, ownerSideOfSnapshot } from "./match-stats";
import { ownerSideOf } from "../../viewer-core/src/owner-side.mjs";
import { loadRealDeckCase, COLLAPSE_CASE_ID } from "../src/realism/real-decks";

/**
 * 측정 계층이 **팀을 어떻게 아는가**에 대한 계약(#377 M0-2 선행 수리).
 *
 * `MatchLog.ballOwner` 는 순수 playerId 다(shared 계약). 종전 측정 코드는 `id.startsWith("H")`
 * 로 팀을 추측했는데, 그건 엔진 픽스처 id(`H9`/`A3`) 전용 가정이라 **실경기 id(`P0xx`)에서는
 * 전부 away** 로 떨어진다. 실덱 픽스처를 넣자마자 주행거리가 home 0 / away 63km 로 나왔다.
 * 같은 뿌리를 뷰어 쪽에서 먼저 고친 것이 #324 다.
 */

const gkIdsOf = (select: { home: { players: { playerId: string; position: string }[] }; away: { players: { playerId: string; position: string }[] } }): Set<string> => {
  const out = new Set<string>();
  for (const side of ["home", "away"] as const) {
    for (const p of select[side].players) if (p.position === "GK") out.add(p.playerId);
  }
  return out;
};

describe("ownerSideOfSnapshot", () => {
  const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);

  it("viewer-core 의 쌍둥이(ownerSideOf)와 모든 틱에서 같은 답을 낸다", () => {
    let compared = 0;
    for (const sn of log.tickSnapshots) {
      const a = ownerSideOfSnapshot(sn);
      const b = (ownerSideOf as (s: unknown) => string | null)(sn);
      expect(a).toBe(b);
      if (a) compared += 1;
    }
    expect(compared).toBeGreaterThan(100); // 비교가 실제로 일어났는지(빈 루프 green 방지)
  });

  it("id 접두사가 아니라 스냅샷의 team 을 본다 — 실덱 id 에서도 양 팀이 다 나온다", () => {
    const c = loadRealDeckCase(COLLAPSE_CASE_ID);
    const rl = runMatch(c.seed, c.homeInput, c.awayInput, c.selectData, defaultEngineConfig);
    const seen = new Set<string>();
    for (const sn of rl.tickSnapshots) {
      const s = ownerSideOfSnapshot(sn);
      if (s) seen.add(s);
    }
    expect([...seen].sort()).toEqual(["away", "home"]);
    // 접두사 추측이었다면 home 은 0틱이었다(모든 id 가 "P" 로 시작).
    expect(rl.tickSnapshots.every((sn) => !sn.ballOwner || !sn.ballOwner.startsWith("H"))).toBe(true);
  });
});

describe("computeMatchStats — 실덱 입력", () => {
  const c = loadRealDeckCase(COLLAPSE_CASE_ID);
  const log = runMatch(c.seed, c.homeInput, c.awayInput, c.selectData, defaultEngineConfig);
  const stats = computeMatchStats(log, gkIdsOf(c.selectData), { pitchWidthM: defaultEngineConfig.pitch.width });

  it("양 팀 모두 주행거리가 나온다(한쪽 0 = 팀 오분류)", () => {
    expect(stats.home.avgDistanceKm).toBeGreaterThan(0);
    expect(stats.away.avgDistanceKm).toBeGreaterThan(0);
  });

  it("주행거리가 물리적으로 가능한 범위다(선수 한 명이 한 하프에 20km 를 뛰지 않는다)", () => {
    // 두 인스턴스가 한 버킷에 합쳐지면 좌표가 두 사람 사이를 오가 63km/경기가 나왔다.
    for (const side of ["home", "away"] as const) {
      expect(stats[side].avgDistanceKm).toBeLessThan(20);
    }
  });

  it("양 팀 폭이 둘 다 측정된다", () => {
    expect(stats.home.avgWidthM).toBeGreaterThan(0);
    expect(stats.away.avgWidthM).toBeGreaterThan(0);
  });
});
