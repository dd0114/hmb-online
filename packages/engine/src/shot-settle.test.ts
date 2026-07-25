import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { runMatch, runFirstHalf, resumeSecondHalf } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect, makeTacticalInput, makeSelectData } from "./fixtures";
import { REALISM_SEEDS } from "./realism/harness";
import { buildShowcaseLog } from "../dev-viewer/generate-demo";

/**
 * 슛 결과 완결 계약 (#178 후속, §2.5 E2E-TDD — 고치기 전에 버그를 박제했다).
 *
 * ## 증상
 * 데모 t719(전반 **마지막 틱**)에 발사된 홈 슛이 유효/빗나감/골 어느 판정도 받지 못하고 증발해
 * `onTarget + offTarget(6) ≠ shots(7)` 이 됐다(apps/web `stats-rows.test.ts` 가 이 엔진 계약을 검증).
 *
 * ## 원인
 * 슛은 **발사 틱에 공이 움직이지 않고**(슈터 발밑 프레임, `shotLaunchedThisTick`) 다음 틱부터
 * 비행한다. 하프 마지막 틱에 쏘면 그 "다음 틱"이 하프타임 킥오프 리셋이라 `ball.flight` 가
 * 통째로 버려진다 → 결과 이벤트가 영원히 안 나온다. 경기 종료 틱도 같다.
 *
 * ## 계약
 * 모든 `shot` 이벤트는 결과(goal · saved · off_target)를 가진다. 실제 축구도 공이 죽을 때까지는
 * 플레이하므로, 하프/경기 경계에서 비행 중인 슛을 마저 해소한다.
 *
 * (선행 결함이었고 #178 마크 진동 픽스로 타임라인이 바뀌며 데모에 드러났다 — hero 지시로 #178
 *  스코프에서 함께 해소.)
 */

const config = defaultEngineConfig;

/** 결과가 없는 슛(발사 이벤트만 있고 goal/saved/off_target 이 뒤따르지 않는 것). */
function orphanShots(log: MatchLog): string[] {
  // 결과 표현: `goal` 이벤트, 또는 detail 이 saved/off_target 인 후속 `shot` 이벤트.
  const out: string[] = [];
  const evs = log.events;
  for (let i = 0; i < evs.length; i++) {
    const s = evs[i]!;
    if (s.type !== "shot" || s.detail === "saved" || s.detail === "off_target") continue;
    const resolved = evs.some(
      (e) =>
        e.tick >= s.tick &&
        e.tick <= s.tick + 20 &&
        e.team === s.team &&
        (e.type === "goal" || (e.type === "shot" && (e.detail === "saved" || e.detail === "off_target"))),
    );
    if (!resolved) out.push(`t${s.tick} ${s.team} ${s.playerId ?? "?"}`);
  }
  return out;
}

const SEEDS = REALISM_SEEDS.slice(0, 8);
const logs: { seed: string; log: MatchLog }[] = [
  // 쇼케이스 config(짧은 경기 = 하프 경계가 자주 온다) — 실제로 이 버그가 드러난 로그.
  { seed: "showcase", log: buildShowcaseLog() },
  { seed: "demo-real", log: runMatch(demoSeed, demoHome, demoAway, demoSelect, config) },
  ...SEEDS.map((seed) => ({
    seed,
    log: runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), makeSelectData(), config),
  })),
];

describe("슛 결과 완결 (#178 후속)", () => {
  it("모든 슛이 결과(골/선방/빗나감)를 갖는다 — 하프·경기 경계에서 증발하지 않는다", () => {
    const orphans = logs.flatMap(({ seed, log }) => orphanShots(log).map((s) => `${seed} ${s}`));
    expect(orphans.length, `결과 없는 슛 ${orphans.length}건 — ${orphans.slice(0, 8).join(" | ")}`).toBe(0);
  });

  it("경계 해소가 재개 동일성을 깨지 않는다 — 분할(전·후반) == 통짜", () => {
    // 경계에서 rng 를 소비하므로 runMatch 와 runFirstHalf+resumeSecondHalf 가 **같은 지점**에서
    // 같은 횟수로 해소해야 한다. 어긋나면 여기서 즉시 깨진다.
    const seed = REALISM_SEEDS[0]!;
    const h = makeTacticalInput("H", seed);
    const a = makeTacticalInput("A", seed);
    const sel = makeSelectData();
    const whole = runMatch(seed, h, a, sel, config);
    const split = resumeSecondHalf(runFirstHalf(seed, h, a, sel, config), h, a);
    const lastHash = (l: MatchLog) => l.tickSnapshots[l.tickSnapshots.length - 1]!.hash;
    expect(lastHash(split)).toBe(lastHash(whole));
    expect(split.finalScore).toEqual(whole.finalScore);
    expect(split.events.length).toBe(whole.events.length);
  });

  it("경계 해소 이벤트는 스냅샷과 어긋나지 않는다 — 골이면 그 틱 공이 골문 안에 있다", () => {
    // 해소 후 마지막 스냅샷을 갱신하지 않으면 "골 이벤트인데 공은 슈터 발밑" 이 되어
    // 뷰어가 골 연출을 엉뚱한 위치에 그린다.
    for (const { seed, log } of logs) {
      const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
      const half = Math.floor(log.tickSnapshots.length / 2);
      for (const g of log.events.filter((e) => e.type === "goal")) {
        const sn = byTick.get(g.tick);
        if (!sn) continue;
        // 경계 틱(하프 직전·경기 끝)의 골만 본다 — 일반 골은 goal-flight 계약이 따로 검증한다.
        if (Math.abs(g.tick - (half - 1)) > 1 && g.tick < log.tickSnapshots.length - 2) continue;
        const atLine = sn.ball.x < 3 || sn.ball.x > config.pitch.width - 3;
        expect(atLine, `${seed} t${g.tick} 골인데 공이 골라인 밖 (${sn.ball.x.toFixed(1)},${sn.ball.y.toFixed(1)})`).toBe(true);
      }
    }
  });
});
