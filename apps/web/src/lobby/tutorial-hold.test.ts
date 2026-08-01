// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_SETTLE_MS, useUnbiddenPopupHold } from "./tutorial-hold";

/**
 * #386 — "저절로 뜨는 팝업을 지금 미뤄야 하는가"의 **경계 세 개**.
 *
 * e2e(`p386-notice-gate.spec.ts`)가 실동선을 잡지만, 거기서는 `toBeVisible()` 이 알아서 기다리므로
 * **"코치마크가 안 돌았는데도 미룬다"** 는 변이체가 조용히 통과한다(그래도 결국 뜨니까).
 * 그 성질은 여기서만 죽는다 — 완료 유저의 홈 진입은 **지연 없이** 열려야 한다.
 */
describe("useUnbiddenPopupHold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("코치마크가 아예 안 돈 방문에서는 미루지 않는다 (완료 유저 = 즉시)", () => {
    const { result } = renderHook(() => useUnbiddenPopupHold(false));
    expect(result.current).toBe(false);
  });

  it("코치마크가 도는 동안은 미룬다", () => {
    const { result } = renderHook(({ active }) => useUnbiddenPopupHold(active), {
      initialProps: { active: true },
    });
    expect(result.current).toBe(true);
  });

  it("코치마크가 끝나면 정착 시간만큼만 더 미루고 **같은 화면에서** 푼다", () => {
    const { result, rerender } = renderHook(({ active }) => useUnbiddenPopupHold(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    // 완료 저장이 me/deck 캐시를 무효화하며 화면이 바뀌는 프레임 — 아직 열지 않는다.
    expect(result.current).toBe(true);

    act(() => void vi.advanceTimersByTime(TUTORIAL_SETTLE_MS + 10));
    // ⚠️ **방문 전체가 아니라 이 창만큼이다** — 예전 래치는 여기서도 참으로 남아 있었고,
    // 그게 신규 유저가 공지를 영영 못 보던 축이었다.
    expect(result.current).toBe(false);
  });

  it("정착 도중 코치마크가 다시 뜨면 그 창은 취소된다 (미룸이 이어진다)", () => {
    const { result, rerender } = renderHook(({ active }) => useUnbiddenPopupHold(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    rerender({ active: true });
    act(() => void vi.advanceTimersByTime(TUTORIAL_SETTLE_MS + 10));
    expect(result.current).toBe(true);
  });
});
