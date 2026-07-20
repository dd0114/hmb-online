/**
 * 튜토리얼 순수 로직 (PRD-v4 §B, AC-B1/AC-B2):
 * 시작 판정(서버 우선 · 재노출 0) · 대상 부재/화면 밖 스킵 · 말풍선 배치(오버플로 0, 대상 지시).
 */
import { describe, expect, it } from "vitest";
import {
  computeBubbleLayout,
  enabledSteps,
  isTargetUsable,
  resolveTutorialDone,
  shouldStartTutorial,
} from "./tutorial-logic";
import { TUTORIAL_STEPS } from "./tutorial-steps";

const VP = { width: 390, height: 844 };

describe("enabledSteps", () => {
  it("drops disabled stubs (deck step waits for #106)", () => {
    const ids = enabledSteps(TUTORIAL_STEPS).map((s) => s.id);
    expect(ids).not.toContain("deck");
    expect(ids.length).toBeGreaterThan(0);
  });

  it("every runnable step points at a target testid", () => {
    for (const step of enabledSteps(TUTORIAL_STEPS)) {
      expect(step.targetTestId).toMatch(/\S/);
      expect(step.title).toMatch(/\S/);
    }
  });
});

describe("isTargetUsable — 부재/화면 밖이면 스킵", () => {
  it("missing target is not usable", () => {
    expect(isTargetUsable(null, VP)).toBe(false);
  });

  it("zero-size target (display:none) is not usable", () => {
    expect(isTargetUsable({ left: 10, top: 10, width: 0, height: 0 }, VP)).toBe(false);
  });

  it("fully off-screen targets are not usable (above / below / left / right)", () => {
    expect(isTargetUsable({ left: 10, top: -60, width: 100, height: 40 }, VP)).toBe(false);
    expect(isTargetUsable({ left: 10, top: 900, width: 100, height: 40 }, VP)).toBe(false);
    expect(isTargetUsable({ left: -120, top: 10, width: 100, height: 40 }, VP)).toBe(false);
    expect(isTargetUsable({ left: 400, top: 10, width: 100, height: 40 }, VP)).toBe(false);
  });

  it("partially visible target is usable", () => {
    expect(isTargetUsable({ left: -10, top: 800, width: 100, height: 60 }, VP)).toBe(true);
  });
});

describe("computeBubbleLayout (AC-B2)", () => {
  const bubble = { width: 320, height: 150 };

  it("places the bubble below the target when there is room", () => {
    const l = computeBubbleLayout({ left: 100, top: 100, width: 120, height: 48 }, VP, bubble);
    expect(l.placement).toBe("below");
    expect(l.top).toBeGreaterThan(148); // 대상 아래
  });

  it("flips above when the target sits near the bottom", () => {
    const l = computeBubbleLayout({ left: 100, top: 800, width: 120, height: 40 }, VP, bubble);
    expect(l.placement).toBe("above");
    expect(l.top + bubble.height).toBeLessThanOrEqual(800);
  });

  it("never overflows the viewport horizontally, even for edge targets", () => {
    const margin = 8;
    for (const target of [
      { left: 0, top: 200, width: 40, height: 40 },
      { left: 350, top: 200, width: 40, height: 40 },
      { left: 180, top: 200, width: 30, height: 30 },
    ]) {
      const l = computeBubbleLayout(target, VP, bubble);
      expect(l.left).toBeGreaterThanOrEqual(margin);
      expect(l.left + bubble.width).toBeLessThanOrEqual(VP.width - margin);
    }
  });

  it("keeps the bubble inside vertically as well", () => {
    const l = computeBubbleLayout({ left: 10, top: 0, width: 40, height: 10 }, VP, bubble);
    expect(l.top).toBeGreaterThanOrEqual(8);
    expect(l.top + bubble.height).toBeLessThanOrEqual(VP.height - 8);
  });

  it("arrow tracks the target centre and stays within the bubble", () => {
    const centred = computeBubbleLayout({ left: 155, top: 200, width: 80, height: 40 }, VP, bubble);
    // 대상 중심(195) - 말풍선 좌측 = 화살표 위치.
    expect(centred.arrowLeft).toBeCloseTo(195 - centred.left, 5);

    const edge = computeBubbleLayout({ left: 0, top: 200, width: 24, height: 24 }, VP, bubble);
    expect(edge.arrowLeft).toBeGreaterThanOrEqual(0);
    expect(edge.arrowLeft).toBeLessThanOrEqual(bubble.width);
  });

  it("desktop viewport keeps the same guarantees", () => {
    const wide = { width: 1280, height: 800 };
    const l = computeBubbleLayout({ left: 1240, top: 700, width: 40, height: 40 }, wide, bubble);
    expect(l.left + bubble.width).toBeLessThanOrEqual(wide.width - 8);
    expect(l.top).toBeGreaterThanOrEqual(8);
  });
});

describe("resolveTutorialDone — 완료 기록은 어느 쪽이든 존중한다", () => {
  it("서버 true 는 로컬 무기록이어도 완료로 본다", () => {
    expect(resolveTutorialDone({ serverDone: true, localDone: false })).toBe(true);
  });

  it("서버 false 는 로컬 완료를 덮지 않는다 (PATCH 부재 — 서버는 로컬 완료 사실을 모른다)", () => {
    // 덮으면 이미 끝낸 유저 전원에게 재노출된다.
    expect(resolveTutorialDone({ serverDone: false, localDone: true })).toBe(true);
  });

  it("falls back to local when the server has not published the field yet", () => {
    expect(resolveTutorialDone({ serverDone: undefined, localDone: true })).toBe(true);
    expect(resolveTutorialDone({ serverDone: null, localDone: false })).toBe(false);
  });
});

describe("shouldStartTutorial (AC-B1)", () => {
  it("starts for a new user (isNew signal) who has not finished", () => {
    expect(shouldStartTutorial({ pending: true, localDone: false })).toBe(true);
  });

  it("does not start again after completion — even with the isNew signal still around", () => {
    expect(shouldStartTutorial({ pending: true, localDone: true })).toBe(false);
  });

  it("does not start for a returning user with no signal (재로그인 미노출)", () => {
    expect(shouldStartTutorial({ pending: false, localDone: false })).toBe(false);
    expect(shouldStartTutorial({ pending: false, localDone: true })).toBe(false);
  });

  it("starts when the server explicitly says tutorialDone=false", () => {
    expect(shouldStartTutorial({ pending: false, localDone: false, serverDone: false })).toBe(true);
  });

  it("서버 false 라도 로컬에 완료 기록이 있으면 시작하지 않는다 (재노출 0)", () => {
    expect(shouldStartTutorial({ pending: false, localDone: true, serverDone: false })).toBe(false);
    expect(shouldStartTutorial({ pending: true, localDone: true, serverDone: false })).toBe(false);
  });

  it("기존 유저 무회귀: 서버 필드 미발행 + isNew 아님 + 로컬 무기록 → 미노출", () => {
    expect(shouldStartTutorial({ pending: false, localDone: false, serverDone: undefined })).toBe(
      false,
    );
  });

  it("server tutorialDone=true wins over a stale local/pending state", () => {
    expect(shouldStartTutorial({ pending: true, localDone: false, serverDone: true })).toBe(false);
  });
});
