import { describe, expect, it } from "vitest";
import type { DailyRewardTrack, LeagueResponseP3 } from "../api/p3";
import {
  crestInitials,
  crestSeed,
  isNextSlot,
  pickDailyReward,
  slotState,
  trackProgress,
} from "./daily-reward-logic";

/**
 * 오늘의 보상 트랙 — 순수 판정 계약 (#368).
 *
 * ⚠️ **기대값은 리터럴로 박는다.** 앱과 같은 상수를 import 하면 임계 변이가 통과한다
 * (apps/web/CLAUDE.md "계약이 초록으로 거짓말하는 방식" #2 — #286 W5 에서 실제로 당했다).
 *
 * ⚠️ 이 파일의 **주제는 "클라가 규칙을 다시 만들지 않는가"** 다. 서버가 준 값을 바꿔 넣었을 때
 * 화면 판정이 따라오는지를 본다 — 안 따라오면 클라 어딘가에 규칙이 복제돼 있다는 뜻이다.
 */

function track(over: Partial<DailyRewardTrack> = {}): DailyRewardTrack {
  return {
    day: "2026-07-31",
    slotsPerDay: 4,
    consumed: 2,
    awardedCount: 1,
    earned: 30,
    currency: "GEM",
    slots: [
      { slotNo: 1, currency: "GEM", amount: 30, big: false, state: "WON", opponentName: "Ironclad FC" },
      { slotNo: 2, currency: "GEM", amount: 30, big: false, state: "MISSED", opponentName: "Shadow Wolves" },
      { slotNo: 3, currency: "GEM", amount: 300, big: true, state: "PENDING", opponentName: "Azure Sentinels" },
      { slotNo: 4, currency: "GEM", amount: 30, big: false, state: "PENDING", opponentName: null },
    ],
    next: { slotNo: 3, currency: "GEM", amount: 300, big: true, state: "PENDING", opponentName: "Azure Sentinels" },
    ...over,
  };
}

describe("pickDailyReward — 응답 형태를 믿지 않는다", () => {
  it("정상 응답을 그대로 통과시킨다", () => {
    const picked = pickDailyReward({ dailyReward: track() } as LeagueResponseP3);
    expect(picked?.slots).toHaveLength(4);
    expect(picked?.awardedCount).toBe(1);
    expect(picked?.next?.slotNo).toBe(3);
  });

  it.each([
    ["필드 부재(구 서버)", {}],
    ["null", { dailyReward: null }],
    ["배열이 온 경우", { dailyReward: [] }],
    ["빈 객체(프록시·목)", { dailyReward: {} }],
    ["칸이 0개", { dailyReward: { day: "2026-07-31", slots: [] } }],
    ["응답 자체가 없음", undefined],
  ])("%s 이면 null — 트랙 구역을 통째로 안 그린다", (_label, res) => {
    expect(pickDailyReward(res as LeagueResponseP3 | undefined)).toBeNull();
  });

  it("모양이 깨진 칸만 버리고 나머지는 살린다 — 한 칸 때문에 트랙이 사라지지 않는다", () => {
    const picked = pickDailyReward({
      dailyReward: {
        ...track(),
        slots: [
          { slotNo: 1, currency: "GEM", amount: 30, big: false, state: "WON" },
          { nonsense: true },
          null,
          { slotNo: 2, currency: "GEM", amount: 30, big: false, state: "PENDING" },
        ],
      },
    } as unknown as LeagueResponseP3);
    expect(picked?.slots).toHaveLength(2);
  });
});

describe("규칙은 서버 것이다 — 클라가 다시 만들지 않는다", () => {
  it("대량 칸은 서버의 big 을 따른다 — 칸 번호로 계산하지 않는다", () => {
    // 서버가 "2번이 대량, 3번은 아니다"라고 하면 화면도 그래야 한다.
    // slotNo % 9 / % 3 같은 규칙이 클라에 있으면 이 단언이 죽는다.
    const picked = pickDailyReward({
      dailyReward: {
        ...track(),
        slots: [
          { slotNo: 1, currency: "GEM", amount: 30, big: false, state: "PENDING" },
          { slotNo: 2, currency: "GEM", amount: 999, big: true, state: "PENDING" },
          { slotNo: 3, currency: "GEM", amount: 30, big: false, state: "PENDING" },
        ],
      },
    } as unknown as LeagueResponseP3);
    expect(picked?.slots?.map((s) => s.big)).toEqual([false, true, false]);
    expect(picked?.slots?.[1]?.amount).toBe(999);
  });

  it("재화 코드도 서버 값 그대로 — GEM 을 전제하지 않는다", () => {
    const picked = pickDailyReward({
      dailyReward: {
        ...track(),
        currency: "POINT",
        slots: [{ slotNo: 1, currency: "POINT", amount: 7, big: false, state: "PENDING" }],
      },
    } as unknown as LeagueResponseP3);
    expect(picked?.currency).toBe("POINT");
    expect(picked?.slots?.[0]?.currency).toBe("POINT");
  });

  it("다음 칸 판정은 서버 next.slotNo 하나로만 — consumed+1 을 세지 않는다", () => {
    // consumed 와 next 가 어긋난 응답(서버가 규칙을 바꾼 상태)에서도 next 가 이긴다.
    const t = track({ consumed: 99, next: { slotNo: 2, currency: "GEM", amount: 30, big: false, state: "PENDING" } });
    expect(isNextSlot(t, t.slots![1]!)).toBe(true);
    expect(isNextSlot(t, t.slots![2]!)).toBe(false);
  });

  it("소진 판정은 next 부재다 — consumed >= slotsPerDay 를 세지 않는다", () => {
    expect(trackProgress(track({ next: null })).exhausted).toBe(true);
    // 아직 칸이 남았는데 consumed 가 크게 온 경우에도 next 가 있으면 소진이 아니다.
    expect(trackProgress(track({ consumed: 999 })).exhausted).toBe(false);
  });
});

describe("표시", () => {
  it("진행 표기는 상한으로 자른다 — '19 / 18' 은 화면에서 틀린 말이다", () => {
    expect(trackProgress(track({ consumed: 19, slotsPerDay: 18 }))).toMatchObject({ used: 18, total: 18 });
    expect(trackProgress(track({ consumed: 2, slotsPerDay: 18 }))).toMatchObject({ used: 2, total: 18 });
  });

  it("모르는 state 는 PENDING 으로 넘기지 않고 null — 추측해서 칠하지 않는다", () => {
    expect(slotState({ slotNo: 1, currency: "GEM", amount: 30, big: false, state: "WON" })).toBe("WON");
    expect(slotState({ slotNo: 1, currency: "GEM", amount: 30, big: false, state: "CLAIMED" })).toBeNull();
    expect(slotState(null)).toBeNull();
  });
});

describe("생성 크레스트 — 아트가 없어서 이름에서 만든다", () => {
  it("같은 팀은 항상 같은 시드(결정론)", () => {
    expect(crestSeed("Ironclad FC")).toBe(crestSeed("Ironclad FC"));
    expect(crestSeed("Ironclad FC")).not.toBe(crestSeed("Shadow Wolves"));
  });

  it("이니셜 — 두 단어는 앞 글자 둘, 한 단어는 앞 두 글자", () => {
    expect(crestInitials("Shadow Wolves")).toBe("SW");
    expect(crestInitials("Ironclad")).toBe("IR");
    expect(crestInitials("검은늑대")).toBe("검은");
  });

  it("이름이 없어도 던지지 않는다 — 마크는 장식이라 화면을 죽이면 안 된다", () => {
    expect(crestInitials(null)).toBe("?");
    expect(crestInitials("")).toBe("?");
    expect(crestSeed(undefined)).toBe(0);
  });
});
