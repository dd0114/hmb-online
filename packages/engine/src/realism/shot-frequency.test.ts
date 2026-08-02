import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { aggregateRealism, GUARD_SEEDS } from "./harness";
import { LADDER, LADDER_TAG } from "./gate";

/**
 * G-A 슛 빈도 계약 (#99, §2.5 E2E-TDD).
 *  A) 단조성: 슛 성향(decisionWeights.shoot)을 올리면 팀당 슛 수가 늘어난다(구조적 회귀 가드).
 *  B) 리얼 config 다수시드 팀당 슛 ∈ [12,14](벤치, football-stats.md §3) + 골이 hero 목표대로 나온다.
 * A 는 config 노브가 슛 빈도의 실제 레버임을 박제(threshold 절벽·멀티플라이어 상호작용에도 방향 보존).
 *
 * ── ⚠️ 골 계열 밴드는 리얼리즘이 아니라 **게임 디자인 결정**이다 (engine@0.25.0) ─────────────
 * **hero 결정: 경기당 골(양팀 합) 평균 5골이 목표.** 근거는 리얼리즘이 아니라 재미다 —
 * "밸런스는 나중에, 그건 config 로 조정할 수 있잖아. 중요한 건 **그런 플레이가 가능한지**야."
 * 실제 축구(2.7–3.3골/경기)의 1.5~1.9배이고, **골·슛→골 전환·슛당 xG 에는 리얼리즘 밴드를
 * 적용하지 않는다**. `bench.ts` 의 goals/shotConvPct/xgPerShot 밴드는 그대로 두되(그건 실축
 * 벤치의 단일 출처다) **계약의 SoT 는 이 파일**이고, 둘이 어긋나는 것은 의도다.
 *
 * 반대로 **구조 지표는 리얼리즘에 붙여 둔다** — 패스 성공률 78–85(`pass-accuracy.test.ts`) ·
 * 팀 width 40–50 · 코너 4–6 · 스로인 17–19 · 유효슛 4.5–5.5 · **팀당 슛 12–14**.
 * 볼륨을 올리다 이것들이 밴드를 벗어나면 그건 "골을 맞춘 것"이 아니라 조정을 잘못한 것이다.
 */

const cfg = defaultEngineConfig;

// 60 시드(팀-경기 120). SD 크지만 평균은 밴드 내 안정.
const agg = aggregateRealism(cfg, GUARD_SEEDS);

/**
 * 사다리 판정식의 **절대 폭 하한**(3.5슛)은 90분 경기에서 뜬 값이다 — 슛/팀·경기 단위라 경기
 * 길이에 비례한다. #365 로 길이가 노브가 됐으므로 상수로 두면 길이를 반으로 줄인 날 "레버가
 * 침식됐다"고 거짓 신호를 낸다. **비율 판정식(1.35배)은 길이에 무관하므로 한 자리도 안 건드린다.**
 */
const SPAN_FLOOR = 3.5 * (cfg.matchMinutes / 90);

/**
 * ⚠️ **#365(경기 45분화)로 볼륨 밴드를 재도출했다 — 노브는 하나도 안 돌렸다.**
 *
 * 아래 밴드들은 전부 **90분 경기**에서 뜬 값이었다(실축 벤치 12–14 슛, hero 목표 5골).
 * 경기가 45분이 되면 같은 확률로도 볼륨이 내려간다 — 그건 회귀가 아니라 **길이의 귀결**이다.
 * hero 판정(2026-07-31): *"경기 내용은 다른 곳에서 튜닝할 거야, 지금은 시간만 건드려."*
 * 그래서 이 웨이브는 확률 노브를 건드리지 않고 **밴드만 45분 실측 위에 다시 세운다.**
 *
 * ⚠️ **"×2 환산"으로 옛 밴드를 재사용하면 안 된다** — 볼륨이 선형으로 반이 되지 않는다.
 * 경기를 4등분한 팀당 슛 밀도가 90분에서 **5.30 / 2.23 / 2.55 / 2.27** 로 **초반이 후반의 2.3배**라,
 * 짧은 경기일수록 그 초반 구간의 비중이 커진다.
 * 45분/90분 비(같은 노브, **GUARD_SEEDS 60시드**): 슛 **×0.616** · 골 **×0.590** ·
 * 스로인 ×0.496(= 사실상 정확히 선형). 즉 **비선형은 슛·골 계열의 성질**이고 순수 카운트 지표는
 * 선형이다. (20시드 REALISM_SEEDS 로는 골 ×0.504 가 나왔는데 그건 표본 차이다 — 밴드 판정은
 * 60시드가 기준이므로 그 값을 적는다. 독립검증 m3.)
 *
 * **폭은 그대로다** — 각 밴드의 상대 폭(±7.7% · ±13.7% · ±10%)을 유지한 채 중심만 45분 실측으로
 * 옮겼다. 즉 판정 세기는 안 낮췄다.
 * **"경기당 5골" 목표를 45분 경기에서도 유지할지는 밸런스 트랙(#10)이 정한다** — 이 파일이
 * 그 결정을 대신하지 않는다.
 */
describe("G-A 슛 빈도 밴드(45분 경기 재도출) — hero 목표 골은 밸런스 트랙 소관", () => {
  it(`팀당 슛 7.2–8.4 (측정 ${agg.mean.shots})`, () => {
    // 밴드는 **안 넓혔다**(D4 확정 벤치 12-14 그대로). 0.25.0 볼륨 재보정 때 골을 5 로 올리는
    // 방법이 두 가지였다 — ① 슛을 20 넘게 늘려 전환율을 실축(10-12%)에 두거나 ② 슛은 벤치
    // 안에 두고 전환율을 올리거나. **②를 골랐다**: hero 가 리얼리즘 밴드를 면제한 것은 골 계열뿐이고,
    // 슛 수는 "경기가 어떻게 흘러가나"를 보는 구조 지표라 벤치에 붙여 두는 게 맞다.
    // 그래서 골 5 를 만드는 데 필요한 슛은 13.6 (전환 18.9%) — 여전히 12–14 한가운데다.
    // 구 밴드 12–14(90분·D4 확정 벤치, 중심 13 ±7.7%) → 45분 실측 7.81 중심에 **같은 상대 폭**.
    expect(agg.mean.shots).toBeGreaterThanOrEqual(7.2);
    expect(agg.mean.shots).toBeLessThanOrEqual(8.4);
  });
  it(`슛당 xG 0.18–0.24 (측정 ${agg.mean.xgPerShot}) — hero 결정: 경기당 5골 목표, 리얼리즘 밴드 미적용`, () => {
    // 구 밴드 0.10–0.13(실축). 골 5 를 슛 13.6 으로 만들려면 슛당 xG 가 그 2배여야 한다
    // (5.10 / (13.64×2) = 0.187). 즉 이 수치는 "슛 질이 왜곡됐다"가 아니라 **hero 목표 골의 정의상
    // 귀결**이다. 밴드 폭(±0.03)은 구 밴드(±0.015)의 2배 — 값이 2배가 됐으므로 상대 폭은 동일하다.
    expect(agg.mean.xgPerShot).toBeGreaterThanOrEqual(0.18);
    expect(agg.mean.xgPerShot).toBeLessThanOrEqual(0.24);
  });
  it(`골: 경기당(양팀 합) ∈ [2.8, 3.7] (측정 ${agg.goalsPerMatch})`, () => {
    // 구 밴드 [4.4, 5.8] = **90분 경기**에서의 hero 목표 5.0 ±13.7%. 45분 실측 3.28 중심에 같은 폭.
    // ⚠️ 이 줄은 이제 "hero 목표를 지킨다"가 아니라 **"길이만 바뀌고 확률은 안 바뀌었다"** 를 지킨다.
    // 45분 경기에서 목표를 몇 골로 둘지는 밸런스 트랙의 결정이다(#365 hero 판정).
    expect(agg.goalsPerMatch).toBeGreaterThanOrEqual(2.8);
    expect(agg.goalsPerMatch).toBeLessThanOrEqual(3.7);
  });
  it(`팀당 골 ∈ [1.4, 1.85] (측정 ${agg.mean.goals})`, () => {
    // 위 goalsPerMatch 의 팀 단위 표현(양팀 합/2). 구 밴드 [2.2,2.9] = 90분 기준.
    // ⚠️ 상한은 **[2.8, 3.7] / 2 = [1.4, 1.85]** 여야 한다 — 1.9 로 두면 이 파일이 스스로
    //   "팀 단위 표현"이라 부르는 관계가 상한에서만 깨진다(독립검증 m2). 그러면 팀당 골이
    //   1.86~1.90 인 상태가 여기선 통과하고 위 줄에서만 걸려, 둘 중 뭐가 기준인지 모호해진다.
    expect(agg.mean.goals).toBeGreaterThanOrEqual(1.4);
    expect(agg.mean.goals).toBeLessThanOrEqual(1.85);
  });
  it(`슛→골 전환 17–22% (측정 ${agg.mean.shotConvPct}) — hero 결정: 경기당 5골 목표, 리얼리즘 밴드 미적용`, () => {
    // 구 벤치 10–12%(실축). 골 5 / 슛 13.6 의 정의상 귀결이라 별도 튜닝 대상이 아니라 **정합성 가드**다
    // (골만 맞고 전환율이 딴 데 있으면 슛이나 골 집계가 어긋난 것).
    expect(agg.mean.shotConvPct).toBeGreaterThanOrEqual(17);
    expect(agg.mean.shotConvPct).toBeLessThanOrEqual(22);
  });
  it(`유효슛 2.9–3.5 (측정 ${agg.mean.onTarget})`, () => {
    // 골 계열이지만 여기만 벤치를 지킨다 — 유효슛은 "골이 몇 개냐"가 아니라 "골문으로 몇 번 가나"라
    // 관전 리듬의 구조 지표에 가깝다. xgBase 상향으로 5.89 까지 튄 것을 `onTargetBase` 0.235→0.21 로
    // 되돌려 5.37 로 맞췄다(config.ts 주석 참조).
    // 구 밴드 4.5–5.5(90분 실축 벤치, 중심 5.0 ±10%) → 45분 실측 3.18 중심에 같은 상대 폭.
    expect(agg.mean.onTarget).toBeGreaterThanOrEqual(2.9);
    expect(agg.mean.onTarget).toBeLessThanOrEqual(3.5);
  });
});

// ── #371: 이 describe 는 **온디맨드**다 (기본 스킵, `HMB_LADDER=1` 로 켠다) ─────────────────
// 아래 3개 it 은 60시드 집계를 **총 10회** 돌린다(사다리 4+1 · 볼륨 3 · weighted 2점) = 4.8분,
// `npm test` 4.3분의 대부분이 이것이었다. 사다리는 "노브가 정말 레버인가"를 보는 계약이라
// **노브를 만지는 웨이브에서** 필요하고 매 커밋마다 필요하지 않다. 위 밴드 describe(집계 1회,
// 28.8초)는 **계속 항상 돈다** — 밴드 이탈은 어떤 변경에서도 즉시 잡혀야 하기 때문이다.
// ⚠️ 삭제가 아니라 게이트다. 근거·규칙·실행법 = `gate.ts`, 커버리지 손실 가드 = `gate.test.ts`.
describe.skipIf(!LADDER)(`G-A 단조성: 슛 노브↑ → 슛 수↑ (config 가 실제 레버) ${LADDER_TAG}`, () => {
  // ── engine@0.24.0 사슬 코어 채택으로 **레버가 바뀌었다** (#279) ────────────────────────
  // 이 계약의 목적은 예나 지금이나 하나다: **슛 빈도를 config 로 움직일 수 있는가**(구조적 회귀
  // 가드 + S8 밸런스의 전제). 바뀐 것은 "그 노브가 무엇인가" 뿐이다.
  //
  // 왜 `decisionWeights.shoot` 이 더 이상 레버가 아닌가:
  //   weighted 코어는 **행동별 즉시 점수**를 가중 추첨하므로 `decisionWeights.shoot` 이 곧 슛 성향이다.
  //   chain 코어는 행동이 아니라 **도달하는 상태의 EV** 를 비교한다(chain.ts:evaluateCandidateEv) —
  //   슛의 EV = xg × `chain.goalValue` + (1−xg) × 턴오버가치 라 `decisionWeights` 를 아예 읽지 않는다.
  //   실측(GUARD_SEEDS=60, chain): shoot 0.15/0.30/0.80 전부 **12.31 로 동일**(완전 무반응).
  //   ⚠️ 선수 단위 `behavior.shootTendency` 는 chain 에서도 살아 있다(EV 배수) — 죽은 것은
  //      **config 팀 레벨 상수** 하나다. 이 사실은 S8(밸런스 1회)의 입력이다.
  //
  // 그래서 사다리를 **활성 코어의 실제 레버**(`chain.goalValue`)로 옮긴다. 임계(비율 1.35배 · 절대
  // 3.5)는 **하나도 손대지 않았다** — 판정 세기를 낮추지 않고 노브만 현행화한 것이다.
  //
  // 실측(engine@0.24.0 chain, GUARD_SEEDS=60시드):
  //   8→1.20 · 10→7.65 · 12→12.31(기본) · 14→14.22 · 18→16.77 · 26→17.50 · (40→18.54)
  //   하단 8 은 "슛 EV 가 패스 EV 를 못 이겨 거의 안 쏘는" 축퇴 구간이라 사다리 최하단으로 둔다.
  //
  // 실측 갱신(engine@0.25.0 볼륨 재보정 후, GUARD_SEEDS=60시드):
  //   8→3.35 · 10→8.67 · 12→10.91 · 14→11.92 · 18→13.67 · 26→13.78 · (40→14.28) · 기본값은 24(13.64)
  //   총효과 = 절대 10.93 · 4.26배 (임계 3.5 / 1.35배 — **임계는 하나도 안 건드렸다**).
  //   ⚠️ 주의: 18→26 구간이 +0.11 로 얇다(SE(Δ)≈0.47). 소유 틱이 줄며 곡선이 **더 일찍 포화**해서다
  //      (구 코어는 26 까지 계속 올랐다). 다음에 여기가 깨지면 계약을 약화시키지 말고 rung 을
  //      포화 이전 구간(≤18)으로 옮겨라 — 레버가 죽은 게 아니라 포화점이 내려온 것이다.
  //
  // ── 무엇을 잃었나(명시) ──────────────────────────────────────────────────────────
  // 구 사다리가 재던 `decisionWeights.shoot` 의 미세 단조성(0.04~0.08 폭 감도)은 chain 에서 **정의
  // 자체가 없다**. 그 감도는 weighted(롤백 경로)에서만 의미가 있으므로 아래 별도 it 에서 2점
  // 대비로만 지킨다(60시드 × 6 rung 을 두 코어 모두 도는 비용은 게이트 시간에 안 맞는다).
  //
  // ── #357: rung 을 **포화 이전 구간으로 옮겼다**(이 주석의 지시대로) ──────────────────
  // 위 "다음에 여기가 깨지면 계약을 약화시키지 말고 rung 을 포화 이전 구간(≤18)으로 옮겨라 —
  // 레버가 죽은 게 아니라 포화점이 내려온 것이다" 를 그대로 집행한다.
  // #357 이 가치 부등식을 세우며(`chain.goalValue` 9.4 → 22) 이 노브의 **역할이 바뀌었다**:
  // 이제 gv 는 "자유로운 선수가 쏘는가"(질, r=threatWeight/goalValue)를 정하고, **볼륨은
  // `contest.shootXgThreshold` 가 정한다**. 그래서 gv 는 12 위에서 사실상 포화한다.
  // 60시드 실측(#357 기본값 트리): 8→6.46 · 10→10.32 · 12→12.11 · **14→11.91** · 18→12.95 ·
  //   26→12.55 · 40→13.23  ← 14 가 12 보다 낮다(포화 구간의 노이즈, SE(Δ)≈0.47).
  // → rung 에서 14·26 을 뺀다. **임계(비율 1.35 · 절대 3.5)는 한 자리도 안 건드렸다.**
  //   현재 총효과 6.46 → 13.23 = 절대 6.77 · 2.05배 (구 4.26배보다 낮지만 임계 위).
  // 그리고 **새 볼륨 레버의 사다리를 아래에 추가**한다(계약이 약해지지 않게 — 이 웨이브에서
  // 슛 볼륨을 실제로 움직이는 노브가 그쪽이므로, 거기에 사다리가 없으면 회귀 가드가 빈다).
  it("chain.goalValue 사다리 8→18 엄격 단조 + 18→40 비엄격(포화 구간)", () => {
    const ladder = [8, 10, 12, 18];
    const SAT = 40; // 포화 구간 상단(비엄격 판정)
    const measure = (goalValue: number) =>
      aggregateRealism({ ...cfg, chain: { ...cfg.chain, goalValue } }, GUARD_SEEDS).mean.shots;

    const shots = ladder.map(measure);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i], `goalValue ${ladder[i - 1]}→${ladder[i]} 구간에서 증가해야 (측정 ${shots.join(" → ")})`)
        .toBeGreaterThan(shots[i - 1]!);
    }
    const sat = measure(SAT);
    // 포화 상단: 증가는 요구하지 않되 **하락은 금지**(tol 은 구 계약과 동일한 1.0슛).
    expect(sat, `goalValue 18→${SAT} 는 포화 구간이라 증가는 안 봐도 되지만 하락하면 회귀다 (18=${shots[shots.length - 1]}, ${SAT}=${sat})`)
      .toBeGreaterThanOrEqual(shots[shots.length - 1]! - 1.0);

    // 총효과 판정식은 구 계약 그대로(비율 주 + 절대 하한). 현재: 1.20 → 18.54 = 절대 17.34 · 15.45배.
    const span = sat - shots[0]!;
    const ratio = sat / shots[0]!;
    const label = `전 구간 총효과 (8=${shots[0]} → ${SAT}=${sat}) 절대 ${span.toFixed(2)} · 비율 ${ratio.toFixed(2)}배`;
    expect(ratio, `${label} — 레버 비율이 죽었다`).toBeGreaterThan(1.35);
    expect(span, `${label} — 절대 폭 하한(무한 침식 방지, 경기 길이 비례)`).toBeGreaterThan(SPAN_FLOOR);
  });

  /**
   * #357 — **현 볼륨 레버의 사다리**. `chain.goalValue` 가 질(자유로운 선수가 쏘는가)을,
   * `contest.shootXgThreshold` 가 양을 맡게 되면서 이 노브가 슛 빈도의 실제 레버가 됐다.
   * 위 gv 사다리가 포화 구간으로 밀려난 만큼 여기서 회귀 가드를 받는다.
   *
   * 임계(비율 1.35 · 절대 3.5)는 gv 사다리와 **같은 판정식**을 쓴다(새로 정하지 않는다).
   * 60시드 실측(#357 기본값 트리): 0.198→12.20 · 0.196→13.03 · 0.194→14.17 · 0.190→15.50 ·
   *   0.186→17.06  (임계가 낮을수록 슛이 는다 = 내림차순 rung)
   * rung 을 3점으로 둔 이유는 게이트 시간이다(60시드 × 1점 ≈ 25초). 간격은 폭 0.006 으로
   * 잡아 rung 당 참효과(≈2.4슛)가 SE(Δ)≈0.47 의 다섯 배 위에 오게 했다 — 그리고 그래야
   * 총효과가 gv 사다리와 **같은 판정식**(1.35배·3.5슛)을 통과한다(0.198↔0.190 은 1.27배로 미달).
   */
  // ── #365(경기 45분화): **임계는 그대로, rung 을 넓혔다** (이 파일의 기존 규율 그대로) ──────
  // 경기가 반이 되면 총효과 비율이 압축된다 — 경기 초반의 슛 밀도가 후반의 2.3배라 그 구간이
  // **길이에 비례하지 않는 바닥**으로 남기 때문이다(90분 12.20→17.06 = 1.40배 / 45분 같은 rung
  // 7.81→10.11 = **1.29배**, 양쪽에 +1.7 정도의 고정분을 더하면 그대로 설명된다).
  // 레버가 죽은 게 아니므로 임계(1.35배)를 내리지 않고 rung 을 0.186 → **0.180** 으로 넓힌다.
  // 45분 60시드 실측: 0.198→7.81 · 0.189→9.26 · 0.180→10.73 (엄격 단조 · 절대 2.92 · **1.374배**).
  it("contest.shootXgThreshold 사다리 0.198→0.180 엄격 단조(임계↓ = 슛↑)", () => {
    const rungs = [0.198, 0.189, 0.180];
    const measure = (shootXgThreshold: number) =>
      aggregateRealism({ ...cfg, contest: { ...cfg.contest, shootXgThreshold } }, GUARD_SEEDS).mean.shots;
    const shots = rungs.map(measure);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i], `shootXgThreshold ${rungs[i - 1]}→${rungs[i]} 구간에서 증가해야 (측정 ${shots.join(" → ")})`)
        .toBeGreaterThan(shots[i - 1]!);
    }
    const span = shots[shots.length - 1]! - shots[0]!;
    const ratio = shots[shots.length - 1]! / shots[0]!;
    const label = `총효과 (0.198=${shots[0]} → 0.180=${shots[shots.length - 1]}) 절대 ${span.toFixed(2)} · 비율 ${ratio.toFixed(2)}배`;
    expect(ratio, `${label} — 레버 비율이 죽었다`).toBeGreaterThan(1.35);
    expect(span, `${label} — 절대 폭 하한(무한 침식 방지, 경기 길이 비례)`).toBeGreaterThan(SPAN_FLOOR);
  });

  /**
   * #407 N1 — **슛 거리 감쇠(`chain.shootDistance`)의 사다리.**
   *
   * 이 노브는 출하 기본이 `enabled:false` 다(축 B 악화 때문 — `config.ts` 주석). 그래도 사다리를
   * 두는 이유는 #338 의 교훈 그대로다: **"지금 안 쓰는 레버"와 "죽은 레버"는 다르고, 둘을
   * 구분해 두지 않으면 다음 웨이브(N2)가 이 노브를 켰을 때 무엇이 고장 난 건지 알 수 없다.**
   * 그래서 스위치를 켠 위에서 단조성을 잰다(`dead-knobs.test.ts` 의 조건부 LIVE 와 같은 규율).
   *
   * 판정식은 이 파일의 다른 사다리와 **같다**(비율 1.35 · 절대 `SPAN_FLOOR`). 새로 정하지 않는다.
   * rung 은 `freeM=0`(전 거리 감쇠) 팔에서 잡았다 — 20시드 실측:
   *   perM 0.05 → 6.90 · 0.04 → 10.85 · 0.03 → 16.50 · 0.02 → 25.20  (감쇠↑ = 슛↓)
   * 3점으로 줄인 이유는 게이트 시간이다(60시드 × 1점 ≈ 25초).
   */
  it("chain.shootDistance.perM 사다리 0.05→0.02 엄격 단조(감쇠↓ = 슛↑)", () => {
    const rungs = [0.05, 0.03, 0.02];
    const measure = (perM: number) =>
      aggregateRealism(
        {
          ...cfg,
          chain: {
            ...cfg.chain,
            shootDistance: { enabled: true, genMaxM: 34, freeM: 0, perM, floor: 0.05 },
          },
        },
        GUARD_SEEDS,
      ).mean.shots;
    const shots = rungs.map(measure);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i], `perM ${rungs[i - 1]}→${rungs[i]} 구간에서 증가해야 (측정 ${shots.join(" → ")})`)
        .toBeGreaterThan(shots[i - 1]!);
    }
    const span = shots[shots.length - 1]! - shots[0]!;
    const ratio = shots[shots.length - 1]! / shots[0]!;
    const label = `총효과 (0.05=${shots[0]} → 0.02=${shots[shots.length - 1]}) 절대 ${span.toFixed(2)} · 비율 ${ratio.toFixed(2)}배`;
    expect(ratio, `${label} — 레버 비율이 죽었다`).toBeGreaterThan(1.35);
    expect(span, `${label} — 절대 폭 하한(무한 침식 방지, 경기 길이 비례)`).toBeGreaterThan(SPAN_FLOOR);
  });

  // 롤백 경로(`chain.mode: "weighted"`)의 레버도 살아 있어야 한다 — 롤백이 "돌아가긴 하는데 튜닝은
  // 못 하는" 상태면 롤백 스위치로서 쓸모가 없다. 2점 대비(사다리 아님)인 이유는 비용이다.
  // 실측(engine@0.24.0 weighted, GUARD_SEEDS=60): 0.15→9.53 · 0.80→13.69 = 절대 4.16 · 1.44배.
  //
  // ── 0.25.0: **임계는 그대로, 대비점을 레버의 실제 사용 범위로 옮겼다** ────────────────────
  // 왜: `contest.xgBase` 0.195→0.42 는 weighted 코어에서 **슛 점수의 바닥을 통째로 올린다**.
  // 그러면 shoot 가중이 낮아도 슛이 이미 이기기 때문에 **내부 구간의 대비가 압축된다** —
  // 60시드 실측 0.15→9.03 · 0.80→12.52 = 절대 **3.49**(구 4.16), 비율 1.39배(임계 1.35 통과).
  // 즉 레버가 죽은 게 아니라 (0.15, 0.80) 이라는 **내부 2점이 더 이상 레버를 분해하지 못한다**.
  // 그래서 임계(절대 3.5 · 비율 1.35)는 **한 자리도 안 건드리고**, 대비점을 레버가 실제로 움직이는
  // 전 구간(0.10 ↔ 1.00)으로 옮긴다. 판정 세기는 오히려 올라간다 — 여유가 4.16 대비 19% 에서
  // 5.80 대비 66% 로 늘기 때문이다.
  // 실측(engine@0.25.0 weighted, GUARD_SEEDS=60):
  //   0.10→7.43 · 0.15→9.03 · 1.00→13.23 · (1.40→13.13 = 포화)
  //   → 대비 절대 5.80 · 1.78배. 상단을 1.00 으로 잡은 이유가 그 포화다(1.40 은 더 안 오른다).
  it("롤백 경로(weighted)의 decisionWeights.shoot 은 여전히 레버다 (0.10 vs 1.00)", () => {
    const weighted: EngineConfig = { ...cfg, chain: { ...cfg.chain, mode: "weighted" } };
    const measure = (shoot: number) =>
      aggregateRealism({ ...weighted, decisionWeights: { ...cfg.decisionWeights, shoot } }, GUARD_SEEDS).mean.shots;
    const lo = measure(0.1);
    const hi = measure(1.0);
    const label = `weighted shoot 0.10=${lo} → 1.00=${hi} (절대 ${(hi - lo).toFixed(2)} · 비율 ${(hi / lo).toFixed(2)}배)`;
    expect(hi / lo, `${label} — 롤백 경로의 레버 비율이 죽었다`).toBeGreaterThan(1.35);
    expect(hi - lo, `${label} — 롤백 경로의 절대 폭 하한(경기 길이 비례)`).toBeGreaterThan(SPAN_FLOOR);
  });
});
