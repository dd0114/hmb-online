// build-viewer.mjs — QA 뷰어(packages/engine/dev-viewer) 를 apps/web 임베드 아티팩트로 후처리.
//
// 파이프라인:
//   1) match-log.json 이 없으면 vitest generate-demo 로 생성(루트 CLAUDE.md §4).
//   2) `node packages/engine/dev-viewer/build-standalone.mjs` 실행 → viewer-standalone.html.
//      (dev-viewer 원본 렌더링 코드는 **무수정** — QA 도메인 경계. 우리는 소비만.)
//   3) 산출 HTML 후처리(무수정 브리지 주입):
//        - 임베드된 `window.__LOG__ = {...}`(수백KB 플레이스홀더) 를 제거하고,
//        - classic <script> 브리지를 원본 `<script type="module">`(deferred) **앞**에 주입.
//      브리지는 원본을 고치지 않고 임베드 로그 로드 지점을 가로챈다:
//        · 원본은 `if (window.__LOG__) loadLog(__LOG__) else fetch("./match-log.json")` 순서.
//        · __LOG__ 를 지웠으니 원본은 fetch 경로를 탄다 → 그 fetch 를 브리지가 가로채
//          부모(postMessage)로 주입된 MatchLog 로 resolve → 원본 loadLog 가 그대로 호출된다.
//      즉 dev-viewer 훅 추가 0. (classic script 는 deferred module 보다 먼저 실행되므로 순서 보장.)
//   4) apps/web/public/viewer-embed.html 로 출력(생성물 — .gitignore, `npm run build:viewer` 로 재현).
//
// ⚠️ 엔진 config.version 이 바뀌면(연출/스냅샷 계약 변경) 이 스크립트를 재실행해야 최신 뷰어가 임베드된다.
//    (match-log.json 은 seed 결정론 생성물이라 재현 가능 → 커밋 대신 빌드 스텝으로 유지.)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const devViewer = join(repoRoot, "packages", "engine", "dev-viewer");
const matchLog = join(devViewer, "match-log.json");
const standalone = join(devViewer, "viewer-standalone.html");
const outPath = join(repoRoot, "apps", "web", "public", "viewer-embed.html");
const engineConfig = join(repoRoot, "packages", "engine", "src", "config.ts");

// 엔진 config 버전 SoT = packages/engine/src/config.ts 의 `version: "engine@x.y.z"`.
// 아티팩트에 이 값을 마커로 박아 predev(ensure-viewer)가 값싸게 최신 여부를 판정한다.
export const ENGINE_VERSION_MARKER = "hmb-engine-version";

/** 현재 엔진 config 버전 문자열(예: "engine@0.9.0"). 소스 파일에서 정적으로 읽음(엔진 실행 없음). */
export function readEngineVersion() {
  const src = readFileSync(engineConfig, "utf8");
  const m = src.match(/version:\s*["']([^"']+)["']/);
  if (!m) throw new Error("engine config.ts 에서 version 을 못 찾음");
  return m[1];
}

/** 아티팩트 HTML 에 박힌 엔진 버전 마커를 읽음(없으면 null). */
export function readEmbeddedVersion(html) {
  const m = html.match(new RegExp(`${ENGINE_VERSION_MARKER}:\\s*([^\\s]+)\\s*-->`));
  return m ? m[1] : null;
}

/** 아티팩트 HTML 에 박힌 브리지 계약 버전을 읽음(#148 이전 아티팩트면 null). */
export function readEmbeddedBridgeVersion(html) {
  const m = html.match(new RegExp(`${BRIDGE_VERSION_MARKER}:\\s*([^\\s]+)\\s*-->`));
  return m ? m[1] : null;
}

// 브리지 스크립트(임베드 로그 대신 부모 주입 로그 로드). dev-viewer 원본은 건드리지 않는다.
export const BRIDGE_MARKER = "hmb-viewer-embed-bridge";
/**
 * 브리지 자체의 계약 버전(#148 컨트롤 크롬/명령 추가). 엔진 버전이 그대로여도 브리지가 바뀌면
 * 기존 아티팩트는 낡은 것이므로 ensure-viewer 가 재빌드하도록 마커로 박는다.
 */
export const BRIDGE_VERSION_MARKER = "hmb-viewer-bridge-version";
export const BRIDGE_VERSION = "6";
/** 플레이 모드에서 뷰어 내부 컨트롤을 감추는 클래스(문서 루트에 건다). */
export const CHROME_PLAY_CLASS = "hmb-chrome-play";
export const bridgeScript = `<script>
/* ${BRIDGE_MARKER} — apps/web/scripts/build-viewer.mjs 주입. dev-viewer 원본 무수정.
   부모(iframe host)로 viewerReady 를 알리고, {type:'loadMatchLog', matchLog} 수신 시
   임베드 로그 대신 주입 로그로 뷰어를 초기화한다. 원본의 fetch("./match-log.json") 지점을
   가로채 주입 로그로 resolve → 원본 loadLog 가 그대로 호출된다(훅 추가 0).

   #148: 컨트롤 크롬 2모드. 기본(play)은 디버그 컨트롤 행/제목/상태줄/파일입력을 CSS 로 숨긴다 —
   경기는 자동 진행하고, 부모가 보내는 유일한 명령은 하이라이트 연출 on/off 다
   ({type:'viewerControl', cmd:'highlight', on}). 명령은 뷰어의 원래 버튼을 **클릭**해 처리한다
   (뷰어 로직 재구현 0). admin/QA 는 {mode:'full'} 로 원래 컨트롤을 전부 되살린다. */
(function () {
  try { window.__LOG__ = null; } catch (e) {}

  // ── 컨트롤 크롬(#148) ─────────────────────────────────────────────────────
  var CHROME_CLASS = "${CHROME_PLAY_CLASS}";
  var DEFAULT_SPEED = 4; // 기본 재생 속도(hero 지시). 뷰어 자체 기본은 1x(≈실시간)라 느리다.
  var ERROR_CLASS = "hmb-chrome-error";
  function ensureChromeStyle() {
    if (document.getElementById("hmb-chrome-style")) return;
    var st = document.createElement("style");
    st.id = "hmb-chrome-style";
    var h = "html." + CHROME_CLASS + " ";
    st.textContent =
      // #169 S1: 스코어보드·통계 HUD·티커도 숨긴다 — 이제 **호스트(게임화면)가 소유**한다.
      // (iframe 안에 남겨두면 같은 정보가 두 번 나오고, 호스트가 켜고 끌 수도 없다.)
      h + "h1," + h + ".controls," + h + "#status," + h + "input[type=file]," +
      h + "#scoreboard," + h + "#hud," + h + "#ticker" +
      "{display:none !important;}" +
      // #169 S1: iframe 은 **경기장면 전용 무대**다. 문서 스크롤을 없애고 캔버스를 박스에
      // letterbox-fit 시킨다(호스트가 박스 크기를 정하고, 맞추는 건 여기서).
      h + "body{padding:0;gap:0;height:100vh;justify-content:center;overflow:hidden;}" +
      h + "#wrap{max-width:none;width:100%;}" +
      h + "canvas{width:auto;height:auto;max-width:100%;max-height:100vh;" +
      "margin:0 auto;border-radius:0;}" +
      // 로드/주입 실패는 숨기지 않는다 — 안 그러면 "멈춘 피치"로만 보인다(원인 비가시).
      // 상태줄은 문서 맨 아래(HUD·티커 뒤)라 display 만 켜면 iframe 접힘 밖이다 → 화면 상단에 고정.
      "html." + CHROME_CLASS + "." + ERROR_CLASS + " #status{display:block !important;color:#ff5a5a;" +
      "position:fixed;top:8px;left:8px;right:8px;z-index:99999;padding:8px 10px;border-radius:8px;" +
      "background:rgba(15,17,21,0.95);border:1px solid #ff5a5a;font-size:12px;}";
    (document.head || document.documentElement).appendChild(st);
  }
  /* 뷰어 상태줄이 실패 문구가 되면 플레이 모드에서도 보이게 한다(위 CSS).
     ⚠️ 클래스는 **바뀔 때만** 건드린다 — 무변경 write 도 mutation 으로 잡혀 옵저버가 자기 자신을
     다시 깨우는 무한 루프가 된다. */
  function syncErrorVisibility() {
    var el = document.getElementById("status");
    var bad = !!el && /fail|invalid|error/i.test(el.textContent || "");
    var cl = document.documentElement.classList;
    if (bad === cl.contains(ERROR_CLASS)) return;
    if (bad) cl.add(ERROR_CLASS); else cl.remove(ERROR_CLASS);
  }
  function setChrome(mode) {
    ensureChromeStyle();
    var cl = document.documentElement.classList;
    if (mode === "full") cl.remove(CHROME_CLASS); else cl.add(CHROME_CLASS);
  }
  // 기본 = 관객용. 부모가 full 을 보내기 전까진 디버그 크롬을 노출하지 않는다.
  setChrome("play");

  function playBtn() { return document.getElementById("playBtn"); }
  function hlBtn() { return document.getElementById("highlightBtn"); }
  function isPlaying() { var b = playBtn(); return !!b && b.textContent.indexOf("Pause") !== -1; }
  function isAuto() { var b = hlBtn(); return !!b && b.classList.contains("active"); }
  /* 하이라이트 자동페이싱 on/off. 켜져 있으면 뷰어가 speed 를 무시하고 자체 페이스로 돈다
     (index.html: eff = autoPace ? (nearKey ? HL_SPEED : CRUISE_SPEED) : speed) → 배속을
     유효하게 하려면 반드시 꺼야 한다. 플레이 모드는 이 토글을 숨기므로 브리지가 대신 누른다. */
  function setAuto(on) {
    var b = hlBtn();
    if (b && isAuto() !== on) b.click();
  }
  /* 재생 속도를 기본값(4x)으로 맞춘다. 뷰어 자체 기본은 1x(≈2 게임초/실초 → 한 하프 8분)이고
     플레이 모드엔 배속 컨트롤이 없으므로, 로드 시점에 한 번 4x 로 박아둔다.
     하이라이트가 켜져 있는 동안엔 뷰어가 speed 를 무시하지만(자체 페이싱), 끄는 순간 이 값이 쓰인다. */
  function setDefaultSpeed() {
    if (curSpeed() === DEFAULT_SPEED) return;
    var b = document.querySelector('[data-speed="' + DEFAULT_SPEED + '"]');
    if (b) b.click();
  }
  function curSpeed() {
    var a = document.querySelector("[data-speed].active");
    var v = a ? parseFloat(a.getAttribute("data-speed")) : 1;
    return isFinite(v) ? v : 1;
  }
  function atEnd() {
    var s = document.getElementById("scrub");
    var v = s ? parseFloat(s.value) : 0;
    return isFinite(v) && v >= 99.99;
  }
  /* #169 S1: 재생 플레이헤드 틱. 호스트가 소유한 실시간 통계·게임로그가 "지금까지"를 계산하려면
     이 값이 필요하다(뷰어 내부 HUD/티커를 숨겼으므로 호스트가 대신 그린다). 뷰어가 아직
     준비 전이면 null → 호스트는 이전 값을 유지한다. */
  function curTick() {
    try {
      var v = window.__viewer;
      if (!v || typeof v.cur !== "function") return null;
      var c = v.cur();
      return c && typeof c.tick === "number" ? c.tick : null;
    } catch (e) { return null; }
  }
  function stateSnapshot() {
    return { playing: isPlaying(), speed: curSpeed(), ended: atEnd(), auto: isAuto(), tick: curTick() };
  }
  function stateKey(s) { return s.playing + "|" + s.speed + "|" + s.ended + "|" + s.auto + "|" + s.tick; }
  function postState() {
    var s = stateSnapshot();
    lastState = stateKey(s);
    try {
      window.parent.postMessage(
        { type: "viewerState", playing: s.playing, speed: s.speed, ended: s.ended, auto: s.auto, tick: s.tick },
        "*"
      );
    } catch (e) {}
  }
  var lastState = "";
  /* 플레이 모드의 유일한 명령 = 하이라이트 연출 on/off.
       on  : 뷰어 자동페이싱 — 빌드업은 빠르게(cruise), 골·파울 등 주요장면은 슬로우+접촉 줌.
       off : 연출 없이 기본 속도(4x)로 쭉 진행. */
  function handleControl(d) {
    if (d.cmd !== "highlight") return;
    var on = d.on !== false;
    setAuto(on);
    if (!on) setDefaultSpeed(); // 연출을 끄면 이 속도로 쭉 진행(뷰어 기본 1x 로 처지지 않게)
    postState();
  }
  // 부모가 모르는 상태 변화(재생 진행/종료, 뷰어 자체 컨트롤 조작) 미러링.
  // 변화 즉시 반영이 우선(라벨 지연 최소화) — MutationObserver 가 놓치는 것만 폴링이 줍는다.
  function mirrorIfChanged() {
    syncErrorVisibility();
    if (stateKey(stateSnapshot()) !== lastState) postState();
  }
  // 관찰 대상은 상태를 담은 노드만 — 문서 전체를 보면 매 프레임 갱신되는 티커/HUD 까지 끌고 오고,
  // 루트 클래스 변경이 콜백으로 되돌아온다.
  if (typeof MutationObserver === "function") {
    var mo = new MutationObserver(mirrorIfChanged);
    var watchText = [playBtn(), document.getElementById("status")];
    for (var i = 0; i < watchText.length; i++) {
      if (watchText[i]) mo.observe(watchText[i], { childList: true, characterData: true, subtree: true });
    }
    var rows = document.querySelectorAll(".controls");
    for (var j = 0; j < rows.length; j++) {
      mo.observe(rows[j], { attributes: true, attributeFilter: ["class"], subtree: true });
    }
  }
  setInterval(mirrorIfChanged, 300);
  var resolveLog;
  var pending = new Promise(function (res) { resolveLog = res; });
  var realFetch = (typeof window.fetch === "function") ? window.fetch.bind(window) : null;
  window.fetch = function (input) {
    var url = (typeof input === "string") ? input : (input && input.url) || "";
    if (url.indexOf("match-log.json") !== -1) {
      return pending.then(function (log) {
        return { ok: true, status: 200, json: function () { return Promise.resolve(log); } };
      });
    }
    return realFetch ? realFetch.apply(window, arguments) : Promise.reject(new Error("fetch disabled"));
  };
  window.addEventListener("message", function (ev) {
    // 호스트(부모 프레임)가 보낸 것만 받는다 — 다른 프레임/창의 postMessage 소음 차단.
    if (ev && ev.source && ev.source !== window.parent) return;
    var d = ev && ev.data;
    if (!d) return;
    if (d.type === "loadMatchLog" && d.matchLog) {
      resolveLog(d.matchLog);
      // 뷰어가 로그를 물고 컨트롤을 초기화한 뒤 기본 배속을 박는다(주입 직후엔 아직 이르다).
      setTimeout(setDefaultSpeed, 0);
    }
    else if (d.type === "setViewerChrome") { setChrome(d.mode); }
    else if (d.type === "viewerControl") { handleControl(d); }
  });
  function announce() { try { window.parent.postMessage({ type: "viewerReady" }, "*"); } catch (e) {} }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", announce);
  else announce();
  window.addEventListener("load", announce);
})();
</script>`;

// (#145 캐릭터 스킨 주입 삭제 — S3: 스킨은 viewer-core 네이티브 옵션(viewer.setSkin)이 됐다.
//  dev-viewer 셸이 postMessage {loadMatchLog, skins} 의 skins 를 setSkin 으로 넘긴다.)

// index.html 원본을 후처리해 임베드 아티팩트 HTML 을 만든다(순수 함수 — 단위검증 용이).
export function injectBridge(standaloneHtml, engineVersion = "") {
  // 1) 임베드된 __LOG__ 플레이스홀더 스크립트 제거(용량↓, fetch 경로 강제). 없으면 브리지가 런타임에 null 처리.
  let out = standaloneHtml.replace(/\s*<script>window\.__LOG__ = [\s\S]*?;<\/script>/, "");
  // 2) 원본 module 스크립트 앞에 브리지(classic) 주입 — classic 은 deferred module 보다 먼저 실행.
  //    엔진 버전 마커도 같이 박아 predev(ensure-viewer)가 최신 여부를 값싸게 비교하게 한다.
  const version =
    (engineVersion ? `<!-- ${ENGINE_VERSION_MARKER}: ${engineVersion} -->\n    ` : "") +
    `<!-- ${BRIDGE_VERSION_MARKER}: ${BRIDGE_VERSION} -->\n    `;
  const before = out;
  out = out.replace(
    /(<script type="module">)/,
    `${version}${bridgeScript}\n    $1`,
  );
  if (out === before) throw new Error("주입 지점(<script type=module>) 을 못 찾음 — dev-viewer index.html 구조 변경?");
  // 스킨(#145)은 이제 viewer-core 네이티브(viewer.setSkin) — 셸이 postMessage skins 를 넘긴다.
  return out;
}

function run() {
  if (!existsSync(matchLog)) {
    console.log("[build-viewer] match-log.json 없음 → generate-demo 로 생성");
    execFileSync(
      "npx",
      ["vitest", "run", "packages/engine/dev-viewer/generate-demo.test.ts"],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }
  console.log("[build-viewer] build-standalone 실행(dev-viewer 원본, 무수정)");
  execFileSync("node", [join(devViewer, "build-standalone.mjs")], { cwd: repoRoot, stdio: "inherit" });

  const engineVersion = readEngineVersion();
  const html = readFileSync(standalone, "utf8");
  const out = injectBridge(html, engineVersion);
  if (!out.includes(BRIDGE_MARKER)) throw new Error("브리지 주입 실패(마커 없음)");
  writeFileSync(outPath, out);
  const mb = (Buffer.byteLength(out) / 1e6).toFixed(2);
  console.log(`[build-viewer] wrote ${outPath} (${mb} MB, bridge=${BRIDGE_MARKER}, ${engineVersion})`);
}

// 직접 실행 시에만 파이프라인 구동(import 시엔 순수 함수만 노출 — 테스트용).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run();
}
