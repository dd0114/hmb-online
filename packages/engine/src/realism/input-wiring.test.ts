import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import type { MatchLog, TacticalInput } from "@hmb/shared";

/**
 * #361 T1 · #366 T5 — **유저가 만지는 것이 경기를 바꾼다.**
 *
 * 배경(#359/#360 진단): `team.width` · `pressingScheme.triggerLine` · `duty` 는 엔진 소비자가
 * **0건**이었고 `passDirectness` 는 weighted 코어에만 있어 사슬 기본(0.24.0~)에서 죽어 있었다.
 * 즉 유저가 슬라이더를 끝까지 올려도 경기가 **비트 단위로 동일**했다.
 *
 * ## 판정 = 변이체 킬 (#377 M2 공통 AC)
 * "참조가 있다"는 통과 기준이 아니다. **입력을 바꿨는데 경기가 bit-identical 이면 FAIL** 이다.
 * 그 위에 **방향 관계식**을 건다 — 값이 달라지기만 하고 엉뚱한 방향이면 배선이 아니라 노이즈다.
 * 절대 임계를 쓰지 않는 이유는 #178 mark-jitter 와 같다: 내가 고른 임계를 내가 통과하는
 * 자기충족을 배제하고, 이후 계수 재보정(트랙 T)에도 계약이 살아남게.
 */

const seeds = REALISM_SEEDS.slice(0, 6);
const select = makeSelectData();

function run(config: EngineConfig, patch: (t: TacticalInput) => TacticalInput, seed: string): MatchLog {
  const h = patch(makeTacticalInput("H", seed));
  const a = makeTacticalInput("A", seed);
  return runMatch(seed, h, a, select, config);
}

/** 최종 상태 해시들 — 두 실행이 bit-identical 인지 보는 가장 강한 판정. */
function hashes(config: EngineConfig, patch: (t: TacticalInput) => TacticalInput): string[] {
  return seeds.map((s) => {
    const log = run(config, patch, s);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

/** 홈 팀 아웃필더의 평균 팀 폭(y 산포, m) — `team.width` 의 직접 관찰량. */
function homeWidth(config: EngineConfig, patch: (t: TacticalInput) => TacticalInput): number {
  let sum = 0;
  let n = 0;
  for (const s of seeds) {
    const log = run(config, patch, s);
    for (const snap of log.tickSnapshots) {
      const ys = snap.players.filter((p) => p.team === "home" && p.playerId !== "H0").map((p) => p.pos.y);
      if (ys.length < 2) continue;
      sum += Math.max(...ys) - Math.min(...ys);
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

const team = (t: TacticalInput, patch: Partial<TacticalInput["team"]>): TacticalInput => ({
  ...t,
  team: { ...t.team, ...patch },
});
const players = (t: TacticalInput, patch: (p: TacticalInput["players"][0]) => TacticalInput["players"][0]): TacticalInput => ({
  ...t,
  players: t.players.map(patch),
});

describe("#361 T1 — team.width 가 실제 레버다", () => {
  const wide = (t: TacticalInput) => team(t, { width: 0.95 });
  const narrow = (t: TacticalInput) => team(t, { width: 0.05 });

  it("변이체 킬 — 폭 0.95 vs 0.05 가 bit-identical 이 아니다", () => {
    expect(hashes(defaultEngineConfig, wide)).not.toEqual(hashes(defaultEngineConfig, narrow));
  }, 300_000);

  it("방향 — 넓게 지시한 팀이 실제로 더 넓게 선다", () => {
    const w = homeWidth(defaultEngineConfig, wide);
    const n = homeWidth(defaultEngineConfig, narrow);
    expect(w, `wide ${w.toFixed(2)}m vs narrow ${n.toFixed(2)}m`).toBeGreaterThan(n);
  }, 300_000);

  it("롤백 — behavior.widthTendency 를 0 으로 두면 팀 슬라이더도 효과가 없다(축이 하나다)", () => {
    // 두 축이 **곱**으로 결합한다는 설계의 계약. 곱이 아니라 합이면 이게 깨진다.
    const flat = (t: TacticalInput) =>
      players(team(t, { width: 0.95 }), (p) => ({ ...p, behavior: { ...p.behavior, widthTendency: 0 } }));
    const flatNarrow = (t: TacticalInput) =>
      players(team(t, { width: 0.05 }), (p) => ({ ...p, behavior: { ...p.behavior, widthTendency: 0 } }));
    expect(hashes(defaultEngineConfig, flat)).toEqual(hashes(defaultEngineConfig, flatNarrow));
  }, 300_000);
});

describe("#361 T1 — pressingScheme.triggerLine 이 실제 레버다", () => {
  const high = (t: TacticalInput) => team(t, { pressingScheme: { ...t.team.pressingScheme, triggerLine: 1 } });
  const low = (t: TacticalInput) => team(t, { pressingScheme: { ...t.team.pressingScheme, triggerLine: 0 } });

  it("변이체 킬 — 하이프레스 vs 로우블록이 bit-identical 이 아니다", () => {
    expect(hashes(defaultEngineConfig, high)).not.toEqual(hashes(defaultEngineConfig, low));
  }, 300_000);

  it("방향 — 로우블록 팀은 공에 아무도 안 붙는다(상대 진영에서 공↔최근접 홈 선수 거리↑)", () => {
    // ⚠️ 관찰량을 두 번 갈아탔다. 기록해 둔다 — 다음 사람이 같은 함정에 빠지지 않게.
    //  ① "공 5m 안 홈 선수 **수**" → **선택 편향**으로 역전(하이프레스는 그 구간에서 공을
    //     빨리 뺏어 표본 자체가 줄고, 남는 틱은 압박이 실패한 틱들뿐이다).
    //  ② "홈 라인 높이 평균" → **희석**. 게이트는 압박 담당 **1명**의 배정만 끄는데, 라인 높이는
    //     10명 평균이라 duty·width·피로 같은 다른 축이 신호를 덮는다(실측 43.49 vs 43.75).
    //  ③ **공↔최근접 홈 선수 거리** — 게이트가 직접 만드는 것(아무도 안 나간다)을 재고,
    //     "몇 명"이 아니라 "얼마나 가까운가"라 표본 수에 덜 휘둘린다.
    const nearest = (patch: (t: TacticalInput) => TacticalInput): number => {
      let sum = 0;
      let n = 0;
      for (const s of seeds) {
        for (const snap of run(defaultEngineConfig, patch, s).tickSnapshots) {
          if (!snap.ballOwner || !snap.ballOwner.startsWith("A")) continue; // 홈이 수비 중
          if (snap.ball.x <= 52.5) continue; // 홈은 +x 공격 → 여기가 상대 진영(게이트가 갈리는 구간)
          let best = Infinity;
          for (const p of snap.players) {
            if (p.team !== "home" || p.playerId === "H0") continue;
            const d = Math.hypot(p.pos.x - snap.ball.x, p.pos.y - snap.ball.y);
            if (d < best) best = d;
          }
          if (Number.isFinite(best)) {
            sum += best;
            n += 1;
          }
        }
      }
      return n > 0 ? sum / n : 0;
    };
    const h = nearest(high);
    const l = nearest(low);
    expect(l, `low ${l.toFixed(2)}m vs high ${h.toFixed(2)}m`).toBeGreaterThan(h);
  }, 300_000);

  it("롤백 — press.trigger.enabled=false 면 triggerLine 이 다시 무효다(변이체 킬의 대조군)", () => {
    const off: EngineConfig = {
      ...defaultEngineConfig,
      press: { trigger: { ...defaultEngineConfig.press.trigger, enabled: false } },
    };
    expect(hashes(off, high)).toEqual(hashes(off, low));
  }, 300_000);
});

describe("#361 T1 — passDirectness 가 사슬 코어에서 살아 있다", () => {
  const direct = (t: TacticalInput) =>
    players(t, (p) => ({ ...p, behavior: { ...p.behavior, passDirectness: 1 } }));
  const patient = (t: TacticalInput) =>
    players(t, (p) => ({ ...p, behavior: { ...p.behavior, passDirectness: 0 } }));

  it("변이체 킬 — 다이렉트 1.0 vs 0.0 이 bit-identical 이 아니다", () => {
    expect(hashes(defaultEngineConfig, direct)).not.toEqual(hashes(defaultEngineConfig, patient));
  }, 300_000);

  it("방향 — 다이렉트 지시가 롱패스 비율을 올린다", () => {
    const longShare = (patch: (t: TacticalInput) => TacticalInput): number => {
      let long = 0;
      let all = 0;
      for (const s of seeds) {
        for (const e of run(defaultEngineConfig, patch, s).events) {
          if (e.type !== "pass" || e.team !== "home") continue;
          all += 1;
          if (e.detail === "long") long += 1;
        }
      }
      return all > 0 ? (long / all) * 100 : 0;
    };
    const d = longShare(direct);
    const p = longShare(patient);
    expect(d, `direct ${d.toFixed(2)}% vs patient ${p.toFixed(2)}%`).toBeGreaterThan(p);
  }, 300_000);
});

describe("#366 T5 — duty 가 오프더볼 위치를 바꾼다", () => {
  const asDuty = (d: "defend" | "support" | "attack") => (t: TacticalInput) =>
    players(t, (p) => (p.role.toLowerCase().includes("gk") ? p : { ...p, duty: d }));

  it("변이체 킬 — duty 전원 attack vs 전원 defend 가 bit-identical 이 아니다", () => {
    expect(hashes(defaultEngineConfig, asDuty("attack"))).not.toEqual(hashes(defaultEngineConfig, asDuty("defend")));
  }, 300_000);

  it("방향 — '공격 가담' 팀이 더 높이 선다(평균 진행도↑)", () => {
    const meanProgress = (patch: (t: TacticalInput) => TacticalInput): number => {
      let sum = 0;
      let n = 0;
      for (const s of seeds) {
        for (const snap of run(defaultEngineConfig, patch, s).tickSnapshots) {
          for (const p of snap.players) {
            if (p.team !== "home" || p.playerId === "H0") continue;
            sum += p.pos.x / 105;
            n += 1;
          }
        }
      }
      return n > 0 ? sum / n : 0;
    };
    const a = meanProgress(asDuty("attack"));
    const d = meanProgress(asDuty("defend"));
    expect(a, `attack ${a.toFixed(4)} vs defend ${d.toFixed(4)}`).toBeGreaterThan(d);
  }, 300_000);

  it("롤백 — duty.enabled=false 면 duty 가 다시 무효다", () => {
    const off: EngineConfig = {
      ...defaultEngineConfig,
      duty: { ...defaultEngineConfig.duty, enabled: false },
    };
    expect(hashes(off, asDuty("attack"))).toEqual(hashes(off, asDuty("defend")));
  }, 300_000);
});
