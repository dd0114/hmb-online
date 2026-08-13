/**
 * `/event-board` 순수 로직 계약 (#492 AC5).
 *
 * 렌더·네트워크 없이 **필터→쿼리스트링 · props 요약 · 퍼널 파생 · 페이저**만 박제한다.
 * 여기 있는 단언들이 곧 "화면이 서버 계약(§Plan D3)을 어떻게 읽기로 했나"의 정본이다.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_FILTER,
  EVENT_LIMIT_MAX,
  EVENT_PAGE_SIZE,
  EVENT_TYPES,
  FUNNEL_STAGES,
  asList,
  eventLabel,
  eventQuery,
  formatPropValue,
  funnelRows,
  furthestLabel,
  furthestStage,
  isKnownEvent,
  modeOf,
  pagerView,
  reachedCount,
  setEventFilterEvent,
  setEventFilterOffset,
  setEventFilterUser,
  summarizeProps,
  userOptions,
} from "./event-board-logic";
import type { FunnelResponse } from "./event-board-logic";

describe("이벤트 7종 (#492 D1)", () => {
  it("종류가 정확히 7개이고 계약에 적힌 이름 그대로다", () => {
    // 이름이 하나라도 어긋나면 서버 필터가 400 을 돌려주거나 조용히 0건이 된다.
    expect([...EVENT_TYPES]).toEqual([
      "user_signup",
      "tutorial_complete",
      "deck_save",
      "gacha_pull",
      "match_start",
      "match_finish",
      "league_season_start",
    ]);
  });

  it("모르는 이벤트명은 라벨 대신 원문을 쓴다 — 화면에서 사라지지 않게", () => {
    expect(eventLabel("match_finish")).toBe("경기 종료");
    expect(eventLabel("brand_new_event")).toBe("brand_new_event");
    expect(isKnownEvent("brand_new_event")).toBe(false);
    expect(isKnownEvent("gacha_pull")).toBe(true);
  });

  it("퍼널 단계는 계약의 reached 키 7개와 순서까지 같다", () => {
    expect([...FUNNEL_STAGES]).toEqual([
      "signup",
      "tutorial",
      "deck",
      "gacha",
      "practice",
      "league",
      "away",
    ]);
  });
});

describe("eventQuery — 필터 → 쿼리스트링", () => {
  it("빈 필터는 event/userId 를 아예 보내지 않는다 (빈 event = 400 위험)", () => {
    expect(eventQuery(DEFAULT_EVENT_FILTER)).toBe("?limit=50&offset=0");
    expect(eventQuery({ ...DEFAULT_EVENT_FILTER, userId: "   " })).toBe("?limit=50&offset=0");
  });

  it("종류·유저·페이지를 키 순서 고정으로 직렬화한다", () => {
    expect(
      eventQuery({ event: "match_finish", userId: "u1", limit: 50, offset: 100 }),
    ).toBe("?event=match_finish&userId=u1&limit=50&offset=100");
  });

  it("userId 는 URL 인코딩되고 앞뒤 공백은 잘린다", () => {
    expect(eventQuery({ ...DEFAULT_EVENT_FILTER, userId: " a b&c " })).toBe(
      "?userId=a+b%26c&limit=50&offset=0",
    );
  });

  it("limit 은 1..200 으로 클램프한다 (서버 상한 초과 요청 방지)", () => {
    expect(eventQuery({ ...DEFAULT_EVENT_FILTER, limit: 9999 })).toContain(
      `limit=${EVENT_LIMIT_MAX}`,
    );
    expect(eventQuery({ ...DEFAULT_EVENT_FILTER, limit: 0 })).toContain("limit=1");
    expect(eventQuery({ ...DEFAULT_EVENT_FILTER, limit: Number.NaN })).toContain(
      `limit=${EVENT_PAGE_SIZE}`,
    );
  });

  it("음수 offset 은 0", () => {
    expect(eventQuery({ ...DEFAULT_EVENT_FILTER, offset: -30 })).toContain("offset=0");
  });

  it("같은 입력은 같은 문자열 — 캐시 키로 써도 되는 결정론", () => {
    const f = { event: "gacha_pull", userId: "u9", limit: 50, offset: 50 } as const;
    expect(eventQuery(f)).toBe(eventQuery(f));
  });
});

describe("필터 전이 — 조건이 바뀌면 페이지를 처음으로", () => {
  it("종류를 바꾸면 offset 이 0 으로 리셋된다", () => {
    const at3rd = { ...DEFAULT_EVENT_FILTER, offset: 100 };
    // 리셋하지 않으면 결과가 3건인데 100번째부터 보여 달라고 해서 **빈 화면**이 뜬다.
    expect(setEventFilterEvent(at3rd, "deck_save")).toEqual({
      event: "deck_save",
      userId: "",
      limit: 50,
      offset: 0,
    });
  });

  it("유저를 바꿔도 리셋된다 (퍼널 행 클릭이 타는 경로)", () => {
    const at3rd = { ...DEFAULT_EVENT_FILTER, offset: 100, event: "match_start" as const };
    const next = setEventFilterUser(at3rd, "u7");
    expect(next.userId).toBe("u7");
    expect(next.offset).toBe(0);
    // 종류 필터는 유지된다 — 유저를 고른다고 종류 선택을 뺏지 않는다.
    expect(next.event).toBe("match_start");
  });

  it("offset 은 음수/비정수를 0 으로 정규화", () => {
    expect(setEventFilterOffset(DEFAULT_EVENT_FILTER, -5).offset).toBe(0);
    expect(setEventFilterOffset(DEFAULT_EVENT_FILTER, 50).offset).toBe(50);
  });
});

describe("pagerView — 서버 total 을 믿고 계산한다", () => {
  it("첫 페이지", () => {
    const p = pagerView(137, 50, 0, 50);
    expect(p).toMatchObject({ page: 1, pages: 3, canPrev: false, canNext: true, nextOffset: 50 });
    expect(p.rangeLabel).toBe("1–50 / 137");
  });

  it("마지막 페이지 — canNext 는 items 길이가 아니라 total 로 판정한다", () => {
    // items 길이로 판단하면 마지막 페이지가 정확히 꽉 찼을 때 빈 페이지로 넘어간다.
    const exact = pagerView(100, 50, 50, 50);
    expect(exact.canNext).toBe(false);
    expect(exact.page).toBe(2);
    expect(exact.rangeLabel).toBe("51–100 / 100");

    const partial = pagerView(137, 50, 100, 37);
    expect(partial.canNext).toBe(false);
    expect(partial.rangeLabel).toBe("101–137 / 137");
  });

  it("0건이면 1/1 페이지 · 0/0 범위 (표가 사라지지 않는다)", () => {
    const p = pagerView(0, 50, 0, 0);
    expect(p).toMatchObject({ page: 1, pages: 1, canPrev: false, canNext: false });
    expect(p.rangeLabel).toBe("0 / 0");
  });

  it("이전 offset 은 0 밑으로 내려가지 않는다", () => {
    expect(pagerView(137, 50, 50, 50).prevOffset).toBe(0);
    expect(pagerView(137, 50, 100, 37).prevOffset).toBe(50);
  });
});

describe("summarizeProps — 표 셀 한 줄 요약", () => {
  it("match_finish 는 mode·result·스코어 순서로 읽힌다 (서버 키 순서와 무관)", () => {
    // 키를 일부러 뒤섞어 넣는다 — 서버 JSON 순서에 기대면 행마다 순서가 달라져 비교가 안 된다.
    const s = summarizeProps({
      goalsAgainst: 1,
      result: "WIN",
      goalsFor: 3,
      mode: "practice",
      matchId: "M1",
      pointsAwarded: 30,
    });
    expect(s.startsWith("mode=practice · result=WIN · goalsFor=3 · goalsAgainst=1")).toBe(true);
    // 5개 이상은 잘리고 남은 개수가 붙는다.
    expect(s).toContain("+2");
  });

  it("배열은 슬래시로 편다 (뽑기 등급)", () => {
    expect(summarizeProps({ grades: ["SILVER", "GOLD"] }, 1)).toBe("grades=SILVER/GOLD");
    expect(formatPropValue(["A", "B"])).toBe("A/B");
    expect(formatPropValue(null)).toBe("-");
    expect(formatPropValue(true)).toBe("true");
    expect(formatPropValue({ a: 1 })).toBe('{"a":1}');
  });

  it("빈 값 키는 빼고, props 자체가 비면 빈 문자열", () => {
    expect(summarizeProps({ a: 1, b: null, c: "", d: undefined })).toBe("a=1");
    expect(summarizeProps({})).toBe("");
    expect(summarizeProps(null)).toBe("");
    expect(summarizeProps(undefined)).toBe("");
    expect(summarizeProps([1, 2])).toBe("");
  });

  it("우선순위 밖 키는 뒤에 사전순 — 새 prop 이 조용히 사라지지 않는다", () => {
    expect(summarizeProps({ zeta: 1, alpha: 2 }, 4)).toBe("alpha=2 · zeta=1");
  });

  it("구 서버가 props 를 JSON 문자열로 줘도 삼킨다 (방어이지 계약은 아니다)", () => {
    expect(summarizeProps('{"mode":"league"}')).toBe("mode=league");
    // 파싱 실패는 원문 그대로 — 통째로 사라지는 것보다 낫다.
    expect(summarizeProps("not json")).toBe("not json");
    expect(summarizeProps("   ")).toBe("");
  });

  it("modeOf 는 매치 모드만 뽑는다", () => {
    expect(modeOf({ mode: "away" })).toBe("away");
    expect(modeOf({ mode: "" })).toBeNull();
    expect(modeOf({})).toBeNull();
    expect(modeOf("x")).toBeNull();
  });
});

describe("asList — 배열 아닌 응답에 .map 을 걸지 않는다", () => {
  it("배열이 아니면 빈 배열 (구 서버 200 `{}` → 흰 화면 방지)", () => {
    expect(asList([1, 2])).toEqual([1, 2]);
    expect(asList({})).toEqual([]);
    expect(asList(undefined)).toEqual([]);
    expect(asList(null)).toEqual([]);
    expect(asList("[]")).toEqual([]);
  });
});

const FUNNEL_OK: FunnelResponse = {
  generatedAt: "2026-08-10T09:00:00Z",
  users: [
    {
      userId: "u1",
      nickname: "심사위원A",
      firstSeenAt: "2026-08-10T01:00:00Z",
      lastSeenAt: "2026-08-10T08:00:00Z",
      reached: {
        signup: true,
        tutorial: true,
        deck: true,
        gacha: false,
        practice: true,
        league: false,
        away: false,
      },
      matchesFinished: 2,
      eventCount: 11,
    },
    {
      userId: "u2",
      nickname: "심사위원B",
      firstSeenAt: "2026-08-09T01:00:00Z",
      lastSeenAt: "2026-08-09T02:00:00Z",
      reached: {
        signup: true,
        tutorial: false,
        deck: false,
        gacha: false,
        practice: false,
        league: false,
        away: false,
      },
      matchesFinished: 0,
      eventCount: 1,
    },
  ],
};

describe("funnelRows — 서버 응답 → 화면 행", () => {
  it("계약 응답을 그대로 편다", () => {
    const rows = funnelRows(FUNNEL_OK);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      userId: "u1",
      nickname: "심사위원A",
      matchesFinished: 2,
      eventCount: 11,
    });
    expect(rows[0]!.reached.practice).toBe(true);
    expect(rows[0]!.reached.away).toBe(false);
  });

  it("서버 정렬(lastSeenAt DESC)을 다시 정렬하지 않는다", () => {
    // 클라가 한 번 더 정렬하면 서버 정렬이 깨져도 화면이 멀쩡해 보여 회귀를 못 잡는다.
    const shuffled: FunnelResponse = {
      users: [FUNNEL_OK.users as never].flat().slice().reverse() as never,
    };
    const rows = funnelRows(shuffled);
    expect(rows.map((r) => r.userId)).toEqual(["u2", "u1"]);
  });

  it("reached 결측/비객체는 7단계 전부 false (fail-closed)", () => {
    const rows = funnelRows({ users: [{ userId: "u9" }, { userId: "u8", reached: "yes" }] });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(FUNNEL_STAGES.every((s) => row.reached[s] === false)).toBe(true);
    }
    // 도달을 못 읽었다고 "다 갔다"로 그리면 심사 결과가 거짓이 된다.
    expect(reachedCount(rows[0]!)).toBe(0);
  });

  it("닉네임이 없으면 userId 로 대체하고, userId 가 없는 행은 버린다", () => {
    const rows = funnelRows({ users: [{ userId: "u9" }, { nickname: "이름만" } as never, null as never] });
    expect(rows.map((r) => r.userId)).toEqual(["u9"]);
    expect(rows[0]!.nickname).toBe("u9");
  });

  it("배열이 아닌 users 응답도 흰 화면이 되지 않는다", () => {
    expect(funnelRows({ users: {} as never })).toEqual([]);
    expect(funnelRows(undefined)).toEqual([]);
    expect(funnelRows(null)).toEqual([]);
  });

  it("숫자 필드 결측은 0", () => {
    const row = funnelRows({ users: [{ userId: "u9" }] })[0]!;
    expect(row.matchesFinished).toBe(0);
    expect(row.eventCount).toBe(0);
    expect(row.firstSeenAt).toBeNull();
  });
});

describe("furthestStage — '어디까지 갔나'", () => {
  it("연속 도달을 가정하지 않는다 (뽑기를 건너뛴 유저)", () => {
    const row = funnelRows(FUNNEL_OK)[0]!;
    // 첫 미도달(gacha)에서 끊으면 '연습까지 갔다'는 사실이 화면에서 사라진다.
    expect(furthestStage(row)).toBe("practice");
    expect(furthestLabel(row)).toBe("연습까지");
    expect(reachedCount(row)).toBe(4);
  });

  it("아무 것도 없으면 null / '기록 없음'", () => {
    const row = funnelRows({ users: [{ userId: "u0" }] })[0]!;
    expect(furthestStage(row)).toBeNull();
    expect(furthestLabel(row)).toBe("기록 없음");
  });

  it("원정까지 간 유저는 마지막 단계로 읽힌다", () => {
    const row = funnelRows({
      users: [{ userId: "u1", reached: { signup: true, away: true } }],
    })[0]!;
    expect(furthestStage(row)).toBe("away");
    expect(furthestLabel(row)).toBe("원정까지");
  });
});

describe("userOptions — 유저 필터 드롭다운", () => {
  it("퍼널 유저를 라벨로 편다", () => {
    const opts = userOptions(funnelRows(FUNNEL_OK), "");
    expect(opts).toEqual([
      { userId: "u1", label: "심사위원A (u1)" },
      { userId: "u2", label: "심사위원B (u2)" },
    ]);
  });

  it("퍼널에 없는 선택값도 잃지 않는다 (select 가 값을 못 찾아 필터가 풀리는 것 방지)", () => {
    const opts = userOptions(funnelRows(FUNNEL_OK), "u404");
    expect(opts.at(-1)).toEqual({ userId: "u404", label: "u404" });
  });

  it("닉네임이 userId 와 같으면 괄호를 중복하지 않는다", () => {
    const rows = funnelRows({ users: [{ userId: "u9" }] });
    expect(userOptions(rows, "")).toEqual([{ userId: "u9", label: "u9" }]);
  });
});
