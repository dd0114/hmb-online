import { readFileSync, existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #471 AC1 — 로컬 빌드 원커맨드 스택 `scripts/local-stack.sh` 의 **구조 계약**.
 *
 * ## 왜 정적 계약인가
 * 이 스크립트의 실효는 실제 기동으로만 증명된다(그건 AC1 증빙 로그·AC4 E2E 가 한다). 그런데
 * 실기동 게이트는 90초+ 라 매 커밋에 못 건다. 반면 이 파일이 지키는 것들은 **한 번 깨지면
 * 다른 세션의 스택을 죽이거나 과금을 새게 하는** 부류라, 싼 검사로 매 커밋에 걸어야 한다:
 *
 * 1. **데모(8080/8790)·배포(18080/18790) 무접촉** — 리포 절대규칙(`CLAUDE.md` §11, `infra/README.md`).
 *    포트 상수 하나 잘못 적으면 hero 가 플레이 중인 라이브 스택에 붙는다.
 * 2. **PID-only cleanup** — `pkill -f` 는 다른 세션의 java/node 를 같이 죽인다(메모리
 *    `no-pattern-kill-in-fleet`, `p4-clock-smoke.sh:29-33` 선례).
 * 3. **`ANTHROPIC_API_KEY` 주입 0** — 있으면 정액제 구독이 아니라 종량 과금으로 샌다
 *    (`packages/server/CLAUDE.md:12`, `infra/.env.example:41-44`). 실행기가 기동 시 unset 을
 *    강제하지만(`executor-main.ts:146-152`) 원칙은 **주입 자체를 안 하는 것**이다.
 * 4. **전 포트 env override** — 같은 머신에서 두 세션이 동시에 이 스크립트를 돌릴 수 있어야 한다.
 *
 * ⚠️ 이 계약은 "스크립트가 동작한다"를 말하지 않는다. 그건 AC1 콜드 실행 로그와 AC4 가 말한다.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT_PATH = `${ROOT}scripts/local-stack.sh`;

/** 리포가 이미 쓰는 포트 전수표(#471 첫 코멘트 실측). 새 스택은 이 중 어느 것도 기본값으로 쓰면 안 된다. */
const TAKEN_PORTS = [
  8080, 8790, // 데모(호스트 native) — 무접촉 절대규칙
  18080, 18790, // 배포 docker compose
  28080, 28790, 28081, // p4-clock-smoke · sub-297 curl 계약
  8085, 8795, 5175, // design 격리 스택
  8081, // measure-flow-e2e
  8300, 8301, // QA 콘솔
  5173, // vite 기본 / 기본 CORS 오리진
  5199, 5287, // web E2E / capture
  4321, // 정적 web serve
  18877, // pages Function e2e
];

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

/** 주석(`#` 로 시작하는 줄)과 빈 줄을 걷어낸 **실행 경로**만. 계약은 주석 문구가 아니라 코드에 건다. */
function codeLines(src: string): string[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("#471 AC1 — scripts/local-stack.sh 구조 계약", () => {
  it("존재하고 실행 가능하다", () => {
    expect(existsSync(SCRIPT_PATH), `${SCRIPT_PATH} 가 없다`).toBe(true);
    // 0o111 = 소유자/그룹/기타 실행 비트 중 하나라도. README 가 `bash scripts/…` 로 부르더라도
    // 실행 비트가 있어야 `./scripts/…` 도 되고, 이 파일이 "쉘 진입점"임이 파일시스템에 남는다.
    expect(statSync(SCRIPT_PATH).mode & 0o111, "실행 비트가 없다").toBeGreaterThan(0);
  });

  it("기본 포트가 리포가 이미 쓰는 포트와 겹치지 않는다 (데모 8080/8790 무접촉)", () => {
    const code = codeLines(readScript()).join("\n");
    // `:-31080` 형태의 기본값만 본다 — env override 로 들어오는 값은 사용자 책임이다.
    const defaults = [...code.matchAll(/:-\s*(\d{4,5})\b/g)].map((m) => Number(m[1]));
    expect(defaults.length, "포트 기본값이 하나도 안 보인다(형태가 바뀌었나)").toBeGreaterThanOrEqual(3);
    const collided = defaults.filter((p) => TAKEN_PORTS.includes(p));
    expect(collided, `이미 쓰이는 포트를 기본값으로 잡았다: ${collided.join(", ")}`).toEqual([]);
  });

  it("실행 경로 어디에도 데모·배포 포트 리터럴이 없다", () => {
    const code = codeLines(readScript());
    const offenders = code.filter((l) => /\b(8080|8790|18080|18790)\b/.test(l));
    expect(offenders, `데모/배포 포트가 실행 경로에 있다:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("모든 포트가 env 로 덮어써진다", () => {
    const code = codeLines(readScript()).join("\n");
    for (const knob of ["HMB_LOCAL_JAVA_PORT", "HMB_LOCAL_RUNNER_PORT", "HMB_LOCAL_WEB_PORT"]) {
      expect(code, `${knob} 로 덮어쓸 수 없다`).toMatch(new RegExp(`\\$\\{${knob}:-`));
    }
  });

  it("정리는 PID 로만 한다 — 패턴 kill 금지", () => {
    const code = codeLines(readScript());
    const patternKill = code.filter((l) => /\b(pkill|killall)\b/.test(l));
    expect(patternKill, `패턴 kill 은 다른 세션 스택을 죽인다:\n${patternKill.join("\n")}`).toEqual([]);
    expect(code.join("\n"), "trap cleanup 이 없다 — 중단 시 프로세스가 남는다").toMatch(/trap\s+cleanup/);
  });

  it("ANTHROPIC_API_KEY 를 주입하지 않는다", () => {
    const code = codeLines(readScript());
    // 읽기(존재 확인·경고)는 허용, **설정**(대입·export)이 금지다.
    const injections = code.filter((l) => /(^|[\s;])(export\s+)?ANTHROPIC_API_KEY\s*=/.test(l));
    expect(injections, `종량 과금으로 새는 경로:\n${injections.join("\n")}`).toEqual([]);
  });

  it("README 가 부르는 서브커맨드를 전부 구현한다", () => {
    const code = codeLines(readScript()).join("\n");
    for (const cmd of ["up", "smoke", "doctor"]) {
      // case 분기에 그 이름이 있어야 한다.
      expect(code, `서브커맨드 ${cmd} 가 없다`).toMatch(new RegExp(`(^|[\\s|(])${cmd}\\s*\\)`, "m"));
    }
  });

  // ── #471 패널 S2 반려분 ────────────────────────────────────────────────
  // 둘 다 "고쳤는데 조용히 회귀하는" 부류다. 특히 첫 번째는 `apps/web/CLAUDE.md` 가
  // 이름 붙여 경고까지 해 둔 지뢰를 그대로 밟은 것이라, 기억이 아니라 계약으로 건다.

  it("web E2E 를 CI=1 로 돌린다 — 낡은 vite 재사용 금지", () => {
    const code = codeLines(readScript()).join("\n");
    // playwright 호출 구문(서브셸 열림 ~ `npx playwright test`) 안에 CI=1 이 있어야 한다.
    // 파일 아무 데나 CI=1 이 있으면 통과하는 식으로 걸면 계약이 헐거워진다.
    const call = code.match(/\(\s*cd\s+"\$ROOT\/apps\/web"[\s\S]*?npx playwright test/);
    expect(call, "playwright 호출 구문을 못 찾았다 — 계약이 낡았다").not.toBeNull();
    expect(
      call![0],
      "CI 가 비면 playwright.config.ts 의 reuseExistingServer 가 true 라 E2E_WEB_PORT 에 남은 " +
        "낡은 vite 를 주워 쓴다. 그 vite 의 /api 프록시는 기동 시점에 고정이라 이번 백엔드가 " +
        "아니다 → apiLive() 는 green 인데 브라우저만 다른 서버를 때린다(#471 패널 S2).",
    ).toMatch(/(^|\s)CI=1(\s|\\)/);
  });

  it("doctor 가 선점 검사하는 포트에 빠진 것이 없다", () => {
    const src = readScript();
    // 스크립트가 선언한 포트 변수 전수 ↔ doctor 선점 루프가 도는 목록. 새 포트를 추가하고
    // 루프에 안 넣으면 여기서 걸린다(E2E_WEB_PORT 가 정확히 그렇게 빠져 있었다).
    const declared = [...src.matchAll(/^([A-Z0-9_]*PORT)="\$\{HMB_LOCAL_/gm)].map((m) => m[1]);
    expect(declared.length, "포트 변수 선언을 못 찾았다 — 계약이 낡았다").toBeGreaterThanOrEqual(4);
    const loop = codeLines(src).join("\n").match(/for p in ([^;]*); do/);
    expect(loop, "doctor 의 포트 선점 루프를 못 찾았다").not.toBeNull();
    const missing = declared.filter((v) => !loop![1].includes(`$${v}`));
    expect(
      missing,
      `선점 검사에서 빠진 포트: ${missing.join(", ")} — 낡은 프로세스가 물고 있어도 ` +
        `사람에게 신호가 안 간다(#471 패널 S2).`,
    ).toEqual([]);
  });

  it("bash strict 모드로 돈다", () => {
    const src = readScript();
    expect(src.split("\n")[0]).toMatch(/^#!.*bash/);
    expect(codeLines(src).join("\n")).toMatch(/set\s+-[a-z]*u/);
  });
});
