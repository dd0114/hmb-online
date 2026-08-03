/**
 * 능력치 표시의 **뷰모델** (#403 W3) — `AttributeLayers` 가 그리는 값의 단일 출처.
 *
 * ## 왜 뷰모델을 끼우나
 * 소비자가 둘이다: 강화탭(`CardGrowthDetail`, 내 카드 = `CardEffective`)과 선수 상세 모달
 * (`match/PlayerDetailModal`, 상대·타 유저 = 카탈로그 `attributes` 뿐). 두 입력의 **모양이 다르고**
 * `api/growth.ts` 는 스스로 *"openapi 에 편입되면 이 파일을 generated 타입으로 교체한다"* 고 예고했다
 * (`statLevels` 는 제거 후보). 컴포넌트가 `CardEffective` 를 직접 받으면 그 교체가 **화면 수정**이
 * 된다 — 여기 변환 함수 하나만 고치면 되게 가른다.
 *
 * ## 두 모드 — **없는 층을 0 으로 그리지 않는다**
 * · `full`   내 카드. `base`/`caps`/`statAdd`/`startLo` 가 있어 3층 막대 + 천장 마커 + 레이더 캡이 선다.
 * · `reduced` 상대·타 유저. 서버가 **남의 성장 진행도를 주지 않는다**(목업 ④ 데이터 경계) →
 *   3층도 천장도 그릴 재료가 없다. 그 자리를 `0` 으로 채우면 "성장분 0"이라는 **거짓**이 된다
 *   (모르는 것이지 0 이 아니다). 그래서 층 자체를 `null` 로 비우고, 화면은 `note` 로 그 사실을 말한다.
 *
 * ⚠️ 카탈로그(`GET /api/players`)의 `attributes` 는 **발행 기본치**다. 상대(특히 원정 유저)는
 * 성장분이 있을 수 있으므로 "그 상대의 현재 능력치"라고 말하면 안 된다 — `REDUCED_NOTE` 가
 * 그것을 화면에서 말한다. 지어내지 않는 것이 이 리포의 규율이다.
 */
import {
  RADAR_CHIP_STATS_BY_POSITION,
  RADAR_GROUPS_BY_POSITION,
  STAT_LABELS,
  STAT_LABEL_MAP,
  cardAxisWindow,
  radarAxisValue,
  type AxisWindow,
  type Position,
} from "./growth-config";

export type AttributeMode = "full" | "reduced";

/** 막대 1줄. `full` 에서만 채워지는 필드는 `reduced` 에서 **null**(0 이 아니다). */
export interface AttributeBarRow {
  key: string;
  label: string;
  /** 유효 능력치(잠재 반영 후) — 두 모드 공통. */
  value: number;
  /** 발행 원본. */
  base: number | null;
  /** `min(cap, base + add)` = 기본 + 성장분. */
  grown: number | null;
  /** 3지선다 누적(성장분). */
  add: number | null;
  /** 그 스탯의 천장. */
  cap: number | null;
}

/** 레이더 밖 스탯 칩. `cap` 은 `full` 에서만. */
export interface AttributeChip {
  key: string;
  label: string;
  value: number;
  cap: number | null;
}

export interface AttributeRadarAxis {
  key: string;
  label: string;
  value: number;
  /** 있으면 StatRadar 가 캡 점선 폴리곤을 그린다(전 축이 있어야 그린다). */
  cap?: number;
}

export interface AttributeView {
  mode: AttributeMode;
  /** 막대·레이더가 **같이** 쓰는 정규화 축. */
  axis: AxisWindow;
  radarAxes: AttributeRadarAxis[];
  chips: AttributeChip[];
  rows: AttributeBarRow[];
  /** 막대 범례의 천장 라벨. `reduced` 면 null(범례 자체를 안 그린다). */
  ceilingLabel: string | null;
  /** `reduced` 가 **없는 것을 없다고** 말하는 줄. `full` 이면 null. */
  note: string | null;
}

/**
 * 카탈로그 값이 무엇인지 화면이 말하게 하는 문장 (목업 ④ 데이터 경계 + 결정 ③).
 * ⚠️ "현재 능력치"라고 쓰지 마라 — 카탈로그는 **발행 기본치**라 성장한 상대에겐 틀린 말이 된다.
 */
export const REDUCED_NOTE =
  "카탈로그 기본치입니다 — 이 선수가 키운 성장분·천장은 공개되지 않습니다";

/**
 * 포지션 미상일 때의 레이더 축. 6축 구성이 포지션마다 다른데(§RADAR_GROUPS_BY_POSITION) 모르면
 * 고를 수가 없다 — 가장 중립적인 MF 축으로 떨어진다. **틀린 포지션을 지어내는 것이 아니라**
 * 축 구성을 하나 고르는 것이고, 값은 어느 축에서든 같은 스탯을 읽는다.
 */
export const DEFAULT_RADAR_POSITION: Position = "MF";

const POSITIONS: ReadonlySet<string> = new Set(["FW", "MF", "DF", "GK"]);

/** 모르는 포지션 문자열은 기본 축으로. */
export function resolveRadarPosition(position: string | null | undefined): Position {
  return position && POSITIONS.has(position) ? (position as Position) : DEFAULT_RADAR_POSITION;
}

/**
 * 능력치 원본(서버 응답 형태를 믿지 않는다 — 유한수 필드만 남긴다).
 * 값이 하나도 없으면 **null** = "그 자료가 없다"이고, 호출부는 그 층을 안 그린다.
 */
function numRecord(src: unknown): Record<string, number> | null {
  if (!src || typeof src !== "object") return null;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      n += 1;
    }
  }
  return n > 0 ? out : null;
}

/** `attributeViewOf` 입력 — `CardEffective` 의 부분집합이자 카탈로그의 상위집합. */
export interface AttributeSource {
  /** 유효 능력치. **이게 없으면 뷰가 없다**(null 반환). */
  attributes?: unknown;
  /** 아래 넷이 다 있어야 `full` — 하나라도 없으면 `reduced` 로 떨어진다. */
  base?: unknown;
  caps?: unknown;
  statAdd?: unknown;
  startLo?: number | null;
  /** 천장 분해 라벨용(없으면 합계만 말한다). */
  growCeil?: number | null;
  starCeilBonus?: number | null;
  star?: number | null;
}

/**
 * 천장 라벨 — `천장 73 = 72 + ★2 보너스 1`(목업 화면 ⑤).
 *
 * `caps = min(growCeil + starCeilBonus, attrHardCap)` 이라 합계만으로는 star 기여를 말할 수 없어
 * 서버가 셋을 따로 준다. ⚠️ 하드캡에 걸려 합이 잘렸으면 **덧셈이 성립하지 않으므로** 분해를
 * 쓰지 않는다 — `72 + 3 = 74` 같은 틀린 식을 그리느니 합계만 말한다.
 */
function ceilingLabelOf(caps: Record<string, number>, src: AttributeSource): string {
  const finite = Object.values(caps).filter((v) => Number.isFinite(v));
  const cap = Math.round(Math.max(0, ...finite));
  const growCeil = src.growCeil;
  const bonus = src.starCeilBonus;
  const star = src.star ?? 1;
  if (typeof growCeil !== "number" || typeof bonus !== "number") return `천장 ${cap}`;
  if (Math.round(growCeil + bonus) !== cap) return `천장 ${cap}`;
  return bonus > 0
    ? `천장 ${cap} = ${growCeil} + ★${star} 보너스 ${bonus}`
    : `천장 ${cap} (★${star} 보너스 0)`;
}

/**
 * 뷰모델을 만든다. `attributes` 가 없으면(응답 손상·구 서버) **null** — 호출부는 능력치 블록을
 * 통째로 안 그린다. 빈 막대 아홉 줄을 그리는 것보다 없는 편이 정직하다.
 */
export function attributeViewOf(
  position: string | null | undefined,
  src: AttributeSource | null | undefined,
): AttributeView | null {
  const attrs = numRecord(src?.attributes);
  if (!attrs || !src) return null;

  const base = numRecord(src.base);
  const caps = numRecord(src.caps);
  const full = base != null && caps != null;
  const add = numRecord(src.statAdd) ?? {};

  const pos = resolveRadarPosition(position);
  const axis: AxisWindow = full
    ? cardAxisWindow(base, caps, src.startLo)
    : cardAxisWindow(undefined, undefined, undefined);

  const radarAxes: AttributeRadarAxis[] = RADAR_GROUPS_BY_POSITION[pos].map((g) =>
    caps
      ? { key: g.key, label: g.label, value: radarAxisValue(g, attrs), cap: radarAxisValue(g, caps) }
      : { key: g.key, label: g.label, value: radarAxisValue(g, attrs) },
  );

  const chips: AttributeChip[] = RADAR_CHIP_STATS_BY_POSITION[pos].map((key) => ({
    key,
    label: STAT_LABEL_MAP[key] ?? key,
    value: attrs[key] ?? 0,
    cap: caps ? caps[key] ?? 0 : null,
  }));

  const rows: AttributeBarRow[] = STAT_LABELS.map(([key, label]) => {
    const value = attrs[key] ?? 0;
    if (!full || !base || !caps) {
      return { key, label, value, base: null, grown: null, add: null, cap: null };
    }
    const b = base[key] ?? 0;
    const cap = caps[key] ?? 0;
    const a = add[key] ?? 0;
    return { key, label, value, base: b, grown: Math.min(cap, b + a), add: a, cap };
  });

  return {
    mode: full ? "full" : "reduced",
    axis,
    radarAxes,
    chips,
    rows,
    ceilingLabel: full && caps ? ceilingLabelOf(caps, src) : null,
    note: full ? null : REDUCED_NOTE,
  };
}
