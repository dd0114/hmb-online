import { expect, test, type Page } from "@playwright/test";

/**
 * 공지 운영 패널 route-mock E2E (#248 §5 web 11).
 *
 * 계약: **상태는 서버가 판정한 값을 그대로 보여준다**(화면이 active × 기간을 다시 합치지 않는다) ·
 * 저장은 즉시 반영(재배포·리로드 호출 없음) · **실패도 이력에 남고 화면에서 사라지지 않는다** ·
 * 미리보기는 **팝업과 같은 렌더러**를 쓴다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어(glob 은 vite 소스까지 잡아 흰 화면).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface Row {
  id: string;
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  priority: number;
  revision: number;
  status: string;
}

interface Audit {
  id: string;
  actor: string;
  action: string;
  result: string;
  reason: string | null;
  createdAt: string;
}

interface MockState {
  rows: Row[];
  history: Audit[];
  seq: number;
  /** true 면 다음 쓰기가 400 — 서버 검증에 걸린 상황. */
  rejectNext: boolean;
  /** true 면 다음 수정/전환이 409 — 동시 수정에서 졌다(revision CAS 실패·조건부 UPDATE 0행). */
  conflictNext: boolean;
  /** 목록 응답을 고의로 망가뜨린다(구버전 서버). */
  brokenList: boolean;
  /** 목록 재조회 횟수 — 404/409 뒤에 화면이 낡은 목록을 다시 불러왔는지 센다. */
  listFetches: number;
}

function row(over: Partial<Row> & { id: string }): Row {
  return {
    title: `${over.id} 제목`,
    body: "본문",
    startsAt: null,
    endsAt: null,
    active: true,
    priority: 0,
    revision: 1,
    status: "LIVE",
    ...over,
  };
}

function freshState(): MockState {
  return {
    rows: [
      row({ id: "N1", title: "7/30 정기 점검", status: "LIVE", revision: 2, startsAt: "2026-07-29T00:00:00Z", endsAt: "2026-07-31T23:59:00Z" }),
      row({ id: "N2", title: "8월 신규 유닛", status: "SCHEDULED" }),
      row({ id: "N3", title: "임시 점검(오탈자)", status: "OFF", active: false, revision: 3 }),
      row({ id: "N4", title: "오픈 베타 시작", status: "EXPIRED" }),
    ],
    history: [],
    seq: 0,
    rejectNext: false,
    conflictNext: false,
    brokenList: false,
    listFetches: 0,
  };
}

/** 서버가 주는 409 — **복구 경로를 담은 문구**라 화면이 그대로 흘려야 한다. */
const CONFLICT_BODY = {
  code: "CONFLICT",
  message: "다른 운영자가 먼저 수정했습니다 — 목록을 새로고침한 뒤 다시 시도하세요",
};
/** 없는/이미 삭제된 id 를 대상으로 한 쓰기. */
const NOT_FOUND_BODY = { code: "NOT_FOUND", message: "공지를 찾을 수 없습니다" };

/**
 * ⚠️ **목은 서버보다 관대하면 안 된다.** 이 목이 PUT 바디를 검사하지 않고 200 을 주는 바람에
 * "수정이 실서버에서 항상 400"(blocker-1)과 "오프셋 없는 시각 전송"(major-2)이 게이트를 그대로
 * 통과했다. 아래 두 규칙은 server-java `AdminNoticeService` 의 실제 검증을 흉내 낸 것이다.
 */

/** 서버 `Notices.normalizeInstant` — 오프셋(`Z` 또는 `±HH:MM`) 없는 시각은 거절한다. */
const ISO_WITH_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

function offsetlessInstant(v: unknown): boolean {
  return typeof v === "string" && v !== "" && !ISO_WITH_OFFSET.test(v);
}

/** 서버 검증 미러. 위반이면 400 바디를, 통과면 null 을 돌려준다. */
function serverRejection(body: Record<string, unknown>, isUpdate: boolean) {
  // AdminNoticeService.requireNoActiveInBody — 수정은 `active` 를 **무시하지 않고 거절**한다.
  if (isUpdate && body.active !== undefined) {
    return {
      code: "VALIDATION_ERROR",
      message: "active 는 수정으로 바꿀 수 없습니다 — POST /api/admin/notices/{id}/active 를 쓰세요",
    };
  }
  if (offsetlessInstant(body.startsAt) || offsetlessInstant(body.endsAt)) {
    return {
      code: "VALIDATION_ERROR",
      message: "startsAt 는 ISO-8601 시각이어야 합니다(예: 2026-07-30T00:00:00Z)",
    };
  }
  // AdminNoticeService.validPriority — 범위 밖은 400. 클라 미러가 느슨하면 여기서 잡힌다(m3).
  if (typeof body.priority === "number" && (body.priority < -1000 || body.priority > 1000)) {
    return {
      code: "VALIDATION_ERROR",
      message: `priority 는 -1000 ~ 1000 사이여야 합니다: ${body.priority}`,
    };
  }
  // AdminNoticeService.validateReason — 500자 초과는 400.
  if (typeof body.reason === "string" && body.reason.length > 500) {
    return { code: "VALIDATION_ERROR", message: "reason 은 500자 이하여야 합니다" };
  }
  return null;
}

function record(st: MockState, action: string, result: string, reason: string | null) {
  st.seq += 1;
  st.history.unshift({
    id: `A${st.seq}`,
    actor: "관리자",
    action,
    result,
    reason,
    createdAt: `2026-07-29T14:0${st.seq}:00Z`,
  });
}

async function mockApi(page: Page): Promise<MockState> {
  const st = freshState();

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
  await page.route((url) => url.pathname === "/api/admin/notices", async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const rejection = serverRejection(body, false);
      if (rejection) {
        record(st, "notice_create", "failed", body.reason ?? null);
        return route.fulfill(json(rejection, 400));
      }
      if (st.rejectNext) {
        record(st, "notice_create", "failed", body.reason ?? null);
        return route.fulfill(json({ code: "VALIDATION_ERROR", message: "본문이 너무 깁니다" }, 400));
      }
      st.rows.unshift(
        row({
          id: `N${st.rows.length + 10}`,
          title: body.title,
          body: body.body,
          startsAt: body.startsAt ?? null,
          endsAt: body.endsAt ?? null,
          active: body.active !== false,
          priority: body.priority ?? 0,
          status: body.active === false ? "OFF" : "LIVE",
        }),
      );
      record(st, "notice_create", "ok", body.reason ?? null);
      return route.fulfill(json({ ok: true }));
    }
    st.listFetches += 1;
    return route.fulfill(json(st.brokenList ? {} : { notices: st.rows }));
  });
  await page.route((url) => url.pathname === "/api/admin/notices/history", (route) =>
    route.fulfill(json(st.history)),
  );
  await page.route(/\/api\/admin\/notices\/[^/]+\/active/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    const body = JSON.parse(route.request().postData() ?? "{}");
    const target = st.rows.find((r) => r.id === id);
    // 서버 규칙: 대상이 없거나 이미 삭제됐으면 404, 동시 수정에서 지면 409.
    if (!target || target.status === "DELETED") {
      record(st, "notice_active", "failed", body.reason ?? null);
      return route.fulfill(json(NOT_FOUND_BODY, 404));
    }
    if (st.conflictNext) {
      record(st, "notice_active", "failed", body.reason ?? null);
      return route.fulfill(json(CONFLICT_BODY, 409));
    }
    target.active = body.active;
    target.status = body.active ? "LIVE" : "OFF";
    record(st, "notice_active", "ok", body.reason ?? null);
    return route.fulfill(json({ ok: true }));
  });
  // ⚠️ `/history` 는 이 패턴에도 걸린다 — 나중에 등록한 핸들러가 이기므로 명시적으로 제외한다
  //    (안 하면 이력 조회가 이 핸들러로 새어 항상 빈 배열이 된다).
  await page.route(
    (url) => /^\/api\/admin\/notices\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/history"),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop()!;
      const method = route.request().method();
      if (method === "PUT") {
        const body = JSON.parse(route.request().postData() ?? "{}");
        const rejection = serverRejection(body, true);
        if (rejection) {
          record(st, "notice_update", "failed", body.reason ?? null);
          return route.fulfill(json(rejection, 400));
        }
        const target = st.rows.find((r) => r.id === id);
        // 404 = 없는/이미 삭제된 공지, 409 = 동시 수정에서 짐(revision CAS·조건부 UPDATE 0행).
        if (!target || target.status === "DELETED") {
          record(st, "notice_update", "failed", body.reason ?? null);
          return route.fulfill(json(NOT_FOUND_BODY, 404));
        }
        if (st.conflictNext) {
          record(st, "notice_update", "failed", body.reason ?? null);
          return route.fulfill(json(CONFLICT_BODY, 409));
        }
        // 서버 규칙: 제목·본문이 실제로 바뀔 때만 revision 을 올린다.
        if (target.title !== body.title || target.body !== body.body) target.revision += 1;
        // ⚠️ **전체 치환이다(부분 패치가 아니다).** 안 온 필드는 기존 값을 살리지 않고 **지운다** —
        //    `?? target.…` 로 살려 두면 web 이 기간을 빠뜨리는 회귀가 나도 목이 덮어 줘서 green 이
        //    된다(m5). 서버 `updateIsAFullReplaceNotAPatch` 와 짝이다.
        target.title = typeof body.title === "string" ? body.title : "";
        target.body = typeof body.body === "string" ? body.body : "";
        target.startsAt = typeof body.startsAt === "string" ? body.startsAt : null;
        target.endsAt = typeof body.endsAt === "string" ? body.endsAt : null;
        target.priority = typeof body.priority === "number" ? body.priority : 0;
        record(st, "notice_update", "ok", body.reason ?? null);
        return route.fulfill(json({ ok: true }));
      }
      if (method === "DELETE") {
        const reason = new URL(route.request().url()).searchParams.get("reason");
        const target = st.rows.find((r) => r.id === id);
        if (!target || target.status === "DELETED") {
          record(st, "notice_delete", "failed", reason);
          return route.fulfill(json(NOT_FOUND_BODY, 404));
        }
        if (target) target.status = "DELETED";
        record(st, "notice_delete", "ok", reason);
        return route.fulfill(json({ ok: true }));
      }
      return route.fulfill(json({}));
    },
  );
  return st;
}

async function openNotices(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_admin"));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-notices").click();
  await expect(page.getByTestId("admin-notices-panel")).toBeVisible();
}

test.describe("#248 admin 공지 패널", () => {
  test("목록은 **서버가 판정한** 상태 뱃지·rev·기간을 그대로 보여준다", async ({ page }) => {
    await mockApi(page);
    await openNotices(page);

    await expect(page.getByTestId("admin-notice-status-N1")).toHaveText("노출중");
    await expect(page.getByTestId("admin-notice-status-N2")).toHaveText("예약");
    await expect(page.getByTestId("admin-notice-status-N3")).toHaveText("중지");
    await expect(page.getByTestId("admin-notice-status-N4")).toHaveText("만료");
    // status 원문을 속성으로 보존한다 — 화면이 다시 계산하지 않았다는 증거.
    await expect(page.getByTestId("admin-notice-status-N2")).toHaveAttribute("data-status", "SCHEDULED");
    await expect(page.getByTestId("admin-notice-rev-N1")).toHaveText("2");
    await expect(page.getByTestId("admin-notice-row-N1")).toContainText("07-2");
  });

  test("게시하면 목록·이력이 즉시 갱신된다(재배포·리로드 호출 없음)", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    await page.getByTestId("admin-notice-title").fill("신규 캐릭터 추가");
    await page.getByTestId("admin-notice-body").fill("**신규 유닛**이 추가됐습니다\n- 보날두\n- 욱링엄");
    await page.getByTestId("admin-notice-priority").fill("10");
    await page.getByTestId("admin-notice-reason").fill("8월 업데이트 공지");
    await page.getByTestId("admin-notice-submit").click();

    await expect(page.getByTestId("admin-notice-notice")).toBeVisible();
    await expect(page.getByTestId("admin-notices-table")).toContainText("신규 캐릭터 추가");
    await expect(page.getByTestId("admin-notice-history")).toContainText("공지 생성");
    await expect(page.getByTestId("admin-notice-history")).toContainText("8월 업데이트 공지");
    expect(st.rows[0]!.title).toBe("신규 캐릭터 추가");
    expect(st.rows[0]!.priority).toBe(10);

    // 저장 성공 후 폼은 비워진다 — 직전 사유가 다음 액션에 재사용되면 원장이 거짓말한다.
    await expect(page.getByTestId("admin-notice-reason")).toHaveValue("");
  });

  test("사유 없이는 요청조차 나가지 않는다", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    await page.getByTestId("admin-notice-title").fill("제목");
    await page.getByTestId("admin-notice-body").fill("본문");
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notice-invalid")).toContainText("사유");
    expect(st.history, "서버에 아무 요청도 가지 않았다").toEqual([]);

    // 기간 역전도 클라에서 막는다.
    await page.getByTestId("admin-notice-reason").fill("사유 있음");
    await page.getByTestId("admin-notice-starts").fill("2026-07-31T00:00");
    await page.getByTestId("admin-notice-ends").fill("2026-07-29T00:00");
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notice-invalid")).toContainText("종료 시각");
    expect(st.history).toEqual([]);
  });

  test("수정 — 내용이 바뀌면 revision 이 오르고 이력에 남는다", async ({ page }) => {
    await mockApi(page);
    await openNotices(page);

    await page.getByTestId("admin-notice-edit-N1").click();
    await expect(page.getByTestId("admin-notice-form-title")).toHaveText("공지 수정");
    await expect(page.getByTestId("admin-notice-title")).toHaveValue("7/30 정기 점검");

    await page.getByTestId("admin-notice-body").fill("점검 시간이 변경됐습니다");
    await page.getByTestId("admin-notice-reason").fill("점검 시간 정정");
    await page.getByTestId("admin-notice-submit").click();

    await expect(page.getByTestId("admin-notice-rev-N1")).toHaveText("3");
    await expect(page.getByTestId("admin-notice-history")).toContainText("공지 수정");
    // 저장 후 작성 모드로 돌아온다.
    await expect(page.getByTestId("admin-notice-form-title")).toHaveText("공지 작성");
  });

  /**
   * blocker-1 회귀 가드 — 수정 바디에 `active` 가 실리면 실서버가 **400** 이고, 운영자는
   * 잘못 올라간 공지의 문구를 영영 못 고친다(hero Q3 재표시 경로가 통째로 죽는다).
   * 목이 서버 규칙을 흉내 내므로 되돌리면 여기서 즉시 깨진다.
   */
  test("수정 요청 바디에 `active` 를 싣지 않는다 (blocker-1)", async ({ page }) => {
    await mockApi(page);
    const puts: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/admin/notices/")) {
        puts.push(JSON.parse(r.postData() ?? "{}"));
      }
    });
    await openNotices(page);

    await page.getByTestId("admin-notice-edit-N1").click();
    await page.getByTestId("admin-notice-body").fill("문구만 고친다");
    await page.getByTestId("admin-notice-reason").fill("오탈자 수정");
    await page.getByTestId("admin-notice-submit").click();

    // 성공해야 한다 — 400 이면 여기서 에러 문구가 뜬다.
    await expect(page.getByTestId("admin-notice-notice")).toBeVisible();
    await expect(page.getByTestId("admin-notice-error")).toHaveCount(0);

    expect(puts, "PUT 이 정확히 한 번").toHaveLength(1);
    expect(Object.keys(puts[0]!), "수정 바디 키 집합에 active 가 없다").not.toContain("active");
    // 내용 필드는 그대로 실린다(빼는 게 목적이 아니라 `active` 만 빼는 것이다).
    expect(puts[0]).toMatchObject({ title: "7/30 정기 점검", body: "문구만 고친다", reason: "오탈자 수정" });

    // 생성은 반대다 — `active` 가 실려야 초기 노출 여부를 정할 수 있다.
    const posts: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/admin/notices")) {
        posts.push(JSON.parse(r.postData() ?? "{}"));
      }
    });
    await page.getByTestId("admin-notice-title").fill("새 공지");
    await page.getByTestId("admin-notice-body").fill("본문");
    await page.getByTestId("admin-notice-reason").fill("신규 게시");
    await page.getByTestId("admin-notice-active").uncheck();
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notices-table")).toContainText("새 공지");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ active: false });
  });

  /**
   * major-2 — 서버는 오프셋 없는 시각(`2026-08-01T00:00`)을 400 으로 거절한다.
   * 목이 그 규칙을 흉내 내므로, 클라가 로컬 문자열을 그대로 보내면 예약 공지 저장이 전부 실패한다.
   */
  test("예약 시각은 오프셋을 포함해 보낸다 — 예약 저장이 400 나지 않는다 (major-2)", async ({ page }) => {
    const st = await mockApi(page);
    const posts: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/admin/notices")) {
        posts.push(JSON.parse(r.postData() ?? "{}"));
      }
    });
    await openNotices(page);

    await page.getByTestId("admin-notice-title").fill("8월 예약 공지");
    await page.getByTestId("admin-notice-body").fill("본문");
    await page.getByTestId("admin-notice-starts").fill("2026-08-01T00:00");
    await page.getByTestId("admin-notice-ends").fill("2026-08-07T23:59");
    await page.getByTestId("admin-notice-reason").fill("8월 예약");
    await page.getByTestId("admin-notice-submit").click();

    await expect(page.getByTestId("admin-notice-notice")).toBeVisible();
    await expect(page.getByTestId("admin-notice-error")).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]!.startsAt), "Z 또는 ±HH:MM 오프셋 포함").toMatch(/(Z|[+-]\d{2}:?\d{2})$/);
    expect(String(posts[0]!.endsAt)).toMatch(/(Z|[+-]\d{2}:?\d{2})$/);
    expect(st.history.some((h) => h.result === "failed"), "실패 기록이 남지 않았다").toBe(false);
  });

  /**
   * m5 — 서버 `PUT` 은 **전체 치환**이다. 기간을 비우고 저장하면 실제로 **지워져야** 한다.
   * 목도 전체 치환이라 web 이 기간 필드를 빠뜨리는 회귀가 나면 여기서 잡힌다
   * (그 전에는 `notice-admin-logic.test.ts` 의 payload 단언 하나에만 의존했다).
   */
  test("수정은 전체 치환 — 기간을 비우면 목록에서 기간이 사라진다 (m5)", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    // N1 은 기간이 있는 공지다(07-29 → 07-31).
    await expect(page.getByTestId("admin-notice-row-N1")).toContainText("07-2");
    await expect(page.getByTestId("admin-notice-row-N1")).not.toContainText("무기한");

    await page.getByTestId("admin-notice-edit-N1").click();
    await expect(page.getByTestId("admin-notice-starts")).not.toHaveValue("");
    // 기간을 비우고 저장 = "이 공지에서 기간을 없앤다"는 뜻이다.
    await page.getByTestId("admin-notice-starts").fill("");
    await page.getByTestId("admin-notice-ends").fill("");
    await page.getByTestId("admin-notice-reason").fill("상시 공지로 전환");
    await page.getByTestId("admin-notice-submit").click();

    await expect(page.getByTestId("admin-notice-notice")).toBeVisible();
    // 안 보낸 게 아니라 **null 을 보내 지운** 결과가 화면에 나타난다.
    await expect(page.getByTestId("admin-notice-row-N1")).toContainText("즉시 → 무기한");
    expect(st.rows.find((r) => r.id === "N1")).toMatchObject({ startsAt: null, endsAt: null });
  });

  /**
   * m3 — 클라 검증이 서버보다 느슨하면 운영자는 **왕복해야만** 400 을 안다.
   * 목도 같은 규칙을 흉내 내므로, 클라 미러를 빼면 요청이 나가고 400 을 받아 여기서 잡힌다.
   */
  test("priority 범위·reason 길이를 클라가 먼저 막는다 — 요청이 나가지 않는다 (m3)", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    await page.getByTestId("admin-notice-title").fill("범위 밖 공지");
    await page.getByTestId("admin-notice-body").fill("본문");
    await page.getByTestId("admin-notice-reason").fill("사유 있음");

    // 입력 자체가 상한을 알린다(왕복 전에 보인다).
    await expect(page.getByTestId("admin-notice-priority")).toHaveAttribute("max", "1000");
    await expect(page.getByTestId("admin-notice-priority")).toHaveAttribute("min", "-1000");
    await expect(page.getByTestId("admin-notice-reason")).toHaveAttribute("maxlength", "500");

    await page.getByTestId("admin-notice-priority").fill("100000");
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notice-invalid")).toContainText("1000");
    expect(st.history, "서버에 요청이 가지 않았다").toEqual([]);

    // 음수 방향도 같다.
    await page.getByTestId("admin-notice-priority").fill("-5000");
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notice-invalid")).toContainText("1000");
    expect(st.history).toEqual([]);

    // 경계값은 통과한다(과잉 차단 회귀 가드).
    await page.getByTestId("admin-notice-priority").fill("1000");
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notice-notice")).toBeVisible();
    expect(st.rows[0]).toMatchObject({ title: "범위 밖 공지", priority: 1000 });
  });

  test("노출 전환·삭제는 사유를 받고, soft delete 라 목록에서 상태로 남는다", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    page.once("dialog", (d) => d.accept("긴급 내림"));
    await page.getByTestId("admin-notice-toggle-N1").click();
    await expect(page.getByTestId("admin-notice-status-N1")).toHaveText("중지");
    await expect(page.getByTestId("admin-notice-history")).toContainText("노출 전환");

    page.once("dialog", (d) => d.accept("중복 공지 정리"));
    await page.getByTestId("admin-notice-delete-N4").click();
    await expect(page.getByTestId("admin-notice-status-N4")).toHaveText("삭제됨");
    await expect(page.getByTestId("admin-notice-history")).toContainText("공지 삭제");
    await expect(page.getByTestId("admin-notice-history")).toContainText("중복 공지 정리");
    // hard delete 가 아니다 — 행이 사라지지 않는다(감사 원장이 참조를 잃지 않게).
    expect(st.rows.some((r) => r.id === "N4")).toBe(true);
  });

  test("사유 입력을 취소하면 아무 일도 일어나지 않는다", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    page.once("dialog", (d) => d.dismiss());
    await page.getByTestId("admin-notice-toggle-N1").click();
    await expect(page.getByTestId("admin-notice-status-N1")).toHaveText("노출중");
    expect(st.history).toEqual([]);
  });

  /**
   * 409 CONFLICT — 동시 수정에서 졌다(revision CAS 실패·조건부 UPDATE 0행).
   * 서버 문구에 **복구 경로**가 담겨 있으므로 그대로 흘려야 하고, 목록은 낡았으므로 다시 조회돼야 한다.
   * 400 만 처리하던 화면이면 여기서 잡힌다.
   */
  test("409 — 복구 경로가 담긴 서버 문구를 그대로 보여주고 목록을 다시 불러온다", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);
    const before = st.listFetches;
    st.conflictNext = true;

    await page.getByTestId("admin-notice-edit-N1").click();
    await page.getByTestId("admin-notice-body").fill("내가 고친 문구");
    await page.getByTestId("admin-notice-reason").fill("문구 정정");
    await page.getByTestId("admin-notice-submit").click();

    // 서버가 준 복구 안내가 그대로 뜬다(화면이 자기 문구로 덮지 않는다).
    await expect(page.getByTestId("admin-notice-error")).toContainText("새로고침");
    await expect(page.getByTestId("admin-notice-error")).toContainText("다른 운영자");
    await expect(page.getByTestId("admin-notice-notice")).toHaveCount(0);
    // 실패도 이력에 남고,
    await expect(page.getByTestId("admin-notice-history-failed")).toBeVisible();
    // 낡은 목록을 다시 불러왔다(onSettled — 성공·실패 가리지 않는다).
    await expect.poll(() => st.listFetches, { timeout: 10_000 }).toBeGreaterThan(before);

    // 갈등이 풀리면 같은 수정이 그대로 통한다(막다른 길이 아니다).
    st.conflictNext = false;
    await page.getByTestId("admin-notice-submit").click();
    await expect(page.getByTestId("admin-notice-notice")).toBeVisible();
  });

  /** 404 — 이미 삭제된 공지. 계속 눌러도 되살아나지 않으므로 목록 갱신이 자연스러운 후속이다. */
  test("404 — 이미 삭제된 공지를 건드리면 안내 + 목록 재조회", async ({ page }) => {
    const st = await mockApi(page);
    await openNotices(page);

    await page.getByTestId("admin-notice-edit-N2").click();
    await page.getByTestId("admin-notice-body").fill("고쳐본다");
    await page.getByTestId("admin-notice-reason").fill("문구 정정");
    // 그 사이 다른 운영자가 지웠다.
    st.rows = st.rows.filter((r) => r.id !== "N2");
    const before = st.listFetches;
    await page.getByTestId("admin-notice-submit").click();

    await expect(page.getByTestId("admin-notice-error")).toContainText("찾을 수 없습니다");
    await expect.poll(() => st.listFetches, { timeout: 10_000 }).toBeGreaterThan(before);
    // 재조회 결과가 화면에 반영된다 — 사라진 행이 목록에서 빠진다.
    await expect(page.getByTestId("admin-notice-row-N2")).toHaveCount(0);
  });

  test("서버가 거절하면 사유를 보여주고 **실패도 이력에 남는다**", async ({ page }) => {
    const st = await mockApi(page);
    st.rejectNext = true;
    await openNotices(page);

    await page.getByTestId("admin-notice-title").fill("실패할 공지");
    await page.getByTestId("admin-notice-body").fill("본문");
    await page.getByTestId("admin-notice-reason").fill("검증 실패 시도");
    await page.getByTestId("admin-notice-submit").click();

    await expect(page.getByTestId("admin-notice-error")).toContainText("본문이 너무 깁니다");
    await expect(page.getByTestId("admin-notice-history-failed")).toBeVisible();
    await expect(page.getByTestId("admin-notice-history")).toContainText("검증 실패 시도");
    // 반쯤 적용된 것처럼 보이지 않는다.
    await expect(page.getByTestId("admin-notices-table")).not.toContainText("실패할 공지");
  });

  test("목록 응답이 망가져도 admin 페이지가 죽지 않는다", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const st = await mockApi(page);
    st.brokenList = true;
    await openNotices(page);

    await expect(page.getByTestId("admin-notices-empty")).toBeVisible();
    // 다른 운영 탭은 그대로 쓸 수 있다.
    await page.getByTestId("admin-tab-users").click();
    await expect(page.getByTestId("admin-page")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("미리보기는 팝업과 **같은 렌더러** — 서식은 살고 스크립트는 죽는다", async ({ page }) => {
    await mockApi(page);
    await openNotices(page);

    await page
      .getByTestId("admin-notice-body")
      .fill('**굵게**\n- 항목\n[링크](https://x.test)\n<script>window.__pwned=1</script>');

    const preview = page.getByTestId("admin-notice-preview-body");
    await expect(preview.locator("strong")).toHaveText("굵게");
    await expect(preview.locator("ul li")).toHaveCount(1);
    await expect(preview.locator("a")).toHaveAttribute("href", "https://x.test");
    expect(await preview.locator("script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(preview).toContainText("<script>window.__pwned=1</script>");
  });
});
