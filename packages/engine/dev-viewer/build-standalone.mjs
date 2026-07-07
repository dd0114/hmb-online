// match-log.json 을 index.html 에 통째로 박아 단일 파일(viewer-standalone.html)로 만든다.
// 서버·fetch·포트 없이 브라우저로 더블클릭해서 열 수 있게. (Node 20+, 플레인 JS)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const log = JSON.parse(readFileSync(join(here, "match-log.json"), "utf8"));

// 용량 축소: 틱을 2개당 1개로 서브샘플(뷰어가 보간) + 좌표 소수1자리 반올림.
const r1 = (n) => Math.round(n * 10) / 10;
const STEP = 2;
const compactSnaps = [];
for (let i = 0; i < log.tickSnapshots.length; i += STEP) {
  const s = log.tickSnapshots[i];
  compactSnaps.push({
    tick: s.tick,
    minute: s.minute,
    ball: { x: r1(s.ball.x), y: r1(s.ball.y) },
    ballOwner: s.ballOwner,
    players: s.players.map((p) => ({ playerId: p.playerId, team: p.team, pos: { x: r1(p.pos.x), y: r1(p.pos.y) } })),
  });
}
const compact = {
  configVersion: log.configVersion,
  seed: log.seed,
  finalScore: log.finalScore,
  events: log.events,
  tickSnapshots: compactSnaps,
};

const html = readFileSync(join(here, "index.html"), "utf8");
const inject = `\n    <script>window.__LOG__ = ${JSON.stringify(compact)};</script>`;
// 메인 스크립트보다 먼저 데이터가 정의되도록 <script> 앞에 주입.
const out = html.replace(/(\n\s*<script>\s*\n\s*\/\/ =====)/, `${inject}$1`);
if (out === html) throw new Error("주입 지점(<script> // =====) 을 못 찾음");

const outPath = join(here, "viewer-standalone.html");
writeFileSync(outPath, out);
const mb = (Buffer.byteLength(out) / 1e6).toFixed(1);
console.log(`[build-standalone] wrote ${outPath} (${mb} MB, ${compactSnaps.length} snapshots, ${compact.events.length} events, score ${compact.finalScore.home}:${compact.finalScore.away})`);
