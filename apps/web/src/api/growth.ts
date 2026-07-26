/**
 * 성장 시스템 v2 응답 타입 (에픽 #179 — 메이플 피벗, V2-4). SoT = packages/shared/src/growth.ts (zod).
 * 3축: ①스탯 성장(경기·Lv) ②성★(1~4, 중복=천장) ③잠재능력(3줄·티어·다이스). 구 강화(enhance)/
 * 한계돌파(limitbreak) 계약은 **폐기**됐다 — 이 파일에 있던 EnhanceResult/ENHANCE_MAX_CODE 등은 제거.
 *
 * ⚠️ 이 엔드포인트들은 아직 openapi.yaml(generated schema.d.ts)에 없다 — server-java(GM2) 소관.
 * 그래서 여기서 shared 계약을 손으로 미러링하되 PlayerAttributes 는 generated schema 를 재사용해
 * 드리프트를 막는다. openapi 에 편입되면 이 파일을 generated 타입으로 교체한다.
 */
import type { components } from "./schema";

type PlayerAttributes = components["schemas"]["PlayerAttributes"];

export const GRADE_ORDER = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"] as const;
export type Grade = (typeof GRADE_ORDER)[number];

/** 성(★) 1~4. 전 등급 동일 — 등급 격차는 잠재 줄 수·티어 캡으로만. */
export type Star = 1 | 2 | 3 | 4;

/** 잠재 티어 (랙칫 — 내려가지 않음). */
export const POTENTIAL_TIERS = ["RARE", "EPIC", "UNIQUE"] as const;
export type PotentialTier = (typeof POTENTIAL_TIERS)[number];

/** 잠재 옵션 1줄. STAT_* 는 stat 지정, 나머지는 팀/컨디션 훅. */
export interface PotentialLine {
  slot: 1 | 2 | 3;
  tier: PotentialTier; // 1줄=카드 티어, 2·3줄=한 단계 아래(이탈 시 동일)
  type: "STAT_PCT" | "STAT_FLAT" | "CONDITION_RECOVERY" | "TEAM_MORALE";
  stat?: string; // PlayerAttributes 키 (STAT_* 만)
  value: number; // pct 는 % 단위(예 4 = +4%), flat 은 절대값
}

/** 스탯 1종의 성장 상태. */
export interface StatLevel {
  lv: number;
  xp: number; // 현재 레벨에서 쌓인 xp (임계 = xpLvBase × xpLvGrowth^lv)
}

/** 카드 상세/주입용 유효 상태 (GET /api/growth/card). */
export interface CardEffective {
  playerId: string;
  grade: Grade; // 등급 불변(승급 없음)
  star: Star;
  attributes: PlayerAttributes; // 잠재 반영 최종 유효 스탯
  prePotential: PlayerAttributes; // 잠재 반영 전(base+성장, cap 클램프)
  base: PlayerAttributes; // 뽑기 롤 원본
  caps: PlayerAttributes; // 성★ 이 개방한 스탯별 천장
  statLevels: Record<string, StatLevel>; // 9종 키
  potential: {
    unlocked: boolean; // 2★ 이상
    tier: PotentialTier;
    maxTier: PotentialTier; // min(등급 캡, 성 캡)
    lines: PotentialLine[]; // 길이 = 등급별 줄 수(브/실1·골2·다/레3)
    rollsSinceTierUp: number;
    ceilingAt: number; // 이 횟수 도달 시 다음 노말 롤 확정 티어업
  };
  ovr: number;
  completion: number; // 0..1, 성장 진행률 Σlv/Σ(cap−base)
}

/** 성★ 승급 결과 (POST /api/growth/star). */
export interface StarUpResult {
  playerId: string;
  star: Star;
  spentCopies: number; // 2★=2 / 3★=3 / 4★=5 (config)
  potentialUnlocked: boolean; // 이번 승급으로 잠재 첫 해금?
  maxTier: PotentialTier; // 승급 후 티어 캡
}

/** 다이스 롤 결과 (POST /api/growth/dice). */
export interface DiceRollResult {
  playerId: string;
  kind: "NORMAL" | "CASH";
  tierBefore: PotentialTier;
  tierAfter: PotentialTier; // 노말만 승급 가능. 랙칫
  tierUp: boolean;
  byCeiling: boolean; // 천장(1.5배) 보장 발동 여부
  lines: PotentialLine[];
  rollsSinceTierUp: number;
  ceilingAt: number;
  diceLeft: number; // 이 kind 의 롤 후 잔여 개수
}

/** 매치 후 성장 리포트 1인분 — 스탯별 XP·레벨업 (GET /api/growth/report). */
export interface MatchGrowthEntry {
  playerId: string;
  name: string;
  statXp: Record<string, number>; // 스탯별 획득 XP
  levelUps: string[]; // 이번 경기로 레벨업한 스탯 키
  ovrBefore: number;
  ovrAfter: number;
}

export interface MatchGrowthReport {
  matchId: string;
  entries: MatchGrowthEntry[];
}

/**
 * POST /api/shop/dice 응답 — **shared/growth.ts 에도 아직 없다**(V2-4 표에는 있지만 zod 스키마
 * 미정의). "지갑 차감·user_dice 증가"(§V2-4)만 명시돼 있어, 갱신된 다이스 잔고 + 지갑을 함께
 * 내려준다고 가정해 손으로 정의했다 — GM2 확정 시 이 타입을 교체할 것(리스크로 최종보고에 기록).
 */
export interface DiceBuyResult {
  kind: "NORMAL" | "CASH";
  count: number;
  dice: { normal: number; cash: number };
  wallet: { points: number };
}

/** 성★ 승급 시 중복 부족 4xx 코드 (V2-4 명시). */
export const INSUFFICIENT_MATERIALS_CODE = "INSUFFICIENT_MATERIALS";

/**
 * 다이스 롤 시 보유 다이스 부족 4xx 코드 — V2-4 문서엔 코드명이 명시돼 있지 않아 INSUFFICIENT_*
 * 네이밍 관례(위 MATERIALS, openapi INSUFFICIENT_POINTS)를 따라 추정했다. GM2 확정 코드가 다르면
 * 이 상수만 갈아끼우면 된다(호출부는 이 상수를 통해서만 비교).
 */
export const INSUFFICIENT_DICE_CODE = "INSUFFICIENT_DICE";
