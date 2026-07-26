#!/usr/bin/env node
// qa-console — QA 콘솔 기동/정지/상태 (#191 AC5).
//
//   node tools/qa-console.mjs start|stop|status|restart|logs
//
// 구성(2프로세스, docs/plan-v5/qa-console.md §5 D3):
//   API  127.0.0.1:8301  ← 레지스트리 읽기/피드백 append
//   vite 127.0.0.1:8300  ← 콘솔 UI(`/qa/console`), `/qa-api` 는 위로 프록시
//
// 규칙:
//  · **nohup 분리기동** — 이 명령이 끝나도 콘솔은 계속 산다(hero 가 브라우저만 열어두면 됨).
//  · 종료는 **pid 파일의 PID 로만**. `pkill -f` 패턴은 다른 세션 스택을 죽인다(메모리 no-pattern-kill-in-fleet).
//  · 127.0.0.1 고정. 인증 없음 = 로컬 전용. 외부 노출·아티팩트 금지.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureHome, registryHome } from "./qa-console/registry.mjs";
import { ensureGitRepo } from "./qa-console/git.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const webRoot = join(repoRoot, "apps", "web");

const UI_PORT = Number(process.env.HMB_QA_CONSOLE_PORT ?? 8300);
const API_PORT = Number(process.env.HMB_QA_API_PORT ?? 8301);
const HOME_DIR = ensureHome(registryHome());
const PID_FILE = join(HOME_DIR, "console.pid");
const LOG_FILE = join(HOME_DIR, "console.log");
const CONSOLE_URL = `http://127.0.0.1:${UI_PORT}/qa/console`;

// ── pid 파일 ──────────────────────────────────────────────────────────────

function readPids() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const v = JSON.parse(readFileSync(PID_FILE, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // 신호 0 = 존재 확인만
    return true;
  } catch {
    return false;
  }
}

async function ping(port, path = "/qa-api/health") {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── 동사 ─────────────────────────────────────────────────────────────────

async function cmdStart() {
  const pids = readPids();
  if (pids && (alive(pids.api) || alive(pids.vite))) {
    process.stdout.write(`이미 떠 있다(api ${pids.api} · vite ${pids.vite})\n  → ${CONSOLE_URL}\n`);
    return 0;
  }
  rmSync(PID_FILE, { force: true });
  ensureGitRepo(HOME_DIR); // 기록 계층 준비(§3.1) — 첫 기동에 리포가 없으면 만든다

  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const out = openSync(LOG_FILE, "a");

  // API — 레지스트리 서버. detached 로 띄워 이 프로세스가 죽어도 산다.
  const api = spawn(process.execPath, [join(here, "qa-console", "api-main.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, HMB_QA_API_PORT: String(API_PORT), HMB_QA_CONSOLE_HOME: HOME_DIR },
    detached: true,
    stdio: ["ignore", out, out],
  });
  api.unref();

  // UI — vite dev. `/qa-api` 프록시 대상을 위 API 로 지정한다(CORS 회피 = 브라우저에서 동일 오리진).
  const vite = spawn("npx", ["vite", "--port", String(UI_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: webRoot,
    env: { ...process.env, VITE_QA_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    detached: true,
    stdio: ["ignore", out, out],
  });
  vite.unref();

  writeFileSync(PID_FILE, `${JSON.stringify({ api: api.pid, vite: vite.pid, uiPort: UI_PORT, apiPort: API_PORT, home: HOME_DIR }, null, 2)}\n`);

  // 기동 확인 — 떴다고만 말하고 실제로는 안 떠 있는 일이 없게 health 를 본다.
  const deadline = Date.now() + 30_000;
  let apiOk = false;
  let uiOk = false;
  while (Date.now() < deadline && !(apiOk && uiOk)) {
    apiOk = apiOk || (await ping(API_PORT));
    uiOk = uiOk || (await ping(UI_PORT, "/"));
    if (apiOk && uiOk) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write(
    [
      `[qa-console] ${apiOk && uiOk ? "기동 완료" : "기동 확인 실패 — 로그를 봐라"}`,
      `  콘솔     ${CONSOLE_URL}`,
      `  API      http://127.0.0.1:${API_PORT}/qa-api/health   ${apiOk ? "✓" : "✗"}`,
      `  UI(vite) http://127.0.0.1:${UI_PORT}/                 ${uiOk ? "✓" : "✗"}`,
      `  레지스트리 ${HOME_DIR}`,
      `  로그     ${LOG_FILE}   (node tools/qa-console.mjs logs)`,
      "",
    ].join("\n"),
  );
  return apiOk && uiOk ? 0 : 1;
}

function cmdStop() {
  const pids = readPids();
  if (!pids) {
    process.stdout.write("pid 파일이 없다 — 떠 있지 않다고 본다\n");
    return 0;
  }
  for (const [name, pid] of [["api", pids.api], ["vite", pids.vite]]) {
    if (!alive(pid)) continue;
    try {
      // PID 로만 죽인다. 패턴 kill 금지(다른 세션의 vite 를 같이 죽인다).
      process.kill(pid, "SIGTERM");
      process.stdout.write(`[qa-console] ${name}(${pid}) 종료 신호\n`);
    } catch (e) {
      process.stderr.write(`[qa-console] ${name}(${pid}) 종료 실패: ${e.message}\n`);
    }
  }
  rmSync(PID_FILE, { force: true });
  return 0;
}

async function cmdStatus() {
  const pids = readPids();
  const apiOk = await ping(API_PORT);
  const uiOk = await ping(UI_PORT, "/");
  const home = pids?.home ?? HOME_DIR;
  const git = spawnSync("git", ["-C", home, "log", "--oneline", "-1"], { encoding: "utf8" });
  const lines = [
    `레지스트리   ${home}`,
    `pid 파일     ${existsSync(PID_FILE) ? PID_FILE : "(없음)"}`,
    `API  :${API_PORT}  ${apiOk ? "✓ 응답" : "✗ 무응답"}  pid ${pids?.api ?? "-"}${alive(pids?.api) ? "(살아있음)" : ""}`,
    `UI   :${UI_PORT}  ${uiOk ? "✓ 응답" : "✗ 무응답"}  pid ${pids?.vite ?? "-"}${alive(pids?.vite) ? "(살아있음)" : ""}`,
    `git 최근 기록 ${git.status === 0 ? git.stdout.trim() : "(git 리포 아님)"}`,
    `콘솔 URL     ${CONSOLE_URL}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return apiOk && uiOk ? 0 : 1;
}

function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    process.stdout.write("로그가 아직 없다\n");
    return 0;
  }
  const all = readFileSync(LOG_FILE, "utf8").split("\n");
  process.stdout.write(`${all.slice(-80).join("\n")}\n`);
  return 0;
}

function cmdHelp() {
  process.stdout.write(
    `qa-console — QA 콘솔 기동/정지 (#191)

  start     nohup 분리기동(API ${API_PORT} + vite ${UI_PORT}) + health 확인
  stop      pid 파일의 PID 만 종료(패턴 kill 금지)
  restart   stop → start
  status    두 포트 응답 · pid 생존 · 최근 git 기록
  logs      최근 80줄

  콘솔 URL  ${CONSOLE_URL}
  레지스트리 ${HOME_DIR}   (HMB_QA_CONSOLE_HOME)
  포트 변경  HMB_QA_CONSOLE_PORT / HMB_QA_API_PORT

재부팅 후 복구: \`node tools/qa-console.mjs start\` 한 번. 탭·피드백·ack 은 파일이라 그대로 살아 있다.
`,
  );
  return 0;
}

const verb = process.argv[2] ?? "help";
let code = 0;
switch (verb) {
  case "start":
    code = await cmdStart();
    break;
  case "stop":
    code = cmdStop();
    break;
  case "restart":
    cmdStop();
    await new Promise((r) => setTimeout(r, 700));
    code = await cmdStart();
    break;
  case "status":
    code = await cmdStatus();
    break;
  case "logs":
    code = cmdLogs();
    break;
  default:
    code = cmdHelp();
}
process.exit(code);
