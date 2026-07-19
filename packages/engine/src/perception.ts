import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import { fdist } from "./fixedmath";
import { distToAttackGoal } from "./pitch";

/**
 * perception — 선수별 주변 인식(고정소수 거리 기반).
 * 근접 동료/상대, 압박도, 패스 옵션 후보를 산출한다. (config.perceptionRadius)
 */

export interface PassOption {
  receiver: SimPlayer;
  dist: number; // fixed
  /** 패스 레인상 가장 가까운 상대까지 수직 거리(작을수록 위험) fixed. */
  laneDanger: number;
  /** 이 패스가 상대 골에 얼마나 가까워지는가(전진 이득) fixed(양수=전진). */
  forwardGain: number;
  /** 롱패스(인식 반경 밖 원거리 동료 대상 = 의도적 롱볼/전환/스루볼) 여부. (E2) */
  long: boolean;
}

/** 두 선수 거리(fixed). */
export function playerDist(a: SimPlayer, b: SimPlayer): number {
  return fdist(a.posFx.x, a.posFx.y, b.posFx.x, b.posFx.y);
}

/** player 에게 가장 가까운 상대. 없으면 null. */
export function nearestOpponent(
  state: SimState,
  player: SimPlayer,
): { opp: SimPlayer; dist: number } | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side === player.side) continue;
    const d = playerDist(player, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? { opp: best, dist: bestD } : null;
}

/** player 를 압박하는 상대 수(pressRange 안). */
export function pressureCount(
  state: SimState,
  player: SimPlayer,
  config: EngineConfig,
  rangeM?: number,
): number {
  const range = (rangeM ?? config.movement.pressRange) * config.fixedScale;
  let c = 0;
  for (const p of state.players) {
    if (p.side === player.side) continue;
    if (playerDist(player, p) <= range) c++;
  }
  return c;
}

/** 점(px,py)-선분(ax,ay)-(bx,by) 사이 최단거리 fixed(정수 산술). */
function pointSegDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return fdist(px, py, ax, ay);
  // t = clamp( (ap·ab)/ab2 , 0..1 ), 정수화 위해 분자/분모로.
  let tNum = apx * abx + apy * aby;
  if (tNum < 0) tNum = 0;
  if (tNum > ab2) tNum = ab2;
  const cx = ax + Math.round((abx * tNum) / ab2);
  const cy = ay + Math.round((aby * tNum) / ab2);
  return fdist(px, py, cx, cy);
}

/**
 * 볼 소유자의 패스 옵션 후보. 인식 반경 안 동료를 대상으로
 * 레인 위험(가장 가까운 상대)과 전진 이득을 계산해 반환.
 */
export function passOptions(
  state: SimState,
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): PassOption[] {
  const radius = config.perceptionRadius * config.fixedScale;
  const ownGoalDist = distToAttackGoal(pitch, owner.side, owner.posFx.x, owner.posFx.y);
  // 롱패스(E2): 인식 반경 밖(longPassMinM~longPassMaxM) 동료도 의도적 롱볼 후보로.
  const lp = config.longPass;
  const longMinFx = lp.minM * config.fixedScale;
  const longMaxFx = lp.maxM * config.fixedScale;
  const options: PassOption[] = [];

  for (const mate of state.players) {
    if (mate.side !== owner.side || mate.id === owner.id) continue;
    const d = fdist(owner.posFx.x, owner.posFx.y, mate.posFx.x, mate.posFx.y);
    if (d === 0) continue;
    const inShort = d <= radius;
    // 롱 후보: 반경 밖이지만 longMax 이내 + 전진(뒤로 빼는 롱볼은 제외).
    const mateGoalDist = distToAttackGoal(pitch, owner.side, mate.posFx.x, mate.posFx.y);
    const forwardGain = ownGoalDist - mateGoalDist; // 양수면 골에 더 가까워짐
    const isLong = !inShort && lp.enabled && d <= longMaxFx && forwardGain > 0;
    if (!inShort && !isLong) continue;
    // 롱은 최소 거리 이상만(짧은 롱은 숏에서 이미 커버).
    if (isLong && d < longMinFx) continue;

    // 레인 위험: 상대들 중 패스선에 가장 가까운 거리.
    let laneDanger = Infinity;
    for (const opp of state.players) {
      if (opp.side === owner.side) continue;
      const sd = pointSegDist(
        opp.posFx.x,
        opp.posFx.y,
        owner.posFx.x,
        owner.posFx.y,
        mate.posFx.x,
        mate.posFx.y,
      );
      if (sd < laneDanger) laneDanger = sd;
    }

    options.push({ receiver: mate, dist: d, laneDanger, forwardGain, long: !inShort });
  }
  return options;
}
