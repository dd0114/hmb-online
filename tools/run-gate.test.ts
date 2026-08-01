import { describe, it, expect } from "vitest";
// 순수 ESM 도구(JSDoc 런타임) — 파싱·판정 함수만 계약으로 검증한다.
import { parseForeignHeavy, parsePsLine } from "./run-gate.mjs";

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
