import { describe, it, expect } from "vitest";
import type { MatchLog, TickSnapshot } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { xgAtPoint } from "../decision";
import { createPitch } from "../pitch";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { preShipping } from "./rollback";

/**
 * #407 N1 + N4 — **슛 하드 게이트 → 결정단 거리 감쇠** · **hold EV 의 1대1 예외** 계약
 * (engine@0.41.0, QA 상시 트랙 #25 산하). 구현 노트 = `issues/2026-08-02-engine-shot-gate-decay.md`.
 *
 * ## 무엇을 박제하나
 * Phase 2-B(`research/e407-volume-diversity.md` §7-2)가 확정한 **세 개의 벽** 중 둘.
 *
 * **벽 2·3 (N1)** — `chain.ts` 의 슛 생성기가 `distToGoalM > contest.shootRange` 면 후보를 **아예
 * 안 만들었다**. 그 한 줄이 ⓐ 오픈플레이 와이드 슛을 확률 0 으로 만들고(와이드 문턱 20.4m >
 * shootRange 19m — 튜닝이 아니라 산수) ⓑ 그 노브로 볼륨을 내리면 박스 밖 슛이 통째로 사라져
 * 박스 편중을 41.2%→90~100% 로 밀었다(Phase 2-A 3안 기각 사유). N1 은 생성을 **안전 상한**까지
 * 넓히고 억제를 `candidateEv` 의 shoot 분기에만 건다 — 먼 슛은 **EV 경쟁에서 지는 것이지
 * 존재하지 않는 것이 아니다**. 규율: **`xgAtPoint` 무수정**(결과 모델과 결정 모델의 분리).
 *
 * **부속 벽 (N4)** — hold EV 가 `p_keep` 기반이라 **자유로울수록 hold 가 최적**이다. 1대1 은 정의상
 * 가장 자유로운 순간이므로, hold 계열을 볼륨 레버로 쓰면 #316 이 먼저 죽는다(2-A 안 A 는
 * `one_on_one` 이 팀-경기 95.8%에서 0건이 되어 기각).
 *
 * ## ⚠️ 출하 기본은 `shootDistance.enabled=false` 다 (측정 결과)
 * 감쇠 축은 **축 A(거리 분포)를 확실히 이기지만 축 B(선수 다양성)를 예외 없이 악화**시킨다
 * (슛 top1 95.8%→97.3~100% · 1대1 7.17%→0~4.3%). hero 가 축 B 악화를 하드 제약으로 걸었으므로
 * 기본을 켤 수 없다. 그래서 아래 N1 계약은 **`enabled:true` 를 명시적으로 켜서** 기제를 검정한다 —
 * 노브가 살아 있다는 것과 그 값이 출하값이라는 것은 다른 문제이고, 여기가 지키는 것은 전자다.
 *
 * ## 규율
 * 전부 **소시드(≤12)** 다. 밴드 판정(60시드)은 `shot-frequency.test.ts`, 단조 사다리는 같은 파일의
 * `HMB_LADDER` 블록이 맡는다 — 이 파일은 "기제가 살아 있나"만 본다.
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

interface Profile {
  /** 팀-경기당 슛(발사 이벤트만). */
  shots: number;
  /** 박스 안 슛 비중(%). */
  inBoxPct: number;
  /**
   * 슛 하나하나의 **골 중앙까지 거리**(m, 이벤트 틱의 공 좌표 기준).
   *
   * ⚠️ 이 자는 생성 게이트가 보는 자(`distToAttackGoal(홀더 좌표)`)와 **최대 `contest.controlRange`
   * 만큼 다르다** — 소유 중 공은 발밑이 아니라 **접촉점**에 놓이기 때문이다(#407 ④). 실측:
   * 하드 게이트(사거리 19m) 출하 트리에서 이벤트 거리 최댓값이 **23.66m** 이고 이는 19 + 4.7 이다.
   * 그래서 "게이트 밖 슛"을 셀 때는 이 슬랙을 **명시적으로** 더한다.
   */
  dists: number[];
  /** `detail="one_on_one"` 슛의 비중(%) — #316 계약 지표. */
  oneOnOnePct: number;
}

/** 슛 프로필 — 정의는 `research/e407-probe/e407-diversity.ts` 와 **같은 자**를 쓴다(비교 가능성). */
function profile(config: EngineConfig, seeds: string[]): Profile {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const boxDepth = config.rules.penalty.boxDepthM;
  const boxHalf = config.rules.penalty.boxHalfWidthM;
  let shots = 0;
  let inBox = 0;
  let oneOnOne = 0;
  const dists: number[] = [];
  for (const s of seeds) {
    const log: MatchLog = runMatch(
      s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config,
    );
    const byTick = new Map<number, TickSnapshot>();
    for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);
    for (const e of log.events) {
      if (e.type !== "shot" || e.detail === "saved" || e.detail === "off_target") continue;
      const sn = byTick.get(e.tick);
      if (!sn || !e.team) continue;
      shots += 1;
      if (e.detail === "one_on_one") oneOnOne += 1;
      const gx = e.team === "home" ? W : 0;
      const lat = Math.abs(sn.ball.y - H / 2);
      const d = Math.hypot(sn.ball.x - gx, lat);
      if (Math.abs(sn.ball.x - gx) <= boxDepth && lat <= boxHalf) inBox += 1;
      dists.push(d);
    }
  }
  const teamMatches = seeds.length * 2;
  return {
    shots: +(shots / teamMatches).toFixed(2),
    inBoxPct: shots ? +((inBox / shots) * 100).toFixed(1) : 0,
    dists,
    oneOnOnePct: shots ? +((oneOnOne / shots) * 100).toFixed(2) : 0,
  };
}

/** 공 접촉점 슬랙(#407 ④) — 이벤트 거리는 생성 게이트가 본 거리보다 이만큼까지 클 수 있다. */
const SLOP = defaultEngineConfig.contest.controlRange;

/** `limitM` + 슬랙을 넘는 슛의 수. "그 게이트 밖에서 슛이 났나"를 **보수적으로** 센다. */
function beyond(p: Profile, limitM: number): number {
  return p.dists.filter((d) => d > limitM + SLOP).length;
}

/** config 를 깊은 복사해 부분 수정(중첩 스프레드 대신 — 노브가 3단계라 실수하기 쉽다). */
function tweak(mutate: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  mutate(c);
  return c;
}

const SEEDS8 = REALISM_SEEDS.slice(0, 8);
const SEEDS12 = REALISM_SEEDS.slice(0, 12);

/* ------------------------------------------------------------------ *
 * N1-①  생성 게이트가 감쇠로 바뀌었다 — 먼 슛이 **존재한다**
 * ------------------------------------------------------------------ */
describe("#407 N1 — 슛 후보 생성은 넓게, 억제는 결정단에서", () => {
  const hard = profile(cfg, SEEDS8); // 출하 = enabled:false = 0.40.0 하드 게이트
  // 생성 축만 보는 팔 — 감쇠를 0 으로 두어 "후보가 만들어지는가"를 억제와 분리해 잰다.
  const wide = profile(
    tweak((c) => {
      c.chain.shootDistance.enabled = true;
      c.chain.shootDistance.genMaxM = 34;
      c.chain.shootDistance.perM = 0;
    }),
    SEEDS8,
  );
  const capped = profile(tweak((c) => { c.chain.shootDistance.enabled = true; }), SEEDS8); // genMaxM 24

  it(`하드 게이트에서는 shootRange(${cfg.contest.shootRange}m) 밖 슛이 정확히 0 이다 (벽 2 의 실체)`, () => {
    // 튜닝 결과가 아니라 생성 게이트의 산수라서 **정확히** 0 이다. 이 0 이 와이드 슛 0% 의 뿌리다.
    const n = beyond(hard, cfg.contest.shootRange);
    expect(n, `측정 ${n} (슛 ${hard.shots}/팀-경기, 최대거리 ${Math.max(...hard.dists).toFixed(2)}m)`).toBe(0);
  });

  it("감쇠를 켜면 사거리 밖 슛이 실제로 나온다 (후보가 생성은 된다)", () => {
    const n = beyond(wide, cfg.contest.shootRange);
    expect(n, `측정 ${n} (슛 ${wide.shots}/팀-경기, 최대거리 ${Math.max(...wide.dists).toFixed(2)}m)`)
      .toBeGreaterThan(0);
  });

  it("생성은 `genMaxM` 안에서만 일어난다 (노드 폭주 방지 안전 상한이 실재한다)", () => {
    // 상한이 배선돼 있다는 증명 — 오타면 조용히 무제한 생성이 되고 노드 예산 컷오프 지점이 바뀐다.
    const cap = cfg.chain.shootDistance.genMaxM;
    expect(beyond(capped, cap), `genMaxM ${cap} 에서 상한 밖 슛 ${beyond(capped, cap)}`).toBe(0);
    expect(beyond(wide, cap), `genMaxM 34 에서는 ${cap}m 밖 슛이 ${beyond(wide, cap)} 개 난다`)
      .toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * N1-②  `xgAtPoint` 무변경 — 결과 모델과 결정 모델의 분리
 * ------------------------------------------------------------------ */
describe("#407 N1 — 감쇠는 결정 축에만 걸린다 (xG 는 bit-identical)", () => {
  it("shootDistance 노브를 어떻게 돌려도 같은 지점의 xG 가 한 비트도 안 바뀐다", () => {
    // Phase 2-A 는 `contest.shootDistanceFactor`(= xG 자체)를 키워 같은 일을 하려다 슛당 xG
    // 0.117 로 붕괴해 기각당했다. 그 실수를 코드로 못 하게 막는 줄이다.
    const pitch = createPitch(cfg);
    const mutated = tweak((c) => {
      c.chain.shootDistance = { enabled: true, genMaxM: 60, freeM: 0, perM: 0.5, floor: 0 };
    });
    for (let xm = 60; xm <= 104; xm += 4) {
      for (let ym = 6; ym <= 62; ym += 7) {
        const xFx = Math.round(xm * cfg.fixedScale);
        const yFx = Math.round(ym * cfg.fixedScale);
        const a = xgAtPoint("home", xFx, yFx, 60, 0.2, cfg, pitch);
        const b = xgAtPoint("home", xFx, yFx, 60, 0.2, mutated, pitch);
        expect(b.xg, `(${xm},${ym})`).toBe(a.xg);
        expect(b.distM, `(${xm},${ym})`).toBe(a.distM);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * N1-③  감쇠는 **단조 볼륨 레버**이고, 같은 볼륨에서 하드 게이트보다 박스 편중이 낮다
 *        ← 이 웨이브의 존재 이유. 계약으로 박는다.
 * ------------------------------------------------------------------ */
describe("#407 N1 — 볼륨을 내려도 박스 편중이 폭증하지 않는다 (Phase 2-A 기각 사유의 회귀 가드)", () => {
  /** 감쇠 강도를 균일 계수로 표현한 팔(`perM` 을 크게 두면 사실상 전 거리 `floor` 배). */
  const uniform = (floor: number): EngineConfig =>
    tweak((c) => {
      c.chain.shootDistance = { enabled: true, genMaxM: 24, freeM: 0, perM: 10, floor };
    });

  const soft = profile(uniform(0.45), SEEDS8);
  const harsh = profile(uniform(0.36), SEEDS8);

  it("감쇠를 세게 하면 팀당 슛이 내려간다 (살아 있는 볼륨 레버다)", () => {
    expect(harsh.shots, `floor .45→.36: ${soft.shots} → ${harsh.shots}`).toBeLessThan(soft.shots);
  });

  it("같은 볼륨대에서 감쇠 축이 하드 게이트 축보다 박스 편중이 **20%p 이상** 낮다", () => {
    // Phase 2-A 3안이 기각당한 이유가 이 지점이다 — `shootRange` 로 볼륨을 내리면 박스 밖 슛이
    // 통째로 사라진다(8시드 실측: sr14 → 슛 8.63 · 박스 **100.0%**).
    // 감쇠로 같은 볼륨대(11.75)를 만들면 박스 **61.7%** 다. 절대치가 아니라 **두 축의 차이**를
    // 계약으로 박는다 — 절대치는 다른 노브의 재보정에 딸려 움직이지만 이 부등식은 기제의 성질이다.
    const hardGate = profile(tweak((c) => { c.contest.shootRange = 14; }), SEEDS8);
    // ⚠️ 관측(#407 독립 검증 minor-5): 이 `× 2` 여유는 실측(하드 8.63 vs 감쇠 11.75 = 1.36배)에
    // 대해 두껍지 않다. 그래도 **결함이 아니다** — 이 줄은 "두 팔이 비교 가능한 볼륨대인가"만 보는
    // 전제 확인이고, 같은 describe 의 단조성 단언(`harsh.shots < soft.shots`)이 감쇠 축의 실질
    // 킬러다(감쇠가 죽으면 그쪽이 먼저 red 다). 여유를 넓히면 "비교 가능"이 무의미해지고, 좁히면
    // 다른 노브 재보정에 딸려 흔들린다 — 이중 방어가 성립하므로 현 폭을 유지한다.
    expect(harsh.shots, `볼륨대 비교 가능성: 하드 ${hardGate.shots} vs 감쇠 ${harsh.shots}`)
      .toBeLessThan(hardGate.shots * 2);
    expect(
      harsh.inBoxPct,
      `하드(sr14) 박스 ${hardGate.inBoxPct}% (슛 ${hardGate.shots}) vs 감쇠 박스 ${harsh.inBoxPct}% (슛 ${harsh.shots})`,
    ).toBeLessThan(hardGate.inBoxPct - 20);
  });
});

/* ------------------------------------------------------------------ *
 * N4  hold EV 의 1대1 예외 — **hold 를 볼륨 레버로 밀 때** 효력이 난다
 * ------------------------------------------------------------------ */
describe("#407 N4 — hold EV 에 확실한 슛(1대1) 예외", () => {
  it("`holdPenalty` 를 볼륨 레버로 밀어도 1대1 이 살아남는다 (2-A 안 A 는 여기서 죽었다)", () => {
    // 2-A 안 A(`holdPenalty` −2.0): `one_on_one` 이 팀-경기의 95.8%에서 **0건** → #316 파괴.
    // 12시드 실측: 예외 off 1대1 2.78% · on **6.28%**(2.26배). 임계는 1.5배로 둔다(시드 여유).
    const off = profile(
      tweak((c) => { c.chain.holdPenalty = -2.0; c.chain.hold.oneOnOnePenalty = 0; }),
      SEEDS12,
    );
    const on = profile(tweak((c) => { c.chain.holdPenalty = -2.0; }), SEEDS12);
    const label = `hp−2.0 에서 1대1: off ${off.oneOnOnePct}% → on ${on.oneOnOnePct}% (슛 ${off.shots}/${on.shots})`;
    expect(on.oneOnOnePct, label).toBeGreaterThan(off.oneOnOnePct * 1.5);
  });

  /**
   * 출하 기본 짝 대조(예외 off vs on) — **두 `it` 이 공유한다**.
   *
   * ⚠️ **왜 `it` 을 둘로 쪼갰나**(#407 ⑦ 독립 검증 M2). 원래 두 축(볼륨·박스 중립 / 1대1 바닥
   * 가드)이 **한 `it` 안**에 있었고, 첫 단언 `|Δshots| < 1.0` 이 실패하면서 vitest 가 거기서
   * `it` 을 끝내 **1대1 가드가 한 번도 실행되지 않았다** — 직전 웨이브(N1+N4)가 독립 검증
   * major-1 수습으로 넣은 회귀 감시 계약이 **한 웨이브 만에 조용히 무력화**된 것이다.
   * 분리는 **임계 완화가 아니라 실행 복원**이다(임계 셋 다 그대로: 1.0 · 5 · ×0.75).
   * 앞으로 한쪽이 빨개져도 다른 쪽은 계속 돌고, red 개수가 계약 개수와 일치한다.
   *
   * 그리고 그 red 자체가 **12시드 소표본 아티팩트**였다(독립 검증 실측, `callProb` 별 |Δshots|):
   *   0.013 → 12시드 0.25 / n60 0.21 · 0.03 → 0.84 / **0.02** ·
   *   **0.045(출하) → 1.0000(red) / n60 0.24** · 0.07 → 0.12 / 0.14
   * 즉 **n60 에서 N4 는 여전히 중립**(Δ 0.24)이고, 12시드 노이즈가 `< 1.0` 경계에 정확히
   * 착지했을 뿐이다. 임계 재도출·표본 상향은 이 계약의 소유 이슈 소관이다(#377 함정 ④).
   *
   * 재측정은 **한 번만** 한다(12시드 × 2팔 = 24 매치). 결정론이라 메모가 안전하다.
   */
  let shippingArms: { off: Profile; on: Profile } | undefined;
  function shippingPair(): { off: Profile; on: Profile } {
    if (!shippingArms) {
      const off = profile(tweak((c) => { c.chain.hold.oneOnOnePenalty = 0; }), SEEDS12);
      const on = profile(cfg, SEEDS12);
      // eslint-disable-next-line no-console
      console.log(
        `[#407 N4 출하 중립] 슛 ${off.shots}→${on.shots} · 박스 ${off.inBoxPct}%→${on.inBoxPct}% · ` +
          `1대1 ${off.oneOnOnePct}%→${on.oneOnOnePct}%`,
      );
      shippingArms = { off, on };
    }
    return shippingArms;
  }

  it("출하 기본에서는 볼륨·박스 편중이 거의 중립이다", () => {
    // 기본 트리는 1대1 에서 이미 슛으로 끝나는 편이라 바뀔 결정이 적다 — 이 중립성이
    // "N4 를 켜도 재보정이 필요 없다"의 근거다. 12시드: 슛 17.58→17.33 · 박스 41.5→43.8.
    //
    // ⚠️ **중립은 볼륨·거리 축에 한한다**(#407 독립 검증 major-1). 60시드 짝 대조에서
    // 출하 팔의 1대1 은 **6.08% → 5.05%**(−17% 상대 · 절대 126→106건) 로 **내려갔다** —
    // 원인 미규명이고, `hp−2.0` 팔에서 1대1 을 살린 것(3.33→5.33)과 방향이 반대다.
    // 그래서 그 축은 **아래 별도 `it`** 이 본다: 이 `it` 의 두 줄(`shots`·`inBoxPct`)은 **정작
    // 움직인 지표를 안 보고**, #316 계약(`one-on-one.test.ts` = `total > 0`)도 이 정도 감소를
    // 잡을 검정력이 없다.
    const { off, on } = shippingPair();
    expect(Math.abs(on.shots - off.shots), `슛 ${off.shots} → ${on.shots}`).toBeLessThan(1.0);
    expect(Math.abs(on.inBoxPct - off.inBoxPct), `박스 ${off.inBoxPct}% → ${on.inBoxPct}%`)
      .toBeLessThan(5);
  });

  it("출하 기본에서 1대1 이 붕괴하지 않는다 (바닥 가드)", () => {
    const { off, on } = shippingPair();
    // ⚠️ **이 `it` 이 실제로 돌았다는 증거를 매 실행 남긴다**(#407 ⑦ M2). 분리 전에는 옆 단언이
    // 먼저 죽어 이 줄이 **한 번도 실행되지 않았고**, 그 사실이 리포트 어디에도 안 보였다 —
    // 통과/실패가 아니라 **부재**가 문제였으므로 로그가 곧 계약의 일부다(vitest 기본 리포터는
    // 느린 테스트만 이름을 찍는데, 이 `it` 은 메모된 값만 읽어 0ms 라 목록에 안 뜬다).
    // eslint-disable-next-line no-console
    console.log(
      `[#407 N4 1대1 바닥 가드 실행] on ${on.oneOnOnePct}% vs 하한 ` +
        `${(off.oneOnOnePct * 0.75).toFixed(2)}% (= off ${off.oneOnOnePct}% × 0.75)`,
    );
    // 소시드에서 잡히는 것은 **붕괴뿐**이다 — 근거는 아래.
    // **하한 = base 대비 상대 −25%. 왜 그 폭인가, 그리고 이 줄이 무엇을 못 하는가:**
    //  · ⚠️ **12시드는 60시드의 −17% 를 재현하지 못한다.** 여기서 실측한 짝 대조는
    //    **5.69% → 5.77%**(+1.4%, 부호가 오히려 반대)다. 즉 이 표본에서 그 이동은
    //    노이즈에 묻힌다 — 12시드(팀-경기 24 · 슛 ~420 · 1대1 ~25건)에서 p≈0.057 의
    //    이항 SE 는 ~1.1%p(= base 대비 상대 ±19%)이고, 찾는 신호(−17%)가 **1 SE 보다 작다**.
    //    표본을 60시드로 올리지 않는 한 어떤 임계도 그 이동을 못 잡는다(그리고 이 파일의
    //    규율은 소시드 ≤12 다 — 밴드 판정은 60시드 프로브의 일이다).
    //    ⚠️ 이 SE 는 **주변(marginal)** 값이다. 두 팔이 시드를 공유하므로 짝 차이의 분산은
    //    이보다 작을 수 있는데, **실측이 그 이론을 이겼다** — 12시드 짝 대조가 부호까지
    //    반대로 나왔다(+1.4%). 그래서 근거는 SE 계산이 아니라 **이 실측**이고, SE 는 임계를
    //    고를 때 쓴 보수적 눈금일 뿐이다.
    //  · 그래서 이 줄은 **밴드 재판정이 아니라 바닥(floor) 가드**다. 잡는 것은
    //    "1대1 이 반토막 난다"(2-A 안 A 가 죽은 방식 = 상대 −50% 이상, SE 의 2.5배 밖)이고,
    //    −25% 는 노이즈 1 SE(±19%)를 헛 red 없이 넘기면서 그 붕괴는 확실히 무는 자리다.
    //  · −17% 자체의 감시 권한은 60시드 프로브(`research/e407-probe/e407-diversity.ts`,
    //    재현 커맨드 = `issues/2026-08-02-engine-shot-gate-decay.md` §8)에 남는다. 그 수치는
    //    노트 §3 표에 박제돼 있고, **원인은 아직 미규명**이다(#407 후속 과제).
    //  · N2 웨이브가 1대1 을 되살리면 이 하한을 **올려서** 그 성과를 박제하는 것이 다음 순서다.
    //  · 그때까지 이 줄의 값어치는 임계가 아니라 `shippingPair()` 의 **`console.log`** 다 —
    //    볼륨·박스만 보던 중립 계약이 이제 정작 움직인 지표를 **매 실행 출력**한다.
    //  · ⚠️ 그 로그도 **이 `it` 이 실제로 도는 것**이 전제다. 옆 `it`(볼륨 중립)이 빨개져도
    //    여기는 계속 돈다 — 그게 `it` 을 분리한 이유다(#407 ⑦ M2, describe 상단 주석).
    expect(
      on.oneOnOnePct,
      `1대1 ${off.oneOnOnePct}% → ${on.oneOnOnePct}% (60시드 실측 6.08 → 5.05 = −17%)`,
    ).toBeGreaterThan(off.oneOnOnePct * 0.75);
  });
});

/* ------------------------------------------------------------------ *
 * 롤백 계약 — 스위치 2개를 끄면 0.40.0 과 **bit-identical**
 * ------------------------------------------------------------------ */
describe("#407 N1+N4 롤백 — 스위치를 끄면 0.40.0 과 비트 동일", () => {
  /**
   * 0.40.0(origin/main 80e25a8) 에서 실측한 최종 스냅샷 해시 =
   * ["f9d9d778","756ec350","f7031974","e5b0e30b"].
   * ⚠️ #407 ⑦(engine@0.42.0) 재기록 — `rules.offside.callProb` 0.013 → 0.045 는 이 웨이브의 두
   * 스위치 **밖**에서 도는 심판 판정이라 롤백 경로에서도 걸린다(`vision.test.ts` ·
   * `press-unit.test.ts` · `def-line.test.ts` 와 같은 처방). 계약 주장은 그대로다:
   * "N1/N4 스위치를 끄면 그 두 웨이브의 코드가 한 줄도 안 돈다".
   */
  const GOLDEN_040 = ["7b731a91", "756ec350", "460ce36e", "e263aa15"];
  it("chain.shootDistance.enabled=false + chain.hold.oneOnOnePenalty=0 → 0.40.0 해시", () => {
    const c = tweak((x) => {
      x.chain.shootDistance.enabled = false;
      x.chain.hold.oneOnOnePenalty = 0;
      // #407(0.44.0) — 박스 유입 팔은 이 두 스위치 **밖**의 config-only 변경이다. ⑦ 까지의
      // 관용구는 골든 재기록이었지만 그러면 "0.40.0 과 같다"는 앵커가 사라진다 → 대신 기준점을
      // 옮긴다(`realism/rollback.ts`). 위 상수는 그대로이고, 이 줄이 그것을 재현 가능하게 한다.
      preShipping(x);
    });
    const got = REALISM_SEEDS.slice(0, 4).map(
      (s) =>
        runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, c)
          .tickSnapshots.slice(-1)[0]!.hash,
    );
    expect(got).toEqual(GOLDEN_040);
  });
});
