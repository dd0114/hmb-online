import { describe, expect, it } from "vitest";
import type { RevengeEntry } from "../api/hooks-p286";
import { revengeAction, revengeSummary, revengeView } from "./revenge-logic";

/**
 * #286 W5 — 복수 규칙 **유닛 계약**(설계 §4.3).
 *
 * ⚠️ 처음엔 이 규칙들이 **브라우저 e2e 에만** 얹혀 있었고, 그 픽스처가 "방어 성공"과 "이미 갚음"을
 * 한 행에 뭉개는 바람에 **hero 확정 ④(방어 성공분 복수 불가)가 통째로 빠진 것을 아무도 못 봤다**
 * (독립검증 BL-1). 규칙 하나당 표본 하나 — 그게 이 파일이 있는 이유다.
 */

const base: RevengeEntry = {
  reportId: "R1",
  opponent: { userId: "u1", nickname: "FC 상대", rating: 1200 },
  attackedAt: "2026-07-29T03:12:00Z",
  theirScore: 3,
  myScore: 1,
  defenceResult: "LOSS",
  ratingDelta: -10,
  attemptsUsed: 0,
  attemptsMax: 2,
  state: "AVAILABLE",
};
const e = (over: Partial<RevengeEntry>): RevengeEntry => ({ ...base, ...over });

describe("revengeAction — 설계 §4.3 규칙표", () => {
  it("졌으면 복수할 수 있다", () => {
    const a = revengeAction(e({ defenceResult: "LOSS" }), 4);
    expect(a.can).toBe(true);
  });

  it("비겼어도 복수할 수 있다 — hero 확정 ①(무승부도 침공)", () => {
    expect(revengeAction(e({ defenceResult: "DRAW" }), 4).can).toBe(true);
  });

  it("**방어에 성공했으면 복수할 수 없다** — hero 확정 ④", () => {
    // ⚠️ 이게 빠지면 이미 이긴 상대에게 지목 원정 2판이 더 생긴다 = V22 가 닫은 어뷰징 경로가
    // hero 가 정한 것보다 넓게 열린다. 1차 구현에서 실제로 빠져 있었다(BL-1).
    const a = revengeAction(e({ defenceResult: "WIN" }), 4);
    expect(a.can).toBe(false);
    expect(a.label).toBe("방어함");
  });

  it("방어 성공은 다른 어떤 조건보다 먼저다 — 시도 여력이 남아도 잠긴다", () => {
    const a = revengeAction(e({ defenceResult: "WIN", attemptsUsed: 0, state: "AVAILABLE" }), 99);
    expect(a.can).toBe(false);
  });

  it("이미 갚았으면 못 한다 — hero 확정: 복수의 복수는 없다", () => {
    const a = revengeAction(e({ state: "AVENGED" }), 4);
    expect(a.can).toBe(false);
    expect(a.label).toBe("복수함");
  });

  it("2회 소진이면 못 한다", () => {
    const a = revengeAction(e({ attemptsUsed: 2, attemptsMax: 2 }), 4);
    expect(a.can).toBe(false);
    expect(a.reason).toContain("2회");
  });

  it("일일 원정 횟수를 다 쓰면 잠긴다 — hero 확정 ②(판수 공유)", () => {
    // ⚠️ 복수만 따로 세면 "비기는 한 무한 재도전"이 열린다(§4.3 각주).
    expect(revengeAction(e({}), 0).can).toBe(false);
  });

  it("남은 횟수를 **모르면** 막지 않는다 — 서버가 안 준 값으로 유저를 세우지 않는다", () => {
    expect(revengeAction(e({}), null).can).toBe(true);
  });

  it("1회 쓴 뒤에는 남은 횟수를 라벨에 말한다", () => {
    expect(revengeAction(e({ attemptsUsed: 1 }), 4).label).toContain("1회 남음");
  });
});

describe("revengeSummary — 점수는 수비자(나) 관점", () => {
  it("내 점수가 앞이다", () => {
    // 뒤집히면 유저가 자기가 이긴 경기를 진 것으로 읽는다.
    expect(revengeSummary(e({ myScore: 1, theirScore: 3 }))).toContain("1 : 3");
  });

  it("방어 성공은 '막아냄'으로 말한다", () => {
    expect(revengeSummary(e({ defenceResult: "WIN", myScore: 4, theirScore: 0 }))).toContain("막아냄");
  });

  it("레이팅 변동이 0 이면 그 조각을 붙이지 않는다", () => {
    expect(revengeSummary(e({ ratingDelta: 0 }))).not.toContain("레이팅");
  });
});

describe("revengeView — 응답 형태를 믿지 않는다", () => {
  it("200 {} 도 빈 목록으로 떨어진다", () => {
    expect(revengeView({} as never).usable).toBe(false);
  });

  it("entries 가 배열이 아니면 무시한다", () => {
    expect(revengeView({ entries: "nope" } as never).entries).toEqual([]);
  });

  it("remainingToday 를 모르면 null — 0 으로 읽지 않는다", () => {
    // 0 으로 읽으면 **모든 복수 버튼이 잠긴다**(= 기능이 통째로 죽는다).
    expect(revengeView({ entries: [] } as never).remainingToday).toBeNull();
  });
});
