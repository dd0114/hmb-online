import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// 순수 ESM 도구(JSDoc 런타임) — 파싱·판정 함수만 계약으로 검증한다.
import { parseForeignHeavy, parsePsLine, findNestedHolder } from "./run-gate.mjs";

type Found = { pid: number; cpu: number; cmd: string };
const find = (lines: string[], own: number[] = [], cpuMin = 50): Found[] =>
  parseForeignHeavy(lines, new Set(own), cpuMin) as Found[];

/**
 * 게이트 밖 무거운 실행 감지의 계약 — #376 후속.
 *
 * ⚠️ **표본은 전부 이 머신의 진짜 `ps -Ao pid,ppid,%cpu,command` 출력에서 떠 왔다.**
 * 지어낸 표본으로 계약을 세웠다가 **두 번** 놓쳤다:
 * 1. `node ./node_modules/.bin/vitest --watch` 같은 문자열로 세웠는데 node 는 argv 를 즉시 덮어써
 *    **그런 형태는 실재하지 않는다** → 가장 흔한 `npm test` 를 통째로 미탐.
 * 2. 고친 뒤에도 워치 표본이 여전히 지어낸 것이라, **유휴 워처가 실행 중인 것과 구별되지 않는다**는
 *    사실을 계약이 못 잡았다 → 워처 하나에 게이트가 5분씩 서는 오탐.
 *
 * 그래서 판정축이 이름이 아니라 **트리 CPU 합**이다. 아래 두 표본이 그 근거다 — **타이틀이 같고
 * 구조도 같은데(워처도 워커를 갖는다) CPU 만 다르다.**
 */

/**
 * 실측 — 이 리포의 **표준 워치**(`npm run test:watch`). ⚠️ `--watch` 가 **어디에도 없다** —
 * 부모는 `npm run test:watch`, 루트는 `node (vitest)`. 이름으로 워치를 가르는 건 불가능하다.
 */
const REAL_NPM_WATCH = [
  "  30001     1   0.0 npm run test:watch  ",
  "  30002 30001   0.0 node (vitest)  ",
  "  30003 30002   0.0 node (vitest 1)     ",
];

/** 실측 — 유휴 워처. 루트·워커 전부 0.0%. 실행 중인 것과 **타이틀·구조가 같다**. */
const REAL_IDLE_WATCH = [
  "  82256     1   0.0 npm exec vitest --watch   ",
  "  82354 82256   0.0 node (vitest)  ",
  "  82364 82354   0.0 node (vitest 2)     ",
  "  82365 82354   0.0 node (vitest 3)     ",
  "  82391 82354   0.0 node (vitest 1)     ",
];

/** 실측 — 게이트 밖 `npm test` 실행 중. 같은 타이틀인데 워커가 CPU 를 태운다. */
const REAL_ACTIVE_RUN = [
  "  85207     1   0.0 npm test  ",
  "  85247 85207   4.1 node (vitest)  ",
  "  85260 85247  52.8 node (vitest 1)     ",
  "  85261 85247  36.2 node (vitest 2)     ",
  "  85262 85247  13.1 node (vitest 3)     ",
];

/** 실측 — 이 리포의 `npm test`(게이트를 거친 경로). 조상에 run-gate 가 있다. */
const REAL_GATED = [
  "  57197     1   0.0 npm test  ",
  "  57237 57214   0.4 node tools/run-gate.mjs --label t1 -- vitest run",
  "  57266 57237   4.0 node (vitest)  ",
  "  57286 57266  54.1 node (vitest 6)     ",
];

/** 실측 — `npx vitest run …`(게이트 밖). npm exec 래퍼가 남는다. */
const REAL_NPX = [
  "  71714     1   0.2 npm exec vitest run packages/engine/src/determinism.test.ts    ",
  "  71738 71714  60.0 node (vitest)   ",
];

/** 실측 — 세션 래퍼 셸. 명령줄에 `vitest` 를 품고 며칠씩 떠 있다. */
const REAL_SHELL_WRAPPER = [
  "  43350     1   0.5 /bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1784828420084.sh 2>/dev/null && npx vitest run",
  // SHELLish 가드가 **실제로 필요한** 형태 — 셸이 vitest 바이너리를 직접 부른다.
  "  43351     1  70.0 /bin/bash -c node node_modules/.bin/vitest run packages/engine",
];

/** 실측 — 다른 세션이 남긴 고아 워커들(부모가 죽어 ppid 1). 루트가 아니다. */
const REAL_ORPHAN_WORKERS = [
  "  36609     1   7.6 node (vitest 3)     ",
  "  36673     1   8.4 node (vitest 6)     ",
  "  38683     1  52.8 node (vitest 8)     ",
];

describe("parsePsLine", () => {
  it("pid·ppid·%cpu·command 를 가른다", () => {
    expect(parsePsLine("  85247 85207   4.1 node (vitest)  ")).toEqual({
      pid: 85247,
      ppid: 85207,
      cpu: 4.1,
      cmd: "node (vitest)",
    });
  });
  it("파싱 불가 줄은 null(ps 포맷 변화에 죽지 않는다)", () => {
    for (const l of ["", "  garbage", "PID PPID %CPU COMMAND"]) expect(parsePsLine(l)).toBeNull();
  });
});

describe("parseForeignHeavy — 실측 형태 (#376)", () => {
  /** 2차 blocker: 이 형태를 통째로 놓쳤다(origin/main 의 `test` 가 `vitest run` 이라 fleet 의 지배적 형태). */
  it("게이트 밖 `npm test` 실행 중 → 루트 1건 (워커는 안 센다)", () => {
    const out = find(REAL_ACTIVE_RUN);
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(85247);
    expect(out[0]?.cpu).toBeGreaterThan(50);
  });

  /** 3차 blocker: 타이틀·구조가 실행 중인 것과 같아 이름으로는 절대 못 가른다. CPU 가 유일한 축이다. */
  it("유휴 워처는 안 센다 — 타이틀·구조가 같아도 CPU 가 0이다", () => {
    expect(find(REAL_IDLE_WATCH)).toEqual([]);
  });

  /** 이 리포의 표준 워치 — `--watch` 문자열이 아예 없어 이름 기반 필터가 원리적으로 불가능하다. */
  it("`npm run test:watch` 유휴도 안 센다 (--watch 문자열이 어디에도 없다)", () => {
    expect(REAL_NPM_WATCH.join(" ")).not.toContain("--watch");
    expect(find(REAL_NPM_WATCH)).toEqual([]);
    // 돌기 시작하면 잡힌다.
    expect(find(REAL_NPM_WATCH.map((l) => l.replace(/\s0\.0\s/, "  60.0 ")))).toHaveLength(1);
  });

  /** ROOT_TITLE 이 없으면 이 형태를 아무 패턴도 못 잡는다(playwright 는 vitest 패턴에 안 걸린다). */
  it("playwright 루트 타이틀(`node (playwright)`)을 잡는다", () => {
    const out = find(["  40001     1   0.5 npm run e2e  ", "  40002 40001  80.0 node (playwright)  "]);
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(40002);
  });

  /**
   * 조상에 `run-gate.mjs` 라는 **글자만** 있는 셸 래퍼가 진짜 감지를 죽이던 결함(3차 검증 실측).
   * 조상 검사에서 셸을 빼지 않으면 이 케이스가 `[]` 로 새어나간다.
   */
  it("명령줄에 run-gate 를 품은 셸 아래의 진짜 실행은 잡는다", () => {
    const out = find([
      "  50001     1   0.2 /bin/bash -c npx vitest run pkg; node tools/run-gate.mjs --status",
      "  50002 50001   1.0 npm exec vitest run pkg    ",
      "  50003 50002  90.0 node (vitest)  ",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(50002);
  });

  it("워처가 **실제로 돌기 시작하면** 잡는다(유휴만 빼는 것이지 워처를 면제하는 게 아니다)", () => {
    const busyWatch = REAL_IDLE_WATCH.map((l) => l.replace(/\s0\.0\s/, "  60.0 "));
    expect(find(busyWatch)).toHaveLength(1);
  });

  it("게이트를 거친 실행은 안 센다 — 조상에 run-gate 가 있다", () => {
    expect(find(REAL_GATED)).toEqual([]);
  });

  it("`npx vitest` 는 트리당 1건 (npm exec 부모 + (vitest) 루트를 중복 계수하지 않는다)", () => {
    const out = find(REAL_NPX);
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(71714);
  });

  /**
   * SHELLish 가드가 없으면 두 번째 줄(셸이 vitest 바이너리를 직접 부르는 형태)이 잡힌다.
   * 가드를 지우면 이 케이스가 red 가 되도록 표본을 골랐다 — 없으면 그 가드는 tautology 다.
   */
  it("셸 래퍼는 안 센다(명령줄에 vitest 를 품어도)", () => {
    expect(find(REAL_SHELL_WRAPPER)).toEqual([]);
  });

  it("부모가 죽은 고아 워커는 루트로 세지 않는다", () => {
    expect(find(REAL_ORPHAN_WORKERS)).toEqual([]);
  });

  it("우리 실행과 그 자손은 안 센다(조상 체인으로)", () => {
    expect(find(REAL_ACTIVE_RUN, [85207])).toEqual([]);
  });

  it("여러 세션이 동시에 돌면 트리 수만큼 잡는다", () => {
    const out = find([...REAL_ACTIVE_RUN, ...REAL_NPX]);
    expect(out.map((o) => o.pid).sort()).toEqual([71714, 85247]);
  });

  it("playwright 도 잡는다", () => {
    const out = find(["   5001     1  70.0 npm exec playwright test", "   5002  5001  10.0 node (playwright 2)"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(5001);
  });

  it("무관한 프로세스는 안 센다", () => {
    expect(
      find([
        "   6001     1  90.0 node tools/tuning-harness/server.mjs --port 8310",
        "   6002     1  80.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "   6003     1  99.0 java -jar server.jar",
        "   6004     1  70.0 node tools/qa-console/api-main.mjs",
      ]),
    ).toEqual([]);
  });

  it("CPU 하한은 조절 가능하고 실제로 판정을 바꾼다", () => {
    expect(find(REAL_ACTIVE_RUN, [], 500)).toEqual([]); // 하한을 올리면 안 잡힌다
    expect(find(REAL_IDLE_WATCH, [], 0)).toHaveLength(1); // 0 이면 유휴도 잡힌다
  });
});

/* ─────────────────────────── 중첩(자기 데드락) 감지 ─────────────────────────── */

/**
 * `run-gate --label X -- npm test` 처럼 **게이트를 내장한 표준 스크립트를 다시 감싸면** 바깥이
 * 슬롯 1/1 을 쥔 채 안쪽이 같은 슬롯을 기다려 **자기 자식을 굶긴다**(CPU 0% 로 30분).
 *
 * ⚠️ 위 머리말과 같은 규율 — **표본은 지어내지 않았다.** 아래 A/B 는 이 머신에서 중첩 시나리오를
 * 실제로 띄우고 찍은 `ps -Ao pid,ppid,%cpu,command` 원문이다(2026-08-03, 수정 전 코드).
 * 재현:
 * ```
 * HMB_GATE_LOCK_DIR=$SP/lockA node tools/run-gate.mjs --label outer -- \
 *   bash -c 'node tools/run-gate.mjs --label inner -- sleep 40' &
 * HMB_GATE_LOCK_DIR=$SP/lockD node tools/run-gate.mjs --label other -- bash -c 'sleep 40' &
 * sleep 6 && ps -Ao pid,ppid,%cpu,command
 * ```
 * 그때 `lockA` 안쪽이 남긴 로그가 정확히 이 버그다:
 * `⏳ 다른 세션이 무거운 검증 중 — 대기: pid 26048 outer` ← **자기 부모를 기다린다.**
 */
const REAL_NESTED = [
  "26048 25663   0.0 node tools/run-gate.mjs --label outer -- bash -c node tools/run-gate.mjs --label inner -- sleep 40",
  "26049 25663   0.0 node tools/run-gate.mjs --label other -- bash -c sleep 40",
  "26080 26048   0.0 node tools/run-gate.mjs --label inner -- sleep 40",
  "26091 26049   0.0 sleep 40",
  // 같은 스냅샷에 실제로 있던 **다른 워크트리 세션**의 게이트 실행(무관한 제3자).
  "26093 26092   0.0 node ../../tools/run-gate.mjs --label ivr2-mu --exclusive -- ../../node_modules/.bin/playwright test -x e2e/p403-result-players.spec.ts",
];
/** 위 스냅샷 시점의 실제 홀더 파일 내용(`$SP/lockA/26048.json`). */
const HOLDER_OUTER = { pid: 26048, childPid: 26080, label: "outer", exclusive: false };
/** 같은 시점의 **무관한 다른 세션** 홀더(`$SP/lockD/26049.json`). */
const HOLDER_UNRELATED = { pid: 26049, childPid: 26091, label: "other", exclusive: false };

/**
 * 실측 B — **wrapper 를 `kill -9` 한 뒤** 살아남은 자식 아래에서 안쪽 게이트가 뜬 형태.
 * `holders()` 의 "wrapper/child 둘 중 하나라도 살아 있으면 점유" 불변식 때문에 홀더 레코드는 남고,
 * 그 pid(28343)는 **ps 에 없다** → 조상 체인은 `childPid` 로만 이어진다.
 * 재현: 위와 같되 `bash -c 'sleep 3; node tools/run-gate.mjs …'`(`;` 라 bash 가 exec 하지 않는다)
 * 로 띄우고 `kill -9 <wrapper>` 후 `ps`.
 */
const REAL_NESTED_CHILD_ONLY = [
  "28408     1   0.0 bash -c sleep 3; node tools/run-gate.mjs --label inner -- sleep 40",
  "29007 28408   0.0 node tools/run-gate.mjs --label inner -- sleep 40",
];
/** 그 시점의 홀더 파일 — `pid` 28343 은 이미 죽어 ps 에 없고 `childPid` 28408 만 살아 있다. */
const HOLDER_ORPHANED_WRAPPER = { pid: 28343, childPid: 28408, label: "outer", exclusive: false };

describe("findNestedHolder — 자기 데드락 감지", () => {
  it("홀더가 조상(pid)에 있으면 중첩으로 판정한다", () => {
    // 안쪽 게이트 26080 의 부모가 곧 홀더 wrapper 26048 이다.
    expect(findNestedHolder(REAL_NESTED, 26080, [HOLDER_OUTER])).toBe(HOLDER_OUTER);
  });

  it("childPid 로만 이어진 경우도 중첩으로 판정한다(wrapper 가 죽어 ps 에 없다)", () => {
    expect(REAL_NESTED_CHILD_ONLY.join(" ")).not.toContain(" 28343 ");
    expect(findNestedHolder(REAL_NESTED_CHILD_ONLY, 29007, [HOLDER_ORPHANED_WRAPPER])).toBe(HOLDER_ORPHANED_WRAPPER);
  });

  /**
   * ⚠️ **가장 중요한 계약.** 여기서 오탐이 나면 동시성 상한이 통째로 무너진다(모두가 통과한다).
   * 무관한 홀더는 조상 체인에 없다 — 형제 트리이거나 다른 워크트리다.
   */
  it("무관한 다른 세션의 홀더는 중첩이 아니다 (오탐 방지)", () => {
    // 26080(트리 A 안쪽) 의 조상은 26048 뿐 — 26049/26091(트리 D)은 형제다.
    expect(findNestedHolder(REAL_NESTED, 26080, [HOLDER_UNRELATED])).toBeNull();
    // 다른 워크트리 세션의 게이트(26093)도 홀더 A 안에 있지 않다.
    expect(findNestedHolder(REAL_NESTED, 26093, [HOLDER_OUTER])).toBeNull();
    // 홀더 wrapper 자신은 자기 자신 안에 중첩된 것이 아니다(조상만 본다).
    expect(findNestedHolder(REAL_NESTED, 26048, [HOLDER_OUTER])).toBeNull();
    // 여러 홀더를 동시에 줘도 조상인 것만 고른다.
    expect(findNestedHolder(REAL_NESTED, 26080, [HOLDER_UNRELATED, HOLDER_OUTER])).toBe(HOLDER_OUTER);
  });

  it("홀더가 없으면 null (슬롯이 비어 있으면 평소 경로)", () => {
    expect(findNestedHolder(REAL_NESTED, 26080, [])).toBeNull();
  });

  /** ps 를 못 읽거나 포맷이 깨지면 감지를 포기한다 — 오탐 통과보다 기존 대기가 낫다. */
  it("ps 파싱 실패·내가 안 보이면 null", () => {
    expect(findNestedHolder([], 26080, [HOLDER_OUTER])).toBeNull();
    expect(findNestedHolder(["garbage", "PID PPID %CPU COMMAND"], 26080, [HOLDER_OUTER])).toBeNull();
    expect(findNestedHolder(REAL_NESTED, 999999, [HOLDER_OUTER])).toBeNull(); // 내 pid 가 ps 에 없다
  });

  /**
   * 아래 두 표본은 **합성**이다(순환 ppid 는 실제 ps 에서 뜰 수 없고, 25단 체인은 재현 비용이 크다).
   * 형태 주장이 아니라 **walk 자체가 죽지 않는다**는 구조 성질만 본다.
   */
  it("조상 체인이 순환해도 죽지 않는다", () => {
    const cyclic = ["  100 101   0.0 node a", "  101 100   0.0 node b"];
    expect(findNestedHolder(cyclic, 100, [{ pid: 999, label: "x" }])).toBeNull();
  });

  it("조상 walk 은 상한 24 를 넘지 않는다", () => {
    // pid i 의 부모는 i+1. 0 에서 출발해 조상 1..24 까지 본다.
    const chain = Array.from({ length: 40 }, (_, i) => `  ${i} ${i + 1}   0.0 node p${i}`);
    expect(findNestedHolder(chain, 0, [{ pid: 24, label: "in" }])?.label).toBe("in");
    expect(findNestedHolder(chain, 0, [{ pid: 25, label: "out" }])).toBeNull();
  });
});

/* ───────────────────── 통합 계약 — 감싼 실행이 굶지 않는다 ───────────────────── */

const GATE = fileURLToPath(new URL("./run-gate.mjs", import.meta.url));

/** ⚠️ 락 디렉토리는 **반드시** 격리한다 — 진짜 `$HOME/.hmb-gate-locks` 를 오염시키면 다른 세션 게이트가 깨진다. */
function isolatedEnv(dir: string, timeoutMs: number) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HMB_GATE_LOCK_DIR: dir,
    HMB_GATE_TIMEOUT_MS: String(timeoutMs),
    HMB_GATE_FOREIGN_WAIT_MS: "0",
  };
  // ⚠️ 상속하면 게이트가 통째로 우회돼 이 계약이 **아무것도 재지 않는다**(실제로 그렇게 거짓 green 이 났다).
  delete env.HMB_NO_GATE;
  delete env.HMB_GATE_SLOTS;
  return env;
}

describe("run-gate 중첩 통합 (#25 run-gate 자기 데드락)", () => {
  it("run-gate 로 run-gate 를 감싸면 안쪽이 대기 없이 통과한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "hmb-gate-nest-"));
    const TIMEOUT = 4000;
    try {
      const t0 = Date.now();
      const r = spawnSync(
        "node",
        [GATE, "--label", "outer", "--", "node", GATE, "--label", "inner", "--", "node", "-e", "process.stdout.write('INNER_RAN')"],
        { encoding: "utf8", env: isolatedEnv(dir, TIMEOUT) },
      );
      const ms = Date.now() - t0;
      expect(r.stdout).toContain("INNER_RAN");
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("게이트 중첩 감지");
      // 수정 전이면 안쪽이 바깥 슬롯을 기다리다 TIMEOUT 을 통째로 소진하고 "초과" 경고를 낸다.
      expect(r.stderr).not.toContain("초과");
      expect(ms).toBeLessThan(TIMEOUT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * 오탐 방지의 **통합 층** — 조상이 아닌 홀더(형제 프로세스)가 쥔 슬롯은 여전히 기다린다.
   * 이게 깨지면 중첩 감지가 동시성 상한을 통째로 무력화한 것이다.
   */
  it("조상이 아닌 홀더의 슬롯은 여전히 기다린다 (동시성 상한 보존)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hmb-gate-sib-"));
    const TIMEOUT = 1500;
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" }); // 형제 프로세스 = 조상 아님
    try {
      writeFileSync(
        join(dir, `${sleeper.pid}.json`),
        JSON.stringify({ pid: sleeper.pid, label: "sibling", exclusive: false, cmd: "sleep 30", cwd: "/", startedIso: "2026-08-03T00:00:00.000Z" }),
      );
      const t0 = Date.now();
      const r = spawnSync("node", [GATE, "--label", "mine", "--", "node", "-e", "process.stdout.write('RAN')"], {
        encoding: "utf8",
        env: isolatedEnv(dir, TIMEOUT),
      });
      const ms = Date.now() - t0;
      expect(r.stderr).toContain("다른 세션이 무거운 검증 중"); // 대기했다
      expect(r.stderr).not.toContain("게이트 중첩 감지"); // 중첩으로 오판하지 않았다
      expect(ms).toBeGreaterThanOrEqual(TIMEOUT * 0.8);
      expect(r.stdout).toContain("RAN"); // 타임아웃 후에는 막지 않고 진행한다(보존 성질)
    } finally {
      if (sleeper.pid) process.kill(sleeper.pid, "SIGKILL"); // PID only — 패턴 kill 금지
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
