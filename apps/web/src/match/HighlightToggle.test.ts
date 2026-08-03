// @vitest-environment jsdom
/**
 * `HighlightToggle` 의 **접근성 계약** (독립검증 N5).
 *
 * 지키려는 것 하나: **버튼의 세 축이 한 곳을 가리킨다.**
 *  · 접근성 이름 = **고정**(`하이라이트 모드`)
 *  · `aria-pressed` = 하이라이트가 켜져 있나(= 보이는 글자의 `ON`/`OFF` 와 같은 축)
 *  · `hint`(누르면 뭐가 되나) = **설명**이라 `title` 로만 나간다
 *
 * 구 동작은 `aria-label={view.hint}` 라 **이름이 액션 문장**이었고, 그게 상태를 말하는
 * `aria-pressed` 와 갈렸다 — 꺼진 상태에서 스크린리더는 *"…전부 재생합니다…, 안 눌림"* 인데
 * 화면은 실제로 전체 재생 **중**이었다. 순수 모듈 쪽(라벨 주어·상태 표기)은
 * `highlight-sequencer.test.ts` 의 `N5` 가 잡고, 여기서는 **DOM 에 실제로 나가는 속성**을 잡는다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다(HalfReportModal.test 동일).
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HighlightToggle } from "./HighlightToggle";
import { highlightToggleView } from "./highlight-sequencer";

afterEach(cleanup);

function mount(enabled: boolean) {
  const onToggle = vi.fn();
  render(
    h(HighlightToggle, {
      view: highlightToggleView({ available: true, enabled, total: 8 }),
      onToggle,
    }),
  );
  return { btn: screen.getByTestId("highlight-toggle"), onToggle };
}

describe("N5 — 라벨과 aria-pressed 의 의미축이 하나다", () => {
  it("접근성 이름은 **상태에 따라 바뀌지 않는다**(액션 문장이 이름이 아니다)", () => {
    const on = mount(true).btn;
    const onName = on.getAttribute("aria-label");
    cleanup();
    const off = mount(false).btn;

    expect(onName).toBe("하이라이트 모드");
    expect(off.getAttribute("aria-label")).toBe(onName);
    // 변이: `aria-label={view.hint}` 로 되돌리면 이름이 상태마다 달라지며 여기서 죽는다.
    expect(off.getAttribute("aria-label")).not.toContain("누르면");
  });

  it("`aria-pressed` 는 보이는 `ON`/`OFF` 와 같은 것을 말한다", () => {
    const on = mount(true).btn;
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.textContent).toContain("ON");
    cleanup();

    const off = mount(false).btn;
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(off.textContent).toContain("OFF");
    /*
     * 구 라벨(`▶ 전체 보기` + `aria-pressed=false`)이 정확히 이 모순이었다 —
     * "전체 보기가 안 눌렸다"고 말하면서 실제로는 전체 보기 중.
     */
    expect(off.textContent).not.toContain("전체 보기");
  });

  it("액션 설명은 `title` 로만 나간다(이름 자리를 뺏지 않는다)", () => {
    const off = mount(false).btn;
    expect(off.getAttribute("title")).toContain("누르면");
    expect(off.getAttribute("title")).not.toBe(off.getAttribute("aria-label"));
  });

  it("숨김 상태에서는 렌더 자체가 없다(끄는 유일한 경로라 available 일 때만 사라진다)", () => {
    render(
      h(HighlightToggle, {
        view: highlightToggleView({ available: false, enabled: true }),
        onToggle: vi.fn(),
      }),
    );
    expect(screen.queryByTestId("highlight-toggle")).toBeNull();
  });
});
