/**
 * 무거운 검증 실행의 **세션 간 동시성 상한** — #376 / #377 M0-3
 *
 * ## 사건
 * `engdeep` 이 vitest 를 2h13m 돌리는 동안 `testcost`·`formgate`·`shortgame`·`deploy2` 가 같은
 * 머신을 썼다. 각자 "내 테스트는 4분"이어도 **동시에 돌면 머신이 죽는다** — load average 328.
 * 조율 지점이 없다는 것이 원인이었다.
 *
 * ## 설계
 * 데몬도 서버도 없다. `$HOME/.hmb-gate-locks/` 의 **파일 = 슬롯**이고, 슬롯 수를 넘으면 기다린다.
 *
 * - 정원 = `HMB_GATE_SLOTS`(기본 **1**). vitest 는 이미 코어를 다 쓴다 — 2개를 동시에 돌리는 것은
 *   빨라지지 않고 서로를 느리게 만들 뿐이다(그리고 게이트 수치가 부하에서 흔들려 거짓 red 가 난다, #344).
 * - `--exclusive` = playwright 처럼 **혼자 써야 하는** 실행. 다른 모든 슬롯이 빌 때까지 기다린다.
 * - **죽은 홀더는 자동 회수**한다(PID liveness). ⚠️ 프로세스 종료는 PID 로만 — 패턴 kill 금지.
 * - 타임아웃(기본 30분)에 걸리면 **막지 않고 경고 후 진행**한다. 게이트가 작업을 영구히 세우는 것이
 *   부하보다 나쁘다.
 * - `HMB_NO_GATE=1` 이면 통째로 우회.
 *
 * ## 사용
 *   node tools/run-gate.mjs --label t1 -- npm run test:t1
 *   node tools/run-gate.mjs --label playwright --exclusive -- npx playwright test
 *   node tools/run-gate.mjs --status
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = process.env.HMB_GATE_LOCK_DIR || join(homedir(), ".hmb-gate-locks");
const SLOTS = Math.max(1, Number(process.env.HMB_GATE_SLOTS || 1));
const TIMEOUT_MS = Math.max(0, Number(process.env.HMB_GATE_TIMEOUT_MS || 30 * 60 * 1000));
const POLL_MS = 1500;

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const flags = dashdash === -1 ? argv : argv.slice(0, dashdash);
const cmd = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const flag = (name) => flags.includes(name);
const opt = (name, dflt) => {
  const i = flags.indexOf(name);
  return i > -1 && flags[i + 1] ? flags[i + 1] : dflt;
};

const LABEL = opt("--label", "gate");
const EXCLUSIVE = flag("--exclusive");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 현재 홀더 목록. 죽은 것은 여기서 회수한다. */
function holders() {
  mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = join(DIR, f);
    let rec;
    try {
      rec = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      rmSync(p, { force: true });
      continue;
    }
    if (!rec.pid || !alive(rec.pid)) {
      rmSync(p, { force: true }); // 죽은 홀더 자동 회수
      continue;
    }
    out.push({ ...rec, file: p });
  }
  return out;
}

/** 레지스트리 조작 임계구역 — `mkdir` 은 원자적이라 그 자체가 스핀락이다. */
function withRegistryLock(fn) {
  const lock = join(DIR, ".registry.lock");
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < 200; i++) {
    try {
      mkdirSync(lock);
      try {
        return fn();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 오래된 락은 버린다(다른 프로세스가 임계구역에서 죽은 경우).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  rmSync(lock, { recursive: true, force: true });
  return fn();
}

function tryAcquire() {
  return withRegistryLock(() => {
    const cur = holders();
    if (EXCLUSIVE ? cur.length > 0 : cur.length >= SLOTS || cur.some((h) => h.exclusive)) {
      return { ok: false, blockedBy: cur };
    }
    const file = join(DIR, `${process.pid}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        pid: process.pid,
        label: LABEL,
        exclusive: EXCLUSIVE,
        cmd: cmd.join(" "),
        cwd: process.cwd(),
        session: process.env.HMB_SESSION || null,
        startedIso: new Date().toISOString(),
      }),
    );
    return { ok: true, file };
  });
}

if (flag("--status")) {
  const cur = holders();
  process.stdout.write(`게이트 슬롯 ${cur.length}/${SLOTS}${cur.some((h) => h.exclusive) ? " (배타 점유)" : ""}\n`);
  for (const h of cur) {
    process.stdout.write(`  pid ${h.pid} · ${h.label}${h.exclusive ? " [배타]" : ""} · ${h.startedIso} · ${h.cmd}\n`);
  }
  process.exit(0);
}

if (cmd.length === 0) {
  process.stderr.write("사용: node tools/run-gate.mjs [--label X] [--exclusive] -- <명령>\n");
  process.exit(2);
}

async function main() {
  let held = null;
  if (!process.env.HMB_NO_GATE) {
    const deadline = Date.now() + TIMEOUT_MS;
    let announced = false;
    for (;;) {
      const got = tryAcquire();
      if (got.ok) {
        held = got.file;
        break;
      }
      if (Date.now() > deadline) {
        process.stderr.write(`⚠️ 게이트 대기 ${Math.round(TIMEOUT_MS / 60000)}분 초과 — 막지 않고 진행한다.\n`);
        break;
      }
      if (!announced) {
        announced = true;
        const who = got.blockedBy
          .map((h) => `pid ${h.pid} ${h.label}${h.exclusive ? "[배타]" : ""} (${h.cwd})`)
          .join(", ");
        process.stderr.write(`⏳ 다른 세션이 무거운 검증 중 — 대기: ${who}\n   (우회: HMB_NO_GATE=1)\n`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const release = () => {
    if (held && existsSync(held)) rmSync(held, { force: true });
    held = null;
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { release(); process.exit(130); });
  process.on("exit", release);

  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", shell: false });
  child.on("error", (e) => {
    release();
    process.stderr.write(`실행 실패: ${e.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    release();
    process.exit(signal ? 1 : (code ?? 0));
  });
}

main();
