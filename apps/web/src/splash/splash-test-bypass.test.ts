/**
 * #479 — **우회 누락 가드**. `bypassSplash` 헬퍼 자체가 아니라 *그 헬퍼를 안 부르는 파일이
 * 생기는 것*을 막는 계약이다.
 *
 * ⚠️ 이 파일이 존재하는 이유(실사고): 스플래시가 `LoginPage` 의 **첫 화면을 대체**하므로,
 * `<LoginPage>` 를 렌더하는 기존 테스트는 전부 provider 버튼을 못 찾게 된다. 나는
 * `LoginPage.test.ts` 에만 우회를 넣고 `local-auth.test.ts`(17건)를 빠뜨린 채 커밋했고,
 * 내가 만진 파일만 골라 돌려서 그것을 못 봤다. 헬퍼로 빼는 것은 *중복*을 없애지만
 * **누락**은 못 없앤다 — 세 번째 파일은 그냥 안 부르면 되기 때문이다.
 *
 * 그래서 정적으로 훑는다: `LoginPage` 를 **import 하는** 테스트 파일은 `bypassSplash` 를
 * 참조해야 한다. 이 가드가 있었다면 그 커밋은 red 였다.
 *
 * ⚠️ 면제 = `SPLASH_EXEMPT`. 스플래시 **자체**를 검증하는 테스트는 우회하면 안 되므로
 * 명시적으로 적어 둔다(빈 목록이 아니라 이름으로 — 그러면 다음 사람이 왜 면제인지 읽는다).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** `apps/web/src` — 이 파일 기준. */
const SRC = join(__dirname, "..");

/**
 * 우회를 부르지 않아도 되는 파일. 지금은 **비어 있다** — 스플래시의 노출 조건을 직접
 * 단언하는 `LoginPage.test.ts` 조차 파일 차원에서는 우회를 켜고(공용 `beforeEach`),
 * 스플래시 전용 describe 안에서만 `sessionStorage.clear()` 로 되돌리기 때문이다.
 * 즉 **면제가 필요 없는 형태**가 존재하므로, 면제로 빼는 대신 그 형태를 쓴다
 * (면제는 그 자체로 구멍이다 — 목록에 든 파일은 다시 아무도 안 본다).
 */
const SPLASH_EXEMPT: readonly string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** `import … from "…/LoginPage"` 형태만 잡는다 — 주석의 단순 언급은 렌더가 아니다. */
const IMPORTS_LOGIN_PAGE = /^\s*import\s[\s\S]*?from\s+["'][^"']*\/LoginPage["'];?\s*$/m;

/**
 * ⚠️ **호출**을 찾는다, 언급이 아니다. 처음엔 `src.includes("bypassSplash")` 로 썼는데
 * 그러면 `import { bypassSplash } from …` 한 줄이 조건을 충족해서, 정작 사고를 재현한
 * 변이(=`beforeEach` 의 호출만 지움)가 **살아남았다**. 계약이 초록으로 거짓말하던 자리다.
 */
const CALLS_BYPASS = /\bbypassSplash\s*\(/;

interface Scanned {
  rel: string;
  src: string;
}

function scanTestFiles(): Scanned[] {
  return walk(SRC)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
    .map((f) => ({ rel: relative(SRC, f).split("\\").join("/"), src: readFileSync(f, "utf8") }));
}

describe("#479 스플래시 우회 누락 가드", () => {
  const files = scanTestFiles();

  it("가드가 실제로 파일을 훑고 있다(스캔 0건이면 이 계약은 거짓 green 이다)", () => {
    // ⚠️ 경로가 어긋나면 walk 가 빈 배열을 주고 아래 단언들이 **전부 자동 통과**한다.
    // 메모리 `wrong-config-zero-tests`: 실행 건수를 먼저 본다.
    expect(files.length).toBeGreaterThan(10);
  });

  it("LoginPage 를 import 하는 테스트 파일이 최소 2개 잡힌다(탐지 로직 생존 확인)", () => {
    const hits = files.filter((f) => IMPORTS_LOGIN_PAGE.test(f.src)).map((f) => f.rel);
    // 사고 당시의 두 파일. 탐지가 깨지면(정규식 오작동) 여기서 먼저 걸린다.
    expect(hits).toContain("auth/LoginPage.test.ts");
    expect(hits).toContain("auth/local-auth.test.ts");
  });

  it("LoginPage 를 렌더하는 모든 테스트 파일이 bypassSplash 를 부른다", () => {
    const missing = files
      .filter((f) => IMPORTS_LOGIN_PAGE.test(f.src))
      .filter((f) => !SPLASH_EXEMPT.includes(f.rel))
      .filter((f) => !CALLS_BYPASS.test(f.src))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it("면제 목록은 실재하는 파일만 담는다(낡은 면제가 구멍이 되지 않게)", () => {
    const known = new Set(files.map((f) => f.rel));
    expect(SPLASH_EXEMPT.filter((rel) => !known.has(rel))).toEqual([]);
  });
});
