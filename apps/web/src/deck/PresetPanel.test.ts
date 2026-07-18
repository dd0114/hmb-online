// @vitest-environment jsdom
/**
 * #73 P0 — 프리셋 생성 실패 시 작성 내용이 유실되면 안 되고(입력 유지), 에러가 보여야 한다.
 * 성공 시에만 입력을 비운다. (JSX 없이 createElement — 루트 include 패턴이 *.test.ts 이므로.)
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetPanel } from "./PresetPanel";
import { emptyDraft } from "./deck-logic";

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
