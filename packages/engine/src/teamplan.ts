import type { TeamSide } from "@hmb/shared";
import type { EngineConfig } from "./config";
import type { Pitch } from "./pitch";
import type { SimState, SimPlayer } from "./simstate";
import { isBallOwner } from "./simstate";
import { attackGoal, clampToPitch, distToAttackGoal } from "./pitch";
import { fdist, isqrt } from "./fixedmath";

/**
 * teamplan — **팀 단위 파생 상태**(틱당 1회, 선수 순회 밖에서 계산).
 *
 * 왜 별도 파일인가: `decision.ts` 는 이미 870줄이고, 무엇보다 이 계산은 `decideOffBall` **안에서**
 * 하면 안 된다 — 그 함수는 `state.players` 순회 안에서 불리고 `player.seen` 을 **변이**하므로,
 * 거기서 팀 상태를 만들면 배열 순서 의존이 생긴다(결정론 규율 §5-1). 계산 지점은
 * `match.ts:stepTick` 의 압박 배정 자리(= decide 루프 **앞**, 틱당 1회) 하나뿐이다.
 *
 * **#279 S1 → #314**: S1 은 자리만 만들었고(값은 현행 동작의 중립 재현, 소비자 0), #314 에서
 * 첫 소비가 붙었다 — `decideOffBall` 의 수비 분기가 `blockCenterX`/`compact` 를 **여기서 읽는다**
 * (공식·값은 그대로라 그 이관 자체는 비트 동일). 로드맵 W5-2 의 "라인으로 투영"은 여전히 S3 몫이다.
 * 그리고 이 파일은 **런 오더**(#314 B — 의도 게시판의 첫 소비자)도 담는다.
 *
 * 규율:
 *  - 순수 함수. `Rng` 를 받지 않는다(= 소비할 수 없다).
 *  - `state.players` 배열 순서에 의존하지 않는다(퇴장이 splice 로 순서를 바꾼다, §5-3).
 *  - 정수 고정소수만. `Math.pow/exp/sin/cos` 금지(§5-4).
 */

/** 한 팀의 이번 틱 계획. */
export interface TeamPlan {
  /**
   * 공유 수비 라인의 x(고정소수 정수).
   *
   * 중립값 = 현재 `decision.ts:decideOffBall` 수비 분기가 **선수마다 중복 계산**하고 있는
   * `blockCenterX` 를 그대로 팀 레벨로 올린 것이다(값·공식 동일 = 동작 변경 0). S3 가
   * "각자 자기 base 에서 16% 보간" 을 "이 라인으로 투영 + 역할별 오프셋" 으로 바꿀 때
   * 여기가 그 라인이 된다.
   */
  lineX: number;
  /**
   * 블록 압축 계수(0.5 + compactness). 중립값 = 현재 수비 분기의 `compact` 와 동일.
   * S3 에서 라인 두께/역할 오프셋 산정의 입력이 된다.
   */
  blockDepth: number;
}

/**
 * `decision.ts` 수비 블록 공식의 팀 레벨 상수 — **여기서 새로 고른 값이 아니라 현행 값의 이관**이다.
 * (원본: `decideOffBall` 의 `lineShift` / `blockCenterX`. S3 에서 decision.ts 가 이 계획을
 *  소비하게 되면 원본 리터럴은 사라지고 여기 하나만 남는다. 그때 config 노브
 *  `movement.lineDiscipline`·`blockLineRangeM` 로 승격된다 — 로드맵 W5-2.)
 */
const LINE_HEIGHT_RANGE = 0.2; // (defensiveLineHeight - 0.5) 가 피치 길이에서 갖는 실권한 폭.
const BLOCK_BEHIND_BALL = 0.06; // 블록 중심을 공보다 자기 골 쪽으로 물리는 기본량(피치 길이 비).

/**
 * `side` 팀의 이번 틱 계획. 순수 함수 — state 를 **변이하지 않는다**(호출부가 `state.plan` 에 담는다).
 */
export function computeTeamPlan(
  state: SimState,
  side: TeamSide,
  config: EngineConfig,
  pitch: Pitch,
): TeamPlan {
  void config; // S1 중립값은 아직 config 노브를 쓰지 않는다(S3 에서 lineDiscipline 등이 들어온다).
  const team = state.teams[side];
  const sign = side === "home" ? 1 : -1;
  const lineShift = (team.defensiveLineHeight - 0.5) * pitch.wFx * LINE_HEIGHT_RANGE;
  const lineX =
    state.ball.posFx.x - sign * Math.round(pitch.wFx * BLOCK_BEHIND_BALL) + sign * Math.round(lineShift);
  return { lineX, blockDepth: 0.5 + team.compactness };
}

/* ------------------------------------------------------------------------- *
 * 런 오더(#314 B) — 의도 게시판의 첫 소비자
 * ------------------------------------------------------------------------- */

/** 만료된 의도와 런 오더를 버린다. **틱당 1회**, 배열 순서 보존(해시가 순서를 흡수한다). */
export function gcIntents(state: SimState): void {
  if (state.intents.length > 0) {
    state.intents = state.intents.filter((i) => i.expiresTick >= state.tick);
  }
  for (const p of state.players) {
    if (p.runOrder && p.runOrder.untilTick < state.tick) p.runOrder = null;
  }
}

/** 데드볼 진입 — 진행 중인 의도·런을 전부 취소한다(공이 죽으면 런도 죽는다). */
export function clearIntents(state: SimState): void {
  if (state.intents.length > 0) state.intents = [];
  for (const p of state.players) {
    if (p.runOrder) p.runOrder = null;
  }
}

/**
 * **런 오더 배정 + 소비**(#314 B) — hero ⓑ "차면 찰 때부터 뛰어들어간다".
 *
 * ## 왜 여기(teamplan)인가
 * 이 계산은 "한 의도에 대해 팀 전체를 보고 상위 N명을 고른다"라 **팀 단위**다.
 * `decideOffBall` 안에서 하면 그 함수가 `state.players` 순회 안에서 불리고 `player.seen` 을
 * 변이하므로 배열 순서 의존이 생긴다(결정론 규율 §5-1). 그래서 `computeTeamPlan` 과 같은
 * 규율로 **선수 루프 밖·틱당 1회** 돈다.
 *
 * ## 왜 decide 루프 *뒤*에 부르나 (computeTeamPlan 과 다른 점)
 * "**차면 찰 때부터**" 가 요구사항이기 때문이다. 패스는 오프더볼 결정이 **끝난 뒤에** 결정되므로,
 * decide 루프 앞에서 돌면 러너는 항상 1틱 늦는다. 여기서는 이동(act) 루프 **직전**에 돌아서
 * 그 틱에 게시된 의도가 **같은 틱의 발**로 이어진다. 순서 의존은 없다 — 이 함수는
 * `player.seen` 을 만지지 않고, 후보 선정이 전순서(거리² → idHash → id)로만 정렬된다.
 *
 * ## 되돌아 달리기 금지 (#181)
 * `minForwardGainM` 미만이면 런을 아예 안 건다. #181 이 "낙하점으로 되돌아 달리면 전진 런이
 * 취소돼 공격이 죽는다"를 실측(슛/팀 9.6→4.9)한 함정이라, 여기서도 **전진일 때만** 뛴다.
 */
export function applyRunOrders(state: SimState, config: EngineConfig, pitch: Pitch): void {
  const ro = config.movement.runOrder;
  if (!ro.enabled) return;
  const scale = config.fixedScale;
  const radiusFx = Math.round(ro.radiusM * scale);
  const aheadFx = Math.round(ro.aheadM * scale);
  const minGainFx = Math.round(ro.minForwardGainM * scale);

  for (const intent of state.intents) {
    if (intent.kind !== "pass_to") continue;
    if (intent.tick !== state.tick) continue; // 배정은 게시된 틱에 1회(그 뒤엔 유지만).
    const g = attackGoal(pitch, intent.side);
    // 런 목표 = 도착 지점에서 **상대 골 쪽으로 조금 더 앞**. "도착 지점"이 아니라 "그 앞"인 이유는,
    // 공이 도착할 때 이미 지나가고 있어야 침투이지 마중이 아니기 때문이다.
    const dgx = g.x - intent.xFx;
    const dgy = g.y - intent.yFx;
    const glen = isqrt(dgx * dgx + dgy * dgy);
    const runPt =
      glen > 0
        ? clampToPitch(
            pitch,
            intent.xFx + Math.round((dgx * aheadFx) / glen),
            intent.yFx + Math.round((dgy * aheadFx) / glen),
          )
        : { x: intent.xFx, y: intent.yFx };

    // 후보 수집 — 전순서 정렬(거리² → idHash → id)로만 고른다(§5-3, 배열 순서 비의존).
    const cands: { p: SimPlayer; d2: number }[] = [];
    for (const p of state.players) {
      if (p.side !== intent.side || p.isGK) continue;
      if (p.id === intent.fromId || p.id === intent.forId) continue;
      if (isBallOwner(state, p)) continue;
      if (fdist(p.posFx.x, p.posFx.y, intent.xFx, intent.yFx) > radiusFx) continue;
      const gain =
        distToAttackGoal(pitch, p.side, p.posFx.x, p.posFx.y) -
        distToAttackGoal(pitch, p.side, runPt.x, runPt.y);
      if (gain < minGainFx) continue; // 되돌아 달리기 금지(#181).
      const dx = p.posFx.x - runPt.x;
      const dy = p.posFx.y - runPt.y;
      cands.push({ p, d2: dx * dx + dy * dy });
    }
    cands.sort((a, b) =>
      a.d2 !== b.d2
        ? a.d2 - b.d2
        : a.p.idHash !== b.p.idHash
          ? a.p.idHash - b.p.idHash
          : a.p.id < b.p.id
            ? -1
            : 1,
    );
    const n = Math.min(ro.maxRunners, cands.length);
    for (let i = 0; i < n; i++) {
      cands[i]!.p.runOrder = {
        xFx: runPt.x,
        yFx: runPt.y,
        untilTick: intent.expiresTick + ro.extraTicks,
        fromId: intent.fromId,
      };
    }
  }

  // --- 소비: 오프더볼 목표를 런 지점 쪽으로 당긴다(볼 소유자는 제외). ---
  if (ro.pull <= 0) return;
  for (const p of state.players) {
    const r = p.runOrder;
    if (!r || r.untilTick < state.tick) continue;
    if (isBallOwner(state, p)) continue;
    const tx = p.targetFx.x + Math.round((r.xFx - p.targetFx.x) * ro.pull);
    const ty = p.targetFx.y + Math.round((r.yFx - p.targetFx.y) * ro.pull);
    p.targetFx = clampToPitch(pitch, tx, ty);
  }
}
