import { z } from "zod";
import { PlayerAttributes } from "./select-data.js";

/**
 * 성장 시스템 계약 (에픽 #179 — 가챠 강화 ⊥ 경기 성장 이중 트랙).
 * SoT = issues/2026-07-26-growth-dual-track.md §5. engine SelectData/match-log 계약은 무변경 —
 * server 가 유효스탯을 계산해 다음 매치 SelectData 에 주입한다.
 */

/** 등급 사다리 — limit_break 단계가 baseGrade 를 위로 민다. */
export const GRADE_ORDER = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"] as const;
export const Grade = z.enum(GRADE_ORDER);
export type Grade = z.infer<typeof Grade>;

/** effectiveGrade = min(LEGEND, baseGrade + limitBreak 단계). */
export function effectiveGrade(baseGrade: Grade, limitBreak: number): Grade {
  const idx = Math.min(GRADE_ORDER.length - 1, GRADE_ORDER.indexOf(baseGrade) + Math.max(0, limitBreak));
  return GRADE_ORDER[idx] ?? baseGrade;
}

/** 카드 인스턴스의 성장·강화 상태(user_players 파생). */
export const GrowthState = z.object({
  playerId: z.string(),
  baseGrade: Grade,
  effectiveGrade: Grade,
  enhanceLevel: z.number().int().min(0), // 강화 레벨(밴드 내)
  limitBreak: z.number().int().min(0), // 한계돌파 단계(등급 개방)
  matchXp: z.number().int().min(0), // 누적 경기 성장 xp
  growthLevel: z.number().int().min(0), // xp→레벨 파생
  ovr: z.number(), // 현재 유효 OVR
  completion: z.number().min(0).max(1), // 완성도 = 채움/천장 (UI 링·%)
});
export type GrowthState = z.infer<typeof GrowthState>;

/** 유효 능력치 + 천장(cap) — 카드 상세(시안3)·SelectData 주입에 사용. */
export const CardEffective = z.object({
  playerId: z.string(),
  baseGrade: Grade,
  effectiveGrade: Grade,
  attributes: PlayerAttributes, // 현재 유효 스탯(base+fill, cap 클램프)
  caps: PlayerAttributes, // 능력치별 천장(effectiveGrade 밴드 상한)
  base: PlayerAttributes, // 뽑기 롤 원본(기준선)
  ovr: z.number(),
  completion: z.number().min(0).max(1),
});
export type CardEffective = z.infer<typeof CardEffective>;

/** 강화/한계돌파 결과. */
export const EnhanceResult = z.object({
  playerId: z.string(),
  enhanceLevel: z.number().int().min(0),
  limitBreak: z.number().int().min(0),
  effectiveGrade: Grade,
  ovr: z.number(),
  promoted: z.boolean(), // 이번 실행으로 등급 승급했나
  spent: z.object({ copies: z.number().int().min(0), points: z.number().int().min(0) }),
});
export type EnhanceResult = z.infer<typeof EnhanceResult>;

/** 매치 후 성장 리포트 (ResultPage S1). */
export const MatchGrowthEntry = z.object({
  playerId: z.string(),
  name: z.string(),
  xpDelta: z.number().int().min(0),
  ovrBefore: z.number(),
  ovrAfter: z.number(),
  leveledUp: z.boolean(),
  topAttrs: z.array(z.string()), // 가장 많이 자란 능력치 라벨(방향 w 상위)
});
export type MatchGrowthEntry = z.infer<typeof MatchGrowthEntry>;

export const MatchGrowthReport = z.object({
  matchId: z.string(),
  entries: z.array(MatchGrowthEntry),
});
export type MatchGrowthReport = z.infer<typeof MatchGrowthReport>;
