import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * QA 콘솔 E2E (#191 AC1~AC4) — **CLI ↔ 브라우저 ↔ CLI 왕복을 실제로** 돌린다.
 * 여기서 검증하는 것이 이 시스템의 존재 이유다: 세션이 탭을 등록하고, hero 가 그걸 보고 피드백하고,
 * 세션이 그 피드백을 받는다.
 *
 * 격리:
 *  · 레지스트리는 `HMB_QA_CONSOLE_HOME`=tmp — **hero 의 실제 탭을 절대 건드리지 않는다**.
 *  · API 는 이 스펙이 임의 포트로 직접 띄우고, 페이지의 `/qa-api` 요청을 route 로 그 포트에 넘긴다
 *    (vite 프록시 대상은 8301 고정이라 실제 콘솔과 충돌한다 → 프록시를 안 쓴다).
 *
 * 실행: cd apps/web && WEB_E2E_PORT=5288 npx playwright test e2e/qa-console.spec.ts
 * (메모리 web-e2e-live-specs-hit-demo — 전체 e2e 금지, 스펙 지정 + 대체 포트)
 */

const repoRoot = resolve(new URL("../../../", import.meta.url).pathname);
const CLI = join(repoRoot, "tools", "qa-tab.mjs");
const API_MAIN = join(repoRoot, "tools", "qa-console", "api-main.mjs");
// 데모 로그(build:viewer 생성물). 없으면 스펙이 스스로 skip 한다 — 남의 게이트를 빨갛게 만들지 않는다.
const DEMO_LOG = join(repoRoot, "packages", "engine", "dev-viewer", "match-log.json");

let home: string;
let api: ChildProcess;
let apiPort: number;

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, HMB_QA_CONSOLE_HOME: home },
  });
}

/** 페이지의 `/qa-api/**` 요청을 이 스펙이 띄운 API 로 넘긴다(vite 프록시 우회 → 실제 콘솔과 격리). */
async function routeApi(page: Page) {
  await page.route("**/qa-api/**", async (route) => {
    const url = new URL(route.request().url());
    const target = `http://127.0.0.1:${apiPort}${url.pathname}${url.search}`;
    const res = await route.fetch({ url: target });
    await route.fulfill({ response: res });
  });
}

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "qa-console-e2e-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  // after 는 실제 데모 로그(진짜 경기가 움직여야 관전 검증이 의미가 있다), before 는 짧은 사본.
  if (existsSync(DEMO_LOG)) {
    const demo = JSON.parse(readFileSync(DEMO_LOG, "utf8"));
    writeFileSync(join(home, "logs", "after.json"), JSON.stringify(demo));
    writeFileSync(
      join(home, "logs", "before.json"),
      JSON.stringify({
        ...demo,
        tickSnapshots: (demo.tickSnapshots ?? []).slice(0, 60),
        // events 도 잘라야 "정말 다른 로그를 읽었다"가 관측된다(뷰어 훅 events() 는 log.events 를 본다)
        events: (demo.events ?? []).filter((e: { tick: number }) => e.tick < 60),
      }),
    );
  }

  api = spawn(process.execPath, [API_MAIN], {
    env: { ...process.env, HMB_QA_CONSOLE_HOME: home, HMB_QA_API_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiPort = await new Promise<number>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("API 기동 타임아웃")), 15_000);
    api.stdout?.on("data", (d) => {
      const m = String(d).match(/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        res(Number(m[1]));
      }
    });
  });
});

test.afterAll(() => {
  api?.kill("SIGTERM"); // 내가 띄운 PID 만 — 패턴 kill 금지
  rmSync(home, { recursive: true, force: true });
});

test.afterEach(async ({ page }) => {
  // 콘솔은 2초 폴링을 돈다 → 종료 순간 route 콜백이 in-flight 로 남는다(제품 동작, 테스트 잡음).
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.beforeEach(() => {
  // 탭만 비운다(레지스트리 루트는 유지 — 로그 파일을 다시 만들지 않게).
  for (const d of ["tabs", "feedback", "acks"]) {
    rmSync(join(home, d), { recursive: true, force: true });
    mkdirSync(join(home, d), { recursive: true });
  }
});

function register(id: string, title: string, extra: string[] = []) {
  return cli([
    "register", "--id", id, "--issue", id.split("-")[0] as string,
    "--title", title,
    "--summary", `${title} 요약 — 무엇을 고쳤는지`,
    "--ask", `${title} 를 눈으로 확인해줘`,
    "--log", `${join(home, "logs", "after.json")}@after:after (fix)`,
    "--log", `${join(home, "logs", "before.json")}@before:before (buggy)`,
    "--point", "12:34 첫 장면 — 여기를 봐라",
    "--point", "0:30@before 같은 장면 before",
    ...extra,
  ]);
}

test.describe("QA 콘솔", () => {
  test.skip(!existsSync(DEMO_LOG), "match-log.json 이 없다 → npx vitest run packages/engine/dev-viewer/generate-demo.test.ts");

  test("AC1 — 세션이 CLI 로 등록하면 콘솔에 즉시 나타나고 브리핑이 보인다", async ({ page }) => {
    expect(register("182-corner-stay", "코너 전원 전진 → 잔류 1~3명").status).toBe(0);
    cli(["status", "--id", "182-corner-stay", "--set", "waiting"]);

    await routeApi(page);
    await page.goto("/qa/console");

    await expect(page.getByTestId("qa-tab-182-corner-stay")).toBeVisible();
    await expect(page.getByTestId("qa-count-total")).toHaveText("1");
    // 브리핑 = "뭘 봐야 하는지" — 이게 없으면 하니스와 다를 게 없다(#191 문제 1)
    const brief = page.getByTestId("qa-brief");
    await expect(brief).toContainText("코너 전원 전진");
    await expect(brief).toContainText("무엇을 고쳤는지");
    await expect(brief).toContainText("눈으로 확인해줘");
    await expect(page.getByTestId("qa-point-0")).toContainText("12'34\"");
  });

  test("AC1 — 등록 없이 열면 무엇을 하라고 알려준다(빈 흰 화면 금지)", async ({ page }) => {
    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-console-blank")).toContainText("qa-tab.mjs register");
  });

  test("AC1 — 세션이 update 하면 폴링으로 화면이 따라온다", async ({ page }) => {
    register("176-deadball", "데드볼 접근 금지");
    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-brief")).toContainText("데드볼 접근 금지");

    cli(["update", "--id", "176-deadball", "--ask", "물러나는 게 자연스러운지 봐줘"]);
    await expect(page.getByTestId("qa-brief")).toContainText("물러나는 게 자연스러운지", { timeout: 10_000 });
  });

  test("AC2 — 탭의 경기가 재생되고, 확인 포인트를 누르면 그 초로 간다", async ({ page }) => {
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");

    // 게임화면과 같은 부품(VisualPlayback)이 마운트된다
    const canvas = page.getByTestId("viewer-canvas-half1");
    await expect(canvas).toBeVisible();
    await page.waitForFunction(() => Boolean((window as { __viewer?: unknown }).__viewer), null, { timeout: 20_000 });

    // #180 초/프레임 컨트롤이 그대로 붙어 있다(재발명 금지)
    await expect(page.getByTestId("viewer-controls-half1")).toBeVisible();

    // 확인 포인트 = 12:34(=754틱). 로그가 그보다 짧으면 마지막 틱으로 클램프되므로 "0 이 아니다"로 본다.
    await page.getByTestId("qa-point-0").click();
    await expect
      .poll(async () => page.evaluate(() => Number((window as never as { __viewer: { cur(): { tick: number } } }).__viewer.cur().tick)), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
  });

  test("AC2 — '지금 장면' 표시가 재생위치를 따라간다(엉뚱한 장면 첨부 오해 방지)", async ({ page }) => {
    // 실화면 QA 에서 잡은 버그: 표시를 ref 로만 그려서 재생위치가 1'30" 인데 라벨은 0'03" 에 멈춰 있었다.
    // 전송 payload 는 최신값이었지만 **hero 는 라벨을 보고 판단**하므로 이건 인지 갭 버그다.
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");
    await page.waitForFunction(() => Boolean((window as { __viewer?: unknown }).__viewer), null, { timeout: 20_000 });

    await page.getByTestId("qa-point-0").click(); // 12:34
    await expect
      .poll(async () => page.getByTestId("qa-attach-clock").textContent(), { timeout: 10_000 })
      .not.toBe("0'00\"");
    const shown = await page.getByTestId("qa-attach-clock").textContent();
    const tick = await page.evaluate(
      () => Number((window as never as { __viewer: { cur(): { tick: number } } }).__viewer.cur().tick),
    );
    const mmss = `${Math.floor(tick / 60)}'${String(tick % 60).padStart(2, "0")}"`;
    expect(shown).toBe(mmss);
  });

  test("AC2 — 뷰를 바꾸면 다른 로그로 갈아탄다(before/after 비교)", async ({ page }) => {
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");
    await page.waitForFunction(() => Boolean((window as { __viewer?: unknown }).__viewer), null, { timeout: 20_000 });

    const snapCount = () =>
      page.evaluate(() => (window as never as { __viewer: { events(): unknown[] } }).__viewer.events().length);
    const afterEvents = await snapCount();

    await page.getByTestId("qa-view-before").click();
    await expect(page.getByTestId("qa-view-before")).toHaveAttribute("aria-pressed", "true");
    // before 는 60 스냅샷으로 자른 사본 → 이벤트 수가 다르다(= 진짜 다른 로그를 읽었다)
    await expect.poll(async () => snapCount(), { timeout: 15_000 }).not.toBe(afterEvents);
  });

  test("AC3 — hero 가 적은 문장이 그대로 세션에 전달된다(왕복 전체)", async ({ page }) => {
    register("182-corner-stay", "코너 잔류");
    cli(["status", "--id", "182-corner-stay", "--set", "waiting"]);
    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-brief")).toBeVisible();

    const said = "잔류는 되는데 3명 다 GK 옆에 뭉쳐 있다";
    await page.getByTestId("qa-feedback-input").fill(said);
    await page.getByTestId("qa-send-reject").click();

    // ① 화면 이력에 남고 "세션 미수신" 으로 보인다
    await expect(page.getByTestId("qa-fb-1")).toContainText(said);
    await expect(page.getByTestId("qa-fb-ack-1")).toHaveText("세션 미수신");

    // ② 세션이 CLI 로 받는다 — body 가 손실 없이 그대로 온다(D9)
    const got = cli(["feedback", "--id", "182-corner-stay", "--unread", "--json"]);
    expect(got.status).toBe(0);
    const items = JSON.parse(got.stdout);
    expect(items).toHaveLength(1);
    expect(items[0].body).toBe(said);
    expect(items[0].verdict).toBe("reject");

    // ③ wait 이 즉시 종료된다(= 백그라운드로 걸어둔 세션이 깨어난다)
    const woke = cli(["wait", "--id", "182-corner-stay", "--timeout", "5"]);
    expect(woke.status).toBe(0);
    expect(JSON.parse(woke.stdout).items[0].body).toBe(said);

    // ④ ack 하면 화면 배지가 "세션 수신"으로 바뀐다
    cli(["ack", "--id", "182-corner-stay", "--seq", "1", "--state", "working", "--note", "재현 중"]);
    await expect(page.getByTestId("qa-fb-ack-1")).toContainText("세션 수신", { timeout: 10_000 });
    await expect(page.getByTestId("qa-fb-ack-1")).toContainText("재현 중");
  });

  test("AC3 — 사유 없는 거부는 막고 이유를 화면에 말한다", async ({ page }) => {
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-brief")).toBeVisible();

    await page.getByTestId("qa-send-reject").click();
    await expect(page.getByTestId("qa-error")).toContainText("사유");
    expect(JSON.parse(cli(["feedback", "--id", "182-corner-stay", "--json"]).stdout)).toEqual([]);
  });

  test("AC3 — 승인은 태그만 눌러도 전달된다(규약은 얇게)", async ({ page }) => {
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-brief")).toBeVisible();

    await page.getByTestId("qa-send-approve").click();
    await expect(page.getByTestId("qa-fb-1")).toContainText("승인");
    expect(JSON.parse(cli(["feedback", "--id", "182-corner-stay", "--json"]).stdout)[0].verdict).toBe("approve");
  });

  test("AC4 — 여러 세션 탭이 동시에 있어도 피드백이 섞이지 않는다", async ({ page }) => {
    register("176-deadball", "데드볼 접근 금지");
    register("181-ball-curve", "공이 스스로 휘는 현상");
    register("182-corner-stay", "코너 잔류");
    for (const id of ["176-deadball", "181-ball-curve", "182-corner-stay"]) {
      cli(["status", "--id", id, "--set", "waiting"]);
    }

    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-count-total")).toHaveText("3");

    // 탭 A 에 남기고
    await page.getByTestId("qa-tab-176-deadball").click();
    await expect(page.getByTestId("qa-brief")).toContainText("데드볼");
    await page.getByTestId("qa-feedback-input").fill("176 것");
    await page.getByTestId("qa-send-comment").click();
    await expect(page.getByTestId("qa-fb-1")).toContainText("176 것");

    // 탭 B 로 옮겨 남긴다
    await page.getByTestId("qa-tab-182-corner-stay").click();
    await expect(page.getByTestId("qa-brief")).toContainText("코너 잔류");
    await page.getByTestId("qa-feedback-input").fill("182 것");
    await page.getByTestId("qa-send-comment").click();
    await expect(page.getByTestId("qa-fb-1")).toContainText("182 것");

    // 각 세션은 자기 것만 받는다
    expect(JSON.parse(cli(["feedback", "--id", "176-deadball", "--json"]).stdout).map((f: { body: string }) => f.body)).toEqual(["176 것"]);
    expect(JSON.parse(cli(["feedback", "--id", "182-corner-stay", "--json"]).stdout).map((f: { body: string }) => f.body)).toEqual(["182 것"]);
    expect(JSON.parse(cli(["feedback", "--id", "181-ball-curve", "--json"]).stdout)).toEqual([]);
  });

  test("AC4 — ?tab= 딥링크로 세션이 hero 를 정확한 탭에 보낸다", async ({ page }) => {
    register("176-deadball", "데드볼 접근 금지");
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console?tab=182-corner-stay");
    await expect(page.getByTestId("qa-brief")).toContainText("코너 잔류");
  });

  test("AC4 — 폴링으로 목록이 갱신돼도 보던 탭이 유지된다", async ({ page }) => {
    register("176-deadball", "데드볼 접근 금지");
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");
    await page.getByTestId("qa-tab-176-deadball").click();
    await expect(page.getByTestId("qa-brief")).toContainText("데드볼");

    // 다른 세션이 새 탭을 등록해도 hero 가 보던 탭이 바뀌면 안 된다(판정을 잃는다)
    register("188-fixture", "픽스처 신선도 가드");
    await expect(page.getByTestId("qa-count-total")).toHaveText("3", { timeout: 10_000 });
    await expect(page.getByTestId("qa-brief")).toContainText("데드볼");
  });

  test("AC5 — 콘솔 서버가 죽으면 화면이 그렇게 말한다(원인 모를 빈 화면 금지)", async ({ page }) => {
    register("182-corner-stay", "코너 잔류");
    await routeApi(page);
    await page.goto("/qa/console");
    await expect(page.getByTestId("qa-brief")).toBeVisible();

    // API 응답을 끊는다 = 서버가 죽은 상태
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/qa-api/**", (route) => route.abort());
    await expect(page.getByTestId("qa-live")).toHaveAttribute("data-live", "0", { timeout: 10_000 });
    await expect(page.getByTestId("qa-live")).toContainText("qa-console.mjs status");
  });
});
