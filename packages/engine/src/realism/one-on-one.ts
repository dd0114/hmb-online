import type { EngineConfig } from "../config";
import type { SimState, SimPlayer } from "../simstate";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { createPitch, attackGoal, type Pitch } from "../pitch";
import { xgAtPoint } from "../decision";
import { fromFixed, fdist, toFixed } from "../fixedmath";
import { setDecisionObserver, type DecisionObserver } from "../action";

/**
 * realism/one-on-one — **1대1(단독) 찬스 진단 계측**(#316 후속).
 *
 * ## 무엇을 가르는가
 * `shot:one_on_one` 이 60시드에 4건(0.067/경기)인데 실축은 경기당 1~2회다. 원인 후보는 둘이고
 * 처방이 정반대라 **먼저 갈라야 한다**:
 *  - ① **상황이 안 생긴다** — 항상 누군가 `oneOnOneClearM` 안에 있다 → 수비 구조 소관.
 *  - ② **상황은 생기는데 라벨이 안 붙는다** — 단독인데 사슬이 carry/pass 를 고른다 → 판정/선택 소관.
 *
 * ## 어떻게 재나 (재계산 금지)
 * 행동을 여기서 다시 계산하면 진단이 구현과 **같은 실수를 공유한다**. 그래서 `match.ts` 의
 * 결정 직후·실행 직전 지점에 걸린 **쓰기 전용 관측자**(`action.ts:setDecisionObserver`)로
 * 엔진이 **실제로 고른 행동**을 읽는다. 기하는 `oneOnOneShot`(decision.ts) 과 **같은 식**이다:
 *  - 사거리: `fromFixed(distToAttackGoal(...)) <= contest.shootRange`
 *  - 단독: 최근접 **비-GK** 상대의 fixed 거리 `> clearM * fixedScale`
 * (임계만 파라미터로 뺐다 — 산술은 복제하되 식이 갈리지 않게 같은 유틸을 쓴다.)
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 에 export 되지 않는다).
 */

/** 엔진이 실제로 실행한 행동(= `Action.kind`). */
export type DecisionKind = "shoot" | "pass" | "dribble" | "clearance" | "hold";

const KINDS: DecisionKind[] = ["shoot", "pass", "dribble", "clearance", "hold"];

export interface KindCounts {
  shoot: number;
  pass: number;
  dribble: number;
  clearance: number;
  hold: number;
}

function zeroKinds(): KindCounts {
  return { shoot: 0, pass: 0, dribble: 0, clearance: 0, hold: 0 };
}

export interface ThresholdBucket {
  /** 임계(m) — 최근접 비-GK 상대가 이 거리보다 멀면 "단독". */
  clearM: number;
  /** 조건 충족 결정 수(사거리 안 + 단독). 데드볼 포함. */
  ticks: number;
  /** 그중 **오픈플레이**(`state.setPiece == null`) — 실축 "단독 찬스"에 해당하는 것. */
  openTicks: number;
  inBox: number;
  outBox: number;
  byKind: KindCounts;
  /** 오픈플레이 조건충족 틱의 행동 분포. */
  byKindOpen: KindCounts;
  /** 박스 안에서의 행동 분포(박스 안/밖 분리 판단용). */
  byKindInBox: KindCounts;
  /**
   * **찬스 에피소드** 수 — 같은 소유자가 연속 결정 틱에서 조건을 유지하면 1회로 센다.
   * 틱 카운트는 한 장면을 여러 번 세므로 "경기당 1~2회"와 직접 비교할 수 없다.
   */
  openEpisodes: number;
  /** 그중 슛으로 끝난(= 안에서 한 번이라도 shoot 를 고른) 에피소드. */
  openEpisodesWithShot: number;
  /**
   * 조건충족 틱 중 **슛 후보가 생성되기라도 한** 틱 수 — `chain.ts:GEN_FN.shoot` 의 게이트
   * (`xgHere >= contest.shootXgThreshold`)를 통과한 수. ②를 다시 둘로 가른다:
   * ②a **생성 자체가 없다**(게이트) vs ②b **생성됐는데 EV 에서 졌다**.
   */
  shootGenerated: number;
  /** 슛 후보가 생성된 틱에서의 행동 분포. */
  byKindGenerated: KindCounts;
  /** 조건충족 틱의 xG 합(평균 계산용). */
  xgSum: number;
  /** 조건충족 틱의 골까지 거리 합(m, 평균 계산용). */
  distSum: number;
}

export interface OneOnOneReport {
  configVersion: string;
  mode: string;
  matches: number;
  /** 볼 소유자 결정 총 수(관측자 호출 수). */
  decisions: number;
  /** 그중 데드볼(세트피스 미실행) 상태의 결정 — 오픈플레이 분모에서 빼야 한다. */
  deadBallDecisions: number;
  /** 그중 슛 사거리 안(= 1대1 판정의 전제 조건 ①). */
  inRange: number;
  /** 사거리 안 & 오픈플레이. */
  inRangeOpen: number;
  /** 사거리 안 결정의 행동 분포(단독 여부 무관 — 대조 기준선). */
  inRangeByKind: KindCounts;
  /** 사거리 안 & 오픈플레이 행동 분포. */
  inRangeOpenByKind: KindCounts;
  buckets: ThresholdBucket[];
  /** 실제 발행된 `shot` 이벤트(결과 마커 제외) 수. */
  shotEvents: number;
  /** 실제 발행된 `shot:one_on_one` 이벤트 수(= 라벨). */
  oneOnOneEvents: number;
  /** 사거리 안 결정에서 최근접 비-GK 상대 거리(m) 히스토그램: 0-1,1-2,...,14-15,15+ */
  nearHist: number[];
  /** 사거리 안 결정의 최근접 비-GK 상대 거리 분위수(m). */
  nearP: { p50: number; p75: number; p90: number; p95: number; p99: number; max: number };
}

/** 소유자가 **상대 페널티박스** 안인가(파울 판정과 같은 기하: `contest.victimInAttackBox`). */
function inAttackBox(pitch: Pitch, config: EngineConfig, p: SimPlayer): boolean {
  const g = attackGoal(pitch, p.side);
  const scale = config.fixedScale;
  const depth = toFixed(config.rules.penalty.boxDepthM, scale);
  const halfW = toFixed(config.rules.penalty.boxHalfWidthM, scale);
  return Math.abs(p.posFx.x - g.x) <= depth && Math.abs(p.posFx.y - g.y) <= halfW;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i]!;
}

/**
 * 시드 목록으로 경기를 돌려 1대1 조건·행동 분포를 모은다.
 * `thresholds` 는 "최근접 비-GK 상대가 몇 m 밖이면 단독인가"의 후보(m).
 */
export function collectOneOnOne(
  config: EngineConfig,
  seeds: string[],
  thresholds: number[] = [10, 8, 7, 5],
): OneOnOneReport {
  const pitch = createPitch(config);
  const select = makeSelectData();
  const scale = config.fixedScale;

  const buckets: ThresholdBucket[] = thresholds.map((m) => ({
    clearM: m,
    ticks: 0,
    openTicks: 0,
    inBox: 0,
    outBox: 0,
    byKind: zeroKinds(),
    byKindOpen: zeroKinds(),
    byKindInBox: zeroKinds(),
    openEpisodes: 0,
    openEpisodesWithShot: 0,
    shootGenerated: 0,
    byKindGenerated: zeroKinds(),
    xgSum: 0,
    distSum: 0,
  }));
  /** 에피소드 추적 상태(버킷별): 마지막 조건충족 오픈플레이 결정의 (틱, 소유자). */
  const epi = buckets.map(() => ({ lastTick: -99, lastOwner: "", shotInEpisode: false }));
  const inRangeByKind = zeroKinds();
  const inRangeOpenByKind = zeroKinds();
  const nearHist = new Array<number>(16).fill(0);
  const nearSamples: number[] = [];
  let decisions = 0;
  let deadBallDecisions = 0;
  let inRange = 0;
  let inRangeOpen = 0;

  const observer: DecisionObserver = (s, owner, kind) => {
    const state = s as SimState;
    decisions += 1;
    // 데드볼(아직 안 찬 세트피스) — 프리킥/PK 는 규칙상 수비가 9.15m 밖에 서므로 기하가
    // **자동으로** 성립한다. 실축의 "단독 찬스"가 아니므로 오픈플레이와 분리해서 센다.
    const dead = state.setPiece != null;
    if (dead) deadBallDecisions += 1;
    // 사거리 + xG — 엔진과 **같은 함수**(`xgAtPoint`)로 잰다(재구현 금지).
    const { xg: xgHere, distM } = xgAtPoint(
      owner.side, owner.posFx.x, owner.posFx.y, owner.attrs.shooting, owner.fatigue, config, pitch,
    );
    // 이 진단의 표본 정의 = **1대1 부스트 자격 거리**(`decision.oneOnOneShot` 이 쓰는 그 자)다.
    // ⚠️ #407 N1(0.41.0) 이후로는 `chain.ts:GEN_FN.shoot` 의 **생성** 거리 게이트와 더 이상 같지
    // 않다 — 그쪽은 `chain.shootDistance` 를 켜면 `genMaxM` 까지 넓어진다. 여기 자를 따라 넓히지
    // 말 것: 이 파일이 재는 것은 "슛 사거리 안 결정 중 hold 비율"이 아니라 **1대1 찬스**이고,
    // 그 자격이 `contest.shootRange` 이기 때문이다(`oneOnOneShot` 의 조건과 하나로 유지).
    if (distM > config.contest.shootRange) return;
    // xG 질 게이트는 N1 이후에도 `GEN_FN.shoot` 에 그대로 남아 있다 — 여기와 **같은 식**이다.
    const shootGen = xgHere >= config.contest.shootXgThreshold;
    inRange += 1;
    const k = kind as DecisionKind;
    if (KINDS.includes(k)) inRangeByKind[k] += 1;
    if (!dead) {
      inRangeOpen += 1;
      if (KINDS.includes(k)) inRangeOpenByKind[k] += 1;
    }

    // 최근접 비-GK 상대 — `oneOnOneShot` 과 같은 루프(fixed 비교).
    let nearFx = Infinity;
    for (const p of state.players) {
      if (p.side === owner.side || p.isGK) continue;
      const d = fdist(owner.posFx.x, owner.posFx.y, p.posFx.x, p.posFx.y);
      if (d < nearFx) nearFx = d;
    }
    const nearM = nearFx === Infinity ? 999 : fromFixed(nearFx, scale);
    nearSamples.push(nearM);
    const hb = Math.min(15, Math.max(0, Math.floor(nearM)));
    nearHist[hb] = (nearHist[hb] ?? 0) + 1;

    const box = inAttackBox(pitch, config, owner);
    const ownerKey = `${owner.side}:${owner.id}`;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      if (!(nearFx > b.clearM * scale)) continue;
      b.ticks += 1;
      b.xgSum += xgHere;
      b.distSum += distM;
      if (box) b.inBox += 1;
      else b.outBox += 1;
      if (shootGen) b.shootGenerated += 1;
      if (KINDS.includes(k)) {
        b.byKind[k] += 1;
        if (box) b.byKindInBox[k] += 1;
        if (shootGen) b.byKindGenerated[k] += 1;
      }
      if (dead) continue;
      b.openTicks += 1;
      if (KINDS.includes(k)) b.byKindOpen[k] += 1;
      // 에피소드 = 같은 소유자가 **연속 결정 틱**(gap ≤ 1)에서 조건을 유지하는 구간.
      const e = epi[i]!;
      const contiguous = state.tick - e.lastTick <= 1 && e.lastOwner === ownerKey;
      if (!contiguous) {
        b.openEpisodes += 1;
        e.shotInEpisode = false;
      }
      if (k === "shoot" && !e.shotInEpisode) {
        b.openEpisodesWithShot += 1;
        e.shotInEpisode = true;
      }
      e.lastTick = state.tick;
      e.lastOwner = ownerKey;
    }
  };

  let shotEvents = 0;
  let oneOnOneEvents = 0;
  setDecisionObserver(observer);
  try {
    for (const seed of seeds) {
      // 경기 경계에서 에피소드가 이어지지 않게 초기화(틱이 0 으로 되감긴다).
      for (const e of epi) {
        e.lastTick = -99;
        e.lastOwner = "";
        e.shotInEpisode = false;
      }
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
      for (const e of log.events) {
        if (e.type !== "shot") continue;
        if (e.detail === "saved" || e.detail === "off_target") continue;
        shotEvents += 1;
        if (e.detail === "one_on_one") oneOnOneEvents += 1;
      }
    }
  } finally {
    // 예외가 나도 반드시 끈다 — 켜진 채 남으면 다른 테스트가 이 클로저를 계속 호출한다.
    setDecisionObserver(null);
  }

  const sorted = [...nearSamples].sort((a, b) => a - b);
  return {
    configVersion: config.version,
    mode: config.chain.mode,
    matches: seeds.length,
    decisions,
    deadBallDecisions,
    inRange,
    inRangeOpen,
    inRangeByKind,
    inRangeOpenByKind,
    buckets,
    shotEvents,
    oneOnOneEvents,
    nearHist,
    nearP: {
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      max: sorted.length ? sorted[sorted.length - 1]! : 0,
    },
  };
}

function pct(n: number, d: number): string {
  if (d <= 0) return "0";
  return (Math.round((1000 * n) / d) / 10).toString();
}
function f(v: number, d = 2): string {
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
}

export function renderOneOnOne(r: OneOnOneReport): string {
  const L: string[] = [];
  const M = r.matches;
  L.push(`=== 1v1 PROBE (${r.configVersion}, mode=${r.mode}, ${M} seeds) ===`);
  L.push(
    `결정 ${r.decisions} (${f(r.decisions / M, 1)}/경기) · 그중 데드볼 ${r.deadBallDecisions} (${pct(r.deadBallDecisions, r.decisions)}%)`,
  );
  L.push(
    `사거리안 ${r.inRange} (${f(r.inRange / M, 1)}/경기, ${pct(r.inRange, r.decisions)}%) · 오픈플레이만 ${r.inRangeOpen} (${f(r.inRangeOpen / M, 1)}/경기)`,
  );
  L.push(
    `사거리안 행동(전체): shoot ${pct(r.inRangeByKind.shoot, r.inRange)}% · pass ${pct(r.inRangeByKind.pass, r.inRange)}% · ` +
      `carry ${pct(r.inRangeByKind.dribble, r.inRange)}% · clear ${pct(r.inRangeByKind.clearance, r.inRange)}% · hold ${pct(r.inRangeByKind.hold, r.inRange)}%`,
  );
  L.push(
    `사거리안 행동(오픈): shoot ${pct(r.inRangeOpenByKind.shoot, r.inRangeOpen)}% · pass ${pct(r.inRangeOpenByKind.pass, r.inRangeOpen)}% · ` +
      `carry ${pct(r.inRangeOpenByKind.dribble, r.inRangeOpen)}% · clear ${pct(r.inRangeOpenByKind.clearance, r.inRangeOpen)}% · hold ${pct(r.inRangeOpenByKind.hold, r.inRangeOpen)}%`,
  );
  L.push(`shot 이벤트 ${r.shotEvents} (${f(r.shotEvents / M, 2)}/경기) · **one_on_one 라벨 ${r.oneOnOneEvents} (${f(r.oneOnOneEvents / M, 3)}/경기)**`);
  L.push("");
  L.push(`[A] 조건충족 틱(데드볼 포함/오픈) · 박스 분리`);
  L.push(`| clearM | 충족틱 | /경기 | 오픈틱 | 오픈/경기 | 박스안 | 박스밖 |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const b of r.buckets) {
    L.push(
      `| ${b.clearM}m | ${b.ticks} | ${f(b.ticks / M, 2)} | ${b.openTicks} | ${f(b.openTicks / M, 2)} | ` +
        `${b.inBox} (${pct(b.inBox, b.ticks)}%) | ${b.outBox} (${pct(b.outBox, b.ticks)}%) |`,
    );
  }
  L.push("");
  L.push(`[B] **찬스 에피소드**(연속 틱 = 1회, 오픈플레이만) — "경기당 1~2회"와 직접 비교할 값`);
  L.push(`| clearM | 에피소드 | /경기 | 슛으로 이어진 에피소드 | 슛 전환율 |`);
  L.push(`|---|---|---|---|---|`);
  for (const b of r.buckets) {
    L.push(
      `| ${b.clearM}m | ${b.openEpisodes} | ${f(b.openEpisodes / M, 2)} | ${b.openEpisodesWithShot} | ${pct(b.openEpisodesWithShot, b.openEpisodes)}% |`,
    );
  }
  L.push("");
  L.push(`[C] 조건충족 틱의 행동 분포(전체 / 오픈)`);
  L.push(`| clearM | shoot | pass | carry | clear | hold |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const b of r.buckets) {
    L.push(
      `| ${b.clearM}m 전체 | ${b.byKind.shoot} (${pct(b.byKind.shoot, b.ticks)}%) | ${b.byKind.pass} (${pct(b.byKind.pass, b.ticks)}%) | ` +
        `${b.byKind.dribble} (${pct(b.byKind.dribble, b.ticks)}%) | ${b.byKind.clearance} (${pct(b.byKind.clearance, b.ticks)}%) | ` +
        `${b.byKind.hold} (${pct(b.byKind.hold, b.ticks)}%) |`,
    );
    L.push(
      `| ${b.clearM}m 오픈 | ${b.byKindOpen.shoot} (${pct(b.byKindOpen.shoot, b.openTicks)}%) | ${b.byKindOpen.pass} (${pct(b.byKindOpen.pass, b.openTicks)}%) | ` +
        `${b.byKindOpen.dribble} (${pct(b.byKindOpen.dribble, b.openTicks)}%) | ${b.byKindOpen.clearance} (${pct(b.byKindOpen.clearance, b.openTicks)}%) | ` +
        `${b.byKindOpen.hold} (${pct(b.byKindOpen.hold, b.openTicks)}%) |`,
    );
  }
  L.push("");
  L.push(`[D] ②a/②b 가르기 — 슛 후보가 **생성되기라도 했나**(gate: xgHere >= contest.shootXgThreshold)`);
  L.push(`| clearM | 충족틱 | 슛후보 생성 | 생성률 | 생성틱 중 shoot | 생성틱 중 carry | 생성틱 중 hold | 평균 xG | 평균 골거리 |`);
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const b of r.buckets) {
    L.push(
      `| ${b.clearM}m | ${b.ticks} | ${b.shootGenerated} | ${pct(b.shootGenerated, b.ticks)}% | ` +
        `${b.byKindGenerated.shoot} (${pct(b.byKindGenerated.shoot, b.shootGenerated)}%) | ` +
        `${b.byKindGenerated.dribble} (${pct(b.byKindGenerated.dribble, b.shootGenerated)}%) | ` +
        `${b.byKindGenerated.hold} (${pct(b.byKindGenerated.hold, b.shootGenerated)}%) | ` +
        `${f(b.xgSum / Math.max(1, b.ticks), 3)} | ${f(b.distSum / Math.max(1, b.ticks), 1)}m |`,
    );
  }
  L.push("");
  L.push(`박스 안에서의 행동(조건충족 틱 중):`);
  for (const b of r.buckets) {
    L.push(
      `  ${b.clearM}m 박스안 n=${b.inBox} → shoot ${pct(b.byKindInBox.shoot, b.inBox)}% · pass ${pct(b.byKindInBox.pass, b.inBox)}% · ` +
        `carry ${pct(b.byKindInBox.dribble, b.inBox)}% · clear ${pct(b.byKindInBox.clearance, b.inBox)}% · hold ${pct(b.byKindInBox.hold, b.inBox)}%`,
    );
  }
  L.push("");
  L.push(
    `최근접 비-GK 상대 거리(사거리안 n=${r.inRange}) p50 ${f(r.nearP.p50)} · p75 ${f(r.nearP.p75)} · ` +
      `p90 ${f(r.nearP.p90)} · p95 ${f(r.nearP.p95)} · p99 ${f(r.nearP.p99)} · max ${f(r.nearP.max)} m`,
  );
  L.push(`히스토그램(m): ${r.nearHist.map((n, i) => `${i}${i === 15 ? "+" : ""}:${n}`).join(" ")}`);
  return L.join("\n");
}
