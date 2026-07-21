import { describe, expect, it } from "vitest";
import type { TradeSlot } from "../api/v2";
import {
  countdownSec,
  formatCountdown,
  formatProbability,
  gradeColor,
  gradeContactLabel,
  slotBadgeLabel,
  slotView,
  speedupButtonState,
  startButtonState,
  waitingCountdownLabel,
  waitingReveal,
} from "./trade-logic";

const baseSlot = (over: Partial<TradeSlot>): TradeSlot => ({
  slot: 1,
  state: "WAITING",
  ...over,
});

describe("slotView", () => {
  it("classifies IDLE / WAITING / RESOLVING by state", () => {
    expect(slotView(baseSlot({ state: "IDLE" }))).toBe("IDLE");
    expect(slotView(baseSlot({ state: "WAITING" }))).toBe("WAITING");
    expect(slotView(baseSlot({ state: "RESOLVING" }))).toBe("RESOLVING");
  });
  it("splits OPEN by offerKind", () => {
    expect(slotView(baseSlot({ state: "OPEN", offerKind: "FA" }))).toBe("OPEN_FA");
    expect(slotView(baseSlot({ state: "OPEN", offerKind: "TRADE" }))).toBe("OPEN_TRADE");
  });
  it("stays IDLE even if stale offer fields linger (#149 안전)", () => {
    const stale = baseSlot({
      state: "IDLE",
      offerKind: "FA",
      target: { playerId: "P1", name: "유령", position: "FW", grade: "GOLD" },
    });
    expect(slotView(stale)).toBe("IDLE");
  });
});

describe("startButtonState (#149 능동 진입)", () => {
  it("IDLE offers [장 시작!]", () => {
    const s = startButtonState("IDLE");
    expect(s.visible).toBe(true);
    expect(s.kind).toBe("start");
    expect(s.label).toBe("장 시작!");
  });
  it("OPEN offers [거래 안함] (= 장 시작을 다시 누른 것과 동일)", () => {
    for (const view of ["OPEN_FA", "OPEN_TRADE"] as const) {
      const s = startButtonState(view);
      expect(s.visible).toBe(true);
      expect(s.kind).toBe("skip");
      expect(s.label).toBe("거래 안함");
    }
  });
  it("hides during WAITING (카운트다운 중 재시작 불가 = 서버 400) and RESOLVING", () => {
    expect(startButtonState("WAITING").visible).toBe(false);
    expect(startButtonState("WAITING").kind).toBeNull();
    expect(startButtonState("RESOLVING").visible).toBe(false);
  });
});

describe("waitingReveal (#149 계약 정밀화)", () => {
  const ref = { playerId: "P1", name: "FA 스트라이커", position: "FW", grade: "DIA" } as const;

  it("MASKED — 아직 한 번도 공개된 적 없는 오퍼(target null)", () => {
    expect(waitingReveal(baseSlot({ state: "WAITING", targetGrade: "GOLD", target: null }))).toBe("MASKED");
    expect(waitingReveal(baseSlot({ state: "WAITING", targetGrade: "GOLD" }))).toBe("MASKED");
  });
  it("REVEALED — 이미 공개됐던 오퍼가 재제안 쿨타임으로 다시 WAITING (target 유지)", () => {
    expect(waitingReveal(baseSlot({ state: "WAITING", targetGrade: "DIA", target: ref }))).toBe("REVEALED");
  });
  it("이미 본 선수를 도로 가리지 않는다 — demand 만 있어도 target 이 있으면 공개", () => {
    const slot = baseSlot({ state: "WAITING", target: ref, demand: { ...ref, playerId: "MINE1", name: "내 수비수" } });
    expect(waitingReveal(slot)).toBe("REVEALED");
  });
});

describe("waitingCountdownLabel", () => {
  it("가려진 대기는 '공개까지', 공개된 채 쿨타임은 '재제안까지'", () => {
    expect(waitingCountdownLabel("MASKED")).toBe("공개까지");
    expect(waitingCountdownLabel("REVEALED")).toBe("재제안까지");
  });
});

describe("slotBadgeLabel", () => {
  it("labels every view (IDLE = 장 닫힘)", () => {
    expect(slotBadgeLabel("IDLE")).toBe("장 닫힘");
    expect(slotBadgeLabel("WAITING")).toBe("접촉 중");
    expect(slotBadgeLabel("OPEN_FA")).toBe("FA 영입");
    expect(slotBadgeLabel("OPEN_TRADE")).toBe("트레이드 제안");
    expect(slotBadgeLabel("RESOLVING")).toBe("처리 중");
  });
});

describe("gradeContactLabel (WAITING 등급만 공개)", () => {
  it("renders the Korean grade label + 접촉 문구", () => {
    expect(gradeContactLabel("GOLD")).toBe("골드 등급 접촉 중");
    expect(gradeContactLabel("LEGEND")).toBe("레전드 등급 접촉 중");
  });
  it("falls back to the raw server string for an unknown grade", () => {
    expect(gradeContactLabel("MYTHIC")).toBe("MYTHIC 등급 접촉 중");
  });
  it("returns null when the server hid the grade (IDLE)", () => {
    expect(gradeContactLabel(null)).toBeNull();
    expect(gradeContactLabel(undefined)).toBeNull();
    expect(gradeContactLabel("")).toBeNull();
  });
});

describe("gradeColor", () => {
  it("reuses the shared grade palette", () => {
    expect(gradeColor("GOLD")).toBe("#f2c744");
    expect(gradeColor("DIA")).toBe("#5ac8e8");
  });
  it("returns a neutral fallback for unknown/absent grades", () => {
    expect(gradeColor("MYTHIC")).toBe("var(--text-muted)");
    expect(gradeColor(null)).toBe("var(--text-muted)");
  });
});

describe("countdownSec", () => {
  it("subtracts local elapsed from the server anchor (drift-immune)", () => {
    expect(countdownSec(120, 0)).toBe(120);
    expect(countdownSec(120, 5_000)).toBe(115);
    expect(countdownSec(120, 5_999)).toBe(115); // floors sub-second elapsed
  });
  it("never goes negative", () => {
    expect(countdownSec(3, 10_000)).toBe(0);
  });
  it("ignores negative elapsed (clock jitter)", () => {
    expect(countdownSec(30, -2_000)).toBe(30);
  });
});

describe("formatCountdown", () => {
  it("formats M:SS", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(600)).toBe("10:00");
  });
  it("formats H:MM:SS past an hour", () => {
    expect(formatCountdown(3661)).toBe("1:01:01");
  });
  it("clamps negatives", () => {
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("formatProbability", () => {
  it("renders a percent from 0..1", () => {
    expect(formatProbability(0.8)).toBe("80%");
    expect(formatProbability(0)).toBe("0%");
    expect(formatProbability(1)).toBe("100%");
  });
  it("returns null when absent (FA has no pre-probability)", () => {
    expect(formatProbability(null)).toBeNull();
    expect(formatProbability(undefined)).toBeNull();
  });
});

describe("speedupButtonState", () => {
  it("enables when loaded, affordable, has cost, not pending", () => {
    const s = speedupButtonState({ loaded: true, points: 500, cost: 200, pending: false });
    expect(s.disabled).toBe(false);
    expect(s.showShort).toBe(false);
  });
  it("shows short + disables when points < cost", () => {
    const s = speedupButtonState({ loaded: true, points: 100, cost: 200, pending: false });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(true);
  });
  it("never shows short before wallet loads (#73)", () => {
    const s = speedupButtonState({ loaded: false, points: 0, cost: 200, pending: false });
    expect(s.showShort).toBe(false);
    expect(s.disabled).toBe(true);
  });
  it("disables (no short) when there is no speedup cost", () => {
    const s = speedupButtonState({ loaded: true, points: 999, cost: null, pending: false });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(false);
  });
  it("disables while pending", () => {
    expect(speedupButtonState({ loaded: true, points: 999, cost: 10, pending: true }).disabled).toBe(true);
  });
});
