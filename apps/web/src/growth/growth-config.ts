/**
 * economy growth/star/potential 블록의 **표시용 미러**(에픽 #179 §V2-5) — 라벨·애니메이션 임계·
 * 축 윈도우처럼 "틀려도 화면만 어색한" 값들.
 *
 * ⚠️ **재화가 걸린 값은 여기 두지 않는다** (#232). 가격·결제재화·충전팩은 `GET /api/config` 가 SoT 다
 * (`api/config.ts`). 미러가 서버보다 뒤처지면 화면이 실제 결제와 어긋나고, 그건 어색한 게 아니라
 * 거짓말이다 — 실제로 다이스 가격이 10배 어긋난 채로 배포돼 있었다(#213).
 * SoT = issues/2026-07-26-growth-dual-track.md §V2-5.
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

/*
 * ⚠️ 다이스 가격·충전 팩 미러 상수는 **제거됐다** (#232).
 *
 * 여기에 `DICE_BUY_COST = { NORMAL: 500 }` 이 있었고, 서버 config 가 5,000 으로 바뀐 뒤에도 그대로
 * 남아 화면이 "500 P 로 구매"를 그렸다 — 눌러서 성공하면 지갑이 10배로 줄어드는 화면이었다.
 * 가격·결제재화·충전팩은 이제 `GET /api/config`(`api/config.ts`)에서만 온다. 되살리지 마라.
 */

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
