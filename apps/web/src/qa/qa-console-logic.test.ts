// QA 콘솔 화면 로직 계약 (#191). hero 의 판정 창구라 "눌렀는데 아무 일도 안 난다"를 여기서 막는다.
import { describe, expect, it } from "vitest";
import {
  ackLabel,
  canSubmit,
  clockOf,
  headerCounts,
  resolveSelection,
  sortTabs,
  statusLabel,
  submitPayload,
  tabFromSearch,
  type QaTabView,
} from "./qa-console-logic";

function view(over: Partial<QaTabView["tab"]> & { unread?: number; stale?: boolean } = {}): QaTabView {
  const { unread = 0, stale = false, ...tab } = over;
  return {
    tab: {
      tabId: "182-corner-stay",
      issue: 182,
      title: "코너 잔류",
      session: "hmb:bug182",
      checkout: "/x",
      branch: "bug/182",
      status: "waiting",
      summary: "",
      ask: "",
      views: [{ id: "after", label: "after", logPath: "/x/a.json" }],
      watch: [],
      createdAt: "2026-07-26T04:00:00.000Z",
      updatedAt: "2026-07-26T04:00:00.000Z",
      ...tab,
    },
    feedbackCount: 0,
    unread,
    lastFeedbackAt: null,
    ackCursor: 0,
    ackItems: {},
    idleMs: 0,
    stale,
  };
}

describe("statusLabel", () => {
  it("상태별 문구", () => {
    expect(statusLabel(view({ status: "waiting" }))).toBe("대기중");
    expect(statusLabel(view({ status: "acked" }))).toBe("처리중");
    expect(statusLabel(view({ status: "resolved" }))).toBe("완료 ✓");
    expect(statusLabel(view({ status: "draft" }))).toBe("준비중");
  });

  it("stale 은 상태를 덮는다 — 세션이 죽었다는 신호가 먼저 보여야 한다", () => {
    expect(statusLabel(view({ status: "waiting", stale: true }))).toMatch(/응답 없음/);
  });
});

describe("sortTabs — hero 가 봐야 할 것이 위로", () => {
  it("내 확인 필요(waiting·미수신0) → 진행중 → 완료 순", () => {
    const list = [
      view({ tabId: "done-tab", status: "resolved" }),
      view({ tabId: "in-progress", status: "waiting", unread: 2 }),
      view({ tabId: "need-me", status: "waiting", unread: 0 }),
    ];
    expect(sortTabs(list).map((v) => v.tab.tabId)).toEqual(["need-me", "in-progress", "done-tab"]);
  });

  it("같은 급끼리는 최근 갱신 우선", () => {
    const list = [
      view({ tabId: "older", updatedAt: "2026-07-26T01:00:00.000Z" }),
      view({ tabId: "newer", updatedAt: "2026-07-26T09:00:00.000Z" }),
    ];
    expect(sortTabs(list).map((v) => v.tab.tabId)).toEqual(["newer", "older"]);
  });

  it("입력 배열을 변형하지 않는다(폴링마다 원본을 흔들지 않게)", () => {
    const list = [view({ tabId: "b-tab", status: "resolved" }), view({ tabId: "a-tab" })];
    const before = list.map((v) => v.tab.tabId);
    sortTabs(list);
    expect(list.map((v) => v.tab.tabId)).toEqual(before);
  });
});

describe("headerCounts", () => {
  it("내 확인 필요 = waiting 이고 아직 아무 말도 안 한 탭", () => {
    const c = headerCounts([
      view({ tabId: "a-tab", status: "waiting", unread: 0 }),
      view({ tabId: "b-tab", status: "waiting", unread: 1 }),
      view({ tabId: "c-tab", status: "resolved" }),
      view({ tabId: "d-tab", status: "waiting", unread: 1, stale: true }),
    ]);
    expect(c).toEqual({ total: 4, waiting: 3, needMe: 1, stale: 1 });
  });
});

describe("canSubmit — 규약은 얇게(D9)", () => {
  it("거부는 사유 필수", () => {
    expect(canSubmit("reject", "")).toBe(false);
    expect(canSubmit("reject", "   ")).toBe(false);
    expect(canSubmit("reject", "뭉침 먼저")).toBe(true);
  });

  it("승인은 태그만 눌러도 된다", () => {
    expect(canSubmit("approve", "")).toBe(true);
  });

  it("그냥 전달은 할 말이 있어야 한다", () => {
    expect(canSubmit("comment", "")).toBe(false);
    expect(canSubmit("comment", "3명이 뭉쳐 있다")).toBe(true);
  });
});

describe("submitPayload", () => {
  it("보던 장면을 첨부한다", () => {
    expect(submitPayload({ verdict: "reject", body: " 뭉침 ", view: "after", tick: 760.4, attach: true })).toEqual({
      verdict: "reject",
      body: "뭉침",
      view: "after",
      tick: 760,
    });
  });

  it("첨부를 끄면 장면을 안 보낸다", () => {
    expect(submitPayload({ verdict: "comment", body: "전반 인상", view: "after", tick: 760, attach: false })).toEqual({
      verdict: "comment",
      body: "전반 인상",
    });
  });

  it("틱이 없으면 뷰만 붙는다(로드 전에 눌러도 깨지지 않게)", () => {
    expect(submitPayload({ verdict: "approve", body: "", view: "after", tick: null, attach: true })).toEqual({
      verdict: "approve",
      body: "",
      view: "after",
    });
  });
});

describe("ackLabel", () => {
  it("항목 상태가 있으면 그것을 보여준다", () => {
    expect(ackLabel(1, { cursor: 1, items: { 1: { state: "working", note: "재현 중", at: "" } } })).toBe(
      "세션 수신 ✓ 처리중 — 재현 중",
    );
    expect(ackLabel(1, { cursor: 1, items: { 1: { state: "done", note: null, at: "" } } })).toBe("세션 수신 ✓ 완료");
  });

  it("커서만 지나갔으면 수신으로 본다", () => {
    expect(ackLabel(1, { cursor: 2, items: {} })).toBe("세션 수신 ✓");
  });

  it("아직이면 미수신 — hero 가 '전달됐나'를 알 수 있어야 한다", () => {
    expect(ackLabel(3, { cursor: 2, items: {} })).toBe("세션 미수신");
  });
});

describe("clockOf", () => {
  it("틱을 분:초로", () => {
    expect(clockOf(0)).toBe("0'00\"");
    expect(clockOf(754)).toBe("12'34\"");
    expect(clockOf(null)).toBe("-");
    expect(clockOf(Number.NaN)).toBe("-");
  });
});

describe("딥링크·선택 유지", () => {
  it("?tab= 을 읽는다", () => {
    expect(tabFromSearch("?tab=182-corner-stay")).toBe("182-corner-stay");
    expect(tabFromSearch("?other=1")).toBeNull();
    expect(tabFromSearch("")).toBeNull();
  });

  it("폴링으로 목록이 갱신돼도 보던 탭을 유지한다 — 선택이 튀면 판정을 잃는다", () => {
    const views = [view({ tabId: "a-tab" }), view({ tabId: "b-tab", status: "resolved" })];
    expect(resolveSelection(views, null, "b-tab")).toBe("b-tab");
  });

  it("보던 탭이 사라지면 딥링크 → 정렬 첫 항목으로 떨어진다", () => {
    const views = [view({ tabId: "a-tab", status: "resolved" }), view({ tabId: "need-me", unread: 0 })];
    expect(resolveSelection(views, "a-tab", "gone-tab")).toBe("a-tab");
    expect(resolveSelection(views, null, "gone-tab")).toBe("need-me");
  });

  it("탭이 없으면 null(콘솔이 빈 상태를 그린다)", () => {
    expect(resolveSelection([], "x", "y")).toBeNull();
  });
});
