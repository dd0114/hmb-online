import { z } from "zod";

/**
 * SelectData — 경기에 참여하는 선수 원본 데이터(능력치). (PRD §7-4 재현 3종세트의 일부)
 * 결정론 재현을 위해 매치 입력의 일부로 고정 저장된다.
 */

/** 선수 능력치. 3축(기술/정신/신체) + 세부 스킬. 각 0..100. */
export const PlayerAttributes = z.object({
  technical: z.number(),
  mental: z.number(),
  physical: z.number(),
  passing: z.number(),
  shooting: z.number(),
  tackling: z.number(),
  pace: z.number(),
  stamina: z.number(),
  positioning: z.number(),
});
export type PlayerAttributes = z.infer<typeof PlayerAttributes>;

export const PlayerCard = z.object({
  playerId: z.string(),
  name: z.string(),
  position: z.string(),
  attributes: PlayerAttributes,
});
export type PlayerCard = z.infer<typeof PlayerCard>;

export const TeamRoster = z.object({
  name: z.string(),
  players: z.array(PlayerCard),
});
export type TeamRoster = z.infer<typeof TeamRoster>;

export const SelectData = z.object({
  home: TeamRoster,
  away: TeamRoster,
});
export type SelectData = z.infer<typeof SelectData>;
