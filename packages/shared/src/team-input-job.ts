import { z } from "zod";
import { TeamSide } from "./match-log.js";
import { PlayerAttributes } from "./select-data.js";
import { SimulateHalf } from "./simulate.js";
import { TacticalInput } from "./tactical-input.js";

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
 * 상대 로스터 1명(마킹 해석 전용) — openapi `OpponentRosterEntry` 와 1:1(3필드).
 * 이름→playerId 매핑에만 쓰이므로 attributes/slotIndex 는 싣지 않는다(입력 토큰 절약).
 * position 은 openapi Position enum 이나 zod 는 관대하게 string(엔진 role 문자열과 호환).
 */
export const OpponentRosterEntry = z.object({
  playerId: z.string(),
  name: z.string(),
  position: z.string(),
});
export type OpponentRosterEntry = z.infer<typeof OpponentRosterEntry>;

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

/**
 * 선수 성격(P2-D7) — AI 컨텍스트 반응성에 영향(mentalModifier 등). openapi `Personality` 와 1:1.
 * FIERY=불꽃 / CALM=침착 / GLASS=유리멘탈 / AMBITIOUS=야심가.
 */
export const Personality = z.enum(["FIERY", "CALM", "GLASS", "AMBITIOUS"]);
export type Personality = z.infer<typeof Personality>;

/**
 * 수동 팀 전술(P2-D4) — 각 0..1. openapi `TeamTactics` 와 필드명 1:1.
 * AI 는 이 값을 베이스(A)로 받고 프롬프트로 보정만 한다(#82 A+B 구조의 A). W3 A+B 분리에서 A-base 로 재사용.
 */
export const ManualTactics = z.object({
  line: z.number().min(0).max(1),
  press: z.number().min(0).max(1),
  tempo: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
});
export type ManualTactics = z.infer<typeof ManualTactics>;

/** 선수별 관계 컨텍스트 1건(신뢰도 + 성격). openapi `RelationContext` 의 값 오브젝트와 1:1. */
export const PlayerRelationContext = z.object({
  trust: z.number().int().min(0).max(100),
  personality: Personality,
});
export type PlayerRelationContext = z.infer<typeof PlayerRelationContext>;

/** 팀 사기 컨텍스트. openapi `AiJobContextPhase2Fields.teamMorale` 와 1:1. streak = +연승 / -연패. */
export const TeamMoraleContext = z.object({
  morale: z.number().int().min(0).max(100),
  streak: z.number().int(),
});
export type TeamMoraleContext = z.infer<typeof TeamMoraleContext>;

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
  /**
   * 상대 선발 로스터(마킹 지시의 상대 이름→playerId 해석용). **additive optional**(구계약 호환).
   * (P2-servants W0, PRD-v3 AC-C2 — Java MatchOrchestrator 가 상대 팀 SelectData 에서 채운다.)
   */
  opponentRoster: z.array(OpponentRosterEntry).optional(),
  // ─────────── Phase 2 컨텍스트 확장 (AC-C4, P2-D7/D8) — 전부 additive optional(구계약 호환) ───────────
  // openapi-v2 `AiJobContextPhase2Fields` 와 필드명·형태 1:1. 출력 스키마(TacticalInput)는 불변 —
  // 컨텍스트는 입력만 늘린다(P2-D8). Java MatchOrchestrator 가 관계/전술/컨디션/사기에서 채운다.
  /** 수동 팀 전술(A-base) — 있으면 coach 가 "베이스, 프롬프트로 보정만" 지침을 낸다. */
  manualTactics: ManualTactics.optional(),
  /** 선수별 컨디션 {playerId: 0..1}(시드 결정론 롤). 라인업 컨디션 표기. openapi `ConditionMap`. */
  conditions: z.record(z.string(), z.number().min(0).max(1)).optional(),
  /** 선수별 관계 {playerId: {trust, personality}}. 성격 4종 반응 규칙 + trust 완화. openapi `RelationContext`. */
  relations: z.record(z.string(), PlayerRelationContext).optional(),
  /** 팀 사기 문맥(morale/streak). */
  teamMorale: TeamMoraleContext.optional(),
});
export type TeamInputJobContext = z.infer<typeof TeamInputJobContext>;

/**
 * TeamInputPatchJobContext — B(패치 생성) 잡 컨텍스트 (A+B 린패치 분리, #82 인계 / W3).
 *
 * kind='team-input-patch'. team-input 컨텍스트 전 필드(로스터·프롬프트·관계·사기·컨디션·상대로스터 …)를
 * **그대로 재사용**(context-blocks 순수 렌더러 공용) + `base`(A 결과 TacticalInput)를 추가로 싣는다.
 * 실행기는 이 컨텍스트로 B 프롬프트를 빌드→TacticalPatch 를 생성→applyPatch(base, patch, {seed})→**최종 TacticalInput 반환**.
 * (Java 는 결과를 team-input 과 동일하게 TacticalInput 으로 소비 — 패치는 실행기 내부 구현 세부.)
 *
 * seed 는 통과 필드 — 머지 시 base.seed 를 이 seed(halfSeed)로 주입. base 콘텐츠의 seed 는 무시된다.
 */
/**
 * 프롬프트 변경분 1건(선수 지시) — old 없음=신규 추가, new 없음=삭제.
 * 둘 다 있으면 수정(old→new). 값은 자연어 지시 원문.
 */
export const PromptDeltaEntry = z.object({
  old: z.string().optional(),
  new: z.string().optional(),
});
export type PromptDeltaEntry = z.infer<typeof PromptDeltaEntry>;

/**
 * PromptDelta — "직전 잡 대비 무엇이 바뀌었나"(#193 W2b-B3).
 * 있으면 실행기가 **델타 모드** 패치 프롬프트를 조립한다(풀 컨텍스트 나열 대신 변경분만 제시 →
 * 사고 토큰 = 지연의 지배 변수를 억제, 실측 8~16s). 없으면 기존 풀 컨텍스트 프롬프트(후방 호환).
 * 팀 지시는 수정만(old/new 둘 다), 선수 지시는 신규/수정/삭제 3형태.
 */
export const PromptDelta = z.object({
  /** 팀 전체 지시 변경(old → new). */
  team: z.object({ old: z.string(), new: z.string() }).optional(),
  /** 선수별 지시 변경 {playerId: {old?, new?}}. */
  players: z.record(z.string(), PromptDeltaEntry).optional(),
});
export type PromptDelta = z.infer<typeof PromptDelta>;

export const TeamInputPatchJobContext = TeamInputJobContext.omit({ kind: true }).extend({
  kind: z.literal("team-input-patch"),
  /** A(베이스 생성) 결과 — 이 위에 패치를 정적 머지한다(프리컴퓨트/캐시된 값). */
  base: TacticalInput,
  /**
   * 직전 잡 대비 지시 변경분. **additive optional**(구계약 호환 — 없으면 기존 프롬프트 경로).
   * Java 가 감독시간 편집분에서 채운다(#193 W2b-B3).
   */
  promptDelta: PromptDelta.optional(),
});
export type TeamInputPatchJobContext = z.infer<typeof TeamInputPatchJobContext>;
