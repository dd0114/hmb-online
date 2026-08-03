import { describe, it, expect } from "vitest";
import type { TacticalInput } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { knobPaths } from "./knob-paths";

/**
 * #338 — **죽은 노브 레지스트리**(사슬 기본 하에서 실행 경로가 없는 튜닝값).
 *
 * ## 왜 주석으로는 부족한가
 * 0.24.0 이 볼 소유자 결정 코어를 사슬로 바꾸면서, `decideBallOwner` **안에서만** 살아 있던
 * 판정들이 조용히 실행 경로를 잃었다. 타입은 통과하고 골든은 (그 시점) 경로를 보증하므로
 * **아무 데서도 빨간불이 안 켜진다.** 실제로 `decisionWeights.shoot` 이 완전 무효인 것을
 * 60시드 스윕으로 발견한 전례가 있다(전부 12.31 동일). config 주석은 그동안 현행처럼 쓰여 있었고,
 * 다음 세션이 그 노브를 돌리며 시간을 태웠다.
 *
 * 주석은 스테일해진다. 그래서 **레지스트리를 계약으로 박제**한다:
 *  - `INERT` 로 선언한 노브는 값을 바꿔도 **bit-identical 이어야 한다**(주석이 사실임을 증명).
 *  - `LIVE` 로 선언한 노브는 값을 바꾸면 **반드시 달라져야 한다**(레버가 조용히 죽으면 여기서 걸린다).
 *
 * ⚠️ 이 노브들을 **지우지 않는다.** 롤백 스위치(`chain.mode="weighted"`)의 자산이다.
 * 문제는 존재가 아니라 "지금 튜닝해도 효과가 없다"가 어디에도 표시돼 있지 않았다는 것이다.
 *
 * ## 이 웨이브에서 정정한 것 (#338 본문의 목록이 일부 스테일했다)
 *  - `contest.oneOnOneClearM` · `oneOnOneXgMult` → **살아 있다.** 0.27.0 이 `oneOnOneShot` 을
 *    두 코어가 공유하는 함수로 이식했다(`chain.ts` 가 루트에서 호출). 죽은 것은 `oneOnOneShootBias`
 *    하나뿐이고, 그건 chain 이 **의도적으로** 적용하지 않는다(EV 공간에 대응물이 없다 — chain.ts 주석).
 *  - `clearance.maxProgress` · `minPressers` → **살아 있다.** `clearanceEligible` 은 두 코어가
 *    같은 함수를 쓴다. 죽은 것은 `passScoreCeil` · `boxWeightMult`(둘 다 `clearanceWeight` 안).
 */

const seeds = REALISM_SEEDS.slice(0, 3);
const select = makeSelectData();

/** 노브 하나를 바꾼 config 로 최종 해시들. */
function hashes(mutate: (c: EngineConfig) => void): string[] {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mutate(c);
  return seeds.map((s) => {
    const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, c);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

/** 노브 + **팀 지시**를 같이 바꾼 config 로 최종 해시들(조건부 LIVE 검정용). */
function hashesWith(mutate: (c: EngineConfig) => void, patch: (t: TacticalInput) => TacticalInput): string[] {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mutate(c);
  return seeds.map((s) => {
    const log = runMatch(s, patch(makeTacticalInput("H", s)), patch(makeTacticalInput("A", s)), select, c);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

const BASE = hashes(() => {});

interface Knob {
  path: string;
  mutate: (c: EngineConfig) => void;
}

/**
 * **INERT** — 사슬 기본에서 실행 경로가 없다. 값을 바꿔도 경기가 비트 동일해야 한다.
 * (전부 `decideBallOwner`/`selectPassOption`/`scoreOption`/`clearanceWeight` 안에서만 읽힌다.)
 */
const INERT: Knob[] = [
  { path: "decisionWeights.shoot", mutate: (c) => { c.decisionWeights.shoot = 0.05; } },
  { path: "decisionWeights.pass", mutate: (c) => { c.decisionWeights.pass = 0.05; } },
  { path: "decisionWeights.dribble", mutate: (c) => { c.decisionWeights.dribble = 3; } },
  { path: "decisionWeights.hold", mutate: (c) => { c.decisionWeights.hold = 3; } },
  { path: "decisionWeights.clearance", mutate: (c) => { c.decisionWeights.clearance = 5; } },
  { path: "decisionWeights.shootInBox", mutate: (c) => { c.decisionWeights.shootInBox = 3; } },
  { path: "decisionWeights.shootCentralBonus", mutate: (c) => { c.decisionWeights.shootCentralBonus = 4; } },
  { path: "decisionWeights.backwardPassPenalty", mutate: (c) => { c.decisionWeights.backwardPassPenalty = 0; } },
  { path: "contest.centralShootHalfM", mutate: (c) => { c.contest.centralShootHalfM = 34; } },
  { path: "contest.oneOnOneShootBias", mutate: (c) => { c.contest.oneOnOneShootBias = 20; } },
  { path: "softCap", mutate: (c) => { c.softCap = 0.9; } },
  { path: "variety.decisionTemperature", mutate: (c) => { c.variety.decisionTemperature = 0.9; } },
  { path: "variety.dribbleChainProb", mutate: (c) => { c.variety.dribbleChainProb = 0; } },
  { path: "variety.dribbleChainBonus", mutate: (c) => { c.variety.dribbleChainBonus = 9; } },
  { path: "clearance.passScoreCeil", mutate: (c) => { c.clearance.passScoreCeil = 999; } },
  { path: "clearance.boxWeightMult", mutate: (c) => { c.clearance.boxWeightMult = 9; } },
  { path: "ball.shotSpeed", mutate: (c) => { c.ball.shotSpeed = 1; } },
];

/**
 * **LIVE** — 사슬 기본에서 실제 레버다. 값을 바꾸면 반드시 달라져야 한다.
 * 여기 있는 항목이 INERT 로 변하면(= 조용히 죽으면) 그게 정확히 #338 이 겪은 사고다.
 */
const LIVE: Knob[] = [
  // ⚠️ 섭동 폭이 좁으면 "레버가 죽었다"는 **거짓 경보**가 난다 — 기본 22 에서 20 은 3시드에서
  // 비트 동일이었다(EV 정수 비교의 순위가 한 번도 안 뒤집힌다). 레버성 판정은 넉넉히 흔든다.
  { path: "chain.goalValue", mutate: (c) => { c.chain.goalValue = 40; } },
  { path: "contest.shootXgThreshold", mutate: (c) => { c.contest.shootXgThreshold = 0.2; } },
  { path: "clearance.maxProgress", mutate: (c) => { c.clearance.maxProgress = 0.99; } },
  { path: "clearance.minPressers", mutate: (c) => { c.clearance.minPressers = 9; } },
  // #369 예고 패스(M3-A). 등록 절차는 CLAUDE.md §2.5 — 스냅샷이 깨지면 여기 먼저 등록한다.
  { path: "movement.passPlan.enabled", mutate: (c) => { c.movement.passPlan.enabled = false; } },
  { path: "movement.passPlan.readBase", mutate: (c) => { c.movement.passPlan.readBase = 0; } },
  { path: "movement.passPlan.readAttrSwing", mutate: (c) => { c.movement.passPlan.readAttrSwing = 1.5; } },
  { path: "movement.passPlan.pull", mutate: (c) => { c.movement.passPlan.pull = 0.95; } },
  { path: "movement.passPlan.expireTicks", mutate: (c) => { c.movement.passPlan.expireTicks = 1; } },
  // #377 M3-C 스루패스(공간 타깃 패스 후보). 8개 전부 3시드에서 해시가 움직이는 것을 확인하고
  // 등록했다 — 후보 **수**가 바뀌면 `chain.temperature` 샘플링의 k·floor 가 바뀌므로,
  // "채택이 안 바뀌어도" 동작은 바뀐다(그래서 표본이 얇아도 레버성 판정이 견고하다).
  { path: "chain.throughPass.enabled", mutate: (c) => { c.chain.throughPass.enabled = false; } },
  { path: "chain.throughPass.behindLineM", mutate: (c) => { c.chain.throughPass.behindLineM = 12; } },
  { path: "chain.throughPass.minRunGainM", mutate: (c) => { c.chain.throughPass.minRunGainM = 12; } },
  // ⚠️ 섭동 폭을 **건드리지 않는다**(M3-C 가 정한 20 그대로). #379 M3-B 가 한때 24 로 벌렸다가
  // 독립검증 m3 에서 **되돌렸다** — 그 근거("20 은 3시드에서 INERT 가 됐다")가 재현되지 않는다.
  // HEAD 재측정(3시드 최종 해시, 출하 config): base `69489f63 beb01ff8 49be688f` vs
  // minLeadM=20 `3d198097 beb01ff8 3e6e803c` = **3시드 중 2개가 갈린다 → LIVE**(24 도 같은 2개가
  // 갈린다 — 즉 20 과 24 는 검출력이 같다). 남는 사실은 M3-C 가 기록한 성질뿐이다: 채택된
  // 스루패스의 리드가 **상한(`maxLeadM` 25)에 몰려 있어**(8/12건) 하한은 상한 근처로 올라가야
  // 발화하고, `minLeadM` 2·15 는 8시드에서도 bit-identical 이다. 20 은 이미 그 위다.
  { path: "chain.throughPass.minLeadM", mutate: (c) => { c.chain.throughPass.minLeadM = 20; } },
  { path: "chain.throughPass.maxLeadM", mutate: (c) => { c.chain.throughPass.maxLeadM = 12; } },
  { path: "chain.throughPass.minMarginTicks", mutate: (c) => { c.chain.throughPass.minMarginTicks = 6; } },
  { path: "chain.throughPass.raceBase", mutate: (c) => { c.chain.throughPass.raceBase = 0.05; } },
  { path: "chain.throughPass.raceGainPerTick", mutate: (c) => { c.chain.throughPass.raceGainPerTick = 0; } },
  // #379 M3-B 수비 레인 예측. 10개 전부 3시드에서 해시가 움직이는 것을 **등록 전에** 확인했다.
  // (레인 후보가 하나만 달라져도 그 수비수의 목표가 달라지고, 그 자리가 다음 경합을 바꾼다 —
  //  그래서 발화 빈도가 낮아도(수비수-틱의 ~4%) 레버성 판정이 견고하다.)
  { path: "vision.laneRead.enabled", mutate: (c) => { c.vision.laneRead.enabled = false; } },
  // #377 S3-B 공유 수비 라인 + 오픈플레이 레스트디펜스. 12개 전부 3시드에서 해시가 움직이는 것을
  // **등록 전에** 확인했다. `movement.lineDiscipline` 은 0.38.0 까지 **선언만 있고 소비자가 0**
  // 이었고(0/0.5/1.0 이 3시드 해시까지 동일) 이 레지스트리에도 없어서 그 사실이 아무 데서도
  // 부정되지 않았다 — 이 웨이브가 소비처를 만들고 여기 등록한다.
  { path: "movement.lineDiscipline", mutate: (c) => { c.movement.lineDiscipline = 1; } },
  { path: "movement.defLine.enabled", mutate: (c) => { c.movement.defLine.enabled = false; } },
  { path: "movement.defLine.memberProgressMax", mutate: (c) => { c.movement.defLine.memberProgressMax = 0.5; } },
  { path: "movement.defLine.minMembers", mutate: (c) => { c.movement.defLine.minMembers = 4; } },
  { path: "movement.defLine.roleOffsetKeep", mutate: (c) => { c.movement.defLine.roleOffsetKeep = 1; } },
  { path: "movement.defLine.blockLineRangeM", mutate: (c) => { c.movement.defLine.blockLineRangeM = 15; } },
  { path: "movement.defLine.heightRangeX", mutate: (c) => { c.movement.defLine.heightRangeX = 0.1; } },
  { path: "movement.defLine.refMode", mutate: (c) => { c.movement.defLine.refMode = "planLine"; } },
  // `bandMode` 는 **밴드의 어느 쪽이 무는가**다. `"holdBack"`(앞으로 튀어나간 선수만 되돌림)은
  // 응집을 거의 못 만든다(위치 산포 p90 23.77 → 20.75, 비단조) — 라인을 만드는 일의 대부분은
  // **뒤처진 선수를 밀어 올리는 쪽**이 한다는 실측이고, 그래서 이 노브는 아블레이션 자산이다.
  { path: "movement.defLine.bandMode", mutate: (c) => { c.movement.defLine.bandMode = "holdBack"; } },
  { path: "movement.restDefence.enabled", mutate: (c) => { c.movement.restDefence.enabled = false; } },
  { path: "movement.restDefence.countMin", mutate: (c) => { c.movement.restDefence.countMin = 5; } },
  { path: "movement.restDefence.countMax", mutate: (c) => { c.movement.restDefence.countMax = 1; } },
  { path: "movement.restDefence.lineCapProgress", mutate: (c) => { c.movement.restDefence.lineCapProgress = 1; } },
  { path: "vision.laneRead.readBase", mutate: (c) => { c.vision.laneRead.readBase = 0; } },
  { path: "vision.laneRead.readAttrSwing", mutate: (c) => { c.vision.laneRead.readAttrSwing = 1.2; } },
  { path: "vision.laneRead.readPeriodTicks", mutate: (c) => { c.vision.laneRead.readPeriodTicks = 25; } },
  { path: "vision.laneRead.pull", mutate: (c) => { c.vision.laneRead.pull = 0.9; } },
  { path: "vision.laneRead.maxStepM", mutate: (c) => { c.vision.laneRead.maxStepM = 0.2; } },
  { path: "vision.laneRead.reachM", mutate: (c) => { c.vision.laneRead.reachM = 3; } },
  { path: "vision.laneRead.laneCostWeight", mutate: (c) => { c.vision.laneRead.laneCostWeight = 0; } },
  { path: "vision.laneRead.minThreatM", mutate: (c) => { c.vision.laneRead.minThreatM = 30; } },
  { path: "vision.laneRead.coveredM", mutate: (c) => { c.vision.laneRead.coveredM = 8; } },
  // #377 S3-A 압박 유닛. 19개 전부 3시드에서 해시가 움직이는 것을 **등록 전에** 확인했다.
  //
  // ⚠️ **셋이 서로 같은 해시를 낸다** — `minThreatM=40` · `reachM=2` · `coveredM=12` 가 전부
  // `3cf6ccd0 2cf000d5 ac5beb8c` 다. 결함이 아니라 **같은 기제를 서로 다른 문에서
  // 끄고 있다는 증거**였다(다섯 다 커버 생성 게이트 → 극단에서 "커버 0" 한 상태로 수렴).
  // 그리고 그 상태는 `enabled=false`(`69489f63 …`)와 **달랐다** — 커버가 없어도 목표 오염 제거는
  // 살아 있기 때문이다. 즉 그 표가 "커버"와 "오염 제거"가 **분리 가능한 두 효과**임을 같이 보여
  // 줬다. (지금은 지원 역할이 생겨 수렴 지점이 갈라진다.)
  // (등급성 — 중간값에서도 레버인가 — 은 `press-unit.test.ts` 의 용량–반응 사다리가 따로 본다.
  //  레지스트리의 질문은 "값을 바꾸면 경기가 달라지는가" 하나다.)
  { path: "press.unit.enabled", mutate: (c) => { c.press.unit.enabled = false; } },
  { path: "press.unit.wideWeight", mutate: (c) => { c.press.unit.wideWeight = 2; } },
  { path: "press.unit.dangerNearM", mutate: (c) => { c.press.unit.dangerNearM = 70; } },
  { path: "press.unit.dangerFarM", mutate: (c) => { c.press.unit.dangerFarM = 26; } },
  { path: "press.unit.countNear", mutate: (c) => { c.press.unit.countNear = 6; } },
  { path: "press.unit.countFar", mutate: (c) => { c.press.unit.countFar = 4; } },
  { path: "press.unit.rangeM", mutate: (c) => { c.press.unit.rangeM = 60; } },
  { path: "press.unit.intensityCountGain", mutate: (c) => { c.press.unit.intensityCountGain = 3; } },
  { path: "press.unit.intensityRangeGain", mutate: (c) => { c.press.unit.intensityRangeGain = 3; } },
  { path: "press.unit.coverLanePull", mutate: (c) => { c.press.unit.coverLanePull = 0; } },
  { path: "press.unit.coverLaneReachM", mutate: (c) => { c.press.unit.coverLaneReachM = 40; } },
  { path: "press.unit.dangerRefM", mutate: (c) => { c.press.unit.dangerRefM = 0; } },
  { path: "press.unit.minThreatM", mutate: (c) => { c.press.unit.minThreatM = 40; } },
  { path: "press.unit.reachM", mutate: (c) => { c.press.unit.reachM = 2; } },
  { path: "press.unit.coveredM", mutate: (c) => { c.press.unit.coveredM = 12; } },
  { path: "press.unit.laneCostWeight", mutate: (c) => { c.press.unit.laneCostWeight = 5; } },
  { path: "press.unit.supportGapM", mutate: (c) => { c.press.unit.supportGapM = 25; } },
  { path: "press.unit.supportSpreadM", mutate: (c) => { c.press.unit.supportSpreadM = 20; } },
  { path: "press.unit.supportSlotPull", mutate: (c) => { c.press.unit.supportSlotPull = 0; } },
  // #407 N1/N4 (0.41.0). 둘 다 **롤백 스위치**라 섭동은 "끈 값 ↔ 켠 값"이다.
  //  · `shootDistance.enabled` = 출하 **false**(감쇠 미사용). 켜면 슛 생성이 `genMaxM` 까지
  //    넓어지므로 3시드에서 반드시 갈린다.
  //  · `hold.oneOnOnePenalty` = 출하 4.0. **사실상 불리언이다** — 1대1 에서 hold 의 우위가 작아
  //    2.0/6.0/20.0 의 20시드 집계가 완전히 동일했다. 그래서 위쪽으로 흔들면 bit-identical 이고,
  //    레버성 판정은 **0(=예외 없음)** 으로만 잰다. 등록 전 확인: 4시드 중 2개(seed#1·#2)가 갈린다.
  { path: "chain.shootDistance.enabled", mutate: (c) => { c.chain.shootDistance.enabled = true; } },
  { path: "chain.hold.oneOnOnePenalty", mutate: (c) => { c.chain.hold.oneOnOnePenalty = 0; } },
  // #407 ⑦ (0.42.0). **미등록이었다** — 0.5.0 도입 이후 아무도 재보정하지 않은 채 콜 빈도가
  // 4배 아래로 내려앉았는데(1.88 → 0.425) 그 사실을 부정하는 계약이 어디에도 없었다.
  // 섭동은 **0**(= 호출 게이트를 완전히 닫음). 기하 오프사이드가 팀-경기당 27.93건 발생하므로
  // 게이트를 닫으면 반드시 갈린다. 빈도의 밴드·단조는 `offside-call.test.ts` 가 따로 본다.
  { path: "rules.offside.callProb", mutate: (c) => { c.rules.offside.callProb = 0; } },
  // #407 N2 (0.43.0) **조건부 박스 도착런**. 출하 기본은 `enabled: false` 라 스위치만 여기 있고
  // 형태 노브 **8종**은 아래 **조건부 LIVE** 블록이 본다(N1 감쇠 형태 노브와 같은 처방).
  // 섭동 = 켜기. 켜면 러너의 목표가 바뀌므로 3시드에서 반드시 갈린다(등록 전 확인).
  { path: "movement.boxArrival.enabled", mutate: (c) => { c.movement.boxArrival.enabled = true; } },
  // #407 박스 유입 탐색(0.44.0, **출하 없음**) — **셋 다 미등록이었다.** `variety.*` 오버랩 계열은
  // 0.4.0 도입 이후, `rules.foul.base` 는 0.28.0 재보정 이후 이 레지스트리에 없었다. 팔은 출하되지
  // 않았지만(탐색 종료) **"레버인데 등록이 없다"는 사실 자체는 그대로**라 여기 남긴다.
  { path: "variety.defenderOverlapProb", mutate: (c) => { c.variety.defenderOverlapProb = 0.4; } },
  // ⚠️ **계단 노브다** — 자격 문턱이 base 슬롯 x 라 슬롯 사이 값은 전부 같은 팔이다
  // (4-3-3: `.45`~`.70` 이 **bit-identical**). 섭동을 좁게 잡으면 **거짓 INERT** 가 난다.
  // 출하 `.4` 에서 `.8` 은 ST 포함 전원이 대상이 되므로 반드시 갈린다.
  { path: "variety.overlapBaseLine", mutate: (c) => { c.variety.overlapBaseLine = 0.8; } },
  { path: "rules.foul.base", mutate: (c) => { c.rules.foul.base = 0.22; } },
];

describe("#338 죽은 노브 레지스트리 — 사슬 기본에서 무효인 것들", () => {
  for (const k of INERT) {
    it(`INERT: ${k.path} 를 바꿔도 경기가 bit-identical 이다 (주석이 사실이다)`, () => {
      expect(hashes(k.mutate), `${k.path} 가 chain 경로에서 동작을 바꿨다 — 주석/레지스트리가 스테일하다`).toEqual(BASE);
    }, 120_000);
  }
});

describe("#338 살아 있는 노브 — 조용히 죽으면 여기서 걸린다", () => {
  for (const k of LIVE) {
    it(`LIVE: ${k.path} 를 바꾸면 경기가 달라진다`, () => {
      expect(hashes(k.mutate), `${k.path} 가 무효가 됐다 — #338 과 같은 사고(레버가 조용히 죽음)`).not.toEqual(BASE);
    }, 120_000);
  }
});

/**
 * **조건부 LIVE** — 코드 경로는 살아 있는데 **상황이 나야** 레버가 되는 노브(#316).
 *
 * `oneOnOneShot` 은 0.27.0 에서 두 코어 공유 함수로 이식됐다(chain.ts 가 루트에서 호출). 그런데
 * 45분 레짐에서 1대1 발생이 **경기당 0.5회** 수준이라(#316 잔여), 3시드 표본에서는 기본
 * `oneOnOneClearM` 로 **한 번도 안 걸려** 값을 바꿔도 해시가 그대로다. 그건 "죽은 노브"가
 * 아니라 **표본에 사례가 없는 것**이다 — 두 원인은 처방이 정반대라 갈라서 박제한다.
 * 그래서 여기서는 **상황을 만들어 놓고**(반경을 좁혀 판정이 자주 걸리게) 레버성을 확인한다.
 */
describe("#338 조건부 LIVE — 1대1 계열(#316 빈도 미달이라 상황을 만들어 잰다)", () => {
  /** 반경을 좁히면 "반경 안 상대 0명"이 쉬워져 판정이 자주 걸린다. */
  const withClear = (clearM: number, mult: number) => (c: EngineConfig) => {
    c.contest.oneOnOneClearM = clearM;
    c.contest.oneOnOneXgMult = mult;
  };

  it("oneOnOneClearM 은 레버다 (반경을 좁히면 경기가 달라진다)", () => {
    expect(hashes(withClear(0.5, defaultEngineConfig.contest.oneOnOneXgMult))).not.toEqual(BASE);
  }, 120_000);

  it("oneOnOneXgMult 는 레버다 (사례가 있는 조건에서 배수를 바꾸면 달라진다)", () => {
    expect(hashes(withClear(0.5, 1.05))).not.toEqual(hashes(withClear(0.5, 3.0)));
  }, 120_000);

  it("rules.restart.fallbackKick 도 조건부 LIVE 다 — 킥 후보가 0 일 때만 발화(#349)", () => {
    // 독립검증 m5: 4시드에서 INERT 로 보이지만 소비자는 실재한다(`decision.ts` 의 wClear 폴백 ·
    // `chain.ts` 의 pushClear(force)). 재시작에서 **패스 옵션 0 + 사거리 밖 + 걷어내기 부적격**이
    // 동시에 성립해야 발화하므로 표본에 사례가 없을 뿐이다. `mustKick` 을 끄면 이 폴백 자체가
    // 도달 불가가 되므로, "켠 상태에서 폴백만 끄기"가 의미를 갖는 유일한 대조다.
    const off = hashes((c) => { c.rules.restart.fallbackKick = false; });
    // 사례가 없으면 동일한 것이 **정상**이다 — 이 단언은 "동일함"을 기록해 두는 것이 목적이고,
    // 깨지면(달라지면) 폴백이 실제로 발화하기 시작했다는 뜻이라 그때 LIVE 로 올린다.
    expect(off).toEqual(BASE);
  }, 120_000);

  it("⚠️ 기본 반경에서는 3시드에 사례가 없다 — #316(1대1 빈도 0.5/경기)의 직접 증거", () => {
    // 이 단언이 **깨지면 좋은 일**이다(#316 이 해소돼 사례가 늘었다는 뜻) → 그때 이 블록을
    // 통째로 LIVE 로 올리고 이 주석을 지워라.
    //
    // ⚠️ #407(0.44.0 탐색)에서 이 단언이 **한 번 뒤집혔다가 돌아왔다** — 박스 유입 팔
    // (`variety.defenderOverlap*` 계열)을 켜면 세 번째 시드에 1대1 사례가 생겨 red 가 됐다.
    // 그때 확인한 것: **그건 #316 해소가 아니다.** 같은 팔에서 1대1 **빈도는 오히려 5.19% →
    // 4.12% 로 줄었고**(n60), 뒤집힌 것은 3시드 **표본의 구성**이었다. 그 팔은 출하되지 않았다
    // (탐색 종료 — `issues/2026-08-03-engine-box-inflow-arm.md` §7-quinquies).
    // ⇒ 이 단언이 다시 깨지거든 **빈도 지표로 먼저 확인해라**. 3시드 해시는 #316 의 판정자가 아니다.
    expect(hashes((c) => { c.contest.oneOnOneXgMult = 1.01; })).toEqual(BASE);
  }, 120_000);
});

/**
 * **조건부 LIVE** — #377 S3-B 레스트디펜스의 가담도·성향 매핑 3종.
 *
 * 셋 다 출하 픽스처에서 **비트 동일**이다. 이유는 노브가 죽어서가 아니라 **픽스처 값이 정확히
 * 중립점**이기 때문이다:
 *  - `commitTempoWeight` 는 `(tempo − 0.5)` 에 곱해지는데 픽스처 tempo 가 **정확히 0.5** 다 → 0 곱.
 *  - `commitLineWeight` 는 `(defensiveLineHeight − 0.5) = 0.05` 라 기여가 미세하고, 인원이
 *    `Math.round` 로 정수화되므로 반올림 경계를 못 넘는다(둘 다 3명).
 *  - `playerOverrideWeight` 는 **순위를 뒤집을 때만** 발화하는데, 픽스처의 CB 는 이미 전진 성향이
 *    낮아 가중치를 키우면 "남는다"가 **더 확실해질 뿐** 순서가 안 바뀐다.
 *
 * 그래서 **조건을 만들어 놓고** 레버성을 확인한다(1대1 계열과 같은 처방). 이건 게임 언어로도
 * 의미가 있다 — 마지막 것은 *"이 센터백은 올라가라"* 라는 프롬프트가 잔류 선정을 실제로 뒤집는가다.
 */
describe("#377 S3-B 조건부 LIVE — 레스트디펜스 가담도·성향 매핑(픽스처 값이 중립점이라 조건을 만든다)", () => {
  const withTeam = (mut: (t: TacticalInput["team"]) => TacticalInput["team"]) => (t: TacticalInput): TacticalInput => ({
    ...t,
    team: mut(t.team),
  });
  const lineHi = withTeam((t) => ({ ...t, defensiveLineHeight: 0.9 }));
  const tempoHi = withTeam((t) => ({ ...t, tempo: 0.9 }));
  /**
   * 수비 4명(슬롯 1~4) 전원에게 높은 전진 성향 = "수비도 다 올라가라".
   *
   * ⚠️ **0.41.0(#407 N4)에서 조건을 강화했다.** 구 시나리오는 센터백 2명(슬롯 2·3)만 0.95 였는데,
   * N4 로 궤적이 옮겨간 뒤 그 시나리오가 3시드에서 **순위를 한 번도 안 뒤집는다**(가중치를
   * 3→20 으로 키워도 전부 bit-identical — 즉 "가중치가 작아서"가 아니라 **비교가 애초에 안 갈리는**
   * 상태다). 4명 전원으로 넓히면 다시 발화한다. 판정 기준("성향이 순서를 뒤집을 수 있을 때
   * 레버인가")은 그대로고 **조건만** 넓혔다 — 계약을 약화시키지 않았다.
   */
  const cbForward = (t: TacticalInput): TacticalInput => ({
    ...t,
    players: t.players.map((p, i) =>
      i >= 1 && i <= 4 ? { ...p, behavior: { ...p.behavior, forwardRunFreq: 0.99 } } : p,
    ),
  });

  it("commitLineWeight 는 레버다 — 라인 지시가 중립이 아니면 잔류 인원이 달라진다", () => {
    expect(hashesWith((c) => { c.movement.restDefence.commitLineWeight = 3; }, lineHi)).not.toEqual(
      hashesWith(() => {}, lineHi),
    );
  }, 120_000);

  it("commitTempoWeight 는 레버다 — 템포가 정확히 0.5 가 아니면 발화한다", () => {
    expect(hashesWith((c) => { c.movement.restDefence.commitTempoWeight = 3; }, tempoHi)).not.toEqual(
      hashesWith(() => {}, tempoHi),
    );
  }, 120_000);

  it("playerOverrideWeight 는 레버다 — 성향이 슬롯 순서를 뒤집을 수 있을 때 발화한다", () => {
    expect(hashesWith((c) => { c.movement.restDefence.playerOverrideWeight = 3; }, cbForward)).not.toEqual(
      hashesWith(() => {}, cbForward),
    );
  }, 120_000);

  it("⚠️ 출하 픽스처에서는 셋 다 비트 동일이다 — 죽은 것이 아니라 **중립점**이라는 기록", () => {
    // 이 단언이 깨지면(달라지면) 픽스처 슬라이더 값이 중립점을 벗어났다는 뜻이다 → 그때 위
    // LIVE 로 올리고 이 블록을 지워라.
    for (const mut of [
      (c: EngineConfig) => { c.movement.restDefence.commitLineWeight = 3; },
      (c: EngineConfig) => { c.movement.restDefence.commitTempoWeight = 3; },
      (c: EngineConfig) => { c.movement.restDefence.playerOverrideWeight = 3; },
    ]) {
      expect(hashes(mut)).toEqual(BASE);
    }
  }, 180_000);
});

/**
 * **조건부 LIVE** — #377 S3-C 오프사이드 트랩(+ 심판 보정 2종).
 *
 * 발화 조건이 **유저 전술 입력**(`team.offsideTrap`)이다. 출하 픽스처는 그 지시가 `false` 이므로
 * (`fixtures.ts` — 하이리스크 전술을 전 벤치마크에 기본 탑재하지 않는다) 이 노브들은 출하값에서
 * **비트 동일**이다. 그건 죽은 것이 아니라 **지시가 없는 것**이고, 둘은 처방이 정반대라 갈라서
 * 박제한다(1대1 계열 · 레스트디펜스 매핑과 같은 처방).
 *
 * ⚠️ **등록 전에 확인했다** — 여섯 노브 전부 트랩을 켠 3시드에서 최종 해시가 움직인다.
 * (`wallClearM` 재발 방지: "참조가 있다"는 통과 기준이 아니고 **"값을 바꾸면 경기가 달라진다"**
 *  가 기준이다 — CLAUDE.md §2.5.)
 */
describe("#377 S3-C 조건부 LIVE — 오프사이드 트랩(지시가 있어야 발화한다)", () => {
  const trapOn = (t: TacticalInput): TacticalInput => ({ ...t, team: { ...t.team, offsideTrap: true } });
  const BASE_TRAP = hashesWith(() => {}, trapOn);

  const knobs: Knob[] = [
    { path: "movement.defLine.trap.enabled", mutate: (c) => { c.movement.defLine.trap.enabled = false; } },
    { path: "movement.defLine.trap.stepUpM", mutate: (c) => { c.movement.defLine.trap.stepUpM = 8; } },
    { path: "movement.defLine.trap.minBallDistM", mutate: (c) => { c.movement.defLine.trap.minBallDistM = 0; } },
    { path: "movement.defLine.trap.shoulderBandM", mutate: (c) => { c.movement.defLine.trap.shoulderBandM = 20; } },
    { path: "movement.defLine.trap.minShoulder", mutate: (c) => { c.movement.defLine.trap.minShoulder = 0; } },
    { path: "movement.defLine.trap.releaseSmooth", mutate: (c) => { c.movement.defLine.trap.releaseSmooth = 0.1; } },
    // 심판 게이트 2종. `trapBiasM` 은 출하 **0**(#377 S3-C — 기하가 물리로 움직이므로 이중 계상
    // 방지) 이지만 **지우지 않는다**: `trap.enabled=false` + 2.5 = 0.39.0 재현 팔이다.
    { path: "rules.offside.trapBiasM", mutate: (c) => { c.rules.offside.trapBiasM = 6; } },
    { path: "rules.offside.trapCallMult", mutate: (c) => { c.rules.offside.trapCallMult = 4; } },
  ];

  for (const k of knobs) {
    it(`조건부 LIVE: ${k.path} 는 트랩 지시가 있으면 레버다`, () => {
      expect(hashesWith(k.mutate, trapOn), `${k.path} 가 트랩 ON 에서도 무효다 — 선언만 남은 노브(#338)`).not.toEqual(BASE_TRAP);
    }, 120_000);
  }

  it("⚠️ 출하 픽스처(트랩 off)에서는 여섯 개 전부 비트 동일이다 — 죽은 것이 아니라 **지시가 없는 것**", () => {
    // 이 단언이 깨지면(달라지면) 트랩 기제가 지시 없이도 발화하기 시작했다는 뜻이다 →
    // 그때는 위 LIVE 로 올리고 이 블록을 지워라. (`trapCallMult` 는 지시 없이도 읽히지 않는다 —
    // `checkOffside` 의 `trap ? … : …` 분기 안이다.)
    for (const k of knobs) {
      if (k.path === "rules.offside.trapBiasM" || k.path === "rules.offside.trapCallMult") continue;
      expect(hashes(k.mutate), `${k.path}`).toEqual(BASE);
    }
  }, 300_000);
});

/**
 * **조건부 LIVE** — #407 N1 슛 거리 감쇠의 형태 노브 4종.
 *
 * 출하 기본이 `chain.shootDistance.enabled=false` 라 이 넷은 출하값에서 **비트 동일**이다.
 * 죽은 것이 아니라 **스위치가 꺼져 있는 것**이고, 둘은 처방이 정반대라 갈라서 박제한다
 * (1대1 계열 · 레스트디펜스 매핑 · 오프사이드 트랩과 같은 처방).
 *
 * ⚠️ **왜 기본이 off 인가**: 감쇠 축은 축 A(거리 분포)를 확실히 개선하지만 축 B(선수 다양성)를
 * 예외 없이 악화시킨다(슛 top1 95.8%→97.3~100% · 1대1 7.17%→0~4.3%, 27지점·20시드 스윕).
 * hero 가 축 B 악화를 하드 제약으로 걸었으므로 켤 수 없다 — 상세 = `config.ts` 주석 ·
 * `issues/2026-08-02-engine-shot-gate-decay.md`.
 *
 * ⚠️ **등록 전에 확인했다** — 넷 전부 감쇠를 켠 3시드에서 최종 해시가 움직인다.
 */
describe("#407 N1 조건부 LIVE — 거리 감쇠 형태 노브(스위치를 켜야 레버다)", () => {
  const on = (c: EngineConfig): void => { c.chain.shootDistance.enabled = true; };
  const BASE_ON = hashes(on);

  const knobs: Knob[] = [
    { path: "chain.shootDistance.genMaxM", mutate: (c) => { on(c); c.chain.shootDistance.genMaxM = 34; } },
    { path: "chain.shootDistance.freeM", mutate: (c) => { on(c); c.chain.shootDistance.freeM = 0; } },
    { path: "chain.shootDistance.perM", mutate: (c) => { on(c); c.chain.shootDistance.perM = 0.02; } },
    { path: "chain.shootDistance.floor", mutate: (c) => { on(c); c.chain.shootDistance.floor = 0.9; } },
  ];

  for (const k of knobs) {
    it(`조건부 LIVE: ${k.path} 는 감쇠를 켜면 레버다`, () => {
      expect(hashes(k.mutate), `${k.path} 가 감쇠 ON 에서도 무효다 — 선언만 남은 노브(#338)`)
        .not.toEqual(BASE_ON);
    }, 120_000);
  }

  it("⚠️ 출하 기본(감쇠 off)에서는 넷 전부 비트 동일이다 — 죽은 것이 아니라 **스위치가 꺼진 것**", () => {
    // 이 단언이 깨지면 감쇠가 스위치 없이 발화하기 시작했다는 뜻이다 → 그때 위 LIVE 로 올린다.
    for (const k of knobs) {
      const off = (c: EngineConfig): void => {
        k.mutate(c);
        c.chain.shootDistance.enabled = false;
      };
      expect(hashes(off), `${k.path}`).toEqual(BASE);
    }
  }, 300_000);
});

/**
 * **조건부 LIVE** — #407 N2 박스 도착런의 형태 노브 **8종**.
 * (초판 주석의 "7종"은 오기였다 — 아래 `knobs` 배열이 여덟이다. #407 독립 검증 blocker-3.)
 *
 * 출하 기본이 `movement.boxArrival.enabled=false` 라 여덟은 출하값에서 **비트 동일**이다.
 * 죽은 것이 아니라 **스위치가 꺼져 있는 것**이고, 둘은 처방이 정반대라 갈라서 박제한다
 * (N1 거리 감쇠 · 1대1 계열 · 레스트디펜스 매핑 · 오프사이드 트랩과 같은 처방).
 *
 * ⚠️ **왜 기본이 off 인가**: 기제는 작동하지만(60시드 비ST 박스수신 0.72→1.04~1.22 ·
 * 박스ST% 86.1→80.4 · HHI 0.904→0.895 를 **팀 폭·스로인 밴드 유지**로 얻는다) **파울이
 * 5.09→4.10~4.70 으로 악화**하고(hero AC 의 하드 제약) 정작 노린 비ST 슛은 평평하다.
 * 상세 = `config.ts` 주석 · `issues/2026-08-03-engine-box-arrival-runs.md`.
 *
 * ⚠️ **등록 전에 확인했다** — 여덟 전부 스위치를 켠 3시드에서 최종 해시가 움직인다.
 */
describe("#407 N2 조건부 LIVE — 박스 도착런 형태 노브(스위치를 켜야 레버다)", () => {
  const on = (c: EngineConfig): void => { c.movement.boxArrival.enabled = true; };
  const BASE_ON = hashes(on);

  const knobs: Knob[] = [
    { path: "movement.boxArrival.maxRunners", mutate: (c) => { on(c); c.movement.boxArrival.maxRunners = 4; } },
    { path: "movement.boxArrival.holdTicks", mutate: (c) => { on(c); c.movement.boxArrival.holdTicks = 1; } },
    { path: "movement.boxArrival.triggerProgress", mutate: (c) => { on(c); c.movement.boxArrival.triggerProgress = 0.5; } },
    { path: "movement.boxArrival.minRunnerProgress", mutate: (c) => { on(c); c.movement.boxArrival.minRunnerProgress = 0.9; } },
    { path: "movement.boxArrival.minBaseLatM", mutate: (c) => { on(c); c.movement.boxArrival.minBaseLatM = 4; } },
    { path: "movement.boxArrival.arrivalDepthM", mutate: (c) => { on(c); c.movement.boxArrival.arrivalDepthM = 2; } },
    { path: "movement.boxArrival.slotSpreadM", mutate: (c) => { on(c); c.movement.boxArrival.slotSpreadM = 20; } },
    { path: "movement.boxArrival.arrivalHalfWidthM", mutate: (c) => { on(c); c.movement.boxArrival.arrivalHalfWidthM = 0; } },
  ];

  for (const k of knobs) {
    it(`조건부 LIVE: ${k.path} 는 도착런을 켜면 레버다`, () => {
      expect(hashes(k.mutate), `${k.path} 가 도착런 ON 에서도 무효다 — 선언만 남은 노브(#338)`)
        .not.toEqual(BASE_ON);
    }, 120_000);
  }

  it("⚠️ 출하 기본(도착런 off)에서는 여덟 전부 비트 동일이다 — 죽은 것이 아니라 **스위치가 꺼진 것**", () => {
    // 이 단언이 깨지면 도착런이 스위치 없이 발화하기 시작했다는 뜻이다 → 그때 위 LIVE 로 올린다.
    for (const k of knobs) {
      const off = (c: EngineConfig): void => {
        k.mutate(c);
        c.movement.boxArrival.enabled = false;
      };
      expect(hashes(off), `${k.path}`).toEqual(BASE);
    }
  }, 600_000);
});

describe("#338 롤백 경로에서는 죽은 노브가 살아난다 (지우면 안 되는 이유)", () => {
  it("weighted 코어로 되돌리면 decisionWeights.shoot 이 다시 레버다", () => {
    const w = (shoot: number): string[] => {
      const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
      c.chain.mode = "weighted";
      c.decisionWeights.shoot = shoot;
      return seeds.map((s) => {
        const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, c);
        return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
      });
    };
    expect(w(0.05)).not.toEqual(w(1.5));
  }, 120_000);
});

/**
 * **노브 신설 게이트** (#377 트랙 D 회고 — main 승인 규칙).
 *
 * 트랙 D 의 blocker 5건 중 **3건**이 "노브를 선언했는데 실제로 아무것도 안 한다" 부류였고,
 * 셋 다 사람이 기억으로 막는 방식이 실패했다. 그래서 기계로 건다.
 *
 * ## 이 스냅샷이 깨졌다면
 * diff 가 **새로 생긴 노브 경로를 그대로 보여준다.** 그때 할 일은 `-u` 로 넘기는 것이 **아니다**:
 *  1. 그 노브를 위 레지스트리에 **분류 등록**한다 — `LIVE`(값을 바꾸면 경기가 달라진다) ·
 *     `INERT`(롤백 자산이라 지금은 무효임을 계약으로 박제) · **조건부 LIVE**(코드는 살아 있는데
 *     상황이 나야 발화 — 그 이유를 주석으로 남긴다).
 *  2. 등록한 판정이 **실제로 참인지** 그 자리에서 확인된다(위 it 들이 해시로 검증한다).
 *  3. 그 다음에 `-u` 로 이 스냅샷을 갱신한다.
 *
 * 노브를 **지운** 경우도 같은 절차다(레지스트리에서 빼고 갱신).
 */
describe("#377 노브 신설 게이트 — 새 EngineConfig 노브는 레지스트리에 등록한다", () => {
  it("EngineConfig 리프 경로 전수를 스냅샷으로 박제한다 (깨지면 위 주석의 3단계를 따라라)", () => {
    expect(knobPaths(defaultEngineConfig)).toMatchSnapshot();
  });

  it("레지스트리에 적힌 경로가 실제 config 에 존재한다 (스테일 등록 방지)", () => {
    const paths = new Set(knobPaths(defaultEngineConfig));
    const registered = [...INERT, ...LIVE].map((k) => k.path);
    const missing = registered.filter((p) => !paths.has(p));
    expect(missing, `config 에 없는 경로가 레지스트리에 남아 있다: ${missing.join(", ")}`).toEqual([]);
  });
});
