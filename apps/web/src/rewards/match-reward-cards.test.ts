/**
 * **경기 종료 보상 카드 순서** 계약 (#456 S4 · B3 AC2).
 *
 * 이 파일이 지키는 것은 **무엇이 몇 장 나오는가**뿐이다 — 그리는 일은 `MatchRewardFlow` 가 한다.
 * 판정을 순수 모듈로 뽑아 둔 이유는 두 가지다:
 *  · 모드별 분기는 **부재가 정상 상태**인 경우가 많다(구 서버·연습·트랙 소진). "안 그린다"는
 *    e2e 로는 공허한 `toHaveCount(0)` 이 되기 쉽다(apps/web CLAUDE.md 표 #6).
 *  · 금액은 **서버 값 그대로** 흘러야 한다(#232 · hero "예 30잼" 은 economy 값이지 코드 상수가
 *    아니다). 여기서 입력≠기대값인 표본을 태워 하드코딩이 통과할 수 없게 만든다.
 */
import { describe, expect, it } from "vitest";
import { matchDailyRewardOf, matchRewardCards } from "./match-reward-cards";

const GOLD = [{ code: "POINT", amount: 1200 }];
/** economy 실값(`data/players/economy.v3.json` league.dailyReward.small = 30)을 그대로 옮긴 표본. */
const DAILY = { slotNo: 3, currency: "GEM", amount: 30, result: "WIN", awarded: true };

describe("카드 순서 — 골드 → 모드별", () => {
  it("리그: 재화 카드 다음이 오늘의 보상 칸이다", () => {
    const cards = matchRewardCards({
      mode: "league",
      currencies: GOLD,
      dailyReward: DAILY,
      rating: 1200,
    });
    expect(cards.map((c) => c.id)).toEqual(["currency", "daily"]);
  });

  it("원정: 재화 카드 다음이 레이팅이다", () => {
    const cards = matchRewardCards({
      mode: "away",
      currencies: GOLD,
      dailyReward: null,
      rating: 1043,
    });
    expect(cards.map((c) => c.id)).toEqual(["currency", "rating"]);
    expect(cards[1]).toMatchObject({ id: "rating", rating: 1043 });
  });

  it("연습: 두 번째 카드가 없다(재화 한 장으로 끝난다)", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: GOLD,
      dailyReward: DAILY,
      rating: 1200,
    });
    expect(cards.map((c) => c.id)).toEqual(["currency"]);
  });

  it("모드를 모르면 두 번째 카드를 추측하지 않는다(구 서버·응답 결손)", () => {
    // ⚠️ 리그로 추측하면 연습 경기 뒤에 남의 트랙 칸이 뜬다(ResultPanel 의 CTA 규율과 같은 축).
    const cards = matchRewardCards({
      mode: undefined,
      currencies: GOLD,
      dailyReward: DAILY,
      rating: 1200,
    });
    expect(cards.map((c) => c.id)).toEqual(["currency"]);
  });
});

describe("없는 것을 지어내지 않는다", () => {
  it("봉투에 재화가 없으면 재화 카드가 없다(W2b 이전 매치·봉투 생성 실패)", () => {
    const cards = matchRewardCards({ mode: "league", currencies: [], dailyReward: DAILY, rating: 0 });
    expect(cards.map((c) => c.id)).toEqual(["daily"]);
  });

  it("아무것도 없으면 카드가 0장이다(= 흐름이 그대로 결과 화면으로 간다)", () => {
    expect(
      matchRewardCards({ mode: "practice", currencies: [], dailyReward: null, rating: null }),
    ).toEqual([]);
  });

  it("리그인데 칸 정보가 안 오면 칸 카드가 없다", () => {
    const cards = matchRewardCards({ mode: "league", currencies: GOLD, dailyReward: null, rating: 0 });
    expect(cards.map((c) => c.id)).toEqual(["currency"]);
  });

  it("원정인데 레이팅 축이 없는 구 서버면 레이팅 카드가 없다", () => {
    // ⚠️ `MeResponse.rating` 은 #245 additive 라 optional 이다. `?? 0` 으로 채우면 **없는 사실**을
    //    단언하게 된다(#286 W5 의 `?? 18` 폴백 금지와 같은 규율).
    const cards = matchRewardCards({
      mode: "away",
      currencies: GOLD,
      dailyReward: null,
      rating: undefined,
    });
    expect(cards.map((c) => c.id)).toEqual(["currency"]);
  });

  it("레이팅 0 은 유효한 값이다(falsy 함정)", () => {
    const cards = matchRewardCards({ mode: "away", currencies: [], dailyReward: null, rating: 0 });
    expect(cards).toEqual([{ id: "rating", rating: 0 }]);
  });
});

describe("금액은 서버 값이다 — 클라가 만들지 않는다 (#232)", () => {
  it.each([
    ["small 칸", 30],
    ["big 칸", 300],
    ["운영이 노브를 돌린 값", 137],
  ])("%s: %i 이 그대로 카드에 실린다", (_label, amount) => {
    const cards = matchRewardCards({
      mode: "league",
      currencies: [],
      dailyReward: { ...DAILY, amount },
      rating: null,
    });
    expect(cards[0]).toMatchObject({ id: "daily", currency: "GEM", amount });
  });

  it("재화 줄도 봉투 값 그대로다(코드·수량 둘 다)", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: [{ code: "POINT", amount: 4321 }, { code: "GEM", amount: 7 }],
      dailyReward: null,
      rating: null,
    });
    expect(cards[0]).toEqual({ id: "currency", entries: [{ code: "POINT", amount: 4321 }, { code: "GEM", amount: 7 }] });
  });
});

describe("칸이 소비된 사실은 값이 0이거나 소멸이어도 말한다 (#368 규율)", () => {
  it("진 경기(소멸)도 카드로 남는다", () => {
    const cards = matchRewardCards({
      mode: "league",
      currencies: [],
      dailyReward: { ...DAILY, result: "LOSS", awarded: false },
      rating: null,
    });
    expect(cards[0]).toMatchObject({ id: "daily", awarded: false, amount: 30 });
  });

  it("트랙을 다 쓴 뒤(amount 0)도 카드로 남는다", () => {
    const cards = matchRewardCards({
      mode: "league",
      currencies: [],
      dailyReward: { ...DAILY, slotNo: 19, amount: 0, awarded: false },
      rating: null,
    });
    expect(cards[0]).toMatchObject({ id: "daily", amount: 0 });
  });
});

/* ───────────────────────────────────────────────────────────────────────────────────────────
 * AC3 — 선수별 카드 (#456 S4-W2)
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

const choice = (choiceId: string, playerId: string, level = 4) => ({
  choiceId,
  playerId,
  level,
  candidates: [{ stat: "pace", gain: 1 }],
});
const growthRow = (playerId: string, name: string) => ({ playerId, name, xpGained: 100 });

describe("선수별 카드 — 모드별 카드 **뒤에**, 받은 순서 그대로", () => {
  it("리그: 골드 → 칸 → 선수 2명", () => {
    const cards = matchRewardCards({
      mode: "league",
      currencies: GOLD,
      dailyReward: DAILY,
      rating: 1200,
      choices: [choice("c1", "P001"), choice("c2", "P002")],
      growth: [growthRow("P001", "김수비"), growthRow("P002", "박미드")],
    });
    expect(cards.map((c) => c.id)).toEqual(["currency", "daily", "choice", "choice"]);
    expect(cards[2]).toMatchObject({ id: "choice", choice: { choiceId: "c1", playerId: "P001" } });
    // 그 선수의 성장 행이 같이 실린다 — 이름·등급·포지션의 출처다(안 실으면 카드가 id 만 안다).
    expect(cards[2]).toMatchObject({ player: { playerId: "P001", name: "김수비" } });
    expect(cards[3]).toMatchObject({ player: { playerId: "P002", name: "박미드" } });
  });

  it("🚨 순서를 다시 정하지 않는다 — 받은 순서가 곧 화면 순서다", () => {
    // 서버가 성장 행 순서로 내려 준다. 여기서 정렬하면 결과 화면 성장 목록과 순서가 갈린다.
    const cards = matchRewardCards({
      mode: "practice",
      currencies: [],
      dailyReward: null,
      rating: null,
      choices: [choice("cZ", "P900", 9), choice("cA", "P001", 2)],
      growth: [],
    });
    expect(cards.map((c) => (c.id === "choice" ? c.choice.choiceId : c.id))).toEqual(["cZ", "cA"]);
  });

  it("연습이어도 선수 카드는 선다 — 레벨업은 모드와 무관하다", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: [],
      dailyReward: DAILY,
      rating: 1200,
      choices: [choice("c1", "P001")],
      growth: [growthRow("P001", "김수비")],
    });
    expect(cards.map((c) => c.id)).toEqual(["choice"]);
  });

  it("성장 행이 없는 선수도 카드가 선다 — `player: null`(이름·등급을 지어내지 않는다)", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: [],
      dailyReward: null,
      rating: null,
      choices: [choice("c1", "P404")],
      growth: [growthRow("P001", "김수비")],
    });
    expect(cards[0]).toMatchObject({ id: "choice", player: null });
  });

  it("선택권이 없으면 선수 카드가 없다(빈 장을 만들지 않는다)", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: GOLD,
      dailyReward: null,
      rating: null,
      choices: [],
      growth: [growthRow("P001", "김수비")],
    });
    expect(cards.map((c) => c.id)).toEqual(["currency"]);
  });

  it("모양이 아닌 항목은 카드가 되지 않는다(구 서버·손상 응답)", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: [],
      dailyReward: null,
      rating: null,
      choices: [
        null as never,
        { choiceId: "c1" } as never, // playerId 없음
        choice("c2", "P002"),
      ],
      growth: [],
    });
    expect(cards.map((c) => (c.id === "choice" ? c.choice.choiceId : c.id))).toEqual(["c2"]);
  });

  it("`choices` 를 안 넘기면(구 호출부) 선수 카드가 0장이다", () => {
    const cards = matchRewardCards({
      mode: "practice",
      currencies: GOLD,
      dailyReward: null,
      rating: null,
    });
    expect(cards.map((c) => c.id)).toEqual(["currency"]);
  });
});

describe("matchDailyRewardOf — 응답 형태를 믿지 않는다", () => {
  it("정상 블록을 꺼낸다", () => {
    expect(matchDailyRewardOf({ dailyReward: DAILY })).toEqual(DAILY);
  });

  it.each([
    ["응답 자체가 없음", undefined],
    ["null", null],
    ["빈 객체(프록시·목)", {}],
    ["dailyReward: null(리그가 아닌 경기)", { dailyReward: null }],
    ["배열이 온 경우", { dailyReward: [] }],
    ["slotNo 가 숫자가 아님", { dailyReward: { ...DAILY, slotNo: "3" } }],
  ])("%s → null", (_label, result) => {
    expect(matchDailyRewardOf(result)).toBeNull();
  });
});
