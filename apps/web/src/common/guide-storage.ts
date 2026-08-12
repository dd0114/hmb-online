/**
 * #493 W2 — 화면별 가이드 진행 상태(localStorage).
 *
 * ⚠️ **모든 키는 userId 격리다.** 공지 억제 키가 계정을 공유하던 기존 결함(notice-logic.ts:149 —
 * 한 기기에서 계정을 바꾸면 다른 계정의 '봤음'이 따라온다)을 반복하지 않는다. userId 를 모르면
 * (비로그인·캐시 미도착) **아무것도 쓰지 않는다** — 익명 키를 만들면 그게 곧 공유 상태다.
 *
 * 두 키:
 *  - pending: 온보딩을 끝낸 계정에 서는 래치. **가이드는 이 래치가 있어야만 발화한다** —
 *    없으면 기존 유저·e2e 목 유저에게 가이드가 쏟아진다(tutorialDone:true 목이 38개 스펙에 있다).
 *  - seen: 화면(pathname) 단위 노출 기록. 다시 보기(resetGuides)는 seen 만 비운다.
 */
const PENDING_KEY = (userId: string) => `hmb.guide.pending.${userId}`;
const SEEN_KEY = (userId: string) => `hmb.guide.seen.${userId}`;
/** #493 W5 — 연습경기 튜토리얼 제안에 **답한 적이 있는가**(수락/거절 무관). 위 두 키와 같은 규율. */
const PRACTICE_KEY = (userId: string) => `hmb.guide.practice.${userId}`;

export function markGuidePending(userId: string | null): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(PENDING_KEY(userId), "1");
  } catch {
    /* 저장 불가(사파리 프라이빗 등) — 가이드가 안 뜰 뿐 동선은 그대로 */
  }
}

export function guidePending(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(PENDING_KEY(userId)) === "1";
  } catch {
    return false;
  }
}

export function readGuideSeen(userId: string | null): Set<string> {
  if (!userId) return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_KEY(userId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function markGuideSeen(userId: string | null, screen: string): void {
  if (!userId) return;
  try {
    const next = readGuideSeen(userId);
    next.add(screen);
    window.localStorage.setItem(SEEN_KEY(userId), JSON.stringify([...next]));
  } catch {
    /* no-op */
  }
}

/**
 * #493 W5 — 홈 [게임 시작]에서 **연습경기 튜토리얼을 제안할 때인가**.
 *
 * 곱 두 개다:
 *  · **pending 래치가 서 있다** = 온보딩을 방금 끝낸 계정(`TutorialProvider.persistIfOwner` 가
 *    심는다). 이 게이트가 없으면 기존 유저와 토큰만 심는 e2e 목 유저 전원이 첫 클릭에 이 모달을
 *    맞는다 — GuideProvider 가 같은 이유로 같은 래치를 본다(이 파일 머리말).
 *  · **아직 답하지 않았다.** 수락이든 거절이든 한 번 답하면 끝이다(매번 물으면 방해다).
 *
 * ⚠️ pending 래치는 '화면 안내 다시 보기'(`resetGuides`)로 다시 설 수 있지만 이 답은 **지우지
 * 않는다** — 안내를 다시 보겠다는 뜻이 "첫 경기를 또 제안받겠다"는 뜻은 아니다.
 */
export function shouldOfferPracticeTutorial(userId: string | null): boolean {
  if (!userId) return false;
  return guidePending(userId) && !practiceTutorialAnswered(userId);
}

export function practiceTutorialAnswered(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(PRACTICE_KEY(userId)) === "1";
  } catch {
    return false;
  }
}

/** 수락/거절 어느 쪽이든 답한 그 순간 기록한다 — 되묻지 않는 것이 이 값의 전부다. */
export function markPracticeTutorialAnswered(userId: string | null): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(PRACTICE_KEY(userId), "1");
  } catch {
    /* 저장 불가(사파리 프라이빗 등) — 다음에 한 번 더 물을 뿐 동선은 그대로 */
  }
}

/** '화면 안내 다시 보기' — seen 을 비우고 pending 을 다시 세운다(그 계정만). */
export function resetGuides(userId: string | null): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(SEEN_KEY(userId));
  } catch {
    /* no-op */
  }
  markGuidePending(userId);
}
