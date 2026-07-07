import type { PlayerBehavior, TacticalInput, TeamInput } from "./tactical-input.js";

/** 값을 [min, max] 로 자른다. */
export function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return v < min ? min : v > max ? max : v;
}

/** 0..1 클램프. */
export const clamp01 = (v: number): number => clamp(v, 0, 1);

function clampBehavior(b: PlayerBehavior): PlayerBehavior {
  return {
    positioningFreedom: clamp01(b.positioningFreedom),
    forwardRunFreq: clamp01(b.forwardRunFreq),
    widthTendency: clamp01(b.widthTendency),
    supportDepth: clamp01(b.supportDepth),
    pressAggression: clamp01(b.pressAggression),
    passRisk: clamp01(b.passRisk),
    passDirectness: clamp01(b.passDirectness),
    dribbleTendency: clamp01(b.dribbleTendency),
    shootTendency: clamp01(b.shootTendency),
  };
}

function clampTeam(t: TeamInput): TeamInput {
  return {
    ...t,
    defensiveLineHeight: clamp01(t.defensiveLineHeight),
    compactness: clamp01(t.compactness),
    tempo: clamp01(t.tempo),
    width: clamp01(t.width),
    pressingScheme: {
      intensity: clamp01(t.pressingScheme.intensity),
      triggerLine: clamp01(t.pressingScheme.triggerLine),
    },
  };
}

/**
 * AI 산출 TacticalInput 의 모든 수치 필드를 유효 범위로 클램프한다. (PRD §6-1 안정성)
 * LLM 이 범위를 벗어난 값을 내도 엔진이 폭주하지 않도록 방어.
 */
export function clampTacticalInput(input: TacticalInput): TacticalInput {
  return {
    ...input,
    team: clampTeam(input.team),
    players: input.players.map((p) => ({
      ...p,
      basePosition: { x: clamp01(p.basePosition.x), y: clamp01(p.basePosition.y) },
      behavior: clampBehavior(p.behavior),
      mentalModifier: clamp(p.mentalModifier, -1, 1),
    })),
  };
}
