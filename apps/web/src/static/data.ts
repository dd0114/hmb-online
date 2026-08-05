/**
 * 스태틱 모드 목데이터 (#444) — `data/**` 발행물을 **그대로** 번들한다.
 *
 * ⚠️ 여기서 선수·봇·경제 수치를 새로 짓지 않는다. 라이브 서버가 읽는 것과 **같은 파일**이라
 * "목데이터로 돈다"가 곧 "실데이터 형태로 돈다"가 된다(재발명 금지 — 루트 §10 운영 모델).
 * 핀은 라이브 발행핀과 같다: players.v2.6 · bots.v3 · economy.v3.
 */
import playersJson from "../../../../data/players/players.v2.6.json";
import botsJson from "../../../../data/players/bots.v3.json";
import economyJson from "../../../../data/players/economy.v3.json";
import type { PlayerAttributes } from "@hmb/shared";
import type { Grade } from "../common/grades";

export interface SeedPlayer {
  id: string;
  name: string;
  shortName?: string;
  position: string;
  grade: Grade;
  attributes: PlayerAttributes;
  personality?: string;
  /** 카탈로그 운영 플래그. **false = 미오픈** — 스태틱 빌드는 이 값을 그대로 존중한다(#443). */
  active?: boolean;
}

export interface SeedBotDeckSlot {
  playerId: string;
  slotIndex: number;
  promptText?: string;
}

export interface SeedBot {
  id: string;
  name: string;
  persona: string;
  analysisText: string;
  strengthMul?: number;
  deck: { formation: string; starters: SeedBotDeckSlot[]; bench: string[] };
}

export interface SeedEconomy {
  initialPoints: number;
  initialGems: number;
  starterPack: string[];
  gacha: {
    singleCost: number;
    tenCost: number;
    tenCount: number;
    rates: Record<string, number>;
    tenPityMinGrade: string;
  };
  rewards: { win: number; draw: number; loss: number };
}

export const SEED_PLAYERS = playersJson as unknown as SeedPlayer[];
export const SEED_BOTS = botsJson as unknown as SeedBot[];
export const SEED_ECONOMY = economyJson as unknown as SeedEconomy;

const BY_ID = new Map(SEED_PLAYERS.map((p) => [p.id, p]));

export function seedPlayer(id: string): SeedPlayer | undefined {
  return BY_ID.get(id);
}

/**
 * 신규 획득 경로(뽑기·스타터 보정)에 노출되는 풀 = `active !== false`.
 * 정적 호스팅엔 서버 게이트가 없으므로 **미오픈 유닛은 이 목록에서 구조적으로 빠진다**(#443).
 */
export const OPEN_PLAYERS = SEED_PLAYERS.filter((p) => p.active !== false);

/** 봇 능력치 배율(#252) — Java `withStrengthMultiplier` 와 같은 식: round 후 1..100 클램프. */
export function scaleAttributes(attrs: PlayerAttributes, mul: number): PlayerAttributes {
  if (mul === 1) return attrs;
  const out = {} as Record<string, number>;
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = Math.max(1, Math.min(100, Math.round(v * mul)));
  }
  return out as unknown as PlayerAttributes;
}
