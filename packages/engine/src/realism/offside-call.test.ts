import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { aggregateRealism, GUARD_SEEDS, REALISM_SEEDS } from "./harness";
import { BENCH, benchVerdict } from "./bench";
import { LADDER, LADDER_TAG } from "./gate";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * #407 ⑦ — **오프사이드 호출 빈도**(engine@0.42.0, `rules.offside.callProb` 0.013 → 0.045).
 *
 * ## 이 계약이 지키는 것 (그리고 지키지 않는 것)
 * `research/e407-offside.md` 가 20시드 라이브 패스 결정 **9,850건 전량**을 판정 시점 좌표로
 * Law 11 독립 재판정해 확정한 사실이 둘이다:
 *  1. **판정 로직에 결함이 없다** — 오심(FP) **0건**, `callProb=1` 반사실에서 엔진↔재판정 384/384 일치.
 *  2. 밴드 이탈(오프사이드 0.33 vs 벤치 1–3)의 **유일한 실효 레버는 `callProb`** 이다
 *     (`defLine` off → 기하가 오히려 **감소** · `throughPass` off → 무변화 = 둘 다 범인이 아니다).
 * 그래서 이 파일은 **판정 정합을 검사하지 않는다**(그건 `e407-offside-probe.test.ts` 소관) —
 * **빈도**만 본다. 노브 하나의 계약이다.
 *
 * ## 왜 밴드를 "주 게이트"로 걸어도 되나 — `offside-trap.test.ts` T3/T4 와의 관계
 * 그 파일은 *"`offsides` 를 주 게이트로 쓰지 말라"* 고 박제해 뒀다. 그건 **트랩 효과 검출**
 * (n60 mean 0.733 · se 0.109 에서 **2배 미만의 처치 효과**를 분해하는 일)에 대한 경고이고,
 * 여기서 하는 일은 다르다 — **한 점의 평균이 밴드 [1,3] 안인가**를 본다. 현 출하 실측은
 * 1.175 ± se 0.090 라 하한까지 **1.9 se**, 상한까지 **20 se** 다. ⚠️ 이 측정은 **결정론적**이라
 * "플래키"하지 않다 — 하한 마진이 얇다는 것은 다음 엔진 변경이 이 밴드를 밀어낼 여지가
 * 그만큼 크다는 뜻이고, 그때 고칠 곳은 이 노브다. 그 경고는 여전히 유효하고
 * (아래 사다리 rung 간격을 그래서 벌렸다) 이 밴드 계약과 충돌하지 않는다.
 *
 * ## ⚠️ 밴드 자체에 대한 정직한 표기 (기준을 바꾸지는 않았다)
 * `bench.ts` 의 `offsides 1–3` 은 **90분 실축 벤치**이고 #365(경기 45분화) 이후 재도출되지
 * 않았다 — `research/e407-volume-recalibration.md` §6-2 가 카운트형 지표 전반에 대해 그
 * 스테일을 기록해 뒀다(코너·스로인·파울·주행). 길이보정(×0.5)을 적용하면 밴드는 0.5–1.5 다.
 * 이 웨이브는 **밴드를 건드리지 않았다** — 재도출은 "지표를 맞췄다"가 아니라 "기준을 바꿨다"라
 * 별도 근거·리뷰 대상이기 때문이다(`bench.ts` 파일 주석). 대신 **두 읽는 법의 교집합**에
 * 착지했다: 1.175 는 원문 [1,3] 안이고 길이보정 [0.5,1.5] 안이기도 하다(90분 환산 2.35/팀 =
 * 실축 EPL 1.5–2.5 한가운데). 밴드 중앙(1.75 = `callProb` 0.07)을 안 고른 이유가 이것이다 —
 * 그 값은 길이보정 상한을 넘는다.
 * 상세·사다리 전문 = `issues/2026-08-03-engine-offside-callprob.md`.
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

const B = BENCH.find((b) => b.key === "offsides")!;

/** 60시드(팀-경기 120) 집계 — 밴드 판정의 단일 출처는 `aggregateRealism` 하나다. */
const agg = aggregateRealism(cfg, GUARD_SEEDS);

function withCallProb(v: number): EngineConfig {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  c.rules.offside.callProb = v;
  return c;
}

describe("#407 ⑦ 오프사이드 호출 빈도 — 벤치 밴드", () => {
  it(`팀-경기당 오프사이드 ∈ [${B.lo}, ${B.hi}] (측정 ${agg.mean.offsides} ± ${agg.sd.offsides} → ${benchVerdict(agg.mean.offsides, B)})`, () => {
    // 0.41.0 까지 0.425 였다(▼0.575 LOW). 이력: 1.88(0.16.0) → 1.4(0.19.0) → 0.33(0.40.0).
    // `callProb` 은 0.5.0 도입 이후 **한 번도 재보정되지 않았고**(git log -S 커밋 1건) 그 사이
    // 패스 구성·수비 형태·행동 코어가 전부 바뀌었다 — 그래서 조용히 4배 아래로 내려앉았다.
    // 이 계약이 그 침식을 다시 잡는다.
    expect(agg.mean.offsides).toBeGreaterThanOrEqual(B.lo);
    expect(agg.mean.offsides).toBeLessThanOrEqual(B.hi);
  });

  it("`callProb = 0` 이면 깃발이 **하나도** 안 오른다 — 빈도의 문은 이 노브 하나다", () => {
    // 비공허성 + 변이체 킬을 겸한다. 기하 오프사이드는 팀-경기당 27.93건 발생하므로(리포트 §5.1)
    // 여기서 0 이 아니면 `callProb` 을 우회하는 **두 번째 판정 경로**가 있다는 뜻이다.
    const zero = withCallProb(0);
    let flags = 0;
    for (const seed of REALISM_SEEDS.slice(0, 8)) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, zero);
      flags += log.events.filter((e) => e.type === "offside").length;
    }
    expect(flags).toBe(0);
    // 그리고 출하값에서는 실제로 오른다(위 단언이 "오프사이드가 원래 안 난다"로 통과하지 않게).
    expect(agg.mean.offsides).toBeGreaterThan(0);
  }, 300_000);
});

// ── #371 게이트: 사다리는 **노브를 만지는 웨이브**에서만 (기본 스킵) ─────────────────────────
// 60시드 집계 4회 ≈ 2분. 밴드 1점(위 describe)은 항상 돈다.
describe.skipIf(!LADDER)(`#407 ⑦ 단조성: \`callProb\` ↑ → 오프사이드 ↑ ${LADDER_TAG}`, () => {
  /**
   * rung 선택 근거(전부 n60 = 팀-경기 120 실측, engine@0.41.0 트리):
   *   0.013 → 0.425 (se 0.062) · 0.045 → 1.175 (0.090) · 0.07 → 1.708 (0.132) · 0.10 → 2.817 (0.166)
   * 인접 rung 간격 0.53~1.11 은 각 se 의 **3.5~7배**라 `offside-trap.test.ts` T3/T4 가 경고한
   * 검출력 부족 구간(2배 미만 효과)을 피한다. 0.05(1.267)·0.055(1.392)·0.06(1.492)·
   * 0.065(1.592)·0.075(1.800) 같은 촘촘한 rung 은 **일부러 뺐다** — 거기서 재면 se 안에서
   * 부호가 뒤집힌다. 출하값(0.045)은 rung 으로 **들어 있다** — 사다리가 착지점을 지나가야
   * "지금 이 값이 그 곡선 위의 어디인가"가 보인다.
   */
  const RUNGS = [0.013, 0.045, 0.07, 0.1];

  it("4 rung 이 엄격 단조 증가한다", () => {
    const measured = RUNGS.map((v) => aggregateRealism(withCallProb(v), GUARD_SEEDS).mean.offsides);
    for (let i = 1; i < measured.length; i++) {
      expect(
        measured[i]!,
        `callProb ${RUNGS[i]} 가 ${RUNGS[i - 1]} 보다 오프사이드가 많아야 한다 — 실측 ${measured.join(" / ")}`,
      ).toBeGreaterThan(measured[i - 1]!);
    }
    // 기울기가 죽지 않았는지도 같이 본다(단조이기만 하고 사실상 평평하면 레버가 아니다).
    expect(measured[measured.length - 1]! - measured[0]!).toBeGreaterThan(1.0);
  }, 900_000);
});
