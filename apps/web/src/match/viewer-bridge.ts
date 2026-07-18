// 부모(iframe host) 쪽 뷰어 브리지 프로토콜 — 순수 로직만(React/DOM 의존 0, 단위검증 대상).
// iframe(viewer-embed.html) 쪽 브리지는 apps/web/scripts/build-viewer.mjs 가 주입한다.
//
// 계약(2메시지):
//   iframe → parent : { type: "viewerReady" }            (뷰어 로드 완료, 로그 주입 받을 준비)
//   parent → iframe : { type: "loadMatchLog", matchLog }  (해당 half MatchLog 주입)
//
// 레이스: viewerReady 와 half 로그(useHalfLog) 는 어느 쪽이 먼저 올지 모른다.
// 그래서 "둘 다 준비 && 아직 안 보냄" 일 때만 주입한다(shouldPostLog / bridgeReducer).

/** iframe src (vite public → 루트 서빙). 생성물 = apps/web/scripts/build-viewer.mjs. */
export const VIEWER_EMBED_SRC = "/viewer-embed.html";

export interface ViewerReadyMessage {
  type: "viewerReady";
}
export interface LoadMatchLogMessage {
  type: "loadMatchLog";
  matchLog: unknown;
}

/** iframe 이 보낸 viewerReady 메시지인지 판별(다른 postMessage 소음과 구분). */
export function isViewerReadyMessage(data: unknown): data is ViewerReadyMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "viewerReady"
  );
}

/** parent → iframe 주입 메시지 생성. */
export function loadMatchLogMessage(matchLog: unknown): LoadMatchLogMessage {
  return { type: "loadMatchLog", matchLog };
}

// ── 시퀀스 상태머신 ──────────────────────────────────────────────────────────
export interface BridgeState {
  /** iframe 이 viewerReady 를 보냈는가. */
  viewerReady: boolean;
  /** 이 half 의 MatchLog 가 로드됐는가(useHalfLog 성공). */
  logLoaded: boolean;
  /** loadMatchLog 를 이미 주입했는가(중복 주입 방지). */
  posted: boolean;
}

export type BridgeEvent =
  | { kind: "reset" } // half 전환/재마운트 — 새 iframe 이므로 전부 초기화
  | { kind: "viewerReady" }
  | { kind: "logLoaded" }
  | { kind: "posted" };

export const initialBridgeState: BridgeState = {
  viewerReady: false,
  logLoaded: false,
  posted: false,
};

export function bridgeReducer(state: BridgeState, event: BridgeEvent): BridgeState {
  switch (event.kind) {
    case "reset":
      return { ...initialBridgeState };
    case "viewerReady":
      return { ...state, viewerReady: true };
    case "logLoaded":
      return { ...state, logLoaded: true };
    case "posted":
      return { ...state, posted: true };
    default:
      return state;
  }
}

/** 지금 로그를 주입해야 하는가 = 뷰어 준비 && 로그 준비 && 아직 미주입. */
export function shouldPostLog(state: BridgeState): boolean {
  return state.viewerReady && state.logLoaded && !state.posted;
}
