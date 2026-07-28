// @vitest-environment jsdom
/**
 * #226 — 스코어바 헤더 계약. **감독시간에는 헤더가 재생을 따라가지 않는다.**
 *
 * 배포본(v8.01)에서 감독시간 헤더가 `0 : 0 / 0'` 였다(API 는 0:4). 원인은 "확정 스코어 우선" 규칙이
 * 레거시 상태명 `H1_BREAK` 에만 걸려 있어 현행 `HALFTIME` 이 규칙 밖에 있었던 것 — 그래서 이 파일은
 * **`HALFTIME` 으로** 단언한다(기존 계약이 전부 `H1_BREAK` 로만 열려 있어 구멍을 못 봤다).
 *
 * 분 표기는 엔진 하프 길이에서 파생된다(웹에 45 를 상수로 두지 않는다) — 전반 마지막 스냅샷 틱
 * 2699 는 44.98분이라 **반올림**해야 `45'` 가 된다.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../../api/hooks";
import { ScoreBar } from "./ScoreBar";

/** 리얼 엔진 전반의 마지막 스냅샷 틱(0..2699) — StageShell 이 로그에서 뽑아 넘기는 값. */
const H1_END_TICK = 2699;

const base = { id: "m1", createdAt: "2026-07-28T00:00:00Z" } as Partial<MatchDetail>;

function renderBar(match: Partial<MatchDetail>, props: Partial<Parameters<typeof ScoreBar>[0]> = {}) {
  return render(
    h(ScoreBar, {
      match: match as MatchDetail,
      homeName: "테스터",
      awayName: "봇 FC",
      liveScore: null,
      tick: null,
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
      { liveScore: { home: 0, away: 0 }, tick: H1_END_TICK },
    );
    expect(screen.getByTestId("h1-score").textContent).toContain("0 : 4");
    expect(screen.getByTestId("match-state").textContent).toBe("감독시간");
  });

  it("HALFTIME 시계는 전반이 끝난 지점(45')에 고정된다", () => {
    renderBar(
      { ...base, state: "HALFTIME", scoreH1Home: 0, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 0 }, tick: H1_END_TICK },
    );
    // 2699 를 내리면 44' 가 된다 — 하프 끝은 반올림 표기다.
    expect(screen.getByTestId("stage-clock").textContent).toBe("45'");
  });

  it("레거시 H1_BREAK 도 같은 규칙을 받는다", () => {
    renderBar(
      { ...base, state: "H1_BREAK", scoreH1Home: 2, scoreH1Away: 1 },
      { liveScore: { home: 0, away: 0 }, tick: H1_END_TICK },
    );
    expect(screen.getByTestId("h1-score").textContent).toContain("2 : 1");
    expect(screen.getByTestId("stage-clock").textContent).toBe("45'");
  });

  it("확정 스코어가 아직 없으면 0 으로 단정하지 않고 '-' 로 둔다", () => {
    renderBar({ ...base, state: "HALFTIME" }, { liveScore: { home: 3, away: 3 }, tick: H1_END_TICK });
    expect(screen.getByTestId("h1-score").textContent).toContain("- : -");
  });

  it("하프 끝을 모르면 시계를 아예 그리지 않는다(틀린 분을 쓰지 않는다)", () => {
    renderBar({ ...base, state: "HALFTIME", scoreH1Home: 0, scoreH1Away: 4 }, { tick: null });
    expect(screen.queryByTestId("stage-clock")).toBeNull();
  });
});

describe("후반 진행 중 헤더 (#233)", () => {
  it("후반 킥오프에도 전반 스코어가 살아 있다 — 후반만의 점수를 경기 점수로 그리지 않는다", () => {
    // 배포본 실측: 라이브 DB 실경기(전반 1:4)의 후반 45' 헤더가 `0 : 0` 이었다.
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 0 }, tick: 2700 },
    );
    expect(screen.getByTestId("stage-score").textContent).toContain("1 : 4");
    expect(screen.getByTestId("stage-clock").textContent).toBe("45'");
    expect(screen.getByTestId("match-state").textContent).toBe("후반 진행 중");
  });

  it("후반 골은 전반 위에 쌓인다", () => {
    // 같은 경기 65' — 후반 2골(away) 뒤. 배포본은 `0 : 2` 였다.
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 2 }, tick: 3900 },
    );
    expect(screen.getByTestId("stage-score").textContent).toContain("1 : 6");
    expect(screen.getByTestId("stage-clock").textContent).toBe("65'");
  });

  it("후반 헤더에는 h1-score testid 를 붙이지 않는다(그 값은 전반 스코어가 아니다)", () => {
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 2 }, tick: 3900 },
    );
    expect(screen.queryByTestId("h1-score")).toBeNull();
  });

  it("전반 확정값 없는 후반(구 매치)은 '-' — 후반만의 점수를 대신 보여주지 않는다", () => {
    renderBar({ ...base, state: "SECOND_HALF" }, { liveScore: { home: 0, away: 2 }, tick: 3900 });
    expect(screen.getByTestId("stage-score").textContent).toContain("- : -");
  });
});

describe("경기 분 상시 표시 (#233 스코프 추가)", () => {
  it("후반 진행 중에도 경기 분이 헤더에 있다", () => {
    renderBar(
      { ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 },
      { liveScore: { home: 0, away: 0 }, tick: 3900 },
    );
    expect(screen.getByTestId("stage-clock").textContent).toBe("65'");
  });

  it("플레이헤드가 아직 없어도 시계 슬롯은 사라지지 않는다", () => {
    renderBar({ ...base, state: "SECOND_HALF", scoreH1Home: 1, scoreH1Away: 4 }, { tick: null });
    expect(screen.getByTestId("stage-clock").textContent).toBe("--'");
  });
});

describe("라이브 하프 헤더 — 무회귀", () => {
  it("FIRST_HALF 는 재생 진행을 따라간다(확정 스코어가 없다)", () => {
    renderBar({ ...base, state: "FIRST_HALF" }, { liveScore: { home: 1, away: 0 }, tick: 1290 });
    expect(screen.queryByTestId("h1-score")).toBeNull();
    expect(screen.getByTestId("stage-score").textContent).toContain("1 : 0");
    // 라이브 시계는 내림 — 21분 30초는 아직 21' 다.
    expect(screen.getByTestId("stage-clock").textContent).toBe("21'");
  });

  it("FINISHED 는 최종 스코어 + 후반 재생 진행", () => {
    renderBar(
      { ...base, state: "FINISHED", scoreHome: 3, scoreAway: 2 },
      { liveScore: { home: 0, away: 0 }, tick: 3900 },
    );
    expect(screen.getByTestId("stage-score").textContent).toContain("3 : 2");
    expect(screen.getByTestId("stage-clock").textContent).toBe("65'");
  });
});
