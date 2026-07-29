// @vitest-environment jsdom
/**
 * 감독시간 팀 전술 — #254 (hero 결정 = 허용).
 *
 * 그전까지 이 화면엔 전술 손잡이가 **없었다**: 서버 계약({@code POST /halftime})에 전술을 실을
 * 자리가 없어서, 다이얼을 두면 "만져도 아무 데도 안 가는 손잡이"가 되기 때문이었다(#244).
 * 계약이 생겼으니 화면을 붙이되, 붙이는 것만으로는 부족하고 **보내는 값**이 계약과 맞아야 한다.
 *
 * 박제하는 것:
 *   ① 다이얼 시작점 = 전반에 실제로 쓴 값(중립 리셋 금지)
 *   ② 건드리면 그 값이 halftime 바디의 teamTactics 로 나간다
 *   ③ 안 건드리면 **필드 자체를 안 보낸다**(서버는 미첨부를 "손대지 않음"으로 읽어 콜0 유지)
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  deck: {
    id: "d1",
    formation: "4-4-2",
    teamPrompt: null,
    slots: [
      { playerId: "GK1", role: "starter", slotIndex: 0, promptText: null },
      ...Array.from({ length: 10 }, (_, i) => ({
        playerId: `P${i + 1}`,
        role: "starter",
        slotIndex: i + 1,
        promptText: null,
      })),
      { playerId: "B1", role: "bench", slotIndex: 0, promptText: null },
    ],
  },
  players: [
    { id: "GK1", name: "골리", position: "GK", grade: "GOLD", owned: true, ownedCount: 1 },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `P${i + 1}`,
      name: `선수${i + 1}`,
      position: i < 4 ? "DF" : i < 8 ? "MF" : "FW",
      grade: "SILVER",
      owned: true,
      ownedCount: 1,
    })),
    { id: "B1", name: "벤치", position: "FW", grade: "BRONZE", owned: true, ownedCount: 1 },
  ],
  submitPrompt: vi.fn(async () => ({})),
  halftime: vi.fn(async () => ({})),
  resume: vi.fn(async () => ({})),
}));

vi.mock("../api/hooks", () => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  return {
    useDeck: () => query(fx.deck),
    usePlayers: () => query(fx.players),
    useSubmitMatchPrompt: () => ({ mutateAsync: fx.submitPrompt, isPending: false }),
    useHalftime: () => ({ mutateAsync: fx.halftime, isPending: false }),
    useResume: () => ({ mutateAsync: fx.resume, isPending: false }),
  };
});

// eslint-disable-next-line import/first
import { HalftimePanel } from "./HalftimePanel";
// eslint-disable-next-line import/first
import { stubDraftHandle } from "./halftime-draft-fixture";

/** 전반에 쓴 전술 — 라인 낮게(0.25), 나머지 보통. */
const FIRST_HALF_TACTICS = { line: 0.25, press: 0.5, tempo: 0.5, width: 0.5 };

function renderPanel(teamTactics: typeof FIRST_HALF_TACTICS | undefined = FIRST_HALF_TACTICS) {
  const match = {
    id: "m1",
    state: "HALFTIME",
    clock: null,
    userDeckSnapshot: teamTactics
      ? { formation: "4-4-2", starters: [], bench: [], teamTactics }
      : null,
  };
  return render(h(HalftimePanel, { match: match as never, draft: stubDraftHandle() }));
}

function halftimeBody(): { substitutions: unknown[]; teamTactics?: Record<string, number> } {
  const calls = fx.halftime.mock.calls as unknown as Array<
    [{ substitutions: unknown[]; teamTactics?: Record<string, number> }]
  >;
  return calls[calls.length - 1]![0];
}

afterEach(() => {
  cleanup();
  fx.halftime.mockClear();
  fx.resume.mockClear();
  fx.submitPrompt.mockClear();
});

/**
 * ⚠️ #244 로 감독시간이 **덱 화면과 같은 에디터**를 쓰게 되면서 전술 다이얼의 자리가 바뀌었다:
 * 전용 `halftime-tactics-*` 섹션 → **지시 레일의 ⚙ 세부 조정**(덱과 같은 `tactics-*` testid).
 * 계약 자체는 그대로다 — 시작점 = 전반 값 · 안 만지면 미전송 · 만지면 4축 전부 전송.
 * 다이얼이 접혀 있으므로 각 테스트는 ⚙ 를 먼저 편다(덱 화면과 같은 동선).
 */
function openTune() {
  fireEvent.click(screen.getByTestId("team-tune-toggle"));
}

describe("HalftimePanel — 팀 전술 (#254)", () => {
  it("다이얼 시작점은 전반에 쓴 값이다 (중립으로 리셋하지 않는다)", () => {
    renderPanel();
    openTune();
    const line = screen.getByTestId("tactics-line");
    // 0.25 = 5스텝 중 1번(낮음). 중립(0.5=2번)에서 시작하면 안 건드린 유저가 후반에 라인을 올려버린다.
    expect(line.getAttribute("data-value")).toBe("0.25");
    expect(line.getAttribute("data-step")).toBe("1");
  });

  it("전술을 안 건드리면 teamTactics 를 아예 보내지 않는다 (콜0 유지)", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("resume-button"));
    await waitFor(() => expect(fx.halftime).toHaveBeenCalledTimes(1));
    expect(halftimeBody().teamTactics).toBeUndefined();
    expect(fx.resume).toHaveBeenCalledTimes(1);
  });

  it("스텝을 누르면 그 값이 halftime 바디로 나간다", async () => {
    renderPanel();
    // 라인 "매우높음"(4번 = 1.0) — 후반에 라인을 끌어올린다.
    openTune();
    fireEvent.click(screen.getByTestId("tactics-line-step-4"));
    expect(screen.getByTestId("tactics-line").getAttribute("data-value")).toBe("1");

    fireEvent.click(screen.getByTestId("resume-button"));
    await waitFor(() => expect(fx.halftime).toHaveBeenCalledTimes(1));
    // 건드린 축만이 아니라 4축 전부 보낸다 — 서버 TeamTactics 는 4축 필수다.
    expect(halftimeBody().teamTactics).toEqual({ line: 1, press: 0.5, tempo: 0.5, width: 0.5 });
  });

  it("스냅샷이 없는 구 매치는 중립에서 시작한다(500 대신 기본값)", () => {
    renderPanel(undefined);
    openTune();
    expect(screen.getByTestId("tactics-press").getAttribute("data-value")).toBe("0.5");
  });
});
