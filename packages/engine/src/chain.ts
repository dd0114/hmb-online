import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { PassOption } from "./perception";
import { fromFixed, fclamp, fdist, toFixed } from "./fixedmath";
import { attackGoal, clampToPitch } from "./pitch";
import { passOptions } from "./perception";
import { computePassProb, planPass, xgAtPoint, type Action } from "./decision";

/**
 * chain — **볼 소유자 결정의 대안 코어**(#279 W2 비교본, `config.chain.mode="chain"` 일 때만).
 *
 * ## 왜 이 파일이 존재하나
 * 기존 `decideBallOwner` 는 {슛·패스·드리블·홀드} 각각의 **즉시 점수**를 만들어 가중 추첨한다.
 * 그 구조에는 "이 패스를 하면 **그다음에 뭐가 되는가**"를 볼 자리가 없다. 그래서 #279 진단이
 * 보여준 증상들(백패스 22.4% · 전진 후보 0개 23.6% · 다이렉트 스피드 5.69 m/s · 슛 출발점 엔트로피 0)을
 * 노브로 각각 눌러야 했고, 하나를 누르면 다른 게 튀었다.
 *
 * 여기서는 행동이 아니라 **도달하는 상태**를 평가한다:
 *
 *   EV(행동) = P(성공) × V(성공 상태, depth−1) + (1 − P(성공)) × V(턴오버 상태)
 *
 * 그래서 "안전하지만 뒤로 빼는 패스"는 V 가 낮아서 자연히 밀리고, "성공하면 좋지만 뺏히면 치명적인
 * 롱볼"은 턴오버 항이 깎는다. 백패스 페널티·전진 보너스 같은 **개별 노브 없이** 방향성이 나온다.
 * 설계 출처 = RoboCup 2D `agent2d` 의 ChainAction(BFS + Field Evaluator, 논문 공개·코드 미사용).
 *
 * ## 범위 (의도적으로 좁다)
 * **볼 소유자 결정만** 바꾼다. 오프더볼 이동(`decideOffBall`)·경합(`contest`)·공 물리는 손대지 않는다.
 * 그래서 패스 타깃은 여전히 **사람**이다(공간 타깃 = 스루패스는 다음 웨이브 사안).
 *
 * ## 결정론
 * 전역 난수·시각 의존 0. 상태 예측은 순수 산술이고, 유일한 Rng 소비는 상위 후보 샘플 1회 +
 * 선택된 패스의 `planPass` 롤(기존과 동일 순서)이다. 예측은 좌표를 **읽기만** 한다(상태 변경 없음).
 */

/** 사슬 탐색이 평가하는 "가상 상태" — 공을 누가 어디서 잡고 있나. 나머지 선수는 정지 가정. */
interface Hypo {
  side: SimPlayer["side"];
  xFx: number;
  yFx: number;
  /** 그 지점에서 슛을 칠 사람의 슈팅 속성·피로(위협 계산용). */
  shooting: number;
  fatigue: number;
}

/**
 * 정수 지수 거듭제곱. **`Math.pow` 를 쓰지 않는다** — ECMAScript 명세상 `Math.pow` 는
 * *구현 근사(implementation-approximated)* 라 엔진/버전 간 최하위 비트가 다를 수 있고, 이 코어는
 * EV 를 부동소수로 **비교·정렬**하므로 그 차이가 **행동 선택을 뒤집을 수 있다**(= 무음 desync).
 * 곱셈은 IEEE754 로 정확히 규정돼 있으므로 반복 곱이 안전하다.
 * → `chain.advanceExponent` 는 **음이 아닌 정수**여야 한다(소수 지수는 지원하지 않는다).
 */
function powInt(base: number, exp: number): number {
  let r = 1;
  const n = exp < 0 ? 0 : Math.round(exp);
  for (let i = 0; i < n; i++) r *= base;
  return r;
}

/** side 팀 관점에서 (x,y) 최근접 상대까지 거리(fixed). 상대가 없으면 Infinity. */
function nearestOppDist(state: SimState, side: SimPlayer["side"], xFx: number, yFx: number): number {
  let best = Infinity;
  for (const p of state.players) {
    if (p.side === side || p.isGK) continue;
    const d = fdist(p.posFx.x, p.posFx.y, xFx, yFx);
    if (d < best) best = d;
  }
  return best;
}

/** 공격 방향 진행도(0:자기골 라인, 1:상대골 라인). */
function progress(pitch: Pitch, side: SimPlayer["side"], xFx: number): number {
  const frac = xFx / pitch.wFx;
  return side === "home" ? frac : 1 - frac;
}

/**
 * 상태 가치 V. 전부 0..1 로 정규화한 항의 가중합이라 노브가 서로 스케일을 안 깨뜨린다.
 *   V = advance·진행도 + threat·xG + space·여유공간
 */
export function evaluateState(state: SimState, h: Hypo, config: EngineConfig, pitch: Pitch): number {
  const c = config.chain;
  // 진행도는 **볼록**하게(^exponent). 선형이면 자기 진영에서 안전하게 돌리는 것과 밀고 가는 것의
  // 가치 차가 작아 뒤로 빼는 게 최적이 된다(#279 W2 1차 실측: 파이널서드 백패스 67%).
  const adv = powInt(fclamp(progress(pitch, h.side, h.xFx), 0, 1), c.advanceExponent);
  const { xg } = xgAtPoint(h.side, h.xFx, h.yFx, h.shooting, h.fatigue, config, pitch);
  const nd = nearestOppDist(state, h.side, h.xFx, h.yFx);
  const ndM = nd === Infinity ? c.spaceRefM : fromFixed(nd, config.fixedScale);
  const space = fclamp(ndM / c.spaceRefM, 0, 1);
  return c.advanceWeight * adv + c.threatWeight * xg + c.spaceWeight * space;
}

/**
 * 턴오버 상태의 가치 — **상대 관점의 V 를 뒤집어** 쓴다. 그래서 "우리 진영에서 뺏기는 것"이
 * "상대 진영에서 뺏기는 것"보다 훨씬 큰 손해로 계산된다(별도 노브 없이 위치 리스크가 나온다).
 */
function turnoverValue(state: SimState, h: Hypo, config: EngineConfig, pitch: Pitch): number {
  const opp: SimPlayer["side"] = h.side === "home" ? "away" : "home";
  // 뺏은 쪽은 그 자리에서 시작한다고 본다. 슈팅 속성은 중앙값(50)으로 — 누가 뺏을지 모른다.
  const v = evaluateState(state, { side: opp, xFx: h.xFx, yFx: h.yFx, shooting: 50, fatigue: 0 }, config, pitch);
  return -config.chain.turnoverWeight * v;
}

/** 한 후보의 EV. depth 가 남아 있고 패스면 리시버의 다음 수까지 재귀. */
interface Cand {
  kind: "shoot" | "pass" | "dribble" | "hold";
  ev: number;
  opt?: PassOption;
  toX?: number;
  toY?: number;
}

/**
 * 깊이 d 에서 "이 지점에서 이 사람이 낼 수 있는 최선의 EV". 재귀 종료(d<=0)면 상태 가치 자체.
 * 여기서는 **패스만** 재귀한다(슛/드리블/홀드는 상태 가치로 종결) — 분기폭 억제.
 */
function bestEvAt(
  state: SimState,
  holder: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
  depth: number,
): number {
  const h: Hypo = {
    side: holder.side,
    xFx: holder.posFx.x,
    yFx: holder.posFx.y,
    shooting: holder.attrs.shooting,
    fatigue: holder.fatigue,
  };
  const base = evaluateState(state, h, config, pitch);
  if (depth <= 0) return base;

  let best = base;
  // 슛(사거리·임계 안일 때만)
  const { xg, distM } = xgAtPoint(h.side, h.xFx, h.yFx, h.shooting, h.fatigue, config, pitch);
  if (distM <= config.contest.shootRange && xg >= config.contest.shootXgThreshold) {
    const ev = xg * config.chain.goalValue + (1 - xg) * turnoverValue(state, h, config, pitch);
    if (ev > best) best = ev;
  }
  // 패스
  for (const opt of passOptions(state, holder, config, pitch)) {
    const p = computePassProb(state, holder, opt, config, pitch);
    const r = opt.receiver;
    const succ: Hypo = {
      side: holder.side,
      xFx: r.posFx.x,
      yFx: r.posFx.y,
      shooting: r.attrs.shooting,
      fatigue: r.fatigue,
    };
    const vSucc = depth > 1 ? bestEvAt(state, r, config, pitch, depth - 1) : evaluateState(state, succ, config, pitch);
    // 시간 할인: 한 수 더 쓰는 건 공짜가 아니다(없으면 무한 리사이클이 최적 — 1차 실측 패스 10.65).
    const ev = config.chain.discount * (p * vSucc + (1 - p) * turnoverValue(state, succ, config, pitch));
    if (ev > best) best = ev;
  }
  return best;
}

/**
 * 사슬 탐색으로 볼 소유자 행동을 고른다. 반환은 기존 `Action` 과 **완전히 같은 계약**이라
 * match.ts 는 어느 코어인지 모른다(교체 가능).
 */
export function decideBallOwnerChain(
  state: SimState,
  owner: SimPlayer,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
): Action {
  const c = config.chain;
  const goal = attackGoal(pitch, owner.side);
  const here: Hypo = {
    side: owner.side,
    xFx: owner.posFx.x,
    yFx: owner.posFx.y,
    shooting: owner.attrs.shooting,
    fatigue: owner.fatigue,
  };
  const cands: Cand[] = [];

  // --- 슛 ---
  const { xg, distM } = xgAtPoint(here.side, here.xFx, here.yFx, here.shooting, here.fatigue, config, pitch);
  if (distM <= config.contest.shootRange && xg >= config.contest.shootXgThreshold) {
    // 슛 성향(프롬프트 behavior)은 EV 를 곱으로 가감 — 전술 입력이 계속 살아 있어야 한다.
    const tend = 0.5 + owner.behavior.shootTendency;
    const ev = (xg * c.goalValue + (1 - xg) * turnoverValue(state, here, config, pitch)) * tend;
    cands.push({ kind: "shoot", ev });
  }

  // --- 패스(후보별 EV, 성공 시 리시버의 다음 수까지) ---
  const opts = passOptions(state, owner, config, pitch);
  for (const opt of opts) {
    const p = computePassProb(state, owner, opt, config, pitch);
    const r = opt.receiver;
    const succ: Hypo = {
      side: owner.side,
      xFx: r.posFx.x,
      yFx: r.posFx.y,
      shooting: r.attrs.shooting,
      fatigue: r.fatigue,
    };
    const vSucc =
      c.depth > 1 ? bestEvAt(state, r, config, pitch, c.depth - 1) : evaluateState(state, succ, config, pitch);
    // passRisk 성향: 리스크 감수형은 턴오버 항을 덜 무겁게 본다(전술 입력 유지).
    const riskScale = 1.4 - owner.behavior.passRisk;
    // 할인: 패스도 한 수를 쓰는 행동이다(슛/드리블과 같은 자에 놓으려면 여기서 깎아야 한다).
    const ev = c.discount * (p * vSucc + (1 - p) * turnoverValue(state, succ, config, pitch) * riskScale);
    cands.push({ kind: "pass", ev, opt });
  }

  // --- 드리블(골 방향 한 스텝) ---
  {
    const step = config.movement.dribbleReach;
    const tx = owner.posFx.x + Math.round((goal.x - owner.posFx.x) * step);
    const ty = owner.posFx.y + Math.round((goal.y - owner.posFx.y) * step);
    const cl = clampToPitch(pitch, tx, ty);
    const after: Hypo = { ...here, xFx: cl.x, yFx: cl.y };
    // 공간이 좁을수록 드리블 성공률이 떨어진다(근접 상대 거리로 스케일).
    const ndM = fromFixed(
      Math.min(nearestOppDist(state, owner.side, owner.posFx.x, owner.posFx.y), toFixed(c.spaceRefM, config.fixedScale)),
      config.fixedScale,
    );
    const p = fclamp(c.dribbleSuccess * (0.4 + 0.6 * (ndM / c.spaceRefM)), 0.05, 0.98);
    const tend = 0.5 + owner.behavior.dribbleTendency;
    const ev =
      (p * evaluateState(state, after, config, pitch) + (1 - p) * turnoverValue(state, here, config, pitch)) * tend;
    cands.push({ kind: "dribble", ev, toX: cl.x, toY: cl.y });
  }

  // --- 홀드(제자리) ---
  cands.push({ kind: "hold", ev: evaluateState(state, here, config, pitch) - c.holdPenalty });

  // --- 선택: 온도 0 이면 argmax, 아니면 상위 K 가중 샘플(변주 유지) ---
  // 정렬은 **완전 전순서**여야 한다. 구버전은 마지막 단계가 `a < b ? -1 : 1` 이라 **완전 동점에서
  // 양방향 모두 1** 을 반환했다(비일관 비교자) — shoot/dribble/hold 는 `opt` 가 없어 실제로 동점이
  // 발생한다. 비일관 비교자에서 `Array.prototype.sort` 결과는 **구현 정의**라 엔진/버전 간 순서가
  // 갈릴 수 있다(= 무음 desync). 좌표 타깃 후보(receiver 없음)를 넣으면 더 흔해진다.
  const key = (c0: Cand): string => `${c0.kind}|${c0.opt?.receiver.id ?? ""}|${c0.toX ?? 0}|${c0.toY ?? 0}`;
  cands.sort((a, b) => {
    if (b.ev !== a.ev) return b.ev - a.ev;
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  let picked = cands[0]!;
  if (c.temperature > 0 && cands.length > 1) {
    const k = Math.max(1, Math.min(cands.length, 1 + Math.round(c.temperature * (cands.length - 1))));
    const floor = cands[k - 1]!.ev;
    const eps = 0.05;
    let total = 0;
    for (let i = 0; i < k; i++) total += cands[i]!.ev - floor + eps;
    let rr = rng.next() * total;
    for (let i = 0; i < k; i++) {
      rr -= cands[i]!.ev - floor + eps;
      if (rr < 0) {
        picked = cands[i]!;
        break;
      }
    }
  }

  switch (picked.kind) {
    case "shoot":
      return { kind: "shoot", xg, toX: goal.x, toY: goal.y };
    case "pass": {
      const plan = planPass(state, owner, picked.opt!, config, rng, pitch);
      return {
        kind: "pass",
        receiver: picked.opt!.receiver,
        toX: plan.toX,
        toY: plan.toY,
        outcome: plan.outcome,
        long: picked.opt!.long,
        claimant: plan.claimant,
      };
    }
    case "dribble":
      return { kind: "dribble", toX: picked.toX!, toY: picked.toY! };
    default:
      return { kind: "hold" };
  }
}
