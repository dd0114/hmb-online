/**
 * economy.v2.json growth/star/potential/dice 블록의 **표시용 미러**(에픽 #179 §V2-5).
 * 서버가 SoT — 여기 값은 UI 라벨/애니메이션 임계용이며 실제 게이트는 항상 서버 응답이 최종
 * 권위(성 승급 재료 부족 = 4xx INSUFFICIENT_MATERIALS, 다이스 부족 = 4xx). 다른 화면들의
 * 표시용 상수 패턴(ShopPage.GACHA_COST_SINGLE 등)과 동일한 성격 — 서버 config 가 바뀌면 이 파일도
 * 갱신 필요. SoT = issues/2026-07-26-growth-dual-track.md §V2-5.
 */
import type { CatalogPlayer } from "../api/hooks";
import type { Grade } from "../common/grades";
import type { PotentialTier, Star } from "../api/growth";

export const STAT_LABELS: Array<[key: keyof CatalogPlayer["attributes"], label: string]> = [
  ["shooting", "슛"],
  ["pace", "스피드"],
  ["positioning", "위치선정"],
  ["technical", "테크닉"],
  ["passing", "패스"],
  ["stamina", "스태미나"],
  ["physical", "피지컬"],
  ["mental", "멘탈"],
  ["tackling", "태클"],
];

export const STAT_LABEL_MAP: Record<string, string> = Object.fromEntries(
  STAT_LABELS.map(([key, label]) => [key, label]),
);

/** star.copies (V2-5) — N★ 승급에 필요한 동일선수 중복 수. */
export const STAR_COPY_COST: Record<Exclude<Star, 1>, number> = { 2: 2, 3: 3, 4: 5 };

/** potential.linesByGrade (V2-5) — 등급별 잠재 슬롯 수(그 이상은 영구 잠금). */
export const GRADE_POTENTIAL_LINES: Record<Grade, number> = {
  BRONZE: 1,
  SILVER: 1,
  GOLD: 2,
  DIA: 3,
  LEGEND: 3,
};

/** growth.xpLvBase × xpLvGrowth^lv (V2-5) — 스탯 XP 진행바 임계(표시 전용). */
export const XP_LV_BASE = 100;
export const XP_LV_GROWTH = 1.7;
export function xpToNextLevel(lv: number): number {
  return Math.round(XP_LV_BASE * Math.pow(XP_LV_GROWTH, Math.max(0, lv)));
}

/** 잠재 티어 색상 — 레어=흰 / 에픽=보라 / 유니크=금(§V2-6). */
export const TIER_COLORS: Record<PotentialTier, string> = {
  RARE: "#e7ecf2",
  EPIC: "#b98bf5",
  UNIQUE: "#f2c744",
};

export const TIER_LABELS: Record<PotentialTier, string> = {
  RARE: "레어",
  EPIC: "에픽",
  UNIQUE: "유니크",
};

/** dice.normalCost/cashCost (V2-5) — 상점 다이스 구매 목업 가격(포인트). */
export const DICE_BUY_COST = { NORMAL: 500, CASH: 5000 } as const;
