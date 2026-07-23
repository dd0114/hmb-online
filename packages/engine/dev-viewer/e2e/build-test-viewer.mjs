// e2e 계약검증용 "풀해상도" 테스트 뷰어를 조립한다.
// build-standalone.mjs 와 달리 STEP=1(서브샘플 없음)·좌표 반올림 없음 →
// 이벤트 틱마다 스냅샷이 존재해 틱정밀 단언이 가능하다.
// 현재 index.html + playback.mjs 를 그대로 읽으므로 V3 의 뷰어 수정이 자동 반영된다.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inlineCore, stripCoreImports } from "../inline-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = dirname(here); // packages/engine/dev-viewer

/** 하나의 로그(JSON 경로)를 현재 index.html+playback.mjs 에 인라인해 풀해상도 테스트 뷰어를 만든다. */
export function buildTestViewer(logPath, outName) {
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  // 풀해상도: 모든 스냅샷 유지, 좌표 원본 정밀도. players 는 렌더에만 쓰이므로 유지.
  const compact = {
    configVersion: log.configVersion,
    seed: log.seed,
    finalScore: log.finalScore,
    events: log.events,
    tickSnapshots: log.tickSnapshots.map((s) => ({
      tick: s.tick,
      minute: s.minute,
      ball: s.ball,
      ballOwner: s.ballOwner,
      players: s.players.map((p) => ({ playerId: p.playerId, team: p.team, pos: p.pos })),
    })),
  };

  const html = readFileSync(join(viewerDir, "index.html"), "utf8");
  const { coreSrc } = inlineCore();

  const out = stripCoreImports(html);
  const inject = `\n    <script>window.__LOG__ = ${JSON.stringify(compact)};</script>\n    <script>\n${coreSrc}\n    </script>`;
  const out2 = out.replace(/(\n\s*<script type="module">)/, `${inject}$1`);
  if (out2 === out) throw new Error("주입 지점(<script type=module>) 을 못 찾음");

  const outPath = join(here, outName);
  writeFileSync(outPath, out2);
  return { outPath, snapshots: compact.tickSnapshots.length, events: compact.events.length };
}

/** e2e 가 쓰는 두 뷰어를 모두 빌드: showcase(주) + real(offside/card 커버). */
export function buildAllTestViewers() {
  const showcase = buildTestViewer(join(viewerDir, "match-log.json"), "viewer-test.html");
  const real = buildTestViewer(join(here, "fixture-real.json"), "viewer-real.html");
  return { showcase, real };
}

// 직접 실행 시(디버깅용) 둘 다 빌드하고 경로 출력.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = buildAllTestViewers();
  console.log(`[build-test-viewer] showcase ${r.showcase.outPath} (${r.showcase.snapshots} snaps) · real ${r.real.outPath} (${r.real.snapshots} snaps)`);
}
