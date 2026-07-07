import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { PassOption } from "./perception";
import { fromFixed, fclamp } from "./fixedmath";
import { attackGoal, defendGoal, distToAttackGoal, clampToPitch } from "./pitch";
import { passOptions, nearestOpponent } from "./perception";

/**
 * decision — 행동 선택.
 *  - 볼 소유자: {슛, 최적 패스, 드리블, 홀드} 를 [속성+behavior+ctx+config.decisionWeights]
 *    시드 확률로 선택.
 *  - 오프더볼/수비: 역할 basePosition 기반 이동 목표를 계산(전진 런/폭/라인/마크/압박).
 * 모든 무작위성은 인자로 받은 Rng 인스턴스만 사용(전역 없음).
 */

export type Action =
  | { kind: "shoot"; xg: number; toX: number; toY: number }
  | { kind: "pass"; receiver: SimPlayer; toX: number; toY: number }
  | { kind: "dribble"; toX: number; toY: number }
  | { kind: "hold" };

/** 극단 behavior(0/1 근처)에 소프트캡 페널티. 0.5 에서 페널티 0. */
function softCapped(b: number, softCap: number): number {
  const extremeness = Math.abs(2 * b - 1);
  return b * (1 - softCap * extremeness);
}

/** 속성 0..100 → 배수(약 0.6..1.4). */
function attrFactor(v: number): number {
  return 0.6 + 0.8 * (v / 100);
}

/** 슛 xG 계산(거리·각도·슈팅속성). */
function computeXg(
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): { xg: number; distM: number } {
  const g = attackGoal(pitch, owner.side);
  const distFx = distToAttackGoal(pitch, owner.side, owner.posFx.x, owner.posFx.y);
  const distM = fromFixed(distFx, config.fixedScale);
  const lateralM = fromFixed(Math.abs(owner.posFx.y - g.y), config.fixedScale);
  const halfH = config.pitch.height / 2;
  const central = fclamp(1 - config.contest.shootAngleFactor * (lateralM / halfH), 0.15, 1);
  let xg = config.contest.xgBase * attrFactor(owner.attrs.shooting);
  xg *= Math.max(0.05, 1 - config.contest.shootDistanceFactor * distM);
  xg *= central;
  xg *= 1 - 0.3 * owner.fatigue;
  return { xg: fclamp(xg, 0.01, 0.9), distM };
}

/** 패스 옵션 점수: 안전(laneDanger)·전진(forwardGain)·거리 종합. */
function scoreOption(opt: PassOption, owner: SimPlayer, config: EngineConfig): number {
  const scale = config.fixedScale;
  const safeM = fromFixed(opt.laneDanger, scale);
  const fwdM = fromFixed(opt.forwardGain, scale);
  const distM = fromFixed(opt.dist, scale);
  const directness = owner.behavior.passDirectness;
  const riskTol = owner.behavior.passRisk;
  // 안전도(위험할수록 감점, passRisk 높으면 관대) + 전진 이득 + 거리 페널티.
  return safeM * (1.2 - riskTol) + fwdM * (0.4 + directness) - distM * 0.15;
}

/** 볼 소유자의 행동 결정(시드 확률). */
export function decideBallOwner(
  state: SimState,
  owner: SimPlayer,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
): Action {
  const w = config.decisionWeights;
  const sc = config.softCap;
  const goal = attackGoal(pitch, owner.side);

  // --- 슛 후보 ---
  const { xg, distM } = computeXg(owner, config, pitch);
  let wShoot = 0;
  if (distM <= config.contest.shootRange) {
    const rangeFactor = fclamp(1 - distM / config.contest.shootRange, 0.05, 1);
    wShoot =
      w.shoot *
      (0.25 + softCapped(owner.behavior.shootTendency, sc)) *
      rangeFactor *
      attrFactor(owner.attrs.shooting);
  }

  // --- 패스 후보 ---
  const opts = passOptions(state, owner, config, pitch);
  let bestOpt: PassOption | null = null;
  let bestScore = -Infinity;
  for (const o of opts) {
    const s = scoreOption(o, owner, config);
    if (s > bestScore) {
      bestScore = s;
      bestOpt = o;
    }
  }
  let wPass = 0;
  if (bestOpt) {
    // 최소 품질 보정: 좋은 옵션일수록 가중.
    const quality = fclamp(0.3 + bestScore / 40, 0.1, 1.3);
    wPass = w.pass * (0.4 + softCapped(1 - owner.behavior.passRisk * 0.3, sc)) * quality;
  }

  // --- 드리블 후보(전방 공간) ---
  const near = nearestOpponent(state, owner);
  const spaceM = near ? fromFixed(near.dist, config.fixedScale) : config.perceptionRadius;
  const spaceFactor = fclamp(spaceM / config.perceptionRadius, 0.1, 1);
  const wDribble =
    w.dribble *
    (0.25 + softCapped(owner.behavior.dribbleTendency, sc)) *
    spaceFactor *
    attrFactor(owner.attrs.technical) *
    (1 - 0.4 * owner.fatigue);

  // --- 홀드 후보(압박 심하면 안전하게) ---
  const wHold = w.hold * (0.5 + 0.5 * owner.behavior.supportDepth);

  // --- 시드 확률 샘플링 ---
  const total = wShoot + wPass + wDribble + wHold;
  if (total <= 0) return { kind: "hold" };
  let r = rng.next() * total;

  if ((r -= wShoot) < 0) {
    return { kind: "shoot", xg, toX: goal.x, toY: goal.y };
  }
  if ((r -= wPass) < 0 && bestOpt) {
    return {
      kind: "pass",
      receiver: bestOpt.receiver,
      toX: bestOpt.receiver.posFx.x,
      toY: bestOpt.receiver.posFx.y,
    };
  }
  if ((r -= wDribble) < 0) {
    // 골 방향으로 약간 전진하는 드리블 목표.
    const step = 0.06;
    const tx = owner.posFx.x + Math.round((goal.x - owner.posFx.x) * step);
    const ty = owner.posFx.y + Math.round((goal.y - owner.posFx.y) * step);
    const c = clampToPitch(pitch, tx, ty);
    return { kind: "dribble", toX: c.x, toY: c.y };
  }
  return { kind: "hold" };
}

/** side 팀에서 공에 가장 가까운 선수(압박 담당 지정용). */
function closestToBall(state: SimState, side: SimPlayer["side"]): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side !== side || p.isGK) continue;
    const dx = p.posFx.x - state.ball.posFx.x;
    const dy = p.posFx.y - state.ball.posFx.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * 오프더볼/수비 이동 목표 계산. player.targetFx 를 설정.
 * (볼 소유자는 match 에서 행동에 따라 별도 처리)
 */
export function decideOffBall(
  state: SimState,
  player: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
  pressAssignee: SimPlayer | null,
): void {
  const scale = config.fixedScale;
  const mv = config.movement;
  const team = state.teams[player.side];
  const sign = player.side === "home" ? 1 : -1;
  const g = attackGoal(pitch, player.side);
  const ownGoal = defendGoal(pitch, player.side);
  const ball = state.ball;

  // GK: 자기 골대 앞에서 공 y 를 살짝 추종.
  if (player.isGK) {
    const gy = fclamp(
      ownGoal.y + Math.round((ball.posFx.y - ownGoal.y) * 0.3),
      Math.round(pitch.hFx * 0.35),
      Math.round(pitch.hFx * 0.65),
    );
    const gx = ownGoal.x + sign * Math.round(pitch.wFx * 0.04);
    player.targetFx = clampToPitch(pitch, gx, gy);
    return;
  }

  let tx = player.baseFx.x;
  let ty = player.baseFx.y;
  const attacking = state.possession === player.side;

  if (attacking) {
    // 전진 런: 역할 위치에서 골 방향으로.
    const runFrac = mv.forwardRunReach * player.behavior.forwardRunFreq;
    tx += Math.round((g.x - player.baseFx.x) * runFrac);
    // 폭: 자기 반쪽 기준 바깥으로 벌림.
    const center = Math.round(pitch.hFx / 2);
    const widthDir = player.baseFx.y < center ? -1 : 1;
    ty += widthDir * Math.round(pitch.hFx * mv.widthReach * player.behavior.widthTendency);
    // 지원: 공 쪽으로 당김.
    tx += Math.round((ball.posFx.x - tx) * mv.supportPull * player.behavior.supportDepth);
    ty += Math.round((ball.posFx.y - ty) * mv.supportPull * player.behavior.supportDepth);
    // roam: positioningFreedom 이 크면 공쪽으로 더.
    tx += Math.round((ball.posFx.x - tx) * 0.15 * player.behavior.positioningFreedom);
  } else {
    // 수비: 라인 높이 반영(0.5 기준 전/후 이동).
    const lineShift = (team.defensiveLineHeight - 0.5) * pitch.wFx * 0.35;
    tx += sign * Math.round(lineShift);
    // 컴팩트: 공 쪽으로 블록 수축.
    tx += Math.round((ball.posFx.x - tx) * team.compactness * 0.25);
    ty += Math.round((ball.posFx.y - ty) * team.compactness * 0.25);

    // 마크: 지정 상대 뒤(자기 골 쪽)에 붙는다.
    if (player.markTarget) {
      const mark = state.byId.get(player.markTarget);
      if (mark) {
        const gap = mv.markGap * scale;
        // 상대와 자기 골 사이.
        const dx = ownGoal.x - mark.posFx.x;
        const dy = ownGoal.y - mark.posFx.y;
        const len = Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy)));
        tx = mark.posFx.x + Math.round((dx * gap) / len);
        ty = mark.posFx.y + Math.round((dy * gap) / len);
      }
    }

    // 압박: 지정된 최근접 수비수이고 압박 성향이면 공으로 돌진.
    if (
      pressAssignee &&
      pressAssignee.id === player.id &&
      player.behavior.pressAggression * team.pressingScheme.intensity > 0.15
    ) {
      tx = ball.posFx.x;
      ty = ball.posFx.y;
    }
  }

  player.targetFx = clampToPitch(pitch, tx, ty);
}

/** side 팀의 압박 담당(공 최근접) 지정. */
export function assignPresser(state: SimState, side: SimPlayer["side"]): SimPlayer | null {
  return closestToBall(state, side);
}
