import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { measureDefLine, measureShapeOutcome, withLineHeight } from "./defshape";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * #377 트랙 D **S3-B — 공유 수비 라인**(#303 · 로드맵 W5-2).
 *
 * ## 무엇이 없었나 (구조 사실 — 측정이 아니다)
 * 라인이 아니라 **독립된 스프링 4개**가 있었다. 수비 x = `base + (lineX − base) × defendCompactX`
 * 라 **68%가 자기 포메이션 슬롯**이고, 4-3-3 슬롯은 풀백을 CB보다 **6.3m 앞**에 둔다. 한 수비수의
 * 위치를 **다른 수비수와 비교하는 코드가 0줄**이었다. 그리고 `movement.lineDiscipline`(0.5)은
 * **선언만 있고 소비자가 0** 이었다 — 0 / 0.5 / 1.0 이 3시드 최종 해시까지 동일했고,
 * `dead-knobs` 레지스트리에도 미등록이라 그 사실이 아무 데서도 부정되지 않았다.
 *
 * ## ⚠️ 이 계약이 두 번 다시 만들어진 이유 (초판은 동어반복이었다)
 * 초판은 기준선을 **목표의 평균**으로 잡았다. 목표 이탈 p90 이 3.58 → 1.10 으로 5-rung 엄격
 * 단조라 계약은 통과했지만, **선수는 한 줄에 서지 않았다**(멤버 위치 산포 8.70 → 7.91 = 무변화).
 * 진단이 이유를 한 줄로 답했다: **목표는 이미 촘촘했고(산포 4.40m) 선수가 자기 목표에서 평균
 * 7.65m 뒤에 있었을 뿐**이다. 목표를 더 모으는 계약은 **정의상 참**이다(#377 M2 `wallClearM`).
 * 그래서 기제를 **위치 기준 응집 밴드**로 다시 만들었고, 이 파일의 관찰량도 전부 **위치**다.
 *
 * ## 계약의 형태 — 절대 임계가 하나도 없다
 * 전부 관계식 · 용량–반응 사다리 · 변이체 킬 · 롤백 비트동일이다. 특히 **백4 산포는 게이트가
 * 아니다**(스코프 단계에서 네 겹으로 기각 — `defshape.ts` 머리주석). 도달 불가능한 임계는
 * 게이트가 아니라 오판 생성기라, 그 값은 **제목에 찍어 보고만** 한다.
 */

const SEEDS8 = REALISM_SEEDS.slice(0, 8);
const SEEDS4 = REALISM_SEEDS.slice(0, 4);
const select = makeSelectData();

function cfg(mut: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
}

/** 라인·레스트를 전부 끈 config = 0.38.0(`2cabfc3`) 동작. 모든 대조군의 기준. */
const OFF = cfg((c) => {
  c.movement.defLine.enabled = false;
  c.movement.restDefence.enabled = false;
});
/** 레스트만 끈 config — 라인 축을 격리해서 본다. */
const LINE_ONLY = cfg((c) => {
  c.movement.restDefence.enabled = false;
});

function hashes(config: EngineConfig, seeds: readonly string[]): string[] {
  return seeds.map((s) => {
    const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

/**
 * `lineDiscipline` 사다리 한 칸(레스트 off 로 격리).
 *
 * ⚠️ **L2 사다리는 20시드(`REALISM_SEEDS`)가 필요하다 — 표본을 줄이지 마라.** 같은 사다리를
 * 좁은 표본으로 재면 **비단조**다(멤버 위치 산포 p90, k = 0 · 0.25 · 0.5 · 0.75 · 1.0):
 *    4시드  21.08 · **23.44** · **22.24** · 16.73 · 12.15   ← 중간 두 칸이 뒤집힌다
 *    8시드  21.13 · **22.45** · 20.10 · 16.02 · 11.46       ← k=0 → 0.25 가 뒤집힌다
 *   20시드  22.41 · 22.01 · 20.37 · 16.00 · 11.41           ← 엄격 단조 (계약이 쓰는 표본)
 * 라인 산포는 경기 전개에 민감한 양이라 좁은 표본으로는 인접 rung 을 분해하지 못한다. 이 트랙이
 * 반복해 걸린 **"적은 표본으로 추세를 읽는"** 함정이고, 아래 "보고" 블록의 백4 산포는 같은
 * 이유로 8시드에서 방향 자체가 뒤집힌다.
 *
 * ⚠️ 구 주석은 *"4시드는 비단조이고 같은 사다리가 8시드에서는 **단조**"* 라고 적었는데 그것은
 * **거짓이었다**(S3-B 독립검증 m1 — 위 8시드 줄이 실측이다). 계약은 처음부터 `REALISM_SEEDS`(20)
 * 를 썼으므로 **계약 자체는 건전했고 주석만 틀렸다**. 다만 그 주석을 근거로 표본을 8로 줄였으면
 * L2 는 red 가 된다 — 그래서 위 세 줄을 실측으로 남긴다.
 *
 * L6 은 8시드로 충분하다 — 거기서 보는 것은 인접 rung 이 아니라 **방향 반전**이다.
 */
function rung(k: number, seeds: readonly string[], mut?: (c: EngineConfig) => void) {
  return measureDefLine(
    cfg((c) => {
      c.movement.restDefence.enabled = false;
      c.movement.lineDiscipline = k;
      mut?.(c);
    }),
    seeds,
  );
}

/** 엄격 단조 감소인가. */
function strictlyDecreasing(v: readonly number[]): boolean {
  for (let i = 1; i < v.length; i++) if (!(v[i]! < v[i - 1]!)) return false;
  return true;
}

/* ------------------------------------------------------------------------- *
 * L1 — 라인이 실제로 잡힌다
 * ------------------------------------------------------------------------- */

describe("S3-B L1 — 라인 배정이 발화한다", () => {
  const on = measureDefLine(LINE_ONLY, SEEDS8);

  it(`수비 틱의 대부분에서 라인이 잡힌다 (발화 ${on.appliedPct.toFixed(1)}% · 멤버 ${on.membersMean.toFixed(2)}명 · 압박유닛이 데려간 ${on.excludedByUnitMean.toFixed(2)}명)`, () => {
    // 0 인 틱도 표본에 들어간다(`kind:"line"` 은 미달 틱도 흘린다) — 안 그러면 발화율이 위로
    // 편향된다. S3-A `kind:"unit"` 과 같은 이유.
    expect(on.lineTicks).toBeGreaterThan(10_000);
    expect(on.appliedPct).toBeGreaterThan(85);
    // 백4에서 압박 유닛이 평균 0.7명을 데려가므로 3명 언저리가 정상이다.
    expect(on.membersMean).toBeGreaterThan(2.8);
    expect(on.excludedByUnitMean).toBeGreaterThan(0.2);
  });

  it("롤백 경로에서는 라인이 아예 안 잡힌다 (관측조차 흘리지 않는다)", () => {
    expect(measureDefLine(OFF, SEEDS4).lineTicks).toBe(0);
  });
});

/* ------------------------------------------------------------------------- *
 * L2 — 용량–반응: 선수가 실제로 한 줄에 선다
 * ------------------------------------------------------------------------- */

describe("S3-B L2 — `lineDiscipline` 이 라인을 모은다 (관찰량은 목표가 아니라 **위치**다)", () => {
  const ks = [0, 0.25, 0.5, 0.75, 1.0];
  const rungs = ks.map((k) => ({ k, m: rung(k, REALISM_SEEDS) }));
  const spreadP90 = rungs.map((r) => r.m.memberPosSpreadP90M);
  const spreadMean = rungs.map((r) => r.m.memberPosSpreadMeanM);
  const gap = rungs.map((r) => r.m.targetPosGapMeanM);

  it(`멤버 **위치** 산포 p90 이 단조 감소한다 (${rungs.map((r) => `${r.k}→${r.m.memberPosSpreadP90M.toFixed(2)}`).join(" · ")})`, () => {
    expect(strictlyDecreasing(spreadP90)).toBe(true);
  });

  it(`멤버 **위치** 산포 **평균**은 보고만 한다 — 첫 칸이 평평하다 (${spreadMean.map((v) => v.toFixed(2)).join(" · ")})`, () => {
    // ⚠️ 평균은 20시드에서도 k=0 → 0.25 가 9.00 → 9.01 로 **평평하다**. 밴드는 "이탈자만" 되돌리는
    // 외과적 제약이라 효과가 **꼬리**에 몰리고, 평균은 밴드 안에 있던 다수에 희석된다.
    // 그래서 단조는 p90 에만 걸고(위), 평균은 **양 끝 관계식**으로만 건다 — 분해되지 않는 인접
    // rung 에 단조를 요구하는 것은 신호 없는 게이트다(트랙 D 함정 #4).
    expect(spreadMean[spreadMean.length - 1]!).toBeLessThan(spreadMean[0]! * 0.85);
  });

  it(`목표↔위치 간격이 줄어든다 = 라인이 **도달 가능한** 목표를 받는다 (${gap.map((v) => v.toFixed(2)).join(" · ")})`, () => {
    // 이게 "라인이 종이 위에만 있는가"를 가르는 양이다. 아래 L6 변이체에서 이 값이 **반대로**
    // 움직이는 것이 이 웨이브 설계 주장의 핵심 증거다.
    expect(strictlyDecreasing(gap)).toBe(true);
  });

  it("`lineDiscipline = 0` 은 응집 밴드만 끈 팔이다 (배정은 그대로 — 발화율이 유지된다)", () => {
    expect(rungs[0]!.m.appliedPct).toBeGreaterThan(85);
    expect(rungs[0]!.m.membersMean).toBeGreaterThan(2.8);
  });
});

/* ------------------------------------------------------------------------- *
 * L3 — 축구적 결과 지표: **신호가 없어서 걸지 않는다** (보고 전용)
 * ------------------------------------------------------------------------- */

describe("S3-B L3 — 결과 지표 후보 4종은 **게이트가 아니다** (무신호를 관측 기록으로 박제한다)", () => {
  const ks = [0, 0.5, 1.0];
  const outs = ks.map((k) =>
    measureShapeOutcome(
      cfg((c) => {
        c.movement.restDefence.enabled = false;
        c.movement.lineDiscipline = k;
      }),
      SEEDS4,
    ),
  );

  /**
   * 스냅샷에 박을 형태 — 후보 4종 × 사다리 3칸. 소수 2자리로 반올림해 **diff 를 눈으로 읽을 수
   * 있게** 한다(값은 결정론이라 반올림은 잡음 제거가 아니라 가독성 목적이다).
   */
  const observed = Object.fromEntries(
    ks.map((k, i) => {
      const o = outs[i]!;
      return [
        `lineDiscipline=${k}`,
        {
          offsideLineSdM: Number(o.offsideLineSdM.toFixed(2)),
          lineStepMeanM: Number(o.lineStepMeanM.toFixed(2)),
          concededShotDistP50M: Number(o.concededShotDistP50M.toFixed(2)),
          behindLinePossPct: Number(o.behindLinePossPct.toFixed(2)),
        },
      ];
    }),
  );

  // ⚠️ **제목에 값을 박지 않는다.** 스냅샷 키는 테스트 제목이라, 제목이 값을 담으면 값이 바뀔 때
  // 키가 같이 바뀌어 **새 스냅샷으로 조용히 기록되고 옛것은 obsolete 로 흘러간다** = diff 가 안
  // 뜬다(이 파일의 다른 it 들은 게이트라 제목 보간이 안전하지만, 스냅샷 it 은 아니다).
  // 값은 전부 아래 스냅샷 파일에 있다.
  it("후보 4종의 사다리 반응을 **스냅샷으로 기록**한다 — 게이트가 아니라 관측 기록이다", () => {
    // ⚠️ **이 테스트는 임계를 걸지 않는다 — 게이트가 아니다.** 스코프 단계에서 선언한 후보
    // 3종(라인SD·라인이동·허용슛거리)과 구현 중 추가한 1종(라인 뚫림%)을 전부 사다리로 재 봤고,
    // 어느 것도 이 축에 단조 반응하지 않았다(라인 뚫림%는 `refMode` 를 바꾸면 크게 움직여서
    // **라인 높이의 대리 변수**임이 드러났다 = 응집이 아니라 높이를 재는 자다).
    // 신호 없는 게이트에 계수를 맞추는 것이 트랙 D 의 함정 #4 라 **걸지 않는다**
    // (S3-A §2-2 가 위협 레인 점유를 같은 이유로 계약에서 뺀 선례).
    //
    // ── 왜 `toHaveLength`/`isFinite` 가 아니라 스냅샷인가 (S3-B 독립검증 m2) ──────────
    // 구 단언은 `expect(outs).toHaveLength(3)` + `Number.isFinite(...)` 뿐이었다 — **값이
    // 어떻게 바뀌어도 아무것도 알려주지 않는데** 주석은 "찾아봤고 없었다를 박제했다"고 적었다.
    // 코드가 하는 일보다 서술이 강했다. 스냅샷이면 그 서술이 사실이 된다: 지금의 무신호가
    // **값으로** 남고, 나중에 이 축에 신호가 생기면 **스냅샷 diff 가 그것을 보여준다**
    // (`dead-knobs`·`mark-jitter`·`movement-synchrony` 가 쓰는 이 리포의 관용구).
    // ⚠️ 스냅샷이 깨졌다고 red 가 아니다 — `-u` 로 갱신하되, **사다리가 단조로 변했으면**
    //    그때는 이 축을 진짜 게이트로 승격할 수 있는지 다시 검정하라. 그게 이 기록의 용도다.
    expect(observed).toMatchSnapshot();
  });
});

/* ------------------------------------------------------------------------- *
 * L4 — 죽은 슬라이더 소생 (`team.defensiveLineHeight`)
 * ------------------------------------------------------------------------- */

describe("S3-B L4 — `defensiveLineHeight` 가 경기에 닿는다 (#361 계열)", () => {
  // 표본 8시드 — 4시드에서는 두 팔의 차이(≈2m)가 시드 분산에 묻힌다(실측 4.23 → 5.98 = 1.41배로
  // 내려앉는다). 20시드 실측은 3.71 → 6.38 = **1.72배**다.
  const authority = (config: EngineConfig): number => {
    const lo = measureShapeOutcome(config, SEEDS8, withLineHeight(0.2)).offsideLineMeanM;
    const hi = measureShapeOutcome(config, SEEDS8, withLineHeight(0.9)).offsideLineMeanM;
    return hi - lo;
  };
  const before = authority(OFF);
  const after = authority(LINE_ONLY);

  it(`슬라이더 전 구간의 라인 높이 권한이 유의하게 커진다 (${before.toFixed(2)}m → ${after.toFixed(2)}m)`, () => {
    // ⚠️ **방향 관계식으로만 건다.** 스코프 단계의 "≥8m" 는 러프 목표였고 그 숫자에 검정력이
    // 있는지 확인하지 않았다 — 확인 안 한 숫자를 게이트로 쓰지 않는다.
    expect(after).toBeGreaterThan(before * 1.5);
    // 방향도 맞아야 한다(하이라인 지시가 라인을 **올려야** 한다).
    expect(after).toBeGreaterThan(0);
  });

  it("구동작에서도 방향은 맞았다 — 없던 것은 방향이 아니라 **권한의 크기**다", () => {
    expect(before).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- *
 * L5 — 롤백 비트 동일
 * ------------------------------------------------------------------------- */

describe("S3-B L5 — 롤백 스위치가 0.38.0 과 비트 동일하다", () => {
  it("`defLine.enabled=false` + `restDefence.enabled=false` = `2cabfc3` 해시", () => {
    // 이 한 줄이 여러 주장을 동시에 검증한다:
    //  ① 새 경로가 롤백에서 한 줄도 안 돈다
    //  ② `computeTeamPlan` 의 `heightRangeX` 승격이 롤백 경로에서 구 상수를 그대로 쓴다
    //  ③ `cornerHolderRank` → `teamplan.ts:holderRank` **관용구 추출이 no-op** 이다
    //     (코너 경로는 이 플래그와 무관하게 돌므로, 여기서 해시가 같다는 것이 곧 그 증명이다)
        // ⚠️ #407 N4(engine@0.41.0) 재기록 — hold EV 의 1대1 예외(`chain.hold.oneOnOnePenalty`)는
    //    이 웨이브의 두 스위치 **밖**에서 도는 볼 소유자 결정 코어 변경이라 롤백 경로에서도 걸린다.
    //    계약 내용(①②③)은 그대로다. 0.38.0 값 = ["8c1af96c","3bfd7771","f3049b84","364419fc"].
    expect(hashes(OFF, SEEDS4)).toEqual(["656652e2", "3bfd7771", "41f847a1", "364419fc"]);
  });

  it("켜면 달라진다 — 두 기제가 **각각** 발화한다(무발화 가드)", () => {
    const base = hashes(OFF, SEEDS4);
    expect(hashes(LINE_ONLY, SEEDS4)).not.toEqual(base);
    expect(hashes(cfg((c) => { c.movement.defLine.enabled = false; }), SEEDS4)).not.toEqual(base);
    expect(hashes(defaultEngineConfig, SEEDS4)).not.toEqual(base);
  });
});

/* ------------------------------------------------------------------------- *
 * L6 — 변이체 킬: **절대 기준점은 라인을 만들지 못한다**
 * ------------------------------------------------------------------------- */

describe("S3-B L6 — 기준점이 위치여야 한다 (`refMode` 아블레이션 = 설계 주장 그 자체)", () => {
  const ks = [0, 0.5, 1.0];
  // L6 은 **방향이 뒤집히는지**를 보는 것이라 효과가 크다 → 8시드로 충분하다(위 사다리와 달리
  // 인접 rung 을 분해할 필요가 없다).
  const members = ks.map((k) => rung(k, SEEDS8));
  const planLine = ks.map((k) => rung(k, SEEDS8, (c) => { c.movement.defLine.refMode = "planLine"; }));

  it(`절대 기준점(planLine)은 목표를 **도달 불가능하게** 만든다 — 간격 members ${members
    .map((m) => m.targetPosGapMeanM.toFixed(2))
    .join("/")} vs planLine ${planLine.map((m) => m.targetPosGapMeanM.toFixed(2)).join("/")}`, () => {
    // 이게 이 웨이브의 설계 주장이다. 두 팔 모두 **목표를 클램프한다** — 다른 것은 기준점뿐이다.
    //  · members  : 라인이 실제로 서 있는 곳 → 앞선 선수를 세울 수 있다 → 간격이 **줄어든다**
    //  · planLine : 공에 매인 절대 좌표 → 전원에게 못 따라갈 같은 점을 준다 → 간격이 **늘어난다**
    expect(members[2]!.targetPosGapMeanM).toBeLessThan(members[0]!.targetPosGapMeanM);
    expect(planLine[2]!.targetPosGapMeanM).toBeGreaterThan(planLine[0]!.targetPosGapMeanM);
  });

  it("두 팔은 실제로 다른 경기다 (아블레이션 한 팔이 재현 가능하다 — #377 M2 m3)", () => {
    expect(hashes(cfg((c) => { c.movement.restDefence.enabled = false; c.movement.defLine.refMode = "planLine"; }), SEEDS4)).not.toEqual(
      hashes(LINE_ONLY, SEEDS4),
    );
  });
});

/* ------------------------------------------------------------------------- *
 * 보고 전용 — 백4 산포(게이트 아님)
 * ------------------------------------------------------------------------- */

describe("S3-B 보고 — 백4 산포는 **게이트가 아니다**", () => {
  // ⚠️ 표본이 20시드인 이유: 8시드에서는 이 양의 방향이 **뒤집힌다**(off 9.92 → on 10.70).
  // 전 백4에는 그 틱의 압박 담당(라인 보정에서 제외된 선수)이 섞여 있어 분산이 크다.
  // "두 점 비교는 이 트랙에서 네 번 틀렸다"의 또 다른 실례라, 방향을 주장하려면 표본이 필요하다.
  const on = measureShapeOutcome(LINE_ONLY, REALISM_SEEDS);
  const off = measureShapeOutcome(OFF, REALISM_SEEDS);

  it(`산포 off ${off.backSpreadMeanM.toFixed(2)} → on ${on.backSpreadMeanM.toFixed(2)}m (p50 ${on.backSpreadP50M.toFixed(2)} · p90 ${on.backSpreadP90M.toFixed(2)}) · 위험거리별 ${on.backSpreadByDangerM
    .map((v) => v.toFixed(2))
    .join(" / ")}`, () => {
    // 로드맵의 "≤6m" 는 **도달 불가능한 수**다(모든 당김을 제거하고 투영을 100%로 올려도 7.2m).
    // 게다가 위험거리 버킷별로 성질이 다른 두 상태를 섞는다(정착 블록 vs 상대 진영 빌드업).
    // 그래서 임계 대신 **방향 관계식**만 건다.
    expect(on.backSpreadMeanM).toBeLessThan(off.backSpreadMeanM);
  });
});
