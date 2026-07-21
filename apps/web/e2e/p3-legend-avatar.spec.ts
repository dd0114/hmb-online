import { expect, test, type Page } from "@playwright/test";

/**
 * LEGEND 도트 아바타 골격 E2E — PRD-v4 §F (AC-F1), P3-D7.
 *
 * 도트 이미지 **미입고** 상태를 검증한다: 현재 레지스트리가 비어 있어 전 선수 placeholder,
 * 깨진 이미지 0. + 런타임 seam(window.__HMB_LEGEND_DOTS__)에 stub(data: URI)을 주입하면
 * LEGEND 만 legend-dot 이 되는 매핑을 증명(실파일 없이). 백엔드/데모 8080 무접촉 — route-mock 전용.
 *
 * ⚠️ 라우트 매칭은 glob('**\/api/**')이 아니라 **pathname 술어**로 한다 —
 *    glob 은 vite 소스(/src/api/*.ts)까지 잡아 모듈 로딩을 깨고 흰 화면이 된다(선례 있음).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

/** 등급 혼합 카탈로그 — LEGEND 2명(P_LEG1/P_LEG2) + 비-LEGEND 3명. 전원 보유(흑백 아님). */
const PLAYERS = [
  { id: "P_LEG1", name: "레전드일", position: "FW", grade: "LEGEND", owned: true, ownedCount: 1, attributes: attrs(90) },
  { id: "P_LEG2", name: "레전드이", position: "MF", grade: "LEGEND", owned: true, ownedCount: 1, attributes: attrs(88) },
  { id: "P_GOLD", name: "골드선수", position: "DF", grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs(75) },
  { id: "P_SILV", name: "실버선수", position: "GK", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs(65) },
  { id: "P_BRON", name: "브론즈선수", position: "DF", grade: "BRONZE", owned: false, ownedCount: 0, attributes: attrs(55) },
];

/** 유효한 1x1 투명 PNG(실제로 로드되는 data URI — 브라우저 onError 안 탐). */
const VALID_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function seedAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

async function mockApi(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ user: { id: "u1", nickname: "감독" }, wallet: { points: 3000 }, records: { wins: 0, draws: 0, losses: 0 } })),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
}

/** 아바타별 [id, kind] 수집. */
async function avatarKinds(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    document.querySelectorAll<HTMLElement>('[data-testid^="player-avatar-"]').forEach((el) => {
      const id = el.getAttribute("data-testid")!.replace("player-avatar-", "");
      out[id] = el.getAttribute("data-avatar-kind") ?? "";
    });
    return out;
  });
}

/** 깨진 img 개수 — 완료됐는데 naturalWidth 0 인 것(broken). */
async function brokenImageCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    [...document.querySelectorAll("img")].filter((img) => img.complete && img.naturalWidth === 0).length,
  );
}

test.describe("AC-F1 — 이미지 미입고: 전 선수 placeholder, 깨짐 0", () => {
  test("도감 카드 아바타가 전부 placeholder 이고 깨진 이미지가 없다", async ({ page }) => {
    await seedAuth(page);
    await mockApi(page);
    await page.goto("/codex");

    await expect(page.getByTestId("codex-grid")).toBeVisible();
    await expect(page.getByTestId("player-avatar-P_LEG1")).toBeVisible();

    const kinds = await avatarKinds(page);
    expect(kinds).toEqual({
      P_LEG1: "placeholder",
      P_LEG2: "placeholder",
      P_GOLD: "placeholder",
      P_SILV: "placeholder",
      P_BRON: "placeholder",
    });
    // placeholder 경로엔 <img> 자체가 없다 → 깨진 이미지도 0.
    const imgCount = await page.locator('[data-testid^="player-avatar-"] img').count();
    expect(imgCount).toBe(0);
    expect(await brokenImageCount(page)).toBe(0);
  });

  test("390px / 1280px 육안 캡처 (placeholder 렌더)", async ({ page }) => {
    await seedAuth(page);
    await mockApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/codex");
    await expect(page.getByTestId("player-avatar-P_LEG1")).toBeVisible();
    await page.screenshot({ path: "/private/tmp/claude-1609956905/-Users-peter-park-spider9-hmb-online/bc115538-b687-4b8c-93bd-5ec2daa258fe/scratchpad/codex-390.png", fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("player-avatar-P_LEG1")).toBeVisible();
    await page.screenshot({ path: "/private/tmp/claude-1609956905/-Users-peter-park-spider9-hmb-online/bc115538-b687-4b8c-93bd-5ec2daa258fe/scratchpad/codex-1280.png", fullPage: true });
  });
});

test.describe("AC-F1 — 에셋 주입 시 LEGEND 만 legend-dot (매핑 동작 증명)", () => {
  test("stub 도트를 주입하면 해당 LEGEND 만 dot, 나머지는 placeholder, 깨짐 0", async ({ page }) => {
    await seedAuth(page);
    // 런타임 seam 에 P_LEG1 도트만 주입 — 앱 스크립트보다 먼저 실행된다.
    await page.addInitScript(
      (dot) => {
        (window as unknown as { __HMB_LEGEND_DOTS__: Record<string, string> }).__HMB_LEGEND_DOTS__ = { P_LEG1: dot };
      },
      VALID_DOT,
    );
    await mockApi(page);
    await page.goto("/codex");

    await expect(page.getByTestId("player-avatar-P_LEG1")).toHaveAttribute("data-avatar-kind", "legend-dot");
    // 주입 안 된 다른 LEGEND 는 여전히 placeholder(매핑이 charId 단위임을 증명).
    await expect(page.getByTestId("player-avatar-P_LEG2")).toHaveAttribute("data-avatar-kind", "placeholder");
    // 비-LEGEND 는 에셋 개념 자체가 없다.
    await expect(page.getByTestId("player-avatar-P_GOLD")).toHaveAttribute("data-avatar-kind", "placeholder");

    // dot img 가 실제로 로드됨(깨짐 아님).
    const dotImg = page.locator('[data-testid="player-avatar-P_LEG1"] img');
    await expect(dotImg).toHaveCount(1);
    await expect(dotImg).toHaveAttribute("src", VALID_DOT);
    await expect
      .poll(() => dotImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);
    expect(await brokenImageCount(page)).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/private/tmp/claude-1609956905/-Users-peter-park-spider9-hmb-online/bc115538-b687-4b8c-93bd-5ec2daa258fe/scratchpad/codex-dot-390.png", fullPage: true });
  });
});
