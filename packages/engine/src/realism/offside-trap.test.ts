import { describe, it, expect } from "vitest";
import type { TacticalInput } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS, GUARD_SEEDS } from "./harness";
import { preShipping } from "./rollback";
import { LADDER, LADDER_TAG } from "./gate";
import { setDefShapeObserver } from "../action";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { measureTrap, measureTrapFire, measureRefereeLineMismatch, measureDeadStops, trapOn, withLine, type TrapFireReport } from "./trap";

/**
 * #377 트랙 D **S3-C — 오프사이드 트랩**(로드맵 W5-3).
 *
 * ## 무엇이 없었나 (구조 사실 — 측정이 아니다)
 * `team.offsideTrap` 의 소비처는 `contest.ts:checkOffside` **하나**였고, 거기서 하는 일은
 * **심판이 쓰는 판정선을 `rules.offside.trapBiasM`(2.5m) 만큼 옮기는 것**이 전부였다.
 * 선수 목표를 읽는 코드도, 라인을 미는 코드도 **0줄**이다. 즉 트랩은 약한 것이 아니라 **없었다**
 * — 유저/AI 가 트랩을 지시해도 선수는 한 명도 다르게 서지 않았다.
 *
 * ## ⚠️ 이 파일이 **자기 주장 하나를 반증하고 있다** — 그게 의도다
 * 스코프 단계에서 이 웨이브의 비동어반복 앵커로 세운 계약이 **T3 프론티어**였다:
 * *"트랩은 같은 평균 라인 높이에서 무차별 상향(`defensiveLineHeight`)보다 위험 대비 효율이
 * 높다"*. 두 독립 레버가 같은 교환곡선 위에 앉는 것을 먼저 확인했으므로 이 주장은
 * **정의상 참이 아니고 실패할 수 있는 주장**이었다.
 *
 * **그리고 실패했다.** 60시드 실측(전부 트랩 ON 레짐, 플라시보 대조 — 아래 표는 minor 수습에서
 * **콜드 재측정**한 값이라 착지 표와 소수 셋째 자리가 다르다. 결론은 같다):
 *
 * | 팔 | 라인(m) | 잡힘 | 뚫림% |
 * |---|---|---|---|
 * | 플라시보(`stepUpM=0`) | 27.719 | 0.6015 | 10.480 |
 * | 트랩 2.5(출하) | 28.073 | 0.6210 | 11.291 |
 * | 트랩 6 | **28.731** | **0.6803** | **13.445** |
 * | 무차별 `defensiveLineHeight` 0.60 | 28.152 | 0.6763 | 11.976 |
 * | 무차별 0.65 | **28.585** | **0.7401** | **13.158** |
 *
 * **같은 라인 높이에서 무차별 상향이 트랩을 순수 지배한다** — 무차별 0.65 는 트랩 6 보다
 * 라인이 **더 낮은데도**(28.585 vs 28.731) **더 많이 잡고**(0.7401 vs 0.6803) **덜 뚫린다**
 * (13.158 vs 13.445). 세 축이 전부 같은 쪽이라 교환곡선을 그릴 필요조차 없다. 커밋된 n20
 * 스냅샷도 같은 형태다(트랩 6: 28.73 / 0.695 / 14.03 · 무차별 0.65: 28.71 / 0.740 / 13.17).
 *
 * ⚠️ **"프론티어 대비 몇 배"라는 표현은 철회했다**(독립검증 m6) — 그건 프론티어 기울기를
 * **한 점에서** 추정해 나눈 파생량이라 표본에 취약하다(같은 `min0` 팔이 n20 **1.04배** ·
 * n60 **1.59배**). 반증 결론은 그 파생량 **없이** 위 세 축의 지배로 성립한다.
 * 다섯 가지 기제 변형(어깨 게이트 off · 밴드 8m · 거리 45/55m)도 전부 프론티어 위로 못
 * 올라갔다 = **T3 를 통과시키는 계수는 발견되지 않았다**(T3 블록).
 *
 * **그래서 계수를 T3 에 맞추지 않았다** — 정확히는 **맞출 계수가 없었다**(다섯 변형 중 최선도
 * 프론티어 위로 못 올라갔다). 스코프 단계에서 그 실패 조건을 미리 선언했으므로(#377 함정 ④ =
 * "신호 없는 게이트에 계수를 맞춘다") 대신 **반증을 스냅샷으로 박제**한다. 다음 사람이 같은
 * 주장을 다시 세우지 않게, 그리고 미래 설계(hold/cooldown)가 이걸 뒤집으면 **스냅샷이 움직여
 * 그 사실이 보이게**.
 *
 * ## 대조군이 왜 "트랩 OFF"가 아니라 **플라시보**인가
 * 트랩 지시(`team.offsideTrap`)를 끄면 기제만 꺼지는 게 아니라 **심판도 달라진다** —
 * `rules.offside.trapCallMult`(1.8)가 판정 확률을 갈라 그 뒤 전개가 통째로 발산한다. 그래서
 * 두 팔은 지시를 **둘 다 켜 두고** 이동량만 0 으로 만든다(라벨·게이트·심판 전부 동일).
 * ⚠️ 이 선택은 **논리 때문이지 효과 크기 때문이 아니다** — 실제로 두 기준선은 같은 자리에
 * 있다(n60 `caught`: 트랩 OFF 0.6027 vs 플라시보 0.6015, t **−0.25**). 출하까지의 상승분도
 * 어느 쪽으로 재든 같다(OFF→출하 +0.0182 · 플라시보→출하 +0.0195 = **차이 7%**).
 *
 * ## 그럼 왜 착지시키나
 * 이 웨이브가 고치는 것은 "트랩이 좋은 전술인가"가 아니라 **"트랩 지시가 실재하는가"** 다.
 * 그리고 실측된 성질은 hero 가 스코프에서 제시한 게임 설계 프레이밍과 **일치한다**:
 * *"하이리스크 전술 — 켜면 오프사이드가 늘지만 실패하면 뒤를 내준다."*
 * 오프사이드 1.13 → 1.27/경기 · 1대1 1.97 → 2.05 · 뚫림 10.47 → 11.28% (전부 n60).
 * 출하 전술 기본값은 **off** 이므로(`fixtures.ts`) 벤치마크·골든은 움직이지 않는다.
 */

const S8 = REALISM_SEEDS.slice(0, 8);
const S20 = REALISM_SEEDS;
const S60 = GUARD_SEEDS;
const select = makeSelectData();

function cfg(mut: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
}
const ON = trapOn("both");
/** `stepUpM` 만 바꾼 config. */
const step = (v: number): EngineConfig => cfg((c) => { c.movement.defLine.trap.stepUpM = v; });
/** 플라시보 — 배정·게이트·라벨은 그대로, **이동만 0**. 라벨이 아니라 기제가 원인임을 가른다. */
const PLACEBO = step(0);
/** 롤백 = 0.39.0 동작 재현(기제 off + 구 심판 보정). */
const ROLLBACK = cfg((c) => {
  c.movement.defLine.trap.enabled = false;
  c.rules.offside.trapBiasM = 2.5;
});
/**
 * T5(골든 무이동) **전용** — 롤백 + 출하 튜닝값 되돌리기. #407 0.44.0 박스 유입 팔은
 * config-only 라 이 웨이브 스위치 밖에서 돈다. 골든을 재기록하는 대신 기준점을 옮긴다
 * (사유·처방 = `realism/rollback.ts` 상단).
 */
const ROLLBACK_PRE = cfg((c) => {
  c.movement.defLine.trap.enabled = false;
  c.rules.offside.trapBiasM = 2.5;
  preShipping(c);
});
/** T5 첫 단언용 — 출하 config 에서 **튜닝값만** 0.43.0 으로(기제는 전부 출하 그대로). */
const SHIPPING_PRE = cfg((c) => { preShipping(c); });

function hashes(config: EngineConfig, patch?: (t: TacticalInput) => TacticalInput): string[] {
  return S8.map((s) => {
    const h = patch ? patch(makeTacticalInput("H", s)) : makeTacticalInput("H", s);
    const a = patch ? patch(makeTacticalInput("A", s)) : makeTacticalInput("A", s);
    const log = runMatch(s, h, a, select, config);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}
const trapOnPatch = (t: TacticalInput): TacticalInput => ({ ...t, team: { ...t.team, offsideTrap: true } });

/**
 * `3d38e86`(engine@0.39.0, S3-B 착지) 의 8시드 최종 해시. **다른 트리에서 뽑았다**
 * (`git worktree add … 3d38e86` → 같은 시드·같은 하네스). 손으로 베낀 값이 아니라 실행 산출이다.
 */
const REF_0_39_0_SHIPPING = ["f9d9d778", "756ec350", "f7031974", "e5b0e30b", "2729ba3f", "5835c656", "c32240d5", "19ccfdd9"];
const REF_0_39_0_TRAP_ON = ["35e56352", "5e9060da", "a87a7465", "bca6a382", "6709e43e", "295057c6", "43c19131", "7d411e90"];

/**
 * ⚠️ **#407 N4(engine@0.41.0) 재기록.** hold EV 의 1대1 예외(`chain.hold.oneOnOnePenalty`)는
 * **볼 소유자 결정 코어**의 전역 변경이라 트랩 스위치 밖에서 돈다 — 이 파일의 두 롤백 계약은
 * 그래서 값이 움직인다(다른 롤백 계약들과 같은 처방: `vision.test.ts` · `press-unit.test.ts` ·
 * `def-line.test.ts`). **계약 내용은 그대로다**: "트랩 기제가 꺼져 있으면 트랩 도입 전과 같다".
 * 위 0.39.0 상수는 **이력으로 남긴다**(지우면 그 사실이 어디에도 안 남는다).
 * 8시드 중 실제로 갈린 것은 shipping 4/8 · trap-on 5/8 이다(N4 는 1대1 이 실제로 난 매치에서만 걸린다).
 */
const REF_0_41_0_SHIPPING = ["f9d9d778", "e816d215", "6a479763", "e5b0e30b", "2729ba3f", "26945380", "8a13900e", "19ccfdd9"];
const REF_0_41_0_TRAP_ON = ["a2910ec7", "dc6849c4", "1f724206", "bca6a382", "f751df47", "295057c6", "43c19131", "a2c11142"];

/**
 * ⚠️ **#407 ⑦(engine@0.42.0) 재기록.** 오프사이드 **호출 게이트**(`rules.offside.callProb`
 * 0.013 → 0.045)는 트랩 스위치 **밖**의 심판 판정이라(트랩 배수 `trapCallMult` 는 그대로) 이
 * 파일의 두 롤백 계약 값이 움직인다 — 0.41.0 재기록과 같은 처방이다.
 * **계약 내용은 그대로다**: "트랩 기제가 꺼져 있으면 트랩 도입 전과 같다".
 * 위 0.39.0/0.41.0 상수는 **이력으로 남긴다**. shipping 은 8시드 중 **6개**가 갈렸고
 * (`7b731a91`·`26945380` 는 불변 = 그 매치의 기하 오프사이드 롤이 0.013~0.045 창을 안 밟았다)
 * trap-on 은 **8/8** 갈렸다(트랩 배수 1.8 이 곱해져 창이 더 넓다).
 */
const REF_0_42_0_SHIPPING = ["7b731a91", "e816d215", "460ce36e", "ed78f19e", "20f453fc", "26945380", "a241f391", "21dbf606"];
const REF_0_42_0_TRAP_ON = ["4aa27f64", "e6929d05", "6913d420", "020536f1", "141980a2", "86c934dd", "06bf496f", "95b8ff9d"];

/**
 * 플라시보 팔의 n20 측정 — **T2 엔드포인트와 T2c 절대값 변이체가 공유**한다(같은 20경기를
 * 두 번 돌리지 않는다). 모듈 로드 시 1회.
 */
const A0 = measureTrap(PLACEBO, S20, ON).both;

function strictlyIncreasing(v: readonly number[]): boolean {
  for (let i = 1; i < v.length; i++) if (!(v[i]! > v[i - 1]!)) return false;
  return true;
}

/* ------------------------------------------------------------------------- *
 * T1 — 트랩이 실제로 걸린다 (판정은 **배정한 쪽이 단 라벨**로만)
 * ------------------------------------------------------------------------- */

describe("S3-C T1 — 발화", () => {
  const fire = measureTrapFire(defaultEngineConfig, S8, ON);

  it(`트랩 지시가 있으면 수비 틱의 일부에서 라인이 밀린다 (발화 ${fire.firePct.toFixed(1)}% · 전진 ${fire.biasWhenFiredM.toFixed(2)}m · 연속 ${fire.runLenMeanTicks.toFixed(2)}틱)`, () => {
    // 분모에 **안 걸린 틱도 들어간다**(`kind:"line"` 은 미발화 틱도 흘린다) — 안 그러면 발화율이
    // 위로 편향된다(S3-A `kind:"unit"` · S3-B `kind:"line"` 과 같은 이유).
    expect(fire.lineTicks).toBeGreaterThan(10_000);
    expect(fire.firePct).toBeGreaterThan(10);
    // 상시 발화면 그건 트랩이 아니라 하이라인이다 — 조건부라는 것이 이 기제의 정의다.
    expect(fire.firePct).toBeLessThan(80);
    // 전진량은 `stepUpM` 을 넘을 수 없다(연속 세기의 상한).
    expect(fire.biasMaxM).toBeLessThanOrEqual(defaultEngineConfig.movement.defLine.trap.stepUpM + 1e-9);
  });

  it("트랩 지시가 없으면(출하 픽스처) 한 번도 안 걸린다", () => {
    expect(measureTrapFire(defaultEngineConfig, S8).firePct).toBe(0);
  });

  it("롤백 경로에서는 지시가 있어도 안 걸린다", () => {
    expect(measureTrapFire(ROLLBACK, S8, ON).firePct).toBe(0);
  });

  it("플라시보(`stepUpM=0`)는 게이트를 다 통과해도 전진량이 0 이다", () => {
    const f = measureTrapFire(PLACEBO, S8, ON);
    expect(f.firePct).toBe(0); // 전진량 0 = 발화로 세지 않는다(라벨이 곧 이동량이다).
    expect(f.biasMaxM).toBe(0);
  });
});

/* ------------------------------------------------------------------------- *
 * T2 — 용량–반응: `stepUpM` 이 실제로 레버다
 * ------------------------------------------------------------------------- */

describe("S3-C T2 — `stepUpM` 이 레버다 (엔드포인트 · 결과 쪽 관찰량 둘)", () => {
  /**
   * ## ⚠️ 초판은 **자기 임계에 검정력이 모자란 사다리**였다 (독립검증 m1)
   * 초판 = `[0, 2.5, 4, 6]` 인접 rung **엄격 단조**를 n20 에서 요구했다. 그런데 그 세 스텝의
   * 대응표본 t(같은 시드 쌍, `caughtMean`)를 **직접 재 보면**:
   *
   * | 스텝 | Δ (n20) | t (n20) | Δ (n60) | t (n60) |
   * |---|---|---|---|---|
   * | 0 → 2.5 | +0.0156 | **1.06** | +0.0195 | 2.03 |
   * | 2.5 → 4 | +0.0155 | **0.86** | +0.0067 | **0.70** |
   * | 4 → 6 | +0.0583 | 3.42 | +0.0526 | 5.63 |
   *
   * 즉 세 스텝 중 둘이 |t| < 1.1 이고, `2.5 → 4` 는 **n60 으로 키워도 t = 0.70** 이다 —
   * 구현자가 "분해 안 된다"며 뺀 1m 칸(t = −1.22)**보다도 신호가 약하다**. 지금 초록인 것은
   * 운이고 재표집에서 뒤집힌다.
   *
   * ## 그래서 임계를 낮추지 않고 **계약을 다시 정의했다**
   * 신호가 있는 것만 항상 걸고, 없는 것은 게이트로 내리거나 값으로만 남긴다:
   *
   *  - **여기(항상)** = 양 끝(0 vs 6)의 **큰 효과**. n20 에서 `caught` +0.0894(t **5.23**) ·
   *    수비 라인 높이 +1.065m(t **5.54**). 임계는 그 절반 근방(0.05 / 0.5m)이라 2~3 SE 여유다.
   *  - **사다리(`HMB_LADDER=1`)** = `[0, 2.5, 6]` 엄격 단조를 **n60** 에서. 이 간격이면 두 스텝
   *    모두 t ≥ 2.03(`caught`) · ≥ 2.75(라인)로 분해된다. `4` 칸은 **뺐다** — 2.5 와 4 사이는
   *    표본을 3배로 키워도 안 갈라진다(위 표). "표본을 늘려도 안 살아나는 칸을 사다리에 넣으면
   *    계약이 플래키해진다"는 1m 칸과 **같은 판정**이다.
   *  - 1m 칸은 계속 뺀다 — n20 · n60 이 **같은 방향으로** 뒤집힌다(0.606/**0.585** ·
   *    0.6011/**0.5892**). 노이즈가 아니라 효과가 없는 것이다.
   *
   * ## 런타임 (사다리는 게이트돼 있다 — §2.5 · #371)
   * 초판 = 사다리 4팔 × n20 + 변이체 1팔 × n20 = **100경기**가 `npm test` 안에서 **항상**.
   * 지금 = 항상 도는 것 **84경기**(엔드포인트 2팔 × n20 = 40 · 부호 라벨 3팔 × n8 = 24 ·
   * 절대값 변이체 1팔 × n20 = 20, 플라시보 팔은 **재사용**) + 게이트된 n60 사다리 180경기
   * (실측 46.1s)는 **노브를 만진 웨이브에서만**. 즉 `npm test` 는 싸지고 검정력은 올라간다.
   */
  const A6 = measureTrap(step(6), S20, ON).both;

  it(`엔드포인트 — 라인 뒤에 남겨진 상대가 는다 (${A0.caughtMean.toFixed(3)} → ${A6.caughtMean.toFixed(3)})`, () => {
    // 실측 Δ +0.0894 (t 5.23) · n60 +0.0788 (t 8.29). 임계는 그 절반.
    expect(A6.caughtMean - A0.caughtMean, `caught ${A0.caughtMean} → ${A6.caughtMean}`).toBeGreaterThan(0.05);
  }, 300_000);

  it(`엔드포인트 — **수비 라인 자체가** 올라간다 (${A0.lineMeanM.toFixed(2)} → ${A6.lineMeanM.toFixed(2)}m)`, () => {
    // 위 `caught` 는 **상대**의 위치이고 이건 **우리**의 위치다 — 둘이 같이 움직여야 "라인을
    // 밀어올렸다"가 성립한다(하나만 보면 상대가 알아서 전진한 경우와 구분되지 않는다).
    // 실측 Δ +1.065m (t 5.54) · n60 +1.012m (t 7.30). 관찰량은 스냅샷 좌표다(라벨 아님).
    expect(A6.lineMeanM - A0.lineMeanM, `line ${A0.lineMeanM} → ${A6.lineMeanM}`).toBeGreaterThan(0.5);
  }, 300_000);
});

/**
 * **용량–반응 사다리**(게이트: `HMB_LADDER=1` · #371). 위 주석의 검정력 표가 rung 선택 근거다.
 */
describe.skipIf(!LADDER)(`S3-C T2b — \`stepUpM\` 사다리 (n60) ${LADDER_TAG}`, () => {
  // ⚠️ 측정은 **`it` 안에서** 한다 — `describe.skipIf` 는 콜백을 그대로 실행하므로(수집 단계)
  // describe 본문에 두면 **스킵될 때도 n60 이 돈다**(실측 수집 +46s). lane-read 와 같은 관용구.
  it("`stepUpM` 을 올리면 라인 뒤 상대도 라인 높이도 단조 증가한다", () => {
    const rungs = [0, 2.5, 6];
    const arms = rungs.map((v) => measureTrap(step(v), S60, ON).both);
    const caught = arms.map((a) => a.caughtMean);
    const line = arms.map((a) => a.lineMeanM);
    // 실측(n60): caught 0.6015 · 0.6210 · 0.6803 (스텝 t 2.03 · 6.06)
    //            line   27.719 · 28.073 · 28.731 (스텝 t 2.75 · 5.47)
    expect(strictlyIncreasing(caught), `caught: stepUpM ${rungs.join("/")} → ${caught.map((x) => x.toFixed(4)).join(", ")}`).toBe(true);
    expect(strictlyIncreasing(line), `line: stepUpM ${rungs.join("/")} → ${line.map((x) => x.toFixed(3)).join(", ")}`).toBe(true);
  }, 1_800_000);
});

/* ------------------------------------------------------------------------- *
 * T2c — 부호 판별 (변이체 킬 **2단**: 구조 라벨 + 결과 위치)
 * ------------------------------------------------------------------------- */

describe("S3-C T2c — 부호를 뒤집으면 기제도 뒤집힌다", () => {
  /**
   * ## ⚠️ 초판의 변이체 킬은 **방향을 판별하지 못했다** (독립검증 m2)
   * 초판 = `stepUpM = −4` 의 `caughtMean` 이 플라시보보다 작다. 그런데 실측하면
   *   −4 → 0.5895 (Δ −0.0168, t **−0.93**)   ·   **+1 → 0.5849 (Δ −0.0215)**
   * 로 **양수 +1 을 먹여도 그 단언이 통과한다** = 부호가 아니라 잡음을 재고 있었다.
   *
   * ## 왜 결과 축으로는 못 가르나 (실측 사실, 원인은 규명하지 않았다)
   * 음의 팔은 **기제가 정상적으로 돈다** — 라벨 기준 발화 28.63%(양의 팔 28.82% 와 같다) ·
   * 부호 있는 평균 이동 **−0.955m**. 그런데 결과 축은 거의 안 움직인다:
   *   라인 높이 Δ  −4 **−0.183(t −0.85)** · −6 −0.041(t −0.21) · −8 −0.275(t **−1.85**)
   *   (같은 자로 잰 양의 팔: +6 **+1.065(t 5.54)** · +8 +2.071(t 8.49))
   * 표본을 늘려서 될 문제가 아니다(−8 에서도 2σ 미만). 백4 위치(평균·최전방·최후방)로 바꿔도
   * 전부 |t| < 1.9 였다. **왜 비대칭인지는 이 수습에서 규명하지 않았다** — 규명 없이 기제를
   * 지어내지 않고, 대신 판정을 두 층으로 나눈다.
   *
   * ## 2단 계약
   *  ① **구조(부호 확실)** — config 의 부호가 기제 라벨(`DefShapeSample.trapBiasFx`)까지 그대로
   *     간다. ⚠️ **동어반복 경계**: 이 자는 기제가 만든 값을 되읽으므로 *"선수가 그 방향으로
   *     섰다"* 는 판정하지 못한다. 판정하는 것은 *"부호가 코드 안에서 살아 있다"* 뿐이다
   *     (`Math.abs` · 부호 상수화 같은 변이체는 여기서 죽는다).
   *  ② **결과(위치)** — 그 방향성이 선수 위치까지 도달한다는 것은 **양의 방향**에서 T2 가
   *     증명한다(라인 +1.065m). 그리고 음의 팔이 라인을 **올리지는 않는다**를 여기서 건다 —
   *     `stepUpM` 을 절대값으로 읽는 변이체는 −4 를 +4(라인 **+0.586m**)로 만들므로 걸린다.
   */
  const fire = (v: number): TrapFireReport => measureTrapFire(step(v), S8, ON);

  it("① 구조 — 음수는 음수로, 양수는 양수로 기제까지 간다 (동어반복 경계는 주석)", () => {
    const neg = fire(-4);
    const pos = fire(1);
    // 실측: −4 → −0.9553m · +1 → +0.2451m. 부호가 갈리는 것이 이 단언의 전부다.
    expect(neg.biasSignedAllTicksM, "음의 stepUpM 인데 기준점이 앞으로 갔다").toBeLessThan(0);
    expect(pos.biasSignedAllTicksM, "양의 stepUpM 인데 기준점이 뒤로 갔다").toBeGreaterThan(0);
    // 세기도 따라간다(−6 이 −4 보다 더 음수). 부호를 상수로 박은 변이체를 함께 잡는다.
    expect(fire(-6).biasSignedAllTicksM).toBeLessThan(neg.biasSignedAllTicksM);
    // 이동량 상한은 부호 대칭이다(T1 의 `biasMaxM` 과 짝).
    expect(neg.biasMinM).toBeGreaterThanOrEqual(-4 - 1e-9);
    // **음의 팔도 기제는 정상적으로 돈다** — 발화율이 양의 팔과 같은 자리다(실측 28.63 vs 29.49%).
    // 이 단언이 있어야 "결과 축이 안 움직인다"가 *미발화 때문이 아니라는 것*이 계약에 남는다.
    expect(neg.fireAnyPct).toBeGreaterThan(pos.fireAnyPct * 0.7);
  }, 300_000);

  it("② 결과 — 음의 팔은 라인을 **올리지 않는다** (절대값 변이체 킬)", () => {
    const back = measureTrap(step(-4), S20, ON).both.lineMeanM;
    const placebo = A0.lineMeanM; // 위에서 이미 잰 플라시보 팔을 재사용한다.
    // 실측 −4 → 27.498 vs 플라시보 27.681 (Δ −0.183). `Math.abs` 변이체면 +4 의 28.267 이 되어
    // Δ **+0.586** 이 된다. 임계 +0.3 은 그 사이에 있고, 잡음(SE ≈ 0.21)에는 −0.183 에서
    // 2.3 SE 여유다. **단측**인 이유는 위 주석 — 음의 방향 효과 크기는 이 자로 못 잰다.
    expect(back, `line(−4) ${back} vs 플라시보 ${placebo}`).toBeLessThan(placebo + 0.3);
  }, 300_000);
});

/* ------------------------------------------------------------------------- *
 * T3/T4 — **반증 스냅샷**: 이 웨이브가 세운 주장이 틀렸다는 기록
 * ------------------------------------------------------------------------- */

describe("S3-C T3/T4 — 프론티어를 이기지 못한다 · 위험지역으로 새어 나간다 (반증 박제)", () => {
  /**
   * ⚠️ **스냅샷 제목에 값을 보간하지 않는다** — 보간하면 값이 바뀔 때 스냅샷 **키**가 같이 바뀌어
   * diff 가 "변경"이 아니라 "삭제 + 추가"로 뜬다(S3-B m2). 값은 본문에만 넣는다.
   */
  it("트랩 팔과 무차별 상향 팔의 효율(잡힘/뚫림)", () => {
    const arm = (label: string, c: EngineConfig, patch: (t: TacticalInput) => TacticalInput) => {
      const b = measureTrap(c, S20, (t) => patch(t)).both;
      return `${label}: line ${b.lineMeanM.toFixed(2)} caught ${b.caughtMean.toFixed(3)} behind ${b.behindLineOwnPct.toFixed(2)} eff ${(b.caughtMean / b.behindLineOwnPct).toFixed(4)}`;
    };
    const rows = [
      arm("placebo", PLACEBO, trapOnPatch),
      arm("trap 2.5", defaultEngineConfig, trapOnPatch),
      arm("trap 6", step(6), trapOnPatch),
      arm("blanket lineH 0.60", PLACEBO, (t) => withLine(0.6)(trapOnPatch(t))),
      arm("blanket lineH 0.65", PLACEBO, (t) => withLine(0.65)(trapOnPatch(t))),
    ];
    expect(rows.join("\n")).toMatchSnapshot();
  }, 600_000);

  it("위험지역(<25m) 뚫림 — 트랩은 거기서 걸지 않는데도 대가는 치른다", () => {
    // 거리 게이트(35m)가 <25m 에서의 **발화**를 막는 것은 T8 이 확인한다. 여기 기록하는 것은
    // 그럼에도 그 버킷의 뚫림이 오른다는 사실이다 — 트랩은 먼 곳에서 걸리고, 러너가 지나간 뒤
    // 공이 가까워질 때까지 라인이 아직 회복 중이라 **대가가 다음 버킷으로 이월된다**.
    const row = (label: string, c: EngineConfig) => {
      const b = measureTrap(c, S20, ON).both;
      return `${label}: ` + b.byDanger.map((x, i) => `${["<25", "25-40", "40-60", ">60"][i]} b${x.behindPct.toFixed(2)}`).join(" ");
    };
    expect([row("placebo", PLACEBO), row("trap 2.5", defaultEngineConfig), row("trap 6", step(6))].join("\n")).toMatchSnapshot();
  }, 600_000);

  it("결과 축(오프사이드·골·1대1)은 노이즈 바닥과 같은 자릿수다 — 게이트로 쓰지 마라", () => {
    // ⚠️ `offsides` 는 **주 게이트 금지**다: n60 에서 mean 0.733 · sd 0.841 · se 0.109 라
    // 2배 미만 효과는 검출되지 않는다. 그 사실을 값으로 남겨 다음 사람이 다시 재지 않게 한다.
    const row = (label: string, c: EngineConfig) => {
      const m = measureTrap(c, S20, ON);
      return `${label}: ofs ${m.offsidesPerMatch.toFixed(2)} goal ${m.goalsPerMatch.toFixed(2)} 1v1 ${(m.oneOnOneHome + m.oneOnOneAway).toFixed(2)} shot ${m.shotsPerTeam.toFixed(2)}`;
    };
    expect([row("placebo", PLACEBO), row("trap 2.5", defaultEngineConfig)].join("\n")).toMatchSnapshot();
  }, 600_000);
});

/* ------------------------------------------------------------------------- *
 * T5 — 롤백 · 골든 무이동
 * ------------------------------------------------------------------------- */

describe("S3-C T5 — 롤백이 `3d38e86`(0.39.0) 과 비트 동일", () => {
  it("출하 픽스처(트랩 off)는 0.39.0 과 **똑같다** — 이 웨이브는 골든을 안 움직인다", () => {
    // 이것이 전술 기본값을 off 로 둔 이유다(스코프 §4-b). 깨지면 그 전제가 무너진 것이므로
    // `-u` 로 넘기지 말고 원인을 실측으로 설명해야 한다.
    // ⚠️ #407(0.44.0) — 기준점만 `preShipping()` 으로 옮겼다(골든 재기록 아님). 이 웨이브가
    //    바꾼 것은 **출하 튜닝값 3개**뿐이고 트랩 기제와 무관하다 — `rollback.ts` 참조.
    expect(hashes(SHIPPING_PRE)).toEqual(REF_0_42_0_SHIPPING);
  }, 300_000);

  it("트랩을 켠 경기도 롤백 config(`trap.enabled=false` + `trapBiasM=2.5`)면 0.39.0 과 같다", () => {
    expect(hashes(ROLLBACK_PRE, trapOnPatch)).toEqual(REF_0_42_0_TRAP_ON);
  }, 300_000);

  it("그리고 기제가 켜지면 다르다 (롤백 계약이 공허하지 않다)", () => {
    expect(hashes(defaultEngineConfig, trapOnPatch)).not.toEqual(REF_0_42_0_TRAP_ON);
  }, 300_000);
});

/* ------------------------------------------------------------------------- *
 * T6 — 결정론
 * ------------------------------------------------------------------------- */

describe("S3-C T6 — 결정론", () => {
  it("트랩을 켠 경기도 두 번 돌리면 같다", () => {
    expect(hashes(defaultEngineConfig, trapOnPatch)).toEqual(hashes(defaultEngineConfig, trapOnPatch));
  }, 300_000);

  it("관측자를 켜도 결과가 같다 (계측이 시뮬을 바꾸지 않는다)", () => {
    const plain = hashes(defaultEngineConfig, trapOnPatch);
    const samples: unknown[] = [];
    setDefShapeObserver((s) => { samples.push(s); });
    let observed: string[];
    try {
      observed = hashes(defaultEngineConfig, trapOnPatch);
    } finally {
      setDefShapeObserver(null);
    }
    expect(samples.length).toBeGreaterThan(0); // 표본이 비면 이 계약은 공허하다.
    expect(observed).toEqual(plain);
  }, 300_000);
});

/* ------------------------------------------------------------------------- *
 * T8 — 변이체 킬 (게이트를 하나씩 없애면 무엇이 깨지나)
 * ------------------------------------------------------------------------- */

describe("S3-C T8 — 게이트 변이체", () => {
  const fire = (c: EngineConfig) => measureTrapFire(c, S8, ON).firePct;

  it("거리 게이트를 없애면 발화가 늘고 위험지역 뚫림이 더 커진다", () => {
    const open = cfg((c) => { c.movement.defLine.trap.minBallDistM = 0; });
    expect(fire(open)).toBeGreaterThan(fire(defaultEngineConfig));
    const near = (c: EngineConfig) => measureTrap(c, S20, ON).both.byDanger[0]!.behindPct;
    expect(near(open)).toBeGreaterThan(near(defaultEngineConfig));
  }, 600_000);

  it("어깨 게이트를 없애면 상시에 가깝게 걸린다 (= 트랩이 아니라 하이라인이 된다)", () => {
    const always = cfg((c) => { c.movement.defLine.trap.minShoulder = 0; });
    expect(fire(always)).toBeGreaterThan(fire(defaultEngineConfig) * 1.5);
  }, 300_000);

  it("어깨 인원 요구를 올리면 발화가 준다", () => {
    expect(fire(cfg((c) => { c.movement.defLine.trap.minShoulder = 4; }))).toBeLessThan(fire(defaultEngineConfig));
  }, 300_000);

  it("`releaseSmooth` 가 세기를 실제로 깎는다 (계단이면 전진량이 곧 `stepUpM` 이다)", () => {
    // ⚠️ **발화율로 재면 안 된다** — 처음엔 "계단이면 발화가 는다"로 걸었는데 실측이 반대였다
    // (28.82% → 28.33%). 이유는 기제가 아니라 **표본**이다: config 가 달라지면 경기 전개 자체가
    // 갈라져 수비 틱 구성이 바뀐다(교차-config 카오스). 그래서 궤적에 안 흔들리는 **구조적
    // 성질**로 바꿔 건다 — 계단에서는 발화한 틱이 전부 최대 세기여야 한다.
    const ramp = measureTrapFire(defaultEngineConfig, S8, ON);
    const step = measureTrapFire(cfg((c) => { c.movement.defLine.trap.releaseSmooth = 0.1; }), S8, ON);
    const full = defaultEngineConfig.movement.defLine.trap.stepUpM;
    expect(step.biasWhenFiredM).toBeCloseTo(full, 2);
    expect(ramp.biasWhenFiredM, `경사 ${ramp.biasWhenFiredM.toFixed(2)}m vs 계단 ${step.biasWhenFiredM.toFixed(2)}m`).toBeLessThan(full - 0.1);
  }, 300_000);
});

/* ------------------------------------------------------------------------- *
 * T9 — `trapBiasM` 잠복 결함: 심판만 다른 라인을 쓴다
 * ------------------------------------------------------------------------- */

describe("S3-C T9 — 심판 ↔ 패스 생성기 라인 불일치 (`trapBiasM` 을 올리면 되살아난다)", () => {
  it("출하값(0)에서는 불일치가 **정확히 0** 이다", () => {
    const r = measureRefereeLineMismatch(defaultEngineConfig, S8, ON);
    expect(r.offsides).toBeGreaterThan(0); // 표본이 비면 이 계약은 공허하다.
    expect(r.mismatched).toBe(0);
  }, 300_000);

  it("2.5(구 출하값)로 올리면 불일치가 생긴다 — 생성기는 온사이드라 믿고 찌른 공을 심판이 잡는다", () => {
    const r = measureRefereeLineMismatch(cfg((c) => { c.rules.offside.trapBiasM = 2.5; }), S8, ON);
    expect(r.mismatched, "trapBiasM>0 인데 불일치가 0 이면 이 계약이 자가 고장난 것이다").toBeGreaterThan(0);
  }, 300_000);
});

/* ------------------------------------------------------------------------- *
 * #399 축 — 트랩이 라인을 밀어올리는 만큼 무소유 급정지가 따라오는가
 * ------------------------------------------------------------------------- */

describe("S3-C — #399 무소유 급정지 축(라인 상향에 연동되는 축)", () => {
  it("트랩을 켜도 이 축이 악화되지 않는다", () => {
    // 배경: 이 축은 `lineDiscipline`·`defensiveLineHeight` 같은 **라인 상향**에 연동된다
    // (8시드 실측: 출하 27.00 → `defensiveLineHeight=0.9` **31.88**). 트랩도 라인을 밀어올리므로
    // 같이 재야 한다. **조건부·단시간이라 다를 것**이라는 것이 이 웨이브의 설계 가설이었고,
    // 실측이 그걸 지지한다(8시드 OFF 27.00 → ON 25.38 · 20시드 25.45 → 25.50).
    // ⚠️ 임계·표본은 `#399` 소유(`ball-physics.test.ts`)라 여기서 **건드리지 않는다** — 이 계약은
    // "트랩이 그 축을 더 나쁘게 만들지 않는다"만 본다(관계식, 절대 임계 아님).
    const off = measureDeadStops(defaultEngineConfig, S20);
    const on = measureDeadStops(defaultEngineConfig, S20, ON);
    expect(on, `무소유 급정지 OFF ${off.toFixed(2)} → ON ${on.toFixed(2)}`).toBeLessThanOrEqual(off * 1.1);
  }, 600_000);
});
