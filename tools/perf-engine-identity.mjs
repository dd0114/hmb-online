#!/usr/bin/env node
// AC-P2 박제 — 러너가 서빙하는 엔진이 QA v1 안정 태그와 동일함을 증명(재실행 가능 가드).
// 판정: (1) v1 이 HEAD 의 조상  (2) packages/engine/src diff v1..HEAD == 0  (3) shared/src diff == 0
//       (4) defaultEngineConfig.version == v1 태그 config 버전(engine@0.10.0)
//       (5) [옵션] RUNNER_HEALTH_URL 이 주어지면 /health.engineVersion 이 (4)와 일치.
// 사용: node tools/perf-engine-identity.mjs [RUNNER_HEALTH_URL]
//   ex) RUNNER_HEALTH_URL=http://localhost:8790/health node tools/perf-engine-identity.mjs
// exit 0 = PASS, 1 = FAIL. epic #82 AC-P2.
import { execSync } from "node:child_process";

const V1_TAG = "v1";
const EXPECTED_ENGINE_VERSION = "engine@0.10.0"; // v1 릴리스 config.version

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

// (1) v1 이 HEAD 의 조상인가
let ancestor = false;
try {
  execSync(`git merge-base --is-ancestor ${V1_TAG} HEAD`);
  ancestor = true;
} catch {
  ancestor = false;
}
const head = sh("git rev-parse --short HEAD");
check("v1 is ancestor of HEAD", ancestor, `HEAD=${head}`);

// (2) engine src diff v1..HEAD == 0
const engineDiff = sh(`git diff --stat ${V1_TAG} HEAD -- packages/engine/src`);
check("engine/src diff v1..HEAD == 0", engineDiff === "", engineDiff || "(no diff)");

// (3) shared src diff v1..HEAD == 0
const sharedDiff = sh(`git diff --stat ${V1_TAG} HEAD -- packages/shared/src`);
check("shared/src diff v1..HEAD == 0", sharedDiff === "", sharedDiff || "(no diff)");

// (4) worktree config.version == v1 릴리스 버전
const cfg = sh(`git grep -h "version:" -- packages/engine/src/config.ts | grep 'engine@'`);
const versionMatch = cfg.includes(EXPECTED_ENGINE_VERSION);
check(`config.version == ${EXPECTED_ENGINE_VERSION}`, versionMatch, cfg);

// (5) 옵션: 라이브 러너 /health
const healthUrl = process.argv[2] ?? process.env.RUNNER_HEALTH_URL;
if (healthUrl) {
  try {
    const body = sh(`curl -s --max-time 5 ${healthUrl}`);
    const served = JSON.parse(body).engineVersion;
    check(`runner /health == ${EXPECTED_ENGINE_VERSION}`, served === EXPECTED_ENGINE_VERSION, `served=${served}`);
  } catch (e) {
    check("runner /health reachable", false, String(e));
  }
}

let allPass = true;
for (const c of checks) {
  const mark = c.pass ? "PASS" : "FAIL";
  if (!c.pass) allPass = false;
  console.log(`[${mark}] ${c.name} — ${c.detail}`);
}
console.log(allPass ? "\nAC-P2 ENGINE IDENTITY: PASS" : "\nAC-P2 ENGINE IDENTITY: FAIL");
process.exit(allPass ? 0 : 1);
