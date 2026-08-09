/**
 * #479 — **우회 누락 가드**. `bypassSplash`/`skipSplash` 헬퍼 자체가 아니라 *그 헬퍼를 안 부르는
 * 파일이 생기는 것*을 막는 계약이다.
 *
 * ⚠️ 이 파일이 존재하는 이유(실사고 2건): 스플래시가 `LoginPage` 의 **첫 화면을 대체**하므로,
 * 로그인 폼을 만지는 기존 테스트는 그 한 겹을 넘지 못하면 전부 빨개진다.
 *  - 1R: `LoginPage.test.ts` 에만 우회를 넣고 `local-auth.test.ts`(17건)를 빠뜨렸다.
 *  - 2R: 그 수습으로 만든 이 가드가 `src/**` 만 훑는 바람에, **같은 부류의 실물**인
 *    `e2e/p477-capture.capture.ts`(#477 캡처 대조군)가 red 인 채로 green 으로 보였다.
 * 헬퍼로 빼는 것은 *중복*을 없애지만 **누락**은 못 없앤다 — 다음 파일은 그냥 안 부르면 된다.
 *
 * 그래서 두 층을 다 훑는다:
 *  1. `src/**` 유닛 — `LoginPage` 를 **import** 하거나 `App` 을 렌더하는 테스트 → `bypassSplash()`
 *  2. `e2e/**` — `/login` 이나 `provider-*` 를 만지는 스펙 → `skipSplash(`
 *
 * ⚠️ **이름 면제 목록을 쓰지 않는다**(목록에 든 파일은 다시 아무도 안 본다). 대신 규칙으로
 * 가른다 — 스플래시 **자신**을 검증하는 e2e 는 `splash-*` testid 를 참조하므로 그것으로 식별한다.
 * 지금 실제 분포에서 이 규칙은 위반 1건만 남기고 정확히 갈린다(아래 liveness 단언이 그걸 지킨다).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** `apps/web/src` · `apps/web/e2e` — 이 파일 기준. */
const SRC = join(__dirname, "..");
const E2E = join(__dirname, "..", "..", "e2e");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * ⚠️ **주석을 지우고 매칭한다.** 처음엔 원본 소스에 정규식을 걸었는데, 그러면
 * `// TODO: bypassSplash() 로 바꾸자` 같은 주석 한 줄이 호출로 세어져 가드가 통과한다
 * (2R minor-1 이 실제 변이로 재현). 문자열 매칭의 한계 안에서라도 그 구멍은 닫는다.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `import … from "…/LoginPage"` 형태. 주석의 단순 언급은 렌더가 아니다. */
const IMPORTS_LOGIN_PAGE = /^\s*import\s[\s\S]*?from\s+["'][^"']*\/LoginPage["'];?\s*$/m;
/** `App` 은 라우터를 통해 `LoginPage` 를 **간접** 마운트한다 — 이 경로도 스플래시에 막힌다. */
const IMPORTS_APP = /^\s*import\s[\s\S]*?from\s+["'][^"']*\/App["'];?\s*$/m;

/**
 * ⚠️ **호출**을 찾는다, 언급이 아니다. 처음엔 `src.includes("bypassSplash")` 로 썼는데
 * 그러면 `import { bypassSplash } from …` 한 줄이 조건을 충족해서, 정작 사고를 재현한
 * 변이(=`beforeEach` 의 호출만 지움)가 **살아남았다**. 계약이 초록으로 거짓말하던 자리다.
 */
const CALLS_BYPASS = /\bbypassSplash\s*\(/;
const CALLS_SKIP_SPLASH = /\bskipSplash\s*\(/;

/** e2e 가 로그인 폼을 실제로 만지는가. */
const TOUCHES_LOGIN = /["']\/login["']|provider-choose|provider-/;
/** 스플래시 **자신**을 검증하는 파일 — 우회하면 검증 대상이 사라진다. */
const IS_SPLASH_OWN = /splash-stage|splash-start|splash-progress/;

interface Scanned {
  rel: string;
  src: string;
}

function scan(root: string, keep: (f: string) => boolean): Scanned[] {
  return walk(root)
    .filter(keep)
    .map((f) => ({
      rel: relative(root, f).split("\\").join("/"),
      src: stripComments(readFileSync(f, "utf8")),
    }));
}

const unitFiles = scan(SRC, (f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"));
const e2eFiles = scan(E2E, (f) => f.endsWith(".ts"));

describe("#479 스플래시 우회 누락 가드 — src 유닛", () => {
  it("가드가 실제로 파일을 훑고 있다(스캔 0건이면 이 계약은 거짓 green 이다)", () => {
    // ⚠️ 경로가 어긋나면 walk 가 빈 배열을 주고 아래 단언들이 **전부 자동 통과**한다.
    // 메모리 `wrong-config-zero-tests`: 실행 건수를 먼저 본다.
    expect(unitFiles.length).toBeGreaterThan(10);
  });

  it("LoginPage 를 직접 import 하는 파일이 2개 이상 잡힌다(탐지 로직 생존 확인)", () => {
    const hits = unitFiles.filter((f) => IMPORTS_LOGIN_PAGE.test(f.src)).map((f) => f.rel);
    // 사고 당시의 두 파일. 탐지가 깨지면(정규식 오작동) 여기서 먼저 걸린다.
    expect(hits).toContain("auth/LoginPage.test.ts");
    expect(hits).toContain("auth/local-auth.test.ts");
  });

  it("App 을 렌더하는 간접 경로도 탐지된다(2R major — '직접 import' 만 보면 표본이 좁다)", () => {
    const hits = unitFiles.filter((f) => IMPORTS_APP.test(f.src)).map((f) => f.rel);
    expect(hits).toContain("common/MaintenanceGate.test.ts");
  });

  it("LoginPage 를 직접·간접으로 마운트하는 모든 테스트 파일이 bypassSplash 를 부른다", () => {
    const missing = unitFiles
      .filter((f) => IMPORTS_LOGIN_PAGE.test(f.src) || IMPORTS_APP.test(f.src))
      .filter((f) => !CALLS_BYPASS.test(f.src))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });
});

describe("#479 스플래시 우회 누락 가드 — e2e", () => {
  it("가드가 실제로 e2e 를 훑고 있다", () => {
    expect(e2eFiles.length).toBeGreaterThan(10);
  });

  it("로그인 폼을 만지는 스펙이 10건 이상 잡힌다(탐지 로직 생존 확인)", () => {
    const hits = e2eFiles.filter((f) => TOUCHES_LOGIN.test(f.src)).map((f) => f.rel);
    // 2R blocker 의 실물. 이 파일이 표본에서 빠지면 같은 사고가 또 조용히 지나간다.
    expect(hits).toContain("p477-capture.capture.ts");
    expect(hits.length).toBeGreaterThanOrEqual(10);
  });

  it("스플래시 자신을 검증하는 파일은 규칙으로 갈린다(이름 면제 목록 없이)", () => {
    const own = e2eFiles.filter((f) => IS_SPLASH_OWN.test(f.src)).map((f) => f.rel);
    expect(own).toContain("p479-splash.spec.ts");
    expect(own).toContain("p479-splash.capture.ts");
  });

  it("로그인 폼을 만지는 모든 e2e 가 skipSplash 를 부른다(스플래시 자신 제외)", () => {
    const missing = e2eFiles
      .filter((f) => TOUCHES_LOGIN.test(f.src))
      .filter((f) => !IS_SPLASH_OWN.test(f.src))
      .filter((f) => !CALLS_SKIP_SPLASH.test(f.src))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });
});
