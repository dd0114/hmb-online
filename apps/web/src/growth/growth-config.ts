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

/**
 * dice.normalCost (V2-5, 유지) — 노말 다이스 1개 구매 포인트 가격.
 * V2.2(§ hero 확정 2026-07-26 — 재화 이원화)로 캐시 다이스는 P 결제가 아니라 **젬** 결제로
 * 개정됐다(구 cashCost 5000P 는 제거) — 아래 DICE_CASH_GEM_COST 참조.
 */
export const DICE_BUY_COST = { NORMAL: 500 } as const;

/** dice.cashGemCost (V2.2) — 캐시 다이스 1개 구매 젬 가격. */
export const DICE_CASH_GEM_COST = 10;

export interface GemTopupPack {
  id: string;
  gems: number;
  /** 목업 표기 가격(원) — 실결제 없음. */
  mockPrice: string;
}

/** gems.topupPacks (V2.2) — 젬 충전(목업) 3종. 클릭 즉시 지급, 실결제 없음(UI에 명시). */
export const GEM_TOPUP_PACKS: readonly GemTopupPack[] = [
  { id: "p1", gems: 60, mockPrice: "₩1,200" },
  { id: "p2", gems: 330, mockPrice: "₩5,900" },
  { id: "p3", gems: 720, mockPrice: "₩11,900" },
];

/**
 * 밴드 앵커 축 윈도우(#179 후속, hero 피드백 "주식 차트처럼 y축 하한 잘라서 드라마틱하게").
 * 등급별 능력치 롤 밴드 — `research`/밸런스 분석 산출(BRONZE 40-55 … LEGEND 80-95). 서버가 SoT 인
 * 실제 롤 분포와 표시용 윈도우 앵커일 뿐 다른 growth-config 상수와 같은 미러 성격(§ 상단 주석 참고).
 */
export const GRADE_BANDS: Record<Grade, { lo: number; hi: number }> = {
  BRONZE: { lo: 40, hi: 55 },
  SILVER: { lo: 50, hi: 65 },
  GOLD: { lo: 60, hi: 75 },
  DIA: { lo: 70, hi: 85 },
  LEGEND: { lo: 80, hi: 95 },
};

/** 윈도우 하한 여유 — band.lo 아래로 이만큼 더 보여준다(막대·레이더 공통). */
export const AXIS_LO_MARGIN = 5;
/** 윈도우 상한 여유 — band.hi 위로 이만큼(잠재/성장 천장까지 드라마틱하게 보이도록). */
export const AXIS_HI_ROOM = 15;

export interface AxisWindow {
  lo: number;
  hi: number;
}

/** 등급 → 밴드 앵커 축 윈도우. 예: GOLD(60-75) → [55, 90]. */
export function computeAxisWindow(grade: Grade): AxisWindow {
  const band = GRADE_BANDS[grade];
  return { lo: band.lo - AXIS_LO_MARGIN, hi: band.hi + AXIS_HI_ROOM };
}

/** value 를 윈도우 안에서 0..1 로 정규화(클램프). 막대 width%·레이더 반경 비율 공통 계산. */
export function normalizeInWindow(value: number, win: AxisWindow): number {
  const span = win.hi - win.lo;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (value - win.lo) / span));
}

/**
 * 레이더 6축 그룹핑 — **포지션별**(hero 2026-07-26 확정: "포지션마다 6축이 달라야 한다, FIFA 가
 * GK 에 다른 6축 쓰는 방식처럼" — 구 전 포지션 공통 6축[슛/스피드/패스/테크닉/수비/피지컬] 폐기).
 * 공간지각(positioning)이 모든 포지션에서 자기 축을 갖는다(구 버전엔 수비 축에 숨어있었음).
 * 단일 스탯 축은 그대로, 겹치는 역할은 평균(피지컬=피지컬+스태미나, MF 는 스태미나 단독축).
 * 레이더 밖 스탯은 칩 2개로 표시(§ RADAR_CHIP_STATS_BY_POSITION).
 */
export interface RadarGroupDef {
  key: string;
  label: string;
  statKeys: readonly string[];
}

export type Position = "FW" | "MF" | "DF" | "GK";

export const RADAR_GROUPS_BY_POSITION: Record<Position, RadarGroupDef[]> = {
  FW: [
    { key: "shooting", label: "슛", statKeys: ["shooting"] },
    { key: "pace", label: "스피드", statKeys: ["pace"] },
    { key: "positioning", label: "공간지각", statKeys: ["positioning"] },
    { key: "technical", label: "테크닉", statKeys: ["technical"] },
    { key: "passing", label: "패스", statKeys: ["passing"] },
    { key: "physical", label: "피지컬", statKeys: ["physical", "stamina"] },
  ],
  MF: [
    { key: "passing", label: "패스", statKeys: ["passing"] },
    { key: "technical", label: "테크닉", statKeys: ["technical"] },
    { key: "pace", label: "스피드", statKeys: ["pace"] },
    { key: "positioning", label: "공간지각", statKeys: ["positioning"] },
    { key: "tackling", label: "수비", statKeys: ["tackling"] },
    { key: "stamina", label: "스태미나", statKeys: ["stamina"] },
  ],
  DF: [
    { key: "tackling", label: "수비", statKeys: ["tackling"] },
    { key: "positioning", label: "공간지각", statKeys: ["positioning"] },
    { key: "physical", label: "피지컬", statKeys: ["physical", "stamina"] },
    { key: "pace", label: "스피드", statKeys: ["pace"] },
    { key: "passing", label: "패스", statKeys: ["passing"] },
    { key: "mental", label: "멘탈", statKeys: ["mental"] },
  ],
  GK: [
    { key: "positioning", label: "선방위치", statKeys: ["positioning"] },
    { key: "mental", label: "멘탈", statKeys: ["mental"] },
    { key: "physical", label: "피지컬", statKeys: ["physical", "stamina"] },
    { key: "passing", label: "패스", statKeys: ["passing"] },
    { key: "technical", label: "테크닉", statKeys: ["technical"] },
    { key: "pace", label: "스피드", statKeys: ["pace"] },
  ],
};

/** RADAR_GROUPS_BY_POSITION 밖 — 레이더 옆 칩 2개로 표시(포지션별로 빠지는 축이 다르다). */
export const RADAR_CHIP_STATS_BY_POSITION: Record<Position, ReadonlyArray<keyof CatalogPlayer["attributes"]>> = {
  FW: ["mental", "tackling"],
  MF: ["mental", "physical"],
  DF: ["shooting", "technical"],
  GK: ["shooting", "tackling"],
};

/** 그룹의 statKeys 평균값. source 는 card.attributes/caps(Record<string, number> 캐스트) 공용. */
export function radarAxisValue(group: RadarGroupDef, source: Record<string, number>): number {
  if (group.statKeys.length === 0) return 0;
  const sum = group.statKeys.reduce((acc, key) => acc + (source[key] ?? 0), 0);
  return sum / group.statKeys.length;
}
