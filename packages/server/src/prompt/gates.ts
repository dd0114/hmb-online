import type { PromptDelta, TacticalInput, OpponentRosterEntry } from "@hmb/shared";

/**
 * 산출 정합 게이트 (#193 W2b-B3) — 두 kind(team-input · team-input-patch) 공통, **최종 TacticalInput 기준**.
 *
 * 설계 원칙: **값의 '방향'은 강제하지 않는다**(감독 지시 해석의 자유도 불변).
 * 여기서 막는 것은 두 가지뿐 —
 *  - **자기모순**: 조합 자체가 축구적으로 성립하지 않는 것(낮은 라인 + 오프사이드 트랩).
 *  - **물리 파손 / 지시 미이행**: 배치가 깨지거나(동일 좌표 밀집), 마킹 지시를 받고도 대상이 없음.
 *
 * throw 메시지가 곧 피드백이다 — ExecutorLoop.executeWithGate 가 이 문구를 그대로 1회 재시도 프롬프트에
 * 실어 보낸다(기존 경로 재사용, 새 배선 없음).
 */

/** 게이트 임계(하드코딩 금지 — 튜닝은 이 오브젝트에서). */
export const SANITY_GATE_CONFIG = {
  /** G1: 오프사이드 트랩을 켤 수 있는 최소 수비라인 높이. 이 미만 + 트랩 ON = 자기모순. */
  trapMinLineHeight: 0.45,
  /** G3: 동일 basePosition 좌표를 공유해도 되는 최대 인원(초과 = 배치 파손). */
  maxPlayersSameSpot: 2,
  /** G3: 좌표 동일성 판정 소수 자리(부동소수 잡음 흡수). */
  spotPrecision: 3,
} as const;

/** 마킹 지시 감지 — 카탈로그 marking 지시어(stub 과 동일 어휘). */
const MARKING_RE = /막아|마크|전담|mark/i;

/** 게이트가 보는 요청 컨텍스트(두 kind 공통 부분집합 — 잡 컨텍스트를 그대로 넘겨도 구조적으로 호환). */
export interface SanityGateContext {
  teamPrompt: string;
  playerPrompts: Record<string, string>;
  opponentRoster?: readonly OpponentRosterEntry[];
  promptDelta?: PromptDelta;
}

/**
 * 게이트가 "이번 요청의 지시"로 보는 텍스트 — 팀 지시 + 개인 지시 + 델타의 **new** 쪽.
 * 삭제된 옛 지시(promptDelta.*.old)는 제외한다(이미 철회된 지시를 강제하지 않는다).
 */
export function gateContextText(ctx: SanityGateContext): string {
  const parts: string[] = [ctx.teamPrompt, ...Object.values(ctx.playerPrompts)];
  const d = ctx.promptDelta;
  if (d?.team?.new) parts.push(d.team.new);
  for (const entry of Object.values(d?.players ?? {})) {
    if (entry.new) parts.push(entry.new);
  }
  return parts.join("\n");
}

/**
 * 최종 TacticalInput 정합 검사. 위반 시 throw(메시지 = 재시도 피드백).
 * 순수 함수 — 두 kind 의 validate 말미에서 호출된다.
 */
export function assertTacticalSanity(input: TacticalInput, ctx: SanityGateContext): void {
  const cfg = SANITY_GATE_CONFIG;

  // ── G1 트랩 자기모순: 라인을 내려 두고 오프사이드 트랩을 켜는 건 성립하지 않는다.
  if (input.team.offsideTrap && input.team.defensiveLineHeight < cfg.trapMinLineHeight) {
    throw new Error(
      `낮은 수비라인(defensiveLineHeight ${input.team.defensiveLineHeight})에서 오프사이드트랩 활성은 자기모순 — ` +
        `트랩을 끄거나 라인을 ${cfg.trapMinLineHeight} 이상으로 올려라`,
    );
  }

  // ── G2 마킹 지시 미이행: 마킹을 지시받았는데 markTarget 이 하나도 없다.
  //    단, 상대 로스터가 없으면 강제하지 않는다(고를 대상이 없는데 유령 id 를 지어내게 만들면 안 됨).
  const hasOpponents = (ctx.opponentRoster?.length ?? 0) > 0;
  if (hasOpponents && MARKING_RE.test(gateContextText(ctx))) {
    const marks = input.players.filter((p) => p.markTarget !== undefined && p.markTarget !== "").length;
    if (marks === 0) {
      throw new Error("마킹 지시가 있으나 markTarget 미설정 — 상대 로스터에서 대상을 골라 설정하라");
    }
  }

  // ── G3 배치 파손: 같은 좌표에 3명 이상이 겹치면 포메이션이 무너진다(엔진 배치가 한 점으로 붕괴).
  //    (0..1 범위 이탈은 shared clampTacticalInput 이 이미 처리 — 게이트는 밀집만 본다.)
  const counts = new Map<string, string[]>();
  for (const p of input.players) {
    const key = `${p.basePosition.x.toFixed(cfg.spotPrecision)},${p.basePosition.y.toFixed(cfg.spotPrecision)}`;
    counts.set(key, [...(counts.get(key) ?? []), p.playerId]);
  }
  for (const [key, ids] of counts) {
    if (ids.length > cfg.maxPlayersSameSpot) {
      throw new Error(
        `배치 파손 — basePosition (${key}) 에 ${ids.length}명이 겹침(${ids.join(",")}). ` +
          `한 지점에 ${cfg.maxPlayersSameSpot}명까지만, 나머지는 서로 다른 좌표로 분산하라`,
      );
    }
  }
}
