/**
 * 튜토리얼 완료 상태 저장 (PRD-v4 §B AC-B1).
 *
 * ⚠️ 서버 필드(`GET /api/me` → `user.tutorialDone`, `src/api/p3.ts` MeResponseP3)가 **아직
 * 미발행**이다. 그래서 지금은 **localStorage 를 userId 별 키**로 쓴다(다른 계정으로 로그인해도
 * 서로 간섭 0). 읽기 우선순위는 `tutorial-logic.resolveTutorialDone` 이 정한다 —
 * 서버 값이 있으면 서버가 SoT, 없으면 로컬.
 *
 * TODO(openapi-v3): p3srv 가 완료 저장 엔드포인트(예: PATCH /api/me { tutorialDone:true })를
 * 발행하면 **`persistTutorialDone` 한 곳에만** 호출을 끼우면 된다(저장 지점 단일화).
 */

const DONE_KEY_PREFIX = "hmb.tutorial.done.";

/**
 * 신규 가입/로그인(`isNew`) 신호 — **메모리 한정**(모듈 변수).
 * 로그인 → 로비는 SPA 내비게이션이라 리로드가 없어 이 신호로 충분하고,
 * 스토리지를 건드리지 않아 AC-A2(로그인 후 sessionStorage 잔존 0)를 깨지 않는다.
 * 리로드하면 신호는 사라지지만, 그때는 서버 `user.tutorialDone`(발행 예정)이 SoT 가 된다.
 */
let pendingSignal = false;

/** userId 별 완료 키 — 계정 간 격리의 핵심. */
export function tutorialDoneKey(userId: string): string {
  return `${DONE_KEY_PREFIX}${userId}`;
}

/** 스토리지 접근은 항상 방어적으로(사파리 프라이빗·차단 환경에서 throw 한다). */
function read(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    const s = window.localStorage;
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* 저장 실패는 무시 — 튜토리얼이 안 뜨는 것보다 앱이 죽는 게 나쁘다. */
  }
}

/** 로컬 완료 여부. userId 를 모르면(로딩 전) false. */
export function readLocalDone(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return read(tutorialDoneKey(userId)) === "1";
}

export function writeLocalDone(userId: string | null | undefined, done: boolean): void {
  if (!userId) return;
  write(tutorialDoneKey(userId), done ? "1" : null);
}

/** 신규 유저 신호 — 로그인 응답 `isNew` 시 심는다(LoginPage). */
export function markTutorialPending(): void {
  pendingSignal = true;
}

export function readTutorialPending(): boolean {
  return pendingSignal;
}

export function clearTutorialPending(): void {
  pendingSignal = false;
}

/**
 * 완료/건너뛰기 저장 — **유일한 저장 지점**.
 * 지금은 로컬만. 서버 엔드포인트가 나오면 여기서 함께 PATCH 한다(실패해도 로컬은 남긴다).
 */
export function persistTutorialDone(userId: string | null | undefined): void {
  writeLocalDone(userId, true);
  clearTutorialPending();
  // TODO(openapi-v3): await apiFetch("/api/me", { method:"PATCH", body:{ tutorialDone:true } })
}

/** ‘다시 보기’ — 저장된 완료 표시를 지운다(수동 시작은 provider 가 한다). */
export function resetTutorialDone(userId: string | null | undefined): void {
  writeLocalDone(userId, false);
  // TODO(openapi-v3): 서버 필드도 함께 false 로 되돌린다.
}
