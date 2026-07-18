// @vitest-environment jsdom
/**
 * #73 P1 — 모달 접근성: role/aria-modal/aria-labelledby, 첫 포커스 이동,
 * Escape·백드롭 닫기(dismissable 토글). createElement(JSX 없음).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

afterEach(cleanup);

function renderModal(props: { dismissable?: boolean } = {}) {
  const onClose = vi.fn();
  render(
    h(
      Modal,
      {
        onClose,
        labelledBy: "t",
        overlayClassName: "ov",
        testId: "dlg",
        ...props,
      },
      h("h2", { id: "t" }, "제목"),
      h("button", { type: "button", "data-testid": "inside" }, "확인"),
    ),
  );
  return { onClose };
}

describe("Modal a11y (#73 P1)", () => {
  it("exposes dialog semantics and moves focus to the first control", () => {
    renderModal();
    const dlg = screen.getByTestId("dlg");
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.getAttribute("aria-labelledby")).toBe("t");
    expect(document.activeElement).toBe(screen.getByTestId("inside"));
  });

  it("closes on Escape and backdrop click when dismissable", () => {
    const { onClose } = renderModal({ dismissable: true });
    fireEvent.keyDown(screen.getByTestId("dlg"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector(".ov") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores Escape/backdrop and inside clicks when not dismissable", () => {
    const { onClose } = renderModal({ dismissable: false });
    fireEvent.keyDown(screen.getByTestId("dlg"), { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".ov") as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when clicking inside the dialog", () => {
    const { onClose } = renderModal({ dismissable: true });
    fireEvent.mouseDown(screen.getByTestId("inside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("restores focus to the previously focused element on close", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-testid", "trigger");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      h(
        Modal,
        { onClose: () => {}, labelledBy: "t", overlayClassName: "ov" },
        h("h2", { id: "t" }, "제목"),
        h("button", { type: "button", "data-testid": "inside" }, "확인"),
      ),
    );
    expect(document.activeElement).toBe(screen.getByTestId("inside"));

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("traps Tab focus within the dialog (wraps both directions)", () => {
    render(
      h(
        Modal,
        { onClose: () => {}, labelledBy: "t", overlayClassName: "ov", testId: "dlg" },
        h("h2", { id: "t" }, "제목"),
        h("button", { type: "button", "data-testid": "first" }, "처음"),
        h("button", { type: "button", "data-testid": "last" }, "끝"),
      ),
    );
    const dlg = screen.getByTestId("dlg");
    const first = screen.getByTestId("first");
    const last = screen.getByTestId("last");

    last.focus();
    fireEvent.keyDown(dlg, { key: "Tab" });
    expect(document.activeElement).toBe(first); // last → first

    first.focus();
    fireEvent.keyDown(dlg, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last); // shift+Tab first → last
  });
});
