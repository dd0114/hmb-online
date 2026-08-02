// @vitest-environment jsdom
/**
 * #226 — 스코어바 헤더 계약. **감독시간에는 헤더가 재생을 따라가지 않는다.**
 *
 * 배포본(v8.01)에서 감독시간 헤더가 `0 : 0 / 0'` 였다(API 는 0:4). 원인은 "확정 스코어 우선" 규칙이
 * 레거시 상태명 `H1_BREAK` 에만 걸려 있어 현행 `HALFTIME` 이 규칙 밖에 있었던 것 — 그래서 이 파일은
 * **`HALFTIME` 으로** 단언한다(기존 계약이 전부 `H1_BREAK` 로만 열려 있어 구멍을 못 봤다).
 *
 * ⚠️ **시계 인자는 #388 부터 틱이 아니라 표기 분이다.** 분을 만드는 규칙(로그가 구운 `minute` 을
 * 읽는다)은 `stage-state.headerMinute` 이 소유하고 그 계약은 `stage-state.test.ts` 에 있다 —
 * 여기서는 "받은 분을 어떻게 그리나 + 스코어와 어떻게 짝짓나"만 본다.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../../api/hooks";
import { ScoreBar } from "./ScoreBar";
import type { HeaderClock } from "./stage-state";

/**
 * 전반이 끝난 표기 분 — StageShell 이 로그의 `half_whistle` 에서 뽑아 넘기는 값(#388).
 * 감독시간엔 **초가 없다**(#406 W2): 휘슬 분에는 앵커가 없고, 이 시계는 흐르는 시각이 아니라
 * "끝난 지점"이다. 규칙은 `stage-state.headerClock` 이 소유한다.
 */
const H1_END: HeaderClock = { minute: 45, second: null };
/** 관전 중 시각 — 분(구운 값) + 그 분의 앵커에서 흐른 초(#406 W2 통합 표기 `48'32"`). */
const at = (minute: number, second: number | null = 0): HeaderClock => ({ minute, second });

const base = { id: "m1", createdAt: "2026-07-28T00:00:00Z" } as Partial<MatchDetail>;

function renderBar(match: Partial<MatchDetail>, props: Partial<Parameters<typeof ScoreBar>[0]> = {}) {
  return render(
    h(ScoreBar, {
      match: match as MatchDetail,
      homeName: "테스터",
      awayName: "봇 FC",
      liveScore: null,
      minute: null,
      onBack: vi.fn(),
      ...props,
    }),
  );
}

afterEach(cleanup);

describe("감독시간 헤더 (#226)", () => {
  it("HALFTIME 은 전반 확정 스코어를 보여준다 — 재생 스코어가 아니라", () => {
    renderBar(
      { ...base, state: "HALFTIME", scoreH1Home: 0, scoreH1Away: 4 },
      // 되감아 플레이헤드가 맨 앞이면 재생 스코어는 0:0 이다. 그걸 따라가면 안 된다.
      { liveScore: { home: 0, away: 0 }, minute: H1_END },
    );
    expect(screen.getByTestId("h1-score").textContent).toContain("0 : 4");
    expect(screen.getByTestId("match-state").textContent).toBe("감독시간");
  });

  it("HALFTIME 시계는 전반이 끝난 지점(45')에 고정된다", () => {
    renderBar(
      { ...base, state: "HALFTIME", scoreH1Home: 0, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 0 }, minute: H1_END },
    );
    // 2699 를 내리면 44' 가 된다 — 하프 끝은 반올림 표기다.
    expect(screen.getByTestId("stage-clock").textContent).toBe("45'");
  });

  it("레거시 H1_BREAK 도 같은 규칙을 받는다", () => {
    renderBar(
      { ...base, state: "H1_BREAK", scoreH1Home: 2, scoreH1Away: 1 },
      { liveScore: { home: 0, away: 0 }, minute: H1_END },
    );
    expect(screen.getByTestId("h1-score").textContent).toContain("2 : 1");
    expect(screen.getByTestId("stage-clock").textContent).toBe("45'");
  });

  it("확정 스코어가 아직 없으면 0 으로 단정하지 않고 '-' 로 둔다", () => {
    renderBar({ ...base, state: "HALFTIME" }, { liveScore: { home: 3, away: 3 }, minute: H1_END });
    expect(screen.getByTestId("h1-score").textContent).toContain("- : -");
  });

  it("하프 끝을 모르면 시계를 아예 그리지 않는다(틀린 분을 쓰지 않는다)", () => {
    renderBar({ ...base, state: "HALFTIME", scoreH1Home: 0, scoreH1Away: 4 }, { minute: null });
    expect(screen.queryByTestId("stage-clock")).toBeNull();
  });
});

describe("후반 진행 중 헤더 (#233)", () => {
  it("후반 킥오프에도 전반 스코어가 살아 있다 — 후반만의 점수를 경기 점수로 그리지 않는다", () => {
    // 배포본 실측: 라이브 DB 실경기(전반 1:4)의 후반 45' 헤더가 `0 : 0` 이었다.
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 0 }, minute: at(45, 32) },
    );
    expect(screen.getByTestId("stage-score").textContent).toContain("1 : 4");
    expect(screen.getByTestId("stage-clock").textContent).toBe("45'32\"");
    expect(screen.getByTestId("match-state").textContent).toBe("후반 진행 중");
  });

  it("후반 골은 전반 위에 쌓인다", () => {
    // 같은 경기 65' — 후반 2골(away) 뒤. 배포본은 `0 : 2` 였다.
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 2 }, minute: at(65, 32) },
    );
    expect(screen.getByTestId("stage-score").textContent).toContain("1 : 6");
    expect(screen.getByTestId("stage-clock").textContent).toBe("65'32\"");
  });

  it("후반 헤더에는 h1-score testid 를 붙이지 않는다(그 값은 전반 스코어가 아니다)", () => {
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 2 }, minute: at(65, 32) },
    );
    expect(screen.queryByTestId("h1-score")).toBeNull();
  });

  it("전반 확정값 없는 후반(구 매치)은 '-' — 후반만의 점수를 대신 보여주지 않는다", () => {
    renderBar({ ...base, state: "SECOND_HALF" }, { liveScore: { home: 0, away: 2 }, minute: at(65, 32) });
    expect(screen.getByTestId("stage-score").textContent).toContain("- : -");
  });
});

describe("경기 분 상시 표시 (#233 스코프 추가)", () => {
  it("후반 진행 중에도 경기 분이 헤더에 있다", () => {
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 0 }, minute: at(65, 32) },
    );
    expect(screen.getByTestId("stage-clock").textContent).toBe("65'32\"");
  });

  it("플레이헤드가 아직 없어도 시계 슬롯은 사라지지 않는다", () => {
    renderBar({ ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 }, { minute: null });
    expect(screen.getByTestId("stage-clock").textContent).toBe("--'");
  });
});

describe("라이브 하프 헤더 — 무회귀", () => {
  it("FIRST_HALF 는 재생 진행을 따라간다(확정 스코어가 없다)", () => {
    renderBar({ ...base, state: "FIRST_HALF" }, { liveScore: { home: 1, away: 0 }, minute: at(21, 32) });
    expect(screen.queryByTestId("h1-score")).toBeNull();
    expect(screen.getByTestId("stage-score").textContent).toContain("1 : 0");
    expect(screen.getByTestId("stage-clock").textContent).toBe("21'32\"");
  });

  it("FINISHED 는 최종 스코어 + 후반 재생 진행", () => {
    renderBar(
      { ...base, state: "FINISHED", scoreHome: 3, scoreAway: 2 },
      { liveScore: { home: 0, away: 0 }, minute: at(65, 32) },
    );
    expect(screen.getByTestId("stage-score").textContent).toContain("3 : 2");
    expect(screen.getByTestId("stage-clock").textContent).toBe("65'32\"");
  });
});

/**
 * #406 W2 — **받은 시각을 그리는 규칙만** 여기서 본다. 분·초를 만드는 규칙(구운 `minute` + 앵커)은
 * `stage-state` 가 소유하고 계약은 `stage-state.test.ts` 에 있다. 여기서 시각을 계산하기 시작하면
 * 규칙이 두 곳이 되고 그게 #388 의 모양이다.
 */
describe("초 표기 (#406 W2 — hero 확정 안 A `48'32\"`)", () => {
  it("한 자리 초는 0 을 채운다 — `48'2\"` 는 시계로 안 읽힌다", () => {
    renderBar({ ...base, state: "FIRST_HALF" }, { liveScore: null, minute: at(48, 2) });
    expect(screen.getByTestId("stage-clock").textContent).toBe("48'02\"");
  });

  it("0 초도 그린다 — 분이 막 바뀐 순간에 시계가 짧아졌다 길어졌다 하지 않는다", () => {
    renderBar({ ...base, state: "FIRST_HALF" }, { liveScore: null, minute: at(48, 0) });
    expect(screen.getByTestId("stage-clock").textContent).toBe("48'00\"");
  });

  it("초를 모르면(second: null) 분만 — `00\"` 을 지어내지 않는다", () => {
    renderBar({ ...base, state: "FIRST_HALF" }, { liveScore: null, minute: at(48, null) });
    expect(screen.getByTestId("stage-clock").textContent).toBe("48'");
  });
});
