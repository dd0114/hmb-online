import type { Vec2 } from "./vec.js";

/**
 * 포메이션 슬롯 → 기준 배치 좌표 (#324).
 *
 * <p><b>왜 계약인가</b>: 유저는 덱 화면 전술보드에서 선수를 좌우로 끌어다 놓는데, 그 배치가
 * `slotIndex` 하나로만 서버에 전달된다. slotIndex 가 피치 어디인지 아무도 정의하지 않으면
 * AI 가 `basePosition` 11개를 매번 새로 지어내고, 그 결과 (a) 유저가 잡은 좌우가 무시되며
 * (b) 두 선수가 <b>같은 좌표</b>를 받아 완전히 포개진다. 둘 다 라이브에서 실제로 났다 —
 * 어웨이 센터백 2명이 전반의 24.9% 를 1m 안에 붙어 있었고(대조군 0.4~1.1%), 같은 유저의
 * 연속 매치에서 선수 4명이 좌↔우로 뒤집혔다.
 *
 * <p><b>규약</b>(엔진 `pitch.ts slotToReal` 과 동일):
 * <ul>
 *   <li>{@code x} = 진행 방향. 0 = 자기 골문, 1 = 상대 골문.</li>
 *   <li>{@code y} = 폭. 0 = 그 팀의 <b>왼쪽</b>, 1 = 오른쪽.</li>
 *   <li>둘 다 <b>팀 자기 기준</b>이다 — 어웨이는 엔진이 x·y 를 <b>모두</b> 미러(1-n)하므로
 *       "y=0 이 우리 왼쪽"이 양 팀에서 성립한다.</li>
 * </ul>
 *
 * <p><b>4-3-3 은 엔진 {@code config.formations["4-3-3"]} 과 값이 동일해야 한다</b> — 이 표를 새로
 * 만든 게 아니라 이미 엔진에 있던 규약을 프롬프트가 읽을 수 있는 자리로 올린 것이다.
 * 드리프트 락은 `packages/server/src/prompt/formation-lock.test.ts`(엔진·shared 를 둘 다
 * 정당하게 import 하는 유일한 자리)가 건다.
 *
 * <p>나머지 3종은 봇 덱이 쓰는 포메이션이다(4-4-2 · 4-2-3-1 · 5-3-2). web 이 유저에게 제시하는
 * 것은 4-4-2 · 4-3-3 둘뿐이고, 그 보드 행 구성은 {@link FORMATION_ROWS} 와 일치해야 한다
 * (`apps/web/src/deck/deck-logic.test.ts` 가 계약으로 건다).
 */
export const FORMATION_BASE_POSITIONS: Record<string, readonly Vec2[]> = {
  // 엔진 formation433 과 바이트 동일. GK · LB LCB RCB RB · LCM CM RCM · LW ST RW
  "4-3-3": [
    { x: 0.05, y: 0.5 },
    { x: 0.22, y: 0.2 },
    { x: 0.16, y: 0.4 },
    { x: 0.16, y: 0.6 },
    { x: 0.22, y: 0.8 },
    { x: 0.44, y: 0.32 },
    { x: 0.4, y: 0.5 },
    { x: 0.44, y: 0.68 },
    { x: 0.7, y: 0.2 },
    { x: 0.78, y: 0.5 },
    { x: 0.7, y: 0.8 },
  ],
  // GK · LB LCB RCB RB · LM LCM RCM RM · LST RST
  "4-4-2": [
    { x: 0.05, y: 0.5 },
    { x: 0.22, y: 0.2 },
    { x: 0.16, y: 0.4 },
    { x: 0.16, y: 0.6 },
    { x: 0.22, y: 0.8 },
    { x: 0.46, y: 0.15 },
    { x: 0.4, y: 0.4 },
    { x: 0.4, y: 0.6 },
    { x: 0.46, y: 0.85 },
    { x: 0.72, y: 0.4 },
    { x: 0.72, y: 0.6 },
  ],
  // GK · LB LCB RCB RB · LDM RDM · LAM CAM RAM · ST
  "4-2-3-1": [
    { x: 0.05, y: 0.5 },
    { x: 0.22, y: 0.2 },
    { x: 0.16, y: 0.4 },
    { x: 0.16, y: 0.6 },
    { x: 0.22, y: 0.8 },
    { x: 0.36, y: 0.4 },
    { x: 0.36, y: 0.6 },
    { x: 0.58, y: 0.2 },
    { x: 0.55, y: 0.5 },
    { x: 0.58, y: 0.8 },
    { x: 0.78, y: 0.5 },
  ],
  // GK · LWB LCB CB RCB RWB · LCM CM RCM · LST RST
  "5-3-2": [
    { x: 0.05, y: 0.5 },
    { x: 0.24, y: 0.12 },
    { x: 0.16, y: 0.32 },
    { x: 0.14, y: 0.5 },
    { x: 0.16, y: 0.68 },
    { x: 0.24, y: 0.88 },
    { x: 0.42, y: 0.3 },
    { x: 0.38, y: 0.5 },
    { x: 0.42, y: 0.7 },
    { x: 0.7, y: 0.4 },
    { x: 0.7, y: 0.6 },
  ],
};

/**
 * 포메이션 행 구성 — <b>표시 순서</b>(FW 행 먼저 … GK 마지막), 각 행은 <b>좌→우</b>.
 * web 전술보드(`FORMATION_LAYOUTS`)가 유저에게 보여 주는 배열과 같은 구조다.
 * 행 안에서 slotIndex 가 커지면 y 도 커진다(= 보드에서 오른쪽으로 갈수록 피치에서도 오른쪽).
 */
export const FORMATION_ROWS: Record<string, readonly (readonly number[])[]> = {
  "4-3-3": [[8, 9, 10], [5, 6, 7], [1, 2, 3, 4], [0]],
  "4-4-2": [[9, 10], [5, 6, 7, 8], [1, 2, 3, 4], [0]],
  "4-2-3-1": [[10], [7, 8, 9], [5, 6], [1, 2, 3, 4], [0]],
  "5-3-2": [[9, 10], [6, 7, 8], [1, 2, 3, 4, 5], [0]],
};

/** 표에 없는 포메이션이 오면 기준으로 삼을 것(서버 기본 포메이션과 같다). */
export const DEFAULT_BASE_FORMATION = "4-4-2";

/**
 * `formation` 의 슬롯 좌표표. 모르는 포메이션이면 {@link DEFAULT_BASE_FORMATION} 으로 떨어진다 —
 * 프롬프트에 좌표를 <b>못 싣는 것</b>보다 근사값이라도 싣는 편이 낫다(그게 이 이슈의 결함이었다).
 */
export function formationBasePositions(formation: string): readonly Vec2[] {
  return FORMATION_BASE_POSITIONS[formation] ?? FORMATION_BASE_POSITIONS[DEFAULT_BASE_FORMATION]!;
}

/** `formation` 의 `slotIndex` 기준 좌표. 범위를 벗어나면 undefined. */
export function formationSlot(formation: string, slotIndex: number): Vec2 | undefined {
  return formationBasePositions(formation)[slotIndex];
}
