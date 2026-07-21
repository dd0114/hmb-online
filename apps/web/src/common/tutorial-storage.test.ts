// @vitest-environment jsdom
/**
 * 튜토리얼 완료 저장 (PRD-v4 §B AC-B1) — **userId 별 격리**와 재노출 0.
 * 서버 필드(user.tutorialDone) 발행 전까지 localStorage 가 폴백 SoT 다(TODO(openapi-v3)).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTutorialPending,
  markTutorialPending,
  persistTutorialDone,
  readLocalDone,
  readTutorialPending,
  resetTutorialDone,
  tutorialDoneKey,
} from "./tutorial-storage";
import { shouldStartTutorial } from "./tutorial-logic";

beforeEach(() => {
  localStorage.clear();
  clearTutorialPending();
});

describe("tutorialDoneKey", () => {
  it("namespaces per user id", () => {
    expect(tutorialDoneKey("u1")).toBe("hmb.tutorial.done.u1");
    expect(tutorialDoneKey("u1")).not.toBe(tutorialDoneKey("u2"));
  });
});

describe("완료 저장", () => {
  it("persist → readLocalDone true, and the pending signal is consumed", () => {
    markTutorialPending();
    expect(readTutorialPending()).toBe(true);

    persistTutorialDone("u1");

    expect(readLocalDone("u1")).toBe(true);
    expect(readTutorialPending()).toBe(false);
    // 신호는 메모리 전용 — 스토리지에는 완료 플래그만 남는다(AC-A2 잔존 검사와 공존).
    expect(sessionStorage.length).toBe(0);
    expect(Object.keys(localStorage)).toEqual([tutorialDoneKey("u1")]);
  });

  it("완료 후 재로그인(=새 pending 없음) 시 다시 시작하지 않는다", () => {
    persistTutorialDone("u1");
    const start = shouldStartTutorial({
      pending: readTutorialPending(),
      localDone: readLocalDone("u1"),
    });
    expect(start).toBe(false);
  });

  it("완료 후 pending 신호가 남아 있어도 재노출하지 않는다", () => {
    persistTutorialDone("u1");
    markTutorialPending(); // 같은 세션에서 다시 로그인해 isNew 가 또 왔다고 가정
    expect(shouldStartTutorial({ pending: true, localDone: readLocalDone("u1") })).toBe(false);
  });

  it("다른 계정과 간섭하지 않는다 (userId 별 격리)", () => {
    persistTutorialDone("u1");
    expect(readLocalDone("u1")).toBe(true);
    expect(readLocalDone("u2")).toBe(false);

    markTutorialPending();
    expect(shouldStartTutorial({ pending: true, localDone: readLocalDone("u2") })).toBe(true);
  });

  it("userId 를 아직 모르면(me 로딩 전) 저장/조회는 no-op", () => {
    persistTutorialDone(null);
    expect(readLocalDone(null)).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});

describe("다시 보기", () => {
  it("resetTutorialDone clears the stored flag for that user only", () => {
    persistTutorialDone("u1");
    persistTutorialDone("u2");

    resetTutorialDone("u1");

    expect(readLocalDone("u1")).toBe(false);
    expect(readLocalDone("u2")).toBe(true);
  });
});

describe("pending 신호", () => {
  it("mark/clear round-trips through sessionStorage", () => {
    expect(readTutorialPending()).toBe(false);
    markTutorialPending();
    expect(readTutorialPending()).toBe(true);
    clearTutorialPending();
    expect(readTutorialPending()).toBe(false);
  });
});
