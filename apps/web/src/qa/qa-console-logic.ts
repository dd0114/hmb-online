// QA 콘솔 화면 로직 — 순수(React/DOM 의존 0). #191
//
// 화면에서 판단이 갈리는 부분만 여기로 뺀다: 상태 배지 · 정렬 · 전송 payload · 전송 가능 여부.
// 콘솔은 hero 의 판정 창구라 "버튼이 눌리는데 아무 일도 안 난다"가 가장 나쁘다 → 그 조건을 테스트로 박는다.

/** 서버 `/qa-api/tabs` 의 한 항목. 필드 근거 = docs/plan-v5/qa-console.md §3.2. */
export interface QaTab {
  tabId: string;
  issue: number | null;
  title: string;
  session: string | null;
  checkout: string | null;
  branch: string | null;
  status: "draft" | "waiting" | "acked" | "resolved";
  summary: string;
  ask: string;
  views: { id: string; label: string; logPath: string }[];
  watch: { tick: number | null; label: string; view?: string }[];
  createdAt: string;
  updatedAt: string;
  producer?: string;
}

export interface QaFeedback {
  seq: number;
  at: string;
  verdict: "comment" | "approve" | "reject";
  body: string;
  view?: string;
  tick?: number;
  clock?: string;
}

export interface QaAck {
  cursor: number;
  items: Record<string, { state: string; note: string | null; at: string }>;
  updatedAt: string | null;
}

export interface QaTabView {
  tab: QaTab;
  feedbackCount: number;
  unread: number;
  lastFeedbackAt: string | null;
  ackCursor: number;
  ackItems: QaAck["items"];
  idleMs: number;
  stale: boolean;
}

/** 좌측 목록의 상태 칩 문구. stale 은 "세션이 죽었다"는 신호라 상태보다 먼저 보여야 한다. */
export function statusLabel(v: Pick<QaTabView, "stale"> & { tab: Pick<QaTab, "status"> }): string {
  if (v.stale) return "⚠ 세션 응답 없음";
  switch (v.tab.status) {
    case "waiting":
      return "대기중";
    case "acked":
      return "처리중";
    case "resolved":
      return "완료 ✓";
    default:
      return "준비중";
  }
}

/**
 * 목록 정렬: **hero 가 봐야 할 것이 위로**.
 * ① 내 확인이 필요한 것(waiting 이고 미수신 피드백 0 = 아직 아무 말도 안 한 탭)
 * ② 그 외 진행중  ③ 완료
 * 같은 급끼리는 최근 갱신 우선.
 */
export function sortTabs(views: QaTabView[]): QaTabView[] {
  const rank = (v: QaTabView) => {
    if (v.tab.status === "resolved") return 2;
    if (v.tab.status === "waiting" && v.unread === 0) return 0;
    return 1;
  };
  return [...views].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Date.parse(b.tab.updatedAt) - Date.parse(a.tab.updatedAt);
  });
}

/** 상단 집계 — "내가 봐야 할 게 몇 개인가"가 hero 의 첫 질문이다. */
export function headerCounts(views: QaTabView[]) {
  return {
    total: views.length,
    waiting: views.filter((v) => v.tab.status === "waiting").length,
    needMe: views.filter((v) => v.tab.status === "waiting" && v.unread === 0).length,
    stale: views.filter((v) => v.stale).length,
  };
}

/**
 * 전송 가능 여부. **거부만 사유 필수**(사유 없는 거부는 세션이 뭘 할지 모른다).
 * 승인·전달은 태그만 눌러도 유효하다(D9 — 규약은 얇게).
 */
export function canSubmit(verdict: QaFeedback["verdict"], body: string): boolean {
  if (verdict === "reject") return body.trim() !== "";
  if (verdict === "approve") return true;
  return body.trim() !== ""; // 그냥 전달은 할 말이 있어야 의미가 있다
}

/** 전송 payload. `attach` 가 켜져 있으면 지금 보던 장면(뷰·틱)을 같이 보낸다. */
export function submitPayload(args: {
  verdict: QaFeedback["verdict"];
  body: string;
  view: string | null;
  tick: number | null;
  attach: boolean;
}) {
  const out: { verdict: string; body: string; view?: string; tick?: number } = {
    verdict: args.verdict,
    body: args.body.trim(),
  };
  if (args.attach) {
    if (args.view) out.view = args.view;
    if (args.tick != null && Number.isFinite(args.tick)) out.tick = Math.max(0, Math.round(args.tick));
  }
  return out;
}

/** 피드백 1건의 세션 처리 상태 표시. */
export function ackLabel(seq: number, ack: Pick<QaAck, "cursor" | "items">): string {
  const item = ack.items?.[String(seq)];
  if (item) {
    const state =
      item.state === "done" ? "완료" : item.state === "working" ? "처리중" : item.state === "skipped" ? "보류" : "수신";
    return `세션 수신 ✓ ${state}${item.note ? ` — ${item.note}` : ""}`;
  }
  if ((ack.cursor ?? 0) >= seq) return "세션 수신 ✓";
  return "세션 미수신";
}

/** 틱 → `12'34"`. 엔진 1틱 = 1 게임초(qa-time-controls.TICK_PER_SECOND). */
export function clockOf(tick: number | null | undefined): string {
  if (tick == null || !Number.isFinite(tick)) return "-";
  const t = Math.max(0, Math.round(tick));
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, "0")}"`;
}

/** `?tab=<id>` 딥링크 — 세션이 register 출력 URL 로 hero 를 정확한 탭에 보낸다. */
export function tabFromSearch(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get("tab");
    return v && v.trim() !== "" ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 지금 선택돼 있어야 할 탭. 딥링크 > 이전 선택 > 정렬 첫 항목.
 * 폴링으로 목록이 갱신될 때 **선택이 튀지 않아야** 한다(hero 가 보던 게 바뀌면 판정을 잃는다).
 */
export function resolveSelection(views: QaTabView[], deepLink: string | null, current: string | null): string | null {
  const has = (id: string | null) => id != null && views.some((v) => v.tab.tabId === id);
  if (has(current)) return current;
  if (has(deepLink)) return deepLink;
  const first = sortTabs(views)[0];
  return first ? first.tab.tabId : null;
}
