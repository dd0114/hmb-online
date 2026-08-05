// @vitest-environment jsdom
/**
 * #424 W1 — 흐름 오버레이의 화면 계약. 특히 **#405 진입 계약(§9.3)** 을 여기서 박는다:
 * C2(continuation 없이도 흐름 완결) · C3(오버레이 **안**에서 렌더) · C4(`onDone` 멱등) ·
 * C5(던지면 오버레이가 닫힌다).
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: null as unknown, players: [] as unknown }));

vi.mock("../../api/hooks", () => ({
  useHalfLog: (_id: string, _half: number, enabled = true) => ({
    data: enabled ? mocks.log : undefined,
    isLoading: false,
  }),
  usePlayers: () => ({ data: mocks.players }),
}));
/*
 * 평점 카드는 **이 스위트의 관심사가 아니다**(브릿지 큐·스택 소유가 주제다) → 인물 선정만 목으로
 * 끈다. 나머지(`highlightStatsOf`)는 진짜를 남긴다 — 통째로 갈면 `HalfReportModal` 이 부르는
 * 심볼이 사라져 "테스트만 성립하는 모듈"이 된다.
 */
vi.mock("../skip-report-rating", async (orig) => ({
  ...(await orig<typeof import("../skip-report-rating")>()),
  topRatedOfHalf: () => null,
}));

import { MatchFlowOverlay } from "./MatchFlowOverlay";
import type { MatchFlowHandle } from "./useMatchFlow";
import type { MatchDetail } from "../../api/hooks";
import type { QueuedBridge } from "./match-flow";

const match = (over: Partial<MatchDetail> = {}): MatchDetail =>
  ({ id: "m1", state: "FINISHED", createdAt: "2026-08-03T00:00:00Z", ...over }) as MatchDetail;

function open(
  bridge: QueuedBridge | null,
  over: { detail?: Partial<MatchDetail>; continuation?: MatchFlowOverlayCont } = {},
) {
  const flow: MatchFlowHandle = {
    bridge,
    beat: null,
    overlayOpen: bridge != null,
    openReport: vi.fn(),
    close: vi.fn(),
    dismissBeat: vi.fn(),
  };
  render(
    h(MatchFlowOverlay, {
      flow,
      match: match(over.detail),
      homeName: "우리팀",
      awayName: "봇 FC",
      matchEndContinuation: over.continuation ?? null,
    }),
  );
  return flow;
}

type MatchFlowOverlayCont = NonNullable<Parameters<typeof MatchFlowOverlay>[0]["matchEndContinuation"]>;

afterEach(() => {
  cleanup();
  mocks.log = null;
  mocks.players = [];
});

describe("C2 — continuation 없이도 흐름이 완결된다(선배포 형태)", () => {
  it("CTA 가 `보상과 결과 보기` 이고 누르면 오버레이가 닫힌다", () => {
    const flow = open({ kind: "match_end", report: null }, { detail: { result: "WIN" } });
    const cta = screen.getByTestId("flow-bridge-next");
    // W6: 닫은 자리에 오는 것이 (봉투 미확인이면) #405 보상 시트라 `결과 보기` 는 참이 아니었다.
    expect(cta.textContent).toBe("보상과 결과 보기");
    expect(screen.getByTestId("flow-bridge-text").textContent).toContain("승리");
    fireEvent.click(cta);
    expect(flow.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("flow-continuation")).toBeNull();
  });
});

describe("C3·C4 — continuation 은 오버레이 안에서 렌더되고 onDone 은 멱등이다", () => {
  it("CTA 라벨이 바뀌고, 누르면 같은 층에서 보상 화면이 뜬다", () => {
    let done: (() => void) | null = null;
    const cont: MatchFlowOverlayCont = (handoff, onDone) => {
      done = onDone;
      return h("p", { "data-testid": "reward-stub" }, handoff.matchId + ":" + String(handoff.viaSkip));
    };
    const flow = open({ kind: "match_end", report: null }, { continuation: cont });

    const cta = screen.getByTestId("flow-bridge-next");
    expect(cta.textContent).toBe("보상 받기");
    fireEvent.click(cta);

    expect(screen.getByTestId("flow-continuation")).toBeTruthy();
    expect(screen.getByTestId("reward-stub").textContent).toBe("m1:false");
    expect(flow.close).not.toHaveBeenCalled();

    // C4 — 애니메이션 끝과 버튼 클릭이 각각 부를 수 있다. 두 번 불러도 한 번만 닫힌다.
    done!();
    done!();
    expect(flow.close).toHaveBeenCalledTimes(1);
  });

  it("스킵으로 끝난 경기는 viaSkip=true 로 넘어간다", () => {
    let seen: unknown = null;
    const cont: MatchFlowOverlayCont = (handoff) => {
      seen = handoff;
      return null;
    };
    open({ kind: "match_end", report: 2 }, { continuation: cont, detail: { scoreHome: 3, scoreAway: 1 } });
    fireEvent.click(screen.getByTestId("half-report-next")); // 리포트 → 브릿지
    fireEvent.click(screen.getByTestId("half-report-next")); // 브릿지 CTA
    expect(seen).toMatchObject({ matchId: "m1", matchState: "FINISHED", viaSkip: true });
  });
});

describe("C5 — 보상 연출이 던져도 결과 화면 도달을 막지 않는다", () => {
  it("오버레이가 닫힌다(화면이 에러로 굳지 않는다)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cont: MatchFlowOverlayCont = () => {
      throw new Error("보상 조회 실패");
    };
    const flow = open({ kind: "match_end", report: null }, { continuation: cont });
    fireEvent.click(screen.getByTestId("flow-bridge-next"));
    expect(flow.close).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("브릿지는 스킵 리포트의 앞 카드다(하나의 스택 · 하나의 닫기)", () => {
  /**
   * ⚠️ **순서가 #456 에서 뒤집혔다.** 구 규칙은 `리포트 → 브릿지` 였고 근거는 *"무슨 일이 있었나 →
   * 이제 뭐가 오나"* 였는데, 그러면 브릿지 도달에 클릭 2회가 걸려 유저 기억엔 리포트만 남았다
   * (hero: *"경기 브릿지 왜 없어?"*). 지금은 **전환을 먼저 알리고** 자세한 것이 뒤에 온다.
   * 두 성질을 **같이** 건다 — 순서만 걸면 마지막 CTA 가 `닫기` 로 퇴화한 반쪽 구현이 통과한다.
   */
  it("브릿지 → 리포트 순서로 넘어가고 마지막 장 CTA 가 갈 곳을 말한다", () => {
    mocks.log = { events: [{ tick: 600, minute: 20, type: "goal", team: "home", playerId: "P1" }] };
    const flow = open({ kind: "h1_end", report: 1 }, { detail: { state: "HALFTIME", scoreH1Home: 1, scoreH1Away: 0 } });

    expect(screen.getByTestId("half-report-card")).toHaveProperty("dataset.card", "bridge");
    expect(screen.getByTestId("half-report-title").textContent).toBe("전반 종료");
    expect(screen.getByTestId("half-report-pager").textContent).toBe("1 / 2");
    // 첫 장은 마지막이 아니므로 버튼은 `다음` 이다(브릿지 CTA 가 여기서 거짓말하지 않는다).
    expect(screen.getByTestId("half-report-next").textContent).toBe("다음");
    fireEvent.click(screen.getByTestId("half-report-next"));

    expect(screen.getByTestId("half-report-title").textContent).toBe("전반 리포트");
    const cta = screen.getByTestId("half-report-next");
    expect(cta.textContent).toBe("감독시간으로");
    fireEvent.click(cta);
    expect(flow.close).toHaveBeenCalledTimes(1);
  });

  it("스킵하지 않은 브릿지는 리포트 스택 이름을 쓰지 않는다(계약이 둘을 혼동하지 않게)", () => {
    open({ kind: "h1_end", report: null }, { detail: { state: "HALFTIME" } });
    expect(screen.queryByTestId("half-report")).toBeNull();
    expect(screen.getByTestId("flow-bridge")).toBeTruthy();
    // 로그를 조회하지 않으므로 타임라인 카드가 아예 없다.
    expect(screen.queryByTestId("flow-bridge-timeline")).toBeNull();
    expect(screen.getByTestId("flow-bridge-next").textContent).toBe("감독시간으로");
  });

  it("확정 스코어를 모르면 스코어 줄을 그리지 않는다(0 : 0 을 지어내지 않는다)", () => {
    open({ kind: "h1_end", report: null }, { detail: { state: "HALFTIME" } });
    expect(screen.queryByTestId("flow-bridge-score")).toBeNull();
  });
});

describe("킥오프 비트", () => {
  it("백드롭 없는 카드로 뜨고 클릭하면 사라진다", () => {
    const flow: MatchFlowHandle = {
      bridge: null,
      beat: "kickoff_h1",
      overlayOpen: false,
      openReport: vi.fn(),
      close: vi.fn(),
      dismissBeat: vi.fn(),
    };
    render(
      h(MatchFlowOverlay, { flow, match: match({ state: "FIRST_HALF" }), homeName: "우리팀", awayName: "봇 FC" }),
    );
    const beat = screen.getByTestId("flow-beat");
    expect(beat.textContent).toContain("전반 시작");
    fireEvent.click(beat);
    expect(flow.dismissBeat).toHaveBeenCalledTimes(1);
  });
});
