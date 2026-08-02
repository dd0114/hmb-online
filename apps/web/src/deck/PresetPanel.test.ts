// @vitest-environment jsdom
/**
 * #73 P0 — 프리셋 생성 실패 시 작성 내용이 유실되면 안 되고(입력 유지), 에러가 보여야 한다.
 * 성공 시에만 입력을 비운다. (JSX 없이 createElement — 루트 include 패턴이 *.test.ts 이므로.)
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetPanel } from "./PresetPanel";
import { emptyDraft, type DeckDraft } from "./deck-logic";
import type { CatalogPlayer } from "../api/hooks";

afterEach(cleanup);

function renderPanel(onCreate: (n: string, b: string) => Promise<void>) {
  return render(
    h(PresetPanel, {
      presets: [],
      draft: emptyDraft(),
      playersById: new Map(),
      creating: false,
      onCreate,
      onDelete: () => Promise.resolve(),
      onBulkApply: () => {},
    }),
  );
}

function fillForm() {
  fireEvent.change(screen.getByTestId("preset-name"), { target: { value: "공격적" } });
  fireEvent.change(screen.getByTestId("preset-body"), { target: { value: "압박 강하게" } });
}

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const KNOWN = {
  id: "P001", name: "레프 야신", shortName: "야신", position: "GK", grade: "LEGEND",
  owned: true, ownedCount: 1, attributes: attrs(80), personality: "CALM",
} as unknown as CatalogPlayer;

/**
 * #406 W1b — 일괄 적용 목록의 **선수명 사다리**.
 *
 * <p>구 코드는 `playersById.get(...)` 결과를 `.filter(Boolean)` 으로 걸러 <b>카탈로그 미상 선수를
 * 목록에서 통째로 지웠다</b>. 덱에는 앉아 있는데 목록엔 없으니, 유저는 그 선수에게만 프리셋이
 * 안 걸린 것을 알 방법이 없다. 그리고 이름은 `player.name` 직독이라 초크포인트 밖이었다.
 *
 * <p>이 패널은 오늘 렌더되지 않는다(#106 R1) — 그래서 더더욱 계약이 필요하다. 되돌리는 사람이
 * 우회를 <b>초록인 채로</b> 부활시키는 자리가 정확히 이런 파일이다.
 */
describe("PresetPanel 일괄 적용 목록 — 이름 사다리 (#406 W1b)", () => {
  const draft = {
    ...emptyDraft("4-4-2"),
    slots: [
      { playerId: KNOWN.id, role: "starter", slotIndex: 0, promptText: "" },
      { playerId: "P999", role: "bench", slotIndex: 0, promptText: "" },
    ],
  } as DeckDraft;

  const PRESET = { id: "pr1", name: "공격적", promptText: "압박 강하게" } as never;

  function renderList(onBulkApply: (ids: string[], text: string) => void = () => {}) {
    return render(
      h(PresetPanel, {
        presets: [PRESET],
        draft,
        playersById: new Map([[KNOWN.id, KNOWN]]),
        creating: false,
        onCreate: () => Promise.resolve(),
        onDelete: () => Promise.resolve(),
        onBulkApply,
      }),
    );
  }

  it("카탈로그 미상 선수도 목록에 남는다 — `미상 선수`, playerId 노출 0", () => {
    renderList();
    // ★ 변이: `.filter(Boolean(x.player))` 를 되살리면 이 줄이 통째로 사라진다.
    expect(screen.getByTestId("bulk-check-P999")).toBeTruthy();
    expect(screen.getByText("미상 선수")).toBeTruthy();
    expect(screen.queryByText(/P999/)).toBeNull();
  });

  it("밀집 UI 라 짧은 이름 축을 쓴다", () => {
    renderList();
    // ★ 변이: `full` 로 바꾸거나 `player.name` 직독으로 되돌리면 `레프 야신` 이 뜬다.
    expect(screen.getByText("야신")).toBeTruthy();
    expect(screen.queryByText("레프 야신")).toBeNull();
  });

  it("체크·적용 대상은 슬롯의 playerId 다 — 미상 선수에게도 프리셋이 걸린다", () => {
    const applied: Array<[string[], string]> = [];
    renderList((ids, text) => applied.push([ids, text]));
    fireEvent.click(screen.getByTestId("bulk-check-P999"));
    fireEvent.change(screen.getByTestId("bulk-preset-select"), { target: { value: "pr1" } });
    fireEvent.click(screen.getByTestId("preset-bulk-apply"));
    // 구 코드는 `player.id`(카탈로그 행) 기준이라 미상 선수는 애초에 여기 도달할 수 없었다.
    expect(applied).toEqual([[["P999"], "압박 강하게"]]);
  });
});

describe("PresetPanel create resilience (#73 P0)", () => {
  it("retains inputs and shows an error when create fails", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("서버 오류"));
    renderPanel(onCreate);
    fillForm();
    fireEvent.click(screen.getByTestId("preset-create"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect((screen.getByTestId("preset-name") as HTMLInputElement).value).toBe("공격적");
    expect((screen.getByTestId("preset-body") as HTMLTextAreaElement).value).toBe("압박 강하게");
    expect(onCreate).toHaveBeenCalledWith("공격적", "압박 강하게");
  });

  it("clears inputs only after a successful create", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderPanel(onCreate);
    fillForm();
    fireEvent.click(screen.getByTestId("preset-create"));

    await waitFor(() =>
      expect((screen.getByTestId("preset-name") as HTMLInputElement).value).toBe(""),
    );
    expect((screen.getByTestId("preset-body") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
