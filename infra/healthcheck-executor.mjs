// AI 실행기 헬스체크.
//
// 배경(검증에서 지적된 결함): Java 도달성만 확인하면 **executor 와 무관한** 검사가 된다 —
// 다른 컨테이너에서 같은 명령을 돌려도 통과했고, 워커를 SIGSTOP 으로 멈춰도 healthy 로 남았다.
// executor 는 listen 포트가 없어서 포트 검사도 못 한다.
//
// 그래서 두 가지를 함께 본다:
//   1) 워커 프로세스가 존재하고 stopped(T)/zombie(Z) 가 아닐 것   ← 프로세스 자체
//   2) Java 에 토큰으로 도달 가능할 것                          ← 의존성
//
// ⚠️ 한계: R/S 상태로 **멈춘 폴링 루프(livelock)** 는 여전히 잡지 못한다.
//    진짜 해결은 executor 가 폴 사이클마다 heartbeat 파일을 touch 하고 여기서 신선도를 보는 것 —
//    packages/server 도메인 변경이라 별도 이슈로 올렸다. 이 스크립트는 그때 (1) 을 교체하면 된다.

import fs from "node:fs";

function fail(msg) {
  console.error(`[hc] FAIL: ${msg}`);
  process.exit(1);
}

// ── 1) 워커 프로세스 상태 ────────────────────────────────────────────────────
// tsx 는 node 프로세스를 2개 만든다(런처 + 로더가 붙은 실제 워커). 둘 중 **아무거나** 멈추면
// 실행기는 동작하지 않으므로 전부 검사하고 하나라도 나쁘면 실패시킨다.
// (초기 구현은 cmdline 에서 "/node" 를 찾다가 "/node_modules" 에 오탐해 런처만 보고 통과했다.)
const workers = [];
for (const d of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(d)) continue;
  let cmd;
  try {
    cmd = fs.readFileSync(`/proc/${d}/cmdline`, "utf8");
  } catch {
    continue; // 순회 중 종료된 프로세스
  }
  if (!cmd.includes("executor-main")) continue;
  // argv[0] 의 basename 이 node 인 것만 — sh/npm 래퍼는 제외.
  const argv0 = cmd.split("\0")[0] ?? "";
  if (argv0.split("/").pop() !== "node") continue;
  workers.push(d);
}
if (workers.length === 0) fail("executor worker process not found");

const states = [];
for (const pid of workers) {
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    fail(`worker pid=${pid} vanished`);
  }
  // comm 에 공백/괄호가 들어갈 수 있어 마지막 ')' 이후부터 파싱한다.
  const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  if (state === "T" || state === "t") fail(`worker pid=${pid} is stopped (state=${state})`);
  if (state === "Z") fail(`worker pid=${pid} is a zombie`);
  states.push(`${pid}:${state}`);
}

// ── 2) Java 도달성 ──────────────────────────────────────────────────────────
const javaUrl = process.env.JAVA_URL;
const token = process.env.SERVANT_TOKEN;
if (!javaUrl) fail("JAVA_URL not set");

try {
  const res = await fetch(`${javaUrl}/internal/health`, {
    headers: { "X-Servant-Token": token ?? "" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) fail(`java /internal/health -> HTTP ${res.status}`);
} catch (e) {
  fail(`java unreachable: ${e.message}`);
}

console.log(`[hc] ok (workers ${states.join(" ")})`);
