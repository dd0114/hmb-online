// @vitest-environment jsdom
/**
 * #382 — 대기 화면 **정경 문구 로테이션** 동작 계약.
 *
 * hero: *"기다리기 지루하니까"* — 그래서 이 파일이 지키는 것은 문구의 존재가 아니라 **움직임**이다.
 * 한 문장이 굳어 버리면(로테이션 배선이 빠지면) 문구만 갈아 끼운 것과 다를 게 없다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다(MatchPage.test 와 동일).
 */
import { createElement as h } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/hooks", () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useRetry: mutation,
    useAbandonMatch: mutation,
    useActiveMatch: () => ({ data: undefined, isLoading: false, isError: false }),
  };
});

import { GenWaitPanel } from "./GenWaitPanel";
import { WAITING_SCENE_LINES, WAITING_SCENE_ROTATE_SEC } from "./waiting-scenes";
import type { MatchDetail } from "../api/hooks";

const match = (state: string) =>
  ({ id: "m1", createdAt: "2026-08-01T00:00:00Z", state }) as unknown as MatchDetail;

function renderPanel(state = "GEN1") {
  render(h(MemoryRouter, null, h(GenWaitPanel, { match: match(state) })));
}

const scene = () => screen.getByTestId("genwait-scene").textContent ?? "";

/** 가짜 타이머로 초를 흘린다 — 패널의 경과 시계는 1초 setInterval 이다. */
function tick(seconds: number) {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GenWaitPanel — 축구장 정경 로테이션 (#382)", () => {
  it("첫 화면부터 정경 문장을 보여준다", () => {
    renderPanel();
    expect(WAITING_SCENE_LINES).toContain(scene());
  });

  it(`${WAITING_SCENE_ROTATE_SEC}초가 지나면 다음 문장으로 바뀐다`, () => {
    renderPanel();
    const first = scene();
    tick(WAITING_SCENE_ROTATE_SEC);
    const second = scene();
    expect(second, "문구가 굳어 있다(로테이션 배선 없음)").not.toBe(first);
    expect(WAITING_SCENE_LINES).toContain(second);
  });

  it("회전 창 안에서는 흔들리지 않는다 (1초 틱마다 바뀌면 읽을 수 없다)", () => {
    renderPanel();
    const first = scene();
    for (let s = 1; s < WAITING_SCENE_ROTATE_SEC; s++) {
      tick(1);
      expect(scene()).toBe(first);
    }
  });

  it("오래 기다려도 문장이 계속 갈린다 — 풀 전체를 돈다", () => {
    renderPanel();
    const seen = new Set<string>([scene()]);
    for (let i = 1; i < WAITING_SCENE_LINES.length; i++) {
      tick(WAITING_SCENE_ROTATE_SEC);
      seen.add(scene());
    }
    expect(seen.size, "풀 뒤쪽 문장이 노출되지 않는다").toBe(WAITING_SCENE_LINES.length);
  });

  it("전반·후반 모두 같은 정경 풀을 쓴다 (한쪽만 시스템 문구로 남지 않는다)", () => {
    for (const state of ["GEN1", "GEN2"]) {
      cleanup();
      renderPanel(state);
      expect(WAITING_SCENE_LINES).toContain(scene());
    }
  });

  it("경과 시계는 남는다 — 걷어낸 것은 서술이지 기능 정보가 아니다", () => {
    renderPanel();
    expect(screen.getByTestId("genwait-elapsed").textContent).toContain("경과 0:00");
    tick(5);
    expect(screen.getByTestId("genwait-elapsed").textContent).toContain("경과 0:05");
  });

  it("시스템 설명·소요시간 안내가 패널 어디에도 없다", () => {
    renderPanel();
    const text = screen.getByTestId("genwait-panel").textContent ?? "";
    for (const word of ["AI", "작전 반영", "지시가", "전달", "10초", "1~2분", "70초"]) {
      expect(text, `시스템 설명이 되살아났다 ← "${word}"`).not.toContain(word);
    }
  });
});
