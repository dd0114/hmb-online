import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { createPitch } from "../pitch";
import { toFixed } from "../fixedmath";
import { holdKeepProb } from "../chain";
import { shotPressureXg, oneOnOneShot, planShot, xgAtPoint } from "../decision";
import { createRng } from "../rng";
import type { SimPlayer, SimState } from "../simstate";
import { collectOneOnOne } from "./one-on-one";
import { REALISM_SEEDS } from "./harness";

/**
 * #353 — **압박에 반응하는 홀드·슛** 계약.
 *
 * ## 결함 (구조)
 * 사슬 EV 는 행동마다 `EV = p×V(성공) + (1−p)×V(턴오버)` 인데 **홀드만 실패 항이 없었다**
 * (`chain.ts` 의 `return evaluateStateEv(ctx, here) − holdPenaltyEv`). 즉 홀드는 **뺏길 수 없는
 * 선택지**였고, 슛 사거리(19m) 안 결정의 **72.0%** 가 홀드였다(구 코어 39.1%). hero 실관전의
 * "다 핀볼처럼 자기 위치 지키면서 주고받는 게 다야"가 이 수치의 정체다(#350·#351·#352 의 뿌리).
 * 슛도 마찬가지로 **압박을 전혀 안 봤다** — 수비수가 붙어 있어도 조준·xG 가 동일했다.
 *
 * ## 계약을 거는 방식
 * 절대 임계(“hold 는 40% 미만이어야 한다”)는 내 튜닝 결과를 기준으로 삼는 것이라 걸지 않는다.
 * 전부 **관계식**이다:
 *  - 유지 확률은 압박 인원·거리에 대해 **단조 감소**한다(같은 좌표, 상대만 다르게 세운 대조군).
 *  - 압박 아래 슛의 xG 는 자유로울 때보다 **낮다**.
 *  - **롤백 등가**: 이 웨이브가 추가한 노브를 전부 레거시 값으로 되돌리면 0.27.0 과 **해시가
 *    비트 동일**하다(= 새 경로가 조용히 항상 켜져 있지 않다는 증거이자 롤백 스위치의 계약).
 *  - 실경기(20시드)에서 사거리 안 홀드 비율이 **레거시 대조군보다 낮다** — 임계가 아니라 대조다.
 */

const cfg = defaultEngineConfig;
const pitch = createPitch(cfg);
const select = makeSelectData();

/**
 * 이 웨이브(#353)가 추가한 노브를 전부 **레거시(무효)** 로 되돌린 config.
 * 홀드: `keepBase=1` + 페널티 0 → `EV = 1×(V−holdPenalty) + 0×턴오버` = 구 식과 **정확히** 같다
 * (`mulFrac(v, FRAC_SCALE) === v`, `mulFrac(v, 0) === 0` 이라 반올림 손실도 없다).
 */
export function legacy0270(): EngineConfig {
  return {
    ...cfg,
    chain: {
      ...cfg.chain,
      hold: { ...cfg.chain.hold, keepBase: 1, pressPenalty: 0, tightPenalty: 0 },
    },
    contest: {
      ...cfg.contest,
      shotPressureAimPenalty: 0,
      shotPressureXgMult: 1,
      passReceiverPressurePenalty: 0,
    },
  };
}

/** 최소 상태 — `holdKeepProb`/`shotPressureXg` 는 `state.players` 와 좌표만 본다. */
function fakeState(players: SimPlayer[]): SimState {
  return { players } as unknown as SimState;
}

function fakePlayer(side: SimPlayer["side"], id: string, xM: number, yM: number, isGK = false): SimPlayer {
  const pos = { x: toFixed(xM, cfg.fixedScale), y: toFixed(yM, cfg.fixedScale) };
  return {
    id,
    side,
    isGK,
    fatigue: 0,
    attrs: { shooting: 50, passing: 50, pace: 50, physical: 50, positioning: 50, mental: 50, technical: 50 },
    posFx: pos,
    // 기본은 "제자리" — 리드 예측이 현재 위치와 같아진다(대조군의 기준선).
    targetFx: { ...pos },
  } as unknown as SimPlayer;
}

const MIDX = cfg.pitch.width / 2;
const MIDY = cfg.pitch.height / 2;

describe("#353 홀드 유지 확률 — 압박의 인원과 거리 둘 다에 반응한다", () => {
  const h = cfg.chain.hold;
  const holder = fakePlayer("home", "H9", MIDX, MIDY);

  /** 홀더에서 `dM` 떨어진 곳에 상대 n 명(같은 지점, 카운트만 늘린다). */
  function keepWith(n: number, dM: number): number {
    const opp: SimPlayer[] = [];
    for (let i = 0; i < n; i++) opp.push(fakePlayer("away", `A${i + 1}`, MIDX + dM, MIDY));
    return holdKeepProb(fakeState([holder, ...opp]), holder, cfg);
  }

  it("압박이 없으면 keepBase 그대로 — '혼자면 지켜도 안전'", () => {
    // 반경 밖(근접 6m 초과)에 세운 상대는 세지 않는다.
    expect(keepWith(1, h.pressRangeM + 2)).toBeCloseTo(h.keepBase, 10);
    expect(keepWith(0, 0)).toBeCloseTo(h.keepBase, 10);
  });

  it("인원에 대해 단조 감소한다(같은 거리, 명수만 증가)", () => {
    const d = (h.tightRangeM + h.pressRangeM) / 2; // 근접이지만 밀착은 아닌 거리
    const k0 = keepWith(0, d);
    const k1 = keepWith(1, d);
    const k2 = keepWith(2, d);
    const k3 = keepWith(3, d);
    expect(k1).toBeLessThan(k0);
    expect(k2).toBeLessThan(k1);
    expect(k3).toBeLessThanOrEqual(k2);
  });

  it("거리에 대해 단조 감소한다(같은 1명, 가까울수록 낮다) — 평평한 상수가 아니다", () => {
    const far = keepWith(1, h.pressRangeM + 2); // 반경 밖
    const near = keepWith(1, (h.tightRangeM + h.pressRangeM) / 2); // 근접
    const tight = keepWith(1, h.tightRangeM / 2); // 밀착
    expect(near).toBeLessThan(far);
    expect(tight).toBeLessThan(near);
  });

  it("하한(minKeep) 아래로 내려가지 않는다", () => {
    expect(keepWith(6, 1)).toBeGreaterThanOrEqual(h.minKeep);
    expect(keepWith(6, 1)).toBeCloseTo(h.minKeep, 10);
  });

  it("롤백 노브(keepBase=1·페널티 0)에서는 압박과 무관하게 1 — 구 식으로 되돌아간다", () => {
    const L = legacy0270();
    for (const n of [0, 1, 3]) {
      const opp: SimPlayer[] = [];
      for (let i = 0; i < n; i++) opp.push(fakePlayer("away", `A${i + 1}`, MIDX + 1, MIDY));
      expect(holdKeepProb(fakeState([holder, ...opp]), holder, L)).toBe(1);
    }
  });
});

describe("#353 압박 아래 슛 — 결과(xG)와 조준이 둘 다 흔들린다", () => {
  // 홈 슈터가 어웨이 골(x=width)을 본다. 사거리 안(골에서 12m).
  const shooter = fakePlayer("home", "H9", cfg.pitch.width - 12, MIDY);
  const gk = fakePlayer("away", "A0", cfg.pitch.width - 2, MIDY, true);
  const { xg: raw, distM } = xgAtPoint("home", shooter.posFx.x, shooter.posFx.y, 50, 0, cfg, pitch);

  function marked(n: number, dM = 1.5): SimState {
    const opp: SimPlayer[] = [gk];
    for (let i = 0; i < n; i++) opp.push(fakePlayer("away", `A${i + 1}`, cfg.pitch.width - 12 + dM, MIDY));
    return fakeState([shooter, ...opp]);
  }

  it("압박 인원에 대해 xG 가 단조 감소한다", () => {
    const x0 = shotPressureXg(marked(0), shooter, raw, cfg);
    const x1 = shotPressureXg(marked(1), shooter, raw, cfg);
    const x2 = shotPressureXg(marked(2), shooter, raw, cfg);
    expect(x0).toBe(raw); // 압박 0 = no-op
    expect(x1).toBeLessThan(x0);
    expect(x2).toBeLessThan(x1);
  });

  it("1대1 부스트와 상호 배타 — 이중 계상이 없다", () => {
    // 반경 안 비-GK 상대가 0명일 때만 부스트가 붙고, 그때 압박 감산은 정의상 no-op 다.
    const free = marked(0);
    const oo = oneOnOneShot(free, shooter, raw, distM, cfg);
    expect(oo.detail).toBe("one_on_one");
    expect(shotPressureXg(free, shooter, oo.xg, cfg)).toBe(oo.xg);
  });

  it("롤백 노브(mult=1)에서는 xG 가 그대로다", () => {
    expect(shotPressureXg(marked(3), shooter, raw, legacy0270())).toBe(raw);
  });

  it("조준이 압박을 실제로 탄다(연출) — 같은 시드에서 압박 유무로 조준점이 갈린다", () => {
    // `planShot` 이 pressers 를 넘기지 않던 구 코드(0 고정)에서는 두 값이 항상 같았다.
    const a = planShot(marked(0), shooter, cfg, createRng("seed-353"), pitch);
    const b = planShot(marked(3), shooter, cfg, createRng("seed-353"), pitch);
    expect(b.toY).not.toBe(a.toY);
    // 롤백 노브에서는 다시 같아진다.
    const L = legacy0270();
    const c = planShot(marked(0), shooter, L, createRng("seed-353"), pitch);
    const d = planShot(marked(3), shooter, L, createRng("seed-353"), pitch);
    expect(d.toY).toBe(c.toY);
  });
});

describe("#353 롤백 등가 — 노브를 되돌리면 engine@0.27.0 과 비트 동일", () => {
  /**
   * 0.27.0(커밋 d6a3636, 이 웨이브 직전) 실측 해시. 이 상수가 깨지면 둘 중 하나다 —
   * 새 경로가 롤백 노브를 무시하고 켜져 있거나, 무관한 변경이 롤백 경로를 드리프트시켰다.
   */
  const GOLDEN: Record<string, string> = {
    "4815162342": "f9dca7e5",
    "9999999999": "990eb969",
    "1234567890": "b92c0b48",
  };

  it("레거시 노브 셋으로 최종 해시가 0.27.0 과 같다", () => {
    const L = legacy0270();
    for (const [seed, hash] of Object.entries(GOLDEN)) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, L);
      expect(log.tickSnapshots[log.tickSnapshots.length - 1]!.hash).toBe(hash);
    }
  }, 120_000);

  it("기본 config 는 그 해시와 **다르다**(변경이 실제로 켜져 있다)", () => {
    const seed = "4815162342";
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    expect(log.tickSnapshots[log.tickSnapshots.length - 1]!.hash).not.toBe(GOLDEN[seed]);
  }, 60_000);
});

describe("#353 실경기 — 사거리 안 홀드가 레거시 대조군보다 줄어든다", () => {
  /**
   * **절대 임계가 아니라 대조군 관계식**이다(#178 mark-jitter 와 같은 규율): 같은 시드·같은
   * 코드에서 노브만 레거시로 되돌린 실행과 비교한다. 그래야 "내가 고른 임계를 내가 통과"하는
   * 자기충족을 배제하고, 이후 밸런스 재보정으로 절대값이 움직여도 계약이 살아남는다.
   */
  it("20시드 대조 — hold 비율이 내려가고 shoot/pass/carry 가 올라간다", () => {
    const seeds = REALISM_SEEDS;
    const now = collectOneOnOne(cfg, seeds, [10]);
    const old = collectOneOnOne(legacy0270(), seeds, [10]);
    const holdPct = (r: typeof now): number => (100 * r.inRangeByKind.hold) / r.inRange;
    const actPct = (r: typeof now): number =>
      (100 * (r.inRangeByKind.shoot + r.inRangeByKind.pass + r.inRangeByKind.dribble)) / r.inRange;
    // eslint-disable-next-line no-console
    console.log(
      `[#353] 사거리안 hold: legacy ${holdPct(old).toFixed(1)}% → now ${holdPct(now).toFixed(1)}% · ` +
        `행동(shoot+pass+carry): ${actPct(old).toFixed(1)}% → ${actPct(now).toFixed(1)}%`,
    );
    expect(holdPct(now)).toBeLessThan(holdPct(old));
    expect(actPct(now)).toBeGreaterThan(actPct(old));
  }, 300_000);
});
