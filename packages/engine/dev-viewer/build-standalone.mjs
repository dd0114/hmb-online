// match-log.json 을 index.html 에 통째로 박아 단일 파일(viewer-standalone.html)로 만든다.
// 서버·fetch·포트 없이 브라우저로 더블클릭해서 열 수 있게. (Node 20+, 플레인 JS)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { subsampleSnapshots } from "./subsample.mjs";
import { inlineCore, stripCoreImports } from "./inline-core.mjs";
import { buildQaSkin } from "./qa-skin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const log = JSON.parse(readFileSync(join(here, "match-log.json"), "utf8"));

// 용량 축소: 틱을 2개당 1개로 서브샘플(뷰어가 보간) + 좌표 소수1자리 반올림.
// #50: 이벤트 참조 틱은 항상 보존(홀수 causeTick 드롭 → 정지 자막/freeze 스킵 방지).
const compactSnaps = subsampleSnapshots(log.tickSnapshots, log.events, 2);
const compact = {
  configVersion: log.configVersion,
  seed: log.seed,
  finalScore: log.finalScore,
  events: log.events,
  tickSnapshots: compactSnaps,
};

const html = readFileSync(join(here, "index.html"), "utf8");
const { coreSrc } = inlineCore();

let out = html;
// 1) 모듈 스크립트의 코어 import(viewer/log-lines) 제거(전역으로 대체). 경로 무관하게 파일명으로 매치.
out = stripCoreImports(out);
// 2) 모듈 스크립트 앞에 데이터 + (있으면)캐릭터 스킨 + 코어(전역화) 를 주입.
//    스킨은 셸 토글이 켜면 setSkin 으로 적용(기본 off — 엔진 디버그는 단색 원). 에셋 없으면 생략.
const qaSkin = buildQaSkin(log);
const skinJs = qaSkin ? ` window.__SKIN__ = ${JSON.stringify(qaSkin)};` : "";
const inject = `\n    <script>window.__LOG__ = ${JSON.stringify(compact)};${skinJs}</script>\n    <script>\n${coreSrc}\n    </script>`;
const out2 = out.replace(/(\n\s*<script type="module">)/, `${inject}$1`);
if (out2 === out) throw new Error("주입 지점(<script type=module>) 을 못 찾음");
out = out2;

const outPath = join(here, "viewer-standalone.html");
writeFileSync(outPath, out);
const mb = (Buffer.byteLength(out) / 1e6).toFixed(1);
console.log(`[build-standalone] wrote ${outPath} (${mb} MB, ${compactSnaps.length} snapshots, ${compact.events.length} events, score ${compact.finalScore.home}:${compact.finalScore.away})`);
