import { z } from "zod";
import { Vec2 } from "./vec.js";

/**
 * MatchLog — 결정론 엔진의 출력. (PRD §7·§8)
 * 틱별 좌표 스냅샷 + 이벤트 시계열 + 최종 스코어 + 틱 해시(재현·desync 검증).
 * web 은 tickSnapshots 를 보간해 실좌표 움직임을 재생한다.
 */

export const TeamSide = z.enum(["home", "away"]);
export type TeamSide = z.infer<typeof TeamSide>;

export const PlayerSnapshot = z.object({
  playerId: z.string(),
  team: TeamSide,
  pos: Vec2, // 피치 실좌표
});
export type PlayerSnapshot = z.infer<typeof PlayerSnapshot>;

export const TickSnapshot = z.object({
  tick: z.number(),
  minute: z.number(),
  ball: Vec2,
  ballOwner: z.string().nullable(),
  players: z.array(PlayerSnapshot),
  /** 결정론 검증용 상태 해시(FNV-1a 등). */
  hash: z.string(),
});
export type TickSnapshot = z.infer<typeof TickSnapshot>;

export const MatchEventType = z.enum([
  "kickoff",
  "pass",
  "interception",
  "tackle",
  "shot",
  "goal",
  "save",
  "foul",
  "offside",
  "free_kick",
  "penalty",
  "card", // detail: "yellow" | "red"
  "substitution",
  "half_whistle",
  "full_whistle",
]);
export type MatchEventType = z.infer<typeof MatchEventType>;

export const MatchEvent = z.object({
  tick: z.number(),
  minute: z.number(),
  type: MatchEventType,
  team: TeamSide.optional(),
  playerId: z.string().optional(),
  /** 슛 이벤트의 기대득점(0..1). */
  xg: z.number().optional(),
  detail: z.string().optional(),
});
export type MatchEvent = z.infer<typeof MatchEvent>;

export const Score = z.object({
  home: z.number(),
  away: z.number(),
});
export type Score = z.infer<typeof Score>;

export const MatchLog = z.object({
  /** 재현 번들 식별: 이 매치를 만든 config 버전 + 시드. (PRD §7-4/§7-6) */
  configVersion: z.string(),
  seed: z.string(),
  tickSnapshots: z.array(TickSnapshot),
  events: z.array(MatchEvent),
  finalScore: Score,
});
export type MatchLog = z.infer<typeof MatchLog>;
