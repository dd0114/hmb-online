import { describe, it, expect } from "vitest";
// @ts-expect-error — 순수 ESM 도구(JSDoc 런타임). 타입 표면 없이 파싱 함수만 계약으로 검증한다.
import { parseForeignHeavy } from "./run-gate.mjs";

/**
 * 게이트 밖 무거운 실행 감지의 파싱 계약 — #376 후속.
 *
 * 왜 필요한가: 실물로 겪었다(2026-08-01). `--status` 는 **슬롯 0/1** 인데 머신 load 가 **330** 이었다.
 * 다른 세션이 `npm exec vitest run …` 을 게이트 밖에서 돌리고 있었고, 홀더 파일만 세는 계산에는
 * 그게 보이지 않았다. 협조적 락은 협조하지 않는 실행을 못 막지만 **보고 알릴 수는 있다**.
 *
 * 오탐이 곧 "남의 워치 모드 때문에 내 게이트가 5분 선다"이므로, 무엇을 **안 세는지**가 계약의 본체다.
 */

const ps = (lines: string[]): string[] => lines;

describe("parseForeignHeavy (#376)", () => {
  it("게이트 밖 vitest 루트를 잡는다", () => {
    const out = parseForeignHeavy(
      ps(["  59457   59067 npm exec vitest run packages/engine/src/realism/restart-kick.test.ts"]),
      new Set<number>(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(59457);
  });

  it("우리 실행과 그 워커는 안 센다", () => {
    const own = new Set([1000]);
    const out = parseForeignHeavy(
      ps([
        "   1000      1 node tools/run-gate.mjs --label t1 -- vitest run",
        "   1001   1000 node (vitest)",
        "   1002   1000 node (vitest 3)",
      ]),
      own,
    );
    expect(out).toEqual([]);
  });

  it("vitest 메인·워커 표기는 루트로 세지 않는다(중복 계수 방지)", () => {
    // 실측: `node (vitest)` 는 공백 뒤 숫자가 없어 처음엔 걸러지지 않았고, 실행 1건이 2건으로 잡혔다.
    const out = parseForeignHeavy(
      ps(["   2001   2000 node (vitest 7)", "   2002   2000 node (vitest)"]),
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("워치 모드는 안 센다 — 상시 떠 있어 게이트를 영구히 세운다", () => {
    const out = parseForeignHeavy(
      ps([
        "   3001      1 node ./node_modules/.bin/vitest --watch",
        "   3002      1 node ./node_modules/.bin/vitest watch",
      ]),
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("게이트를 거친 실행은 홀더 쪽에서 세므로 여기서 중복 계수하지 않는다", () => {
    const out = parseForeignHeavy(
      ps(["   4001      1 node tools/run-gate.mjs --label ladder -- vitest run packages/engine/src/realism"]),
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("playwright 도 잡는다", () => {
    const out = parseForeignHeavy(ps(["   5001      1 node ./node_modules/.bin/playwright test"]), new Set<number>());
    expect(out).toHaveLength(1);
  });

  /**
   * 실측 오탐(2026-08-01): 세션 래퍼 셸이 명령줄에 `vitest` 를 품고 며칠씩 떠 있어 통째로 잡혔다.
   * "그 단어가 있다"가 아니라 **실제 호출 형태**여야 한다 — 오탐 하나가 곧 남의 유휴 셸 때문에
   * 내 게이트가 5분 서는 일이다.
   */
  it("명령줄에 단어만 있는 래퍼 셸은 안 센다(실측 오탐)", () => {
    const out = parseForeignHeavy(
      ps([
        "  43350      1 /bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1784828420084.sh 2>/dev/null && npx vitest run",
        "  65952      1 /bin/zsh -c npm test # vitest",
      ]),
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("무관한 프로세스는 안 센다", () => {
    const out = parseForeignHeavy(
      ps([
        "   6001      1 node tools/tuning-harness/server.mjs --port 8310",
        "   6002      1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "   6003      1 java -jar server.jar",
      ]),
      new Set<number>(),
    );
    expect(out).toEqual([]);
  });

  it("파싱 불가 줄은 조용히 넘긴다(ps 포맷 변화에 죽지 않는다)", () => {
    expect(parseForeignHeavy(ps(["", "  garbage", "PID PPID COMMAND"]), new Set<number>())).toEqual([]);
  });
});
