import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

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

  it("⚠️ 기본 반경에서는 3시드에 사례가 없다 — #316(1대1 빈도 0.5/경기)의 직접 증거", () => {
    // 이 단언이 **깨지면 좋은 일**이다(#316 이 해소돼 사례가 늘었다는 뜻) → 그때 이 블록을
    // 통째로 LIVE 로 올리고 이 주석을 지워라.
    expect(hashes((c) => { c.contest.oneOnOneXgMult = 1.01; })).toEqual(BASE);
  }, 120_000);
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
