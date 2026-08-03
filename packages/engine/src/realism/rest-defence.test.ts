import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { preShipping } from "./rollback";
import { measureRestDefence, measureShapeOutcome } from "./defshape";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * #377 트랙 D **S3-B — 오픈플레이 레스트 디펜스**(#303 · 로드맵 W5-8).
 *
 * ## 무엇이 없었나 (구조 사실 — 측정이 아니다)
 * 잔류 로직이 **코너 분기 안에만** 있었다(`decision.ts:cornerHolderRank`, `sp.kind === "corner"`
 * 안에서 early-return). 오픈플레이 공격 분기에는 "누가 뒤에 남는가"라는 개념이 **한 줄도** 없었고,
 * `attackLinePush`(0.56)가 **역할 게이트 없이** 센터백에게도 그대로 걸렸다:
 * `tx += (ball.x − base.x) × 0.56`.
 *
 * ## ⚠️ `attackLinePush` 를 내리는 것은 해법이 아니다
 * 그 사다리(0 / 0.28 / 0.56 / 0.84)에서 CB 하프라인 초과는 0.03 / 2.05 / 18.53 / 33.19% 로 엄격
 * 단조지만, **같은 사다리에서 공격 시 팀 산포가 17.18 → 13.20 으로 같이 눌린다** — 팀 업필드
 * 이동은 의도된 동역학이라 그걸 죽이면 공격이 같이 죽는다. 그래서 전역 계수가 아니라
 * **역할 조건부 상한**이다. (M3-B 가 통과한 성립 조건과 같다: 수비를 똑똑하게 만들면서 공격을
 * 안 죽인다 — 아래 R4.)
 *
 * ## ⚠️ 자[尺] 정정 — 18.53% 가 아니라 27.23% 다
 * 스코프 단계의 18.53% 는 **데드볼 틱을 포함한** 자로 잰 값이다. 정지 중에는 규칙기반 배치가
 * CB 를 자기 자리로 되돌리므로 그 틱들이 비율을 희석한다. 계약과 증거가 공유하는 자
 * (`defshape.ts`, 데드볼 창 제외)로 다시 재면 **27.23%** 다. 두 값은 같은 상태의 다른 자이고,
 * 이 파일은 **계약의 자**만 쓴다("남이 준 수치를 인용하지 말고 다시 재라" — 이 경우 남 = 나다).
 */

const SEEDS8 = REALISM_SEEDS.slice(0, 8);
const SEEDS4 = REALISM_SEEDS.slice(0, 4);
const select = makeSelectData();

function cfg(mut: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
}

/** 라인·레스트를 전부 끈 config = 0.38.0 동작. */
const OFF = cfg((c) => {
  c.movement.defLine.enabled = false;
  c.movement.restDefence.enabled = false;
});
/** `OFF` + 출하 튜닝값 되돌리기 — R6 골든 해시 **전용**(`rollback.ts` 참조). */
const OFF_PRE = cfg((c) => {
  c.movement.defLine.enabled = false;
  c.movement.restDefence.enabled = false;
  preShipping(c);
});
/** 라인만 끈 config — 레스트 축을 격리해서 본다. */
const REST_ONLY = cfg((c) => {
  c.movement.defLine.enabled = false;
});
/** 플라시보 — 배정은 그대로 하되 상한이 없다(`lineCapProgress = 1`). */
const PLACEBO = cfg((c) => {
  c.movement.defLine.enabled = false;
  c.movement.restDefence.lineCapProgress = 1;
});

function hashes(config: EngineConfig, seeds: readonly string[]): string[] {
  return seeds.map((s) => {
    const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

/* ------------------------------------------------------------------------- *
 * R1 — 잔류가 실제로 배정된다
 * ------------------------------------------------------------------------- */

describe("S3-B R1 — 오픈플레이 잔류 배정이 발화한다", () => {
  const on = measureRestDefence(REST_ONLY, SEEDS8);

  it(`요청 인원만큼 실제로 배정된다 (요청 ${on.wantMean.toFixed(2)} · 배정 ${on.assignedMean.toFixed(2)} · 상한에 걸림 ${on.cappedMean.toFixed(2)} · 걸린 틱 ${on.cappedTickPct.toFixed(1)}%)`, () => {
    expect(on.restTicks).toBeGreaterThan(10_000);
    const rd = defaultEngineConfig.movement.restDefence;
    // 인원은 상수가 아니라 팀 가담도 매핑에서 나온다(코너 `stayBackMin/Max` 와 동형).
    expect(on.wantMean).toBeGreaterThanOrEqual(rd.countMin);
    expect(on.wantMean).toBeLessThanOrEqual(rd.countMax);
    // 배정이 요청을 채운다(후보가 모자라 조용히 0 이 되는 경우가 없다).
    expect(on.assignedMean).toBeCloseTo(on.wantMean, 1);
  });

  it("롤백 경로에서는 아예 배정되지 않는다", () => {
    expect(measureRestDefence(OFF, SEEDS4).restTicks).toBe(0);
  });

  it(`상한이 실제로 문다 — 걸린 선수는 평균 ${on.capOvershootMeanM.toFixed(2)}m 를 되돌려받는다`, () => {
    // "배정은 하는데 아무도 안 걸린다"(= 무발화)를 배제한다. #377 M2 `wallClearM` 이 그 상태였다.
    expect(on.cappedTickPct).toBeGreaterThan(30);
    expect(on.capOvershootMeanM).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------------- *
 * R2 / R3 — 효과: 센터백이 상대 진영으로 산책하지 않는다
 * ------------------------------------------------------------------------- */

describe("S3-B R2/R3 — 센터백이 하프라인 너머로 끌려가지 않는다", () => {
  const on = measureShapeOutcome(REST_ONLY, SEEDS8);
  const off = measureShapeOutcome(OFF, SEEDS8);

  it(`공격 중 CB 가 하프라인을 넘는 비율 (${off.cbOverHalfPct.toFixed(2)}% → ${on.cbOverHalfPct.toFixed(2)}%)`, () => {
    // ⚠️ 이 자는 스코프 단계 검정을 **통과했다** — `attackLinePush` 4 rung 에서 엄격 단조이고
    // 동적 범위가 3자릿수라, 절대 임계를 써도 자기충족이 아니다(내가 고른 임계가 아니라 이
    // 축이 실제로 만드는 범위 안에서 고른 값이다).
    expect(on.cbOverHalfPct).toBeLessThan(5);
    expect(off.cbOverHalfPct).toBeGreaterThan(15);
  });

  it(`경기당 CB 최고 진행도가 상한 안으로 들어온다 (${off.cbProgMaxM.toFixed(2)}m → ${on.cbProgMaxM.toFixed(2)}m)`, () => {
    const cap = defaultEngineConfig.movement.restDefence.lineCapProgress * defaultEngineConfig.pitch.width;
    // 상한 + 여유 1m(고정소수 반올림 + 그 틱에 이미 앞서 있던 선수가 걸어 돌아오는 꼬리).
    expect(on.cbProgMaxM).toBeLessThanOrEqual(cap + 1);
    expect(off.cbProgMaxM).toBeGreaterThan(cap + 20);
  });

  it("용량–반응 — `lineCapProgress` 를 내리면 CB 최고 진행도가 단조 감소한다", () => {
    const rungs = [1.0, 0.7, 0.6, 0.5, 0.4].map((v) =>
      measureShapeOutcome(
        cfg((c) => {
          c.movement.defLine.enabled = false;
          c.movement.restDefence.lineCapProgress = v;
        }),
        SEEDS4,
      ).cbProgMaxM,
    );
    for (let i = 1; i < rungs.length; i++) expect(rungs[i]!).toBeLessThan(rungs[i - 1]!);
  });
});

/* ------------------------------------------------------------------------- *
 * R4 — 공격을 죽이지 않는다
 * ------------------------------------------------------------------------- */

describe("S3-B R4 — 수비를 세우면서 공격을 죽이지 않는다", () => {
  const on = measureShapeOutcome(REST_ONLY, SEEDS8);
  const off = measureShapeOutcome(OFF, SEEDS8);

  it(`상대 진영 인원이 잔류 인원만큼만 줄어든다 (${off.attackersUpfieldMean.toFixed(2)} → ${on.attackersUpfieldMean.toFixed(2)}명)`, () => {
    // **관계식으로 건다.** 잔류를 배정하면 전방 인원이 줄어드는 것은 정의상 당연하고, 문제는
    // "얼마나"다. 요청 인원(≈3)보다 많이 줄면 그건 잔류가 아니라 **공격 붕괴**다.
    const want = defaultEngineConfig.movement.restDefence.countMax;
    expect(off.attackersUpfieldMean - on.attackersUpfieldMean).toBeLessThan(want);
    // 그리고 여전히 과반이 전진해 있어야 한다(아웃필더 10명 중).
    expect(on.attackersUpfieldMean).toBeGreaterThan(4);
  });

  it(`슛 볼륨이 무너지지 않는다 (팀당 ${off.shotsPerTeam.toFixed(2)} → ${on.shotsPerTeam.toFixed(2)})`, () => {
    // ⚠️ 절대 밴드가 아니라 **관계식**이다 — 볼륨 총량은 §2-4 가 참고 지표로 강등한 축이고
    // 재보정은 트랙 T 소관이다. 여기서 막는 것은 "공격이 통째로 죽는" 크기의 붕괴뿐이다.
    expect(on.shotsPerTeam).toBeGreaterThan(off.shotsPerTeam * 0.8);
  });
});

/* ------------------------------------------------------------------------- *
 * R5 — 롤백 · 플라시보
 * ------------------------------------------------------------------------- */

describe("S3-B R5 — 롤백과 플라시보", () => {
  it("`lineCapProgress = 1` 은 **배정만 하고 상한이 없는** 팔이다 → 롤백과 비트 동일", () => {
    // 이 기제는 상한 말고는 부작용이 없다 — 그래서 플라시보가 롤백과 정확히 같은 경기다.
    // (S3-A 의 `coverLanePull=0` 은 역할 배정이 로밍·마크 제외를 동반해 달랐다. 여기는 안 그렇다는
    //  것을 **해시로 박제**한다 — 숨은 결합이 생기면 이 테스트가 먼저 깨진다.)
    expect(hashes(PLACEBO, SEEDS4)).toEqual(hashes(OFF, SEEDS4));
    // 그런데 배정 자체는 돌고 있다(관측이 나온다) = "무발화"가 아니라 "무효과"임을 구분한다.
    expect(measureRestDefence(PLACEBO, SEEDS4).restTicks).toBeGreaterThan(0);
    expect(measureRestDefence(PLACEBO, SEEDS4).cappedMean).toBe(0);
  });

  it("상한을 켜면 달라진다 (무발화 가드)", () => {
    expect(hashes(REST_ONLY, SEEDS4)).not.toEqual(hashes(OFF, SEEDS4));
  });
});

/* ------------------------------------------------------------------------- *
 * R6 — 코너 무회귀 (관용구 추출이 no-op 이다)
 * ------------------------------------------------------------------------- */

describe("S3-B R6 — `cornerHolderRank` → `holderRank` 관용구 추출이 no-op 이다", () => {
  it("코너 경로는 이 웨이브의 플래그와 무관하게 도는데, 롤백 해시가 0.38.0 과 같다", () => {
    // 남의 계약(`corner-rest-defence.test.ts`)을 내 변경에 맞추지 않는다는 것이 사전 합의였고,
    // 증명 실패 시 추출을 포기한다는 것도 함께 정했다. 이 해시가 그 증명이다.
        // ⚠️ #407 N4(engine@0.41.0) 재기록 — `chain.hold.oneOnOnePenalty` 는 이 플래그 밖의 전역
    //    변경이다. 0.38.0 값 = ["8c1af96c","3bfd7771","f3049b84","364419fc"].
    // ⚠️ #407 ⑦(engine@0.42.0) 재기록 — `rules.offside.callProb` 도 같은 부류(플래그 밖 전역).
    //    0.41.0 값 = ["656652e2","3bfd7771","41f847a1","364419fc"].
    // ⚠️ #407(engine@0.44.0) — 재기록 대신 **기준점 이동**. config-only 웨이브(출하 튜닝값 3개)는
    //    골든을 새로 적을 게 아니라 롤백 config 에 `preShipping()` 을 얹어 시점을 고정한다.
    //    사유·처방 = `realism/rollback.ts` 상단.
    expect(hashes(OFF_PRE, SEEDS4)).toEqual(["8531adc4", "3bfd7771", "7d94e80b", "364419fc"]);
  });
});
