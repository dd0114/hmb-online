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

  /**
   * **공간 조준점**(#377 M3-C 스루패스, fixed). 있으면 공을 리시버 **발밑이 아니라 이 지점**으로
   * 찬다 — `planPass` 의 `leadAim`(리시버의 미래 위치)을 이 좌표가 대신한다.
   *
   * ## 왜 `PassOption` 에 붙나 (새 행동을 안 만드는 이유)
   * 스루패스는 **패스다.** 실행(`planPass`)·도착(`resolveArrival`)·이벤트(`pass`)·오프사이드가
   * 전부 같은 함수를 타야 두 코어와 스탯이 갈리지 않는다(#314 `clearance` 가 별도 타입이 되면서
   * `MatchEventType` 을 건드려 #326 을 만든 전례). 그래서 바뀌는 것은 **조준점 하나**다.
   *
   * ⚠️ `passOptions`(아래)는 이 필드를 **절대 채우지 않는다** — 채우는 곳은 스루패스 생성기
   * (`through.ts`)뿐이고, 그래서 weighted 롤백 경로는 이 필드를 한 번도 보지 않는다(bit-identical).
   */
  aimFx?: { x: number; y: number };

  /**
   * **경주 계수**(0..1, #377 M3-C). 스루패스의 성공확률에 곱한다 — "러너가 먼저 닿나, 수비가
   * 먼저 닿나"를 확률로 옮기는 항이다. `undefined` 면 곱하지 않는다(= 기존 패스 무영향).
   */
  raceFrac?: number;
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

/**
 * **임의 지점**을 압박하는 `side` 팀의 상대 수(반경 안). `pressureCount` 의 일반형이다.
 *
 * 왜 지점 버전이 필요한가(#353): 패스를 받는 쪽의 압박은 "리시버가 **지금** 서 있는 자리"가 아니라
 * **공이 도착할 때 그가 있을 자리**에서 재야 한다(리드패스 예측 지점 — `decision.ts:leadAim`).
 * 선수 버전으로는 그 질문을 표현할 수 없다. 산술은 하나뿐이고 `pressureCount` 가 이 함수를
 * 위임 호출하므로 두 경로가 갈릴 수 없다(= 선수 버전은 bit-identical).
 */
export function pressureCountAt(
  state: SimState,
  side: SimPlayer["side"],
  xFx: number,
  yFx: number,
  config: EngineConfig,
  rangeM?: number,
): number {
  const range = (rangeM ?? config.movement.pressRange) * config.fixedScale;
  let c = 0;
  for (const p of state.players) {
    if (p.side === side) continue;
    if (fdist(p.posFx.x, p.posFx.y, xFx, yFx) <= range) c++;
  }
  return c;
}

/** player 를 압박하는 상대 수(pressRange 안). */
export function pressureCount(
  state: SimState,
  player: SimPlayer,
  config: EngineConfig,
  rangeM?: number,
): number {
  return pressureCountAt(state, player.side, player.posFx.x, player.posFx.y, config, rangeM);
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
 * **패스 레인 위험** — (ax,ay)→(bx,by) 선분에 가장 가까운 `side` 팀의 상대까지 거리(fixed).
 * 상대가 하나도 없으면 `Infinity`(기존 관용구 유지).
 *
 * ⚠️ 단일 출처(#377 M3-C): `passOptions`(발밑 패스)와 `through.ts`(공간 조준점)가 **같은 자**로
 * 레인을 잰다. 스루패스가 자기 사본을 들고 있으면 "레인이 위험한데 EV 는 안전하다고 본다"가
 * 조용히 성립한다. 반복 순서·산술이 그대로라 이 추출은 bit-identical 이다.
 */
export function laneDangerOn(
  state: SimState,
  side: SimPlayer["side"],
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  let danger = Infinity;
  for (const opp of state.players) {
    if (opp.side === side) continue;
    const sd = pointSegDist(opp.posFx.x, opp.posFx.y, ax, ay, bx, by);
    if (sd < danger) danger = sd;
  }
  return danger;
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
    const laneDanger = laneDangerOn(
      state,
      owner.side,
      owner.posFx.x,
      owner.posFx.y,
      mate.posFx.x,
      mate.posFx.y,
    );

    options.push({ receiver: mate, dist: d, laneDanger, forwardGain, long: !inShort });
  }
  return options;
}
