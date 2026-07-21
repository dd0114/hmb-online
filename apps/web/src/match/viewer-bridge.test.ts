import { describe, expect, it } from "vitest";
import {
  bridgeReducer,
  initialBridgeState,
  isViewerReadyMessage,
  loadMatchLogMessage,
  shouldFallbackAfterTimeout,
  shouldPostLog,
  setChromeMessage,
  viewerControlMessage,
  isViewerStateMessage,
  VIEWER_EMBED_SRC,
  VIEWER_READY_TIMEOUT_MS,
  type BridgeEvent,
  type BridgeState,
} from "./viewer-bridge";

// 이벤트 시퀀스를 초기상태에서부터 접어(fold) 최종상태를 얻는다.
function run(events: BridgeEvent[], from: BridgeState = initialBridgeState): BridgeState {
  return events.reduce(bridgeReducer, from);
}

describe("viewer-bridge — message guards", () => {
  it("viewerReady 메시지만 참으로 판별한다", () => {
    expect(isViewerReadyMessage({ type: "viewerReady" })).toBe(true);
  });

  it("다른 postMessage 소음(타입 불일치/원시값/null)은 거른다", () => {
    expect(isViewerReadyMessage({ type: "loadMatchLog" })).toBe(false);
    expect(isViewerReadyMessage({ hello: 1 })).toBe(false);
    expect(isViewerReadyMessage(null)).toBe(false);
    expect(isViewerReadyMessage("viewerReady")).toBe(false);
    expect(isViewerReadyMessage(undefined)).toBe(false);
  });

  it("loadMatchLog 주입 메시지를 계약대로 만든다", () => {
    const log = { tickSnapshots: [], events: [], finalScore: { home: 1, away: 0 } };
    expect(loadMatchLogMessage(log)).toEqual({ type: "loadMatchLog", matchLog: log });
  });

  it("embed src 는 vite public 루트 경로다", () => {
    expect(VIEWER_EMBED_SRC).toBe("/viewer-embed.html");
  });
});

describe("viewer-bridge — 주입 시퀀스(레이스 무관)", () => {
  it("초기상태에선 주입하지 않는다", () => {
    expect(shouldPostLog(initialBridgeState)).toBe(false);
  });

  it("viewerReady 만 오면 아직 주입 안 함(로그 대기)", () => {
    const s = run([{ kind: "viewerReady" }]);
    expect(shouldPostLog(s)).toBe(false);
  });

  it("logLoaded 만 오면 아직 주입 안 함(뷰어 대기)", () => {
    const s = run([{ kind: "logLoaded" }]);
    expect(shouldPostLog(s)).toBe(false);
  });

  it("viewerReady → logLoaded 순서면 주입한다", () => {
    const s = run([{ kind: "viewerReady" }, { kind: "logLoaded" }]);
    expect(shouldPostLog(s)).toBe(true);
  });

  it("logLoaded → viewerReady 역순(로그가 먼저 캐시됨)이어도 주입한다", () => {
    const s = run([{ kind: "logLoaded" }, { kind: "viewerReady" }]);
    expect(shouldPostLog(s)).toBe(true);
  });

  it("한 번 주입하면 다시 주입하지 않는다(중복 방지)", () => {
    const s = run([{ kind: "viewerReady" }, { kind: "logLoaded" }, { kind: "posted" }]);
    expect(shouldPostLog(s)).toBe(false);
  });

  it("타임아웃 만료 시 viewerReady 면 폴백 안 함, 아니면 폴백한다(onError 못 잡는 케이스 방어)", () => {
    expect(shouldFallbackAfterTimeout(false)).toBe(true); // 브리지 없는 페이지(SPA-fallback 200) → 폴백
    expect(shouldFallbackAfterTimeout(true)).toBe(false); // 정상 로드 → 유지
  });

  it("타임아웃 상수는 양수(합리적 대기)다", () => {
    expect(VIEWER_READY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("reset(half 전환/재마운트) 후엔 다시 준비되면 재주입한다", () => {
    const afterFirst = run([
      { kind: "viewerReady" },
      { kind: "logLoaded" },
      { kind: "posted" },
    ]);
    // 새 iframe 마운트 → reset → 새 viewerReady/logLoaded → 재주입 가능
    const afterReset = run(
      [{ kind: "reset" }, { kind: "viewerReady" }, { kind: "logLoaded" }],
      afterFirst,
    );
    expect(afterReset).toEqual({ viewerReady: true, logLoaded: true, posted: false });
    expect(shouldPostLog(afterReset)).toBe(true);
  });
});

// ── #148: 컨트롤 크롬(뷰어 내부 컨트롤 표시) + 재생 명령 프로토콜 ──────────────
describe("viewer-bridge — 컨트롤 크롬/명령 메시지", () => {
  it("setViewerChrome 메시지는 모드를 그대로 싣는다", () => {
    expect(setChromeMessage("play")).toEqual({ type: "setViewerChrome", mode: "play" });
    expect(setChromeMessage("full")).toEqual({ type: "setViewerChrome", mode: "full" });
  });

  it("재생 명령은 {type,cmd} 형태 — 배속은 화이트리스트 값만 싣는다", () => {
    expect(viewerControlMessage("toggle")).toEqual({ type: "viewerControl", cmd: "toggle" });
    expect(viewerControlMessage("auto")).toEqual({ type: "viewerControl", cmd: "auto" });
    expect(viewerControlMessage("speed", 2)).toEqual({ type: "viewerControl", cmd: "speed", speed: 2 });
    // 화이트리스트 밖 배속은 명령 자체를 만들지 않는다(브리지로 흘리지 않음).
    expect(viewerControlMessage("speed", 8 as never)).toBeNull();
    expect(viewerControlMessage("speed")).toBeNull();
  });

  it("viewerState(iframe→parent)만 상태로 인정하고, 필드 타입을 검증한다", () => {
    expect(isViewerStateMessage({ type: "viewerState", playing: true, speed: 2, ended: false, auto: true })).toBe(true);
    expect(isViewerStateMessage({ type: "viewerState", playing: "yes", speed: 2, ended: false, auto: true })).toBe(false);
    // auto 누락 = 구 브리지 아티팩트 → 계약 불일치로 거른다(재빌드 유도).
    expect(isViewerStateMessage({ type: "viewerState", playing: true, speed: 2, ended: false })).toBe(false);
    expect(isViewerStateMessage({ type: "viewerReady" })).toBe(false);
    expect(isViewerStateMessage(null)).toBe(false);
  });
});
