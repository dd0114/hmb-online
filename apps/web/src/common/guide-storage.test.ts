// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  guidePending,
  markGuidePending,
  markGuideSeen,
  readGuideSeen,
  resetGuides,
} from "./guide-storage";

/**
 * #493 W2 — 화면별 가이드 진행 상태 (AC4).
 *
 * 계약의 핵심은 **userId 격리**다: 공지 억제 키가 계정 공유되던 기존 결함(notice-logic.ts —
 * 한 기기에서 계정을 바꾸면 다른 계정의 '봤음'이 따라오는)을 이 저장소는 반복하지 않는다.
 */
describe("#493 guide-storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("pending 래치 — 온보딩을 끝낸 계정에만 선다", () => {
    expect(guidePending("u1")).toBe(false);
    markGuidePending("u1");
    expect(guidePending("u1")).toBe(true);
    // userId 격리: 같은 기기의 다른 계정은 래치가 없다.
    expect(guidePending("u2")).toBe(false);
  });

  it("seen 은 화면 단위로 쌓이고 계정별로 격리된다", () => {
    markGuideSeen("u1", "/game");
    markGuideSeen("u1", "/recruit");
    expect([...readGuideSeen("u1")].sort()).toEqual(["/game", "/recruit"]);
    expect(readGuideSeen("u2").size).toBe(0);
  });

  it("중복 mark 는 한 번만 남는다", () => {
    markGuideSeen("u1", "/game");
    markGuideSeen("u1", "/game");
    expect(readGuideSeen("u1").size).toBe(1);
  });

  it("resetGuides = seen 을 비우고 pending 을 다시 세운다(다시 보기)", () => {
    markGuidePending("u1");
    markGuideSeen("u1", "/game");
    resetGuides("u1");
    expect(readGuideSeen("u1").size).toBe(0);
    expect(guidePending("u1")).toBe(true);
    // 다른 계정의 seen 은 건드리지 않는다.
    markGuideSeen("u2", "/me");
    resetGuides("u1");
    expect(readGuideSeen("u2").size).toBe(1);
  });

  it("userId 없음(null) = 전부 no-op / false — 익명 상태에서 키가 생기지 않는다", () => {
    markGuidePending(null);
    markGuideSeen(null, "/game");
    expect(guidePending(null)).toBe(false);
    expect(readGuideSeen(null).size).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it("손상 저장값은 빈 집합으로 읽힌다(throw 0)", () => {
    window.localStorage.setItem("hmb.guide.seen.u1", "{not json");
    expect(readGuideSeen("u1").size).toBe(0);
  });
});
