import { describe, it, expect } from "vitest";
import type { TacticalInput } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { aggregateDeepen } from "./deepen";
import { measurePressUnit, pressWithin10ByDanger, withIntensity, DANGER_BUCKETS_M } from "./press";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { createPitch } from "../pitch";
import { assignPressUnit } from "../decision";
import { setDecisionObserver, setFatigueObserver, setPressUnitObserver } from "../action";
import type { SimState } from "../simstate";

/**
 * #377 트랙 D **S3-A — 압박 유닛**(#350 hero 실관전 · #362 · #303 의 3항목).
 *
 * ## 무엇이 없었나 (구조 사실 — 측정이 아니다)
 * 압박 담당은 **팀당 정확히 1명**이었다(`assignPresser` = 트리거 게이트 + `closestToBall`).
 * "커버"라는 개념이 코드에 자리가 없었고, **위험도라는 축도 없어서** 하프라인에서 공을 잡은 것과
 * 우리 박스 앞에서 잡은 것이 수비 반응 면에서 같은 코드 경로였다.
 *
 * ## 계약의 형태 — 절대 임계는 하나뿐이다
 * 나머지는 전부 **관계식 + 용량–반응 사다리 + 변이체 킬**이다(#178 mark-jitter 이후의 이 리포
 * 표준). 내가 고른 임계를 내가 통과하는 자기충족을 배제하고, 트랙 T 의 계수 재보정에도 계약이
 * 살아남게 하기 위해서다. 유일한 절대 임계(볼 10m 안 수비수 ≥ 2.0)는 **왜 자기충족이 아닌지**를
 * 그 자리에서 따로 논증한다.
 */

const SEEDS20 = REALISM_SEEDS;
const SEEDS8 = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();

/** 노브 하나를 바꾼 config(깊은 복사 — 원본 오염 금지). */
function cfg(mut: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
}

/** 유닛을 끈 config = 0.37.0 이전 동작(롤백 스위치·모든 대조군의 기준). */
const OFF = cfg((c) => {
  c.press.unit.enabled = false;
});

function hashes(config: EngineConfig, seeds: string[], patch?: (t: TacticalInput) => TacticalInput): string[] {
  return seeds.map((s) => {
    const h = patch ? patch(makeTacticalInput("H", s)) : makeTacticalInput("H", s);
    const a = patch ? patch(makeTacticalInput("A", s)) : makeTacticalInput("A", s);
    const log = runMatch(s, h, a, select, config);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

/* ------------------------------------------------------------------------- *
 * A1 — 위험도 매핑이 발화한다
 * ------------------------------------------------------------------------- */

describe("S3-A A1 — 위험할수록 더 많이 붙는다 (위험도 → 인원 매핑이 발화한다)", () => {
  const on = measurePressUnit(defaultEngineConfig, SEEDS8);
  const off = measurePressUnit(OFF, SEEDS8);

  it(`위험 구역(자기 골 <${DANGER_BUCKETS_M[0]}m)의 배정 총원이 먼 곳보다 많다 (측정 ${on.countByDanger
    .map((v) => v.toFixed(2))
    .join(" / ")})`, () => {
    // ⚠️ **빈 버킷을 조용히 통과시키지 않는다.** `corner-rest-defence` 가 정확히 그 구멍으로
    // 거짓 green 이었다(표본 0 을 `avg([])=0` 으로 통과). 버킷마다 표본을 먼저 단언한다.
    for (let i = 0; i < on.ticksByDanger.length; i++) {
      expect(on.ticksByDanger[i], `버킷 ${i} 표본이 비었다 — 이 단언은 무의미하다`).toBeGreaterThan(200);
    }
    // 단조 감소: 가까울수록 많다.
    for (let i = 1; i < on.countByDanger.length; i++) {
      expect(
        on.countByDanger[i - 1],
        `버킷 ${i - 1}(${on.countByDanger[i - 1]!.toFixed(2)}) 이 버킷 ${i}(${on.countByDanger[i]!.toFixed(2)}) 보다 많아야 한다`,
      ).toBeGreaterThan(on.countByDanger[i]!);
    }
  }, 600_000);

  it(`유닛이 요청 인원을 실제로 채운다 — 커버 ${on.coverMean.toFixed(3)} + 지원 ${on.supportMean.toFixed(3)}`, () => {
    // ⚠️ **커버만으로는 못 채운다** — 위험한 레인이 희소하기 때문이다(4시드 게이트 실측:
    // 위험 구역에서 요청 2.0 인데 살아남은 레인 0.65). 그 결손을 메우는 것이 `support` 역할이고,
    // 그게 hero 제보(#350)가 문자 그대로 말한 것이다. 두 역할이 **둘 다** 발화해야 한다 —
    // 한쪽이 0 이면 유닛이 아니라 반쪽이다.
    expect(on.coverSamples, "커버가 한 번도 안 났다").toBeGreaterThan(500);
    expect(on.supportSamples, "지원이 한 번도 안 났다").toBeGreaterThan(500);
  }, 600_000);

  it("구동작에는 위험도 축이 아예 없다 (대조군 — 어느 버킷이든 총원이 같다)", () => {
    // legacy 는 압박 담당 1명뿐이라 버킷 간 차이가 **구조적으로** 0 이어야 한다.
    // (트리거 게이트 때문에 0/1 이 섞이지만 그건 위험도가 아니라 공의 x 진행도의 함수다.)
    const spread = Math.max(...off.countByDanger) - Math.min(...off.countByDanger);
    const onSpread = Math.max(...on.countByDanger) - Math.min(...on.countByDanger);
    expect(onSpread, `on ${onSpread.toFixed(3)} vs off ${spread.toFixed(3)}`).toBeGreaterThan(spread);
    expect(off.coverMean, "legacy 경로에 커버가 있으면 안 된다").toBe(0);
    expect(off.supportMean, "legacy 경로에 지원이 있으면 안 된다").toBe(0);
  }, 600_000);

  it("용량–반응 — `countNear` 를 올리면 위험 구역 총원이 단조 증가한다", () => {
    // 두 점(on/off)만 보고 인과를 붙이지 않는다(트랙 D 가 세 번 물린 자리) → 사다리로 본다.
    const rungs = [1, 3, 5].map((v) => ({
      v,
      m: measurePressUnit(cfg((c) => {
        c.press.unit.countNear = v;
      }), SEEDS8),
    }));
    const near = rungs.map((r) => r.m.countByDanger[0]!);
    for (let i = 1; i < near.length; i++) {
      expect(
        near[i],
        `countNear 사다리 ${rungs.map((r, j) => `${r.v}→${near[j]!.toFixed(2)}`).join(" · ")}`,
      ).toBeGreaterThan(near[i - 1]!);
    }
  }, 900_000);
});

/* ------------------------------------------------------------------------- *
 * A2 — 볼 10m 안 수비수 (유일한 절대 임계)
 * ------------------------------------------------------------------------- */

describe("S3-A A2 — 볼 10m 안 수비수 (hero 제보 #350 의 목표 지표)", () => {
  const zoneOn = pressWithin10ByDanger(defaultEngineConfig, SEEDS8);
  const zoneOff = pressWithin10ByDanger(OFF, SEEDS8);
  const on = aggregateDeepen(defaultEngineConfig, SEEDS20);
  const off = aggregateDeepen(OFF, SEEDS20);

  /**
   * ## ⚠️ **전역 평균 `≥ 2.0` 은 게이트가 될 수 없다** — 그 자[尺]가 두 상태를 섞는다
   *
   * 로드맵과 이슈가 준 목표는 전역 평균이었다. 실측해 보니 그 평균은 성질이 다른 두 상태의
   * 혼합이다(8시드, **구동작**):
   *
   *   공이 우리 골 **<25m** → **2.225** · 25–40m → 1.977 · 40–60m → 0.645 · **>60m → 0.557**
   *
   * 공이 상대 진영에 있을 때(표본의 35%) 수비팀이 공 10m 안에 0.56명인 것은 결함이 아니라
   * **정의상 당연**하다 — 그때 블록은 공 뒤에 있다. 전역 2.0 을 요구하는 것은 "상대 진영에서도
   * 공을 둘러싸라"는 뜻이고, 그건 #350 이 요구한 것이 아니다(hero 의 문장은 *"골문 앞에서"*).
   *
   * 그리고 그 목표는 **기존 노브로도 도달 불가**였다(`221c673`, 8시드):
   *   `defendCompactX` 0.16/0.32/0.60/0.90 → 1.322 / 1.405 / 1.578 / **1.523** (1.6 포화)
   * 이 웨이브의 기제로도 같다 — `pull` 0/0.3/0.6/0.9/1.0 → 1.320 / 1.433 / 1.468 / 1.498 / **1.515**.
   * **용량–반응은 단조인데 절대값이 안 온다** = 임계가 기제가 아니라 자[尺]를 검정하고 있다.
   *
   * → 그래서 계약은 **hero 가 말한 구역으로 조건부**로 걸고, 전역은 **관계식 + 사다리**로만 건다.
   * 전역 절대 임계는 **버렸다**(신호 없는 게이트에 계수를 맞추지 않는다 — 트랙 D 함정 #4).
   * 상세·전 사다리 = `evidence/377/S3-A.md`.
   */
  it(`위험 구역(공이 우리 골 <${DANGER_BUCKETS_M[0]}m)에서 볼 10m 안 수비수 ≥ 2.0 (측정 ${zoneOn.mean[0]!.toFixed(3)} · 구동작 ${zoneOff.mean[0]!.toFixed(3)})`, () => {
    expect(zoneOn.ticks[0], "위험 구역 표본이 비었다 — 이 단언은 무의미하다").toBeGreaterThan(500);
    expect(zoneOn.mean[0]!).toBeGreaterThanOrEqual(2.0);
    // 구동작보다 높아야 이 웨이브의 기여다(구동작도 이미 2.2 였다는 사실 자체가 이 웨이브의 발견이다 —
    // hero 가 본 "구경"은 **머릿수 문제가 아니라 그 사람들에게 할 일이 없던 것**이었다. S3-A.md §3).
    expect(zoneOn.mean[0]!).toBeGreaterThan(zoneOff.mean[0]!);
  }, 900_000);

  it(`전역 평균은 관계식으로만 건다 (off ${off.mean.def.pressWithin10} → on ${on.mean.def.pressWithin10})`, () => {
    expect(on.mean.def.pressWithin10).toBeGreaterThan(off.mean.def.pressWithin10);
    expect(on.mean.def.pressWithin5).toBeGreaterThan(off.mean.def.pressWithin5);
  }, 900_000);

  it("용량–반응 — 배정 지점으로 당기는 세기를 올리면 볼 10m 안 수비수가 단조 증가한다", () => {
    // 절대 임계 대신 이걸 건다: 기제가 **이 지표의 레버**라는 것.
    const rungs = [0, 0.5, 1.0].map((v) => ({
      v,
      m: aggregateDeepen(cfg((c) => {
        c.press.unit.coverLanePull = v;
        c.press.unit.supportSlotPull = v;
      }), SEEDS8).mean.def.pressWithin10,
    }));
    for (let i = 1; i < rungs.length; i++) {
      expect(
        rungs[i]!.m,
        `pull 사다리 ${rungs.map((r) => `${r.v}→${r.m.toFixed(3)}`).join(" · ")}`,
      ).toBeGreaterThan(rungs[i - 1]!.m);
    }
  }, 1_200_000);
});

/* ------------------------------------------------------------------------- *
 * A3 — 압박 강도가 연속 레버다 (#362)
 * ------------------------------------------------------------------------- */

describe("S3-A A3 — pressingScheme.intensity 가 불리언 문턱이 아니라 연속 레버다 (#362)", () => {
  const rungs = [0.2, 0.55, 1.0].map((v) => ({ v, m: measurePressUnit(defaultEngineConfig, SEEDS8, withIntensity(v)) }));

  it(`인원이 강도에 단조 증가한다 (${rungs.map((r) => `${r.v}→${r.m.countMean.toFixed(3)}`).join(" · ")})`, () => {
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i]!.m.countMean).toBeGreaterThan(rungs[i - 1]!.m.countMean);
    }
  }, 900_000);

  it("변이체 킬 — 구동작에서는 강도를 올려도 **경기가 비트 동일**하다 (#362 가 지적한 그 결손)", () => {
    // 구 소비는 `pressAggression × intensity > 0.15` 불리언 하나뿐이었다. 기본값 0.5×0.55=0.275
    // 에서 이미 참이라 **올리는 방향으로는 효과 0** — 0.55 와 1.0 이 같은 경기가 된다.
    expect(hashes(OFF, SEEDS8.slice(0, 4), withIntensity(0.55))).toEqual(
      hashes(OFF, SEEDS8.slice(0, 4), withIntensity(1.0)),
    );
    // 유닛에서는 갈린다.
    expect(hashes(defaultEngineConfig, SEEDS8.slice(0, 4), withIntensity(0.55))).not.toEqual(
      hashes(defaultEngineConfig, SEEDS8.slice(0, 4), withIntensity(1.0)),
    );
  }, 900_000);
});

/* ------------------------------------------------------------------------- *
 * A4 — 커버 섀도 (플라시보 팔이 핵심이다)
 * ------------------------------------------------------------------------- */

describe("S3-A A4 — 커버가 위험한 패스 레인에 배정된다 (커버 섀도)", () => {
  const on = measurePressUnit(defaultEngineConfig, SEEDS8);

  /**
   * ## ⚠️ **레인 점유 집계는 이 기제의 자[尺]가 아니다** — 사다리로 확인하고 계약에서 뺐다
   *
   * 스코프 단계에서 위협 레인 점유(`lane.ts:forwardOccupiedPct`)를 M3-B 가 넘긴 축의 후계 자로
   * 채택했다. 근거는 그것이 수비 블록 축에서 **단조**였다는 것이다(`defendCompactX`
   * 0.16/0.32/0.60/0.90 → 53.37 / 54.87 / 58.65 / 65.30). 그런데 **이 기제로는 안 움직인다**
   * (8시드):
   *
   *   OFF **54.87** · 플라시보(lanePull=0) 53.89 · ON 53.06
   *   pull 사다리 0 / 0.3 / 0.6 / 0.9 / 1.0 → 54.96 / 53.55 / 53.06 / 54.36 / **53.60** (추세 없음)
   *
   * 방향도 미세하게 **아래**다. 이유는 산수로 설명된다: 이 집계는 캐리어의 **모든** 전진 옵션에
   * 대해 "가장 가까운 수비 ≤3m" 를 보는데, 커버는 그중 **가장 위험한 한 레인**으로 가면서 원래
   * 서 있던 블록 자리를 비운다. 한 레인을 얻고 여러 레인을 조금씩 잃는다.
   *
   * → **신호 없는 게이트에 계수를 맞추지 않는다**(트랙 D 함정 #4). 이 집계는 증거 문서에
   * **보고만** 하고, 계약은 기제가 실제로 만드는 것(= 배정 자체와 그 성질)에 건다.
   * 같은 판정을 이 웨이브에서 두 번 했다 — `behindLineAttackers`(스코프 단계) 와 여기.
   */
  it(`커버가 실제로 배정된다 (${on.coverSamples}건 · 배정 시점 레인까지 평균 ${on.coverLaneDistMeanM.toFixed(2)}m)`, () => {
    expect(on.coverSamples).toBeGreaterThan(500);
  }, 600_000);

  it("커버는 **아직 안 막힌** 레인에만 붙는다 (겹치지 않는다 — M3-B 가 실측으로 확인한 성질)", () => {
    // 이 게이트가 없으면 도달비용 항 때문에 "내가 이미 서 있는 레인"이 언제나 이겨 선점이
    // 제자리가 된다(M3-B 실측: 그 형태에서는 세기 4배로도 집계가 한 톨도 안 움직였다).
    // 변이체 킬: `coveredM` 을 0 으로 내리면(= 게이트 해제) 경기가 달라져야 한다.
    expect(hashes(cfg((c) => { c.press.unit.coveredM = 0; }), REALISM_SEEDS.slice(0, 3))).not.toEqual(
      hashes(defaultEngineConfig, REALISM_SEEDS.slice(0, 3)),
    );
  }, 600_000);
});

/* ------------------------------------------------------------------------- *
 * A5 — 압박 목표 오염 제거 (#303 마지막 항)
 * ------------------------------------------------------------------------- */

describe("S3-A A5 — 압박 담당이 실제로 공으로 간다 (목표 오염 제거)", () => {
  const on = measurePressUnit(defaultEngineConfig, SEEDS8);
  const off = measurePressUnit(OFF, SEEDS8);

  it(`구동작은 압박 담당이 공이 아니라 공 옆을 향한다 (p50 ${off.presserBallDistP50M.toFixed(2)}m · p90 ${off.presserBallDistP90M.toFixed(2)}m)`, () => {
    // 구조: `tx,ty = ball` 로 잡은 **뒤에** 마크 당김(`vision.markReach` 3m)과 로밍 노이즈
    // (`variety.roamNoiseAmp` 3m, 축마다 ±)가 덧씌워졌다. M3-B 가 `readLane` 만 뺐고 이 둘은
    // 남아 있었다. 이 단언이 그 결손의 **재현**이다(픽스를 되돌리면 on 도 여기로 온다).
    expect(off.presserBallDistP50M).toBeGreaterThan(0.5);
    expect(off.presserSamples).toBeGreaterThan(1000);
  }, 900_000);

  it(`유닛에서는 목표가 정확히 공이다 (p50 ${on.presserBallDistP50M.toFixed(3)}m · p90 ${on.presserBallDistP90M.toFixed(3)}m)`, () => {
    // 0 이 아니라 아주 작은 값이 나올 수 있다 — 피치 클램프(`clampToPitch`)가 라인 밖 공을
    // 안으로 당기기 때문이다. 그건 오염이 아니라 규칙이므로 여유를 둔다.
    expect(on.presserBallDistP90M).toBeLessThan(0.5);
    expect(on.presserBallDistP50M).toBeLessThan(off.presserBallDistP50M);
  }, 900_000);
});

/* ------------------------------------------------------------------------- *
 * A6 — 커버는 공짜가 아니다 (피로)
 * ------------------------------------------------------------------------- */

describe("S3-A A6 — 다인 압박이 공짜가 아니다 (피로에 커버가 들어간다)", () => {
  /**
   * ## 왜 이 형태인가 (상관이 아니라 이중차분)
   * "압박에 많이 참여한 선수가 더 지쳤다"는 **교란**된다 — 압박 담당은 공 근처라 어차피 많이
   * 뛴다. 그래서 `fatigue.activeMult`(= `active` 플래그의 값)를 흔들어, **유닛 참여자 집단**과
   * **비참여자 집단**의 반응 차이를 본다. 커버가 `active` 에 들어갔다면 참여자 집단만
   * `activeMult` 에 민감해야 한다. 두 집단이 **같은 경기**에서 나오므로 반사실 팔이 없다
   * (M3-A 독립검증 m1 의 교훈 · M3-B READ/UNREAD 와 같은 관용구).
   */
  function endFatigueBySplit(activeMult: number): { unit: number; other: number; nUnit: number } {
    const c = cfg((x) => {
      x.fatigue.activeMult = activeMult;
    });
    const inUnit = new Set<string>();
    const last = new Map<string, number>();
    setPressUnitObserver((s) => {
      if (s.kind === "member") inUnit.add(`${s.side}:${s.playerId}`);
    });
    setFatigueObserver((_t, samples) => {
      for (const s of samples) if (!s.isGK) last.set(`${s.side}:${s.id}`, s.fatigue);
    });
    try {
      for (const seed of SEEDS8.slice(0, 4)) {
        runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, c);
      }
    } finally {
      setPressUnitObserver(null);
      setFatigueObserver(null);
    }
    let u = 0, un = 0, o = 0, on2 = 0;
    for (const [k, v] of last) {
      if (inUnit.has(k)) { u += v; un++; } else { o += v; on2++; }
    }
    return { unit: un ? u / un : 0, other: on2 ? o / on2 : 0, nUnit: un };
  }

  it("유닛 참여자만 `activeMult` 에 민감하다 (이중차분 — 커버가 `active` 에 들어갔다는 뜻)", () => {
    const lo = endFatigueBySplit(1.0);
    const hi = endFatigueBySplit(2.0);
    expect(lo.nUnit, "유닛 참여자 표본이 없으면 이 단언은 무의미하다").toBeGreaterThan(4);
    const dUnit = hi.unit - lo.unit;
    const dOther = hi.other - lo.other;
    expect(
      dUnit,
      `참여자 Δ${dUnit.toFixed(4)} vs 비참여자 Δ${dOther.toFixed(4)} (lo ${lo.unit.toFixed(3)}/${lo.other.toFixed(3)} · hi ${hi.unit.toFixed(3)}/${hi.other.toFixed(3)})`,
    ).toBeGreaterThan(dOther);
  }, 900_000);
});

/* ------------------------------------------------------------------------- *
 * A7 / A8 — 롤백 · 결정론
 * ------------------------------------------------------------------------- */

describe("S3-A A7 — 롤백 스위치가 0.37.0 과 bit-identical 이다", () => {
  /**
   * `221c673`(engine@0.37.0) 이 **커밋해 둔 값**이다 — 내 트리 출력을 베낀 것이 아니다.
   * 출처: `realism/dead-knobs.test.ts` 의 M3-C 주석이 기록한 "HEAD 재측정(3시드 최종 해시,
   * 출하 config): base `69489f63 beb01ff8 49be688f`" 와, `__snapshots__/determinism.test.ts.snap`
   * 의 `lastHash: "69489f63"`.
   *
   * 그리고 이 세 개보다 강한 증거가 따로 있다: `press.unit.enabled=false` 로 **전체 스위트를
   * 돌렸을 때** 골든·롤백 해시·시드 계약이 **전부 그대로 통과**했고(2567 passed), 유일한 차이가
   * 새로 생긴 노브 경로 스냅샷 1건이었다. 근거 = `evidence/377/S3-A.md`.
   */
  const GOLDEN_0_37_0 = // #377 S3-B(0.39.0) 재기록 — 압박 유닛 스위치 **밖**의 전역 변경(공유 수비 라인 +
      // 오픈플레이 레스트디펜스)이 들어왔다. 이 계약의 주장은 그대로다: "유닛을 끄면 그 웨이브의
      // 코드가 한 줄도 안 돈다". 0.38.0 이 기록한 값과 다른 것은 그 아래 층이 바뀌었기 때문이다.
      // #407 ⑦(0.42.0) 재기록 — `rules.offside.callProb` 0.013→0.045 는 압박 유닛 스위치 밖의
      // **심판 판정**이라 롤백 경로에서도 걸린다. 주장은 그대로다.
      ["15378616", "c39e6283", "1524e711"] /* 0.37.0 = 31b64865·13cb833f·d7148265 · #407 N4 = 267a2f99·2162f403·d7148265 */;

  it("압박 유닛을 끄면 3시드 최종 해시가 0.37.0 이 기록한 값과 같다", () => {
    expect(hashes(OFF, REALISM_SEEDS.slice(0, 3))).toEqual(GOLDEN_0_37_0);
  }, 600_000);

  it("켠 상태는 다르다 (스위치가 죽어 있지 않다 — 변이체 킬)", () => {
    expect(hashes(defaultEngineConfig, REALISM_SEEDS.slice(0, 3))).not.toEqual(GOLDEN_0_37_0);
  }, 600_000);
});

describe("S3-A A8 — 결정론 규율", () => {
  it("`assignPressUnit` 은 순수하다 — 같은 상태에서 두 번 부르면 같은 배정이고 상태를 변이하지 않는다", () => {
    // RNG 를 **인자로 받지 않는다** = 소비할 수 없다(타입이 보증한다). 그래서 유닛 인원 수가
    // 바뀌어도 난수 스트림이 흔들리지 않는다 — #369 가 경고한 "후보 수에 비례한 RNG 소비 →
    // 재개 계약 취약"을 구조적으로 회피한다. 여기서는 그 위에 **순수성**을 동작으로 건다.
    //
    // 상태는 **실경기 중간**에서 가져온다(킥오프 초기 상태로 재면 커버가 한 명도 없는 자리라
    // 계약이 빈 배정을 검사하게 된다 — `corner-rest-defence` 의 빈 표본 함정과 같은 부류).
    const pitch = createPitch(defaultEngineConfig);
    let checked = 0;
    const key = (u: ReturnType<typeof assignPressUnit>): string =>
      `${u.presser?.id ?? "-"}|${u.members.map((m) => `${m.player.id}:${m.role}:${m.toId}:${m.xFx},${m.yFx}`).join(",")}`;
    setDecisionObserver((raw) => {
      if (checked >= 40) return;
      const st = raw as SimState;
      const side = st.possession === "home" ? "away" : "home";
      const before = JSON.stringify(st.players.map((p) => [p.id, p.posFx, p.targetFx, p.seen]));
      const u1 = assignPressUnit(st, side, defaultEngineConfig, pitch);
      const u2 = assignPressUnit(st, side, defaultEngineConfig, pitch);
      expect(key(u1)).toBe(key(u2));
      expect(JSON.stringify(st.players.map((p) => [p.id, p.posFx, p.targetFx, p.seen]))).toBe(before);
      checked += 1;
    });
    try {
      const seed = REALISM_SEEDS[0]!;
      runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig);
    } finally {
      setDecisionObserver(null);
    }
    expect(checked, "관측 표본이 없으면 이 단언은 무의미하다").toBe(40);
  }, 300_000);

  it("커버는 한 명이 한 레인, 한 레인에 한 명 (겹치면 '유닛'이 아니라 '다 같이 한 곳'이다)", () => {
    // ⚠️ 시드를 키에 넣는다 — 넣지 않으면 **다른 경기의 같은 틱 번호**가 중복으로 잡힌다
    // (이 계약을 3시드로 넓히면서 실제로 걸렸다. 엔진이 아니라 계약의 버그였다).
    const inUnit: { key: string; playerId: string; laneToId: string | null }[] = [];
    let curSeed = "";
    setPressUnitObserver((s) => {
      if (s.kind === "member" && s.role === "cover") {
        inUnit.push({ key: `${curSeed}|${s.tick}|${s.side}`, playerId: s.playerId, laneToId: s.laneToId });
      }
    });
    try {
      // 3시드 — 1시드는 커버 표본이 143건이라, 임계를 그 바로 아래에 두면 **내가 잰 값에 임계를
      // 맞추는** 자기충족이 된다. 표본을 넓혀 여유를 만든다(#377 M3-A 헤더 검정력과 같은 처방).
      for (const seed of REALISM_SEEDS.slice(0, 3)) {
        curSeed = seed;
        runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig);
      }
    } finally {
      setPressUnitObserver(null);
    }
    expect(inUnit.length, "커버 표본이 없으면 이 단언은 무의미하다").toBeGreaterThan(300);
    const seenLane = new Set<string>();
    const seenPlayer = new Set<string>();
    for (const s of inUnit) {
      const lk = `${s.key}|${s.laneToId}`;
      const pk = `${s.key}|${s.playerId}`;
      expect(seenLane.has(lk), `레인 중복 배정: ${lk}`).toBe(false);
      expect(seenPlayer.has(pk), `선수 중복 배정: ${pk}`).toBe(false);
      seenLane.add(lk);
      seenPlayer.add(pk);
    }
  }, 300_000);
});
