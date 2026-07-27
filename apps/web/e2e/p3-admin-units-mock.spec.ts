import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * 어드민 유닛 카탈로그 route-mock E2E (#207 파트 A / 웨이브2-C).
 *
 * server-java 의 admin units API 를 **백엔드 없이** page.route 로 목킹해
 * `docs/plan-v2/api/openapi.yaml` admin units 섹션 계약을 web 측에서 박제한다.
 * (라이브 왕복은 서버 발행 후 통합 게이트에서 별도 — v7 배포/데모 스택 무접촉.)
 *
 * 유닛 테스트(AdminUnitsSection.test.ts)가 못 보는 것을 여기서 본다:
 *   · 실제 HTTP 요청에 **Idempotency-Key 헤더가 실제로 실리는가**
 *   · 등급 하향 409 → 확인 → confirmImpact 재요청이 **다른 키**로 나가는가
 *   · 모바일 가로 오버플로 0
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다. glob('**\/api\/**')는 vite 소스 /src/api/*.ts 까지
 * 잡아 모듈 로딩을 깨고 흰 화면이 된다(프로젝트 기지식).
 */

const CAP_DIR = new URL("../.admin-units/", import.meta.url).pathname;

interface Unit {
  id: string;
  name: string;
  position: "GK" | "DF" | "MF" | "FW";
  grade: "BRONZE" | "SILVER" | "GOLD" | "DIA" | "LEGEND";
  attributes: Record<string, number>;
  personality: "FIERY" | "CALM" | "GLASS" | "AMBITIOUS";
  active: boolean;
  adminLocked: boolean;
  dataVersion: string;
}

const ATTRS = {
  technical: 93,
  mental: 95,
  physical: 92,
  passing: 93,
  shooting: 95,
  tackling: 86,
  pace: 93,
  stamina: 95,
  positioning: 89,
};

interface MockState {
  units: Unit[];
  /** 관측용 — 실제로 나간 변경 요청(경로·바디·멱등키). */
  seen: { path: string; method: string; idemKey: string | null; body: unknown }[];
}

function freshState(): MockState {
  return {
    units: [
      {
        id: "P005",
        name: "유라도나",
        position: "MF",
        grade: "LEGEND",
        attributes: { ...ATTRS },
        personality: "FIERY",
        active: true,
        adminLocked: false,
        dataVersion: "v2.1",
      },
      {
        id: "P001",
        name: "석신",
        position: "GK",
        grade: "LEGEND",
        attributes: { ...ATTRS, positioning: 96 },
        personality: "CALM",
        active: false,
        adminLocked: true,
        dataVersion: "admin",
      },
      {
        id: "P074",
        name: "김스타터",
        position: "DF",
        grade: "BRONZE",
        attributes: { ...ATTRS, technical: 44 },
        personality: "GLASS",
        active: true,
        adminLocked: false,
        dataVersion: "v2.1",
      },
    ],
    seen: [],
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const GRADE_ORDER = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];

function record(state: MockState, req: Request) {
  state.seen.push({
    path: new URL(req.url()).pathname,
    method: req.method(),
    idemKey: req.headers()["idempotency-key"] ?? null,
    body: req.postData() ? req.postDataJSON() : null,
  });
}

async function mockApi(page: Page, state: MockState) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );

  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u3", nickname: "관리자", isAdmin: true },
          wallet: { points: 999 },
          records: { wins: 1, draws: 0, losses: 0 },
        }),
      ),
  );

  await page.route(
    (url) => url.pathname === "/api/admin/users",
    (route) => route.fulfill(json({ users: [] })),
  );

  // 목록 — 필터 q·grade·position·active 를 서버처럼 적용한다.
  await page.route(
    (url) => url.pathname === "/api/admin/units",
    (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        record(state, req);
        const body = req.postDataJSON() as Partial<Unit> & { reason: string };
        const created: Unit = {
          id: "P181",
          name: body.name!,
          position: body.position!,
          grade: body.grade!,
          attributes: body.attributes as Record<string, number>,
          personality: body.personality ?? "CALM",
          active: body.active ?? true,
          adminLocked: true,
          dataVersion: "admin",
        };
        state.units.push(created);
        return route.fulfill(
          json({ unit: created, applied: true, idempotencyKey: "k", auditId: "A9", changedFields: [] }),
        );
      }
      const sp = new URL(req.url()).searchParams;
      const q = sp.get("q")?.trim().toLowerCase() ?? "";
      let items = state.units;
      if (q) {
        items = items.filter(
          (u) => u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q),
        );
      }
      const grade = sp.get("grade");
      if (grade) items = items.filter((u) => u.grade === grade);
      const position = sp.get("position");
      if (position) items = items.filter((u) => u.position === position);
      const activeParam = sp.get("active");
      if (activeParam !== null) items = items.filter((u) => u.active === (activeParam === "true"));
      return route.fulfill(json({ items, total: items.length, limit: 25, offset: 0 }));
    },
  );

  // 상세 + PATCH(등급 하향은 confirmImpact 없으면 409 + 영향 detail)
  await page.route(
    (url) => /^\/api\/admin\/units\/[^/]+$/.test(url.pathname),
    (route) => {
      const req = route.request();
      const id = new URL(req.url()).pathname.split("/").pop()!;
      const unit = state.units.find((u) => u.id === id);
      if (!unit) return route.fulfill(json({ code: "NOT_FOUND", message: "no unit" }, 404));

      if (req.method() === "PATCH") {
        record(state, req);
        const body = req.postDataJSON() as Record<string, unknown>;
        const nextGrade = body.grade as Unit["grade"] | undefined;
        const lowering =
          nextGrade !== undefined &&
          GRADE_ORDER.indexOf(nextGrade) < GRADE_ORDER.indexOf(unit.grade);
        if (lowering && body.confirmImpact !== true) {
          return route.fulfill(
            json(
              {
                code: "CONFLICT",
                message: "등급 하향은 영향 확인이 필요합니다",
                detail: {
                  fromGrade: unit.grade,
                  toGrade: nextGrade,
                  capLowered: true,
                  affectedUsers: 12,
                  avgOvrDelta: -3.24,
                  worstOvrDelta: -7.33,
                  computed: true,
                },
              },
              409,
            ),
          );
        }
        const changed: string[] = [];
        for (const k of ["name", "position", "grade", "personality", "active"] as const) {
          if (body[k] !== undefined) {
            (unit as Record<string, unknown>)[k] = body[k];
            changed.push(k);
          }
        }
        if (body.attributes) {
          Object.assign(unit.attributes, body.attributes as Record<string, number>);
          changed.push("attributes");
        }
        unit.adminLocked = true;
        return route.fulfill(
          json({ unit, applied: true, idempotencyKey: "k", auditId: "A8", changedFields: changed }),
        );
      }

      return route.fulfill(
        json({
          unit,
          holdings: { owners: 12, copies: 19 },
          recentAudit: [
            {
              id: "A1",
              actorUserId: "관리자",
              playerId: unit.id,
              action: "unit_update",
              before: { grade: "DIA" },
              after: { grade: "LEGEND" },
              changedFields: ["grade"],
              reason: "레전드 승격",
              idemKey: "k0",
              createdAt: "2026-07-26T09:00:00Z",
            },
          ],
        }),
      );
    },
  );

  // 활성/비활성 토글
  await page.route(
    (url) => /^\/api\/admin\/units\/[^/]+\/(activate|deactivate)$/.test(url.pathname),
    (route) => {
      const req = route.request();
      record(state, req);
      const parts = new URL(req.url()).pathname.split("/");
      const verb = parts.pop()!;
      const id = parts.pop()!;
      const unit = state.units.find((u) => u.id === id)!;
      unit.active = verb === "activate";
      unit.adminLocked = true;
      return route.fulfill(
        json({ unit, applied: true, idempotencyKey: "k", auditId: "A7", changedFields: ["active"] }),
      );
    },
  );
}

async function seedToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
}

async function openUnits(page: Page) {
  await page.goto("/admin");
  await expect(page.getByTestId("admin-page")).toBeVisible();
  await page.getByTestId("admin-tab-units").click();
  await expect(page.getByTestId("admin-units")).toBeVisible();
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test.describe("어드민 유닛 카탈로그 (route-mock)", () => {
  test("(a) 목록·필터 — 비활성 유닛이 시각적으로 구분되고 모바일 가로 오버플로 0", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await openUnits(page);
    await expect(page.getByTestId("admin-unit-row-P005")).toBeVisible();
    await expect(page.getByTestId("admin-unit-row-P001")).toHaveAttribute("data-active", "false");
    await expect(page.getByTestId("admin-unit-state-P001")).toHaveText("비활성");

    // 비활성 행은 딤 처리된다(계산된 opacity 가 활성 행보다 낮다).
    const dim = await page
      .getByTestId("admin-unit-row-P001")
      .locator("td")
      .first()
      .evaluate((el) => Number(getComputedStyle(el).opacity));
    const lit = await page
      .getByTestId("admin-unit-row-P005")
      .locator("td")
      .first()
      .evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(dim).toBeLessThan(lit);

    await page.screenshot({ path: `${CAP_DIR}units-list-phone.png`, fullPage: true });

    // 활성 필터 = 비활성만
    await page.getByTestId("admin-units-active").selectOption("false");
    await expect(page.getByTestId("admin-unit-row-P001")).toBeVisible();
    await expect(page.getByTestId("admin-unit-row-P005")).toHaveCount(0);
    await page.getByTestId("admin-units-active").selectOption("");

    // 등급 필터
    await page.getByTestId("admin-units-grade").selectOption("BRONZE");
    await expect(page.getByTestId("admin-unit-row-P074")).toBeVisible();
    await expect(page.getByTestId("admin-unit-row-P005")).toHaveCount(0);
    await page.getByTestId("admin-units-grade").selectOption("");

    // 검색(디바운스)
    await page.getByTestId("admin-units-search").fill("석신");
    await expect(page.getByTestId("admin-unit-row-P001")).toBeVisible();
    await expect(page.getByTestId("admin-unit-row-P005")).toHaveCount(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("(b) 상세 — 현재값·보유 유저 수·감사 이력(이전값 → 새값)", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await openUnits(page);
    await page.getByTestId("admin-unit-select-P005").click();
    await expect(page.getByTestId("admin-unit-detail")).toBeVisible();
    await expect(page.getByTestId("admin-unit-owners")).toHaveText("12");
    await expect(page.getByTestId("admin-unit-copies")).toHaveText("19");
    await expect(page.getByTestId("admin-unit-audit-row-A1")).toContainText("grade: DIA → LEGEND");
    await expect(page.getByTestId("admin-unit-audit-row-A1")).toContainText("레전드 승격");
    await page.screenshot({ path: `${CAP_DIR}units-detail.png`, fullPage: true });
  });

  test("(c) 수정 — 사유 필수, 바뀐 능력치만 PATCH, Idempotency-Key 헤더 실림", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await openUnits(page);
    await page.getByTestId("admin-unit-select-P005").click();
    await page.getByTestId("admin-unit-attr-pace").fill("90");
    // 사유가 없으면 제출 자체가 막힌다.
    await expect(page.getByTestId("admin-unit-submit")).toBeDisabled();
    await page.getByTestId("admin-unit-reason").fill("밸런스 조정");
    await page.getByTestId("admin-unit-submit").click();
    await expect(page.getByTestId("admin-units-notice")).toContainText("수정 완료");

    const patch = state.seen.find((s) => s.method === "PATCH")!;
    expect(patch.body).toEqual({ reason: "밸런스 조정", attributes: { pace: 90 } });
    expect(patch.idemKey).toBeTruthy();
  });

  test("(d) ⭐ 등급 하향 409 → 영향 확인 다이얼로그 → confirmImpact 재요청(새 멱등키)", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await openUnits(page);
    await page.getByTestId("admin-unit-select-P005").click();
    await page.getByTestId("admin-unit-grade").selectOption("DIA");
    await expect(page.getByTestId("admin-unit-downgrade-warn")).toBeVisible();
    await page.getByTestId("admin-unit-reason").fill("레전드 강등");
    await page.getByTestId("admin-unit-submit").click();

    // 409 는 에러가 아니라 확인 요청으로 뜬다.
    await expect(page.getByTestId("admin-unit-impact")).toBeVisible();
    await expect(page.getByTestId("admin-unit-impact-body")).toHaveText(
      "이 변경으로 12명의 카드가 평균 −3.2 OVR (최악 −7.3 OVR)",
    );
    await expect(page.getByTestId("admin-unit-impact-users")).toHaveText("12명");
    await page.screenshot({ path: `${CAP_DIR}units-grade-impact-dialog.png` });

    await page.getByTestId("admin-unit-impact-ok").click();
    await expect(page.getByTestId("admin-units-notice")).toContainText("수정 완료");
    await expect(page.getByTestId("admin-unit-impact")).toHaveCount(0);

    const patches = state.seen.filter((s) => s.method === "PATCH");
    expect(patches.length).toBe(2);
    expect(patches[0]!.body).toEqual({ reason: "레전드 강등", grade: "DIA" });
    expect(patches[1]!.body).toEqual({ reason: "레전드 강등", grade: "DIA", confirmImpact: true });
    // 두 요청 다 멱등키가 실리고, 재요청은 **다른 키**다(바디가 달라졌으므로).
    expect(patches[0]!.idemKey).toBeTruthy();
    expect(patches[1]!.idemKey).toBeTruthy();
    expect(patches[1]!.idemKey).not.toBe(patches[0]!.idemKey);

    await page.screenshot({ path: `${CAP_DIR}units-after-downgrade.png`, fullPage: true });
  });

  test("(e) 목록에서 바로 활성/비활성 토글 — 사유 필수", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await openUnits(page);
    await page.getByTestId("admin-unit-toggle-P005").click();
    await expect(page.getByTestId("admin-unit-toggle-ok")).toBeDisabled();
    await page.getByTestId("admin-unit-toggle-reason").fill("레거시 전환");
    await page.getByTestId("admin-unit-toggle-ok").click();
    await expect(page.getByTestId("admin-unit-state-P005")).toHaveText("비활성");

    const call = state.seen.find((s) => s.path.endsWith("/deactivate"))!;
    expect(call.body).toEqual({ reason: "레거시 전환" });
    expect(call.idemKey).toBeTruthy();
  });

  test("(f) 신규 유닛 추가 — 9종 + 사유", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await openUnits(page);
    await page.getByTestId("admin-unit-create-open").click();
    await page.getByTestId("admin-unit-create-name").fill("권씨");
    await page.getByTestId("admin-unit-create-position").selectOption("FW");
    await page.getByTestId("admin-unit-create-grade").selectOption("LEGEND");
    for (const k of [
      "technical",
      "mental",
      "physical",
      "passing",
      "shooting",
      "tackling",
      "pace",
      "stamina",
      "positioning",
    ]) {
      await page.getByTestId(`admin-unit-create-attr-${k}`).fill("88");
    }
    await expect(page.getByTestId("admin-unit-create-submit")).toBeDisabled();
    await page.getByTestId("admin-unit-create-reason").fill("신규 8종 투입");
    await page.getByTestId("admin-unit-create-submit").click();
    await expect(page.getByTestId("admin-units-notice")).toContainText("P181");

    const post = state.seen.find((s) => s.method === "POST" && s.path === "/api/admin/units")!;
    expect(post.idemKey).toBeTruthy();
    expect((post.body as { attributes: Record<string, number> }).attributes.pace).toBe(88);
    await page.screenshot({ path: `${CAP_DIR}units-create.png`, fullPage: true });
  });
});
