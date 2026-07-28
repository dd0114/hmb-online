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
  tier: PotentialTier; // V2.1-1: 전줄 = 카드 잠재 티어(동일). 구 "2·3줄=한 단계 아래" 모델 폐기.
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

/**
 * 잠재 리롤 결과 (POST /api/growth/dice).
 *
 * ⚠️ **#247: 구매 단계가 사라졌다** — 다이스는 사는 물건이 아니라 롤 비용이다. 그래서 응답에서
 * `diceLeft`(재고 잔여)가 빠지고 `wallet`(차감 후 지갑)이 들어왔다. 재고 필드를 되살리지 마라 —
 * 되살아나는 순간 화면에 "보유 n개"가 다시 그려진다.
 */
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
  wallet: WalletBalance; // 롤 비용 차감 후 잔액(재화를 정하는 쪽이 잔액도 준다, #232)
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
 * 지갑 — V2.2 재화 이원화(에픽 #179, hero 확정 2026-07-26): P(무료 게임머니) + 젬(충전형, 목업
 * 충전). SoT = packages/shared/src/growth.ts WalletBalance. openapi 미편입이라 여기서도 손 미러링.
 */
export interface WalletBalance {
  points: number;
  gems: number;
}

/**
 * 젬 충전(목업) 결과 (POST /api/shop/gems/topup). 실결제 없음 — mock 지급, 즉시 반영.
 * SoT = packages/shared/src/growth.ts GemTopupResult.
 */
export interface GemTopupResult {
  packId: string;
  granted: number;
  wallet: WalletBalance;
}

/**
 * 성★ 승급 시 중복 부족 4xx 코드 (V2-4 명시).
 *
 * ⚠️ 잔액 부족(`INSUFFICIENT_POINTS`/`INSUFFICIENT_GEMS`)에는 대응 상수가 **일부러 없다**.
 * #247 로 리롤이 지갑 결제가 되면서 그 문구는 **서버가 표기 메타로 만든 것을 그대로** 띄우므로
 * (#232), 클라가 코드를 분기해 자기 문구를 지어낼 자리가 없어졌다. 상수를 되살리면 그 분기가
 * 같이 돌아온다.
 */
export const INSUFFICIENT_MATERIALS_CODE = "INSUFFICIENT_MATERIALS";
