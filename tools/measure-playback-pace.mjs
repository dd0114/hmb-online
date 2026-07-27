#!/usr/bin/env node
/**
 * 하이라이트 켬(연출) 모드의 **실측 재생 길이**를 하프 단위로 측정한다 (#216 AC2).
 *
 * 왜 필요한가: 서버 시계(`hmb.match.clock.half-real-ms`)는 "한 하프를 실시간 몇 분에 보여줄까"라는
 * 노브인데, 실제 재생 속도는 뷰어 코어의 연출 페이싱(크루즈 4x / 키장면 1x / 데드볼 홀드)이 정한다.
 * 두 값이 어긋나면 재생이 끝나기 전에 하프타임이 열리거나(구 240s = 실측의 57%) 반대로 빈 시간이
 * 생긴다. 그래서 **config 를 이 측정값에 맞춘다**.
 *
 * 측정 대상은 코어 자신이다 — 페이싱 규칙·상수는 `packages/viewer-core/src/playback.mjs`
 * (`autoPaceDurationMs`, `PACE`)에 있고 렌더 루프가 같은 것을 읽는다(SoT 하나).
 *
 * 실행:  node tools/measure-playback-pace.mjs [시드…]
 *   기본 8시드 × 전·후반 = 16하프. 리얼 config(`defaultEngineConfig`) 로 실제 매치를 시뮬한다.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const seeds = process.argv.slice(2);
const SEEDS = seeds.length ? seeds : ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

// 엔진은 TS 라 tsx 로 한 번 감싸 실행한다(이 파일 자체는 순수 node 로 읽히게 유지).
// 시드는 argv 가 아니라 소스에 심는다 — `tsx --eval` 의 argv 배치가 런처마다 달라 조용히 하나씩 샌다.
const script = `
import { runFirstHalf, resumeSecondHalf } from "${root}/packages/engine/src/match";
import { defaultEngineConfig } from "${root}/packages/engine/src/config";
import { makeSelectData, makeTacticalInput } from "${root}/packages/engine/src/fixtures";
import { autoPaceDurationMs } from "${root}/packages/viewer-core/src/playback.mjs";

const seeds = ${JSON.stringify(SEEDS)};
const select = makeSelectData();
const all = [];
for (const seed of seeds) {
  const home = makeTacticalInput("H", seed), away = makeTacticalInput("A", seed);
  const carry = runFirstHalf(seed, home, away, select, defaultEngineConfig);
  const h1 = { snaps: carry.snapshots.slice(), events: carry.events.slice() };
  const n1 = carry.snapshots.length, e1 = carry.events.length;
  const full = resumeSecondHalf(carry, home, away);
  const h2 = { snaps: full.tickSnapshots.slice(n1), events: full.events.slice(e1) };
  const d1 = autoPaceDurationMs(h1.snaps, h1.events) / 1000;
  const d2 = autoPaceDurationMs(h2.snaps, h2.events) / 1000;
  all.push(d1, d2);
  console.log(\`\${seed}  H1 \${d1.toFixed(1)}s (\${h1.snaps.length}틱)   H2 \${d2.toFixed(1)}s (\${h2.snaps.length}틱)\`);
}
all.sort((a, b) => a - b);
const mean = all.reduce((a, b) => a + b, 0) / all.length;
console.log(\`\\nn=\${all.length}  min \${all[0].toFixed(1)}s  p50 \${all[Math.floor(all.length/2)].toFixed(1)}s  mean \${mean.toFixed(1)}s  max \${all[all.length-1].toFixed(1)}s\`);
console.log(\`→ 권장 half-real-ms ≈ \${Math.round(mean/10)*10_000}  (현행값과 다르면 application.yml 의 hmb.match.clock.half-real-ms 를 맞춘다)\`);
`;

execFileSync("npx", ["tsx", "--eval", script], {
  cwd: root,
  stdio: "inherit",
});
