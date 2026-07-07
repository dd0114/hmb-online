import type {
  SelectData,
  TacticalInput,
  PlayerCard,
  PlayerInput,
  PlayerAttributes,
  PlayerBehavior,
  Vec2,
} from "@hmb/shared";
import { defaultEngineConfig } from "./config";
import { createRng } from "./rng";

/**
 * fixtures — 데모/테스트용 샘플. 4-3-3 두 팀의 SelectData(각 11명, 그럴듯한 속성)와
 * formation 기반 기본 TacticalInput(basePosition=슬롯, 중립 behavior)을 제공한다.
 * 완전 결정론(시드 RNG 로 속성 변주, 표준 난수 API 미사용).
 */

/** 4-3-3 슬롯별 역할·포지션 라벨. config.formations["4-3-3"] 순서와 1:1. */
const ROLES: { role: string; position: string; arch: Arch }[] = [
  { role: "GK", position: "GK", arch: "gk" },
  { role: "LB", position: "DF", arch: "fullback" },
  { role: "LCB", position: "DF", arch: "centreback" },
  { role: "RCB", position: "DF", arch: "centreback" },
  { role: "RB", position: "DF", arch: "fullback" },
  { role: "LCM", position: "MF", arch: "midfielder" },
  { role: "CM", position: "MF", arch: "midfielder" },
  { role: "RCM", position: "MF", arch: "midfielder" },
  { role: "LW", position: "FW", arch: "winger" },
  { role: "ST", position: "FW", arch: "striker" },
  { role: "RW", position: "FW", arch: "winger" },
];

type Arch = "gk" | "fullback" | "centreback" | "midfielder" | "winger" | "striker";

/** 아키타입별 속성 프로파일(0..100 근사 중심값). */
const ARCH_ATTRS: Record<Arch, PlayerAttributes> = {
  gk: {
    technical: 45, mental: 65, physical: 62, passing: 48, shooting: 20,
    tackling: 30, pace: 45, stamina: 55, positioning: 80,
  },
  fullback: {
    technical: 58, mental: 60, physical: 68, passing: 60, shooting: 40,
    tackling: 68, pace: 74, stamina: 78, positioning: 66,
  },
  centreback: {
    technical: 52, mental: 66, physical: 78, passing: 55, shooting: 35,
    tackling: 80, pace: 60, stamina: 66, positioning: 78,
  },
  midfielder: {
    technical: 70, mental: 68, physical: 66, passing: 76, shooting: 58,
    tackling: 60, pace: 64, stamina: 80, positioning: 66,
  },
  winger: {
    technical: 74, mental: 60, physical: 60, passing: 66, shooting: 66,
    tackling: 40, pace: 82, stamina: 72, positioning: 62,
  },
  striker: {
    technical: 72, mental: 64, physical: 68, passing: 62, shooting: 82,
    tackling: 35, pace: 76, stamina: 70, positioning: 74,
  },
};

/** 아키타입별 중립 성향에 역할색을 살짝 입힌 behavior. */
function behaviorFor(arch: Arch): PlayerBehavior {
  const base: PlayerBehavior = {
    positioningFreedom: 0.4,
    forwardRunFreq: 0.4,
    widthTendency: 0.4,
    supportDepth: 0.5,
    pressAggression: 0.5,
    passRisk: 0.4,
    passDirectness: 0.5,
    dribbleTendency: 0.4,
    shootTendency: 0.4,
  };
  switch (arch) {
    case "gk":
      return { ...base, forwardRunFreq: 0.05, shootTendency: 0.02, passRisk: 0.2, pressAggression: 0.1 };
    case "fullback":
      return { ...base, widthTendency: 0.75, forwardRunFreq: 0.5, shootTendency: 0.15 };
    case "centreback":
      return { ...base, forwardRunFreq: 0.12, widthTendency: 0.25, shootTendency: 0.08, passRisk: 0.25 };
    case "midfielder":
      return { ...base, forwardRunFreq: 0.5, supportDepth: 0.7, passDirectness: 0.55, shootTendency: 0.45 };
    case "winger":
      return { ...base, widthTendency: 0.8, forwardRunFreq: 0.7, dribbleTendency: 0.7, shootTendency: 0.6 };
    case "striker":
      return { ...base, forwardRunFreq: 0.75, shootTendency: 0.85, supportDepth: 0.5, dribbleTendency: 0.55 };
  }
}

/** 시드 변주( ±spread )로 속성 다양화. 결정론. */
function vary(attrs: PlayerAttributes, seedStr: string): PlayerAttributes {
  const rng = createRng(seedStr);
  const spread = 8;
  const j = (): number => Math.round((rng.next() * 2 - 1) * spread);
  const clamp = (v: number): number => (v < 1 ? 1 : v > 99 ? 99 : v);
  return {
    technical: clamp(attrs.technical + j()),
    mental: clamp(attrs.mental + j()),
    physical: clamp(attrs.physical + j()),
    passing: clamp(attrs.passing + j()),
    shooting: clamp(attrs.shooting + j()),
    tackling: clamp(attrs.tackling + j()),
    pace: clamp(attrs.pace + j()),
    stamina: clamp(attrs.stamina + j()),
    positioning: clamp(attrs.positioning + j()),
  };
}

function makeRoster(prefix: string, teamName: string): PlayerCard[] {
  return ROLES.map((r, i) => {
    const id = `${prefix}${i}`;
    return {
      playerId: id,
      name: `${teamName} ${r.role}`,
      position: r.position,
      attributes: vary(ARCH_ATTRS[r.arch], `attr-${id}`),
    } satisfies PlayerCard;
  });
}

/** 데모 SelectData(홈/어웨이 각 11명). */
export function makeSelectData(): SelectData {
  return {
    home: { name: "Home FC", players: makeRoster("H", "Home") },
    away: { name: "Away United", players: makeRoster("A", "Away") },
  };
}

/** formation 슬롯 기반 기본 TacticalInput. */
export function makeTacticalInput(prefix: string, seed: string): TacticalInput {
  const slots: Vec2[] = defaultEngineConfig.formations["4-3-3"]!;
  const players: PlayerInput[] = ROLES.map((r, i) => {
    const slot = slots[i]!;
    const duty = r.arch === "striker" || r.arch === "winger"
      ? "attack"
      : r.arch === "gk" || r.arch === "centreback"
        ? "defend"
        : "support";
    return {
      playerId: `${prefix}${i}`,
      role: r.role,
      duty,
      basePosition: { x: slot.x, y: slot.y },
      behavior: behaviorFor(r.arch),
      mentalModifier: 0,
    } satisfies PlayerInput;
  });

  return {
    seed,
    team: {
      formation: "4-3-3",
      defensiveLineHeight: 0.55,
      compactness: 0.5,
      tempo: 0.5,
      width: 0.55,
      pressingScheme: { intensity: 0.55, triggerLine: 0.5 },
      offsideTrap: false,
    },
    players,
  };
}

/** 데모 번들: 시드 + 두 팀 입력 + SelectData. */
export const demoSeed = "4815162342";
export const demoHome = makeTacticalInput("H", demoSeed);
export const demoAway = makeTacticalInput("A", demoSeed);
export const demoSelect = makeSelectData();
