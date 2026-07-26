import { z } from "zod";
import { PlayerAttributes } from "./select-data.js";

/**
 * 성장 시스템 계약 v2 — 메이플 피벗 (에픽 #179, hero 확정 2026-07-26 안 ㄴ).
 * 3축: ①스탯 성장(경기·스탯별 Lv 지수) ②성★(중복=천장) ③잠재능력(3줄·티어·다이스).
 * SoT = issues/2026-07-26-growth-dual-track.md §V2. 구 강화(enhance/limitbreak) 계약은 폐기.
 * engine SelectData/match-log 계약 무변경 — server 가 유효스탯을 계산해 주입한다.
 */

export const GRADE_ORDER = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"] as const;
export const Grade = z.enum(GRADE_ORDER);
export type Grade = z.infer<typeof Grade>;

/** 성(★) 1~4. 전 등급 동일 — 등급 격차는 잠재 줄 수·티어 캡으로만. */
export const Star = z.number().int().min(1).max(4);
export type Star = z.infer<typeof Star>;

/** 잠재 티어 (랙칫 — 내려가지 않음). */
export const POTENTIAL_TIERS = ["RARE", "EPIC", "UNIQUE"] as const;
export const PotentialTier = z.enum(POTENTIAL_TIERS);
export type PotentialTier = z.infer<typeof PotentialTier>;

/** 잠재 옵션 1줄. STAT_* 는 stat 지정, 나머지는 팀/컨디션 훅. */
export const PotentialLine = z.object({
  slot: z.number().int().min(1).max(3),
  tier: PotentialTier, // 1줄=카드 티어, 2·3줄=한 단계 아래(이탈 시 동일)
  type: z.enum(["STAT_PCT", "STAT_FLAT", "CONDITION_RECOVERY", "TEAM_MORALE"]),
  stat: z.string().optional(), // PlayerAttributes 키 (STAT_* 만)
  value: z.number(), // pct 는 % 단위(예 4 = +4%), flat 은 절대값
});
export type PotentialLine = z.infer<typeof PotentialLine>;

/** 스탯 1종의 성장 상태. */
export const StatLevel = z.object({
  lv: z.number().int().min(0),
  xp: z.number().int().min(0), // 현재 레벨에서 쌓인 xp (임계 = xpLvBase × xpLvGrowth^lv)
});
export type StatLevel = z.infer<typeof StatLevel>;

/** 카드 상세/주입용 유효 상태 (GET /api/growth/card). */
export const CardEffective = z.object({
  playerId: z.string(),
  grade: Grade, // 등급 불변(승급 없음)
  star: Star,
  attributes: PlayerAttributes, // 잠재 반영 최종 유효 스탯
  prePotential: PlayerAttributes, // 잠재 반영 전(base+성장, cap 클램프)
  base: PlayerAttributes, // 뽑기 롤 원본
  caps: PlayerAttributes, // 성★ 이 개방한 스탯별 천장
  statLevels: z.record(z.string(), StatLevel), // 9종 키
  potential: z.object({
    unlocked: z.boolean(), // 2★ 이상
    tier: PotentialTier,
    maxTier: PotentialTier, // min(등급 캡, 성 캡)
    lines: z.array(PotentialLine), // 길이 = 등급별 줄 수(브/실1·골2·다/레3)
    rollsSinceTierUp: z.number().int().min(0),
    ceilingAt: z.number().int().min(1), // 이 횟수 도달 시 다음 노말 롤 확정 티어업
  }),
  ovr: z.number(),
  completion: z.number().min(0).max(1), // 성장 진행률 Σlv/Σ(cap−base)
});
export type CardEffective = z.infer<typeof CardEffective>;

/** 성★ 승급 결과 (POST /api/growth/star). */
export const StarUpResult = z.object({
  playerId: z.string(),
  star: Star,
  spentCopies: z.number().int().min(0), // 2★=2 / 3★=3 / 4★=5 (config)
  potentialUnlocked: z.boolean(), // 이번 승급으로 잠재 첫 해금?
  maxTier: PotentialTier, // 승급 후 티어 캡
});
export type StarUpResult = z.infer<typeof StarUpResult>;

/** 다이스 롤 결과 (POST /api/growth/dice). */
export const DiceRollResult = z.object({
  playerId: z.string(),
  kind: z.enum(["NORMAL", "CASH"]),
  tierBefore: PotentialTier,
  tierAfter: PotentialTier, // 노말만 승급 가능. 랙칫
  tierUp: z.boolean(),
  byCeiling: z.boolean(), // 천장(1.5배) 보장 발동 여부
  lines: z.array(PotentialLine),
  rollsSinceTierUp: z.number().int().min(0),
  ceilingAt: z.number().int().min(1),
  diceLeft: z.number().int().min(0),
});
export type DiceRollResult = z.infer<typeof DiceRollResult>;

/** 다이스 보유 잔액 (GET /api/growth/dice) — 페이지 로드 시 조회(세션 리셋 무관). */
export const DiceBalance = z.object({
  normal: z.number().int().min(0),
  cash: z.number().int().min(0),
});
export type DiceBalance = z.infer<typeof DiceBalance>;

/** 다이스 구매 결과 (POST /api/shop/dice). 부족 에러코드 = INSUFFICIENT_POINTS / 롤 부족 = INSUFFICIENT_DICE. */
export const DiceBuyResult = z.object({
  kind: z.enum(["NORMAL", "CASH"]),
  count: z.number().int().min(1),
  dice: DiceBalance, // 구매 후 잔액
  wallet: z.object({ points: z.number().int().min(0) }),
});
export type DiceBuyResult = z.infer<typeof DiceBuyResult>;

/** 매치 후 성장 리포트 1인분 — 스탯별 XP·레벨업 (GET /api/growth/report). */
export const MatchGrowthEntry = z.object({
  playerId: z.string(),
  name: z.string(),
  statXp: z.record(z.string(), z.number().int().min(0)), // 스탯별 획득 XP
  levelUps: z.array(z.string()), // 이번 경기로 레벨업한 스탯 키
  ovrBefore: z.number(),
  ovrAfter: z.number(),
});
export type MatchGrowthEntry = z.infer<typeof MatchGrowthEntry>;

export const MatchGrowthReport = z.object({
  matchId: z.string(),
  entries: z.array(MatchGrowthEntry),
});
export type MatchGrowthReport = z.infer<typeof MatchGrowthReport>;
