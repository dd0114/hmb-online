// @vitest-environment jsdom
/**
 * 튜토리얼 완료 저장 (PRD-v4 §B AC-B1 · #209) — **userId 별 격리**와 재노출 0,
 * 그리고 저장이 서버(POST /api/me/tutorial-complete)까지 간다는 것. 서버가 SoT 이고
 * localStorage 는 왕복이 실패한 세션을 위한 폴백이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  clearTutorialPending();
  fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ tutorialDone: true, deckGranted: true, deck: null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("서버 저장 (#209)", () => {
  it("완료 저장이 POST /api/me/tutorial-complete 를 친다 — 덱 지급의 트리거", async () => {
    const res = await persistTutorialDone("u1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain("/api/me/tutorial-complete");
    expect(init.method).toBe("POST");
    expect(res).toEqual({ tutorialDone: true, deckGranted: true, deck: null });
  });

  it("서버 왕복이 실패해도 로컬 폴백은 남고 예외를 던지지 않는다", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    await expect(persistTutorialDone("u1")).resolves.toBeNull();
    expect(readLocalDone("u1")).toBe(true);
  });

  it("다시 보기는 서버 플래그를 되돌리지 않는다 — 지급 경로를 두드릴 문을 만들지 않는다", () => {
    resetTutorialDone("u1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLocalDone("u1")).toBe(false);
  });
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
