import { expect, test, type Page } from "@playwright/test";

/**
 * economy 무배포 운영 패널 route-mock E2E (#209 B안).
 *
 * 운영자 관점의 계약을 박제한다: <b>"바꿨다"가 아니라 "지금 뭐가 먹고 있는지"를 화면이 말해야 한다.</b>
 * 발행물은 이미지에 구워져 있어 서버가 override 파일로 갈아끼우므로, 값만 보여주는 화면은
 * "적용됐나?"에 답할 수 없다 — 그래서 출처 뱃지(BAKED/OVERRIDE)가 계약의 일부다.
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다(glob 은 vite 소스까지 잡아 흰 화면이 된다 — 프로젝트 기지식).
 */

interface OpsEntry {
  id: string;
  actor: string;
  action: string;
  result: string;
  reason: string | null;
  detailJson: string | null;
  createdAt: string;
}

interface MockState {
  pool: string[];
  count: number;
  overrideApplied: boolean;
  history: OpsEntry[];
  seq: number;
  /** true 면 교체 요청이 400 — 서버 검증(카탈로그 실재 등)에 걸린 상황. */
  rejectNext: boolean;
  /** 적용되지 않은 override 파일이 디스크에 남아 있는 상태(거절된 파일). */
  staleFile: boolean;
}

const BAKED_POOL = ["P001", "P003", "P005", "P009", "P025"];

function freshState(): MockState {
  return {
    pool: [...BAKED_POOL],
    count: 1,
    overrideApplied: false,
    history: [],
    seq: 0,
    rejectNext: false,
    staleFile: false,
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function view(st: MockState) {
  return {
    version: st.overrideApplied ? "v3" : "v3",
    source: st.overrideApplied ? "OVERRIDE" : "BAKED",
    effectivePath: st.overrideApplied ? "/var/lib/hmb/economy.override.json" : "/app/data/players/economy.v3.json",
    overridePath: "/var/lib/hmb/economy.override.json",
    overrideApplied: st.overrideApplied,
    overrideFilePresent: st.overrideApplied || st.staleFile,
    loadedAt: `2026-07-27T10:0${st.seq}:00Z`,
    starterPackSize: 14,
    starterTop: { pool: st.pool, count: st.count },
  };
}

function record(st: MockState, action: string, result: string, reason: string | null) {
  st.seq += 1;
  st.history.unshift({
    id: `A${st.seq}`,
    actor: "관리자",
    action,
    result,
    reason,
    detailJson: JSON.stringify({ before: BAKED_POOL, after: st.pool }),
    createdAt: `2026-07-27T10:0${st.seq}:00Z`,
  });
}

async function mockApi(page: Page): Promise<MockState> {
  const st = freshState();

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u-admin", nickname: "관리자", isAdmin: true, tutorialDone: true },
          wallet: { points: 0, gems: 0 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
  await page.route((url) => url.pathname === "/api/admin/users", (route) => route.fulfill(json({ users: [] })));
  await page.route((url) => url.pathname === "/api/admin/economy", (route) => route.fulfill(json(view(st))));
  await page.route((url) => url.pathname === "/api/admin/economy/history", (route) =>
    route.fulfill(json(st.history)),
  );
  await page.route((url) => url.pathname === "/api/admin/economy/starter-top", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (st.rejectNext) {
      record(st, "economy_starter_top", "failed", body.reason ?? null);
      return route.fulfill(json({ code: "VALIDATION_ERROR", message: "카탈로그에 없는 playerId 입니다: P999" }, 400));
    }
    st.pool = body.pool;
    st.count = body.count;
    st.overrideApplied = true;
    record(st, "economy_starter_top", "ok", body.reason ?? null);
    return route.fulfill(json(view(st)));
  });
  await page.route((url) => url.pathname === "/api/admin/economy/reload", (route) => {
    record(st, "economy_reload", "ok", "수동 리로드");
    return route.fulfill(json(view(st)));
  });
  await page.route((url) => url.pathname === "/api/admin/economy/override", (route) => {
    st.pool = [...BAKED_POOL];
    st.count = 1;
    st.overrideApplied = false;
    record(st, "economy_override_clear", "ok", "발행물로 롤백");
    return route.fulfill(json(view(st)));
  });
  return st;
}

/**
 * 운영 화면 진입 — #207 이 admin 을 탭 구조로 바꿨다(유저 운영 / 유닛 카탈로그 / 스타터 지급).
 * economy 패널은 그 세 번째 탭이므로 **탭을 눌러 들어가는 동선**이 실제 사용 경로다.
 */
async function openAdmin(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_admin"));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-economy").click();
  await expect(page.getByTestId("admin-economy-panel")).toBeVisible();
}

test.describe("#209 B안 — economy 무배포 운영 패널", () => {
  test("적용되지 않은 override 가 남아 있으면 경고 + 롤백으로 정리할 수 있다", async ({ page }) => {
    const st = await mockApi(page);
    st.staleFile = true;   // 서버가 거절해 적용은 안 됐지만 파일은 디스크에 남은 상태
    await openAdmin(page);

    // 값의 출처는 여전히 발행물이라고 정직하게 말하고,
    await expect(page.getByTestId("admin-economy-source")).toHaveAttribute("data-source", "BAKED");
    // 남아 있는 파일은 경고로 알리며, 롤백(삭제)은 가능해야 한다.
    await expect(page.getByTestId("admin-economy-stale-override")).toBeVisible();
    await expect(page.getByTestId("admin-economy-rollback")).toBeEnabled();
  });

  test("현재 값과 **출처**를 함께 보여준다 — 처음엔 배포 발행물", async ({ page }) => {
    await mockApi(page);
    await openAdmin(page);

    await expect(page.getByTestId("admin-economy-source")).toHaveAttribute("data-source", "BAKED");
    await expect(page.getByTestId("admin-economy-pool")).toHaveValue(BAKED_POOL.join(", "));
    await expect(page.getByTestId("admin-economy-current")).toContainText("5명");
    // 발행물 상태에서는 롤백할 게 없다.
    await expect(page.getByTestId("admin-economy-rollback")).toBeDisabled();
  });

  test("후보를 바꾸면 출처가 OVERRIDE 로 바뀌고 이력에 남는다", async ({ page }) => {
    const st = await mockApi(page);
    await openAdmin(page);

    await page.getByTestId("admin-economy-pool").fill("P016, P017");
    await page.getByTestId("admin-economy-count").fill("1");
    await page.getByTestId("admin-economy-reason").fill("레전드 개편 반영");
    page.once("dialog", (d) => d.accept()); // 전면 교체 확인
    await page.getByTestId("admin-economy-apply").click();

    await expect(page.getByTestId("admin-economy-notice")).toBeVisible();
    await expect(page.getByTestId("admin-economy-source")).toHaveAttribute("data-source", "OVERRIDE");
    await expect(page.getByTestId("admin-economy-rollback")).toBeEnabled();
    expect(st.pool).toEqual(["P016", "P017"]);

    // 이력이 즉시 갱신된다(새로고침 없이).
    await expect(page.getByTestId("admin-economy-history")).toContainText("최상위 후보 교체");
    await expect(page.getByTestId("admin-economy-history")).toContainText("레전드 개편 반영");
  });

  test("롤백 한 번이면 배포 발행물로 되돌아간다", async ({ page }) => {
    const st = await mockApi(page);
    await openAdmin(page);

    await page.getByTestId("admin-economy-pool").fill("P016");
    await page.getByTestId("admin-economy-reason").fill("교체");
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("admin-economy-apply").click();
    await expect(page.getByTestId("admin-economy-source")).toHaveAttribute("data-source", "OVERRIDE");

    await page.getByTestId("admin-economy-rollback").click();
    await expect(page.getByTestId("admin-economy-source")).toHaveAttribute("data-source", "BAKED");
    await expect(page.getByTestId("admin-economy-pool")).toHaveValue(BAKED_POOL.join(", "));
    expect(st.overrideApplied).toBe(false);
    await expect(page.getByTestId("admin-economy-history")).toContainText("발행물로 롤백");
  });

  test("형태가 틀린 입력은 요청조차 나가지 않는다", async ({ page }) => {
    const st = await mockApi(page);
    await openAdmin(page);

    // 사유 없음 → 클라가 먼저 막는다(서버 왕복 0).
    await page.getByTestId("admin-economy-pool").fill("P016");
    await page.getByTestId("admin-economy-reason").fill("");
    await page.getByTestId("admin-economy-apply").click();
    await expect(page.getByTestId("admin-economy-invalid")).toContainText("사유");

    // 장수 > 후보 수 → 역시 클라에서 차단.
    await page.getByTestId("admin-economy-reason").fill("사유 있음");
    await page.getByTestId("admin-economy-count").fill("3");
    await page.getByTestId("admin-economy-apply").click();
    await expect(page.getByTestId("admin-economy-invalid")).toContainText("후보 수");

    expect(st.history, "서버에 아무 요청도 가지 않았다").toEqual([]);
  });

  test("서버가 거절하면 사유를 보여주고, 실패도 이력에 남는다", async ({ page }) => {
    const st = await mockApi(page);
    st.rejectNext = true;
    await openAdmin(page);

    await page.getByTestId("admin-economy-pool").fill("P999");
    await page.getByTestId("admin-economy-reason").fill("없는 선수 시도");
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("admin-economy-apply").click();

    await expect(page.getByTestId("admin-economy-error")).toContainText("P999");
    // 실패해도 화면의 현재 상태는 그대로(발행물) — 반쯤 적용된 것처럼 보이지 않는다.
    await expect(page.getByTestId("admin-economy-source")).toHaveAttribute("data-source", "BAKED");
    await expect(page.getByTestId("admin-economy-history-failed")).toBeVisible();
  });
});
