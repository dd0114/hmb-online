import { describe, it, expect } from "vitest";
// 순수 ESM 도구(JSDoc 런타임) — 파싱 함수만 계약으로 검증한다.
import { parseForeignHeavy, parsePsLine } from "./run-gate.mjs";

type Found = { pid: number; cmd: string };

/**
 * 게이트 밖 무거운 실행 감지의 계약 — #376 후속.
 *
 * 왜 필요한가: 실물로 겪었다(2026-08-01). `--status` 는 **슬롯 0/1** 인데 머신 load 가 **330** 이었다.
 * 다른 세션이 `npm test` 를 게이트 밖에서 돌리고 있었고, 홀더 파일만 세는 계산에는 안 보였다.
 *
 * ⚠️ **이 스위트의 표본은 전부 이 머신의 진짜 `ps -Ao pid,ppid,command` 출력에서 떠 왔다.**
 * 처음 판은 손으로 지어낸 형태(`node ./node_modules/.bin/vitest --watch` 등)로 계약을 세웠는데,
 * node 는 argv 를 즉시 덮어써서 **그런 문자열은 실제로 존재하지 않는다**. 그래서 9건이 green 인 채로
 * 가장 흔한 형태(`npm test` → `node (vitest)`)를 통째로 놓쳤다. 지어낸 표본은 계약이 아니다.
 */

/** 실측 스냅샷 — `npm test`(게이트 밖). vitest 가 프로세스 타이틀을 덮어쓴 형태 그대로. */
const REAL_NPM_TEST = [
  "  57197     1 npm test  ",
  "  57266 57197 node (vitest)  ",
  "  57286 57266 node (vitest 6)     ",
  "  57300 57266 node (vitest 4)     ",
  "  57315 57266 node (vitest 5)     ",
];

/** 실측 스냅샷 — 이 리포의 `npm test`(게이트를 거친 경로). run-gate 가 조상에 있다. */
const REAL_GATED = [
  "  57197     1 npm test  ",
  "  57237 57214 node tools/run-gate.mjs --label t1 -- vitest run",
  "  57266 57237 node (vitest)  ",
  "  57286 57266 node (vitest 6)     ",
];

/** 실측 스냅샷 — `npx vitest run …`(게이트 밖). npm exec 래퍼가 남는다. */
const REAL_NPX = [
  "  71714     1 npm exec vitest run packages/engine/src/determinism.test.ts    ",
  "  71738 71714 node (vitest)   ",
];

/** 실측 스냅샷 — 세션 래퍼 셸. 명령줄에 `vitest` 를 품고 며칠씩 떠 있다. */
const REAL_SHELL = [
  "  43350     1 /bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1784828420084.sh 2>/dev/null && npx vitest run",
];

describe("parsePsLine", () => {
  it("pid·ppid·command 를 가른다", () => {
    expect(parsePsLine("  57266 57197 node (vitest)  ")).toEqual({ pid: 57266, ppid: 57197, cmd: "node (vitest)" });
  });
  it("파싱 불가 줄은 null(ps 포맷 변화에 죽지 않는다)", () => {
    for (const l of ["", "  garbage", "PID PPID COMMAND"]) expect(parsePsLine(l)).toBeNull();
  });
});

describe("parseForeignHeavy — 실측 형태 (#376)", () => {
  /**
   * **이 케이스가 blocker 였다.** 앞선 판은 `\(vitest ?\d*\)` 로 숫자 없는 `(vitest)` 까지 지워
   * 루트를 잃었고, 부모 `npm test` 는 어떤 호출 패턴에도 안 걸려 **감지 0** 이 됐다.
   * origin/main 의 `test` 스크립트가 `vitest run` 이라 다른 워크트리의 `npm test` 는 전부 이 형태다.
   */
  it("`npm test` → `node (vitest)` 루트를 잡는다 (워커는 안 센다)", () => {
    const out = parseForeignHeavy(REAL_NPM_TEST, new Set<number>()) as Found[];
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(57266);
    expect(out[0]?.cmd).toContain("(vitest)");
  });

  it("게이트를 거친 실행은 안 센다 — 조상에 run-gate 가 있으면 홀더 쪽에서 센다", () => {
    expect(parseForeignHeavy(REAL_GATED, new Set<number>())).toEqual([]);
  });

  it("`npx vitest` 는 트리당 1건이다 (npm exec 부모 + (vitest) 루트를 중복 계수하지 않는다)", () => {
    const out = parseForeignHeavy(REAL_NPX, new Set<number>()) as Found[];
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(71714); // 조상이 후보면 자손은 접는다
  });

  it("세션 래퍼 셸은 안 센다 — 단어만 품고 며칠 떠 있다", () => {
    expect(parseForeignHeavy(REAL_SHELL, new Set<number>())).toEqual([]);
  });

  it("우리 실행과 그 자손은 안 센다(조상 체인으로)", () => {
    const own = new Set([57197]);
    expect(parseForeignHeavy(REAL_NPM_TEST, own)).toEqual([]);
  });

  it("워치/UI 모드는 안 센다 — 상시 떠 있어 게이트를 영구히 세운다", () => {
    const out = parseForeignHeavy(
      ["   3001     1 node (vitest) --watch", "   3002     1 npm exec vitest --ui"],
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("playwright 도 잡고, 워커 표기는 안 센다", () => {
    const out = parseForeignHeavy(
      ["   5001     1 npm exec playwright test", "   5002  5001 node (playwright 2)"],
      new Set<number>(),
    ) as Found[];
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(5001);
  });

  it("무관한 프로세스는 안 센다", () => {
    const out = parseForeignHeavy(
      [
        "   6001     1 node tools/tuning-harness/server.mjs --port 8310",
        "   6002     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "   6003     1 java -jar server.jar",
        "   6004     1 node tools/qa-console/api-main.mjs",
      ],
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("여러 세션이 동시에 돌면 트리 수만큼 잡는다", () => {
    const out = parseForeignHeavy([...REAL_NPM_TEST, ...REAL_NPX], new Set<number>()) as Found[];
    expect(out.map((o) => o.pid).sort()).toEqual([57266, 71714]);
  });
});
