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

/*
 * ⚠️ 스탯별 XP 임계 미러(`XP_LV_BASE`·`XP_LV_GROWTH`·`xpToNextLevel`)는 **제거했다** (#405 W3).
 * 소비처였던 강화탭의 스탯별 XP 막대가 사라졌고(구 `statLevels` 는 유효스탯에 관여하지 않는다),
 * 카드 레벨의 임계는 **서버가 `xpToNext` 로 내려준다** — 클라가 곡선을 다시 그리면 계수를 무배포로
 * 바꾸는 날(§2.8) 막대만 조용히 거짓말한다.
 */

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
 * 축 윈도우(#179 후속, hero 피드백 "주식 차트처럼 y축 하한 잘라서 드라마틱하게").
 *
 * ⚠️ **등급별 밴드 미러(`GRADE_BANDS` BRONZE 40-55 … LEGEND 80-95)는 제거했다** (#405 W3).
 * v2.5 발행이 초기 스탯을 하향(BRONZE 32-42 … LEGEND 68-78, 설계 §2.2)하면서 그 상수는 **틀린
 * 값**이 됐고, 밴드는 `bands.<GRADE>.{startLo,startHi,growCeil}` 로 **무배포 조정 대상**이라
 * (§2.8 하드 AC) 클라 미러는 언제든 다시 낡는다 — `DICE_BUY_COST` 가 10배 어긋난 채 배포됐던
 * 것과 같은 형태다(#213).
 *
 * 대신 축을 **카드가 실제로 들고 온 값**에서 만든다: 하한 = 발행 원본(`base`)의 최소값 −여유,
 * 상한 = 서버가 계산한 천장(`caps`)의 최대값. 미러가 없으므로 서버가 밴드를 바꿔도 축이 따라온다.
 */
export const AXIS_LO_MARGIN = 5;

export interface AxisWindow {
  lo: number;
  hi: number;
}

/**
 * 카드의 `base`/`caps` 에서 축 윈도우를 만든다 — **한 카드의 9막대·레이더가 같은 축을 쓴다**.
 *
 * 값이 하나도 없으면(응답 손상) `{lo:0, hi:100}` 으로 눕힌다. 폭 0 축은 모든 막대를 0%로 만들어
 * "성장이 하나도 없다"는 거짓을 그린다.
 */
export function cardAxisWindow(
  base: Record<string, number> | undefined,
  caps: Record<string, number> | undefined,
): AxisWindow {
  const bases = Object.values(base ?? {}).filter((v) => Number.isFinite(v));
  const ceils = Object.values(caps ?? {}).filter((v) => Number.isFinite(v));
  if (bases.length === 0 || ceils.length === 0) return { lo: 0, hi: 100 };
  const lo = Math.floor(Math.min(...bases)) - AXIS_LO_MARGIN;
  const hi = Math.ceil(Math.max(...ceils));
  return hi > lo ? { lo, hi } : { lo, hi: lo + 1 };
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
