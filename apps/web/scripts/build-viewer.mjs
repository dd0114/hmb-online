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

// 브리지 스크립트(임베드 로그 대신 부모 주입 로그 로드). dev-viewer 원본은 건드리지 않는다.
export const BRIDGE_MARKER = "hmb-viewer-embed-bridge";
export const bridgeScript = `<script>
/* ${BRIDGE_MARKER} — apps/web/scripts/build-viewer.mjs 주입. dev-viewer 원본 무수정.
   부모(iframe host)로 viewerReady 를 알리고, {type:'loadMatchLog', matchLog} 수신 시
   임베드 로그 대신 주입 로그로 뷰어를 초기화한다. 원본의 fetch("./match-log.json") 지점을
   가로채 주입 로그로 resolve → 원본 loadLog 가 그대로 호출된다(훅 추가 0). */
(function () {
  try { window.__LOG__ = null; } catch (e) {}
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
    var d = ev && ev.data;
    if (d && d.type === "loadMatchLog" && d.matchLog) { resolveLog(d.matchLog); }
  });
  function announce() { try { window.parent.postMessage({ type: "viewerReady" }, "*"); } catch (e) {} }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", announce);
  else announce();
  window.addEventListener("load", announce);
})();
</script>`;

// index.html 원본을 후처리해 임베드 아티팩트 HTML 을 만든다(순수 함수 — 단위검증 용이).
export function injectBridge(standaloneHtml, engineVersion = "") {
  // 1) 임베드된 __LOG__ 플레이스홀더 스크립트 제거(용량↓, fetch 경로 강제). 없으면 브리지가 런타임에 null 처리.
  let out = standaloneHtml.replace(/\s*<script>window\.__LOG__ = [\s\S]*?;<\/script>/, "");
  // 2) 원본 module 스크립트 앞에 브리지(classic) 주입 — classic 은 deferred module 보다 먼저 실행.
  //    엔진 버전 마커도 같이 박아 predev(ensure-viewer)가 최신 여부를 값싸게 비교하게 한다.
  const version = engineVersion ? `<!-- ${ENGINE_VERSION_MARKER}: ${engineVersion} -->\n    ` : "";
  const before = out;
  out = out.replace(/(<script type="module">)/, `${version}${bridgeScript}\n    $1`);
  if (out === before) throw new Error("주입 지점(<script type=module>) 을 못 찾음 — dev-viewer index.html 구조 변경?");
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
