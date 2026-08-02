/**
 * player-stats — **선수별** 경기 기록 집계(데이터 계층 전용, #403 W1).
 *
 * 스펙 SoT = `docs/plan-v5/player-stats.md` §2(지표 선정 T1/T2) · §3(아키텍처 결정).
 * 이 파일은 화면을 모른다 — React·DOM·API 의존 0. UI(패널·모달)는 W2 이후가 소비한다.
 *
 * ## 왜 새 파일인가
 * 기존 집계는 전부 **팀 축**이다(`viewer-core/stats` · `match-stats.ts` · `match-logic.deriveTeamStats`).
 * 여기는 사본이 아니라 **새 축(선수)** 이고, 팀 합계는 절대 다시 계산하지 않는다 —
 * 계약(`player-stats.test.ts`)이 `liveEventStats`(팀) 와 선수 합계를 교차검증한다.
 * 선수 합 ≠ 팀 합이 되는 순간 화면이 신뢰를 잃는다.
 *
 * ## 키는 반드시 `(team, playerId)` 다
 * 유저 덱과 봇 로스터가 같은 선수 카탈로그를 공유해서 **같은 `playerId` 가 양 팀에 동시에 뛴다**
 * (라이브 하프의 상당수 — 엔진 #231, viewer-core `owner-side.mjs` 주석). `playerId` 단독으로 잡으면
 * 두 인스턴스가 한 버킷에 합쳐져 주행거리가 두 사람 사이를 오간다(엔진 실측 63km/경기).
 *
 * ## 라이브 컷(`uptoTick`) 은 `liveEventStats` 와 **같은 축**이다
 * 이벤트·스냅샷 둘 다 `tick <= uptoTick` 만 본다(= `viewer-core` 의 `e.tick > upto` 컷과 동일).
 * 재생 위치를 넘는 기록을 보이면 스포일러다(#233/#238).
 *
 * ## 하프가 둘이면 하프별로 돌리고 합친다
 * 하프 로그는 각각 자기 틱 번호를 갖는다 → `computePlayerStats` 는 **하프 하나**를 받고,
 * `combinePlayerStats` 가 합산한다. ⚠️ 합산은 **시도/성공의 합에서 비율을 다시 계산**한다
 * (비율의 평균은 틀린 수다). 평점·MOTM 도 합산 후 **다시** 산출한다.
 */
import { computeCumulativePossession } from "@hmb/viewer-core";

// ── 입력 형상(구조적 타입) ────────────────────────────────────────────────
// web 은 Java API 만 안다(PRD §1) — `@hmb/shared` 의 zod 타입을 값으로 끌어오지 않고
// `match-logic.ts` 와 같은 규율로 필요한 최소 형상만 로컬 선언한다.

export type TeamSide = "home" | "away";

export interface StatEvent {
  tick: number;
  minute?: number;
  type: string;
  team?: string;
  playerId?: string;
  xg?: number;
  detail?: string;
}

export interface StatPlayerSnapshot {
  playerId: string;
  team?: string;
  pos: { x: number; y: number };
}

export interface StatSnapshot {
  tick: number;
  minute?: number;
  ball: { x: number; y: number };
  ballOwner?: string | null;
  players: readonly StatPlayerSnapshot[];
}

export interface StatMatchLog {
  tickSnapshots?: readonly StatSnapshot[];
  events?: readonly StatEvent[];
}

export type PlayerPosition = "GK" | "DF" | "MF" | "FW";

export interface PlayerStatsOptions {
  /** 이 틱까지만 집계(포함). 생략하면 전량. 라이브 재생 위치 = 스포일러 상한. */
  uptoTick?: number;
  /**
   * 골키퍼 키 집합 — 원소는 **`playerKey(team, playerId)`**(`"home:P7"`), 맨 id 가 아니다.
   *
   * ⚠️ 맨 id 로 받으면 이 파일이 세운 규율을 옵션이 뚫는다: 같은 선수가 양 팀에 뛰는 하프
   * (#231, 라이브에서 흔하다)에서 `{"P7"}` 하나가 **양쪽 P7 을 모두 GK 로** 만든다.
   * 편의 헬퍼 = `playerKeySet([["home","P7"], ...])`.
   */
  gkKeys?: ReadonlySet<string>;
  /** `playerKey(team, playerId)` → 포지션. 평점의 희소성 보정에만 쓴다(없으면 보정 없음). */
  positions?: Readonly<Record<string, PlayerPosition>>;
  /** 피치 실치수(m). 히트맵 빈·전진거리 기준. */
  pitch?: { lengthM: number; widthM: number };
  /** 히트맵 격자. */
  heatBins?: { cols: number; rows: number };
}

// ── 산출 형상 ────────────────────────────────────────────────────────────

export interface PlayerStatLine {
  key: string;
  team: TeamSide;
  playerId: string;

  // ── T1: 이벤트가 `playerId` 를 직접 실어 주는 지표 (팀 합계와 정확히 일치해야 한다) ──
  goals: number;
  shots: number;
  shotsOnTarget: number;
  shotsOffTarget: number;
  xg: number;
  tackles: number;
  interceptions: number;
  /** 걷어내기(#314). 엔진이 경기당 수십 건 쏘는데 종전 집계기는 **어느 것도 세지 않았다**. */
  clearances: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  /** 경고 누적 퇴장 — 엔진이 같은 틱에 `yellow` 와 `red` 를 **둘 다** 쏜다. */
  secondYellow: boolean;
  sentOff: boolean;
  offsides: number;
  /** GK 선방. */
  saves: number;
  /** GK 가 피치 위에 있는 동안 팀이 먹은 골(`gkKeys` 를 줘야 채워진다). */
  goalsConceded: number;

  // ── T2: 소유 체인 재구성으로 나오는 지표 (아래 §소유 체인 참조) ──
  passesAttempted: number;
  passesCompleted: number;
  longPasses: number;
  longPassesCompleted: number;
  /** 리시버가 그 소유 구간에서 슛한 패스(어시스트 포함). */
  keyPasses: number;
  assists: number;
  /** 소유 구간 진입 횟수. */
  touches: number;
  /** 공을 몰고 간 소유 구간 수(`CARRY_MIN_M` 이상 이동). */
  carries: number;
  /** 캐리 구간에서 공이 실제로 지나간 거리(m). */
  carryDistanceM: number;
  /** 캐리 구간의 **상대 골 방향** 순전진(m, 음수는 0). */
  carryProgressM: number;
  /** 상대 태클로 공을 뺏긴 횟수(패스 차단은 여기 포함하지 않는다 — 그건 실패 패스다). */
  dispossessed: number;
  /** 뛴 거리(m). */
  distanceM: number;
  /** 등장한 스냅샷 수(퇴장 선수는 이후 스냅샷에서 사라진다). */
  ticksPlayed: number;
  /** 등장한 **분**의 수. 로그가 구운 `minute` 축을 쓴다 — `floor(tick/60)` 금지(#388). */
  minutesPlayed: number;
  /** 히트맵 빈(길이 = cols × rows, row-major, x=길이축·y=폭축). */
  heat: number[];

  /** 기본점(`RATING_WEIGHTS.base`) 기준 가감. 소수 1자리. */
  rating: number;
}

/**
 * 귀속에 실패한 이벤트의 잔차. **0 이 아닐 수 있고, 그걸 숨기지 않는다** —
 * 선수 합 + 잔차 = 팀 합이 항상 성립해야 교차검증이 의미를 갖는다.
 */
export interface UnattributedCounts {
  /** `pass` 이벤트인데 직전 소유자를 못 찾음(= 패서 미상). */
  passesCompleted: number;
  /** 실패 패스(가로챔·아웃)인데 직전 소유자를 못 찾음. */
  passesAttempted: number;
  /** `playerId` 가 비어 있어 선수에게 못 붙인 T1 이벤트 수(타입별). */
  events: Record<string, number>;
}

export interface Motm {
  key: string;
  team: TeamSide;
  playerId: string;
  rating: number;
}

export interface PlayerStatsResult {
  /** `(team, playerId)` 오름차순 — 결정론적. */
  players: PlayerStatLine[];
  motm: Motm | null;
  unattributed: UnattributedCounts;
  heatBins: { cols: number; rows: number };
  /** 이 결과에 적용된 컷(없으면 null). 합산 결과는 항상 null. */
  uptoTick: number | null;
  /** 집계에 쓰인 스냅샷 수. */
  ticks: number;
}

// ── 튜닝 상수 ────────────────────────────────────────────────────────────

/** 소유 구간에서 공이 이 거리 이상 움직였으면 "몰고 갔다"(캐리)로 센다. */
export const CARRY_MIN_M = 3;

const DEFAULT_PITCH = { lengthM: 105, widthM: 68 } as const;
const DEFAULT_HEAT_BINS = { cols: 12, rows: 8 } as const;

/**
 * 평점 계수 — **여기 한 곳**이 게임의 가치판단이다. 화면·다른 모듈에 숫자를 흩뿌리지 마라.
 * hero 가 이 표를 보고 조정한다.
 *
 * 구조: `base ± (공격항 × 포지션공격배수) ± (수비항 × 포지션수비배수) ± 키퍼항 ± 규율항`.
 *
 * ⚠️ **계수는 실축 통계가 아니라 이 엔진의 볼륨에 맞춰 사이징한다.** 실축 계수를 그대로 걸었더니
 * 수비 볼륨만으로 상한 10.0 에 붙는 무득점 MOTM 이 나왔다(#403 독립 검증 m4). 그룹별 실제
 * 기록량과 그 결과 분포는 `apps/web/scripts/rating-distribution.ts --volumes` 로 언제든 다시 잰다.
 *
 * ## ⚠️ 계수를 조정하면 **두 모드를 다 봐라** — 그룹 순서가 서로 뒤집힌다
 *
 * `--real-decks`(라이브 입력 10조합) 와 기본 픽스처 모드는 **결론이 다르다**. 픽스처는
 * `makeTacticalInput` 이 시드마다 `seed` 필드만 바꿔서 사실상 **한 매치업의 RNG 반복**이고,
 * 실덱은 4-4-2·5-3-2·로우블록까지 **입력 분포 자체**가 다르다(#374 가 엔진에서 세운 교훈).
 *
 * | | 픽스처 100시드 | 실덱 10덱×5시드 |
 * |---|---|---|
 * | GK / DF / MF / FW 중앙값 | 7.30 / 7.50 / **7.80** / 7.30 | 7.05 / 7.20 / 7.10 / **7.70** |
 * | 최고 그룹 | **MF** | **FW** ← 뒤집힌다 |
 * | 그룹 spread | 0.50 | 0.65 (최악 덱 1.70) |
 * | FW 상한포화 | 4.7% | 6.5% |
 * | FW MOTM | 55% | 48% |
 *
 * 독립 검증 실측(별도 시드 파생, before → after): pooled spread **1.80 → 0.70** ·
 * FW 포화 **17.7% → 5.1%** · MOTM FW/DF/GK **78%/0%/0% → 50%/12%/10%** ·
 * 최악 덱 spread **3.15 → 1.55**. **10개 덱 전부 개선** = 방향은 일반화된다.
 * 다만 `deck-03` 은 GK 6.15 vs DF 7.10 으로 **여전히 벌어져 있다**(조정 포인트).
 */
export interface RatingWeights {
  base: number;
  min: number;
  max: number;
  attack: {
    goal: number;
    assist: number;
    keyPass: number;
    shotOnTarget: number;
    shot: number;
    passCompleted: number;
    passFailed: number;
    longPassCompleted: number;
    carry: number;
    carryProgressPer10m: number;
  };
  defence: { tackle: number; interception: number; clearance: number };
  /**
   * 골키퍼 축 — **선방률**이 주축이다(hero 확정 ③). 종전엔 `save +0.30` 과
   * `goalConceded −0.30` 이 정확히 상쇄돼 6실점 6선방 GK 가 기본점과 같았다
   * (= GK 평점이 일한 양과 무관한 상수였다).
   */
  keeper: {
    /** 기준 선방률. 이 값보다 잘 막으면 +, 못 막으면 −. 리얼 config 실측 기반. */
    expectedSaveRate: number;
    /**
     * 소표본 수축(베이지안 셋업) — "평균적인 유효슛"을 이만큼 미리 깔고 비율을 낸다.
     * 없으면 유효슛 2개짜리 하프에서 선방률이 0%/100% 로 튀어 GK 분산이 필드의 몇 배가 된다.
     */
    priorFaced: number;
    /** 선방률 편차 1.0(=100%p) 당 평점. */
    saveRateScale: number;
    /** 선방 1회당 — "일한 양"에 주는 소액. 비율이 같아도 바쁜 키퍼를 조금 더 쳐준다. */
    saveVolume: number;
    /** 실점 잔여 감점. **주축은 선방률**이라 여긴 작게(같은 정보를 두 번 세지 않는다). */
    goalConceded: number;
  };
  discipline: { dispossessed: number; foul: number; yellow: number; red: number };
  position: Record<PlayerPosition | "UNKNOWN", { attack: number; defence: number }>;
}

/** 깊은 readonly. `RATING_WEIGHTS` 를 런타임에 못 바꾸게 한다(아래 주석 참조). */
type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };

/**
 * 중첩 객체까지 `Object.freeze`.
 *
 * ⚠️ **타입만으로는 못 막는다** — 한때 이 자리엔 `DeepReadonly` 만 있고 주석은 "런타임에 못
 * 바꾼다"고 적혀 있었는데, 실제로는 **한 줄로 우회되고 tsc 는 0 에러**였다(#403 통합 검증 minor-2):
 * ```ts
 * const alias: RatingWeights = RATING_WEIGHTS; // readonly→mutable 대입은 TS 가 안 본다
 * alias.base = 3.0;                            // 앱 전역 평점이 바뀐다
 * ```
 * 주장을 낮추는 대신 **주장이 참이 되게** 잠근다(엄격 모드에서 대입은 TypeError).
 */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * ⚠️ **깊게 얼려 둔다(`Object.freeze` + `DeepReadonly`).** 이 상수는 앱 전체 평점의 단일 출처라,
 * 가변이면 어떤 소비자든 `RATING_WEIGHTS.base = 3` 한 줄로 전 화면의 평점을 조용히 바꿀 수 있다.
 * 계수를 갈아끼워야 하는 정당한 용도(분포 하네스의 스윕)는 **`ratingWithWeights` 가
 * 이미 제공**하므로 — 표를 주입받는 산식 — 이 상수까지 가변일 이유가 없다.
 * 계약 = `player-stats.test.ts` "`RATING_WEIGHTS` 는 런타임에도 못 바꾼다".
 */
export const RATING_WEIGHTS: DeepReadonly<RatingWeights> = deepFreeze({
  /** 무관여 기본점(hero 확정 ②) — "잘하면 오르고 못하면 깎인다". */
  base: 6.5,
  min: 3.0,
  max: 10.0,
  attack: {
    /** 골(hero 확정 ①: 유지). */
    goal: 1.0,
    /**
     * ⚠️ **어시스트의 실효 가치는 `assist + keyPass` 다** — `keyPasses` 는 어시스트를
     * **포함**하므로(위 `PlayerStatLine.keyPasses` 정의) 어시스트 1개는 두 항에 모두 걸린다.
     * 지금 값의 실효치 = 0.75 + 0.11 = **0.86**(골 1.0 의 86%). 이 값을 조정할 때는
     * 반드시 합으로 보고 골과 견줘라 — `assist` 만 보면 실제보다 낮게 읽는다.
     */
    assist: 0.75,
    /** 리시버가 그 소유 구간에서 슛한 패스(**어시스트 포함**) — MF 3.4/경기, FW 2.0/경기. */
    keyPass: 0.11,
    shotOnTarget: 0.05,
    shot: 0.01,
    /** 전개 — 볼륨이 커서(MF 28.5/경기) 단가는 작아야 한다. */
    passCompleted: 0.01,
    passFailed: -0.014,
    /** 롱패스 성공 — GK 5.5·DF 2.5/경기라 후방 전개의 주 보상이다. */
    longPassCompleted: 0.035,
    carry: 0.004,
    /** 캐리 전진 10m 당. FW 가 경기당 75m 를 몰고 가 단가가 작아야 한다. */
    carryProgressPer10m: 0.002,
  },
  defence: {
    tackle: 0.22,
    interception: 0.13,
    clearance: 0.12,
  },
  keeper: {
    expectedSaveRate: 0.5,
    priorFaced: 4,
    saveRateScale: 5.5,
    saveVolume: 0.14,
    goalConceded: -0.04,
  },
  discipline: {
    dispossessed: -0.08,
    foul: -0.05,
    /** 경고 누적 퇴장은 옐로 1장 + 레드 1장이지만 **감점은 레드 한 번만** 먹는다. */
    yellow: -0.25,
    red: -0.9,
  },
  /**
   * 포지션 보정 — ⚠️ **레벨링의 대부분을 여기가 한다.** 단가 사이징이 아니다.
   *
   * 아블레이션(배수를 전부 1.0 으로, 리얼 config 100시드):
   *   그룹 중앙값 spread **0.50 → 0.90** · FW 상한포화 **4.7% → 21.2%** ·
   *   FW MOTM 점유 **55.0% → 95.0%**.
   * 즉 위의 단가(골·태클·패스…)만으로는 포지션 균형이 서지 **않고**, 이 표가 그걸 세운다.
   * 계수를 조정할 때 단가만 만지면 분포가 잘 안 움직이는 이유가 이것이다.
   *
   * 이름은 "희소성 보정"이지만 실제로는 두 가지가 섞여 있고, **섞여 있다는 것을 알고 써야 한다**:
   *  - 희소성: `DF.attack 1.6`(수비수의 골은 드무니 더) · `FW.defence 1.4`(공격수의 볼뺏기는 드무니 더)
   *  - **균일 축소**: `MF 0.85/0.85` 는 공·수가 **같은 값**이라 희소성이 아니다 —
   *    미드필더는 패스·인터셉트 볼륨이 구조적으로 커서 그룹 중앙값을 그냥 끌어내린 것이다.
   *    `FW.attack 0.58` 도 절반은 같은 성격(골 폭발을 상한 안에 눌러 담기).
   *
   * 실측 = `apps/web/scripts/rating-distribution.ts`(픽스처) · `--real-decks`(라이브 입력).
   */
  position: {
    GK: { attack: 1.8, defence: 1.3 },
    DF: { attack: 1.6, defence: 1.1 },
    MF: { attack: 0.85, defence: 0.85 },
    FW: { attack: 0.58, defence: 1.4 },
    UNKNOWN: { attack: 1.0, defence: 1.0 },
  },
});

// ── 유틸 ─────────────────────────────────────────────────────────────────

export function playerKey(team: TeamSide, playerId: string): string {
  return `${team}:${playerId}`;
}

/**
 * `(team, playerId)` 쌍들로 옵션용 키 집합을 만든다 — 호출부가 `"home:" + id` 를 손으로
 * 조립하지 않게. 문자열 조립이 호출부에 흩어지면 거기서 규율이 깨진다.
 */
export function playerKeySet(entries: Iterable<readonly [TeamSide, string]>): Set<string> {
  const out = new Set<string>();
  for (const [team, id] of entries) out.add(playerKey(team, id));
  return out;
}

function isSide(v: string | undefined): v is TeamSide {
  return v === "home" || v === "away";
}

function oppositeOf(side: TeamSide): TeamSide {
  return side === "home" ? "away" : "home";
}

/** 패스 성공률(%). 시도가 없으면 **null** — 0% 는 거짓말이다. */
export function passPct(line: Pick<PlayerStatLine, "passesAttempted" | "passesCompleted">): number | null {
  if (line.passesAttempted <= 0) return null;
  return Math.round((line.passesCompleted / line.passesAttempted) * 1000) / 10;
}

/**
 * 패스 귀속 커버리지(0..1). 1 = 팀 합계의 패스 시도가 **전부** 선수에게 붙었다.
 * 시도가 하나도 없으면 null.
 *
 * ⚠️ 화면이 "이 기록은 불완전하다"를 말할 수 있어야 해서 노출한다. 스냅샷이 성길수록
 * (서버가 트림한 로그·구 매치) 소유 체인이 끊겨 잔차가 커진다 — 실측: 틱당 스냅샷 1개인
 * 로그는 0%, 3틱당 1개인 트림 로그는 4.2%, 20틱당 1개면 40% 를 넘는다.
 * 숫자를 조용히 낮게 보여 주는 대신 **커버리지를 같이** 보여 주는 것이 이 모듈의 입장이다.
 */
export function passAttributionCoverage(result: PlayerStatsResult): number | null {
  const attributed = result.players.reduce((a, p) => a + p.passesAttempted, 0);
  const total = attributed + result.unattributed.passesAttempted;
  if (total <= 0) return null;
  return attributed / total;
}

export function findPlayerStat(
  result: PlayerStatsResult,
  team: TeamSide,
  playerId: string,
): PlayerStatLine | undefined {
  const key = playerKey(team, playerId);
  return result.players.find((p) => p.key === key);
}

function emptyLine(team: TeamSide, playerId: string, heatLen: number): PlayerStatLine {
  return {
    key: playerKey(team, playerId),
    team,
    playerId,
    goals: 0,
    shots: 0,
    shotsOnTarget: 0,
    shotsOffTarget: 0,
    xg: 0,
    tackles: 0,
    interceptions: 0,
    clearances: 0,
    fouls: 0,
    yellowCards: 0,
    redCards: 0,
    secondYellow: false,
    sentOff: false,
    offsides: 0,
    saves: 0,
    goalsConceded: 0,
    passesAttempted: 0,
    passesCompleted: 0,
    longPasses: 0,
    longPassesCompleted: 0,
    keyPasses: 0,
    assists: 0,
    touches: 0,
    carries: 0,
    carryDistanceM: 0,
    carryProgressM: 0,
    dispossessed: 0,
    distanceM: 0,
    ticksPlayed: 0,
    minutesPlayed: 0,
    heat: new Array<number>(heatLen).fill(0),
    rating: RATING_WEIGHTS.base,
  };
}

// ── 소유 체인 ─────────────────────────────────────────────────────────────

interface OwnerSample {
  /** 이 소유가 관측된 스냅샷 틱. */
  tick: number;
  side: TeamSide;
  playerId: string;
}

/**
 * ⚠️ **휴리스틱이 사는 유일한 자리(seam)**.
 *
 * `TickSnapshot.ballOwner` 는 **맨 `playerId`** 다(shared 계약 — #231 은 엔진 내부만
 * `(side, playerId)` 로 바꿨다). 그래서 문자열만으로는 팀을 알 수 없고, 같은 id 가 양 팀에
 * 있으면 **공에 더 가까운 쪽**을 소유자로 보는 추정이 필요하다. 그 판정은 **viewer-core 가
 * 소유한다**(`owner-side.mjs` — 여기서 재구현하면 두 벌이 되어 조용히 갈라진다, #324).
 *
 * `computeCumulativePossession` 은 그 판정의 **공개 표면**이다(패키지 `exports` 밖으로
 * 손을 뻗지 않는다). 누적값의 차분이 곧 그 틱의 소유팀이다.
 *
 * 👉 엔진이 언젠가 `pass`/`interception` 에 **패서 id + side** 를 실어 주면(레이즈 = 계획서 §2
 * "T3 레이즈" 표), 이 함수만 갈아끼우면 된다 — 아래 집계 로직과 공개 API 는 안 바뀐다.
 */
function ownerChain(snaps: readonly StatSnapshot[]): (TeamSide | null)[] {
  if (snaps.length === 0) return [];
  // 사본을 뜨지 않는다 — `StatSnapshot` 이 그 API 의 요구 형상과 구조적으로 같다.
  // (매 틱 재계산하는 라이브 화면에서 스냅샷×선수만큼의 객체를 새로 만드는 비용이 그대로 든다.)
  const { cumHome, cumAway } = computeCumulativePossession(snaps);
  const out: (TeamSide | null)[] = [];
  let prevH = 0;
  let prevA = 0;
  for (let i = 0; i < snaps.length; i++) {
    const h = cumHome[i] ?? prevH;
    const a = cumAway[i] ?? prevA;
    out.push(h > prevH ? "home" : a > prevA ? "away" : null);
    prevH = h;
    prevA = a;
  }
  return out;
}

// ── 본체 ─────────────────────────────────────────────────────────────────

/**
 * **하프 하나**의 선수별 기록. 두 하프는 각각 돌리고 `combinePlayerStats` 로 합친다
 * (하프 로그는 자기 틱 번호를 쓴다 — 합쳐서 한 번에 돌리면 틱이 겹친다).
 *
 * ⚠️ **비용은 O(스냅샷 × 선수)** 이고 증분이 아니다(라이브 하프 ≈ 2,700틱 × 22명). 재생 중 매 틱
 * 부르면 그만큼 다시 돈다 — 소비하는 화면이 `uptoTick` 단위로 **메모이즈하거나 스로틀**해야 한다.
 * (증분화는 화면이 실제로 무엇을 요구하는지 나온 뒤에 한다 — 지금 하면 근거 없는 최적화다.)
 */
export function computePlayerStats(log: StatMatchLog, opts: PlayerStatsOptions = {}): PlayerStatsResult {
  const upto = opts.uptoTick ?? null;
  const bins = opts.heatBins ?? DEFAULT_HEAT_BINS;
  const heatLen = Math.max(1, bins.cols * bins.rows);
  const pitch = opts.pitch ?? DEFAULT_PITCH;
  const gkKeys = opts.gkKeys ?? new Set<string>();

  const allSnaps = log.tickSnapshots ?? [];
  const snaps = upto === null ? allSnaps.slice() : allSnaps.filter((s) => s.tick <= upto);
  const events = (log.events ?? [])
    .filter((e) => (upto === null || e.tick <= upto) && typeof e.tick === "number")
    .slice()
    .sort((a, b) => a.tick - b.tick); // 안정 정렬 — 같은 틱의 원본 순서(옐로→레드, 슛→결과)를 보존한다.

  const lines = new Map<string, PlayerStatLine>();
  const unattributed: UnattributedCounts = { passesCompleted: 0, passesAttempted: 0, events: {} };

  const line = (team: TeamSide, playerId: string): PlayerStatLine => {
    const key = playerKey(team, playerId);
    let l = lines.get(key);
    if (!l) {
      l = emptyLine(team, playerId, heatLen);
      lines.set(key, l);
    }
    return l;
  };
  const lineOfKey = (key: string): PlayerStatLine => {
    const i = key.indexOf(":");
    const team = key.slice(0, i) as TeamSide;
    return line(team, key.slice(i + 1));
  };
  const missed = (type: string): void => {
    unattributed.events[type] = (unattributed.events[type] ?? 0) + 1;
  };

  // ── ① 스냅샷 패스: 출전·주행거리·히트맵 + 소유 구간(터치·캐리) ──────────
  const owners = ownerChain(snaps);
  const samples: OwnerSample[] = [];

  const lastPos = new Map<string, { x: number; y: number }>();
  const lastMinute = new Map<string, number>();

  let runKey: string | null = null;
  let runStart = -1;

  const flushRun = (endIdx: number): void => {
    if (runKey === null || runStart < 0) return;
    const l = lineOfKey(runKey);
    l.touches += 1;
    let path = 0;
    for (let i = runStart + 1; i <= endIdx; i++) {
      const a = snaps[i - 1];
      const b = snaps[i];
      if (!a || !b) continue;
      path += Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y);
    }
    if (path >= CARRY_MIN_M) {
      const from = snaps[runStart];
      const to = snaps[endIdx];
      l.carries += 1;
      l.carryDistanceM += path;
      if (from && to) {
        const dx = to.ball.x - from.ball.x;
        // home 은 +x, away 는 −x 로 공격한다(엔진 좌표 규약 — match-stats.ts 와 동일).
        const forward = l.team === "home" ? dx : -dx;
        if (forward > 0) l.carryProgressM += forward;
      }
    }
    runKey = null;
    runStart = -1;
  };

  for (let i = 0; i < snaps.length; i++) {
    const snap = snaps[i];
    if (!snap) continue;

    for (const p of snap.players) {
      if (!isSide(p.team)) continue;
      const l = line(p.team, p.playerId);
      const key = l.key;
      const prev = lastPos.get(key);
      if (prev) l.distanceM += Math.hypot(p.pos.x - prev.x, p.pos.y - prev.y);
      lastPos.set(key, { x: p.pos.x, y: p.pos.y });
      l.ticksPlayed += 1;
      // 표시 분은 로그가 구운 `minute` 축이다(#388 — floor(tick/60) 금지).
      const min = typeof snap.minute === "number" ? snap.minute : -1;
      if (lastMinute.get(key) !== min) {
        l.minutesPlayed += 1;
        lastMinute.set(key, min);
      }
      const col = clampInt(Math.floor((p.pos.x / pitch.lengthM) * bins.cols), 0, bins.cols - 1);
      const row = clampInt(Math.floor((p.pos.y / pitch.widthM) * bins.rows), 0, bins.rows - 1);
      const idx = row * bins.cols + col;
      l.heat[idx] = (l.heat[idx] ?? 0) + 1;
    }

    const side = owners[i] ?? null;
    const ownerId = snap.ballOwner ?? null;
    const key = side && ownerId ? playerKey(side, ownerId) : null;
    if (key !== runKey) {
      flushRun(i - 1);
      if (key) {
        runKey = key;
        runStart = i;
      }
    }
    if (side && ownerId) samples.push({ tick: snap.tick, side, playerId: ownerId });
  }
  flushRun(snaps.length - 1);

  // ── ② 이벤트 패스 ────────────────────────────────────────────────────
  // "직전 소유자" = `tick < e.tick` 인 마지막 소유 샘플. 이벤트가 발행되는 시점 규약이
  // 타입마다 다르지만(패스·가로챔·태클은 **도착/성립 틱**, 슛·걷어내기는 **발사 틱**),
  // 셋 다 "그 이벤트 직전의 소유자"가 우리가 찾는 행위자/피해자다.
  let sp = 0;
  const lastOwnerBefore = (tick: number): OwnerSample | null => {
    while (sp < samples.length && (samples[sp]?.tick ?? Infinity) < tick) sp++;
    return sp > 0 ? (samples[sp - 1] ?? null) : null;
  };
  /** `from` 이후 지금까지 소유자가 `key` 하나뿐이었나(= 소유가 안 끊겼다). */
  const heldContinuously = (from: number, key: string): boolean => {
    for (let i = from; i < sp; i++) {
      const s = samples[i];
      if (!s) continue;
      if (playerKey(s.side, s.playerId) !== key) return false;
    }
    return true;
  };

  interface PendingShot {
    shooterKey: string;
    assistKey: string | null;
  }
  const pendingShots: Record<TeamSide, PendingShot[]> = { home: [], away: [] };
  /**
   * 직전에 **완성된** 패스(키패스·어시스트 판정용). 소유가 끊기는 이벤트에서 무효화하고,
   * 슛 시점에 **리시버가 그 소유 구간을 계속 쥐고 있었는지**(`sinceSample`)까지 확인한다 —
   * 이벤트 없는 소유 이전(세트피스 크로스·헤딩 세컨볼, `contest.resolveArrival`)이 있으므로
   * 이벤트만으로는 "그 패스로 만든 슛"이 성립하지 않는다.
   */
  let pendingAssist: { passerKey: string; receiverKey: string; sinceSample: number } | null = null;
  /** 마지막 "발사"(슛·걷어내기) — 아웃(스로인)을 실패 패스로 오귀속하지 않기 위한 표식. */
  let lastRelease: { key: string; tick: number } | null = null;

  const yellowAt = new Set<string>(); // `${tick}|${key}` — 같은 틱 옐로+레드 = 경고 누적 퇴장.

  for (const e of events) {
    const side = isSide(e.team) ? e.team : null;
    const owner = lastOwnerBefore(e.tick);

    switch (e.type) {
      case "shot": {
        if (e.detail === "saved" || e.detail === "off_target") {
          // 결과 마커 — `playerId` 가 없다. 직전 발사에 페어링해서 슈터에게 붙인다.
          if (!side) break;
          const pend = pendingShots[side].shift();
          if (!pend) {
            missed("shot_result_unpaired");
            break;
          }
          const l = lineOfKey(pend.shooterKey);
          if (e.detail === "saved") l.shotsOnTarget += 1;
          else l.shotsOffTarget += 1;
          break;
        }
        // 발사. ⚠️ xG 는 **여기서만** 더한다 — 결과 마커/골 이벤트도 xg 를 재발행하므로
        // 그것까지 더하면 두 배가 된다.
        if (!side || !e.playerId) {
          missed("shot");
          break;
        }
        const l = line(side, e.playerId);
        l.shots += 1;
        if (typeof e.xg === "number") l.xg += e.xg;
        const assistKey =
          pendingAssist &&
          pendingAssist.receiverKey === l.key &&
          heldContinuously(pendingAssist.sinceSample, l.key)
            ? pendingAssist.passerKey
            : null;
        if (assistKey) lineOfKey(assistKey).keyPasses += 1;
        pendingShots[side].push({ shooterKey: l.key, assistKey });
        pendingAssist = null;
        lastRelease = { key: l.key, tick: e.tick };
        break;
      }

      case "goal": {
        if (!side) {
          missed("goal");
          break;
        }
        const pend = pendingShots[side].shift() ?? null;
        if (e.playerId) {
          const l = line(side, e.playerId);
          l.goals += 1;
          l.shotsOnTarget += 1; // 골도 유효슛이다.
        } else {
          missed("goal");
        }
        if (pend?.assistKey) lineOfKey(pend.assistKey).assists += 1;
        // 실점 귀속 — 그 틱에 피치에 있던 상대 GK.
        const conceding = oppositeOf(side);
        for (const gkKey of goalkeepersAt(snaps, e.tick, conceding, gkKeys)) {
          lineOfKey(gkKey).goalsConceded += 1;
        }
        pendingAssist = null;
        break;
      }

      case "save":
        if (side && e.playerId) line(side, e.playerId).saves += 1;
        else missed("save");
        break;

      case "foul":
        if (side && e.playerId) line(side, e.playerId).fouls += 1;
        else missed("foul");
        pendingAssist = null;
        break;

      case "card": {
        if (!side || !e.playerId) {
          missed("card");
          break;
        }
        const l = line(side, e.playerId);
        const stamp = `${e.tick}|${l.key}`;
        if (e.detail === "red") {
          l.redCards += 1;
          l.sentOff = true;
          // ⚠️ 2번째 옐로는 엔진이 `yellow` 와 `red` 를 **둘 다** 쏜다. 카드 2장이 아니라
          // "경고 누적 퇴장" 한 사건이다 — 평점 감점이 두 번 먹지 않게 표시해 둔다.
          if (yellowAt.has(stamp)) l.secondYellow = true;
        } else {
          l.yellowCards += 1;
          yellowAt.add(stamp);
        }
        break;
      }

      case "offside":
        if (side && e.playerId) line(side, e.playerId).offsides += 1;
        else missed("offside");
        pendingAssist = null;
        break;

      case "tackle": {
        if (side && e.playerId) line(side, e.playerId).tackles += 1;
        else missed("tackle");
        // 뺏긴 쪽 = 직전 소유자(상대 팀). 패스 차단(가로챔)과 다르다 — 그건 실패 패스다.
        if (side && owner && owner.side === oppositeOf(side)) {
          line(owner.side, owner.playerId).dispossessed += 1;
        }
        pendingAssist = null;
        break;
      }

      case "clearance": {
        if (side && e.playerId) {
          const l = line(side, e.playerId);
          l.clearances += 1;
          lastRelease = { key: l.key, tick: e.tick };
        } else {
          missed("clearance");
        }
        pendingAssist = null;
        break;
      }

      case "pass": {
        // ⚠️ `playerId` 는 **패서가 아니라 리시버**다(engine `contest.ts` — 도착 틱에 발행).
        // 패서는 소유 체인의 직전 소유자다.
        if (side && owner && owner.side === side) {
          const p = line(owner.side, owner.playerId);
          p.passesAttempted += 1;
          p.passesCompleted += 1;
          if (e.detail === "long") {
            p.longPasses += 1;
            p.longPassesCompleted += 1;
          }
          pendingAssist = e.playerId
            ? { passerKey: p.key, receiverKey: playerKey(side, e.playerId), sinceSample: sp }
            : null;
        } else {
          // 패서 미상 — 잔차로 남긴다. **시도도 같이** 남겨야 `선수합 + 잔차 = 팀합` 이 성립한다.
          // (팀이 없는 이벤트는 팀 집계에도 안 들어가므로 잔차로도 세지 않는다.)
          if (side) {
            unattributed.passesCompleted += 1;
            unattributed.passesAttempted += 1;
          }
          pendingAssist = null;
        }
        break;
      }

      case "interception": {
        if (side && e.playerId) line(side, e.playerId).interceptions += 1;
        else missed("interception");
        // 끊긴 쪽의 실패 패스.
        if (side && owner && owner.side === oppositeOf(side)) {
          const v = line(owner.side, owner.playerId);
          v.passesAttempted += 1;
          if (e.detail === "long") v.longPasses += 1;
        } else if (side) {
          unattributed.passesAttempted += 1;
        }
        pendingAssist = null;
        break;
      }

      case "kickoff": {
        // 상대 스로인 = 내 패스가 라인 밖으로 나갔다(팀 축 `liveEventStats` 와 같은 정의).
        // ⚠️ 단, 직전 행동이 **슛/걷어내기**였으면 실패 패스가 아니다 — 그 둘은 의도 수신자가
        // 없는 킥이라 패스 성공률 캘리브레이션을 오염시킨다.
        if (e.detail === "throw_in" && side) {
          const victimSide = oppositeOf(side);
          if (owner && owner.side === victimSide) {
            const victim = line(victimSide, owner.playerId);
            const shotOrClear =
              lastRelease !== null && lastRelease.key === victim.key && lastRelease.tick > owner.tick;
            if (shotOrClear) unattributed.passesAttempted += 1;
            else victim.passesAttempted += 1;
          } else {
            unattributed.passesAttempted += 1;
          }
        }
        pendingAssist = null;
        break;
      }

      default:
        pendingAssist = null;
        break;
    }
  }

  return finalize(
    [...lines.values()],
    unattributed,
    { cols: bins.cols, rows: bins.rows },
    upto,
    snaps.length,
    opts.positions,
  );
}

/**
 * 하프별 결과를 합친다. 카운터·거리·출전시간은 **더하고**, 비율(성공률)은 저장하지 않으므로
 * 소비자가 `passPct` 로 합계에서 다시 계산한다(비율의 평균 금지). 평점·MOTM 은 합산 후 재산출.
 */
export function combinePlayerStats(
  parts: readonly PlayerStatsResult[],
  opts: Pick<PlayerStatsOptions, "positions"> = {},
): PlayerStatsResult {
  const first = parts[0];
  const bins = first ? first.heatBins : DEFAULT_HEAT_BINS;
  for (const p of parts) {
    if (p.heatBins.cols !== bins.cols || p.heatBins.rows !== bins.rows) {
      throw new Error("combinePlayerStats: heatBins 가 다른 결과는 합칠 수 없다");
    }
  }
  const heatLen = Math.max(1, bins.cols * bins.rows);
  const merged = new Map<string, PlayerStatLine>();
  const unattributed: UnattributedCounts = { passesCompleted: 0, passesAttempted: 0, events: {} };
  let ticks = 0;

  for (const part of parts) {
    ticks += part.ticks;
    unattributed.passesCompleted += part.unattributed.passesCompleted;
    unattributed.passesAttempted += part.unattributed.passesAttempted;
    for (const [k, v] of Object.entries(part.unattributed.events)) {
      unattributed.events[k] = (unattributed.events[k] ?? 0) + v;
    }
    for (const src of part.players) {
      let dst = merged.get(src.key);
      if (!dst) {
        dst = emptyLine(src.team, src.playerId, heatLen);
        merged.set(src.key, dst);
      }
      dst.goals += src.goals;
      dst.shots += src.shots;
      dst.shotsOnTarget += src.shotsOnTarget;
      dst.shotsOffTarget += src.shotsOffTarget;
      dst.xg += src.xg;
      dst.tackles += src.tackles;
      dst.interceptions += src.interceptions;
      dst.clearances += src.clearances;
      dst.fouls += src.fouls;
      dst.yellowCards += src.yellowCards;
      dst.redCards += src.redCards;
      dst.secondYellow = dst.secondYellow || src.secondYellow;
      dst.sentOff = dst.sentOff || src.sentOff;
      dst.offsides += src.offsides;
      dst.saves += src.saves;
      dst.goalsConceded += src.goalsConceded;
      dst.passesAttempted += src.passesAttempted;
      dst.passesCompleted += src.passesCompleted;
      dst.longPasses += src.longPasses;
      dst.longPassesCompleted += src.longPassesCompleted;
      dst.keyPasses += src.keyPasses;
      dst.assists += src.assists;
      dst.touches += src.touches;
      dst.carries += src.carries;
      dst.carryDistanceM += src.carryDistanceM;
      dst.carryProgressM += src.carryProgressM;
      dst.dispossessed += src.dispossessed;
      dst.distanceM += src.distanceM;
      dst.ticksPlayed += src.ticksPlayed;
      dst.minutesPlayed += src.minutesPlayed;
      for (let i = 0; i < heatLen; i++) dst.heat[i] = (dst.heat[i] ?? 0) + (src.heat[i] ?? 0);
    }
  }

  return finalize([...merged.values()], unattributed, bins, null, ticks, opts.positions);
}

// ── 평점 · MOTM ──────────────────────────────────────────────────────────

function finalize(
  players: PlayerStatLine[],
  unattributed: UnattributedCounts,
  heatBins: { cols: number; rows: number },
  uptoTick: number | null,
  ticks: number,
  positions: Readonly<Record<string, PlayerPosition>> | undefined,
): PlayerStatsResult {
  // ⚠️ 포지션 조회도 `(team, playerId)` 키다 — `playerId` 로 조회하면 양 팀 동명 선수가
  //    같은 보정을 받는다(옵션이 이 파일의 키 규율을 뚫는 자리).
  for (const l of players) l.rating = computeRating(l, positions?.[l.key]);
  // 정렬 = **home 먼저**, 그 다음 playerId 오름차순(사전순 `away < home` 이 아니다 — 화면이
  // 홈/원정 순으로 읽히도록 명시적으로 정한다). 결정론적이라 스냅샷 계약에 쓸 수 있다.
  players.sort((a, b) =>
    a.team === b.team ? cmp(a.playerId, b.playerId) : SIDE_ORDER[a.team] - SIDE_ORDER[b.team],
  );
  return { players, motm: pickMotm(players), unattributed, heatBins, uptoTick, ticks };
}

const SIDE_ORDER: Record<TeamSide, number> = { home: 0, away: 1 };

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 기본점 기준 가감. 계수는 전부 `RATING_WEIGHTS`. */
export function computeRating(line: PlayerStatLine, position?: PlayerPosition): number {
  return ratingWithWeights(line, position, RATING_WEIGHTS);
}

/**
 * `computeRating` 의 본체 — 계수표를 **주입**받는 형태. `computeRating` 은 이 함수에
 * `RATING_WEIGHTS` 를 넘기는 얇은 껍데기다.
 *
 * ⚠️ 왜 나뉘어 있나: 분포 하네스(`apps/web/scripts/rating-distribution.ts`)가 계수 후보를
 * 같은 시드셋에서 비교하려면 표를 갈아끼워야 하는데, 그러자고 산식을 하네스에 다시 쓰면
 * **측정이 구현과 다른 실수를 공유하게 된다**. 산식은 여기 하나뿐이다.
 * `computeRating(line, position?)` 의 공개 시그니처는 그대로다(#421 이 붙어 있다).
 */
export function ratingWithWeights(
  line: PlayerStatLine,
  position: PlayerPosition | undefined,
  W: RatingWeights,
): number {
  const pos = W.position[position ?? "UNKNOWN"] ?? W.position.UNKNOWN;

  const passFailed = Math.max(0, line.passesAttempted - line.passesCompleted);
  const attack =
    line.goals * W.attack.goal +
    line.assists * W.attack.assist +
    line.keyPasses * W.attack.keyPass +
    line.shotsOnTarget * W.attack.shotOnTarget +
    line.shots * W.attack.shot +
    line.passesCompleted * W.attack.passCompleted +
    passFailed * W.attack.passFailed +
    line.longPassesCompleted * W.attack.longPassCompleted +
    line.carries * W.attack.carry +
    (line.carryProgressM / 10) * W.attack.carryProgressPer10m;

  const defence =
    line.tackles * W.defence.tackle +
    line.interceptions * W.defence.interception +
    line.clearances * W.defence.clearance;

  const keeper = keeperAxis(line, W);

  // 경고 누적 퇴장은 한 사건이다 — 그 옐로는 레드로 흡수한다(카드 2장으로 세지 않는다).
  const effectiveYellows = Math.max(0, line.yellowCards - (line.secondYellow ? 1 : 0));
  const discipline =
    line.dispossessed * W.discipline.dispossessed +
    line.fouls * W.discipline.foul +
    effectiveYellows * W.discipline.yellow +
    (line.sentOff ? W.discipline.red : 0);

  const raw = W.base + attack * pos.attack + defence * pos.defence + keeper + discipline;
  const clamped = Math.min(W.max, Math.max(W.min, raw));
  return Math.round(clamped * 10) / 10;
}

/**
 * 골키퍼 축 — **선방률**(hero 확정 ③). 구 산식은 `save +0.30` 과 `goalConceded −0.30` 이
 * 정확히 상쇄돼 **6실점 6선방 GK 가 무관여와 같은 점수**였다(= 일한 양과 무관한 상수).
 *
 * ## 재료
 * 엔진에서 유효슛의 결말은 **선방 아니면 골** 둘뿐이다(빗나간 슛은 GK 의 일이 아니다) →
 * `상대한 유효슛 = saves + goalsConceded` 가 근사가 아니라 **항등식**이다. 다른 팀의
 * 라인을 볼 필요가 없어 `computeRating(line, position?)` 시그니처를 지킬 수 있다.
 *
 * ## 소표과 수축이 핵심이다
 * 한 하프에 유효슛이 2개면 생 선방률은 0% 아니면 100% 로 튄다. 그대로 쓰면 GK 평점 분산이
 * 필드 플레이어의 몇 배가 되고, "평점"이 실력이 아니라 **표본 크기**를 보여 주게 된다.
 * 그래서 `priorFaced` 개의 "평균적인 유효슛"을 미리 깔고 비율을 낸다(베이지안 셋업) —
 * 표본이 얇을수록 답이 기준선(`expectedSaveRate`)으로 당겨지고, 많이 상대할수록 실측이 이긴다.
 *
 * ⚠️ **포지션 라벨이 아니라 실제 한 일로 분기한다** — `faced === 0` 이면 이 축은 통째로 0 이라
 * 필드 플레이어에게 무해하고, `positions` 를 안 넘겨도 GK 가 제 축을 받는다(옵션 누락에 견딘다).
 */
function keeperAxis(line: PlayerStatLine, W: RatingWeights): number {
  const faced = line.saves + line.goalsConceded; // 유효슛 = 선방 or 실점 (항등식)
  let out = line.saves * W.keeper.saveVolume + line.goalsConceded * W.keeper.goalConceded;
  // ⚠️ **분모를 지킨다** — `faced > 0` 이 아니라 `denom > 0` 이다.
  //    이 가드가 막는 유일한 것은 `faced = 0` **이면서** `priorFaced = 0` 일 때의 `0/0 = NaN`
  //    이고, `priorFaced = 0` 은 가상의 값이 아니라 **수축 아블레이션과 하네스 `--weights`
  //    경로가 실제로 쓰는 설정**이다. 여기가 NaN 이면 그 선수의 평점이 NaN 이 되고
  //    (NaN 은 clamp 의 min/max 비교를 전부 통과한다) 화면까지 그대로 흘러간다.
  //    ⚠️ 이 등가는 **출하값의 성질이 아니라 항등식**이다(#403 W1e) — `priorFaced` 가 무엇이든
  //    이 가드는 `faced > 0` 과 같은 답을 낸다: `prior > 0` 이면 `faced = 0` 에서도
  //    shrunk === expectedSaveRate 라 기여가 정확히 0 이고, `prior = 0` 이면 `denom` 이 곧
  //    `faced` 라 두 조건이 문자 그대로 같다. 그러니 이 줄을 **출하값에 기대어 읽지 마라** —
  //    가드가 막는 것은 `if (true)` 로 조건을 없앴을 때의 `0/0` 뿐이다.
  //    계약 = "분모 가드는 `priorFaced` 값과 무관하게 옳다" + "0 으로 내려도 유한값".
  const denom = faced + W.keeper.priorFaced;
  if (denom > 0) {
    const shrunk = (line.saves + W.keeper.priorFaced * W.keeper.expectedSaveRate) / denom;
    out += (shrunk - W.keeper.expectedSaveRate) * W.keeper.saveRateScale;
  }
  return out;
}

/**
 * MOTM = 팀 무관 최고 평점 1명. 동점이면 **골 → 어시스트 → (반올림 전) 평점 → 키** 순.
 * 전순서로 끝까지 내려가므로 결정론적이다.
 */
function pickMotm(players: readonly PlayerStatLine[]): Motm | null {
  let best: PlayerStatLine | null = null;
  for (const p of players) {
    if (p.ticksPlayed <= 0) continue; // 출전하지 않은 선수는 후보가 아니다.
    if (!best) {
      best = p;
      continue;
    }
    if (p.rating !== best.rating) {
      if (p.rating > best.rating) best = p;
      continue;
    }
    if (p.goals !== best.goals) {
      if (p.goals > best.goals) best = p;
      continue;
    }
    if (p.assists !== best.assists) {
      if (p.assists > best.assists) best = p;
      continue;
    }
    if (cmp(p.key, best.key) < 0) best = p;
  }
  return best ? { key: best.key, team: best.team, playerId: best.playerId, rating: best.rating } : null;
}

// ── 보조 ─────────────────────────────────────────────────────────────────

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** `tick` 시점(그 이하 마지막 스냅샷)에 피치 위에 있던 `side` 의 GK 키들. */
function goalkeepersAt(
  snaps: readonly StatSnapshot[],
  tick: number,
  side: TeamSide,
  gkKeys: ReadonlySet<string>,
): string[] {
  if (gkKeys.size === 0 || snaps.length === 0) return [];
  let lo = 0;
  let hi = snaps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = snaps[mid]?.tick ?? 0;
    if (t <= tick) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const snap = found >= 0 ? snaps[found] : undefined;
  if (!snap) return [];
  const out: string[] = [];
  for (const p of snap.players) {
    // 팀 필터가 **먼저**다 — 없으면 반대 팀의 동명 선수가 같은 키를 만들어 실점이 두 번 붙는다.
    if (p.team !== side) continue;
    if (gkKeys.has(playerKey(side, p.playerId))) out.push(playerKey(side, p.playerId));
  }
  return out;
}
