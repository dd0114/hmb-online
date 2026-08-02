// @vitest-environment node
/**
 * 성장 행의 두 순수 판정 (#405 W3).
 *
 * ① **출전 구분의 축은 `minutes`** 다 — `xpGained === 0` 은 그 값이 없는 구 정산분 폴백일 뿐이다.
 *    두 축을 섞으면 배율 조합에 따라 "뛰었는데 0 XP" 인 선수가 벤치로 그려진다(거짓).
 * ② **XP 바 임계는 서버가 준 `xpToNext`** 다. 만렙 0 을 나누면 `Infinity%`, 없는 값을 0 으로
 *    때우면 "레벨 시작"이라는 거짓이 뜬다 → 못 그리면 **바 자체를 안 그린다**.
 */
import { describe, expect, it } from "vitest";
import type { RewardGrowthEntry } from "../types";
import { isBench, xpBarPctOf } from "./GrowthSection";

const entry = (over: Partial<RewardGrowthEntry> = {}): RewardGrowthEntry => ({
  playerId: "P001",
  name: "강태산",
  xpGained: 100,
  ...over,
});

describe("isBench — 축은 minutes", () => {
  it("starter · partial 은 출전, bench 는 미투입", () => {
    expect(isBench(entry({ minutes: "starter" }))).toBe(false);
    expect(isBench(entry({ minutes: "partial" }))).toBe(false);
    expect(isBench(entry({ minutes: "bench", xpGained: 0 }))).toBe(true);
  });

  it("⚠️ 0 XP 로 뛴 선수를 벤치로 오독하지 않는다 (minutes 가 이긴다)", () => {
    expect(isBench(entry({ minutes: "starter", xpGained: 0 }))).toBe(false);
  });

  it("minutes 가 없으면(구 정산분) xpGained 로 떨어진다 — 그때 알 수 있는 전부다", () => {
    expect(isBench(entry({ xpGained: 0 }))).toBe(true);
    expect(isBench(entry({ xpGained: 90 }))).toBe(false);
    expect(isBench(entry({ minutes: null, xpGained: 0 }))).toBe(true);
  });
});

describe("xpBarPctOf — 서버가 준 값으로만", () => {
  it("진행도는 cardXp / xpToNext", () => {
    expect(xpBarPctOf(entry({ cardXp: 59, xpToNext: 141 }))).toBeCloseTo(41.84, 1);
    expect(xpBarPctOf(entry({ cardXp: 0, xpToNext: 100 }))).toBe(0);
  });

  it("⚠️ 만렙(xpToNext === 0)은 100% — 나누면 Infinity 다", () => {
    expect(xpBarPctOf(entry({ cardXp: 0, xpToNext: 0 }))).toBe(100);
  });

  it("값이 없으면(W2b 초판 정산분) null — 바를 안 그린다", () => {
    expect(xpBarPctOf(entry())).toBeNull();
    expect(xpBarPctOf(entry({ cardXp: 59 }))).toBeNull();
    expect(xpBarPctOf(entry({ cardXp: null, xpToNext: null }))).toBeNull();
  });

  it("넘치는 값도 0..100 으로 잘린다(서버가 이상해도 막대가 밖으로 나가지 않는다)", () => {
    expect(xpBarPctOf(entry({ cardXp: 500, xpToNext: 100 }))).toBe(100);
    expect(xpBarPctOf(entry({ cardXp: -5, xpToNext: 100 }))).toBe(0);
  });
});
