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

  // ── #471 패널 S2R 반려분 ───────────────────────────────────────────────
  // 이건 정적으로 못 건다 — `exit $?` 가 "무엇의" $? 인지는 실행해야 갈린다.
  // (구 코드 `doctor; QUIET_EXIT=1; exit $?` 는 대입문의 0 을 읽어 항상 성공으로 끝났다.)
  it("doctor 는 전제 미충족을 exit code 로 전달한다", async () => {
    const { createServer } = await import("node:net");
    const { execFile } = await import("node:child_process");
    // 포트는 **커널이 고르게 한다**(0 = ephemeral) — 데모 8080/8790·배포 18080/18790 은 물론
    // 어떤 고정 포트도 잡지 않아야 다른 세션과 충돌하지 않는다.
    const srv = createServer();
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as { port: number }).port;
    try {
      const run = (env: NodeJS.ProcessEnv) =>
        new Promise<number>((res) => {
          execFile("bash", [SCRIPT_PATH, "doctor"], { env: { ...process.env, ...env } }, (err) =>
            res(err && typeof err.code === "number" ? err.code : 0),
          );
        });
      // 그 포트를 스택이 쓸 포트로 지정 → doctor 의 선점 검출이 bad=1 을 세워야 한다.
      const busy = await run({ HMB_LOCAL_E2E_WEB_PORT: String(port) });
      expect(
        busy,
        "포트가 물려 있는데 doctor 가 0 으로 끝났다 — `doctor && up` 이나 CI 래퍼가 " +
          "전제 미충족을 통과로 읽는다(#471 패널 S2R).",
      ).not.toBe(0);
    } finally {
      srv.close(); // PID-only cleanup 원칙과 동일 취지 — 우리가 연 것만 우리가 닫는다.
    }
  }, 30_000);

  // ── #471 패널 3R 반려분 (S2 ②) ─────────────────────────────────────────
  // 헬스체크 200 은 "우리 프로세스가 떴다"를 뜻하지 않는다. 실측(2026-08-10):
  // 러너가 이미 물려 있는 포트에 `listen` 하면 `EADDRINUSE` 로 **즉시 죽는데**(exit 1),
  // 그동안 curl 은 고아에게서 `{"ok":true}` 200 을 받는다 → 구 코드는 "러너 준비"로 통과하고
  // 낡은 프로세스를 문 채 끝까지 가서 exit 0 으로 성공을 보고했다.

  it("wait_http 호출부가 전부 우리가 띄운 PID 를 넘긴다", () => {
    const code = codeLines(readScript());
    const calls = code.filter((l) => /(^|[\s;(])wait_http\s+/.test(l));
    expect(calls.length, "wait_http 호출을 못 찾았다 — 계약이 낡았다").toBeGreaterThanOrEqual(3);
    // url, 초 다음 세 번째 인자가 `$..._PID` 여야 한다. 헤더만 넘기던 구 형태(start_java)가
    // 정확히 이 자리에 토큰 헤더를 두고 있었다.
    const noPid = calls.filter((l) => !/wait_http\s+\S+\s+\S+\s+"\$[A-Z_]*PID"/.test(l));
    expect(
      noPid,
      `PID 없이 헬스체크만 하는 호출부:\n${noPid.join("\n")}\n` +
        `— 고아 프로세스의 200 을 "준비 완료"로 오판한다(#471 패널 3R S2 ②).`,
    ).toEqual([]);
  });

  it("포트 검사는 스폰 **직전**에 한다 — 그 사이에 긴 빌드를 끼우지 않는다", () => {
    // 왜: `require_port_free` 를 빌드 **앞**에만 두면 검사~바인드 창이 마이크로초가 아니라
    // `gradlew bootJar` 통째(콜드 수 분)가 된다. 그 창의 유일한 방어인 `port_owner_ok` 는
    // lsof 가 있어야만 도는데, lsof 없는 환경이야말로 이 방어가 존재하는 이유다
    // = 가장 중요한 포트가 가장 넓은 창에서 무방비였다(#471 패널 5R S2).
    const code = codeLines(readScript());
    const start = code.findIndex((l) => /^start_java\(\)/.test(l));
    expect(start, "start_java 를 못 찾았다 — 계약이 낡았다").toBeGreaterThanOrEqual(0);
    const body = code.slice(start, start + 60);
    const spawn = body.findIndex((l) => /cd "\$ROOT\/server-java" && java/.test(l));
    const build = body.findIndex((l) => /gradlew bootJar/.test(l));
    expect(build, "bootJar 호출을 못 찾았다").toBeGreaterThanOrEqual(0);
    expect(spawn, "java 기동을 못 찾았다").toBeGreaterThan(build);
    const guards = body
      .map((l, i) => (/require_port_free\s+"\$JAVA_PORT"/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    const afterBuild = guards.filter((i) => i > build && i < spawn);
    expect(
      afterBuild.length,
      `require_port_free "$JAVA_PORT" 가 빌드(라인 +${build})와 기동(라인 +${spawn}) **사이**에 없다.\n` +
        `발견한 위치: ${guards.map((i) => `+${i}`).join(", ") || "없음"}\n` +
        `— 빌드 앞에서만 재면 검사~바인드 창이 빌드 시간 전체가 된다(#471 패널 5R S2).`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("포트를 문 고아가 200 을 줘도 '준비 완료'로 오판하지 않는다", async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    // 스크립트가 띄우는 러너와 **같은 방식**으로 바인드한다(host 미지정 = :: dual-stack).
    // 127.0.0.1 로만 잡으면 러너가 그 위에 또 떠 버려(macOS 실측) 재현하려는 상태가 아니다.
    const orphan = createServer((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end('{"ok":true,"who":"orphan"}');
    });
    await new Promise<void>((res) => orphan.listen(0, res));
    const port = (orphan.address() as { port: number }).port;
    try {
      const out = await new Promise<{ code: number; text: string }>((res) => {
        execFile(
          "bash",
          [SCRIPT_PATH, "smoke"],
          {
            env: {
              ...process.env,
              HMB_LOCAL_RUNNER_PORT: String(port),
              // 선점 게이트(require_free_ports)를 일부러 열어 **wait_http 경로**를 태운다.
              // 안 열면 앞단에서 죽어서 이 계약이 검정하려는 코드에 도달조차 못 한다(동어반복).
              HMB_LOCAL_ALLOW_BUSY_PORTS: "1",
              HMB_LOCAL_AI: "stub",
            },
            timeout: 90_000,
            maxBuffer: 8 << 20,
          },
          (err, stdout, stderr) =>
            res({
              code: err && typeof err.code === "number" ? err.code : 0,
              text: `${stdout}${stderr}`,
            }),
        );
      });
      expect(out.code, `선점 상태인데 스택이 성공으로 끝났다:\n${out.text}`).not.toBe(0);
      expect(out.text, "고아의 200 을 우리 러너로 오인했다").not.toContain("✓ 러너 준비");
      // 방어가 두 겹이라 **어느 쪽이 먼저 물어도 통과**다: 띄우기 전 포트 점유 검사(1차,
      // 의존성 0)와 기동 후 소유·생존 판정(2차). 어느 문구든 "남의 200 을 우리 것으로 읽지
      // 않았다"를 뜻한다 — 특정 문구 하나에 걸면 방어를 강화할 때마다 계약이 거짓 red 가 된다.
      expect(out.text).toMatch(/이미 누가 듣고 있다|러너 프로세스가 죽었다/);
    } finally {
      orphan.close();
    }
  }, 120_000);

  // ── #471 패널 4R 반려분 (S2) ───────────────────────────────────────────
  // 위 방어를 `lsof` 로만 세우면 **lsof 없는 환경에서 통째로 조용히 사라진다** — `port_owner_ok`
  // 는 `command -v lsof || return 0` 으로 통과하고, 구 `ports_busy` 는 lsof 로 재서 "아무도 안 문다"
  // 를 돌려줬다. 그래서 1차 방어를 **bash 내장 `/dev/tcp`** 로 내렸다(외부 명령 의존 0).
  // 이 계약은 그 사실을 **lsof 를 실제로 숨기고** 검정한다.

  it("lsof 가 없어도 고아 선점을 잡는다 (검출이 도구 설치에 걸리지 않는다)", async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, chmodSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // PATH 를 갈아끼워 lsof 만 사라진 환경을 만든다 — 나머지 도구는 심링크로 그대로 보인다.
    const shim = mkdtempSync(join(tmpdir(), "hmb-nolsof-"));
    const realPath = process.env.PATH ?? "";
    const seen = new Set<string>();
    for (const dir of realPath.split(":")) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name === "lsof" || seen.has(name)) continue;
        seen.add(name);
        // 심링크 대신 얇은 래퍼 — 원본 경로를 그대로 exec 한다(권한/플랫폼 차이에 덜 민감).
        try {
          writeFileSync(join(shim, name), `#!/bin/sh\nexec "${join(dir, name)}" "$@"\n`);
          chmodSync(join(shim, name), 0o755);
        } catch {
          /* 이름이 이상한 파일은 건너뛴다 — 이 테스트의 주제가 아니다 */
        }
      }
    }

    const orphan = createServer((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end('{"ok":true,"who":"orphan"}');
    });
    await new Promise<void>((res) => orphan.listen(0, res));
    const port = (orphan.address() as { port: number }).port;
    try {
      const out = await new Promise<{ code: number; text: string }>((res) => {
        execFile(
          "bash",
          [SCRIPT_PATH, "smoke"],
          {
            env: {
              ...process.env,
              PATH: shim,
              HMB_LOCAL_RUNNER_PORT: String(port),
              // 선점 게이트까지 열어 **띄우기 직전 방어**만 남긴 최악 조건에서 검정한다.
              HMB_LOCAL_ALLOW_BUSY_PORTS: "1",
              HMB_LOCAL_AI: "stub",
            },
            timeout: 90_000,
            maxBuffer: 8 << 20,
          },
          (err, stdout, stderr) =>
            res({
              code: err && typeof err.code === "number" ? err.code : 0,
              text: `${stdout}${stderr}`,
            }),
        );
      });
      // 이 환경에 정말 lsof 가 없었는지부터 확인한다 — 아니면 이 계약은 아무것도 검정하지 않는다.
      expect(out.text, "lsof 가 여전히 보인다 — PATH 차폐가 실패했다(계약이 동어반복)").toContain(
        "lsof 가 없다",
      );
      expect(out.code, `lsof 없는 환경에서 선점을 통과시켰다:\n${out.text}`).not.toBe(0);
      expect(out.text, "고아의 200 을 우리 러너로 오인했다").not.toContain("✓ 러너 준비");
    } finally {
      orphan.close();
    }
  }, 120_000);

  // 위 두 계약은 **1차 방어**(띄우기 전 점유 검사)가 먼저 물어서 통과한다. 그러면 2차 방어인
  // `wait_http` 의 소유 판정은 어떤 테스트도 안 태우는 코드가 된다 — 그 층이 막는 것은
  // "검사할 땐 비어 있었는데 우리가 바인드하기 전에 남이 잡은" 경주라 스택 전체로는 재현하기
  // 어렵다. 그래서 함수를 **직접** 부른다(`HMB_LOCAL_LIB_ONLY=1` 로 source = 함수만 로드).
  it("wait_http 는 리스너가 우리 잡이 아니면 200 을 받아도 준비완료로 안 읽는다", async () => {
    const { execFile } = await import("node:child_process");
    // 프로브가 왜 별도 파일인지는 그 파일 머리말 참조(스택 전체로는 이 층을 태울 수 없다).
    const out = await new Promise<string>((res) => {
      execFile(
        "bash",
        [`${ROOT}tools/local-stack-wait-http-probe.sh`],
        { timeout: 60_000 },
        (_e, stdout, stderr) => res(`${stdout}${stderr}`),
      );
    });
    // 3 = "남이 그 포트를 물고 있다". 소유 확인을 지우면 여기가 0 이 된다(변이체 킬 지점).
    expect(out, `남의 리스너를 우리 것으로 읽었다:\n${out}`).toContain("foreign_arm=3");
    // 반대 팔 — 자기 자신도 못 알아보면 스택이 영영 안 뜬다(늘 3 을 뱉는 계약이 아님).
    expect(out, `우리 리스너를 못 알아봤다:\n${out}`).toContain("own_arm=0");
  }, 90_000);

  it("bash strict 모드로 돈다", () => {
    const src = readScript();
    expect(src.split("\n")[0]).toMatch(/^#!.*bash/);
    expect(codeLines(src).join("\n")).toMatch(/set\s+-[a-z]*u/);
  });
});
