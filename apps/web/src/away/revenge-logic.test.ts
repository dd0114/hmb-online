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

  it("무제한 센티널(-1)을 '소진'으로 읽지 않는다 (#332)", () => {
    /**
     * ⚠️ 서버는 일일 한도를 끄면(`hmb.away.match.daily-limit: 0`, 롤백 스위치) `remainingToday: -1`
     * 을 준다. 이걸 숫자로 그냥 비교하면 **-1 ≤ 0** 이라 복수 버튼이 전량 잠기고
     * "오늘 원정 횟수를 모두 썼습니다"가 뜬다 — **서버는 실제로 수락하는데** 화면이 기능을 죽인다.
     * 같은 도메인의 `AwayPage` 는 이미 `remainingToday >= 0` 으로 센티널을 걸러 왔다(#286 W5 만 몰랐다).
     */
    const v = revengeView({ entries: [], remainingToday: -1 });
    expect(v.remainingToday, "센티널은 '모른다'와 같게 다룬다 — 숫자로 새 나가면 안 된다").toBeNull();
    expect(v.unlimited).toBe(true);
    // 그리고 그 상태에서 복수는 **열려 있어야** 한다.
    const a = revengeAction(e({}), v.remainingToday);
    expect(a.can).toBe(true);
  });

  it("한도 0 은 여전히 소진이다 — 센티널 처리가 진짜 소진을 덮으면 안 된다 (#332)", () => {
    const v = revengeView({ entries: [], remainingToday: 0 });
    expect(v.remainingToday).toBe(0);
    expect(v.unlimited).toBe(false);
    expect(revengeAction(e({}), v.remainingToday).can).toBe(false);
  });

  it("6건 이상 와도 최근 5건까지만 그린다 (설계 §4.1 조건 ③)", () => {
    /**
     * ⚠️ 슬라이딩 창의 주인은 서버 원장이다 — 여기 상한은 **표시 상한**이지 자물쇠가 아니다.
     * 그래도 계약이 필요한 이유: 서버가 회귀로 전량을 보내면 원정 화면이 복수 목록 벽이 된다.
     * §4.1 은 세 조건을 계약으로 박제한다고 썼는데 ③만 양쪽 어디에도 없었다(독립검증 2R minor-4).
     */
    const many = Array.from({ length: 8 }, (_, i) => e({ reportId: `R${i}` }));
    const v = revengeView({ entries: many, remainingToday: 3 });
    // ⚠️ 기대값은 **리터럴 5** 다. `REVENGE_QUEUE_MAX` 를 import 해 비교하면 상수를 8 로 바꾸는
    // 변이가 그대로 통과한다(이 에픽에서 실제로 당한 tautology — 계약이 앱과 같은 값을 읽었다).
    expect(v.entries).toHaveLength(5);
    // **앞에서** 자른다 — 최신이 앞이므로 뒤에서 자르면 방금 맞은 침공이 사라진다.
    expect(v.entries.at(0)!.reportId).toBe("R0");
    expect(v.entries.at(-1)!.reportId).toBe("R4");
  });
});
