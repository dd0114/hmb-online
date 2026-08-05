import { GRADE_LABELS, GRADE_ORDER, type Grade } from "../common/grades";

/**
 * 뽑기(영입) 홍보 — **문구와 표를 만드는 순수 모듈** (#457 C1).
 *
 * hero: *"뽑기화면 너무 심심해. 뽑기 페이지 설명 더 붙여. 지금 레전드 선수를 뽑아보세요 같은
 * 홍보페이지 만들어."* 그전 화면은 **카드 2장뿐**이었다(단뽑/10연뽑 버튼) — 무엇을 얻는지,
 * 왜 지금 뽑는지 말하는 문장이 하나도 없었다.
 *
 * ## 규율 두 개
 *
 * 1. **숫자는 하나도 여기서 짓지 않는다** (#232·#213). 개수·보장 등급·확률은 전부 서버
 *    `GET /api/config` 의 `shop.gacha` 에서 온다. 화면에 `"선수 11명 · 골드 이상 1명 보장"` 을
 *    손으로 적어 두었던 것이 정확히 #213 이 만든 사고의 모양이다(값이 바뀌어도 화면은 그대로).
 * 2. **모르면 말하지 않는다.** `rates`·`tenPityMinGrade` 는 **아직 서버가 안 준다**(#458 이
 *    노출한다) → 그 줄을 **아예 그리지 않는다**. `?? 0.15` 같은 폴백을 넣으면 화면이 서버가 하지
 *    않는 약속을 하게 된다. #458 이 랜딩하면 **코드 변경 없이** 확률표가 켜진다.
 *
 * ⚠️ 문구는 게임 언어다 — 시스템 용어("가챠"·"확률 테이블")를 쓰지 않는다(#382 대기 화면과 같은 규율).
 */

/** `shop.gacha` — 오늘 오는 필드 + #458 additive(부재가 정상). */
export interface GachaPromoConfig {
  tenCount?: number;
  rates?: Record<string, number> | null;
  tenPityMinGrade?: string | null;
}

/**
 * 홍보 문안 **SoT**. 화면에 문장을 직접 적지 마라 — 갈라지면 다음 사람이 한쪽만 고친다(#382 선례).
 * ⚠️ hero 컨펌 대상(게임 언어). 톤을 바꿀 땐 여기만 고친다.
 */
export const GACHA_PROMO = {
  kicker: "스카우트 리포트",
  title: "이번 영입 시장, 레전드급 자원 포착",
  // ⚠️ hero 확정(2026-08-06): 스카우트 보고 톤. **"선착순"은 쓰지 않는다** — 실제로 선착순이
  //    아니라서(확률 뽑기) 화면이 없는 규칙을 말하게 된다.
  body: "보고서에 오른 선수들입니다. 최고 등급 선수는 경기장에서 고유 아트로 뜁니다.",
  points: [
    { icon: "✦", text: "레전드·다이아는 전용 일러스트로 등장합니다" },
    { icon: "◈", text: "같은 선수를 다시 뽑으면 성(★) 승급 재료가 됩니다" },
    { icon: "◎", text: "영입한 선수는 [선수]에서 강화할 수 있습니다" },
  ],
} as const;

/** 등급 라인업 — 높은 등급부터. 홍보는 "무엇을 노리나"를 위에서부터 보여준다. */
export const PROMO_GRADES: Grade[] = [...GRADE_ORDER].reverse();

/** `0.02` → `"2%"` · `0.155` → `"15.5%"`. 0.05% 미만은 반올림으로 0 이 되지 않게 소수 2자리까지 편다. */
export function formatRate(rate: number): string {
  const pct = rate * 100;
  const digits = pct >= 1 ? (Number.isInteger(pct) ? 0 : 1) : 2;
  return `${Number(pct.toFixed(digits))}%`;
}

export interface RateRow {
  grade: Grade;
  label: string;
  rate: number;
  text: string;
}

/**
 * 확률표 — 서버가 `rates` 를 줄 때만 만든다. 없으면 **null**(표 자체를 안 그린다).
 * 서버가 모르는 등급 키를 보내면 조용히 버린다(등급 축의 SoT 는 `grades.ts`).
 */
export function rateRows(cfg: GachaPromoConfig | null | undefined): RateRow[] | null {
  const rates = cfg?.rates;
  if (!rates || typeof rates !== "object") return null;
  const rows = PROMO_GRADES.filter((g) => typeof rates[g] === "number").map((g) => ({
    grade: g,
    label: GRADE_LABELS[g],
    rate: rates[g]!,
    text: formatRate(rates[g]!),
  }));
  return rows.length > 0 ? rows : null;
}

/**
 * 10연 안내 — 개수·보장 등급 **둘 다 서버 값**이다.
 * 보장 등급을 모르면 개수만 말한다(모르는 약속을 지어내지 않는다). 개수도 모르면 null.
 */
export function tenPullNote(cfg: GachaPromoConfig | null | undefined): string | null {
  const count = cfg?.tenCount;
  if (typeof count !== "number" || count <= 0) return null;
  const pity = cfg?.tenPityMinGrade;
  const label = pity && pity in GRADE_LABELS ? GRADE_LABELS[pity as Grade] : null;
  return label ? `선수 ${count}명 · ${label} 이상 1명 보장` : `선수 ${count}명`;
}
