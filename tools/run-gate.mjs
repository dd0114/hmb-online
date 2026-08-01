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
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

const DIR = process.env.HMB_GATE_LOCK_DIR || join(homedir(), ".hmb-gate-locks");
const SLOTS = Math.max(1, Number(process.env.HMB_GATE_SLOTS || 1));
const TIMEOUT_MS = Math.max(0, Number(process.env.HMB_GATE_TIMEOUT_MS || 30 * 60 * 1000));
/** 게이트 **밖** 실행에 양보하는 상한 — 통제 못 하는 대상이라 홀더 대기보다 훨씬 짧다. */
const FOREIGN_WAIT_MS = Math.max(0, Number(process.env.HMB_GATE_FOREIGN_WAIT_MS || 5 * 60 * 1000));
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
    // wrapper 가 `kill -9` 로 죽으면 exit 핸들러가 안 돌아 슬롯이 남는다. 그런데 자식(vitest)은
    // 살아 있을 수 있으므로 **둘 중 하나라도 살아 있으면** 점유로 본다 — wrapper 만 보고 회수하면
    // 두 번째 무거운 실행이 살아 있는 vitest 와 함께 뜬다.
    const held = (rec.pid && alive(rec.pid)) || (rec.childPid && alive(rec.childPid));
    if (!held) {
      rmSync(p, { force: true }); // 죽은 홀더 자동 회수
      continue;
    }
    out.push({ ...rec, file: p });
  }
  return out;
}

/**
 * 게이트를 **거치지 않은** 무거운 실행 감지 — 협조적 락의 구멍을 좁힌다.
 *
 * 실물로 겪었다(2026-08-01): `--status` 는 슬롯 0/1 인데 load 가 **330** 이었다. 다른 세션이
 * `npm exec vitest run …` 을 직접 돌리고 있었고, 홀더 파일만 세는 게이트에는 그게 보이지 않았다.
 * 협조적 락은 협조하지 않는 실행을 못 막지만, **보고 알릴 수는 있다.**
 *
 * 차단이 아니라 **짧은 양보**다(기본 5분). 우리가 통제하지 못하는 프로세스에 무한정 묶이는 것이
 * 부하보다 나쁘고, 오탐(다른 리포·워치 모드)도 있다. 홀더 대기(30분)보다 짧은 이유 = 홀더는
 * 곧 놓는다는 약속이 있고 외부는 없다.
 */
/**
 * ⚠️ **vitest 는 macOS 에서 자기 프로세스 타이틀을 덮어쓴다.** 실측 형태:
 * ```
 * 57197     1  npm test                 ← 부모(스크립트 문자열은 이미 사라졌다)
 * 57266 57237  node (vitest)            ← 루트. 숫자가 없다
 * 57286 57266  node (vitest 6)          ← 워커. 숫자가 있다
 * ```
 * 그래서 **루트를 찾는 유일한 신호가 `(vitest)` 타이틀**인 경우가 많다(`npm test` 는 원래
 * 커맨드라인이 남지 않는다). 앞선 판(`\(vitest ?\d*\)` 로 전부 제외)이 바로 이 루트를 지워서
 * `npm test` 를 통째로 못 잡았다 — 그때 "중복 2건"이라 본 것은 `npm exec vitest`(부모) +
 * `node (vitest)`(루트) 였고, **눌렀어야 할 쪽은 부모가 아니라 아무것도 아니었다**(ppid 로 접었어야 했다).
 *
 * 그래서 이제:
 * - 워커 제외는 **숫자 필수**(`(vitest 6)`), 숫자 없는 `(vitest)` 는 **루트로 센다**
 * - 중복 제거 축은 타이틀이 아니라 **ppid 체인** — 조상이 이미 후보면 접는다
 * - 조상 중에 `run-gate.mjs` 가 있으면 **게이트를 거친 실행**이라 홀더 쪽에서 세므로 제외
 */
const WORKER_TITLE = /\((?:vitest|playwright)\s+\d+\)/; // 숫자 필수 = 워커
const ROOT_TITLE = /\((?:vitest|playwright)\)/; // 숫자 없음 = 루트
const SHELLish = /shell-snapshots|^\/?(usr\/)?bin\/(ba|z|d)?sh\b/;
const WATCHish = /--watch|\bvitest\s+watch\b|--ui\b/;

/** ps 한 줄 → `{pid, ppid, cmd}`. 파싱 못 하면 null. */
export function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] };
}

export function parseForeignHeavy(psLines, ownPids) {
  const rows = psLines.map(parsePsLine).filter(Boolean);
  const byPid = new Map(rows.map((r) => [r.pid, r]));

  /** 조상 체인을 훑는다(순환·고아 대비 상한). */
  const ancestors = (row) => {
    const out = [];
    let cur = byPid.get(row.ppid);
    for (let i = 0; i < 24 && cur; i++) {
      out.push(cur);
      cur = byPid.get(cur.ppid);
    }
    return out;
  };

  const isCandidate = (r) => {
    if (SHELLish.test(r.cmd)) return false;
    if (WATCHish.test(r.cmd)) return false;
    if (WORKER_TITLE.test(r.cmd)) return false;
    if (/run-gate\.mjs/.test(r.cmd)) return false;
    return (
      ROOT_TITLE.test(r.cmd) ||
      /(^|\/)node\b[^|]*\bvitest\b/.test(r.cmd) ||
      /\bnpm\s+exec\s+vitest\b/.test(r.cmd) ||
      /\.bin\/vitest\b/.test(r.cmd) ||
      /\.bin\/playwright\b/.test(r.cmd) ||
      /\bplaywright\s+test\b/.test(r.cmd)
    );
  };

  const candidates = rows.filter(isCandidate);
  const candidatePids = new Set(candidates.map((c) => c.pid));

  const out = [];
  for (const c of candidates) {
    const anc = ancestors(c);
    if (ownPids.has(c.pid) || anc.some((a) => ownPids.has(a.pid))) continue; // 우리 실행과 그 자손
    if (anc.some((a) => /run-gate\.mjs/.test(a.cmd))) continue; // 게이트를 거친 실행
    if (anc.some((a) => candidatePids.has(a.pid))) continue; // 같은 트리는 루트 하나만
    out.push({ pid: c.pid, cmd: c.cmd.slice(0, 110) });
  }
  return out;
}

function foreignHeavy(ownPids) {
  let psOut;
  try {
    psOut = execFileSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return []; // ps 를 못 읽으면 감지를 포기한다 — 막지 않는다
  }
  return parseForeignHeavy(psOut.split("\n").slice(1), ownPids);
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

/**
 * CLI 진입은 **직접 실행일 때만**. 계약 테스트가 `parseForeignHeavy` 를 import 하는 순간
 * `process.exit(2)` 가 돌아버리면 그 함수는 영원히 테스트할 수 없다.
 */
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain && flag("--status")) {
  const cur = holders();
  process.stdout.write(`게이트 슬롯 ${cur.length}/${SLOTS}${cur.some((h) => h.exclusive) ? " (배타 점유)" : ""}\n`);
  for (const h of cur) {
    process.stdout.write(`  pid ${h.pid} · ${h.label}${h.exclusive ? " [배타]" : ""} · ${h.startedIso} · ${h.cmd}\n`);
  }
  const foreign = foreignHeavy(new Set([process.pid, ...cur.flatMap((h) => [h.pid, h.childPid].filter(Boolean))]));
  if (foreign.length) {
    process.stdout.write(`⚠️ 게이트를 안 거친 무거운 실행 ${foreign.length}건 — 슬롯 계산에 안 잡힌다:\n`);
    for (const f of foreign) process.stdout.write(`  pid ${f.pid} · ${f.cmd}\n`);
  }
  process.exit(0);
}

if (isMain && cmd.length === 0) {
  process.stderr.write("사용: node tools/run-gate.mjs [--label X] [--exclusive] -- <명령>\n");
  process.exit(2);
}

/** 분 단위로 반올림하면 짧은 상한이 "최대 0분"으로 찍힌다 — 60초 미만은 초로 쓴다. */
function humanWait(ms) {
  return ms < 60_000 ? `${Math.round(ms / 1000)}초` : `${Math.round(ms / 60_000)}분`;
}

async function main() {
  let held = null;
  if (!process.env.HMB_NO_GATE) {
    /**
     * ① 게이트 **밖** 실행에 먼저 양보한다 — **슬롯을 잡기 전에**.
     * 잡고 나서 양보하면 그 5분 동안 슬롯을 쥔 채로 다른 **게이트 안** 실행을 굶긴다
     * (게이트 밖에 양보하려다 게이트 안을 벌주는 셈). 최악 대기도 30분+5분 → 30분으로 준다.
     */
    const foreignDeadline = Date.now() + FOREIGN_WAIT_MS;
    let foreignAnnounced = false;
    for (;;) {
      const own = new Set([process.pid, ...holders().flatMap((h) => [h.pid, h.childPid].filter(Boolean))]);
      const foreign = foreignHeavy(own);
      if (foreign.length === 0) break;
      if (Date.now() > foreignDeadline) {
        process.stderr.write(
          `⚠️ 게이트 밖 실행 ${foreign.length}건이 계속 돈다 — 더 기다리지 않고 진행한다.\n` +
            `   부하가 겹치면 게이트 수치가 흔들릴 수 있다(#344).\n`,
        );
        break;
      }
      if (!foreignAnnounced) {
        foreignAnnounced = true;
        process.stderr.write(
          `⏳ 게이트를 안 거친 무거운 실행 대기(최대 ${humanWait(FOREIGN_WAIT_MS)}):\n` +
            foreign.map((f) => `   pid ${f.pid} · ${f.cmd}`).join("\n") +
            `\n   (표준 경로는 npm test · test:t* · e2e — npx vitest 직접 실행은 이 게이트를 우회한다)\n`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    // ② 그 다음 슬롯을 잡는다.
    const deadline = Date.now() + TIMEOUT_MS;
    let announced = false;
    for (;;) {
      const got = tryAcquire();
      if (got.ok) {
        held = got.file;
        break;
      }
      if (Date.now() > deadline) {
        process.stderr.write(`⚠️ 게이트 대기 ${humanWait(TIMEOUT_MS)} 초과 — 막지 않고 진행한다.\n`);
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
  // 자식 PID 를 홀더 파일에 기록 — wrapper 가 `kill -9` 로 죽어도 살아 있는 자식이 있으면
  // 슬롯을 회수하지 않는다(그러지 않으면 두 번째 무거운 실행이 함께 뜬다).
  if (held && existsSync(held)) {
    try {
      const rec = JSON.parse(readFileSync(held, "utf8"));
      writeFileSync(held, JSON.stringify({ ...rec, childPid: child.pid }));
    } catch {
      /* 기록 실패는 치명적이지 않다 — wrapper liveness 로 폴백 */
    }
  }
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

if (isMain) main();
