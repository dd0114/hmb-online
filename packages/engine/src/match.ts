import type {
  TacticalInput,
  SelectData,
  MatchLog,
  TickSnapshot,
  MatchEvent,
  TeamSide,
  TeamRoster,
  PlayerCard,
  PlayerAttributes,
} from "@hmb/shared";
import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import { buildById, playerAt, ballOwnerOf, isBallOwner } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import { defaultEngineConfig } from "./config";
import { createRng, hashSeed } from "./rng";
import { createPitch, slotToReal, clampToPitch, centerSpot } from "./pitch";
import { toFixed, fromFixed, stepToward, fdist } from "./fixedmath";
import { glueBallToOwner, advanceBall, kickBall } from "./ball";
import { decideBallOwner, decideOffBall, assignPresser, speedStep } from "./decision";
import { decideBallOwnerChain } from "./chain";
import { applyRunOrders, clearIntents, computeTeamPlan, gcIntents } from "./teamplan";
import {
  tryIntercept,
  tryTackle,
  resolveArrival,
  resolveShot,
  resetKickoff,
  restartThrowIn,
  restartGoalKick,
  restartCorner,
  restartFreeKick,
  restartPenalty,
  launchCornerCross,
  checkOffside,
} from "./contest";
import {
  deadBallZone,
  deadBallExcluded,
  deadBallBlocked,
  deadBallClearance,
  deadBallRetreatPoint,
  deadBallShapeTarget,
  deadBallUsesShape,
  deadBallPaceStep,
} from "./deadball";
import { computeSetPiecePlan } from "./setpiece";
import { attackGoal } from "./pitch";
import type { OutCross } from "./ball";
import { hashState } from "./hash";

/**
 * match — 결정론 매치 엔진의 핵심 API.
 *  - runMatch: 통짜 90분.
 *  - runFirstHalf / resumeSecondHalf: 하프타임 델타 주입 후 전반 종료 상태(좌표·속도·스코어·RNG)를
 *    이어받아 후반 재개. delta 를 전반과 동일 입력으로 주면 통짜 90분과 완전히 동일하다.
 *
 * 매 틱: perceive → decide → act → resolveContests → applyFatigue → emit.
 */

const DEFAULT_ATTRS: PlayerAttributes = {
  technical: 50,
  mental: 50,
  physical: 50,
  passing: 50,
  shooting: 50,
  tackling: 50,
  pace: 50,
  stamina: 50,
  positioning: 50,
};

function isGoalkeeper(role: string, position: string): boolean {
  return /gk|goalkeep|골키퍼/i.test(role) || /gk|goalkeep|골키퍼/i.test(position);
}

function findCard(roster: TeamRoster, playerId: string): PlayerCard | undefined {
  return roster.players.find((p) => p.playerId === playerId);
}

/** TacticalInput + roster → SimPlayer[]. */
function buildPlayers(
  input: TacticalInput,
  roster: TeamRoster,
  side: TeamSide,
  pitch: Pitch,
): SimPlayer[] {
  return input.players.map((pi) => {
    const card = findCard(roster, pi.playerId);
    const attrs = card ? card.attributes : DEFAULT_ATTRS;
    const base = slotToReal(pitch, pi.basePosition.x, pi.basePosition.y, side);
    const gk = isGoalkeeper(pi.role, card?.position ?? "");
    return {
      id: pi.playerId,
      side,
      role: pi.role,
      duty: pi.duty,
      behavior: pi.behavior,
      markTarget: pi.markTarget,
      mentalModifier: pi.mentalModifier,
      attrs,
      baseFx: { x: base.x, y: base.y },
      posFx: { x: base.x, y: base.y },
      targetFx: { x: base.x, y: base.y },
      fatigue: 0,
      isGK: gk,
      idHash: hashSeed(pi.playerId),
      dribbleStreak: 0,
      yellowCards: 0,
      seen: {},
    } satisfies SimPlayer;
  });
}

/** 하프타임 델타 적용: 전술/행동/기본위치 갱신, 좌표·피로·RNG 는 유지. */
function applyDelta(
  state: SimState,
  input: TacticalInput,
  side: TeamSide,
  pitch: Pitch,
): void {
  state.teams[side] = input.team;
  for (const pi of input.players) {
    const p = playerAt(state, side, pi.playerId);
    if (!p) continue;
    p.role = pi.role;
    p.duty = pi.duty;
    p.behavior = pi.behavior;
    p.markTarget = pi.markTarget;
    p.mentalModifier = pi.mentalModifier;
    const base = slotToReal(pitch, pi.basePosition.x, pi.basePosition.y, side);
    p.baseFx = { x: base.x, y: base.y };
  }
}

interface Carry {
  state: SimState;
  rng: Rng;
  nextTick: number;
  snapshots: TickSnapshot[];
  events: MatchEvent[];
  seed: string;
  config: EngineConfig;
  pitch: Pitch;
}

/** 총 틱 수. */
function totalTicks(config: EngineConfig): number {
  return Math.round((config.matchMinutes * 60 * 1000) / config.msPerTick);
}

/** 틱 → 경기 분. */
function tickToMinute(tick: number, config: EngineConfig): number {
  return Math.floor((tick * config.msPerTick) / 60000);
}

/** 현재 상태로 TickSnapshot 생성(실좌표 + 해시). */
function snapshot(state: SimState, config: EngineConfig): TickSnapshot {
  const scale = config.fixedScale;
  const round2 = (v: number): number => Math.round(fromFixed(v, scale) * 100) / 100;
  return {
    tick: state.tick,
    minute: tickToMinute(state.tick, config),
    ball: { x: round2(state.ball.posFx.x), y: round2(state.ball.posFx.y) },
    ballOwner: state.ball.owner,
    players: state.players.map((p) => ({
      playerId: p.id,
      team: p.side,
      pos: { x: round2(p.posFx.x), y: round2(p.posFx.y) },
    })),
    hash: hashState(state),
  };
}

/**
 * 공이 경계를 넘었을 때(out) 세트피스 판정.
 *  - 사이드라인 → 스로인(찬 팀 상대).
 *  - 골라인: 공격팀이 냄 → 골킥(수비팀) / 수비팀이 냄 → 코너(공격팀).
 * 슛은 resolveShot 에서 처리되므로 여기 out 은 사실상 패스(fail_out)/루즈볼.
 */
function resolveOut(carry: Carry, out: OutCross, tick: number, minute: number): void {
  const { state, config, pitch } = carry;
  const f = state.ball.flight;
  const fromSide: TeamSide = f?.fromSide ?? state.possession;
  const opp: TeamSide = fromSide === "home" ? "away" : "home";
  state.ball.flight = null;

  if (out.edge === "top" || out.edge === "bottom") {
    // 사이드라인 아웃 → 스로인(상대 볼).
    carry.events.push(restartThrowIn(state, pitch, config, opp, out.x, out.y, tick, minute));
    return;
  }
  // 골라인 아웃. 홈은 오른쪽(right=wFx) 공격, 어웨이는 왼쪽(left=0) 공격.
  const homeAttackLine = out.edge === "right";
  const attackerOfLine: TeamSide = homeAttackLine ? "home" : "away";
  if (fromSide === attackerOfLine) {
    // 공격팀이 냄 → 골킥(수비팀).
    carry.events.push(restartGoalKick(state, pitch, config, opp, tick, minute));
  } else {
    // 수비팀(fromSide)이 자기 골라인 밖으로 냄(클리어 등) → 코너는 **공격팀**(attackerOfLine)에게.
    // (구버전은 fromSide=수비팀을 restartCorner(side=..)에 넘겨 반대편 골라인에 수비팀 코너를
    //  만드는 스퓨리어스 코너 버그였음 — #110. restartCorner 의 side 는 코너를 얻는 공격팀.)
    carry.events.push(restartCorner(state, pitch, config, attackerOfLine, out.y, tick, minute));
  }
}

/** 한 틱 진행(perceive→decide→act→resolve→fatigue). 이벤트는 carry.events 로 push. */
function stepTick(carry: Carry): void {
  const { state, rng, config, pitch } = carry;
  const minute = tickToMinute(state.tick, config);

  // --- 세트피스 정지(dead ball): 재배치만 하고 결정/경합/공비행 스킵 ---
  if (state.stoppage > 0) {
    state.stoppage--;
    // #307: 팀 계획은 **정지 중에도** 갱신한다. 이전엔 이 분기가 먼저 return 해서 `state.plan` 이
    // 정지 진입 직전 값으로 굳었고(S1 이 주석으로 남긴 성질), 그래서 코너 깃발·스팟으로 공이
    // 옮겨간 뒤에도 라인이 옛 볼 위치를 가리켰다. 지금은 소비자가 없어 **동작 변화 0**(해시만
    // 움직인다). S3 가 정지 중 배치에 라인을 쓰려면 선행돼야 하는 성질이라 여기서 갚는다.
    state.plan = {
      home: computeTeamPlan(state, "home", config, pitch),
      away: computeTeamPlan(state, "away", config, pitch),
    };
    // #314 B: 공이 죽으면 런도 죽는다 — 정지 중 배치는 규칙기반(deadBallShapeTarget)이 소유하고,
    // 살아 있는 런 오더가 그 위에 남으면 #185/#174(제자리 왕복·단독 질주)를 되살린다.
    clearIntents(state);
    // #231: 소유자는 (id, side) 쌍으로 잡는다 — id 만 보면 반대 팀 동명 선수까지 "소유자 취급"돼
    // 그 틱의 재배치를 못 받는다. 캡처 시점 값을 쓰는 의미는 그대로 보존한다.
    const heldId = state.ball.owner;
    const heldSide = state.ball.ownerSide;
    // #176: 실제 축구 규칙(Law 8/13/14/15/16/17) — 재시작 팀의 상대는 스팟에서 물러나 있어야 한다.
    // 이게 없으면 상대가 정지 내내 스팟까지 걸어 들어와, 정지가 끝나는 순간 바로 옆에서
    // 태클/인터셉트로 강탈한다(골킥이면 박스 안 키퍼에게서 뺏어 즉시 실점).
    const zone = deadBallZone(state, config, pitch);
    const shapeSp = state.setPiece && deadBallUsesShape(state.setPiece.kind) ? state.setPiece : null;
    // #307: 세트피스 역할 배정(프리킥 벽·백업)은 **팀 전체를 보는** 계산이라 선수 루프 **앞에서
    // 틱당 1회**만 한다(결정론 규율 §5-1 — `teamplan` 과 같은 자리·같은 이유).
    const spPlan = shapeSp ? computeSetPiecePlan(state, pitch, config, shapeSp, zone) : null;
    // #307 H3: 도착 페이싱에서 제외할 선수(제때 도착이 계약인 선수). 아래 배치 루프에서 채운다.
    const noPace = new Set<SimPlayer>();
    for (const p of state.players) {
      if (p.id === heldId && p.side === heldSide) {
        noPace.add(p); // taker — walkStoppage(#59)가 도달 틱을 정한다. 늦추면 공에 못 닿는다.
        continue;
      }
      // #185/#174: 정지 중엔 평소 오프더볼 로직(자기 위치·시야 피드백) 대신 **규칙기반 정적 배치**.
      // 상황이 안 변하는 구간에서 매 틱 재계산하면 목표가 자기 위치를 따라 흔들려 제자리 왕복이
      // 생기고(#185), 전원이 굳은 뒤 한 명만 기억 만료로 새 타깃을 받아 혼자 질주한다(#174).
      if (shapeSp) p.targetFx = deadBallShapeTarget(state, pitch, config, p, shapeSp, spPlan);
      else decideOffBall(state, p, config, pitch, null);
      if (!zone || !deadBallExcluded(p, zone)) continue;
      // 구역 안에 있으면 전술 목표보다 **나가는 것이 우선**(안 그러면 반대편 목표로 가느라
      // 스팟을 더 가깝게 지나친다). 목표만 안이면 경계까지 = 벽 세우고 서기.
      const inside = deadBallClearance(zone, p.posFx.x, p.posFx.y) < 0;
      const targetInside = deadBallClearance(zone, p.targetFx.x, p.targetFx.y) < 0;
      if (inside || targetInside) {
        p.targetFx = deadBallRetreatPoint(pitch, zone, config, p.posFx.x, p.posFx.y);
        // 후퇴는 재시작 틱까지 **반드시** 끝나야 한다(Law 계약 A) → 페이싱 제외.
        noPace.add(p);
      }
    }
    // 코너는 **더 느슨한 상한**을 쓴다 — 코너 정지 중 배치(rest defence, #182)는 하프라인까지 40m 를
    // 오가야 성립하는데 걷기 속도로 묶으면 정지 안에 도달을 못 해 그 계약이 깨진다(실측: '뒤를 봐라'
    // 지시받은 공격수의 잔류율 0). 무제한으로 두면 정지 중 최대 변위가 질주 수준으로 남으므로(#174)
    // 중간값을 쓴다. 정적 배치에서 코너를 뺀 것과 같은 경계다.
    const walkCap = toFixed(
      shapeSp != null ? config.rules.deadBall.walkSpeedM : config.rules.deadBall.cornerWalkSpeedM,
      config.fixedScale,
    );
    for (const p of state.players) {
      // #174: 데드볼엔 뛰지 않고 **걸어서** 자리를 잡는다 — 정지 중엔 공도 멈춰 있어서 한 명만
      // 풀스피드로 가로지르면 "공보다 선수가 빠른" 그림이 된다(실측 최대 6.4 m/tick).
      // taker 도 포함한다. walkStoppage(#59)가 **같은 상한**으로 도달 틱을 산정하므로 도달은 보장된다.
      //
      // #307 H3: 그 위에 **재시작 시각에 맞춘 도착 페이싱**을 한 겹 더 얹는다 — 목표는 그대로 두고
      // 남은 거리를 남은 틱에 펴서 걷는다. 창 후반에 전원이 굳는 그림(정지 21.4%)이 사라지면서
      // 목표가 안 움직이므로 왕복(#185)은 구조적으로 생기지 않는다. remain = 이번 틱 포함 남은 틱.
      const paceCap = noPace.has(p) ? Infinity : deadBallPaceStep(config, p, state.stoppage + 1);
      const step = Math.min(speedStep(p, config), walkCap, paceCap);
      const next = stepToward(p.posFx.x, p.posFx.y, p.targetFx.x, p.targetFx.y, step);
      const c = clampToPitch(pitch, next.x, next.y);
      if (zone && deadBallExcluded(p, zone) && deadBallBlocked(zone, p, c)) continue;
      p.posFx.x = c.x;
      p.posFx.y = c.y;
    }
    // #59: 정지 중 공은 배치된 스팟에 그대로 둔다(글루 안 함) — taker 는 targetFx(스팟)로 걸어와
    // 공을 잡는 자연 무브먼트가 스냅샷에 남고, 공은 스팟에서 드리프트하지 않는다. 재시작(freeze-end)은
    // 공(스팟)으로 실행. (기존: 공을 owner 에 글루 → taker 가 걸으면 공이 딸려가 드리프트했음.)
    // 정지가 끝나면 재개 처리.
    if (state.stoppage === 0) {
      const sp = state.setPiece;
      // shot_out 재시작은 새 세트피스(코너/골킥)를 설정하므로 그 setPiece/stoppage 를 보존.
      let keepSetPiece = false;
      if (sp && (sp.kind === "goal" || sp.kind === "kickoff")) {
        // 정식 킥오프: 골 세리머니 종료(공은 그동안 네트에 머묾) 또는 후반 시작 정지 종료 →
        // 재개팀(실점팀/어웨이) 센터 킥오프. 공을 센터·재개팀 소유로 두고, 전 선수를 t0 킥오프
        // 포메이션으로 되돌린다(정지 종료 틱에 리셋 → 그 틱 스냅샷이 정렬 배치를 크리스프하게 담음).
        resetKickoff(state, pitch, sp.side, config);
        // kickoff MatchEvent emit(재개팀 표기, detail 없음 = 골 후/후반 재시작 — 뷰어 playback 이
        // detail 없는 kickoff 를 "포메이션 리셋 지점"으로 인식).
        carry.events.push({ tick: state.tick, minute, type: "kickoff", team: sp.side });
      } else if (sp && sp.kind === "shot_out") {
        // 슛 아웃(세이브 굴절/빗맞음) 정지 종료 → 실제 세트피스(코너/골킥) 시작.
        // 이 단계에서 비로소 공이 코너 깃발/골킥 스팟에 놓인다(정지 프레임과 함께).
        const r = sp.restart;
        if (r && r.kind === "corner") {
          carry.events.push(restartCorner(state, pitch, config, r.side, r.nearY, state.tick, minute));
          keepSetPiece = true;
        } else if (r && r.kind === "goal_kick") {
          carry.events.push(restartGoalKick(state, pitch, config, r.side, state.tick, minute));
          keepSetPiece = true;
        } else if (r && r.kind === "penalty") {
          // 2단계 페널티: 파울 비트 정지 종료 → 이제 공을 페널티 스팟에 배치(테이커 걸어옴) + penalty
          // 이벤트 emit(뷰어가 "페널티킥!" + 공 컷으로 스팟 이동을 가림). 다음 정지 종료 시 킥 발사.
          restartPenalty(state, pitch, config, r.side, state.tick, minute);
          carry.events.push({ tick: state.tick, minute, type: "penalty", team: r.side });
          keepSetPiece = true;
        }
      } else if (sp && sp.kind === "penalty") {
        // 페널티 정지 종료 → 테이커(공 소유자)가 상대 골로 고xG 슛 발사.
        const taker = ballOwnerOf(state) ?? null;
        if (taker) {
          const g = attackGoal(pitch, taker.side);
          // #320: 페널티도 **골문 방향 속도**로 찬다(구: 골문을 목표로 보간).
          state.ball.flight = kickBall(
            state.ball.posFx.x,
            state.ball.posFx.y,
            g.x,
            g.y,
            toFixed(config.contest.shotBallSpeed, config.fixedScale),
            {
              kind: "shot",
              delivery: "ground",
              target: taker.id,
              fromSide: taker.side,
              xg: config.rules.penalty.xg,
            },
          );
          state.ball.owner = null;
          state.ball.ownerSide = null;
          carry.events.push({
            tick: state.tick,
            minute,
            type: "shot",
            team: taker.side,
            playerId: taker.id,
            xg: config.rules.penalty.xg,
            detail: "penalty",
          });
        }
      } else if (sp && sp.kind === "corner") {
        // 코너 정지 종료 → taker 가 공을 박스 중앙으로 크로스(드리블로 몰고 나가지 않게, #31).
        // setPiece 는 아래서 null → 다음 틱부터 크로스 비행이 advanceBall 로 진행, resolveArrival 로 경합.
        launchCornerCross(state, pitch, config, rng);
      }
      // #176: 규칙상 상대가 물러나 있어야 하는 건 "공이 **인플레이 될 때까지**" 다 — 정지 카운터가
      // 0 이 되는 순간이 아니다. taker 가 공을 발밑에 두고 서 있는(아직 안 찬) 재시작은 setPiece 를
      // 살려둬 접근 금지를 유지하고, taker 가 실제로 공을 찰 때(패스/슛/드리블) 해제한다.
      // 안 그러면 정지 종료 틱에 상대가 한 번에 몰려들어(실측 +0.06m → −4.8m 한 틱 점프) 픽스가
      // 강탈을 8틱 미루는 데 그친다. 코너·페널티는 정지 종료 즉시 공이 떠나므로 해당 없음.
      const held = state.setPiece;
      if (held && (held.kind === "goal_kick" || held.kind === "throw_in" || held.kind === "free_kick" || held.kind === "kickoff")) {
        keepSetPiece = true;
      }
      if (!keepSetPiece) state.setPiece = null;
    }
    return;
  }

  // --- 팀 계획(틱당 1회) ---
  // #279 S1: 팀 단위 파생 상태는 **여기서만** 계산한다 — decide 루프 **앞**이라 선수 순회 순서와
  // 무관하고(결정론 규율 §5-1), `decideOffBall` 안에서 계산하면 그 함수가 `player.seen` 을 변이하는
  // 탓에 배열 순서 의존이 생긴다. 현재는 아무도 소비하지 않는다(S3 수비 구조가 첫 소비자).
  //
  // ⚠️ **정지(stoppage) 틱에는 갱신되지 않는다** — 위 정지 분기가 먼저 return 하기 때문이다.
  // 즉 정지 중 `plan.lineX` 는 정지 진입 직전의 공 x 로 고정된 채 해시에 들어간다(재현 가능하므로
  // 결정론엔 무해). S3 가 **정지 중 배치**에도 라인을 쓰려면 이 성질을 먼저 바꿔야 한다 —
  // 지금 구조에서는 코너 깃발·스팟으로 공이 옮겨간 뒤에도 라인이 옛 볼 위치를 가리킨다.
  state.plan = {
    home: computeTeamPlan(state, "home", config, pitch),
    away: computeTeamPlan(state, "away", config, pitch),
  };
  // #314 B: 만료된 의도·런 오더 폐기(틱당 1회, 배열 순서 보존).
  gcIntents(state);

  // --- 압박 담당 지정(수비팀만) ---
  const defSide: TeamSide = state.possession === "home" ? "away" : "home";
  const presser = assignPresser(state, defSide);

  // --- decide: 오프더볼/수비 목표 ---
  const ownerId = state.ball.owner;
  const ownerSide = state.ball.ownerSide; // #231: id 단독 비교 금지(반대 팀 동명 선수)
  // #176: 아직 안 찬 세트피스(taker 가 공을 들고 서 있음)면 접근 금지가 계속 유효하다.
  // 정지는 끝났지만 규칙상 공은 아직 인플레이가 아니다 → 압박 배정보다 규칙이 우선.
  const liveZone = deadBallZone(state, config, pitch);
  // 아직 안 찬 세트피스(taker 가 공을 들고 서 있음) = 규칙상 공이 인플레이가 아닌 구간.
  // 정지 브랜치와 **같은 규율**(규칙기반 배치 + 걷기 속도)을 적용한다 — 안 그러면 정지가 끝나는
  // 순간 이 구간에서만 평소 로직이 되살아나 왕복·단독질주가 그대로 남는다(실측 최대 6.3 m/tick).
  const liveSp = state.setPiece && deadBallUsesShape(state.setPiece.kind) ? state.setPiece : null;
  // #307: 정지 브랜치와 같은 규율 — 세트피스 역할 배정은 decide 루프 앞, 틱당 1회.
  const liveSpPlan = liveSp ? computeSetPiecePlan(state, pitch, config, liveSp, liveZone) : null;
  for (const p of state.players) {
    if (p.id === ownerId && p.side === ownerSide) continue;
    // 볼을 안 가진 선수는 드리블 체인 리셋(활성 캐리어만 연속 누적).
    p.dribbleStreak = 0;
    const pa = p.side === defSide ? presser : null;
    if (liveSp) p.targetFx = deadBallShapeTarget(state, pitch, config, p, liveSp, liveSpPlan);
    else decideOffBall(state, p, config, pitch, pa);
    if (!liveZone || !deadBallExcluded(p, liveZone)) continue;
    const inside = deadBallClearance(liveZone, p.posFx.x, p.posFx.y) < 0;
    const targetInside = deadBallClearance(liveZone, p.targetFx.x, p.targetFx.y) < 0;
    if (inside || targetInside) {
      p.targetFx = deadBallRetreatPoint(pitch, liveZone, config, p.posFx.x, p.posFx.y);
    }
  }

  // 이번 틱에 막 쏜 슛인지 — 그렇다면 이 틱엔 공을 슈터 발밑에 두고 다음 틱부터
  // 골문으로 비행시킨다(같은 틱 순간 해상 방지 → 눈에 보이는 슛 궤적 확보).
  let shotLaunchedThisTick = false;

  // --- decide: 볼 소유자 행동 ---
  // 아직 안 찬 세트피스에서 taker 가 스팟에 **도달하기 전**이면 행동 결정을 하지 않는다(#59/#176).
  // 규칙상 공은 스팟에 놓여 있고 taker 는 걸어가 잡는 중이다 — 여기서 hold 를 결정하게 두면
  // taker 가 그 자리에 서고 공이 taker 에게 글루돼 스팟에서 끌려간다(실측 2.5m 드리프트).
  const takerWalkingIn =
    liveSp != null &&
    ownerId != null &&
    (() => {
      // #231: 소유자는 **(ownerSide, owner)** 로 찾는다. id 단독이면 같은 id 의 반대 팀 선수가
      // 잡혀 이 거리 판정이 영구 참이 되고, 아래 `decideBallOwner` 가 한 번도 안 불려 하프가 죽는다.
      const o = ballOwnerOf(state);
      return o ? fdist(o.posFx.x, o.posFx.y, liveSp.x, liveSp.y) > config.contest.controlRange * config.fixedScale : false;
    })();
  if (takerWalkingIn && ownerId) {
    const o = ballOwnerOf(state);
    if (o) o.targetFx = { x: liveSp!.x, y: liveSp!.y };
  }
  if (ownerId && !state.ball.flight && !takerWalkingIn) {
    const owner = ballOwnerOf(state);
    if (owner) {
      // #279 W2: 볼 소유자 결정 코어 교체 스위치. "weighted"(기본) = 기존 즉시점수 가중추첨,
      // "chain" = 행동 사슬 EV 탐색. 반환 계약(Action)이 같아 이 아래 코드는 어느 코어인지 모른다.
      const action =
        config.chain.mode === "chain"
          ? decideBallOwnerChain(state, owner, rng, config, pitch)
          : decideBallOwner(state, owner, rng, config, pitch);
      // #176: taker 가 공을 실제로 플레이하면(패스/슛/드리블) 그 순간 공이 인플레이 → 접근 금지 해제.
      // hold 는 아직 안 찬 것이므로 유지한다. (offside 등 새 세트피스는 아래서 setPiece 를 덮어쓴다.)
      if (liveZone && action.kind !== "hold") state.setPiece = null;
      switch (action.kind) {
        case "shoot": {
          // #312: 세기는 **행동이 들고 온다**. #320: 그 세기를 조준 **방향**에 실어 속도로 준다 —
          // 슛은 골문까지 거의 등속으로 꽂히고(friction.shot 0.96) 목표 근처에서 감속하지 않는다.
          state.ball.flight = kickBall(
            state.ball.posFx.x,
            state.ball.posFx.y,
            action.toX,
            action.toY,
            action.speedFx,
            {
              kind: "shot",
              delivery: "ground",
              target: owner.id,
              fromSide: owner.side,
              xg: action.xg,
            },
          );
          shotLaunchedThisTick = true;
          owner.dribbleStreak = 0;
          state.ball.owner = null;
          state.ball.ownerSide = null;
          carry.events.push({
            tick: state.tick,
            minute,
            type: "shot",
            team: owner.side,
            playerId: owner.id,
            xg: action.xg,
            detail: action.detail,
          });
          owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
          break;
        }
        case "pass": {
          // 오프사이드: 전진 패스 순간 리시버가 2nd-last 수비수보다 앞이면 수비팀 프리킥.
          if (checkOffside(state, rng, config, pitch, owner, action.receiver)) {
            owner.dribbleStreak = 0;
            carry.events.push({
              tick: state.tick,
              minute,
              type: "offside",
              team: owner.side,
              playerId: action.receiver.id,
            });
            carry.events.push(
              restartFreeKick(
                state,
                pitch,
                config,
                defSide,
                action.receiver.posFx.x,
                action.receiver.posFx.y,
                state.tick,
                minute,
                "offside",
              ),
            );
            break;
          }
          // #320: 조준점(`action.toX/toY`)은 **방향과 계획 낙하점**만 준다 — 공의 운동은
          // `방향 × 세기`의 속도 벡터다. `toX/toY` 는 계획 창(passOutcome)의 종료 시점을
          // 재는 기준으로만 실려 간다(`ball.ts:passedPlanPoint`).
          state.ball.flight = kickBall(
            state.ball.posFx.x,
            state.ball.posFx.y,
            action.toX,
            action.toY,
            // #312: 상수 `ball.passSpeed` 대입 → 선수가 정한 세기.
            action.speedFx,
            {
              kind: "pass",
              // #306: 지상/공중 종류. lofted 는 마찰이 거의 없어 박스까지 직선으로 간다.
              delivery: action.lofted ? "lofted" : "ground",
              hangTicks: action.lofted
                ? Math.max(1, Math.ceil(fdist(state.ball.posFx.x, state.ball.posFx.y, action.toX, action.toY) / Math.max(1, action.speedFx)))
                : 0,
              target: action.receiver.id,
              fromSide: owner.side,
              passOutcome: action.outcome,
              long: action.long,
              // #181: 이 공을 결국 잡을 사람 — 리드패스로 조준해 공과 만난다(순간이동 제거).
              claimant: action.claimant ? action.claimant.id : undefined,
            },
          );
          owner.dribbleStreak = 0;
          state.ball.owner = null;
          state.ball.ownerSide = null;
          // #314 B: **의도 게시** — 이 패스가 어디로 가는지를 팀이 볼 수 있게 남긴다.
          // S1 이 만들어 둔 `state.intents` 의 첫 쓰기다. 읽기는 `applyRunOrders`(아래) 와
          // 수비의 `decideOffBall`(런 오더를 통해 간접). push 순서는 틱당 최대 1건이라 고정.
          {
            const g = attackGoal(pitch, owner.side);
            const passGainFx =
              fdist(owner.posFx.x, owner.posFx.y, g.x, g.y) - fdist(action.toX, action.toY, g.x, g.y);
            const ro = config.movement.runOrder;
            // **전진 패스에만** 런이 붙는다. 모든 패스에 붙이면 팀 전체가 상시 전진 배치가 되어
            // 공격이 과열된다(실측 슛/팀 12.5 → 20.1). 서드맨 런은 전진 패스에 붙는 것이다.
            if (ro.enabled && passGainFx >= Math.round(ro.minPassGainM * config.fixedScale)) {
              const flightTicks = Math.max(
                1,
                Math.ceil(
                  fdist(state.ball.posFx.x, state.ball.posFx.y, action.toX, action.toY) /
                    Math.max(1, action.speedFx),
                ),
              );
              state.intents.push({
                side: owner.side,
                fromId: owner.id,
                kind: "pass_to",
                xFx: action.toX,
                yFx: action.toY,
                tick: state.tick,
                expiresTick: state.tick + flightTicks,
                forId: action.receiver.id,
              });
            }
          }
          // #314 B: 패서의 **따라 들어가기**. 구버전은 여기서 무조건 제자리에 세웠고(hero ⓑ 의
          // 코드상 실체 — 실측 "패스 후 패서 전진 0%"), 그래서 "차고 나서 뛰어들어가는" 그림이
          // 구조적으로 불가능했다. 단 **전진 패스일 때만** 푼다 — 뒤로 뺀 패스를 따라가면
          // 되돌아 달리기가 되어 공격을 죽인다(#181 가드).
          {
            const ro = config.movement.runOrder;
            const followFx = Math.round(ro.passerFollowM * config.fixedScale);
            const g = attackGoal(pitch, owner.side);
            const gainFx =
              fdist(owner.posFx.x, owner.posFx.y, g.x, g.y) - fdist(action.toX, action.toY, g.x, g.y);
            // 런 오더와 **같은 게이트**(전진 패스에만) — 매 패스마다 따라 들어가면 공격 라인이
            // 상시 전진해 볼륨이 과열된다(실측 슛/팀 12.2 → 15.3).
            if (followFx > 0 && gainFx >= Math.round(ro.minPassGainM * config.fixedScale)) {
              const dx = action.toX - owner.posFx.x;
              const dy = action.toY - owner.posFx.y;
              // 길이는 정수 제곱근으로(플랫폼 편차 0, §5-4 — `Math.sqrt` 직접 호출 금지 관례).
              const len = Math.max(1, fdist(owner.posFx.x, owner.posFx.y, action.toX, action.toY));
              const t = clampToPitch(
                pitch,
                owner.posFx.x + Math.round((dx * followFx) / len),
                owner.posFx.y + Math.round((dy * followFx) / len),
              );
              owner.targetFx = { x: t.x, y: t.y };
            } else {
              owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
            }
          }
          break;
        }
        case "clearance": {
          // #314 A(hero ⓐ): 걷어내기 — **의도 수신자가 없다**. `passOutcome`/`claimant`/`target`
          // 을 달지 않으므로 도착은 순수 기하(양 팀 루즈볼·헤딩 경합)로 간다. 그래서 벤치
          // 78–85% 패스 성공률 캘리브레이션(`passOutcomeAuthoritative`)을 건드리지 않는다.
          // #320 통합: 공이 **속도 벡터** 권위로 바뀌었으므로 flight 를 손으로 짜지 않고
          // `kickBall`(방향×세기 → v)로 만든다. 안 그러면 vxFx/vyFx 가 비어 공이 안 움직인다.
          state.ball.flight = kickBall(
            state.ball.posFx.x,
            state.ball.posFx.y,
            action.toX,
            action.toY,
            action.speedFx,
            {
              kind: "pass",
              delivery: action.lofted ? "lofted" : "ground",
              hangTicks: action.lofted
                ? Math.max(
                    1,
                    Math.ceil(
                      fdist(state.ball.posFx.x, state.ball.posFx.y, action.toX, action.toY) /
                        Math.max(1, action.speedFx),
                    ),
                  )
                : 0,
              fromSide: owner.side,
            },
          );
          owner.dribbleStreak = 0;
          state.ball.owner = null;
          state.ball.ownerSide = null;
          owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
          carry.events.push({
            tick: state.tick,
            minute,
            type: "clearance",
            team: owner.side,
            playerId: owner.id,
          });
          break;
        }
        case "dribble": {
          owner.dribbleStreak = Math.min(config.variety.dribbleChainMaxTicks, owner.dribbleStreak + 1);
          owner.targetFx = { x: action.toX, y: action.toY };
          break;
        }
        case "hold": {
          owner.dribbleStreak = 0;
          owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
          break;
        }
      }
    }
  }

  // 오프사이드 등으로 이번 틱 decide 단계에서 dead-ball 이 설정되면 이동·경합·피로를
  // 건너뛴다(정지 재개는 다음 틱 stoppage 브랜치가 처리). 슛/패스 비행은 stoppage 를 안 건드림.
  if (state.stoppage > 0) return;

  // --- 런 오더 배정 + 소비(#314 B) ---
  // decide 루프 **뒤 · act 루프 앞**이다. 패스는 오프더볼 결정이 끝난 뒤에 결정되므로, 여기가
  // "차면 **그 틱에** 뛰어들어간다"가 성립하는 유일한 자리다(앞에서 돌면 러너가 항상 1틱 늦는다).
  // 팀 전체를 보는 계산이라 선수 루프 밖·틱당 1회 — `computeTeamPlan` 과 같은 규율(§5-1).
  // 아직 안 찬 세트피스(liveSp) 구간은 규칙기반 배치가 소유하므로 건너뛴다(#174/#185 재발 방지).
  if (!liveSp) applyRunOrders(state, config, pitch);

  // --- act: 선수 이동 ---
  for (const p of state.players) {
    // 아직 안 찬 세트피스 구간은 정지와 동일하게 걷기 속도(#174).
    const raw = speedStep(p, config);
    const step = liveSp ? Math.min(raw, toFixed(config.rules.deadBall.walkSpeedM, config.fixedScale)) : raw;
    const next = stepToward(p.posFx.x, p.posFx.y, p.targetFx.x, p.targetFx.y, step);
    const c = clampToPitch(pitch, next.x, next.y);
    // #176: 아직 안 찬 세트피스면 정지 때와 같은 일방통행 벽을 유지(직선 경로 가로지르기 차단).
    if (liveZone && deadBallExcluded(p, liveZone) && deadBallBlocked(liveZone, p, c)) continue;
    p.posFx.x = c.x;
    p.posFx.y = c.y;
  }

  // --- act: 공 이동 + 경합 ---
  const curOwnerId = state.ball.owner;
  const curOwnerSide = state.ball.ownerSide; // #231: 피로 판정도 (id, side) 쌍
  if (state.ball.flight && shotLaunchedThisTick && state.ball.flight.kind === "shot") {
    // 막 쏜 틱: 공은 슈터 위치 그대로(비행은 다음 틱부터). 스냅샷에 슈터 발밑이 찍힌다.
  } else if (state.ball.flight) {
    // #320: 공은 속도 벡터로 전진하고, 판정은 그 결과를 읽는다(구: "목표 도달 = 도착").
    const wasShot = state.ball.flight.kind === "shot";
    const res = advanceBall(state.ball, config, pitch);
    if (wasShot) {
      // 슛: 골문(계획 낙하점)에 닿는 틱에 판정. 골문은 물리적 벽이라 `out` 으로 새지 않는다.
      if (res.passedPlan) {
        for (const e of resolveShot(state, rng, config, pitch, state.tick, minute)) {
          carry.events.push(e);
        }
      } else if (res.out) {
        // 조준이 라인 쪽으로 크게 빗나간 슛 — 세트피스는 resolveShot 이 만들지 못했으므로
        // 여기서 일반 아웃(스로인/골킥/코너)으로 처리한다.
        resolveOut(carry, res.out, state.tick, minute);
      } else if (res.stopped) {
        // 방어: 슛이 골문 전에 마찰로 서면(현 config 에선 기하학적으로 불가 — 감속 거리 200m+)
        // 그 자리에서 해소한다. 안 그러면 비행이 영원히 남아 하프가 죽는다.
        for (const e of resolveShot(state, rng, config, pitch, state.tick, minute)) {
          carry.events.push(e);
        }
      }
    } else if (res.out) {
      resolveOut(carry, res.out, state.tick, minute);
    } else {
      // 패스/루즈볼: **매 틱** 접촉 판정. 계획 낙하점 전이면 `resolveArrival` 이 스스로 빠지고
      // (계획 창 보존, contest.ts 주석), 그 구간은 예전과 동일하게 확률 인터셉트만 작동한다.
      const evs = resolveArrival(state, rng, config, pitch, state.tick, minute, res);
      for (const e of evs) carry.events.push(e);
      // 아직 계획 창 안에서 날아가는 패스만 인터셉트 롤 대상이다(`tryIntercept` 가 kind 로 거른다 —
      // 낙하점을 지나면 `resolveArrival` 이 kind 를 "loose" 로 내려 롤이 자동으로 멈춘다).
      if (evs.length === 0) {
        for (const e of tryIntercept(state, rng, config, state.tick, minute)) {
          carry.events.push(e);
        }
      }
    }
  } else if (curOwnerId && state.setPiece) {
    // 아직 안 찬 세트피스: 규칙상 공은 **스팟에 놓여 있고 인플레이가 아니다**.
    // 공을 taker 에게 글루하지 않고(끌려가면 스팟 이탈), 태클도 성립하지 않는다 —
    // 이 두 줄이 #176 강탈 경로의 마지막 구멍이다(스로인 금지반경 2m ≈ tackleRange 2m 경계).
  } else if (curOwnerId) {
    const owner = ballOwnerOf(state);
    if (owner) glueBallToOwner(state.ball, owner.posFx.x, owner.posFx.y);
    for (const e of tryTackle(state, rng, config, pitch, state.tick, minute)) {
      carry.events.push(e);
    }
  }

  // --- applyFatigue ---
  for (const p of state.players) {
    // #231: 소유자는 (id, side) 쌍, 압박 담당은 **객체 동일성**(같은 id 의 반대 팀 선수 오인 방지).
    // ⚠️ 캡처 시점(curOwner*) 값을 쓴다 — 여기서 state 를 다시 읽으면 틱 중간의 소유권 이전이
    //    피로에 반영돼 동작이 바뀐다(실측: 골든 7건 깨짐).
    const active = (p.id === curOwnerId && p.side === curOwnerSide) || p === presser;
    const exertion = p.isGK ? 0.3 : active ? 1.6 : 1.0;
    p.fatigue = Math.min(1, p.fatigue + config.fatiguePerTick * exertion);
  }
}

/** carry 의 nextTick 부터 endTick(미포함) 까지 시뮬레이션하며 스냅샷/이벤트 수집. */
function simulateRange(carry: Carry, endTick: number): void {
  const { state, config } = carry;
  for (let t = carry.nextTick; t < endTick; t++) {
    state.tick = t;
    stepTick(carry);
    carry.snapshots.push(snapshot(state, config));
  }
  carry.nextTick = endTick;
}

/**
 * 하프/경기 경계에서 **비행 중인 슛을 마저 해소**한다(#178 후속).
 *
 * 슛은 발사 틱에 공이 움직이지 않고(슈터 발밑 프레임, `shotLaunchedThisTick`) 다음 틱부터
 * 비행한다. 하프 **마지막 틱**에 쏘면 그 "다음 틱"이 하프타임 킥오프 리셋이라 `ball.flight` 가
 * 통째로 버려져 유효/빗나감/골 판정이 영원히 안 나온다 → `onTarget + offTarget ≠ shots`
 * (실측: 쇼케이스 데모 t719 홈 슛 1개 증발). 경기 종료 틱도 같다.
 * 실제 축구도 공이 죽을 때까지는 플레이하므로 경계에서 비행을 끝까지 진행시켜 결과를 남긴다.
 *
 * 결정론: `runMatch`(통짜)와 `runFirstHalf`+`resumeSecondHalf`(분할)에서 **같은 지점**에 호출해야
 * rng 소비가 일치한다(계약 = shot-settle.test.ts 재개 동일성). 해소 후 마지막 스냅샷을 갱신해
 * "골 이벤트인데 공은 슈터 발밑" 같은 이벤트↔화면 불일치도 막는다.
 */
function settleInFlightShot(carry: Carry): void {
  const { state, rng, config, pitch } = carry;
  if (state.ball.flight?.kind !== "shot") return;
  const minute = tickToMinute(state.tick, config);
  // 상한은 하드코딩이 아니라 기하로 도출: 피치를 가로지르는 데 필요한 틱 + 여유.
  // #312: 슛 세기가 선수마다 달라졌으므로 config 상수가 아니라 **이 슛의 실제 속도**로 계산한다
  // (상수로 두면 느리게 찬 슛이 상한 안에 골문까지 못 가 무음으로 증발한다).
  const speedM = fromFixed(state.ball.flight.speed, config.fixedScale);
  const maxSteps = Math.ceil(config.pitch.width / Math.max(0.5, speedM)) + 2;
  for (let i = 0; i < maxSteps; i++) {
    if (state.ball.flight?.kind !== "shot") break;
    const res = advanceBall(state.ball, config, pitch);
    if (res.passedPlan) {
      for (const e of resolveShot(state, rng, config, pitch, state.tick, minute)) carry.events.push(e);
      break;
    }
    if (res.out) {
      // 슛은 골문(계획 낙하점)에서 먼저 해소되므로 여기 오기 어렵다. 와도 하프가 끝났으므로
      // 재시작 세트피스를 만들지 않고 비행만 정리한다.
      state.ball.flight = null;
      break;
    }
    // #320: 마찰로 슛이 골문 앞에 서면(아주 약한 슛) 더 굴러도 판정이 안 나온다 — 무음 증발을
    // 막기 위해 정지한 순간 그 자리에서 해소한다(슛 결과 완결 계약 #178).
    if (res.stopped) {
      for (const e of resolveShot(state, rng, config, pitch, state.tick, minute)) carry.events.push(e);
      break;
    }
  }
  // 해소 결과를 마지막 스냅샷에 반영(이벤트와 화면이 어긋나지 않게).
  if (carry.snapshots.length > 0) carry.snapshots[carry.snapshots.length - 1] = snapshot(state, config);
}

/** 초기 상태 구성 + 킥오프. */
function initCarry(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  select: SelectData,
  config: EngineConfig,
): Carry {
  const pitch = createPitch(config);
  const rng = createRng(seed);
  const homePlayers = buildPlayers(home, select.home, "home", pitch);
  const awayPlayers = buildPlayers(away, select.away, "away", pitch);
  const players = [...homePlayers, ...awayPlayers];
  const byId = buildById(players);

  const state: SimState = {
    players,
    byId,
    ball: { posFx: { x: 0, y: 0 }, owner: null, ownerSide: null, flight: null },
    score: { home: 0, away: 0 },
    possession: "home",
    tick: 0,
    seedHash: hashSeed(seed),
    teams: { home: home.team, away: away.team },
    stoppage: 0,
    setPiece: null,
    possessionSince: 0,
    lastTurnover: null,
    // 첫 stepTick 이 덮어쓴다. 초기값도 같은 순수 함수로 만들어 "초기 상태 해시"가 계획과 정합.
    plan: { home: { lineX: 0, blockDepth: 0 }, away: { lineX: 0, blockDepth: 0 } },
    // S4/S5 가 소비할 자리. S1 에서는 값이 절대 바뀌지 않는다(항상 "open" · 빈 배열).
    phase: { home: "open", away: "open" },
    intents: [],
  };
  state.plan = {
    home: computeTeamPlan(state, "home", config, pitch),
    away: computeTeamPlan(state, "away", config, pitch),
  };

  const carry: Carry = {
    state,
    rng,
    nextTick: 0,
    snapshots: [],
    events: [],
    seed,
    config,
    pitch,
  };

  // 킥오프: 홈이 센터에서 시작. 1틱 킥오프 정지(setPiece kind "kickoff" + stoppage 1)로 예약 →
  // tick 0 종료 시 stepTick 정지-종료 경로가 포메이션 리셋 + kickoff 이벤트를 수행한다(골 후/후반
  // 킥오프와 완전히 동일 경로 → tick0 스냅샷이 정렬된 킥오프 포메이션을 크리스프하게 담고,
  // 골·후반 킥오프 배치가 t0 슬롯과 정확히 일치한다).
  const c = centerSpot(pitch);
  state.setPiece = { kind: "kickoff", side: "home", x: c.x, y: c.y };
  state.stoppage = 1;
  return carry;
}

/**
 * 후반 시작 킥오프 예약: 전반에 킥오프하지 않은 팀(어웨이)이 센터에서 재개.
 * 1틱짜리 킥오프 정지(setPiece kind "kickoff" + stoppage 1)를 걸어, 첫 후반 틱(half) 종료 시
 * stepTick 의 정지-종료 경로가 포메이션 리셋 + kickoff 이벤트를 수행한다(골 후 킥오프와 동일 경로 →
 * 그 틱 스냅샷이 정렬 배치를 크리스프하게 담음).
 * runMatch(통짜)와 resumeSecondHalf(분할 재개) 양쪽에서 하프 경계의 동일 지점에 호출해 재개
 * 동일성을 유지한다(applyDelta 를 전반과 동일 입력으로 주면 baseFx·teams 무변경 → 결과 동일).
 */
function secondHalfKickoff(carry: Carry): void {
  const { state, pitch } = carry;
  const c = centerSpot(pitch);
  state.setPiece = { kind: "kickoff", side: "away", x: c.x, y: c.y };
  state.stoppage = 1;
}

/** carry → MatchLog. */
function toMatchLog(carry: Carry): MatchLog {
  return {
    configVersion: carry.config.version,
    seed: carry.seed,
    tickSnapshots: carry.snapshots,
    events: carry.events,
    finalScore: { home: carry.state.score.home, away: carry.state.score.away },
  };
}

/**
 * 통짜 90분 매치 실행. (핵심 API)
 */
export function runMatch(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  select: SelectData,
  config: EngineConfig = defaultEngineConfig,
): MatchLog {
  const carry = initCarry(seed, home, away, select, config);
  const total = totalTicks(config);
  const half = Math.floor(total / 2);

  simulateRange(carry, half);
  settleInFlightShot(carry); // #178 후속: 하프 마지막 틱 슛이 증발하지 않게.
  carry.events.push({
    tick: half,
    minute: tickToMinute(half, config),
    type: "half_whistle",
  });
  // 후반 시작: 어웨이 킥오프 + 포메이션 리셋(하프타임 후에도 정렬 배치로 재개).
  secondHalfKickoff(carry);
  simulateRange(carry, total);
  settleInFlightShot(carry); // 경기 종료 틱도 동일.
  carry.events.push({
    tick: total - 1,
    minute: config.matchMinutes,
    type: "full_whistle",
  });
  return toMatchLog(carry);
}

/** 재개용 carry state(엔진 내부 객체 그대로 관통). */
export type CarryState = Carry;

/**
 * 전반전만 실행하고 재개용 상태 반환. RNG·좌표·스코어·피로가 carry 안에 살아있다.
 */
export function runFirstHalf(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  select: SelectData,
  config: EngineConfig = defaultEngineConfig,
): CarryState {
  const carry = initCarry(seed, home, away, select, config);
  const half = Math.floor(totalTicks(config) / 2);
  simulateRange(carry, half);
  settleInFlightShot(carry); // runMatch(통짜)와 **동일 지점** — rng 소비 일치(재개 동일성).
  carry.events.push({
    tick: half,
    minute: tickToMinute(half, config),
    type: "half_whistle",
  });
  return carry;
}

/**
 * 하프타임 델타(후반 전술) 주입 후 후반 재개 → 완결 MatchLog.
 * delta 를 전반 입력과 동일하게 주면 runMatch(통짜)와 완전히 동일.
 */
export function resumeSecondHalf(
  carry: CarryState,
  deltaHome: TacticalInput,
  deltaAway: TacticalInput,
): MatchLog {
  const { state, config, pitch } = carry;
  applyDelta(state, deltaHome, "home", pitch);
  applyDelta(state, deltaAway, "away", pitch);
  // 후반 시작 킥오프(runMatch 통짜와 동일 지점) — half_whistle 은 runFirstHalf 가 이미 emit.
  secondHalfKickoff(carry);
  const total = totalTicks(config);
  simulateRange(carry, total);
  settleInFlightShot(carry); // runMatch(통짜)와 **동일 지점**.
  carry.events.push({
    tick: total - 1,
    minute: config.matchMinutes,
    type: "full_whistle",
  });
  return toMatchLog(carry);
}
