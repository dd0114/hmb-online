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
