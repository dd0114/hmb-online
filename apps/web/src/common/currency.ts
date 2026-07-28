import type { Currency } from "../api/config";

/**
 * 재화 표기 포매터 (#232) — 화면에 나가는 재화 문자열은 **전부 여기를 통과한다**.
 *
 * 규칙 하나: **심볼·이름을 이 파일 밖에서 쓰지 않는다.** "P"·"💎"·"포인트"·"젬"을 컴포넌트에 적으면
 * 서버가 표기를 바꿔도 화면이 안 따라오고, 그 상태가 바로 #213(화면 "300 P" / 실제 다이아 300 차감)이다.
 *
 * ## 폴백 (config 조회 실패 시)
 * 흰 화면도 안 되고, 하드코딩된 "P"로 되돌아가서도 안 된다. 대신 **코드를 그대로 노출**한다
 * ("POINT 300"). 못생겼지만 거짓말은 아니고, 화면에서 바로 눈에 띄어 조용히 썩지 않는다.
 */

/** 내부 재화 코드 — 서버 계약과 같은 문자열. 표기가 아니라 **키**다. */
export const CURRENCY_POINT = "POINT";
export const CURRENCY_GEM = "GEM";

/**
 * 마지막 폴백. 심볼 자리에 코드가 들어간다 — 기본 표기를 여기 적어 두면 서버가 바뀌어도
 * "그럴듯하게" 틀린 화면이 나와서 사고를 못 잡는다(그게 정확히 #213 이 숨어 있던 방식이다).
 */
export function fallbackCurrency(code: string): Currency {
  return { code, symbol: code, name: code, icon: "", position: "suffix", separator: " " };
}

/**
 * 코드로 표기 조회 — **필드 단위로** 폴백을 덮는다.
 *
 * 코드가 있으면 그대로 쓰던 구현은, 서버가 일부 필드만 준 응답에서 `undefined` 를 그대로 화면에
 * 보간했다(`62,000undefinedΩ`, 390px 뷰포트가 498px 로 벌어짐 — 독립검증 MJ-1). 응답 스키마는
 * 클라가 강제할 수 없으니(구 서버·롤백·프록시 변형) 렌더 직전에 성분을 보장한다.
 * `separator` 만은 **빈 문자열이 의미 있는 값**(붙여쓰기)이라 존재 여부로 판정한다.
 */
export function findCurrency(currencies: Currency[] | undefined, code: string): Currency {
  const found = currencies?.find((c) => c.code === code);
  if (!found) return fallbackCurrency(code);
  const base = fallbackCurrency(code);
  const position = found.position === "prefix" || found.position === "suffix" ? found.position : base.position;
  return {
    code,
    symbol: nonEmpty(found.symbol) ?? base.symbol,
    name: nonEmpty(found.name) ?? base.name,
    icon: typeof found.icon === "string" ? found.icon : base.icon,
    position,
    separator: typeof found.separator === "string" ? found.separator : base.separator,
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 숫자 표기(천단위 구분). 금액 포맷은 한 곳에서만 정한다. */
export function formatNumber(value: number): string {
  return value.toLocaleString("ko-KR");
}

/**
 * 금액 표기 — `62,000 G` / `● 6,000 Z`(아이콘 포함 시). 아이콘은 opts.icon 일 때만 붙인다
 * (버튼처럼 좁은 자리에서는 심볼만 쓴다).
 */
export function formatAmount(
  currency: Currency,
  value: number,
  opts: { icon?: boolean } = {},
): string {
  const n = formatNumber(value);
  const body =
    currency.position === "prefix"
      ? `${currency.symbol}${currency.separator}${n}`
      : `${n}${currency.separator}${currency.symbol}`;
  return opts.icon && currency.icon ? `${currency.icon} ${body}` : body;
}

/**
 * 문장형 안내문용 이름 + 조사. 서버 문구를 그대로 쓸 수 있는 자리(4xx message)는 서버 것을 쓰고,
 * 클라가 문장을 만들어야 하는 자리(잔액 부족 힌트 등)만 이걸 쓴다.
 *
 * 조사가 필요한 이유: 이름이 데이터가 됐다. "다이아" → "다이아가", "젬" → "젬이".
 */
export function withIga(name: string): string {
  return `${name}${hasFinalConsonant(name) ? "이" : "가"}`;
}

export function withEulReul(name: string): string {
  return `${name}${hasFinalConsonant(name) ? "을" : "를"}`;
}

export function withEunNeun(name: string): string {
  return `${name}${hasFinalConsonant(name) ? "은" : "는"}`;
}

/**
 * 마지막 글자에 받침이 있는가. 한글 음절 블록 = `0xAC00 + (초성*21 + 중성)*28 + 종성` 이라
 * 종성 인덱스가 0 이 아니면 받침이 있다. 한글이 아니면(코드 폴백 "GEM" 등) 받침 있음으로 본다 —
 * "GEM이"는 어색해도 읽히지만 "GEM가"는 틀린 말이다.
 */
function hasFinalConsonant(word: string): boolean {
  if (!word) return true;
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return true;
  return (code - 0xac00) % 28 !== 0;
}

/**
 * 지갑에서 **그 재화의 잔액**을 고른다. 모르면 `null`.
 *
 * <b>모를 때 잠그지 않는 것이 규칙이다.</b> 지갑은 두 재화만 들고 있는데 서버는 미지 코드를
 * 지원한다(로더가 명시적으로). 모르는 재화를 조용히 무료재화 잔액으로 재면 "500 Z 인데 골드가
 * 모자라서 잠김"이 되고, 그건 이 이슈가 고친 #213 과 정확히 같은 형태다. 판정 근거가 없으면
 * **서버 판정에 맡긴다** — 잘못 잠그는 것보다 눌러서 4xx 를 받는 편이 낫다.
 *
 * `gems` 가 응답에 없는 경우(구서버 — openapi 가 required 로 두지 않은 그 경우)도 "모름"이다.
 * `?? 0` 으로 떨어뜨리면 유상재화를 들고 있는 유저가 거짓으로 잠긴다.
 */
export function balanceFor(
  code: string,
  wallet: { points?: number | null; gems?: number | null },
): number | null {
  if (code === CURRENCY_POINT) return typeof wallet.points === "number" ? wallet.points : null;
  if (code === CURRENCY_GEM) return typeof wallet.gems === "number" ? wallet.gems : null;
  return null;
}

/** "{이름}가 부족합니다" — 잔액 부족 힌트를 클라가 만들어야 하는 자리 공용. */
export function shortageMessage(currency: Currency): string {
  return `${withIga(currency.name)} 부족합니다`;
}
