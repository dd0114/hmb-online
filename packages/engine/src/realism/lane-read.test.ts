import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { LADDER, LADDER_TAG } from "./gate";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { measureLaneSplit } from "./lane";

/**
 * #379 — **수비가 패스 레인을 읽고 먼저 선점한다**(트랙 D M3-B, W0 §2-B).
 *
 * ## 무엇이 없었나
 * 오프더볼 수비의 목표는 블록·마크·압박 셋뿐이었다. 셋 다 **사람 아니면 공**을 본다 —
 * "저 둘 **사이**"라는 개념이 없어 캐리어와 위협적인 리시버를 잇는 선은 비어 있어도 아무도
 * 서지 않았다.
 *
 * ## 이 파일이 집행하는 것
 *  ① **게시판을 안 읽는다**(소스) — A(#369)의 `pass_plan` 은 아군 전용이다. 수비가 읽으면
 *     텔레파시고, W0 이 A 와 B 를 다른 축으로 그은 이유가 사라진다.
 *  ② **출하값에서 광고한 동작이 난다** — 변이체 킬("경기가 달라진다")은 그것을 뜻하지 않는다
 *     (M3-A `pull` 0.45 가 정확히 그 함정이었다). 그래서 출하 config **한 경기 안에서**
 *     엔진의 읽기 판정으로 표본을 갈라 READ vs UNREAD 를 본다.
 *  ③ **플라시보** — 읽기 *라벨*만 있고 선점이 없는 팔(`pull: 0`)에서 두 팔이 같아지는지.
 *     라벨은 능력 비례라 READ 쪽 인지 능력이 살짝 높다(67.9 vs 66.8) — 그 선택 편향이
 *     신호를 만들지 않는다는 것을 이 팔이 **반증으로** 보증한다.
 *  ④ **용량–반응**(사다리 게이트) — 두 점만 보고 인과를 붙이는 것이 이 트랙이 세 번 걸린 자리다.
 *
 * ## ⚠️ 여기서 걸지 **않는** 것 — 전 레인 집계(“패스 레인 점유 39.5%”)
 * W0 §4-B 의 문구는 집계 점유율이지만, 그 집계는 **이 축의 함수가 아니다**. 6 rung 사다리에서
 * 세기를 4배로 올리고 전원이 읽게 해도 57.9~58.9% 사이에서 움직이지 않는다. 이유는 산수다 —
 * 그 지표는 **11명 중 최소**이고, 이 기제가 손대는 것은 결정 틱당 옵션 7.7개 중 0.3개 수준이라
 * 읽힌 레인에서 +6%p 가 나도 전체로는 +0.02%p 다(팔 간 산포 ±0.5%p 의 1/20). 신호가 없는
 * 게이트에 값을 맞추는 것은 금지돼 있으므로(메모리 `balance-measure-multiseed`) 계약에 넣지
 * 않고, 실측과 그 산수를 `evidence/377/M3-B.md` 에 남긴다.
 *
 * ## ⚠️ `coveredM` 과 점유 지표(`guardedPct`)는 **서로의 독립 증거가 아니다**(독립검증 m2)
 * 후보 게이트 `vision.laneRead.coveredM`(출하 3m)과 점유 측정 임계 `lane.ts:LANE_NEAR_M`(3m)은
 * **같은 숫자**이고 **같은 함수**(`perception.ts:laneDangerOn`)를 임계와 비교한다 — 방향만 반대다
 * (전자는 `> coveredM` 인 레인만 후보로 받고, 후자는 `≤ LANE_NEAR_M` 이면 점유로 센다).
 * 그래서 `coveredM` 을 올리면 점유는 **기제와 무관하게 산술로** 무너진다: 4시드 실측 READ 점유
 * 3 → **58.8%** · 4 → 46.8% · 5 → 27.9% · **8 → 0.0%**(표본도 1125 → 53). 이 파일의 사다리가
 * `coveredM` 을 **고정하고 `pull`·`maxStepM` 만** 흔드는 이유가 그것이다. 두 값이 같은 것 자체는
 * 의도된 정합(같은 질문을 같은 자로 잰다)이므로 값·동작은 바꾸지 않는다 — 금지되는 것은 둘을
 * **서로의 확인**으로 인용하는 것이다.
 */

const seeds = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();

const patch = (mut: (c: EngineConfig) => void): EngineConfig => {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
};

/** 최종 해시들 — 동작이 실제로 달라졌는지 보는 가장 강한 판정. */
function hashes(config: EngineConfig, n = 8): string[] {
  return seeds.slice(0, n).map((s) => {
    const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

function laneReadSource(): string {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "decision.ts"), "utf8");
  // 함수 **본문**만 자른다(앞 문서주석은 뺀다 — 거기엔 "안 읽는다"는 설명으로 금지어가 나온다).
  const from = src.indexOf("function readLane(");
  const to = src.indexOf("/**\n * `duty` 배수", from);
  expect(from, "readLane 이 사라졌다").toBeGreaterThan(0);
  expect(to, "readLane 뒤의 앵커(dutyMult 주석)가 사라졌다").toBeGreaterThan(from);
  return src.slice(from, to);
}

describe("#379 수비 레인 예측 — 레인을 읽고 먼저 선점한다", () => {
  it("변이체 킬 — laneRead 를 끄면 경기가 달라진다 (no-op 이면 여기서 걸린다)", () => {
    // M3-A 의 첫 구현은 값을 계산해 놓고 뒤에서 덮어써지는 no-op 이었다. tsc 는 통과한다 —
    // **해시만이 그걸 부정한다.**
    expect(hashes(defaultEngineConfig)).not.toEqual(
      hashes(patch((c) => { c.vision.laneRead.enabled = false; })),
    );
  }, 300_000);

  it("**출하값에서 읽은 수비수가 레인으로 실제로 다가간다** — 광고한 동작이 난다", () => {
    const r = measureLaneSplit(defaultEngineConfig, seeds);
    expect(r.read.n, "READ 표본").toBeGreaterThan(1500);
    expect(r.unread.n, "UNREAD 표본").toBeGreaterThan(2000);
    // ⓪ **선택 편향 배제** — 두 팔이 같은 기하에서 갈렸다(갈린 것은 시드 노이즈 판정 하나뿐).
    //    d0 이 어긋나면 그 차이는 기제가 아니라 표본 구성이다(M3-A 가 세운 규율).
    expect(
      Math.abs(r.read.d0AvgM - r.unread.d0AvgM),
      `d0 READ ${r.read.d0AvgM.toFixed(2)}m vs UNREAD ${r.unread.d0AvgM.toFixed(2)}m`,
    ).toBeLessThan(0.6);
    // ① 관계식 — 읽은 쪽이 레인으로 훨씬 많이 좁힌다(출하 실측 1.278 vs 0.460 = 2.8배).
    expect(
      r.read.closedAvgM,
      `READ 좁힘 ${r.read.closedAvgM.toFixed(3)}m vs UNREAD ${r.unread.closedAvgM.toFixed(3)}m`,
    ).toBeGreaterThan(r.unread.closedAvgM * 2);
    // ② 절대 — 관계식만 두면 UNREAD 가 조용해질 때 통과한다(#377 M2 의 mark-jitter 가 정확히
    //    그 방식으로 거짓 신호를 냈다: 분모가 움직이는 자[尺]).
    expect(r.read.closedPosPct, `READ 좁힌 ${r.read.closedPosPct.toFixed(1)}%`).toBeGreaterThan(65);
    // ③ **AC 의 자[尺]로** — 읽힌 레인이 실제로 더 자주 막힌다(`laneDangerOn` 기준 3m 안).
    //    개인이 다가갔다가 아니라 **레인이 닫혔다**를 본다.
    expect(
      r.read.guardedPct,
      `읽힌 레인 점유 ${r.read.guardedPct.toFixed(1)}% vs 안 읽은 ${r.unread.guardedPct.toFixed(1)}%`,
    ).toBeGreaterThan(r.unread.guardedPct + 3);
  }, 600_000);

  it("플라시보 — 선점을 0 으로 두면 READ/UNREAD 차이가 사라진다 (라벨 편향 반증)", () => {
    // 읽기 확률이 능력 비례라 READ 팔의 인지 능력이 조금 높다 → "잘하는 수비수라 원래 잘 붙는다"가
    // 위 신호를 만들 수 있다. `pull: 0` 은 **판정과 라벨은 그대로 두고 선점만 없앤** 팔이라
    // 그 가설을 직접 반증한다(실측: 좁힌 55.1% vs 55.5% = 차이 없음, 출하는 71.3% vs 53.7%).
    const r = measureLaneSplit(patch((c) => { c.vision.laneRead.pull = 0; }), seeds);
    expect(r.read.n, "플라시보 READ 표본").toBeGreaterThan(1000);
    expect(
      Math.abs(r.read.closedPosPct - r.unread.closedPosPct),
      `플라시보 READ ${r.read.closedPosPct.toFixed(1)}% vs UNREAD ${r.unread.closedPosPct.toFixed(1)}%`,
    ).toBeLessThan(3);
  }, 600_000);

  it("능력치가 높은 수비가 더 자주 읽는다 — '수비 지능'이 계량된다", () => {
    // 읽기 확률 = readBase + readAttrSwing × ((positioning+mental)/2 − 50)/50.
    // 전원이 똑같이 읽으면 그 개념이 없는 것이다(#379 AC).
    expect(hashes(patch((c) => { c.vision.laneRead.readBase = 1; }), 4)).not.toEqual(
      hashes(patch((c) => { c.vision.laneRead.readBase = 0; }), 4),
    );
  }, 300_000);

  it("**A(#369)의 게시판을 안 읽는다** — 정보 출처는 기하뿐(텔레파시 금지)", () => {
    // 동작 실험으로는 "수비가 게시판을 읽는 세계"를 만들 수 없다(그런 config 를 안 두는 것이
    // 계약이다) → 소스 수준으로 박제한다. `pass-plan.test.ts` 의 아군 필터 계약과 같은 방식.
    const fn = laneReadSource();
    for (const forbidden of ["intents", "pass_plan", "readPassPlan", "runOrder"]) {
      expect(fn, `readLane 이 ${forbidden} 를 읽기 시작했다 — 그건 기하가 아니라 텔레파시다`)
        .not.toContain(forbidden);
    }
    // 그리고 실제로 쓰는 입력이 무엇인지도 박아 둔다(공 위치 · 인지 기억 · 우리 골대).
    expect(fn).toContain("state.ball.posFx");
    expect(fn).toContain("ownGoal");
  });

  it("결정론 — 읽기 판정이 RNG 스트림을 소비하지 않는다(시드 노이즈)", () => {
    // #369 가 명시적으로 경고한 함정: 소비량이 후보 수에 비례하면 재개 계약이 후보 공간의
    // 함수가 된다. `varietyNoise` 는 상태의 순수 함수라 스트림을 한 번도 안 건드린다.
    const fn = laneReadSource();
    expect(fn).toContain("varietyNoise");
    expect(fn, "readLane 이 Rng 를 쓰기 시작했다 — 재개 계약이 취약해진다").not.toContain("rng");
  });
});

/**
 * **용량–반응 사다리**(게이트: `HMB_LADDER=1`).
 *
 * 왜 계약인가: 이 트랙이 세 번 걸린 실패 모드가 *"두 점(on/off)만 보고 인과를 붙인다"* 다.
 * 세기를 올리면 읽힌 레인이 **단조로** 더 막혀야 한다 — 안 그러면 관측된 차이는 이 축의
 * 함수가 아니다. `pull` 만 올리면 `maxStepM` 상한에서 포화하므로(실측: 0.6 이상에서 평평)
 * **둘을 같이** 흔든다. 그것 자체가 이 사다리가 알려준 사실이다.
 */
describe.skipIf(!LADDER)(`#379 레인 예측 용량–반응 ${LADDER_TAG}`, () => {
  it("세기를 올리면 읽힌 레인이 단조로 더 막힌다 (UNREAD 대조군 대비)", () => {
    const rungs: [string, number, number][] = [
      ["0.5x", 0.15, 1.25],
      ["1x(출하)", 0.3, 2.5],
      ["2x", 0.6, 5],
      ["4x", 1.0, 12],
    ];
    const s4 = REALISM_SEEDS.slice(0, 4);
    const gaps = rungs.map(([, pull, step]) => {
      const r = measureLaneSplit(
        patch((c) => { c.vision.laneRead.pull = pull; c.vision.laneRead.maxStepM = step; }),
        s4,
      );
      return { closed: r.read.closedAvgM - r.unread.closedAvgM, guard: r.read.guardedPct - r.unread.guardedPct };
    });
    for (let i = 1; i < gaps.length; i++) {
      expect(
        gaps[i]!.closed,
        `rung ${rungs[i]![0]} 좁힘 격차 ${gaps[i]!.closed.toFixed(3)} ≤ ${rungs[i - 1]![0]} ${gaps[i - 1]!.closed.toFixed(3)}`,
      ).toBeGreaterThan(gaps[i - 1]!.closed);
    }
    // 점유(AC 의 자)는 상위 rung 에서 **동료의 선점이 UNREAD 레인까지 덮는 파급**이 생겨
    // 격차가 포화한다 — 그래서 단조 대신 "끝점이 시작점보다 확실히 크다"로 건다.
    expect(
      gaps[gaps.length - 1]!.guard,
      `점유 격차 사다리 ${gaps.map((g) => g.guard.toFixed(1)).join(" → ")}`,
    ).toBeGreaterThan(gaps[0]!.guard + 2);
  }, 900_000);
});
