// @vitest-environment jsdom
/**
 * iframe 쪽 브리지(#148 컨트롤 크롬/명령) 동작 계약. build-viewer.mjs 가 주입하는 스크립트를
 * dev-viewer 컨트롤 마크업 복제본 위에서 **실제로 실행**해 검증한다(문자열 grep 아님).
 *
 * 계약: 플레이 모드는 뷰어 내부 컨트롤(제목·컨트롤 행·상태줄·파일입력)을 숨기고,
 * 부모 명령은 뷰어의 **원래 버튼을 클릭**해 처리한다(재생 로직 재구현 0, 원본 무수정).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeScript, CHROME_PLAY_CLASS } from "../../scripts/build-viewer.mjs";

/** dev-viewer index.html 의 컨트롤 마크업 최소 복제(브리지가 붙잡는 훅만). */
const VIEWER_MARKUP = `
  <h1>HMB TIER-B ENGINE · DEBUG VIEWER</h1>
  <div id="scoreboard"><span id="score">0 : 0</span></div>
  <div id="wrap"><canvas id="pitch"></canvas></div>
  <div class="controls">
    <button id="playBtn">▶ Play</button>
    <button id="restartBtn">⟲ Restart</button>
    <button id="highlightBtn" class="active">🎬 Highlights</button>
    <button data-speed="0.25">0.25x</button>
    <button data-speed="1" class="active">1x</button>
    <button data-speed="2">2x</button>
    <button data-speed="4">4x</button>
  </div>
  <div class="controls">
    <button id="prevGoal">◀ Prev goal</button>
    <input id="scrub" type="range" min="0" max="100" value="0" />
  </div>
  <div id="status">Loaded · config engine@0.16.0 · seed 1</div>
  <input type="file" id="fileInput" />
`;

const clicks: string[] = [];
/** 브리지가 건 리스너/인터벌 — jsdom window 는 테스트 간 공유라 매번 해제해야 인스턴스가 안 쌓인다. */
let bridgeListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
let bridgeTimers: number[] = [];

function mountBridge() {
  document.documentElement.className = "";
  document.head.innerHTML = "";
  document.body.innerHTML = VIEWER_MARKUP;
  clicks.length = 0;
  // 뷰어의 원래 핸들러 대역 — 클릭이 실제로 도달했는지 + 라벨/active 갱신(뷰어와 동일 동작).
  const play = document.getElementById("playBtn") as HTMLButtonElement;
  play.onclick = () => {
    clicks.push("play");
    play.textContent = play.textContent!.includes("Pause") ? "▶ Play" : "⏸ Pause";
  };
  // 하이라이트 자동페이싱 토글(뷰어 index.html:792 와 동일 동작). 켜져 있으면 뷰어가
  // speed 를 무시하므로(index.html:729 eff 분기) 배속 명령은 이걸 반드시 꺼야 한다.
  const hl = document.getElementById("highlightBtn") as HTMLButtonElement;
  hl.onclick = () => {
    clicks.push("highlight");
    hl.classList.toggle("active", !hl.classList.contains("active"));
  };
  document.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => {
    b.onclick = () => {
      clicks.push(`speed:${b.dataset.speed}`);
      document.querySelectorAll("[data-speed]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    };
  });
  const js = bridgeScript.replace(/^<script>/, "").replace(/<\/script>$/, "");
  // 브리지가 등록하는 리스너/인터벌을 잡아뒀다가 afterEach 에서 해제(인스턴스 누적 방지).
  bridgeListeners = [];
  bridgeTimers = [];
  const addEv = window.addEventListener.bind(window);
  const setInt = window.setInterval.bind(window);
  window.addEventListener = ((t: string, h: EventListenerOrEventListenerObject, o?: unknown) => {
    bridgeListeners.push([t, h]);
    addEv(t, h as EventListener, o as never);
  }) as typeof window.addEventListener;
  window.setInterval = ((fn: TimerHandler, ms?: number) => {
    const id = setInt(fn as never, ms);
    bridgeTimers.push(id);
    return id;
  }) as typeof window.setInterval;
  try {
    new Function(js)();
  } finally {
    window.addEventListener = addEv;
    window.setInterval = setInt;
  }
}

function unmountBridge() {
  for (const [t, h] of bridgeListeners) window.removeEventListener(t, h as EventListener);
  for (const id of bridgeTimers) window.clearInterval(id);
  bridgeListeners = [];
  bridgeTimers = [];
}

function send(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

/** 부모(jsdom 에선 self)가 받은 viewerState 중 마지막 것. */
function lastState(): { playing: boolean; speed: number; ended: boolean; auto: boolean } | null {
  for (let i = received.length - 1; i >= 0; i--) {
    const m = received[i] as { type?: string };
    if (m?.type === "viewerState") return m as never;
  }
  return null;
}

let received: unknown[] = [];
function onMsg(ev: MessageEvent) {
  received.push(ev.data);
}

beforeEach(() => {
  received = [];
  window.addEventListener("message", onMsg);
  mountBridge();
});
afterEach(() => {
  window.removeEventListener("message", onMsg);
  unmountBridge();
});

describe("embed bridge — 컨트롤 크롬", () => {
  it("기본은 플레이 크롬: 디버그 제목·컨트롤 행·상태줄·파일입력이 숨겨진다", () => {
    expect(document.documentElement.classList.contains(CHROME_PLAY_CLASS)).toBe(true);
    const css = document.getElementById("hmb-chrome-style")!.textContent!;
    for (const sel of ["h1", ".controls", "#status", "input[type=file]"]) {
      expect(css).toContain(`html.${CHROME_PLAY_CLASS} ${sel}`);
    }
    expect(css).toContain("display:none !important");
    // 경기 장면(스코어보드·피치)은 숨김 대상이 아니다.
    expect(css).not.toContain("#wrap");
    expect(css).not.toContain("#scoreboard");
  });

  it("로드/주입 실패 문구는 플레이 모드에서도 보인다(원인 없는 '멈춘 피치' 방지)", async () => {
    const status = document.getElementById("status")!;
    status.textContent = "Failed to load injected MatchLog: Invalid MatchLog";
    await new Promise((r) => setTimeout(r, 350)); // 폴링/옵저버 반영
    expect(document.documentElement.classList.contains("hmb-chrome-error")).toBe(true);
    const css = document.getElementById("hmb-chrome-style")!.textContent!;
    expect(css).toContain(`html.${CHROME_PLAY_CLASS}.hmb-chrome-error #status{display:block !important`);
    // 정상 문구로 돌아오면 다시 숨긴다.
    status.textContent = "Loaded · config engine@0.16.0 · seed 1";
    await new Promise((r) => setTimeout(r, 350));
    expect(document.documentElement.classList.contains("hmb-chrome-error")).toBe(false);
  });

  it("setViewerChrome full → 뷰어 원래 컨트롤 복구, play → 다시 숨김", () => {
    send({ type: "setViewerChrome", mode: "full" });
    expect(document.documentElement.classList.contains(CHROME_PLAY_CLASS)).toBe(false);
    send({ type: "setViewerChrome", mode: "play" });
    expect(document.documentElement.classList.contains(CHROME_PLAY_CLASS)).toBe(true);
  });
});

describe("embed bridge — 재생 명령", () => {
  it("toggle 은 뷰어의 재생 버튼을 클릭한다(재생 로직 재구현 0)", () => {
    send({ type: "viewerControl", cmd: "toggle" });
    expect(clicks).toEqual(["play"]);
  });

  it("play/pause 는 현재 상태를 보고 필요한 때만 클릭한다(토글 꼬임 방지)", () => {
    send({ type: "viewerControl", cmd: "play" });
    expect(clicks).toEqual(["play"]); // 정지 → 재생
    send({ type: "viewerControl", cmd: "play" });
    expect(clicks).toEqual(["play"]); // 이미 재생 중 → 클릭 없음
    send({ type: "viewerControl", cmd: "pause" });
    expect(clicks).toEqual(["play", "play"]);
  });

  it("배속은 화이트리스트(1·2·4)만 적용 — 슬로우/미지의 값은 무시한다", () => {
    send({ type: "viewerControl", cmd: "speed", speed: 2 });
    expect(clicks.filter((c) => c.startsWith("speed"))).toEqual(["speed:2"]);
    send({ type: "viewerControl", cmd: "speed", speed: 0.25 });
    send({ type: "viewerControl", cmd: "speed", speed: 8 });
    send({ type: "viewerControl", cmd: "speed", speed: '2"]/../..//[data-speed="4' });
    expect(clicks.filter((c) => c.startsWith("speed"))).toEqual(["speed:2"]);
  });

  // 회귀 가드: 배속을 눌러도 하이라이트 자동페이싱이 켜져 있으면 뷰어는 speed 를 무시한다
  // (index.html:729 `eff = autoPace ? (nearKey ? HL_SPEED : CRUISE_SPEED) : speed`).
  // 플레이 모드는 뷰어의 Highlights 토글을 숨기므로, 배속 명령이 직접 꺼줘야 실제로 빨라진다.
  it("배속 명령은 하이라이트 자동페이싱을 끈다(안 끄면 배속이 무동작)", () => {
    send({ type: "viewerControl", cmd: "speed", speed: 4 });
    expect(clicks).toEqual(["highlight", "speed:4"]);
    expect(document.getElementById("highlightBtn")!.classList.contains("active")).toBe(false);
    // 이미 꺼져 있으면 다시 토글하지 않는다(꼬임 방지).
    send({ type: "viewerControl", cmd: "speed", speed: 2 });
    expect(clicks).toEqual(["highlight", "speed:4", "speed:2"]);
  });

  it("auto 명령은 하이라이트 자동페이싱을 되돌린다(기본 관람 페이스)", () => {
    send({ type: "viewerControl", cmd: "speed", speed: 2 }); // 자동페이싱 off
    send({ type: "viewerControl", cmd: "auto" });
    expect(document.getElementById("highlightBtn")!.classList.contains("active")).toBe(true);
    send({ type: "viewerControl", cmd: "auto" }); // 이미 켜짐 → 무동작
    expect(clicks.filter((c) => c === "highlight")).toHaveLength(2);
  });

  it("미러링 상태에 자동페이싱 여부(auto)가 포함된다", async () => {
    await new Promise((r) => setTimeout(r, 0));
    expect(lastState()).toMatchObject({ auto: true });
    send({ type: "viewerControl", cmd: "speed", speed: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(lastState()).toMatchObject({ auto: false, speed: 2 });
  });

  it("명령 처리 후 재생 상태를 부모로 미러링한다(버튼 라벨 동기화용)", async () => {
    send({ type: "viewerControl", cmd: "toggle" });
    send({ type: "viewerControl", cmd: "speed", speed: 4 });
    await new Promise((r) => setTimeout(r, 0));
    expect(lastState()).toEqual({
      type: "viewerState",
      playing: true,
      speed: 4,
      ended: false,
      auto: false,
    });
  });

  it("알 수 없는 cmd 는 아무것도 하지 않는다", () => {
    send({ type: "viewerControl", cmd: "restart" });
    send({ type: "viewerControl" });
    expect(clicks).toEqual([]);
  });
});
