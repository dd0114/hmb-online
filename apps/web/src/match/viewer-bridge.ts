// 부모(iframe host) 쪽 뷰어 브리지 프로토콜 — 순수 로직만(React/DOM 의존 0, 단위검증 대상).
// iframe(viewer-embed.html) 쪽 브리지는 apps/web/scripts/build-viewer.mjs 가 주입한다.
//
// 계약:
//   iframe → parent : { type: "viewerReady" }            (뷰어 로드 완료, 로그 주입 받을 준비)
//   parent → iframe : { type: "loadMatchLog", matchLog, skins? } (해당 half MatchLog 주입,
//                     skins = 경기장 캐릭터 스킨 #145 — optional additive)
//   parent → iframe : { type: "setViewerChrome", mode }   (#148 뷰어 내부 컨트롤 표시/숨김)
//   parent → iframe : { type: "viewerControl", cmd: "highlight", on } (#148 하이라이트 연출 on/off)
//   iframe → parent : { type: "viewerState", playing, speed, ended, auto } (#148 상태 미러링)
//
// #148: 플레이 모드에선 뷰어 내부 컨트롤(재생/일시정지·배속·되감기·프레임점프·스크럽·배율·
// 디버그 토글)을 전부 숨긴다. 경기는 **자동 진행**하고 유일한 컨트롤은 **하이라이트 토글**이다
// (hero 재지시). 뷰어(dev-viewer) 원본은 무수정 — 크롬 CSS·명령 핸들러는
// apps/web/scripts/build-viewer.mjs 가 주입하는 브리지가 담당한다.
//
// 레이스: viewerReady 와 half 로그(useHalfLog) 는 어느 쪽이 먼저 올지 모른다.
// 그래서 "둘 다 준비 && 아직 안 보냄" 일 때만 주입한다(shouldPostLog / bridgeReducer).

import { type ControlMode } from "./playback-controls";

/** iframe src (vite public → 루트 서빙). 생성물 = apps/web/scripts/build-viewer.mjs. */
export const VIEWER_EMBED_SRC = "/viewer-embed.html";

export interface ViewerReadyMessage {
  type: "viewerReady";
}
export interface LoadMatchLogMessage {
  type: "loadMatchLog";
  matchLog: unknown;
  /**
   * 경기장 캐릭터 스킨(#145) — **optional additive**. 없으면 뷰어가 현행 단색 원으로 그린다
   * (구버전 뷰어 아티팩트와도 호환: 모르는 필드는 무시된다).
   */
  skins?: unknown;
}

/** iframe 이 보낸 viewerReady 메시지인지 판별(다른 postMessage 소음과 구분). */
export function isViewerReadyMessage(data: unknown): data is ViewerReadyMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "viewerReady"
  );
}

/** parent → iframe 주입 메시지 생성. skins 는 있을 때만 실어 보낸다(무회귀). */
export function loadMatchLogMessage(matchLog: unknown, skins?: unknown): LoadMatchLogMessage {
  return skins ? { type: "loadMatchLog", matchLog, skins } : { type: "loadMatchLog", matchLog };
}

// ── #148 컨트롤 크롬/명령 ────────────────────────────────────────────────────
export interface SetChromeMessage {
  type: "setViewerChrome";
  mode: ControlMode;
}

export type ViewerCommand = "highlight";

export interface ViewerControlMessage {
  type: "viewerControl";
  cmd: ViewerCommand;
  /** 하이라이트 연출(주요장면 슬로우·접촉 줌) 켜기/끄기. */
  on: boolean;
}

export interface ViewerStateMessage {
  type: "viewerState";
  playing: boolean;
  speed: number;
  ended: boolean;
  /** 하이라이트 자동페이싱(뷰어 Highlights) 여부 — true 면 speed 는 무시된다. */
  auto: boolean;
}

/** 뷰어 내부 컨트롤 표시 모드 지시(play=숨김, full=노출). */
export function setChromeMessage(mode: ControlMode): SetChromeMessage {
  return { type: "setViewerChrome", mode };
}

/**
 * 하이라이트 연출 on/off 명령. 플레이 모드의 **유일한** 컨트롤이다
 * (재생/일시정지·배속 명령은 없다 — 경기는 자동 진행).
 */
export function highlightMessage(on: boolean): ViewerControlMessage {
  return { type: "viewerControl", cmd: "highlight", on };
}

/** iframe 이 보낸 재생 상태 미러링 메시지인지(필드 타입까지 검증). */
export function isViewerStateMessage(data: unknown): data is ViewerStateMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Partial<ViewerStateMessage>;
  return (
    d.type === "viewerState" &&
    typeof d.playing === "boolean" &&
    typeof d.speed === "number" &&
    typeof d.ended === "boolean" &&
    typeof d.auto === "boolean"
  );
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

/**
 * iframe 이 마운트 후 이 시간(ms) 안에 viewerReady 를 안 보내면 폴백한다.
 * onError 로 못 잡는 케이스 방어: vite SPA-fallback 이 없는 viewer-embed.html 요청에
 * index.html(HTTP 200)을 돌려주면 iframe 은 "로드 성공"이라 onError 가 안 뜨고 앱이
 * iframe 안에 재귀 렌더된다. 그 페이지엔 브리지가 없어 viewerReady 가 영영 안 온다 → 타임아웃 감지.
 */
export const VIEWER_READY_TIMEOUT_MS = 4000;

/** 타임아웃 만료 시점에 아직 viewerReady 가 아니면 타임라인으로 폴백해야 한다. */
export function shouldFallbackAfterTimeout(viewerReady: boolean): boolean {
  return !viewerReady;
}
