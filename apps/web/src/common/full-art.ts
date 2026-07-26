/**
 * 풀아트 카드 기하 + URL 해석 + 디자인 토큰 — **순수 로직만**(fetch/DOM/React 의존 0). #187
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ① 왜 "합성"인가 — 발행 에셋 두 축이 서로를 반쪽씩 갖고 있다.
 *
 *   `characters/card-<char>.png` (226×425) = 프레임까지 **구워진 완성 카드**.
 *      프레임 색이 **캐릭터 시그니처 색**이고 별은 항상 5개다(파이프라인 `composeCard` 기본값).
 *      → 그대로 쓰면 BRONZE 선수가 별 5개 금테로 보인다(**등급 오독**).
 *
 *   `frame-<GRADE>.png` (226×425) = **등급 프레임 템플릿**. 테두리 색·별 개수가 등급별로 맞다.
 *      대신 아트 영역이 비어 있고 포지션 뱃지가 `MF` 로 구워져 있다(플레이스홀더 규격).
 *
 * 프레임리스 아트(`out/<char>/card-art.png`)는 파이프라인 중간 산출물이라 **커밋돼 있지 않다**
 * (#145 가 발행 요청을 남기고 종료). 그래서 재생성·재발행 없이, **커밋된 두 장을 겹쳐서**
 * 등급 정합 카드를 만든다:
 *
 *      [층1] frame-<GRADE>.png 전체        → 테두리·별·하단 밴드 = 등급
 *      [층2] card-<char>.png 의 아트 영역만 → 캐릭터 일러스트 = 오리진
 *      [층3] React 텍스트 오버레이          → 이름·포지션 뱃지(구워진 `MF` 를 덮는다)
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ② 갈아끼우기 (hero 요구, 2026-07-26) — **web 코드를 안 고치고 바꿀 수 있는 것들**
 *
 *   · **이미지 교체**: `design/characters/dist/**` 를 새로 발행하고 `npm run build:chars`.
 *     경로는 전부 manifest 에서 읽는다(하드코딩 경로 0) — 캐릭터 수·파일명이 바뀌어도 무변경.
 *   · **카드 규격 변경**(프레임 두께·아트 영역·밴드 위치): 발행 manifest 에 `cardGeometry` 를
 *     실으면 **그 값이 이긴다**(`resolveCardGeometry`). 없으면 아래 기본값(현행 발행물 실측).
 *     필드 단위로 검사하므로 **일부만 실어도** 되고, 손상값은 조용히 기본값으로 떨어진다.
 *   · **크기 조정**: `FULL_ART_SIZES` 한 곳. 소비처는 픽셀이 아니라 `"grid" | "rail" | ...`
 *     시맨틱 토큰을 쓴다 → 한 줄 고치면 전 화면이 같이 움직인다.
 *   · **색/링/폰트비**: `FULL_ART_DESIGN` 한 곳(+ `FullArtCard.module.css` 의 CSS 변수).
 * ════════════════════════════════════════════════════════════════════════════
 */
import { assetUrl, characterCardUrl, frameUrl } from "./char-manifest";
import type { CharactersManifest, PlaceholderManifest } from "./char-manifest";
import { GRADE_COLORS, type Grade } from "./grades";

// ── ① 카드 규격 ────────────────────────────────────────────────────────────

export interface CardGeometry {
  w: number;
  h: number;
  /** 프레임 두께(바깥 베벨 1 + 금테 7 + 안쪽 베벨 2). 아트 영역의 시작점. */
  inset: number;
  /** 아트 영역의 아래 끝(여기부터 네임플레이트). */
  artBottom: number;
  nameY: number;
  nameH: number;
  descY: number;
  /** 포지션 뱃지(좌상단) — 프레임 위에 얹히므로 인셋 바깥이다. */
  badge: { x: number; y: number; w: number; h: number };
}

/**
 * 현행 발행물 실측 기본값 — `design/characters/pipeline/lib/card.mjs` 의 `CARD` 와 같은 값.
 * 발행물이 `cardGeometry` 를 실어 보내면 그쪽이 이긴다(`resolveCardGeometry`).
 * `full-art.test.ts` 가 실제 PNG 크기와 대조해 드리프트를 잡는다.
 */
export const DEFAULT_CARD_GEOMETRY: CardGeometry = {
  w: 226,
  h: 425,
  inset: 10,
  artBottom: 331,
  nameY: 330,
  nameH: 32,
  descY: 386,
  badge: { x: 8, y: 8, w: 34, h: 18 },
};

const posNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * 발행 manifest 의 `cardGeometry`(선택 필드)를 기본값 위에 덮는다.
 *
 * **필드 단위**로 검사하는 이유: 발행물이 일부만 싣거나 한 필드가 손상돼도 카드 전체가
 * 무너지면 안 된다. 숫자가 아니거나 음수면 그 필드만 기본값으로 남는다(throw 없음).
 * 규격이 안 맞으면 화면이 어긋날 뿐 깨지지는 않는다 — 폴백 계단과 같은 원칙.
 */
export function resolveCardGeometry(manifest: CharactersManifest | null | undefined): CardGeometry {
  const raw = (manifest as { cardGeometry?: unknown } | null | undefined)?.cardGeometry;
  if (!raw || typeof raw !== "object") return DEFAULT_CARD_GEOMETRY;
  const g = raw as Record<string, unknown>;
  const b = (g.badge && typeof g.badge === "object" ? g.badge : {}) as Record<string, unknown>;
  const d = DEFAULT_CARD_GEOMETRY;
  const merged: CardGeometry = {
    w: posNum(g.w) ?? d.w,
    h: posNum(g.h) ?? d.h,
    inset: posNum(g.inset) ?? d.inset,
    artBottom: posNum(g.artBottom) ?? d.artBottom,
    nameY: posNum(g.nameY) ?? d.nameY,
    nameH: posNum(g.nameH) ?? d.nameH,
    descY: posNum(g.descY) ?? d.descY,
    badge: {
      x: posNum(b.x) ?? d.badge.x,
      y: posNum(b.y) ?? d.badge.y,
      w: posNum(b.w) ?? d.badge.w,
      h: posNum(b.h) ?? d.badge.h,
    },
  };
  // 아트 영역이 음수/0 이 되는 조합(예: inset 이 폭의 절반 이상)은 렌더가 성립하지 않는다 → 통째 기본값.
  const artW = merged.w - merged.inset * 2;
  const artH = merged.artBottom - merged.inset;
  return artW > 0 && artH > 0 ? merged : DEFAULT_CARD_GEOMETRY;
}

/** 카드 종횡비 — 컨테이너에 `aspect-ratio` 로 걸어 세로 흔들림 0. */
export const cardAspect = (g: CardGeometry = DEFAULT_CARD_GEOMETRY) => `${g.w} / ${g.h}`;

/**
 * **아트 영역만**의 종횡비(`variant="art"`).
 *
 * 왜 필요한가: 이름·등급·별을 카드 **밖**에서 이미 보여주는 자리(덱 지시 레일 헤드,
 * 트레이드 카드, 강화 상세 헤더)에서는 `showLabels={false}` 로 껐는데, 프레임 에셋이
 * 하단 밴드(네임플레이트 + 설명판)를 **이미 그려놨기 때문에 빈 검은 띠가 남는다**
 * (트레이드에서 카드 높이의 22%. hero·독립 검증이 같이 지적).
 * 그럴 땐 프레임 통짜가 아니라 **아트만 잘라** 쓰고 등급은 링이 말하게 한다.
 */
export const artAspect = (g: CardGeometry = DEFAULT_CARD_GEOMETRY) =>
  `${g.w - g.inset * 2} / ${g.artBottom - g.inset}`;

const pct = (n: number) => `${(n * 100).toFixed(4)}%`;

export interface FullArtLayout {
  window: { left: string; top: string; width: string; height: string };
  art: { left: string; top: string; width: string; height: string };
  name: { top: string; height: string };
  desc: { top: string; height: string };
  badge: { left: string; top: string; width: string; height: string };
  /** `variant="art"` 용 — 컨테이너가 아트 박스(206×321)라 카드 기준 좌표를 쓸 수 없다. */
  badgeArt: { left: string; top: string; width: string; height: string };
}

/**
 * 카드 박스(=원본을 비율로 축소한 것) 안에서 각 층이 차지할 자리를 **퍼센트**로 계산한다.
 * 픽셀이 아니라 퍼센트인 이유: 카드 크기가 화면마다 다르고(88~290px), 퍼센트면 한 벌로 다 커버된다.
 */
export function fullArtLayout(g: CardGeometry = DEFAULT_CARD_GEOMETRY): FullArtLayout {
  const artW = g.w - g.inset * 2;
  const artH = g.artBottom - g.inset;
  return {
    /** 아트 창(overflow hidden) — 카드 박스 기준. */
    window: {
      left: pct(g.inset / g.w),
      top: pct(g.inset / g.h),
      width: pct(artW / g.w),
      height: pct(artH / g.h),
    },
    /**
     * 창 안에 들어가는 카드 원본 이미지 — 창보다 크게 깔고 음수 오프셋으로 밀어
     * 원본의 아트 영역만 보이게 한다(= CSS 크롭).
     * top/height 퍼센트는 **창의 높이** 기준으로 해석되므로 artH 로 나눈다.
     */
    art: {
      left: pct(-g.inset / artW),
      top: pct(-g.inset / artH),
      width: pct(g.w / artW),
      height: pct(g.h / artH),
    },
    /** 네임플레이트 밴드(층1 이 이미 그려둔 어두운 판) — 여기에 이름 텍스트를 얹는다. */
    name: { top: pct(g.nameY / g.h), height: pct(g.nameH / g.h) },
    /** 하단 설명판 — 등급 라벨 등. */
    desc: { top: pct(g.descY / g.h), height: pct((g.h - g.inset - g.descY) / g.h) },
    /** 포지션 뱃지 — 층1 의 `MF` 를 덮어야 하므로 위치·크기를 정확히 맞춘다. */
    badge: {
      left: pct(g.badge.x / g.w),
      top: pct(g.badge.y / g.h),
      width: pct(g.badge.w / g.w),
      height: pct(g.badge.h / g.h),
    },
    /*
     * 아트 변형의 뱃지 — 원본 뱃지는 (badge.x, badge.y) 에서 시작해 **인셋보다 위/왼쪽**이라
     * 크롭 경계를 넘는다(8 < 10). 그래서 아트 박스 좌상단(0,0)에 붙이고, 크롭 안으로 들어온
     * 부분만큼만 크기를 잡는다. 음수가 되는 조합(뱃지가 완전히 크롭 밖)이면 0 → 렌더 안 됨.
     */
    badgeArt: {
      left: "0%",
      top: "0%",
      width: pct(Math.max(0, g.badge.x + g.badge.w - g.inset) / artW),
      height: pct(Math.max(0, g.badge.y + g.badge.h - g.inset) / artH),
    },
  };
}

// ── ② 디자인 토큰 (크기·색) ─────────────────────────────────────────────────

/**
 * 카드 폭 **시맨틱 토큰**. 소비처는 픽셀 대신 이 이름을 쓴다 —
 * 나중에 "뽑기 카드를 좀 키우자"가 여기 한 줄 수정으로 끝난다.
 *
 * 실측 근거: 96px 에서는 이름이 안 읽힌다(웨이브1 캡처) → 그리드 최소 104.
 */
export const FULL_ART_SIZES = {
  /** 뽑기 결과 그리드 — 모바일 390 에서 3열이 나오는 최대치. */
  grid: 104,
  /** 덱 지시 레일 헤드 — 신원 한 줄 옆(데스크탑). */
  rail: 88,
  /**
   * 모바일 하단 독의 레일 헤드. **세로 예산이 계약으로 묶여 있다** — #106 R3a/R3b 가
   * 펼친 독 높이를 보유 선수 리스트 가시성·접힘 점프(<400px)에 맞춰 튜닝해 놨고,
   * 88px(=165px 높이) 카드를 넣으면 그 계약이 전부 깨진다(deck-teamsheet e2e 3건이 잡았다).
   * 여기서 키우고 싶으면 그 e2e 를 같이 봐야 한다 — 숫자만 올리면 조용히 리스트가 덮인다.
   */
  railCompact: 52,
  /** 도감 확장 / 트레이드 영입 대상 — 능력치와 나란히. */
  detail: 132,
  /** 상세 시트. */
  sheet: 200,
  /** 확대·스포트라이트. */
  hero: 290,
} as const;

export type FullArtSize = keyof typeof FULL_ART_SIZES;

/** 토큰 또는 임의 픽셀 → 픽셀. 임의값도 허용하되 기본은 토큰을 쓰게 유도한다. */
export function fullArtWidth(size: FullArtSize | number): number {
  return typeof size === "number" ? size : FULL_ART_SIZES[size];
}

/**
 * 카드 안 텍스트의 폰트 크기 = 카드 폭 비율. 카드가 커지면 글자도 같이 커져야
 * 밴드 안에서 같은 비율로 앉는다(고정 px 면 88px 카드에서 넘치고 290px 에서 초라해진다).
 */
export const FULL_ART_DESIGN = {
  nameFontRatio: 0.075,
  gradeFontRatio: 0.062,
  badgeFontRatio: 0.055,
  minNameFont: 9,
  minGradeFont: 8,
  minBadgeFont: 7,
  /** 폴백 아이콘이 아트 창에서 차지할 비율. */
  fallbackIconRatio: 0.52,
} as const;

/**
 * D4 — **등급색 링 1겹**(hero 위임 판단, 2026-07-26).
 *
 * 왜: 프레임 에셋의 `LEGEND #e4991c` 와 `GOLD #d9a01e` 는 육안 구분이 안 돼 **별 개수로만**
 * 갈린다. web `GRADE_COLORS` 는 DIA·SILVER·BRONZE 가 프레임과 이미 일치하고 **LEGEND(보라)
 * 한 자리만 어긋난다**. 카드 **바깥**에 등급색을 한 겹 두르면 LEGEND 가 확실히 갈리고,
 * 나머지 등급은 프레임 색을 보강할 뿐이라 충돌이 없다. **에셋은 안 건드린다.**
 */
export function gradeRingShadow(grade: Grade | null | undefined): string | undefined {
  const c = grade ? GRADE_COLORS[grade] : undefined;
  if (!c) return undefined;
  return `0 0 0 2px ${c}, 0 0 16px ${c}8c`;
}

// ── ③ URL 해석 + 폴백 ──────────────────────────────────────────────────────

/**
 * 한 장을 그리는 데 필요한 이미지 URL 들.
 * `art` 가 null 이면 캐릭터 매핑이 없는 선수 — 프레임만 그리고 호출부가 아이콘으로 채운다.
 * `frame` 이 null 이면 등급 프레임 자체가 없다 — 호출부가 CSS 폴백(등급색 테두리)으로 떨어진다.
 */
export interface FullArtLayers {
  art: string | null;
  frame: string | null;
  /** 어느 단계까지 해석됐는지 — 계약 테스트·QA 가 눈이 아니라 데이터로 확인할 수 있게 노출. */
  kind: "full-art" | "frame-only" | "none";
}

/**
 * 폴백 체인(깨짐 0):
 *   1) 캐릭터 매핑 O + 등급 프레임 O → `full-art`  (원하는 그림)
 *   2) 캐릭터 매핑 X (또는 카드 경로 손상) → `frame-only` — 등급 프레임 + 아이콘
 *   3) 등급 프레임도 없음 → `none` — CSS 폴백(테두리 + 아이콘)
 *
 * 어떤 입력(손상 manifest·프로토타입 오염·경로 탈출)에도 throw 하지 않는다 — `char-manifest` 의
 * 접근자가 이미 형상·경로를 검사하고 null 로 떨어뜨린다.
 */
export function fullArtLayers(args: {
  characters: CharactersManifest | null | undefined;
  placeholders: PlaceholderManifest | null | undefined;
  charId: string | null | undefined;
  grade: string | null | undefined;
  base?: string;
}): FullArtLayers {
  const art = characterCardUrl(args.characters, args.charId, args.base);
  const frame = frameUrl(args.placeholders, args.grade, args.base);
  if (art && frame) return { art, frame, kind: "full-art" };
  if (frame) return { art: null, frame, kind: "frame-only" };
  return { art: null, frame: null, kind: "none" };
}

/**
 * 프리로드 대상 URL — **풀아트를 실제로 띄우는 화면에서만** 부른다(AC4 lazy).
 * 아트 14장 ~139KB + 프레임 5장 ~8KB 라 화면 단위로 받으면 부담이 없지만,
 * 목록/매치처럼 아이콘만 쓰는 화면은 이 경로를 타지 않으므로 **한 바이트도 안 받는다.**
 */
export function preloadUrls(layers: FullArtLayers): string[] {
  return [layers.frame, layers.art].filter((u): u is string => typeof u === "string");
}

/** 등급 프레임만 단독으로 필요할 때(프리뷰·스켈레톤). */
export function gradeFrameUrl(
  placeholders: PlaceholderManifest | null | undefined,
  grade: string | null | undefined,
  base?: string,
): string | null {
  return frameUrl(placeholders, grade, base);
}

/** manifest 상대경로 → URL (재노출 — 프리뷰 하니스가 카드 원본을 직접 가리킬 때 쓴다). */
export { assetUrl };
