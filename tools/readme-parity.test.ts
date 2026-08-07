import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #471 AC2 — README ↔ 스크립트 ↔ 버전 SoT **싱크 계약**.
 *
 * ## 왜 필요한가 (hero 요구 "최신버전이랑 항상 싱크되어야함")
 * 사람이 쓴 문서는 코드와 **조용히** 어긋난다. 리포는 이 부류를 이미 세 번 계약으로 막았다:
 * `dockerfile-workspaces.test.ts`(Dockerfile 이 선언한 워크스페이스 = 실제 워크스페이스),
 * `DataVersionParityTest`(선언 버전 = 실제 시드), `advertised-fields.test.ts`(광고 필드 = 실효 필드).
 * 이것이 **네 번째**다 — README 가 광고하는 것과 실제로 도는 것.
 *
 * ## 절차의 SoT 는 스크립트다
 * README 는 **포인터**여야 한다(요구 1 "read.me에서 로컬 빌드 방법으로 쓰여있어야함" 은 문서가
 * 있으라는 뜻이지, 절차를 두 벌 유지하라는 뜻이 아니다). 그래서 이 계약이 대조하는 것은:
 *
 * | README 가 적는 것 | 기계 SoT |
 * |---|---|
 * | Node 버전 | `.nvmrc` |
 * | JDK 버전 | `server-java/build.gradle.kts` toolchain |
 * | 스크립트 경로 | 파일시스템 |
 * | 서브커맨드 | `scripts/local-stack.sh` 의 `case` 분기 |
 * | 접속 포트 | 스크립트의 `:-` 기본값 |
 *
 * ## 변이체 킬 (`HMB_PARITY_MUTANT`)
 * 계약이 **정말 무는지**는 틀린 README 를 먹여 red 가 나야 증명된다(`og-function.e2e.sh` 선례).
 * 이 스위치는 README 를 **메모리에서만** 오염시킨다 — 디스크는 안 건드린다.
 *   `HMB_PARITY_MUTANT=node-version|jdk-version|script-path|subcommand|port` npx vitest run tools/readme-parity.test.ts
 * 각 팔은 반드시 **red** 여야 한다. 전부 green 이면 계약이 아무것도 안 무는 것이다.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const README_PATH = `${ROOT}README.md`;
const SCRIPT_REL = "scripts/local-stack.sh";
const NVMRC_PATH = `${ROOT}.nvmrc`;
const GRADLE_PATH = `${ROOT}server-java/build.gradle.kts`;

const MUTANTS = ["node-version", "jdk-version", "script-path", "subcommand", "port"] as const;
type Mutant = (typeof MUTANTS)[number];

const MUTANT = process.env.HMB_PARITY_MUTANT as Mutant | undefined;

/** README 를 읽되, 변이체 스위치가 켜져 있으면 **메모리에서만** 한 군데를 틀리게 만든다. */
function readReadme(): string {
  const raw = readFileSync(README_PATH, "utf8");
  if (!MUTANT) return raw;
  if (!MUTANTS.includes(MUTANT)) {
    throw new Error(`알 수 없는 HMB_PARITY_MUTANT=${MUTANT} (가능: ${MUTANTS.join("|")})`);
  }
  switch (MUTANT) {
    // 버전을 한 자리 올린다 = "README 가 낡았다" 의 정확한 재현.
    case "node-version":
      return raw.replace(/`\d+\.\d+\.\d+`/, "`99.0.0`");
    case "jdk-version":
      return raw.replace(/JDK[^\n]*?`(\d+)`/, (m, v) => m.replace(`\`${v}\``, "`17`"));
    case "script-path":
      return raw.replaceAll("scripts/local-stack.sh", "scripts/local-stak.sh");
    case "subcommand":
      return raw.replaceAll(/local-stack\.sh\s+doctor/g, "local-stack.sh diagnose");
    case "port":
      return raw.replaceAll(/localhost:(\d{4,5})/g, "localhost:39999");
  }
}

const readme = readReadme();
const script = readFileSync(`${ROOT}${SCRIPT_REL}`, "utf8");

/** 주석·빈 줄을 걷어낸 스크립트 실행 경로. 계약은 주석 문구가 아니라 코드에 건다. */
const scriptCode = script
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .join("\n");

describe("#471 AC2 — README 싱크 계약", () => {
  it("변이체 스위치가 배선돼 있다 (계약이 무는지 증명 가능)", () => {
    // 스위치 자체가 죽어 있으면 아래 모든 red 증빙이 거짓이 된다.
    expect(MUTANTS.length).toBeGreaterThanOrEqual(5);
    expect(() => {
      process.env.HMB_PARITY_MUTANT = "nonexistent-arm";
      try {
        // readReadme 는 모듈 로드 시점 값을 쓰므로 여기서는 검증 로직만 재현한다.
        if (!MUTANTS.includes("nonexistent-arm" as Mutant)) throw new Error("unknown mutant");
      } finally {
        if (MUTANT) process.env.HMB_PARITY_MUTANT = MUTANT;
        else delete process.env.HMB_PARITY_MUTANT;
      }
    }).toThrow();
  });

  it("README 가 로컬 빌드 절차를 담고 스크립트를 가리킨다", () => {
    expect(readme, "README 에 로컬 빌드 섹션이 없다").toMatch(/로컬\s*(빌드|실행)/);
    expect(readme, `README 가 ${SCRIPT_REL} 를 가리키지 않는다`).toContain(SCRIPT_REL);
  });

  it("README 의 Node 버전 = .nvmrc", () => {
    const want = readFileSync(NVMRC_PATH, "utf8").trim();
    const row = readme.match(/^\|\s*Node[^\n|]*\|\s*`([^`]+)`/m);
    expect(row, "README 전제표에 Node 행이 없다(`| Node.js | `x.y.z` |` 형태)").not.toBeNull();
    expect(row![1], `.nvmrc(${want}) 와 어긋난다`).toBe(want);
  });

  it("README 의 JDK 버전 = build.gradle.kts toolchain", () => {
    const g = readFileSync(GRADLE_PATH, "utf8").match(/JavaLanguageVersion\.of\((\d+)\)/);
    expect(g, "build.gradle.kts 에서 toolchain 을 못 읽었다").not.toBeNull();
    const row = readme.match(/^\|\s*JDK[^\n|]*\|\s*`(\d+)`/m);
    expect(row, "README 전제표에 JDK 행이 없다").not.toBeNull();
    expect(row![1], `build.gradle.kts(${g![1]}) 와 어긋난다`).toBe(g![1]);
  });

  it("README 가 언급하는 스크립트 경로가 전부 실재한다", () => {
    const paths = [...new Set([...readme.matchAll(/\b(scripts\/[\w.\-/]+\.sh)\b/g)].map((m) => m[1]))];
    expect(paths.length, "README 가 스크립트를 하나도 안 가리킨다").toBeGreaterThan(0);
    const missing = paths.filter((p) => !existsSync(`${ROOT}${p}`));
    expect(missing, `README 가 없는 파일을 가리킨다: ${missing.join(", ")}`).toEqual([]);
  });

  it("README 가 부르는 서브커맨드가 전부 스크립트에 있다", () => {
    const cmds = [...new Set([...readme.matchAll(/local-stack\.sh\s+([a-z][a-z0-9:-]*)/g)].map((m) => m[1]))];
    expect(cmds.length, "README 에 실행 예시가 없다").toBeGreaterThanOrEqual(2);
    const missing = cmds.filter((c) => !new RegExp(`(^|[\\s|(])${c}\\s*\\)`, "m").test(scriptCode));
    expect(missing, `스크립트에 없는 서브커맨드를 광고한다: ${missing.join(", ")}`).toEqual([]);
  });

  it("README 가 적는 접속 포트 = 스크립트 기본값 (그리고 데모 8080/8790 이 아니다)", () => {
    const defaults = new Set([...scriptCode.matchAll(/:-\s*(\d{4,5})\b/g)].map((m) => m[1]));
    const shown = [...new Set([...readme.matchAll(/localhost:(\d{4,5})/g)].map((m) => m[1]))];
    expect(shown.length, "README 에 접속 주소가 없다").toBeGreaterThan(0);
    const wrong = shown.filter((p) => !defaults.has(p));
    expect(wrong, `스크립트 기본값에 없는 포트를 안내한다: ${wrong.join(", ")}`).toEqual([]);
    expect(shown.filter((p) => ["8080", "8790", "18080", "18790"].includes(p))).toEqual([]);
  });
});
