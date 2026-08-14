/**
 * #504 D1-A — **연습경기 튜토리얼 제안을 띄울 것인가**(순수 판정).
 *
 * ## 왜 함수 하나로 뽑았나
 * 이 판정은 원래 홈 타일 `pressTile` **한 곳에만** 있었고, 그래서 게임 화면으로 가는 나머지 길
 * (하단탭 [게임] · 덱 화면의 `navigate("/game")` · URL 직접 · 뒤로가기)은 판정을 **평가조차 하지
 * 않았다**. 오픈베타 실유저 2명 / 온레일 발화 0명이 그 결과다(#504 조사).
 *
 * hero 결정(2026-08-15) = **D1-A: `/game` 도착 자체를 판정 지점으로.** 그래서 판정을 화면에서
 * 떼어내 여기 두고, 소비처는 도착 지점(`GamePage`) **하나**로 좁혔다. 홈 타일은 이제 이동만 한다 —
 * 두 화면이 각자 판정하면 그게 다시 두 벌이 되고, 새 진입로가 생길 때마다 또 샌다.
 *
 * ⚠️ **수용한 대가**(hero 명시): 리그·원정만 하러 온 신규 유저도 **1회** 모달을 본다. 자격은 답한
 * 순간 소모되므로(`markPracticeTutorialAnswered`) 두 번은 없다.
 */

/**
 * **D3 스위치** — 덱이 없는 자격자에게 제안을 먼저 할 것인가.
 *
 * `false`(기본) = **②현행 유지**: 덱없음 가드가 먼저다. 그 창에 걸린 유저는 제안을 못 받고,
 * 그 사실이 `onrail_offer_missed` 로 서버에 남는다 — 그 크기가 이 스위치를 뒤집을지의 근거다.
 * `true` = **①제안 먼저**: 온레일 1스텝이 덱 화면이라 "덱이 없다"는 튜토리얼이 풀어 줄 문제라는 쪽.
 *
 * ⚠️ **hero 미회신 상태로 착지한 값이다**(매니저 판단, #504). 회신이 ① 이면 **이 한 줄만** 뒤집는다 —
 * 그래서 순서를 화면 코드의 if 순서가 아니라 이 상수의 함수로 만들어 두었다.
 */
export const OFFER_BEFORE_DECKLESS_GUARD = false;

export type PracticeOfferDecision =
  /** 제안을 띄운다. */
  | "offer"
  /** 자격은 있지만 덱없음 가드가 먼저다(D3 기본) — 제안 없이 도착한 사실을 남긴다. */
  | "deckless-first"
  /** 자격 자체가 없다 — 아무 일도 일어나지 않는다(기존 유저·목 유저 방해 0). */
  | "none";

export function practiceOfferDecision({
  eligible,
  deckMissing,
  offerFirst = OFFER_BEFORE_DECKLESS_GUARD,
}: {
  /** `guide-storage.shouldOfferPracticeTutorial` — pending 래치 ∧ 아직 답하지 않음. */
  eligible: boolean;
  /**
   * 덱이 **없다고 확인됐다**. ⚠️ 로딩 중(`undefined`)을 여기에 `false` 로 흘리지 마라 —
   * 호출부가 덱을 알기 전에 판정하면 "제안했는데 알고 보니 덱이 없더라"가 되고, 그건 D3 를
   * 스위치로 만든 의미를 없앤다. 그래서 소비처는 `deck !== undefined` 를 먼저 본다.
   */
  deckMissing: boolean;
  /** 테스트·롤백용 주입. 생략하면 위 스위치. */
  offerFirst?: boolean;
}): PracticeOfferDecision {
  if (!eligible) return "none";
  if (deckMissing && !offerFirst) return "deckless-first";
  return "offer";
}
