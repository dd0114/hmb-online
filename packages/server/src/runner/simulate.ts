import { z } from "zod";
import {
  runFirstHalf,
  resumeSecondHalf,
  defaultEngineConfig,
  createRng,
  buildById,
  type EngineConfig,
  type CarryState,
  type SimState,
  type SimPlayer,
} from "@hmb/engine";
import { applyOverrides, effectiveConfigHash } from "./config-overlay.js";
import {
  TeamSide,
  Duty,
  PlayerBehavior,
  PlayerAttributes,
  TeamInput,
  type TickSnapshot,
  type MatchEvent,
  type MatchLog,
  type SimulateRequest,
  type SimulateResponse,
} from "@hmb/shared";
// @ts-expect-error — viewer-core 는 순수 .mjs(타입 선언 없음). 재생 길이 모델의 SoT 라 여기서
// 다시 구현하지 않고 그대로 읽는다(#365).
import { autoPaceDurationMs } from "@hmb/viewer-core/playback";

/**
 * simulate — 엔진러너 순수 로직(HTTP 무관, 단위테스트 가능).
 * LLD-ts-servants §2: half=1(전반) → matchLog+resumeState+lastHash.
 *                      half=2+resumeState(승계 재개) → matchLog(후반만)+lastHash.
 *                      half=2 단독(로스터 교체 폴백) → 독립 후반 시뮬(LLD-server-java §5.4).
 *
 * 무상태: 요청 밖 저장 0. resumeState 는 엔진 CarryState(SimState+RNG상태+pitch 등)를 이 파일이
 * 직접 정의한 JSON-안전 포맷으로 직렬화한 것 — 엔진 코드 수정 없이 공개 API(rng.serialize/restore,
 * CarryState 필드 전부 공개 타입)만으로 왕복 가능하다.
 */

// --- resumeState 직렬화 포맷(이 러너 내부 전용 — shared 계약에서는 unknown) --------------------

const Vec2Fx = z.object({ x: z.number(), y: z.number() });

const SimPlayerSchema = z.object({
  id: z.string(),
  side: TeamSide,
  role: z.string(),
  duty: Duty,
  behavior: PlayerBehavior,
  markTarget: z.string().optional(),
  mentalModifier: z.number(),
  attrs: PlayerAttributes,
  baseFx: Vec2Fx,
  posFx: Vec2Fx,
  targetFx: Vec2Fx,
  fatigue: z.number(),
  isGK: z.boolean(),
  idHash: z.number(),
  dribbleStreak: z.number(),
  /**
   * 시야 기억(engine@0.17.0, #147 W3). zod `.object()` 는 미선언 키를 **조용히 버리므로**
   * 이 줄이 없으면 재개 시 기억이 유실돼 하프분할 ≠ 통짜가 된다(무음 desync). (#154)
   * 엔진이 `Record` 로 담아 JSON 왕복에 안전하다 — `Map` 이던 시절엔 이 선언만으로는 부족했다.
   * `.optional()` 이라 구 저장 상태도 그대로 통과한다.
   */
  seen: z.record(z.string(), z.object({ x: z.number(), y: z.number(), tick: z.number() })).optional(),
  yellowCards: z.number(),
  /**
   * 런 오더(engine #314 B, `SimPlayer.runOrder`). 하프 경계에 런이 살아 있으면 이 선언이 없을 때
   * 조용히 버려져 재개 하프에서만 러너가 멈춘다(무음 desync). zod 는 미선언 키를 버린다(#154).
   * `.nullish()` 라 구 저장 상태(필드 없음)도 그대로 통과한다.
   */
  runOrder: z
    .object({ xFx: z.number(), yFx: z.number(), untilTick: z.number(), fromId: z.string() })
    .nullish(),
});

const BallFlightSchema = z.object({
  toX: z.number(),
  toY: z.number(),
  /**
   * #320: 공 운동의 **권위**는 속도 벡터다(`toX/toY` 는 계획 낙하점 참고값으로 강등됐다).
   * 이 두 줄이 없으면 zod 가 미선언 키를 **조용히 버려서**(#154 동형 함정) 하프 경계에 비행
   * 중인 공이 재개 시 속도 0 이 된다 — 공이 허공에 서고 그때부터 통짜와 갈라진다(무음 desync).
   * `speed` 는 `|v|` 의 파생 캐시라 이 둘을 대신할 수 없다(방향이 없다).
   */
  vxFx: z.number(),
  vyFx: z.number(),
  speed: z.number(),
  kind: z.enum(["pass", "shot", "loose"]),
  target: z.string().optional(),
  fromSide: TeamSide,
  xg: z.number().optional(),
  passOutcome: z.enum(["success", "fail_intercept", "fail_out"]).optional(),
  /**
   * #279 S1 드리프트 수리: 아래 5개는 engine@#181(claimant 마중 + 오버힛 굴림) · E2(long) 산물인데
   * 이 스키마가 따라가지 않아 **재개 시 조용히 버려지고 있었다**. 하프 경계에 패스가 비행 중이면
   * claimant/waited 를 잃어 도착 판정이 계획 대신 기하로 뒤집히고(성공 계획 → 인터셉트),
   * fromX/fromY 를 잃으면 `settle()` 이 방향을 못 구해 공이 그 자리에 정지한다.
   */
  claimant: z.string().optional(),
  waited: z.number().optional(),
  fromX: z.number().optional(),
  fromY: z.number().optional(),
  long: z.boolean().optional(),
  /**
   * #306(S6) 공중볼. 하프 경계에 크로스/롱볼이 떠 있으면 이 두 값이 유실될 때 도착 판정이
   * 헤딩 경합 대신 지상 컨트롤로 뒤집힌다(무음 desync). zod 는 미선언 키를 조용히 버린다(#154).
   */
  delivery: z.enum(["ground", "lofted"]).optional(),
  hangTicks: z.number().optional(),
});

const BallSchema = z.object({
  posFx: Vec2Fx,
  owner: z.string().nullable(),
  ownerSide: TeamSide.nullable(),
  flight: BallFlightSchema.nullable(),
});

const DeferredRestartSchema = z.union([
  z.object({ kind: z.literal("corner"), side: TeamSide, nearY: z.number() }),
  z.object({ kind: z.literal("goal_kick"), side: TeamSide }),
  /**
   * #279 S1 드리프트 수리: 2단계 페널티(박스 파울 → "파울 비트" 정지 → 스팟 배치)의 변형이
   * 엔진에는 있는데 여기 없었다. 하프 **마지막 틱**에 박스 파울이 나면 union 파싱이 실패해
   * `deserializeCarry` 가 throw → 후반 재개가 **400** 으로 죽는다(드문 만큼 늦게 터진다).
   */
  z.object({ kind: z.literal("penalty"), side: TeamSide }),
]);

const SetPieceSchema = z.object({
  kind: z.enum(["corner", "throw_in", "goal_kick", "kickoff", "goal", "free_kick", "penalty", "shot_out"]),
  side: TeamSide,
  x: z.number(),
  y: z.number(),
  restart: DeferredRestartSchema.optional(),
});

/** 팀 단위 파생 계획(engine teamplan.ts). 틱당 1회 재계산되지만 하프 경계 상태에도 실려야 한다. */
const TeamPlanSchema = z.object({
  lineX: z.number(),
  blockDepth: z.number(),
});

/** 팀 국면(engine simstate.ts `TeamPhase`). S1 에서는 항상 "open". */
const TeamPhaseSchema = z.enum([
  "open",
  "build",
  "progress",
  "final_third",
  "transition_win",
  "transition_lose",
]);

/** 의도 게시(engine simstate.ts `Intent`). S1 에서는 항상 빈 배열. */
const IntentSchema = z.object({
  side: z.enum(["home", "away"]),
  fromId: z.string(),
  kind: z.enum(["pass_to", "run_to", "cross_from"]),
  xFx: z.number(),
  yFx: z.number(),
  tick: z.number(),
  expiresTick: z.number(),
  forId: z.string().optional(),
});

const SimStateSchema = z.object({
  players: z.array(SimPlayerSchema),
  ball: BallSchema,
  score: z.object({ home: z.number(), away: z.number() }),
  possession: TeamSide,
  tick: z.number(),
  seedHash: z.number(),
  teams: z.object({ home: TeamInput, away: TeamInput }),
  stoppage: z.number(),
  setPiece: SetPieceSchema.nullable(),
  /**
   * #279 S1 상태 골격. **필수**로 선언한다 — `.optional()` 로 두면 이 필드가 빠진 resumeState 가
   * 조용히 통과해 `state.plan` 이 undefined 인 채 다음 틱에 hashState 가 터지거나(운 좋은 경우)
   * 무음으로 갈라진다(#154 의 교훈). 스키마 확장 이전에 만들어진 resumeState 는 여기서
   * "invalid resumeState" 로 **시끄럽게** 400 이 되는 게 맞다.
   */
  possessionSince: z.number(),
  lastTurnover: z
    .object({ side: TeamSide, tick: z.number(), xFx: z.number(), yFx: z.number() })
    .nullable(),
  plan: z.object({ home: TeamPlanSchema, away: TeamPlanSchema }),
  /**
   * S4/S5 가 소비할 자리(S1 에서는 값이 고정: phase 항상 "open", intents 항상 빈 배열).
   * **지금 선언하는 이유** = 스키마·해시·골든을 한 번만 움직이기 위해서다. S4/S5 에서 필드를
   * 추가하면 그때는 실제 동작 변경과 뒤섞여 들어와 해시 이동의 원인을 분리할 수 없다.
   */
  phase: z.object({ home: TeamPhaseSchema, away: TeamPhaseSchema }),
  intents: z.array(IntentSchema),
});

const SerializedCarrySchema = z.object({
  configVersion: z.string(),
  /**
   * **유효 config 지문**(#383) — 계수 오버레이가 열리면 `configVersion` 만으로는 "같은 config 로
   * 재개하는가"에 답할 수 없다(오버레이는 버전을 올리지 않는다 — 올리면 그게 #241 재현이다).
   * 이 값이 h1 과 다르면 후반은 **다른 경기**가 되고, 그 갈라짐은 아무 신호도 내지 않는다.
   *
   * `.optional()` 인 것이 이 필드의 절반이다: 배포 순간 비행 중이던 **구 resumeState** 에는 이
   * 키가 없고, 그걸 거부하면 이 웨이브 자신이 #241 을 일으킨다. 없으면 검사하지 않는다.
   */
  configHash: z.string().optional(),
  seed: z.string(),
  rngState: z.number(),
  nextTick: z.number(),
  pitch: z.object({ scale: z.number(), wFx: z.number(), hFx: z.number() }),
  state: SimStateSchema,
  /**
   * 전반 tickSnapshots/events "개수"만 보관(내용은 이미 half=1 응답의 matchLog 로 전달 완료).
   * resumeSecondHalf 는 이 배열에 push 만 하고 기존 원소를 읽지 않으므로, 재개 시 개수만큼의
   * 빈 자리(placeholder)를 채워 넣으면 이후 slice(count) 로 후반분만 정확히 분리된다.
   * (resumeState 를 half1 데이터로 중복 팽창시키지 않기 위한 최적화 — 안 그러면 응답이 두 배로 커진다.)
   */
  snapshotCount: z.number(),
  eventCount: z.number(),
});
type SerializedCarry = z.infer<typeof SerializedCarrySchema>;

/** CarryState(엔진 재개 상태) → JSON-안전 포맷. Map(byId)·함수(rng)를 평탄화하고, 전반 스냅샷/이벤트는
 *  개수만 보관한다(내용은 half=1 응답의 matchLog 가 이미 전달했으므로 중복 저장하지 않는다). */
export function serializeCarry(carry: CarryState): SerializedCarry {
  const { byId: _byId, ...restState } = carry.state;
  return {
    configVersion: carry.config.version,
    configHash: effectiveConfigHash(carry.config),
    seed: carry.seed,
    rngState: carry.rng.serialize(),
    nextTick: carry.nextTick,
    pitch: { scale: carry.pitch.scale, wFx: carry.pitch.wFx, hFx: carry.pitch.hFx },
    state: restState,
    snapshotCount: carry.snapshots.length,
    eventCount: carry.events.length,
  };
}

/**
 * JSON-안전 포맷 → CarryState. 형태가 깨졌거나(zod 실패) config 버전이 현재 러너와 다르면 throw
 * (호출부가 400 으로 매핑 — "오래되었거나 손상된 resumeState"는 malformed request 취급).
 * snapshots/events 는 개수만큼의 placeholder 배열로 복원(resumeSecondHalf 가 push 만 하므로 안전) —
 * 호출부가 반드시 결과에서 원래 개수만큼 slice 해 후반분만 취해야 한다.
 */
export function deserializeCarry(raw: unknown, config: EngineConfig): CarryState {
  const parsed = SerializedCarrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid resumeState: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const s = parsed.data;
  if (s.configVersion !== config.version) {
    throw new Error(
      `resumeState config version mismatch: resumeState=${s.configVersion} runner=${config.version}`,
    );
  }
  // #383: 버전이 같아도 **계수 오버레이가 다르면 다른 경기**다. 조용히 갈라지느니 여기서 죽는다
  // (무음 desync 는 #154·#279·#306·#320 이 반복해 물린 함정이다). 구 상태(지문 없음)는 통과 —
  // 그 관대함이 이 웨이브가 진행 중 매치를 죽이지 않는 이유다.
  if (s.configHash !== undefined) {
    const current = effectiveConfigHash(config);
    if (s.configHash !== current) {
      throw new Error(
        `resumeState effective config mismatch: resumeState=${s.configHash} runner=${current} ` +
          `(configOverrides 가 전반과 달라졌습니다 — 한 매치는 시작 시점 스냅샷 하나로만 돌아야 합니다)`,
      );
    }
  }
  const rng = createRng(s.seed);
  rng.restore(s.rngState);
  // #231: 맵 키는 (side, id) — 같은 playerId 가 양 팀에 있을 수 있어서 id 단독은 충돌한다.
  // 키 규칙의 SoT 는 엔진(buildById) 하나뿐이다 — 여기서 손으로 만들면 조용히 갈라진다.
  const byId = buildById(s.state.players as SimPlayer[]);
  const state: SimState = { ...s.state, byId };
  return {
    state,
    rng,
    nextTick: s.nextTick,
    snapshots: new Array(s.snapshotCount) as TickSnapshot[],
    events: new Array(s.eventCount) as MatchEvent[],
    seed: s.seed,
    config,
    pitch: s.pitch,
  };
}

// --- MatchLog 조립 --------------------------------------------------------------------

function carryToMatchLog(carry: CarryState): MatchLog {
  return {
    configVersion: carry.config.version,
    seed: carry.seed,
    tickSnapshots: carry.snapshots,
    events: carry.events,
    finalScore: { home: carry.state.score.home, away: carry.state.score.away },
  };
}

/**
 * **이 하프를 연출 페이싱으로 다 보는 데 걸리는 실시간(ms)** (#365).
 *
 * 서버가 하프 마감 시각을 이 값으로 잡으면 창 == 재생 길이가 되어 **클라가 배속을 창에 맞춰
 * 보정할 일이 사라진다**(hero 확정: 고정 배속만). 계산 규칙은 viewer-core 가 SoT 이고 렌더 루프와
 * 같은 상수(`PACE`)를 읽는다 — 여기서 숫자를 다시 적지 않는다.
 *
 * 실패해도 시뮬을 죽이지 않는다: 값이 없으면 서버가 config 폴백(`half-real-ms`)을 쓴다.
 */
function playbackMsOf(matchLog: MatchLog): number | undefined {
  try {
    const ms = autoPaceDurationMs(matchLog.tickSnapshots, matchLog.events);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
  } catch {
    return undefined;
  }
}

function lastHashOf(matchLog: MatchLog): string {
  const last = matchLog.tickSnapshots[matchLog.tickSnapshots.length - 1];
  if (!last) throw new Error("simulate: empty tickSnapshots — cannot compute lastHash");
  return last.hash;
}

// --- 엔트리 ----------------------------------------------------------------------------

/**
 * simulate — SimulateRequest → SimulateResponse. 결정론(같은 요청 → 같은 응답), 무상태.
 * 요청 검증(zod)은 HTTP 레이어(runner-main.ts) 책임 — 여기서는 이미 파싱된 타입을 받는다.
 * (resumeState 는 계약상 unknown 이라 여기서 직접 형태 검증한다.)
 *
 * config 파라미터 = **기준(base) config**. 러너(HTTP)는 항상 defaultEngineConfig 를 쓰고,
 * fixture 생성 스크립트만 짧은 매치 샘플용 config 를 넘긴다.
 *
 * #383: 요청의 `configOverrides`(점경로 계수 오버레이)를 그 base 위에 얹는다. 오버레이가 없으면
 * `applyOverrides` 가 base 를 **그대로**(동일 객체) 돌려주므로 이 필드 이전과 bit-identical 이다.
 * 검증 실패는 여기서 throw → 호출부(runner-main)가 400 으로 매핑한다.
 */
export function simulate(
  req: SimulateRequest,
  baseConfig: EngineConfig = defaultEngineConfig,
): SimulateResponse {
  const { config, hash: effectiveHash } = applyOverrides(baseConfig, req.configOverrides);

  if (req.half === 1) {
    const carry = runFirstHalf(req.seed, req.homeInput, req.awayInput, req.selectData, config);
    const matchLog = carryToMatchLog(carry);
    return {
      matchLog,
      resumeState: serializeCarry(carry),
      lastHash: lastHashOf(matchLog),
      playbackMs: playbackMsOf(matchLog),
      effectiveConfigHash: effectiveHash,
    };
  }

  // half === 2, resumeState 있음: 전반 상태 승계 재개 → 후반분만 슬라이스해 반환.
  if (req.resumeState !== undefined) {
    const carry = deserializeCarry(req.resumeState, config);
    const half1TickCount = carry.snapshots.length;
    const half1EventCount = carry.events.length;
    const half1Score = { ...carry.state.score };
    const full = resumeSecondHalf(carry, req.homeInput, req.awayInput);
    const matchLog: MatchLog = {
      configVersion: full.configVersion,
      seed: full.seed,
      tickSnapshots: full.tickSnapshots.slice(half1TickCount),
      events: full.events.slice(half1EventCount),
      finalScore: {
        home: full.finalScore.home - half1Score.home,
        away: full.finalScore.away - half1Score.away,
      },
    };
    return {
      matchLog,
      lastHash: lastHashOf(matchLog),
      playbackMs: playbackMsOf(matchLog),
      effectiveConfigHash: effectiveHash,
    };
  }

  // half === 2, resumeState 없음: 로스터 교체 폴백 — 독립 후반 시뮬(연속성 손실 PoC 허용,
  // LLD-server-java §5.4). 엔진에 "이어받지 않는 단독 하프" 전용 API 가 없어 runFirstHalf 를
  // 재사용한다(틱 0 기점·홈 킥오프·half_whistle 종료 — 코스메틱 한계).
  // R2(#66) 지원 시 이 분기 제거.
  const carry = runFirstHalf(req.seed, req.homeInput, req.awayInput, req.selectData, config);
  const matchLog = carryToMatchLog(carry);
  return {
    matchLog,
    lastHash: lastHashOf(matchLog),
    playbackMs: playbackMsOf(matchLog),
    effectiveConfigHash: effectiveHash,
  };
}
