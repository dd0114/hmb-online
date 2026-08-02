import type { TeamSide } from "@hmb/shared";
import type { EngineConfig } from "./config";
import type { Pitch } from "./pitch";
import type { SimState, SimPlayer } from "./simstate";
import { isBallOwner } from "./simstate";
import { attackGoal, attackProgressX, clampToPitch, defendGoal, distToAttackGoal } from "./pitch";
import { fclamp, fdist, isqrt } from "./fixedmath";
import { defShapeObserver } from "./action";

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
  const team = state.teams[side];
  const sign = side === "home" ? 1 : -1;
  // #377 S3-B: 구 하드코딩 상수를 config 로 승격(§2-4). 롤백 경로는 구 상수를 그대로 써서
  // **비트 동일**을 지킨다 — 이 한 줄이 "롤백이 정말 0.38.0 인가"를 성립시킨다.
  const range = config.movement.defLine.enabled ? config.movement.defLine.heightRangeX : LINE_HEIGHT_RANGE;
  const lineShift = (team.defensiveLineHeight - 0.5) * pitch.wFx * range;
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

/* ------------------------------------------------------------------------- *
 * 수비 형태(#377 S3-B) — 공유 수비 라인 · 오픈플레이 레스트디펜스
 * ------------------------------------------------------------------------- */

/**
 * **그룹 내 순위 매핑**(전순서: 점수 → `idHash` → `id`) — 코너 잔류/아웃렛(#182)이 쓰던 관용구를
 * 여기로 일반화했다. `decision.ts:cornerHolderRank` 가 이제 이 함수의 특수화이고, 오픈플레이
 * 레스트디펜스(`applyRestDefence`)가 두 번째 소비자다.
 *
 * ⚠️ **이 추출은 no-op 이어야 한다** — 코너 경로의 점수 함수·비교 순서·조기 종료가 한 글자도
 * 달라지지 않았고, 골든 해시로 그것을 증명한다(그러지 못하면 추출을 포기하고 병렬 함수를 둔다는
 * 것이 이 웨이브의 사전 합의였다). 남의 계약(`corner-rest-defence.test.ts`)을 내 변경에 맞추지 않는다.
 *
 * @param count  뽑을 인원. 0 이하면 아무도 안 뽑는다.
 * @param lowest true = 점수가 가장 **낮은** N명(= 뒤에 남는 쪽) · false = 가장 **높은** N명.
 * @returns 뽑혔으면 그룹 내 순위(0-based)와 그룹 크기, 아니면 `rank: -1`.
 */
export function holderRank(
  state: SimState,
  player: SimPlayer,
  count: number,
  lowest: boolean,
  score: (p: SimPlayer) => number,
): { rank: number; count: number } {
  const miss = { rank: -1, count: 0 };
  if (count <= 0) return miss;
  const mine = score(player);
  let ahead = 0;
  for (const p of state.players) {
    if (p.side !== player.side || p.isGK || p.id === player.id) continue;
    if (isBallOwner(state, p)) continue;
    const r = score(p);
    // 동률(예: LCB/RCB 가 슬롯·성향 모두 같음)은 idHash → id 로 안정 정렬.
    const tie = p.idHash !== player.idHash ? p.idHash < player.idHash : p.id < player.id;
    const better = r === mine ? tie : lowest ? r < mine : r > mine;
    if (better && ++ahead >= count) return miss;
  }
  return { rank: ahead, count };
}

/**
 * **공유 수비 라인**(#377 S3-B · 로드맵 W5-2) — 백4가 서로를 보고 한 줄을 유지한다.
 *
 * ## 왜 여기(decide 루프 *뒤*)인가 — 이건 스프링이 아니라 **제약**이다
 * 기존 수비 x 는 `base + (lineX − base) × defendCompactX` 라 **또 하나의 스프링**이었고, 그
 * 스프링을 아무리 세게 당겨도 라인이 안 생긴다(§config `defLine` 주석의 7.20m 실측). 여기서는
 * `decideOffBall` 이 만든 목표를 **입력으로 받아** 이탈자만 되돌린다.
 *
 * ## ⚠️ 왜 기준점이 **위치**인가 (설계의 핵심 — 그리고 초판이 여기서 틀렸다)
 * 초판은 기준선을 **목표의 평균**으로 잡았다. 계약은 통과했지만(목표 이탈 p90 3.58 → 1.10, 5-rung
 * 엄격 단조) **선수는 한 줄에 서지 않았다**(멤버 위치 산포 8.70 → 7.91m = 사실상 무변화). 진단이
 * 그 이유를 한 줄로 답한다:
 *
 *   **목표는 이미 촘촘하다(산포 4.40m). 선수가 자기 목표에서 평균 7.65m 뒤에 있을 뿐이다.**
 *
 * 즉 산포는 목표에 있지 않고 **지연**에 있다. 목표를 더 모으는 것은 이미 촘촘한 것을 더 촘촘하게
 * 하는 것이라 **정의상 참인 계약**(동어반복)을 만들 뿐이다 — #377 M2 `wallClearM` 이 정확히 이
 * 함정이었다.
 *
 * 지연 편차를 줄이는 유일한 방법: **뒤진 선수에게 "더 빨리"는 불가능한 주문**이고(이미 최대 속도)
 * **앞선 선수에게 "기다려라"는 가능한 주문**이다. 그건 기준점이 라인이 *실제로 서 있는 곳*일 때만
 * 표현된다. 그래서 이 함수는 **위치 평균 기준 응집 밴드**다:
 *
 *   `밴드 = [라인위치 + 역할오프셋 ± blockLineRangeM]` · `목표를 그 밴드로 클램프` ·
 *   `lineDiscipline` 만큼만 적용
 *
 * 밴드 **안**이면 아무것도 안 한다(마킹·압박을 근거리에서 안 흔든다). 밴드 **밖**이면 되돌린다.
 * 라인이 전진하지 못하게 되지도 않는다 — 멤버가 올라가면 위치 평균이 올라가고 밴드도 따라 올라
 * 간다. 이게 실축의 "유닛으로 올라간다"이고, 기준점이 자기 위치라 **폭주가 구조적으로 없다**
 * (기준점에 높이 가산을 더하면 매 틱 앞으로 미는 되먹임이 생긴다 — 그래서 라인 높이 권한은
 *  여기가 아니라 공에 매인 `computeTeamPlan` 쪽 `heightRangeX` 가 갖는다).
 *
 * `refMode: "planLine"` 이 "안 되는 쪽"(공에 매인 절대 기준점)을 config 로 재현하는 아블레이션
 * 팔이다(#377 M2 m3 — 한 팔이 재현 불가면 귀속 분해가 검증 불가가 된다).
 *
 * ## 규율
 *  - 틱당 1회, 선수 순회 **밖**(§5-1). `player.seen` 을 만지지 않는다.
 *  - 배열 순서 비의존: 멤버를 `id` 전순서로 정렬해 쓰고, 집계는 정수 합·min/max 뿐이다(§5-3).
 *  - 정수 고정소수만. `Rng` 를 받지 않는다(= 소비할 수 없다).
 *  - **정지·미킥 세트피스 구간에서는 호출되지 않는다** — 그 구간은 규칙기반 배치가 소유한다(#176/#307).
 *
 * @param unitBusy 압박 유닛이 데려간 선수들. 압박 담당의 그 틱 목표는 **공**이고 커버·지원은
 *   이미 맡은 자리가 있다 — 라인으로 되당기면 S3-A 를 그대로 되돌린다.
 */
/**
 * **오프사이드 트랩 — 라인 기준점의 조건부 전진량**(#377 S3-C · 로드맵 W5-3).
 *
 * ## 무엇이 없었나 (구조 사실 — 측정이 아니다)
 * `team.offsideTrap` 의 소비처는 `contest.ts:checkOffside` **하나**였고, 거기서 하는 일은
 * **심판이 쓰는 판정선을 `rules.offside.trapBiasM` 만큼 옮기는 것**이 전부였다. 선수 목표를
 * 읽는 코드도, 라인을 미는 코드도 0줄이다. 즉 트랩은 약한 것이 아니라 **없었다**.
 *
 * ## 설계 — "얼마나 세게"가 아니라 **"어디서 거는가"**
 * 20시드 실측에서 어깨 위 러너(라인 앞 4m)는 25–40m 구간에서 위험지역과 거의 같은 밀도로
 * 존재하는데(0.841 vs 0.858) 뚫렸을 때의 대가는 1/3 이고 40–60m 이면 1/20 이다(수치표는 config
 * `defLine.trap` 주석). 그래서 이 함수의 대부분은 **게이트**이고 세기는 노브 하나다.
 *
 *   세기 = clamp((공↔우리골 − minBallDistM) / releaseSmooth, 0, 1)   ← 연속(계단 아님)
 *   전진량 = stepUpM × 세기                                          ← 어깨 러너가 있을 때만
 *
 * ⚠️ **연속인 이유**: 이진 on/off 면 목표가 매 틱 앞뒤로 튀어 #178(마크 당김 진동)이 그대로
 * 재현된다 — 선수는 제자리에서 왕복하고 총 이동만 늘어난다.
 *
 * ⚠️ **무상태인 이유**(hold/cooldown 을 저장하지 않는다): `SimState` 에 필드를 늘리면
 * `packages/server` 의 `SimStateSchema` 가 미선언 키를 **조용히 버려** 하프 재개에서 무음 유실이
 * 된다(#154/#241 계열, 그 파일이 그 사고를 두 번 적어 뒀다). 창(window)은 저장하는 것이 아니라
 * **트리거 조건 자체의 지속**에서 나온다 — 러너는 어깨에 몇 틱씩 머문다.
 *
 * ## 규율
 *  - 순수 함수. `Rng` 를 받지 않는다(= 소비할 수 없다) · 정수 고정소수만 · 상대 위치는 **실측**
 *    좌표를 쓴다(`seen` 기억이 아니다 — 라인 배정은 팀 단위 계산이고 선수 인지 계층이 아니다).
 *  - `state.players` 순회 순서에 의존하지 않는다(합·비교만).
 *
 * @returns 기준점에 더할 전진량(고정소수, 진행도 축). 트랩이 안 걸리면 0.
 */
function trapStepUpFx(
  state: SimState,
  config: EngineConfig,
  pitch: Pitch,
  defSide: TeamSide,
  members: readonly SimPlayer[],
  refProgFx: number,
  progOf: (x: number) => number,
): number {
  const tp = config.movement.defLine.trap;
  // 롤백 경로 = 0.39.0. 한 줄도 다르게 돌지 않는다.
  if (!tp.enabled) return 0;
  // 지시가 없으면 트랩은 없다 — 이 웨이브가 실효화하는 것이 바로 이 불리언이다.
  if (!state.teams[defSide].offsideTrap) return 0;
  if (tp.stepUpM <= 0 && tp.releaseSmooth < 0) return 0;
  const scale = config.fixedScale;

  // ① 거리 게이트 — 공이 우리 골에서 충분히 멀 때만. 세기는 `releaseSmooth` 폭에 걸쳐 연속.
  const goal = defendGoal(pitch, defSide);
  const ballDistFx = fdist(state.ball.posFx.x, state.ball.posFx.y, goal.x, goal.y);
  const minDistFx = toFixedM(tp.minBallDistM, scale);
  const smoothFx = Math.max(1, toFixedM(tp.releaseSmooth, scale));
  const overFx = ballDistFx - minDistFx;
  if (overFx <= 0) return 0;
  // strength = min(1, over/smooth) 를 정수로. 분해능 1/1000(고정소수 반올림 누적 회피).
  const strengthMilli = Math.min(1000, Math.round((overFx * 1000) / smoothFx));
  if (strengthMilli <= 0) return 0;

  // ② 어깨 게이트 — 라인 **바로 앞**(아직 온사이드)에 상대가 있어야 건다. 잡을 사람이 없으면
  //    라인을 올릴 이유가 없다(그건 그냥 하이라인이고, 대가만 치른다).
  //
  //    ⚠️ 축 방향에 주의: `progOf` 는 **우리 골 0 → 상대 골 +** 다. 그러니 우리 라인보다
  //    **작은** 진행도 = 우리 골 쪽 = **이미 라인 뒤(오프사이드 위치)** 이고, 밀어올려서 잡을
  //    수 있는 "어깨 위 러너"는 라인보다 **큰** 쪽 밴드 `[ref, ref + band]` 에 있다.
  const bandFx = toFixedM(tp.shoulderBandM, scale);
  let shoulder = 0;
  for (const p of state.players) {
    if (p.side === defSide || p.isGK) continue;
    const prog = progOf(p.posFx.x);
    if (prog < refProgFx) continue; // 이미 라인 뒤 = 트랩 대상이 아니다(이미 잡혀 있다).
    if (prog <= refProgFx + bandFx) shoulder++;
  }
  if (shoulder < tp.minShoulder) return 0;

  // ③ 전진량. 멤버가 하나도 없으면 호출부가 여기 오지 않는다(applied 게이트).
  if (members.length === 0) return 0;
  return Math.round((toFixedM(tp.stepUpM, scale) * strengthMilli) / 1000);
}

/** 미터 → 고정소수(정수). `toFixed` 를 import 하지 않고 같은 규칙을 쓴다(정수 반올림). */
function toFixedM(m: number, scale: number): number {
  return Math.round(m * scale);
}

export function applyDefensiveLine(
  state: SimState,
  config: EngineConfig,
  pitch: Pitch,
  defSide: TeamSide,
  unitBusy: ReadonlySet<SimPlayer>,
): void {
  const dl = config.movement.defLine;
  // 롤백 경로 = 0.38.0. 관측조차 흘리지 않는다(한 줄도 다르게 돌지 않게).
  if (!dl.enabled) return;
  const scale = config.fixedScale;
  const obs = defShapeObserver();
  // 진행도(자기 골 0 → 상대 골 wFx). 정수 그대로라 반올림 손실이 없다.
  const progOf = (x: number): number => (defSide === "home" ? x : pitch.wFx - x);
  const xOf = (prog: number): number => (defSide === "home" ? prog : pitch.wFx - prog);

  const maxBaseProgFx = Math.round(dl.memberProgressMax * pitch.wFx);
  const members: SimPlayer[] = [];
  let excludedByUnit = 0;
  for (const p of state.players) {
    if (p.side !== defSide || p.isGK) continue;
    if (isBallOwner(state, p)) continue;
    if (progOf(p.baseFx.x) > maxBaseProgFx) continue;
    if (unitBusy.has(p)) {
      excludedByUnit++;
      continue;
    }
    members.push(p);
  }
  // 전순서 정렬(§5-3). 집계가 합·min/max 라 결과는 순서와 무관하지만, 순서 의존이 **구조적으로**
  // 없다는 것을 코드가 보이게 한다 — 퇴장이 `splice` 로 배열 순서를 바꾼다.
  members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const applied = members.length >= dl.minMembers;
  let refProgFx = 0;
  let heightBiasFx = 0;
  let trapBiasFx = 0;
  let beforeSpreadFx = 0;
  let afterSpreadFx = 0;

  if (applied) {
    let sumP = 0;
    let sumB = 0;
    let minT = Number.MAX_SAFE_INTEGER;
    let maxT = -Number.MAX_SAFE_INTEGER;
    for (const p of members) {
      const t = progOf(p.targetFx.x);
      // ⚠️ 기준점은 **위치**다(목표가 아니다) — 위 주석의 7.65m 진단이 이 한 줄의 근거다.
      sumP += progOf(p.posFx.x);
      sumB += progOf(p.baseFx.x);
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const n = members.length;
    const meanP = Math.round(sumP / n);
    const meanB = Math.round(sumB / n);
    beforeSpreadFx = maxT - minT;
    // 라인 높이 권한은 여기가 아니라 `computeTeamPlan`(공에 매인 좌표)이 갖는다 — 자기 위치
    // 기준점에 높이 가산을 더하면 매 틱 앞으로 미는 되먹임(폭주)이 된다.
    heightBiasFx = 0;
    refProgFx = dl.refMode === "planLine" ? progOf(state.plan[defSide].lineX) : meanP;
    // #377 S3-C 오프사이드 트랩 — 기준점을 **조건부로** 앞으로 민다. 밴드는 그대로라
    // 라인 전체가 같이 움직인다(= 유닛으로 올라간다). 자세한 근거는 config `defLine.trap` 주석.
    trapBiasFx = trapStepUpFx(state, config, pitch, defSide, members, refProgFx, progOf);
    refProgFx += trapBiasFx;
    const bandFx = Math.round(dl.blockLineRangeM * scale);

    const k = config.movement.lineDiscipline;
    let minA = Number.MAX_SAFE_INTEGER;
    let maxA = -Number.MAX_SAFE_INTEGER;
    for (const p of members) {
      const before = progOf(p.targetFx.x);
      // 역할 깊이차는 **전부 지우지 않는다** — 실축 라인도 완전 평면이 아니다.
      const centre = refProgFx + Math.round((progOf(p.baseFx.x) - meanB) * dl.roleOffsetKeep);
      const hi = centre + bandFx;
      // **밴드 안이면 손대지 않는다** — 이탈자만 되돌리는 외과적 제약이다.
      // `holdBack`(출하)은 **앞으로 튀어나간 선수만** 되돌린다 — 뒤에 남은 선수를 끌어올리면
      // 라인이 통째로 올라가 뒤 공간이 열린다(config `bandMode` 주석의 실측).
      const lo = dl.bandMode === "both" ? centre - bandFx : -Number.MAX_SAFE_INTEGER;
      const desired = before < lo ? lo : before > hi ? hi : before;
      const after = before + Math.round((desired - before) * k);
      const c = clampToPitch(pitch, xOf(after), p.targetFx.y);
      p.targetFx = c;
      const actual = progOf(c.x);
      if (actual < minA) minA = actual;
      if (actual > maxA) maxA = actual;
      if (obs) {
        obs({
          kind: "lineMember",
          tick: state.tick,
          side: defSide,
          playerId: p.id,
          beforeProgFx: before,
          desiredProgFx: desired,
          afterProgFx: actual,
          posProgFx: progOf(p.posFx.x),
        });
      }
    }
    afterSpreadFx = maxA - minA;
  }

  if (obs) {
    obs({
      kind: "line",
      tick: state.tick,
      side: defSide,
      members: members.length,
      excludedByUnit,
      applied,
      refProgFx,
      heightBiasFx,
      trapBiasFx,
      beforeSpreadFx,
      afterSpreadFx,
    });
  }
}

/**
 * **레스트 디펜스(오픈플레이)**(#377 S3-B · 로드맵 W5-8) — 공격할 때 뒤에 남을 사람이 정해져 있다.
 *
 * 지금까지 잔류라는 개념은 **코너 분기 안에만** 있었고, 오픈플레이에서는 `attackLinePush`(0.56)가
 * 역할 게이트 없이 센터백에게도 걸렸다(실측: CB 가 공격 틱의 18.53% 를 하프라인 너머에서,
 * 경기당 최고 91.21m = 상대 골라인 14m 앞). 인원 매핑과 선정은 코너와 **같은 관용구**(`holderRank`)를
 * 쓰고, 코너가 그 특수화다.
 *
 * ## 왜 `attackLinePush` 를 내리지 않는가
 * 같은 사다리에서 팀 전체 공격 산포가 17.18 → 13.20 으로 같이 눌린다 — 팀 업필드 이동은
 * **의도된 동역학**이라 그걸 죽이면 공격이 같이 죽는다(M3-B 가 통과한 성립 조건: 수비를 똑똑하게
 * 만들면서 공격을 안 죽인다). 그래서 전역 계수가 아니라 **역할 조건부 상한**이다.
 *
 * 규율은 `applyDefensiveLine` 과 같다(틱당 1회 · 선수 순회 밖 · 정수 · 순서 비의존 · 세트피스 제외).
 */
export function applyRestDefence(
  state: SimState,
  config: EngineConfig,
  pitch: Pitch,
  atkSide: TeamSide,
): void {
  const rd = config.movement.restDefence;
  // 롤백 경로 = 0.38.0.
  if (!rd.enabled) return;
  const obs = defShapeObserver();
  const team = state.teams[atkSide];
  // 가담도 매핑 — 코너 `teamCornerCommit` 과 동형(높을수록 적게 남긴다).
  const commit = fclamp(
    0.5 + (team.defensiveLineHeight - 0.5) * rd.commitLineWeight + (team.tempo - 0.5) * rd.commitTempoWeight,
    0,
    1,
  );
  const want = Math.round(rd.countMax + (rd.countMin - rd.countMax) * commit);
  if (want <= 0) {
    if (obs) obs({ kind: "rest", tick: state.tick, side: atkSide, want: 0, assigned: 0, capped: 0 });
    return;
  }
  const progOf = (x: number): number => (atkSide === "home" ? x : pitch.wFx - x);
  const xOf = (prog: number): number => (atkSide === "home" ? prog : pitch.wFx - prog);
  const capFx = Math.round(rd.lineCapProgress * pitch.wFx);
  // "얼마나 올라가고 싶은가" — 슬롯 깊이 + 프롬프트 성향. 코너 `cornerGoScore` 와 같은 형태이고,
  // 오버라이드가 충분히 크면 슬롯 순서를 뒤집는다("이 CB 는 올라가라" / "이 윙어는 뒤를 봐라").
  const score = (p: SimPlayer): number =>
    attackProgressX(pitch, p.side, p.baseFx.x) + (p.behavior.forwardRunFreq - 0.5) * rd.playerOverrideWeight;

  let assigned = 0;
  let capped = 0;
  for (const p of state.players) {
    if (p.side !== atkSide || p.isGK) continue;
    if (isBallOwner(state, p)) continue;
    const h = holderRank(state, p, want, true, score);
    if (h.rank < 0) continue;
    assigned++;
    const before = progOf(p.targetFx.x);
    let after = before;
    const hit = before > capFx;
    if (hit) {
      const c = clampToPitch(pitch, xOf(capFx), p.targetFx.y);
      p.targetFx = c;
      after = progOf(c.x);
      capped++;
    }
    if (obs) {
      obs({
        kind: "restMember",
        tick: state.tick,
        side: atkSide,
        playerId: p.id,
        beforeProgFx: before,
        afterProgFx: after,
        capped: hit,
      });
    }
  }
  if (obs) obs({ kind: "rest", tick: state.tick, side: atkSide, want, assigned, capped });
}
