/**
 * #479 — 첫 진입 스플래시를 **언제 띄우나**. 순수 판정 + 저장소 접근 한 곳.
 *
 * 화면(`LoginPage`)에서 조건을 다시 조립하지 마라 — 규칙이 두 곳에 생기면 한쪽만 낡는다
 * (모듈 규율: `deckless.ts`·`icon-policy.ts` 와 같은 축).
 */

/** 세션당 1회 노출 플래그. `localStorage` 가 아니다 — 아래 주석 참조. */
export const SPLASH_SEEN_KEY = "hmb.splash.seen";

export interface SplashGateInput {
  /** 이번 세션에 이미 봤나(`sessionStorage`). */
  seen: boolean;
  /**
   * `?returnTo=` 원본 문자열. 있으면(공유 딥링크로 들어온 사람) **띄우지 않는다** —
   * 그가 온 목적은 그 링크의 목적지이고, 광고를 먼저 보여 주면 #298 이 되살린 "목적지를
   * 잃지 않는다"를 화면에서 다시 깨는 셈이다.
   */
  returnTo: string | null;
}

/**
 * ⚠️ **왜 `sessionStorage` 인가** — 축이 둘이다.
 *  · `localStorage`(영구 1회) = 광고를 한 번 본 사람은 기기를 바꾸기 전까지 다시 못 본다.
 *    연출을 갱신해도 재방문자에게 영영 안 닿는다.
 *  · 매 진입 = `/login` 을 왕복할 때마다(로그아웃·401 튕김·뒤로가기) 15초 광고가 다시 뜬다.
 * 세션당 1회가 그 사이다. hero 문구 "웹 **첫 진입**"에 맞고, 조정하려면 이 함수 하나만 바꾼다.
 */
export function shouldShowSplash({ seen, returnTo }: SplashGateInput): boolean {
  if (seen) return false;
  if (returnTo) return false;
  return true;
}

/**
 * ⚠️ 저장소 접근은 **예외를 삼키고 "안 봤다"로 폴백**한다(사파리 프라이빗·쿠키 차단에서
 * `sessionStorage` 접근 자체가 throw 한다). `growth/roll-confirm.ts` 와 같은 관용구지만
 * 폴백 방향이 반대다 — 저기는 "확인을 띄우는 쪽"(안전), 여기는 "스플래시를 띄우는 쪽"이
 * 기능이 살아 있는 쪽이다. 최악이 "광고를 한 번 더 본다"라 그쪽이 안전측이다.
 */
export function readSplashSeen(): boolean {
  try {
    return window.sessionStorage.getItem(SPLASH_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSplashSeen(): void {
  try {
    window.sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
  } catch {
    // 저장 실패는 동선을 막지 않는다 — 다음 진입에 한 번 더 보이는 것이 전부다.
  }
}
