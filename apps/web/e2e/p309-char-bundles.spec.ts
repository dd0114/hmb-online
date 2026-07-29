import { expect, test, type Page } from "@playwright/test";

/**
 * 유닛 아트 핫로드 운영 화면 (#309 W2). 설계 = `docs/plan-v5/ops-content.md` §7.
 *
 * <b>무엇을 지키나</b>: 유닛 *등록*은 이미 무배포였다(#207 파트 A). 남은 배포 의존은 **아트**였다 —
 * 새 유닛에 그림을 붙이려면 웹을 다시 배포해야 했다. 이 화면이 그걸 끊는다.
 *
 * 여기서 보는 것은 "버튼이 있다"가 아니라 **운영자가 답을 얻는가**이다:
 *  · 지금 무엇이 나가고 있는가(구운 폴백인가, 어느 리비전인가) — "올렸는데 왜 안 바뀌지"의 답
 *  · 올린 것이 **바로 켜지지 않는다**(확인 후 켜는 흐름)
 *  · 되돌릴 수 있다(다른 리비전 / 구운 기본 아트)
 *
 * ⚠️ 라우트 매칭은 pathname 술어(glob 은 vite 소스까지 잡아 흰 화면).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface Bundle {
  id: string;
  fileCount: number;
  byteSize: number;
  summary: Record<string, unknown>;
  note: string | null;
  active: boolean;
  createdAt: string;
}

interface MockState {
  bundles: Bundle[];
  activeRevision: string | null;
  uploads: { reason: string | null; note: string | null; contentType: string | null }[];
  activations: { revisionId: string | null; reason: string | null }[];
}

function bundle(over: Partial<Bundle> & { id: string }): Bundle {
  return {
    fileCount: 42,
    byteSize: 6_200_000,
    summary: { unitsCount: 9, unitsSource: "hero-rev4", mappingVersion: "v2", mappedPlayers: 172 },
    note: null,
    active: false,
    createdAt: "2026-07-30T01:00:00Z",
    ...over,
  };
}

async function mockApi(page: Page, initial?: Partial<MockState>): Promise<MockState> {
  const st: MockState = {
    bundles: [bundle({ id: "REV2", note: "9차 입고" }), bundle({ id: "REV1", note: "8차 입고" })],
    activeRevision: null,
    uploads: [],
    activations: [],
    ...initial,
  };
  st.bundles = st.bundles.map((b) => ({ ...b, active: b.id === st.activeRevision }));

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

  await page.route((url) => url.pathname === "/api/admin/chars/bundles", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill(json({
        bundles: st.bundles,
        activeRevision: st.activeRevision,
        storageRoot: "/var/lib/hmb/char-bundles",
      }));
    }
    const params = new URL(route.request().url()).searchParams;
    st.uploads.push({
      reason: params.get("reason"),
      note: params.get("note"),
      contentType: route.request().headers()["content-type"] ?? null,
    });
    // ⚠️ 서버는 업로드로 **활성화하지 않는다** — 목도 그래야 계약이 성립한다.
    const created = bundle({ id: `REV${st.bundles.length + 10}`, note: params.get("note") });
    st.bundles.unshift(created);
    return route.fulfill(json(created, 201));
  });

  await page.route((url) => url.pathname === "/api/admin/chars/bundles/active", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    st.activations.push({ revisionId: body.revisionId ?? null, reason: body.reason ?? null });
    st.activeRevision = body.revisionId ?? null;
    st.bundles = st.bundles.map((b) => ({ ...b, active: b.id === st.activeRevision }));
    return route.fulfill(json({ activeRevision: st.activeRevision, bundles: st.bundles }));
  });

  await page.route((url) => url.pathname === "/api/admin/chars/bundles/history", (route) =>
    route.fulfill(json([])),
  );

  return st;
}

async function openChars(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_admin"));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-chars").click();
  await expect(page.getByTestId("admin-chars-panel")).toBeVisible();
}

/** 운영 액션마다 사유를 받는다 — 자동 응답시킨다. */
async function autoAnswer(page: Page, answer: string | null) {
  await page.addInitScript((reply) => {
    window.prompt = () => reply as string | null;
    window.confirm = () => reply !== null;
  }, answer);
}

test.describe("#309 W2 유닛 아트 운영", () => {
  test("활성 번들이 없으면 **구운 기본 아트 중**이라고 분명히 말한다", async ({ page }) => {
    await mockApi(page, { activeRevision: null });
    await openChars(page);

    // "올렸는데 왜 안 바뀌지"의 답이 화면에 있어야 한다 — 없으면 운영자가 캐시·배포·zip 을 헤맨다.
    await expect(page.getByTestId("admin-chars-active")).toContainText("구운 기본 아트");
    await expect(page.getByTestId("admin-chars-state-REV2")).toHaveAttribute("data-active", "0");
  });

  test("활성 리비전이 있으면 그 id 를 말하고, 그 행만 '서빙중' 이다", async ({ page }) => {
    await mockApi(page, { activeRevision: "REV1" });
    await openChars(page);

    await expect(page.getByTestId("admin-chars-active")).toContainText("REV1");
    await expect(page.getByTestId("admin-chars-state-REV1")).toHaveAttribute("data-active", "1");
    await expect(page.getByTestId("admin-chars-state-REV2")).toHaveAttribute("data-active", "0");
    // 서빙 중인 리비전에는 '켜기' 버튼이 없다(누를 이유가 없는 버튼을 두지 않는다).
    await expect(page.getByTestId("admin-chars-activate-REV1")).toHaveCount(0);
  });

  test("업로드는 zip 을 multipart 로 보내고 **바로 켜지지 않는다**", async ({ page }) => {
    const st = await mockApi(page, { activeRevision: null });
    await autoAnswer(page, "9차 아트 입고");
    await openChars(page);

    await page.getByTestId("admin-chars-input").setInputFiles({
      name: "chars.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PKfake"),
    });

    await expect.poll(() => st.uploads.length).toBe(1);
    expect(st.uploads[0]!.contentType).toContain("multipart/form-data");
    expect(st.uploads[0]!.reason).toBe("9차 아트 입고");
    // ⚠️ 올리는 것과 켜는 것은 별개다 — 잘못된 아트가 확인 전에 라이브로 나가지 않게.
    expect(st.activations, "업로드가 활성화를 유발하지 않는다").toHaveLength(0);
    await expect(page.getByTestId("admin-chars-notice")).toContainText("켜기");
  });

  test("리비전을 켜면 서버로 그 id 가 가고, 화면이 따라온다", async ({ page }) => {
    const st = await mockApi(page, { activeRevision: null });
    await autoAnswer(page, "적용");
    await openChars(page);

    await page.getByTestId("admin-chars-activate-REV2").click();

    await expect.poll(() => st.activations.length).toBe(1);
    expect(st.activations[0]).toEqual({ revisionId: "REV2", reason: "적용" });
    await expect(page.getByTestId("admin-chars-active")).toContainText("REV2");
  });

  test("**되돌릴 수 있다** — 구운 기본 아트로 롤백하면 revisionId 가 null 로 간다", async ({ page }) => {
    const st = await mockApi(page, { activeRevision: "REV1" });
    await autoAnswer(page, "아트가 잘못됨");
    await openChars(page);

    await page.getByTestId("admin-chars-rollback").click();

    await expect.poll(() => st.activations.length).toBe(1);
    // null = "전부 끄기" = 웹 빌드에 구운 아트로 돌아간다(= 이 기능이 없던 상태).
    expect(st.activations[0]).toEqual({ revisionId: null, reason: "아트가 잘못됨" });
    await expect(page.getByTestId("admin-chars-active")).toContainText("구운 기본 아트");
  });

  test("롤백 버튼은 켜져 있을 때만 보인다(끌 것이 없으면 없다)", async ({ page }) => {
    await mockApi(page, { activeRevision: null });
    await openChars(page);

    await expect(page.getByTestId("admin-chars-rollback")).toHaveCount(0);
  });

  test("사유를 취소하면 아무 일도 일어나지 않는다", async ({ page }) => {
    const st = await mockApi(page, { activeRevision: "REV1" });
    await autoAnswer(page, null);
    await openChars(page);

    await page.getByTestId("admin-chars-activate-REV2").click();
    await page.getByTestId("admin-chars-input").setInputFiles({
      name: "chars.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PKfake"),
    });

    expect(st.activations).toHaveLength(0);
    expect(st.uploads).toHaveLength(0);
    await expect(page.getByTestId("admin-chars-active")).toContainText("REV1");
  });

  test("**삭제 버튼이 없다** — 리비전은 쌓이고 포인터만 옮긴다", async ({ page }) => {
    await mockApi(page, { activeRevision: "REV1" });
    await openChars(page);

    const panel = page.getByTestId("admin-chars-panel");
    await expect(panel.getByTestId("admin-chars-delete-REV1")).toHaveCount(0);
    await expect(page.getByTestId("admin-chars-row-REV1")).not.toContainText("삭제");
  });

  test("요약이 있어 켜기 전에 무엇인지 확인할 수 있다", async ({ page }) => {
    await mockApi(page, { activeRevision: null });
    await openChars(page);

    const summary = page.getByTestId("admin-chars-summary-REV2");
    await expect(summary).toContainText("유닛 9");
    await expect(summary).toContainText("hero-rev4");
    await expect(summary).toContainText("9차 입고");
  });
});
