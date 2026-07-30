import type { TeamSide, PlayerAttributes } from "@hmb/shared";
import type { PlayerBehavior, Duty, TeamInput } from "@hmb/shared";
import type { TeamPlan } from "./teamplan";

/**
 * simstate — 엔진 내부 시뮬 상태 타입(직렬화 계약 아님, 엔진 전용).
 * 좌표·속도는 모두 고정소수 정수(fixed). posFx 등의 값은 EngineConfig.fixedScale 스케일.
 */

/**
 * 선수 조회 키 (#231). **`playerId` 단독은 키가 될 수 없다** — 유저 덱과 봇 로스터가 같은 선수
 * 카탈로그를 공유하므로 **같은 선수가 양 팀에 동시에 출전할 수 있다**(라이브 실측: 51하프 중 20하프).
 * id 로만 맵을 만들면 두 인스턴스 중 하나가 덮이고, 소유자 조회가 **반대 팀 선수**를 돌려준다 →
 * 데드볼 taker 가 영원히 공을 차지 못해 하프가 통째로 죽는다(라이브 1384틱 정지).
 *
 * ⚠️ 이 키는 **엔진 내부 전용**이다. `Ball.owner` · `MatchLog` 스냅샷의 `ballOwner` · 이벤트의
 * `playerId` 는 계속 **순수 `playerId`** 를 담는다(shared 계약·뷰어 무변경). 조회할 때 side 를
 * 같이 넘기는 것이 규율이고, side 는 항상 문맥에 있다(`ball.ownerSide` · `player.side` ·
 * `flight.fromSide` · 입력 적용 루프의 side).
 */
export function playerKey(side: TeamSide, id: string): string {
  return `${side}:${id}`;
}

/** `players` → `byId`. 맵 생성은 여기 한 곳만 — 재개(deserialize) 경로도 이걸 쓴다. */
export function buildById(players: SimPlayer[]): Map<string, SimPlayer> {
  const byId = new Map<string, SimPlayer>();
  for (const p of players) byId.set(playerKey(p.side, p.id), p);
  return byId;
}

/** (side, id) 로 선수 조회. 둘 중 하나라도 없으면 undefined. */
export function playerAt(
  state: SimState,
  side: TeamSide | null | undefined,
  id: string | null | undefined,
): SimPlayer | undefined {
  if (!side || !id) return undefined;
  return state.byId.get(playerKey(side, id));
}

/** 공 소유자. `owner`(id) 와 `ownerSide` 를 **함께** 써야 중복 id 에서 안 어긋난다. */
export function ballOwnerOf(state: SimState): SimPlayer | undefined {
  return playerAt(state, state.ball.ownerSide, state.ball.owner);
}

/**
 * 비행 중인 공의 `claimant` 가 속한 팀. 인터셉트 계획이면 **상대**, 그 외(성공 패스)는 **차는 팀**.
 * 이 파생 덕분에 `BallFlight` 에 새 필드를 넣지 않아도 된다(resumeState 직렬화 계약 무변경).
 */
export function claimantSideOf(f: BallFlight): TeamSide {
  const opp: TeamSide = f.fromSide === "home" ? "away" : "home";
  return f.passOutcome === "fail_intercept" ? opp : f.fromSide;
}

/** 반대 팀. */
export function otherSide(side: TeamSide): TeamSide {
  return side === "home" ? "away" : "home";
}

/**
 * 이 선수가 지금 공을 가진 선수인가. **`p.id === state.ball.owner` 로 비교하지 마라** (#231) —
 * 같은 id 의 반대 팀 선수까지 참이 되어, 소유자가 아닌 쪽이 "소유자 취급"으로 그 틱의 판단·재배치를
 * 건너뛴다(실측 노출: 중복 경기의 2.8% 틱). 조회와 같은 이유로 side 를 함께 본다.
 */
export function isBallOwner(state: SimState, p: SimPlayer): boolean {
  return state.ball.owner === p.id && state.ball.ownerSide === p.side;
}

/** 시뮬 내부 선수 상태. */
export interface SimPlayer {
  id: string;
  side: TeamSide;
  role: string;
  duty: Duty;
  behavior: PlayerBehavior;
  markTarget?: string;
  mentalModifier: number;
  attrs: PlayerAttributes;
  /** 역할 기본 위치(실좌표 fixed, 미러 반영 완료). */
  baseFx: { x: number; y: number };
  /** 현재 위치(fixed). */
  posFx: { x: number; y: number };
  /** 이번 틱 목표 위치(fixed). */
  targetFx: { x: number; y: number };
  /** 피로 0..1. 클수록 느려짐. */
  fatigue: number;
  isGK: boolean;
  /** id 의 결정론 해시(오프더볼 시드 노이즈용, 초기화 시 1회 계산). */
  idHash: number;
  /** 연속 드리블 틱 수(드리블 체인 모멘텀용). 소유 상실/비드리블 시 0. */
  dribbleStreak: number;
  /** 받은 옐로카드 수(2장 누적 시 퇴장). */
  yellowCards: number;
  /**
   * 상대별 마지막으로 본 위치와 시점(시야 기억, #147 W3). key = 상대 playerId.
   * 값은 **정확하지만 낡을 수 있다** — 본 순간의 좌표를 그대로 담고, 갱신 시점(tick)으로
   * 신선도를 판단한다(librcsc pos_count 방식: 위치를 흐리는 게 아니라 나이로 신뢰도를 잰다).
   * `config.vision.memoryTicks` 를 넘긴 기억은 판단에서 제외된다.
   *
   * **표현이 Map 이 아니라 Record 인 이유**: 서버 RPC 재개는 이 상태를 JSON 으로 왕복시키는데
   * `JSON.stringify(new Map(...))` 는 `{}` 가 되어 **전송만으로 기억이 통째로 유실**된다(무음 desync).
   * Record 면 JSON 왕복에서 살아남으므로, 남는 일은 소비자 스키마에 필드를 선언하는 것뿐이다(#154).
   */
  seen: Record<string, { x: number; y: number; tick: number }>;
}

/** 공 비행 상태(패스/슛/루즈볼). */
export interface BallFlight {
  toX: number;
  toY: number;
  /** 이동 속도(fixed m/tick). */
  speed: number;
  kind: "pass" | "shot" | "loose";
  /** 패스 의도 수신자 playerId. */
  target?: string;
  /** 공을 찬 팀. */
  fromSide: TeamSide;
  /** 슛을 쏜 xG(이벤트 기록용). */
  xg?: number;
  /** 패스 계획 결과: 성공/인플레이 턴오버/아웃오브바운즈. (성공률 결정론 제어) */
  passOutcome?: "success" | "fail_intercept" | "fail_out";
  /**
   * #181: 이 패스를 **결국 잡을 사람**(성공=의도 수신자, fail_intercept=계획된 가로챈 수비수).
   * 이 사람이 낙하점으로 마주 달리고(decideOffBall), 도착 판정도 이 사람 기준으로 한다 →
   * 공이 사람에게 순간이동하는 대신 둘이 같은 지점에서 만난다.
   */
  claimant?: string;
  /** #181: 낙하점에서 claimant 를 기다린 틱 수(arrivalWaitMaxTicks 초과 시 기하 판정으로 폴백). */
  waited?: number;
  /** #181: 발사 지점 — 도착했는데 아무도 못 닿았을 때 **같은 방향으로** 굴려보내기 위한 기준. */
  fromX?: number;
  fromY?: number;
  /** 의도적 롱패스(E2) — 도착 이벤트 detail="long" 로 뷰어 구분. */
  long?: boolean;
  /**
   * #306(S6) 전달 종류. `"ground"`(기본) = 지상 패스, `"lofted"` = 띄운 공(크로스·롱볼).
   *
   * **이 필드 하나가 공중볼의 전부다.** 높이(z)를 좌표로 들고 다니지 않는 이유:
   * 1초 틱에서 z 는 렌더 보간에만 쓰이고 판정에는 "이 공이 머리 높이로 오는가"만 필요하다.
   * 그 판정을 z 로 하면 낙하 시점 계산(포물선)이 들어가고, 그건 `Math.pow` 없이 정수로 하기
   * 어려워 결정론 규율(§5-4)과 싸운다. 종류 + 체공(`hangTicks`)이면 도착 시 경합에 필요한
   * 정보가 전부 있고, 뷰어는 이 두 값으로 아크를 그릴 수 있다(렌더는 별도 트랙 — hero 결정).
   *
   * `undefined` = ground(구 저장 상태 호환).
   */
  delivery?: "ground" | "lofted";
  /**
   * #306: 이 공이 공중에 뜬 채로 날아가는 총 틱(발사 시 1회 계산). 뷰어의 아크 파라미터이자
   * "도착 순간이 공중 경합인가"의 근거. ground 면 0/undefined.
   */
  hangTicks?: number;
}

/**
 * shot_out 정지 종료 시 이어질 재시작 명령(코너킥 or 골킥).
 * 슛(세이브 굴절/빗맞음)이 아웃되면 공을 골문 프레임(키퍼/포스트 옆)에 먼저 두고 짧게 정지한 뒤,
 * 이 명령으로 실제 세트피스(공이 코너 깃발/골킥 스팟에 놓이는 단계)를 시작한다.
 */
export type DeferredRestart =
  | { kind: "corner"; side: TeamSide; nearY: number }
  | { kind: "goal_kick"; side: TeamSide }
  // 박스 파울 → 공을 접촉 지점에 두는 "파울 비트" 정지 후 페널티 스팟 배치+런업(2단계, 코너 패턴).
  | { kind: "penalty"; side: TeamSide };

/** 진행 중인 세트피스 컨텍스트(정지 동안 재배치에 사용). */
export interface SetPiece {
  /**
   * kind:
   *  - corner/throw_in/goal_kick/kickoff: 일반 세트피스.
   *  - goal: 골 직후 세리머니 정지. 공은 네트에 머물고, 정지가 끝나면 side 팀이 센터 킥오프.
   *  - free_kick: 파울/오프사이드 후 프리킥. side 팀이 재개.
   *  - penalty: 박스 내 파울 후 페널티. 정지가 끝나면 side 팀 테이커가 고xG 슛.
   *  - shot_out: 슛이 세이브 굴절/빗맞음으로 아웃된 직후의 짧은 정지. 공은 골문 프레임
   *    (키퍼 위치 또는 포스트 옆)에 머물고(코너 깃발 직행 금지), 정지가 끝나면 restart
   *    (코너킥/골킥) 세트피스가 시작된다.
   */
  kind: "corner" | "throw_in" | "goal_kick" | "kickoff" | "goal" | "free_kick" | "penalty" | "shot_out";
  /** 재시작(수혜) 팀. goal 이면 킥오프할 실점팀. shot_out 이면 정지 동안 공을 지킨 수비팀. */
  side: TeamSide;
  /** 재시작 지점(fixed). */
  x: number;
  y: number;
  /** shot_out 정지 종료 시 실행할 세트피스(코너/골킥). shot_out 외에는 undefined. */
  restart?: DeferredRestart;
}

/** 공 상태. */
export interface Ball {
  posFx: { x: number; y: number };
  owner: string | null;
  ownerSide: TeamSide | null;
  flight: BallFlight | null;
}

/** 전체 시뮬 상태. */
export interface SimState {
  players: SimPlayer[];
  byId: Map<string, SimPlayer>;
  ball: Ball;
  score: { home: number; away: number };
  possession: TeamSide;
  tick: number;
  /** 매치 시드의 결정론 해시(오프더볼 변주 시드 노이즈용). 재개 시에도 관통. */
  seedHash: number;
  /** 팀 전술 파라미터(라인/압박/폭). 움직임 결정에 사용. */
  teams: { home: TeamInput; away: TeamInput };
  /** 남은 정지(dead ball) 틱. >0 이면 결정/경합/공비행 없이 재배치만. */
  stoppage: number;
  /** 진행 중 세트피스(정지 동안). 없으면 null. */
  setPiece: SetPiece | null;
  /**
   * 현재 소유가 **시작된** 틱(#279 S1). `setPossession` 이 소유 팀이 실제로 바뀔 때만 갱신한다 —
   * 같은 팀 안의 소유 이전(패스 성공/드리블 인계)에는 갱신하지 않는다. 안 그러면 "소유 경과"가
   * 매 패스마다 0 으로 리셋돼 국면 판정(S4)의 입력으로 쓸 수 없다.
   */
  possessionSince: number;
  /**
   * 마지막 **오픈플레이 소유 전환**(#279 S1). 재시작(스로인/프리킥/코너/골킥)·킥오프·득점은
   * 여기에 기록되지 않는다 — `setPossession` 의 `reason` 이 그 구분이다.
   * 좌표는 전환 시점의 공 위치(고정소수). 아직 전환이 없었으면 null.
   */
  lastTurnover: { side: TeamSide; tick: number; xFx: number; yFx: number } | null;
  /** 팀 단위 파생 계획(틱당 1회, decide 루프 앞에서 갱신). 소비는 S3~. */
  plan: { home: TeamPlan; away: TeamPlan };
  /**
   * 팀 국면(#279 S4 소비). **S1 에서는 자리만 만들고 항상 `"open"` 으로 고정한다.**
   *
   * 왜 소비자도 없는데 지금 넣나 — S1 의 존재 이유가 "직렬화·해시·골든 마이그레이션을 **한 번에**
   * 끝낸다"이기 때문이다. S4 에서 필드를 추가하면 스키마·해시·골든을 다시 움직여야 하는데, 그때는
   * **실제 동작 변경과 뒤섞여** 들어와 "해시가 형식 때문에 움직였나 동작 때문에 움직였나"를 분리할
   * 수 없다. 이번엔 동작 변경이 0이라 구 해시 공식 재계산으로 깔끔히 분리해 증명할 수 있었다.
   * S4 는 이 union 을 **넓히기만** 하면 된다(필드 추가가 아니라 값 변경 → 그건 정상적인 동작 변경).
   */
  phase: { home: TeamPhase; away: TeamPhase };
  /**
   * 선수 간 **의도 게시판**(#279 S5 소비). S1 에서는 자리만 만들고 **항상 빈 배열**이다.
   * 이유는 `phase` 와 동일 — 골든 마이그레이션을 한 번에 끝내기 위해서다.
   * S5 가 여기에 "이 지점으로 패스한다 / 저 지점으로 뛴다"를 게시하고 `decideOffBall` 이 읽는다.
   */
  intents: Intent[];
}

/**
 * 팀 국면. S1 에서는 `"open"` 하나만 쓰이고, S4 가 나머지를 실제로 설정한다.
 * (열거를 미리 정의해 두는 것은 **직렬화 스키마를 한 번만 움직이기 위해서**다 — 값은 S4 소관.)
 */
export type TeamPhase =
  | "open"
  | "build"
  | "progress"
  | "final_third"
  | "transition_win"
  | "transition_lose";

/** 의도 게시(#279 S5). S1 에서는 생성되지 않는다. */
export interface Intent {
  side: TeamSide;
  fromId: string;
  kind: "pass_to" | "run_to" | "cross_from";
  /** 목표 지점(고정소수). */
  xFx: number;
  yFx: number;
  tick: number;
  /** 이 틱을 지나면 폐기. */
  expiresTick: number;
  /** 지목된 러너(없으면 공개 게시). */
  forId?: string;
}

/**
 * 소유 전환의 **단일 지점**(#279 S1). `state.possession` 직접 대입 금지 — 전환을 관측하는 곳이
 * 여기 하나여야 S4(국면·카운터프레스·전술파울)가 전환 시각을 신뢰할 수 있다.
 *
 * `reason` 이 핵심이다:
 *  - `"turnover"`  오픈플레이에서 공을 뺏김/뺏음(태클·인터셉트·GK 캐치·패스 도착 경합).
 *  - `"restart"`   데드볼 재시작(스로인·프리킥·코너·골킥·페널티 배치).
 *  - `"kickoff"`   킥오프(경기 시작·하프 시작·득점 후).
 *  - `"goal"`      득점 직후 실점팀에게 소유가 넘어가는 순간.
 *
 * `giveBallTo` 는 **재시작에서도** 불린다 — reason 없이 전환을 기록하면 스로인마다
 * 카운터프레스가 발동한다. 그래서 `lastTurnover` 는 `reason === "turnover"` 이고 **소유 팀이
 * 실제로 바뀐** 경우에만 남긴다(같은 팀 리시버가 패스를 받는 것은 턴오버가 아니다).
 */
export type PossessionReason = "turnover" | "restart" | "kickoff" | "goal";

export function setPossession(
  state: SimState,
  side: TeamSide,
  tick: number,
  reason: PossessionReason,
): void {
  if (state.possession === side) return; // 같은 팀 안의 소유 이전 — 전환이 아니다.
  state.possession = side;
  state.possessionSince = tick;
  if (reason === "turnover") {
    state.lastTurnover = { side, tick, xFx: state.ball.posFx.x, yFx: state.ball.posFx.y };
  }
}
