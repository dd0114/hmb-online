import { z } from "zod";
import { TeamSide } from "./match-log.js";
import { PlayerAttributes } from "./select-data.js";
import { SimulateHalf } from "./simulate.js";

/**
 * TeamInputJobContext — AI실행기(ts-servants ②) 잡 컨텍스트 계약.
 * (LLD-ts-servants §3, LLD-server-java §5.2, openapi.yaml `AiJobContext` 와 동일 — 필드명 camelCase 일치)
 *
 * Java MatchOrchestrator 가 kickoff/halftime 에 팀당 1개씩 생성해 `/internal/ai-jobs` 큐에 싣고,
 * TS 실행기가 poll 로 받아 프롬프트를 빌드(로스터 능력치·팀 지시·선수별 개인 지시·half2 prevSummary)한 뒤
 * TacticalInput 을 산출해 complete 로 돌려준다.
 */

/** 로스터 1명(슬롯 포함). slotIndex = 포메이션 슬롯(0..10, 덱 슬롯과 동일 순서). */
export const TeamInputRosterEntry = z.object({
  playerId: z.string(),
  name: z.string(),
  position: z.string(),
  attributes: PlayerAttributes,
  slotIndex: z.number(),
});
export type TeamInputRosterEntry = z.infer<typeof TeamInputRosterEntry>;

/**
 * 전반 요약(half=2 잡에만). Java 가 match_halves(1) 로그에서 산출(LLD-server-java §5.2).
 * openapi 는 느슨한 오브젝트(additionalProperties)로 두므로 passthrough — 여기 필드는 LLD 기술 형태.
 */
export const PrevHalfSummary = z
  .object({
    scoreHome: z.number(),
    scoreAway: z.number(),
    shots: z.number(),
    possessionHint: z.union([z.string(), z.number()]),
  })
  .passthrough();
export type PrevHalfSummary = z.infer<typeof PrevHalfSummary>;

export const TeamInputJobContext = z.object({
  kind: z.literal("team-input"),
  matchId: z.string(),
  side: TeamSide,
  half: SimulateHalf,
  /** side 별 파생 halfSeed(10진 문자열). */
  seed: z.string(),
  formation: z.string(),
  /** 선발 11명(능력치 포함 — 프롬프트의 로스터 섹션 원천). */
  roster: z.array(TeamInputRosterEntry).length(11),
  /** 팀 전체 자연어 지시(유저 프롬프트 병합 or 봇 페르소나). 빈 문자열 허용. */
  teamPrompt: z.string(),
  /** 선수별 개인 자연어 지시({playerId: text}). 빈 오브젝트 허용. */
  playerPrompts: z.record(z.string(), z.string()),
  /** half=2 만: 전반 요약. */
  prevSummary: PrevHalfSummary.nullish(),
});
export type TeamInputJobContext = z.infer<typeof TeamInputJobContext>;
