import { expect, test, type Page } from "@playwright/test";

/**
 * 공지 이미지 업로드 route-mock E2E (#309 W1). 설계 = `docs/plan-v5/ops-content.md`.
 *
 * <b>무엇을 지키나</b>: 공지에 그림 한 장을 넣으려고 **웹을 다시 배포**하던 것을 끊었다.
 * 그래서 이 스펙이 보는 것은 "버튼이 있다"가 아니라 **한 바퀴가 실제로 돈다**이다 —
 * 파일을 고르면 → 서버에 올라가고 → 본문에 마크업이 들어가고 → 미리보기에 그 이미지가 뜬다.
 *
 * 그리고 **삭제 버튼이 없다**를 박제한다(hero 확정: 내리기는 노출 스위치로만). "정리 기능"이라는
 * 이유로 삭제가 다시 생기면 오조작 한 번이 영구 소실이 된다 — 계약이 그 문을 막는다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어(glob 은 vite 소스까지 잡아 흰 화면).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** 실제로 디코드되는 1×1 PNG — `naturalWidth > 0` 으로 "픽셀이 도착했다"를 볼 수 있어야 한다. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Asset {
  id: string;
  url: string;
  originalName: string | null;
  contentType: string;
  byteSize: number;
  active: boolean;
  usedBy: number;
  createdAt: string;
}

interface MockState {
  assets: Asset[];
  uploads: { reason: string | null; contentType: string | null }[];
  activeCalls: { id: string; active: boolean; reason: string | null }[];
  /** 다음 업로드를 거절한다(서버 화이트리스트에 걸린 상황). */
  rejectNextUpload: boolean;
}

function asset(over: Partial<Asset> & { id: string }): Asset {
  return {
    url: `/api/notices/assets/${over.id}`,
    originalName: `${over.id}.png`,
    contentType: "image/png",
    byteSize: 81806,
    active: true,
    usedBy: 0,
    createdAt: "2026-07-30T01:00:00Z",
    ...over,
  };
}

async function mockApi(page: Page): Promise<MockState> {
  const st: MockState = {
    assets: [
      asset({ id: "AS1", originalName: "hero-kyeongnicius.webp", contentType: "image/webp", usedBy: 2 }),
      asset({ id: "AS2", originalName: "patch-note.png", active: false, usedBy: 0 }),
    ],
    uploads: [],
    activeCalls: [],
    rejectNextUpload: false,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u-admin", nickname: "관리자", isAdmin: true, tutorialDone: true },
        wallet: { points: 0, gems: 0 },
        records: { wins: 0, draws: 0, losses: 0 },
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/admin/users", (route) =>
    route.fulfill(json({ users: [] })),
  );
  await page.route((url) => url.pathname === "/api/admin/notices", (route) =>
    route.fulfill(json({ notices: [] })),
  );
  await page.route((url) => url.pathname === "/api/admin/notices/history", (route) =>
    route.fulfill(json([])),
  );

  // 업로드·목록. **오리진을 보지 않고 pathname 으로** 매칭한다 — 배포 빌드에서는 이 요청이
  // 백엔드 오리진으로 나가므로, 오리진에 앵커하면 그 경로를 검사할 수 없다.
  await page.route((url) => url.pathname === "/api/admin/notices/assets", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill(json({ assets: st.assets }));
    }
    const reason = new URL(route.request().url()).searchParams.get("reason");
    st.uploads.push({ reason, contentType: route.request().headers()["content-type"] ?? null });
    if (st.rejectNextUpload) {
      return route.fulfill(
        json({ code: "VALIDATION_ERROR", message: "지원하지 않는 이미지 형식입니다" }, 400),
      );
    }
    const created = asset({ id: `AS${st.assets.length + 10}`, originalName: "새이미지.png" });
    st.assets.unshift(created);
    return route.fulfill(json(created, 201));
  });

  await page.route(/\/api\/admin\/notices\/assets\/[^/]+\/active$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!;
    const body = JSON.parse(route.request().postData() ?? "{}");
    st.activeCalls.push({ id, active: body.active, reason: body.reason ?? null });
    const target = st.assets.find((a) => a.id === id);
    if (target) target.active = body.active;
    return route.fulfill(json(target ?? {}));
  });

  // 공개 서빙 — 실제 픽셀을 준다(썸네일·미리보기가 진짜로 그려지는지 보려고).
  await page.route((url) => url.pathname.startsWith("/api/notices/assets/"), (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 }),
  );

  return st;
}

async function openNotices(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_admin"));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-notices").click();
  await expect(page.getByTestId("admin-notices-panel")).toBeVisible();
}

/** `window.prompt`/`confirm` 은 운영 액션마다 사유를 받는다 — 자동 응답시킨다. */
async function autoAnswer(page: Page, answer: string | null) {
  await page.addInitScript((reply) => {
    window.prompt = () => reply as string | null;
    window.confirm = () => reply !== null;
  }, answer);
}

test.describe("#309 공지 이미지 업로드", () => {
  test("파일을 고르면 업로드되고 **본문에 마크업이 들어가며** 미리보기에 그림이 뜬다", async ({ page }) => {
    const st = await mockApi(page);
    await autoAnswer(page, "8월 업데이트 히어로 이미지");
    await openNotices(page);

    await page.getByTestId("admin-notice-asset-input").setInputFiles({
      name: "hero.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });

    // ① 서버로 갔다 — multipart 로.
    await expect.poll(() => st.uploads.length).toBe(1);
    expect(st.uploads[0]!.contentType, "boundary 를 브라우저가 붙였다").toContain("multipart/form-data");
    expect(st.uploads[0]!.reason, "사유가 원장에 남게 실려 나간다").toBe("8월 업데이트 히어로 이미지");

    // ② 본문에 **상대경로** 마크업이 들어갔다(절대 URL 이 아니다 — 터널 주소가 바뀌어도 안 깨진다).
    const body = page.getByTestId("admin-notice-body");
    await expect(body).toHaveValue(/!\[hero\]\(\/api\/notices\/assets\/AS\d+\)/);
    await expect(body).not.toHaveValue(/https?:\/\//);

    // ③ 미리보기에 **픽셀이 실제로 도착했다** — 경로 해석이 맞았다는 증거.
    const img = page.getByTestId("admin-notice-preview-body").locator("img").first();
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test("업로드가 거절되면 문구가 뜨고 **본문은 건드리지 않는다**", async ({ page }) => {
    const st = await mockApi(page);
    st.rejectNextUpload = true;
    await autoAnswer(page, "svg 시도");
    await openNotices(page);

    await page.getByTestId("admin-notice-body").fill("원래 본문");
    await page.getByTestId("admin-notice-asset-input").setInputFiles({
      name: "x.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    });

    await expect(page.getByTestId("admin-notice-error")).toContainText("지원하지 않는");
    // 실패한 업로드의 마크업이 본문에 남으면 운영자는 **영영 안 뜨는 그림**을 게시하게 된다.
    await expect(page.getByTestId("admin-notice-body")).toHaveValue("원래 본문");
  });

  test("자산 목록은 사용 중 건수·노출 상태를 보여주고 **삭제 버튼이 없다**", async ({ page }) => {
    await mockApi(page);
    await openNotices(page);

    await expect(page.getByTestId("admin-notice-assets")).toBeVisible();
    await expect(page.getByTestId("admin-notice-asset-used-AS1")).toHaveText("2");
    await expect(page.getByTestId("admin-notice-asset-state-AS1")).toHaveAttribute("data-active", "1");
    await expect(page.getByTestId("admin-notice-asset-state-AS2")).toHaveAttribute("data-active", "0");

    // ⚠️ 이 단언이 이 스펙의 핵심 하나다 — 삭제 경로가 다시 생기면 여기서 깨진다.
    const panel = page.getByTestId("admin-notices-panel");
    await expect(panel.getByTestId("admin-notice-asset-delete-AS1")).toHaveCount(0);
    await expect(page.getByTestId("admin-notice-asset-row-AS1")).not.toContainText("삭제");
  });

  test("노출 끄기는 사유를 받아 서버로 가고, 다시 켤 수 있다(되돌릴 수 있다)", async ({ page }) => {
    const st = await mockApi(page);
    await autoAnswer(page, "잘못 올림");
    await openNotices(page);

    await page.getByTestId("admin-notice-asset-toggle-AS1").click();
    await expect.poll(() => st.activeCalls.length).toBe(1);
    expect(st.activeCalls[0]).toEqual({ id: "AS1", active: false, reason: "잘못 올림" });

    // 꺼진 자산은 다시 켤 수 있다 — 그게 삭제 대신 스위치를 쓰는 이유다.
    await expect(page.getByTestId("admin-notice-asset-toggle-AS2")).toHaveText("다시 켜기");
    await page.getByTestId("admin-notice-asset-toggle-AS2").click();
    await expect.poll(() => st.activeCalls.length).toBe(2);
    expect(st.activeCalls[1]).toEqual({ id: "AS2", active: true, reason: "잘못 올림" });
  });

  test("사유를 취소하면 아무 일도 일어나지 않는다", async ({ page }) => {
    const st = await mockApi(page);
    await autoAnswer(page, null);
    await openNotices(page);

    await page.getByTestId("admin-notice-asset-toggle-AS1").click();
    await page.getByTestId("admin-notice-asset-input").setInputFiles({
      name: "hero.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });

    await expect(page.getByTestId("admin-notice-asset-state-AS1")).toHaveAttribute("data-active", "1");
    expect(st.activeCalls).toHaveLength(0);
    expect(st.uploads).toHaveLength(0);
  });

  test("목록 이미지가 실제로 그려진다(서빙 경로가 맞다)", async ({ page }) => {
    await mockApi(page);
    await openNotices(page);

    const thumb = page.getByTestId("admin-notice-asset-thumb-AS1");
    await expect(thumb).toBeVisible();
    expect(await thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });
});
