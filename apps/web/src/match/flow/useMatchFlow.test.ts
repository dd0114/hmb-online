// @vitest-environment jsdom
/**
 * #424 W1 — 전이 관측 훅의 계약(설계 §12.1 P2·P3·P4·P5).
 *
 * 가장 중요한 것은 **P2(첫 관측 무발화)** 다: 이 가드가 없으면 새로고침·`FINISHED` 재입장에
 * 브릿지가 다시 뜬다. 플래그 저장소 없이 **구조적으로** 막는 자리라 계약도 여기 있어야 한다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 renderHook 으로 쓴다.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../../api/hooks";
import { useMatchFlow } from "./useMatchFlow";

const m = (state: string, id = "m1"): MatchDetail =>
  ({ id, state, createdAt: "2026-08-03T00:00:00Z" }) as MatchDetail;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("P2 — 첫 관측에서는 아무것도 열지 않는다", () => {
  it("FINISHED 매치를 나중에 다시 열어도 경기 종료 브릿지가 뜨지 않는다", () => {
    const { result } = renderHook(() => useMatchFlow(m("FINISHED")));
    expect(result.current.bridge).toBeNull();
    expect(result.current.overlayOpen).toBe(false);
  });

  it("라이브 매치에 재입장(새로고침)해도 조용하다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("HALFTIME") },
    });
    // 폴링이 같은 상태를 계속 돌려줘도 전이가 아니다.
    rerender({ d: m("HALFTIME") });
    rerender({ d: m("HALFTIME") });
    expect(result.current.bridge).toBeNull();
  });

  it("매치가 아직 안 왔다가(undefined) 도착하는 것도 전이가 아니다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: undefined as MatchDetail | undefined },
    });
    rerender({ d: m("FINISHED") });
    expect(result.current.bridge).toBeNull();
  });

  it("다른 매치로 갈아타는 것도 전이가 아니다(id 가 기준점을 다시 잡는다)", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("SECOND_HALF", "m1") },
    });
    rerender({ d: m("FINISHED", "m2") });
    expect(result.current.bridge).toBeNull();
  });
});

describe("전이가 브릿지를 연다", () => {
  it("FIRST_HALF → HALFTIME 에서 h1_end(리포트 없음)", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("FIRST_HALF") },
    });
    rerender({ d: m("HALFTIME") });
    expect(result.current.bridge).toEqual({ kind: "h1_end", report: null });
    expect(result.current.overlayOpen).toBe(true);
  });

  it("SECOND_HALF → FINISHED 에서 match_end", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("SECOND_HALF") },
    });
    rerender({ d: m("FINISHED") });
    expect(result.current.bridge?.kind).toBe("match_end");
  });

  it("대기형(BRIEFING→GEN1 · HALFTIME→GEN2)은 오버레이를 열지 않는다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("BRIEFING") },
    });
    rerender({ d: m("GEN1") });
    expect(result.current.bridge).toBeNull();
    expect(result.current.overlayOpen).toBe(false);
  });
});

describe("P3 — 두 소스가 겹쳐도 한 번만 열린다", () => {
  it("스킵 신호 + 전이 관측이 같은 프레임에 와도 스택은 하나다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("FIRST_HALF") },
    });
    act(() => result.current.openReport(1)); // SkipButton.onSkipped
    rerender({ d: m("HALFTIME") }); // 캐시 갱신으로 전이 관측
    expect(result.current.bridge).toEqual({ kind: "h1_end", report: 1 });
  });

  it("P4 — 스킵 신호가 **늦게** 와도 리포트가 앞에 끼워진다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("FIRST_HALF") },
    });
    rerender({ d: m("HALFTIME") });
    expect(result.current.bridge?.report).toBeNull();
    act(() => result.current.openReport(1));
    expect(result.current.bridge).toEqual({ kind: "h1_end", report: 1 });
  });

  it("D6 — 스킵 응답이 GEN2(오토)여도 리포트 브릿지가 열린다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("FIRST_HALF") },
    });
    act(() => result.current.openReport(1));
    rerender({ d: m("GEN2") });
    expect(result.current.bridge).toEqual({ kind: "h1_end", report: 1 });
  });
});

describe("P5 — 닫은 브릿지는 폴링이 다시 열지 않는다", () => {
  it("닫은 뒤 같은 전이가 재관측돼도 조용하다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("FIRST_HALF") },
    });
    rerender({ d: m("HALFTIME") });
    act(() => result.current.close());
    expect(result.current.bridge).toBeNull();

    // 서버가 잠깐 FIRST_HALF 를 돌려주고(재조회 경합) 다시 HALFTIME 이 되는 최악의 경우.
    rerender({ d: m("FIRST_HALF") });
    rerender({ d: m("HALFTIME") });
    expect(result.current.bridge).toBeNull();
  });

  it("두 브릿지가 쌓이면 하나씩 소비된다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("FIRST_HALF") },
    });
    rerender({ d: m("HALFTIME") });
    rerender({ d: m("SECOND_HALF") });
    rerender({ d: m("FINISHED") });
    expect(result.current.bridge?.kind).toBe("h1_end");
    act(() => result.current.close());
    expect(result.current.bridge?.kind).toBe("match_end");
    act(() => result.current.close());
    expect(result.current.bridge).toBeNull();
  });
});

describe("킥오프 비트", () => {
  it("GEN1 → FIRST_HALF 에서 뜨고 스스로 사라진다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("GEN1") },
    });
    rerender({ d: m("FIRST_HALF") });
    expect(result.current.beat).toBe("kickoff_h1");
    // ⚠️ 비트는 무대를 내리지 않는다 — 백드롭 없이 경기 화면 위에 겹치는 카드다.
    expect(result.current.overlayOpen).toBe(false);
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.beat).toBeNull();
  });

  it("클릭으로 즉시 사라진다", () => {
    const { result, rerender } = renderHook(({ d }) => useMatchFlow(d), {
      initialProps: { d: m("GEN2") },
    });
    rerender({ d: m("SECOND_HALF") });
    expect(result.current.beat).toBe("kickoff_h2");
    act(() => result.current.dismissBeat());
    expect(result.current.beat).toBeNull();
  });
});
