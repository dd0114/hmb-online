/**
 * 덱 없는 유저의 게임 시작 가드 — **순수 판정** (#286 W3.5).
 *
 * hero 발제(라이브 실증): 덱이 없는 유저가 [게임 시작]까지 도달해 막다른 에러를 본다.
 *
 * ⚠️ **서버가 관용적이어서 생긴 문제가 아니다.** `MatchService` 의 매치 생성 3경로(연습·리그·
 * 원정)는 전부 `getActiveDeck` 으로 시작하고, 덱이 없으면 던진다 — 거부는 이미 하고 있었다.
 * 없던 것은 **안내**다. 그래서 이 모듈은 "막을지"와 "무엇을 시킬지"만 정하고, 규칙을 서버에서
 * 복제해 오지 않는다.
 */

/** 선발 정원. IFAB 11명 — 서버 `DeckService` 검증과 같은 값이지만 **여기선 안내용 분모**다. */
export const STARTER_REQUIRED = 11;

export type DecklessBranch =
  /** 카드는 충분하다 → 덱을 구성하러 보낸다(자동완성 → 감독 한마디 → 저장). */
  | { kind: "build" }
  /**
   * 카드가 모자라 자동완성으로도 11칸을 못 채운다 → **영입으로 보낸다**(hero Q8 = C).
   * 여기서 "덱을 구성하시겠습니까?"를 띄우면 **할 수 없는 일을 시키는 안내**가 된다.
   */
  | { kind: "recruit"; owned: number; required: number };

/**
 * 덱이 없는가.
 *
 * `useDeck` 은 404 를 `null` 로 정규화한다(= 덱 없음). `undefined` 는 **아직 모른다**(로딩)이고,
 * 그때는 막지 않는다 — 모르는 동안 막으면 정상 유저가 첫 클릭마다 안내를 맞는다.
 */
export function deckMissing(deck: unknown | null | undefined): boolean {
  return deck === null;
}

/**
 * 안내 분기. `owned` 는 **서버가 준 보유 수**다 — 클라가 지어내지 않는다.
 *
 * 보유 수를 모르면(카탈로그 미도착) `build` 로 떨어진다: 덱 화면은 어차피 저장을 막고
 * 부족분을 그 자리에서 보여주므로, 유저를 **덜 아는 화면**으로 보내는 쪽이 안전하다.
 */
export function decklessBranch(owned: number | null | undefined): DecklessBranch {
  if (typeof owned === "number" && owned < STARTER_REQUIRED) {
    return { kind: "recruit", owned, required: STARTER_REQUIRED };
  }
  return { kind: "build" };
}

/**
 * 서버가 "덱이 없다"고 거부했는가 — 클라 가드를 통과한 **경합** 경로(다른 탭에서 덱 삭제 등).
 *
 * 두 형태를 다 받는다:
 *  · `DECK_REQUIRED` — W4 가 붙일 전용 코드
 *  · `404` + 덱 문구 — 지금 서버(`ApiException.notFound`)의 뭉뚱그린 응답
 *
 * ⚠️ **404 만으로 판정하지 않는다.** 이 엔드포인트의 404 가 항상 덱 문제라는 보장이 없고,
 * 그렇게 넓히면 엉뚱한 실패까지 "덱을 만드세요"로 덮어 진짜 원인을 가린다. 그래서 전용 코드가
 * 아니면 **문구까지** 본다. W4 가 코드를 붙이면 이 문구 의존은 사라진다(가지는 남겨 둔다 —
 * 구 서버가 살아 있는 동안 web 이 먼저 나갈 수 있어야 한다).
 */
export function isDeckRequiredError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (e.code === "DECK_REQUIRED") return true;
  return e.status === 404 && typeof e.message === "string" && e.message.includes("덱");
}
