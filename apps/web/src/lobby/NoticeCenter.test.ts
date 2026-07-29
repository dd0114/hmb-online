// @vitest-environment jsdom
/**
 * 공지 다시 보기 진입점 계약 (#248 UX 후속).
 *
 * 이 화면이 존재하는 **유일한 이유**를 계약으로 박는다:
 *  ① [24시간 안 보기]를 눌러 팝업에서 사라진 공지도 **목록에는 있다**
 *  ② 안 읽음 점은 억제를 본다(다 읽으면 꺼진다)
 *  ③ 본문은 **팝업과 같은 렌더러**를 쓴다(서식·살균이 갈라지지 않는다)
 *  ④ 공지 0건이면 진입점 자체가 없다(빡빡한 헤더를 빈 버튼이 차지하지 않는다)
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoticeCenter } from "./NoticeCenter";
import { markNoticeClosed, markNoticeDismissed, type NoticeStores } from "./notice-logic";

afterEach(cleanup);

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const NOW = 1_800_000_000_000;
let stores: NoticeStores;
beforeEach(() => {
  stores = { session: memStorage(), local: memStorage() };
});

function notice(id: string, extra: Record<string, unknown> = {}) {
  return { id, revision: 1, title: `${id} 제목`, body: `${id} 본문`, priority: 0, ...extra };
}

function mount(raw: unknown) {
  render(h(NoticeCenter, { notices: raw, stores, now: () => NOW }));
}

describe("NoticeCenter — 진입점", () => {
  it("활성 공지가 0건이면 아무것도 그리지 않는다", () => {
    mount({ notices: [] });
    expect(screen.queryByTestId("notice-center-open")).toBeNull();
  });

  it("응답이 이상해도(구 서버 `{}`·비배열·null) 진입점 없이 조용히 넘어간다", () => {
    for (const bad of [{}, { notices: "곧" }, null, [{ id: "A" }]]) {
      cleanup();
      mount(bad);
      expect(screen.queryByTestId("notice-center-open")).toBeNull();
    }
  });

  it("공지가 있으면 진입점이 뜨고, 안 읽음 수를 점으로 알린다", () => {
    mount({ notices: [notice("A"), notice("B")] });
    const btn = screen.getByTestId("notice-center-open");
    expect(btn.getAttribute("data-unread")).toBe("2");
    expect(screen.getByTestId("notice-center-dot")).toBeTruthy();
  });
});

describe("NoticeCenter — 억제는 팝업에만 적용된다", () => {
  it("**24시간 안 보기를 누른 공지도 목록에 보인다** (이 기능의 존재 이유)", () => {
    markNoticeDismissed(stores, "A@1", NOW);
    mount({ notices: [notice("A"), notice("B")] });

    // 진입점은 살아 있고, 점은 안 읽은 1건만 센다.
    expect(screen.getByTestId("notice-center-open").getAttribute("data-unread")).toBe("1");

    fireEvent.click(screen.getByTestId("notice-center-open"));
    const items = screen.getAllByTestId("notice-center-item");
    // ⚠️ 변이체: 목록을 `visibleNotices` 로 바꾸면 여기가 1건이 되며 깨진다.
    expect(items.map((li) => li.getAttribute("data-id"))).toEqual(["A", "B"]);
    // 억제된 A 에는 안 읽음 점이 없다(억제 상태는 그대로 반영된다).
    expect(screen.getAllByTestId("notice-center-item-dot")).toHaveLength(1);
  });

  it("전부 억제돼 팝업이 안 뜨는 상태에서도 목록은 열린다", () => {
    markNoticeDismissed(stores, "A@1", NOW);
    markNoticeDismissed(stores, "B@1", NOW);
    mount({ notices: [notice("A"), notice("B")] });

    expect(screen.getByTestId("notice-center-open").getAttribute("data-unread")).toBe("0");
    expect(screen.queryByTestId("notice-center-dot")).toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-open"));
    expect(screen.getAllByTestId("notice-center-item")).toHaveLength(2);
  });
});

describe("NoticeCenter — 읽기", () => {
  it("펼치면 본문이 **팝업과 같은 렌더러**로 그려진다(서식이 살아 있다)", () => {
    mount({ notices: [notice("A", { body: "**굵게** 안내\n\n- 항목" })] });
    fireEvent.click(screen.getByTestId("notice-center-open"));

    expect(screen.queryByTestId("notice-center-body")).toBeNull();
    fireEvent.click(screen.getAllByTestId("notice-center-item-toggle")[0]!);

    const body = screen.getByTestId("notice-center-body");
    expect(body.querySelector("strong")?.textContent).toBe("굵게");
    expect(body.querySelectorAll("ul li")).toHaveLength(1);
  });

  it("펼쳐 읽으면 안 읽음 점이 그 자리에서 꺼진다", () => {
    mount({ notices: [notice("A"), notice("B")] });
    fireEvent.click(screen.getByTestId("notice-center-open"));
    expect(screen.getAllByTestId("notice-center-item-dot")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("notice-center-item-toggle")[0]!);
    expect(screen.getAllByTestId("notice-center-item-dot")).toHaveLength(1);
    expect(screen.getByTestId("notice-center-open").getAttribute("data-unread")).toBe("1");
  });

  it("다시 누르면 접힌다 — 접는다고 읽음이 취소되지는 않는다", () => {
    mount({ notices: [notice("A")] });
    fireEvent.click(screen.getByTestId("notice-center-open"));
    const toggle = screen.getAllByTestId("notice-center-item-toggle")[0]!;

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("notice-center-item-dot")).toBeNull();
  });

  it("한 번에 한 장만 펼쳐진다", () => {
    mount({ notices: [notice("A"), notice("B")] });
    fireEvent.click(screen.getByTestId("notice-center-open"));
    const toggles = screen.getAllByTestId("notice-center-item-toggle");

    fireEvent.click(toggles[0]!);
    fireEvent.click(toggles[1]!);
    expect(screen.getAllByTestId("notice-center-body")).toHaveLength(1);
    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("true");
  });

  /**
   * ⚠️ 억제 저장소의 **쓰는 쪽이 여럿**이다(공지 팝업의 [닫기]/[24시간]). 자기 쓰기만 반영하면
   * "팝업에서 다 닫았는데 헤더 점이 그대로"가 된다 — e2e 가 실제로 그 상태를 잡았다.
   * 구독(`subscribeNoticeSuppression`)을 되돌리면 이 계약이 죽는다.
   */
  it("다른 화면(팝업)이 억제를 기록해도 헤더의 점이 따라온다", () => {
    mount({ notices: [notice("A"), notice("B")] });
    expect(screen.getByTestId("notice-center-open").getAttribute("data-unread")).toBe("2");

    act(() => markNoticeClosed(stores, "A@1"));
    expect(screen.getByTestId("notice-center-open").getAttribute("data-unread")).toBe("1");

    act(() => markNoticeDismissed(stores, "B@1", NOW));
    expect(screen.getByTestId("notice-center-open").getAttribute("data-unread")).toBe("0");
    expect(screen.queryByTestId("notice-center-dot")).toBeNull();
  });

  it("열자마자 포커스는 [닫기] 다 — 본문 링크로 Enter 이탈하지 않는다", () => {
    mount({ notices: [notice("A", { body: "[외부](https://example.test)" })] });
    fireEvent.click(screen.getByTestId("notice-center-open"));
    expect(document.activeElement).toBe(screen.getByTestId("notice-center-close"));
  });
});
