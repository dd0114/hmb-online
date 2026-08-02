import { describe, it, expect } from "vitest";
import type { TacticalInput } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { setDefShapeObserver } from "../action";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { measureTrap, measureTrapFire, measureRefereeLineMismatch, measureDeadStops, trapOn, withLine } from "./trap";

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
 * **그리고 실패했다.** 60시드 실측(전부 트랩 ON 레짐, 플라시보 대조):
 *
 * | 팔 | 라인(m) | 잡힘 | 뚫림% | 프론티어 대비 가격 |
 * |---|---|---|---|---|
 * | 플라시보(`stepUpM=0`) | 27.723 | 0.6011 | 10.469 | — (기준) |
 * | 트랩 2.5(출하) | 28.078 | 0.6212 | 11.275 | **2.0배** |
 * | 트랩 4 | 28.199 | 0.6284 | 11.573 | **2.0배** |
 * | 트랩 6 | 28.731 | 0.6803 | 13.403 | **1.85배** |
 * | 무차별 `defensiveLineHeight` 0.60 | 28.150 | **0.6762** | **11.978** | 1.0 (프론티어) |
 * | 무차별 0.65 | 28.595 | 0.7407 | 13.153 | 1.0 |
 * | 무차별 0.75 | 29.392 | 0.9253 | 16.540 | 1.0 |
 *
 * 무차별 0.60 은 트랩 6 과 **거의 같은 잡힘(0.6762 vs 0.6803)을 1.4pp 적은 위험**으로 산다.
 * 즉 이 엔진에서 조건부 라인 상향은 무차별 상향에 **지배당한다**. 다섯 가지 기제 변형
 * (어깨 게이트 off · 밴드 8m · 거리 45/55m)으로도 프론티어 아래를 벗어나지 못했다(T3 블록).
 *
 * **그래서 계수를 T3 에 맞추지 않았다** — 스코프 단계에서 그 실패 조건을 미리 선언했고
 * (#377 함정 ④ = "신호 없는 게이트에 계수를 맞춘다"), 대신 **반증을 스냅샷으로 박제**한다.
 * 다음 사람이 같은 주장을 다시 세우지 않게, 그리고 미래 설계(hold/cooldown)가 이걸 뒤집으면
 * **스냅샷이 움직여 그 사실이 보이게**.
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
const select = makeSelectData();

function cfg(mut: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
}
const ON = trapOn("both");
/** 플라시보 — 배정·게이트·라벨은 그대로, **이동만 0**. 라벨이 아니라 기제가 원인임을 가른다. */
const PLACEBO = cfg((c) => { c.movement.defLine.trap.stepUpM = 0; });
/** 롤백 = 0.39.0 동작 재현(기제 off + 구 심판 보정). */
const ROLLBACK = cfg((c) => {
  c.movement.defLine.trap.enabled = false;
  c.rules.offside.trapBiasM = 2.5;
});

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

describe("S3-C T2 — `stepUpM` 사다리 (관찰량은 **상대 선수**의 위치다)", () => {
  /**
   * ⚠️ **1m 칸은 뺐다 — 분해되지 않는다.** 5칸(0/1/2.5/4/6)으로 재면 1m 칸이 뒤집힌다:
   *   n20  0.606 · **0.585** · 0.622 · 0.639 · 0.695
   *   n60  0.6011 · **0.5892** · 0.6212 · 0.6284 · 0.6803
   * 두 표본이 **같은 방향으로** 뒤집히므로 이건 시드 노이즈가 아니라 **효과가 없는 것**이다 —
   * 1m 전진 × 발화 28% ≈ 평균 0.28m 이고 선수의 물리 지연이 그걸 삼킨다. 표본을 늘려도
   * 안 살아나는 칸을 사다리에 넣으면 계약이 플래키해진다(#182 의 rung 폭 교훈).
   * 남긴 4칸은 **n20·n60 둘 다 엄격 단조**다.
   */
  const rungs = [0, 2.5, 4, 6];
  const caught = rungs.map((v) =>
    measureTrap(cfg((c) => { c.movement.defLine.trap.stepUpM = v; }), S20, ON).both.caughtMean,
  );

  it(`라인 뒤에 남겨진 상대 수가 단조 증가한다 (${caught.map((x) => x.toFixed(3)).join(" · ")})`, () => {
    expect(strictlyIncreasing(caught), `stepUpM ${rungs.join("/")} → ${caught.join(", ")}`).toBe(true);
  }, 300_000);

  it("부호를 뒤집으면 방향도 뒤집힌다 (변이체 킬 — 라벨이 아니라 이동이 원인이다)", () => {
    // 라인을 **뒤로** 당기면 라인 뒤 상대가 줄어야 한다. 이 단언이 통과하지 않으면
    // `caughtMean` 이 트랩 이동이 아니라 다른 무언가를 재고 있다는 뜻이다.
    const back = measureTrap(cfg((c) => { c.movement.defLine.trap.stepUpM = -4; }), S20, ON).both.caughtMean;
    expect(back).toBeLessThan(caught[0]!);
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
      arm("trap 6", cfg((c) => { c.movement.defLine.trap.stepUpM = 6; }), trapOnPatch),
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
    expect([row("placebo", PLACEBO), row("trap 2.5", defaultEngineConfig), row("trap 6", cfg((c) => { c.movement.defLine.trap.stepUpM = 6; }))].join("\n")).toMatchSnapshot();
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
    expect(hashes(defaultEngineConfig)).toEqual(REF_0_39_0_SHIPPING);
  }, 300_000);

  it("트랩을 켠 경기도 롤백 config(`trap.enabled=false` + `trapBiasM=2.5`)면 0.39.0 과 같다", () => {
    expect(hashes(ROLLBACK, trapOnPatch)).toEqual(REF_0_39_0_TRAP_ON);
  }, 300_000);

  it("그리고 기제가 켜지면 다르다 (롤백 계약이 공허하지 않다)", () => {
    expect(hashes(defaultEngineConfig, trapOnPatch)).not.toEqual(REF_0_39_0_TRAP_ON);
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
