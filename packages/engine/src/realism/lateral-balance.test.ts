import { describe, it, expect } from "vitest";
import type { MatchLog, TeamSide } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

/**
 * 좌우(y) 대칭 계약 (#25, §2.5 E2E-TDD 회귀 가드).
 *
 * 버그: decideOffBall 의 폭확장 tie-break `baseFx.y < center ? -1 : 1` 이 정확히 중앙(y=center)에
 * 있는 선수(4-3-3 의 ST·CM)를 **항상 +y(아래)** 로 밀어, 지원/로밍 당김의 피드백으로 전체 공격이
 * 피치 아래쪽으로 쏠렸다. 결과: 슛의 96%가 하프 아래에서(6 vs 520), 코너의 98.6%가 같은 쪽 깃발
 * (top 3 vs bottom 213) → "코너가 매번 같은 쪽에서 반복"되는 관전 단조로움(코드 주석 contest.ts:672
 * 의 shooter.y 기반 코너-side 다양화가 입력(shooter.y) 편향 때문에 무력화됨).
 *
 * 픽스: 중앙 선수를 idHash 패리티로 좌/우로 결정적 분배(Math.random 없음) → 공격이 양쪽 폭을 쓰고
 * 슛/코너가 좌우로 고르게 분포한다. 이 테스트는 그 대칭을 박제(수정 전엔 FAIL).
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

function collect(): { shotYbelow: number; shotYabove: number; cornerTop: number; cornerBottom: number; shotMeanY: number } {
  const centerM = cfg.pitch.height / 2;
  let below = 0, above = 0, cornerTop = 0, cornerBottom = 0;
  const shotYs: number[] = [];
  for (const seed of REALISM_SEEDS) {
    const home = makeTacticalInput("H", seed);
    const away = makeTacticalInput("A", seed);
    const log: MatchLog = runMatch(seed, home, away, select, cfg);
    const ballByTick = new Map<number, { x: number; y: number }>();
    for (const sn of log.tickSnapshots) ballByTick.set(sn.tick, sn.ball);
    for (const e of log.events) {
      if (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target") {
        const b = ballByTick.get(e.tick);
        if (!b) continue;
        shotYs.push(b.y);
        if (b.y < centerM - 0.5) below++;
        else if (b.y > centerM + 0.5) above++;
      }
      if (e.type === "kickoff" && e.detail === "corner") {
        const b = ballByTick.get(e.tick);
        if (!b) continue;
        if (b.y < centerM) cornerTop++;
        else cornerBottom++;
      }
    }
  }
  const shotMeanY = shotYs.reduce((s, v) => s + v, 0) / (shotYs.length || 1);
  return { shotYbelow: below, shotYabove: above, cornerTop, cornerBottom, shotMeanY };
}

const m = collect();

describe("좌우(y) 대칭 — 공격이 한쪽으로 쏠리지 않음 (#25)", () => {
  it(`슛 origin y 가 중앙에 균형 (mean ${m.shotMeanY.toFixed(2)}m, center ${cfg.pitch.height / 2}m)`, () => {
    // 수정 전 mean≈36.96(치우침). 픽스 후 center(34)±2.5m 안.
    expect(Math.abs(m.shotMeanY - cfg.pitch.height / 2)).toBeLessThanOrEqual(2.5);
  });
  it(`슛이 상/하 하프에 고르게 (below ${m.shotYbelow} / above ${m.shotYabove})`, () => {
    const tot = m.shotYbelow + m.shotYabove;
    const minShare = Math.min(m.shotYbelow, m.shotYabove) / tot;
    // 수정 전 below/above = 6/520 (minShare≈0.011). 각 하프 최소 30%.
    expect(minShare).toBeGreaterThanOrEqual(0.3);
  });
  it(`코너가 위/아래 깃발에 고르게 (top ${m.cornerTop} / bottom ${m.cornerBottom})`, () => {
    const tot = m.cornerTop + m.cornerBottom;
    const minShare = Math.min(m.cornerTop, m.cornerBottom) / tot;
    // 수정 전 top/bottom = 3/213 (minShare≈0.014). 각 쪽 최소 30% → "매번 같은 코너" 회귀 차단.
    expect(minShare).toBeGreaterThanOrEqual(0.3);
  });
});
