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
/**
 * 게이트 **밖** 실행에 양보하는 상한. **기본 0 = 알리기만 하고 기다리지 않는다.**
 *
 * ⚠️ 이 기본값은 두 번의 사고에서 나왔다. 감지는 `ps` 휴리스틱이라 틀릴 수 있는데, 그걸
 * **권위**로 쓰면 틀리는 순간 fleet 전체가 선다(유휴 워처 하나에 모든 게이트 실행이 5분씩 멈췄다).
 * **강제는 슬롯 락이 한다**(그건 우리가 쓰는 파일이라 확실하다). 감지는 **정보**다 — "지금 수치가
 * 흔들릴 수 있다"를 알려주는 것이 본래 값어치고, 그건 0ms 로도 온전히 남는다.
 * 정말 기다리고 싶으면 `HMB_GATE_FOREIGN_WAIT_MS=300000` 처럼 **명시적으로 켠다**.
 */
const FOREIGN_WAIT_MS = Math.max(0, Number(process.env.HMB_GATE_FOREIGN_WAIT_MS || 0));
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
 * `npm test` 를 직접 돌리고 있었고, 홀더 파일만 세는 게이트에는 그게 보이지 않았다.
 * 협조적 락은 협조하지 않는 실행을 못 막지만, **보고 알릴 수는 있다** — 그리고 이건
 * **알림이지 강제가 아니다**(기본 대기 0, 위 `FOREIGN_WAIT_MS` 주석 참조).
 *
 * ⚠️ **프로세스 이름으로는 "무거운가"를 알 수 없다.** 두 번 데었다:
 *
 * ```
 * 82256     1  0.0  npm exec vitest --watch   ← 부모에만 --watch 가 남는다
 * 82354 82256  0.0  node (vitest)             ← 워처 루트. 실행 중인 것과 타이틀이 같다
 * 82364 82354  0.0  node (vitest 2)           ← 워처도 워커를 갖는다(구조로 구별 불가)
 *
 * 57266 57197 54.1  node (vitest)             ← 실제 실행 중
 * 57286 57266 52.8  node (vitest 8)           ← 워커가 CPU 를 태운다
 * ```
 * ①처음엔 `(vitest)` 를 워커로 오인해 지워서 **게이트 밖 `npm test` 를 통째로 놓쳤고**(2차 blocker)
 * ②고쳐서 루트로 세니 이번엔 **유휴 워처가 잡혀** 게이트가 5분씩 섰다(3차 blocker).
 *
 * 결론: 판정 축은 이름이 아니라 **지금 CPU 를 태우고 있는가**여야 한다 — #376 이 실제로 걱정한 것도
 * 프로세스의 존재가 아니라 **부하**였다. 그래서 **트리 CPU 합**(루트+자손)으로 판정한다.
 * 유휴 워처는 0.0% 라 자연히 빠지고, 실행 중이면 워처든 아니든 잡히는 게 맞다.
 *
 * ⚠️ 이름 기반 워치 필터는 **두지 않는다.** 이 리포의 표준 워치는 `npm run test:watch` 라
 * 부모에도 `--watch` 가 **어디에도 안 남는다**(실측). 이름으로 워치를 가르려는 시도는 전부
 * 실패했고, CPU 축이 유일한 방어다.
 */
const WORKER_TITLE = /\((?:vitest|playwright)\s+\d+\)/; // 숫자 필수 = 워커
const ROOT_TITLE = /\((?:vitest|playwright)\)/; // 숫자 없음 = 루트
const SHELLish = /shell-snapshots|^\/?(usr\/)?bin\/(ba|z|d)?sh\b/;

/**
 * 트리 CPU 합이 이 값 미만이면 "지금 무겁지 않다"로 본다(%).
 *
 * ⚠️ **절대 임계라 머신이 바쁠수록 미탐이 커진다** — 같은 실행이 한산할 때 78% 인데 load 130 에서는
 * 11~35% 로 떨어진다(실측). 즉 경고가 가장 필요한 순간에 약해진다. 그래서 임계를 **낮게** 잡는다:
 * 유휴 워처는 실측 **0.0%** 라 10 으로도 확실히 걸러지고, 부하 중 눌린 실행(11~35%)은 잡힌다.
 * 완전한 해법은 아니다(기동 램프 ~2.5초 구간은 여전히 미탐) — 감지가 **알림 전용**인 이유이기도 하다.
 */
const CPU_MIN = Number(process.env.HMB_GATE_CPU_MIN || 10);

/** ps 한 줄(`pid ppid %cpu command`) → 객체. 파싱 못 하면 null. */
export function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*\S)\s*$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), cmd: m[4] };
}

/**
 * @param psLines `ps -Ao pid,ppid,%cpu,command` 출력(헤더 제외)
 * @param ownPids 우리 실행 pid 집합
 * @param cpuMin 트리 CPU 하한(%). 기본 `HMB_GATE_CPU_MIN`.
 */
export function parseForeignHeavy(psLines, ownPids, cpuMin = CPU_MIN) {
  const rows = psLines.map(parsePsLine).filter(Boolean);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r);
  }

  /** 조상 체인(순환·고아 대비 상한). */
  const ancestors = (row) => {
    const out = [];
    let cur = byPid.get(row.ppid);
    for (let i = 0; i < 24 && cur; i++) {
      out.push(cur);
      cur = byPid.get(cur.ppid);
    }
    return out;
  };

  /** 자기 + 자손의 %cpu 합. 이게 "지금 머신을 먹고 있는 양"이다. */
  const treeCpu = (row) => {
    let sum = 0;
    const stack = [row];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur.pid)) continue;
      seen.add(cur.pid);
      sum += cur.cpu;
      for (const ch of children.get(cur.pid) ?? []) stack.push(ch);
    }
    return sum;
  };

  const isCandidate = (r) => {
    if (SHELLish.test(r.cmd)) return false;
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
    // ⚠️ 조상이 **게이트 실행 자체**일 때만 제외한다. raw 문자열로 보면 명령줄에 그 이름을 품은
    // 셸 래퍼까지 걸려 진짜 감지가 통째로 죽는다(3차 검증 실측).
    if (anc.some((a) => !SHELLish.test(a.cmd) && /run-gate\.mjs/.test(a.cmd))) continue;
    if (anc.some((a) => candidatePids.has(a.pid))) continue; // 같은 트리는 루트 하나만
    // ⚠️ 여기서 조상의 `--watch` 를 보고 빼면 안 된다. **워처를 면제하는 게 아니라 유휴를 빼는 것**이고,
    // 워처가 실제로 돌기 시작하면 그건 잡혀야 하는 부하다. 판정은 CPU 한 축으로 통일한다
    // (계약이 이 자기모순을 잡았다 — "워처가 돌기 시작하면 잡는다" 케이스가 red 였다).
    const cpu = treeCpu(c);
    if (cpu < cpuMin) continue; // 유휴 워처 등 — 지금 머신을 먹고 있지 않다
    out.push({ pid: c.pid, cpu: Math.round(cpu), cmd: c.cmd.slice(0, 110) });
  }
  return out;
}

function foreignHeavy(ownPids) {
  let psOut;
  try {
    psOut = execFileSync("ps", ["-Ao", "pid,ppid,%cpu,command"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
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
    for (const f of foreign) process.stdout.write(`  pid ${f.pid} · CPU ${f.cpu}% · ${f.cmd}\n`);
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
      if (!foreignAnnounced) {
        foreignAnnounced = true;
        process.stderr.write(
          `⚠️ 게이트를 안 거친 무거운 실행 ${foreign.length}건 — 슬롯 계산에 안 잡힌다:\n` +
            foreign.map((f) => `   pid ${f.pid} · CPU ${f.cpu}% · ${f.cmd}`).join("\n") +
            `\n   부하가 겹치면 게이트 수치가 흔들릴 수 있다(#344).` +
            `\n   (표준 경로는 npm test · test:t* · e2e — npx vitest 직접 실행은 이 게이트를 우회한다)\n`,
        );
      }
      // 기본은 **알리고 진행**. 기다리려면 HMB_GATE_FOREIGN_WAIT_MS 로 명시적으로 켠다.
      if (Date.now() > foreignDeadline) {
        if (FOREIGN_WAIT_MS > 0) {
          process.stderr.write(`⚠️ 게이트 밖 실행이 계속 돈다 — 더 기다리지 않고 진행한다.\n`);
        }
        break;
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

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;

  /**
   * ⚠️ **자식을 두고 슬롯만 놓지 않는다.** 종전엔 시그널에서 곧장 `release()` 후 종료해서,
   * `kill -TERM <wrapper>` 하면 vitest 는 계속 도는데 슬롯이 비었다 — `holders()` 가
   * "둘 중 하나라도 살아 있으면 점유"라고 적어 둔 불변식과 정면으로 어긋난다. 그리고 이 도구의
   * 논거 자체가 "감지는 알림, **강제는 슬롯 락**"이라, 가장 흔한 중단 경로에서 그 강제가 새면
   * 남는 게 없다. (이 머신에 고아 `node (vitest N)` 이 쌓여 있던 것과 같은 뿌리로 보인다.)
   *
   * 그래서 시그널을 **자식에게 전달**하고, 슬롯 해제는 자식의 `exit` 핸들러에 맡긴다.
   * 자식이 아직 없으면 그 자리에서 놓고 나간다.
   */
  const onSignal = (sig) => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig);
      } catch {
        /* 이미 죽었으면 exit 핸들러가 정리한다 */
      }
      return; // release 는 child.on("exit") 가 한다
    }
    release();
    process.exit(130);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => onSignal(sig));
  process.on("exit", release);

  child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", shell: false });
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
