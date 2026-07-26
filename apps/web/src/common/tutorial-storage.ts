/**
 * 튜토리얼 완료 상태 저장 (PRD-v4 §B AC-B1 · #209).
 *
 * **SoT 는 서버다** — `GET /api/me` → `user.tutorialDone` 이 #209 로 실제 발행됐고, 저장은
 * `POST /api/me/tutorial-complete`(멱등, 덱 지급 포함)가 한다. localStorage(userId 별 키)는
 * 남겨 둔 **폴백**이다: 저장 왕복이 실패한 세션에서 튜토리얼이 다시 뜨는 것을 막는다.
 * 읽기 우선순위는 `tutorial-logic.resolveTutorialDone` — 서버 값이 있으면 서버가 이긴다.
 */
import { apiFetch } from "../api/client";
import { TUTORIAL_COMPLETE_PATH, type TutorialCompleteResponse } from "../api/p3";

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
 *
 * #209 로 서버가 SoT 가 됐다: `POST /api/me/tutorial-complete` 가 완료 플래그를 저장하고,
 * **덱이 없으면 이때 지급한다**(멱등 — 몇 번을 불러도 덱은 하나). 로컬 기록은 남겨 둔다 —
 * 네트워크가 실패해도 이번 세션에서 튜토리얼이 다시 뜨지 않게 하는 폴백이다.
 *
 * 반환 프로미스는 호출자(TutorialProvider)가 덱/me 캐시를 무효화하는 데 쓴다. 실패는
 * 삼킨다(null) — 온보딩 마지막 클릭에서 에러 토스트를 띄우는 것이 더 나쁘고, 다음 완료
 * 호출이나 재로그인에서 서버 상태는 어차피 수렴한다.
 */
export function persistTutorialDone(
  userId: string | null | undefined,
): Promise<TutorialCompleteResponse | null> {
  writeLocalDone(userId, true);
  clearTutorialPending();
  return apiFetch<TutorialCompleteResponse>(TUTORIAL_COMPLETE_PATH, { method: "POST", body: {} })
    .catch(() => null);
}

/**
 * ‘다시 보기’ — 저장된 완료 표시를 지운다(수동 시작은 provider 가 한다).
 *
 * ⚠️ **서버 플래그는 되돌리지 않는다**(의도적). 서버의 `tutorial_done` 은 이제 덱 지급의
 * 멱등 축과 같은 흐름에 있어서, 이걸 false 로 되돌리는 API 를 열면 "다시 보기 → 완료"를
 * 반복해 지급 경로를 두드리는 문이 생긴다. 다시 보기는 **이 세션의 화면 동작**이면 충분하다
 * (서버가 done 이어도 provider 의 수동 시작 경로는 이 게이트를 거치지 않는다).
 */
export function resetTutorialDone(userId: string | null | undefined): void {
  writeLocalDone(userId, false);
}
