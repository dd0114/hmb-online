import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #348 — **데스크톱 비율대 계약**. 후반 지시 입력 화면이 데스크톱에서 안 보이던 것(hero 실사용 제보).
 *
 * ── 왜 이 파일이 따로 있나 ────────────────────────────────────────────────────────────────
 * `p284-info-tabs.spec.ts` 는 파일 전체가 `test.use({ viewport: PHONE })` 라 **390px 하나만** 잰다.
 * 그래서 데스크톱(≥1024px)에만 걸리는 규칙 —
 *   `.sheetInfo  { height: clamp(170px, 26svh, 340px) }`
 *   `.sheetState { height: clamp(260px, 40svh, 420px) }`
 * — 이 입력 패널을 눌러 **프롬프트 입력칸을 뷰포트 밖으로 밀어내는데도** 계약이 전부 green 이었다.
 * 실측(1280×800): 시트 208px · 패널 내용 287px · 입력칸 bottom 876 > 뷰포트 800.
 *
 * 그 고정 높이 자체는 **의도된 결정**이다(hero 2026-07-23 — 로그가 쌓여도 무대가 안 줄게). 그러니
 * 이 파일은 "고정하지 마라"가 아니라 **"입력칸은 어느 데스크톱 비율에서도 화면 안에 있어야 한다"**
 * 를 잰다. 값을 어떻게 잡든 그 성질만 지키면 된다.
 *
 * ⚠️ `toBeVisible()` 로 쓰지 마라 — 뷰포트 밖도 통과한다(apps/web CLAUDE.md 함정 3, #286 W3.5 실적).
 * **박스 좌표 + 중심점 `elementFromPoint` 히트테스트**로만 잰다.
 */

const CAP_DIR = new URL("../.stage/p348/", import.meta.url).pathname;
const MATCH_ID = "m-348";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

/** 데스크탑 분기(≥1024px) 안에서 실제로 쓰이는 비율대 + 분기 하한/직하. */
const DESKTOP = [
  { name: "1024x768", width: 1024, height: 768 }, // 분기 하한 — 세로가 가장 빡빡하다
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1280x800", width: 1280, height: 800 }, // hero 제보 비율대
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1512x945", width: 1512, height: 945 }, // MacBook Pro 14"
  { name: "1680x1050", width: 1680, height: 1050 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const STARTERS = Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}` }));
const BENCH = Array.from({ length: 5 }, (_, i) => ({ slotIndex: i, playerId: `b${i + 1}` }));
const SNAPSHOT = {
  formation: "4-3-3",
  starters: STARTERS,
  bench: BENCH,
  teamTactics: { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 },
};
const DECK = {
  formation: "4-3-3",
  slots: [
    ...STARTERS.map((s) => ({ ...s, role: "starter" as const })),
    ...BENCH.map((s) => ({ ...s, role: "bench" as const })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "SILVER",
    owned: true,
    ownedCount: 1,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "BRONZE",
    owned: true,
    ownedCount: 1,
  })),
];

/** ⚠️ 라우트는 pathname 술어로 — glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다. */
async function mockApi(page: Page, state: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          scoreH1Home: 1,
          scoreH1Away: 1,
          createdAt: "2026-07-29T09:00:00Z",
          opponent: { name: "봇 FC" },
          userDeckSnapshot: SNAPSHOT,
          clock: null,
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: MATCH_LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string) {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  bottom: number;
  right: number;
  /** 박스가 뷰포트 안에 **통째로** 들어왔나. */
  inViewport: boolean;
  /** 중심점을 실제로 자기가 받나 — 잘리거나 덮였으면 false. */
  hitSelf: boolean;
  vw: number;
  vh: number;
}

async function box(page: Page, testId: string): Promise<Box> {
  const out = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
      inViewport:
        r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      hitSelf: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, testId);
  expect(out, `[${testId}] 가 DOM 에 없다`).not.toBeNull();
  return out!;
}

function pageScroll(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    return {
      v: Math.max(d.scrollHeight - d.clientHeight, b.scrollHeight - d.clientHeight),
      h: Math.max(d.scrollWidth - d.clientWidth, b.scrollWidth - d.clientWidth),
    };
  });
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

/**
 * ① 전반 `후반 지시` — 입력칸이 화면 안에 있어야 한다.
 *
 * 이게 hero 가 본 것이다: 탭도 칩도 보이는데 **적을 칸이 없다**. 그래서 계약의 주어는 탭이 아니라
 * **입력칸**이다. 스크롤하면 닿는다는 건 변론이 못 된다 — 800px 화면에서 150px 창 안을 스크롤해야
 * 한다는 사실 자체를 유저가 알 방법이 없었다.
 */
test.describe("① 후반 지시 입력칸 — 데스크톱 전 비율", () => {
  for (const vp of DESKTOP) {
    test(`${vp.name} — 프롬프트 입력칸이 뷰포트 안에 통째로 있다`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "FIRST_HALF");
      await page.getByTestId("stage-tab-brief").click();
      await expect(page.getByTestId("stage-panel-brief")).toHaveCount(1);

      const prompt = await box(page, "brief-team-prompt");
      expect(
        prompt.inViewport,
        `${vp.name}: 입력칸이 화면 밖 — bottom ${prompt.bottom} > 뷰포트 ${prompt.vh}`,
      ).toBe(true);
      expect(prompt.hitSelf, `${vp.name}: 입력칸 중심을 다른 것이 받는다(덮였거나 잘렸다)`).toBe(true);
      // 3줄 textarea 가 한 줄로 찌그러지면 "보이긴 한다"가 성립해도 못 쓴다.
      expect(prompt.h, `${vp.name}: 입력칸 높이가 3줄 값 아래로 눌리면 안 된다`).toBeGreaterThanOrEqual(60);

      // 대상 칩 줄도 같이 살아야 한다(누구에게 쓸지 못 고르면 입력칸만 있어도 소용없다).
      const targets = await box(page, "brief-targets");
      expect(targets.inViewport, `${vp.name}: 대상 칩 줄이 화면 밖`).toBe(true);
    });
  }

  test("무대는 후반 지시 탭에서도 남는다 (#169 AC-W1-1 유지)", async ({ page }) => {
    // 입력칸 자리를 만든다고 무대를 없애면 다른 계약을 깨는 것이다.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    const canvas = await box(page, "stage-canvas");
    expect(canvas.h, "무대가 사라지거나 실질적으로 0 이 되면 안 된다").toBeGreaterThan(160);
    expect(canvas.y, "무대는 화면 안에서 시작한다").toBeGreaterThanOrEqual(-1);
  });

  test("문서 스크롤 0 · 시트 폭 ≤ 뷰포트 (데스크톱 전 비율, 전 탭)", async ({ page }) => {
    for (const vp of DESKTOP) {
      await page.setViewportSize(vp);
      await openMatch(page, "FIRST_HALF");
      for (const key of ["stats", "log", "brief"]) {
        await page.getByTestId(`stage-tab-${key}`).click();
        const s = await pageScroll(page);
        expect(s.v, `${vp.name}/${key}: 문서 세로 스크롤 0`).toBeLessThanOrEqual(1);
        expect(s.h, `${vp.name}/${key}: 가로 오버플로 0`).toBeLessThanOrEqual(1);
        const sheet = await box(page, "stage-sheet");
        expect(sheet.w, `${vp.name}/${key}: 시트 폭이 뷰포트를 넘으면 안 됨`).toBeLessThanOrEqual(vp.width + 1);
      }
    }
  });
});

/**
 * ② 감독시간 — 무대가 탭으로 내려간 상태(managing)라 **패널이 세로를 전부 가져간다**.
 * `.bodyManaging` 주석이 선언한 성질인데 데스크톱 고정 높이가 그것을 덮고 있었다:
 * 1280×800 실측에서 시트가 ~360px 에 갇히고 아래 440px 가 빈 검은 화면이었다.
 */
test.describe("② 감독시간 — 죽은 공간 없이 세로를 쓴다", () => {
  for (const vp of DESKTOP) {
    test(`${vp.name} — 시트가 본문 세로를 다 쓰고 CTA·입력이 화면 안`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "HALFTIME");
      await expect(page.getByTestId("halftime-panel")).toHaveCount(1);

      const sheet = await box(page, "stage-sheet");
      // 시트 아래로 남는 빈 띠 = 죽은 공간. 무대가 없는 상태라 이 자리를 비워둘 이유가 없다.
      const dead = sheet.vh - sheet.bottom;
      expect(dead, `${vp.name}: 시트 아래 빈 공간 ${dead}px — 감독시간엔 무대가 없다`).toBeLessThanOrEqual(8);

      const cta = await box(page, "resume-button");
      expect(cta.inViewport, `${vp.name}: [후반 시작] 이 화면 밖`).toBe(true);
      expect(cta.hitSelf, `${vp.name}: [후반 시작] 중심을 다른 것이 받는다`).toBe(true);

      const prompt = await box(page, "editor-team-prompt");
      expect(prompt.inViewport, `${vp.name}: 감독시간 팀 지시 입력칸이 화면 밖`).toBe(true);
      expect(prompt.hitSelf, `${vp.name}: 감독시간 입력칸이 CTA 등에 덮였다`).toBe(true);
    });
  }
});

/**
 * ③ **분기 바깥의 "넓고 낮은 창"** — 스윕이 드러낸 인접 밴드.
 *
 * 처음엔 데스크탑(≥1024)만 고쳤는데 스윕이 1023×768 에서 **같은 증상**을 그대로 보여줬다
 * (무대가 58svh=445px 를 먹고 시트 237px → 입력칸 bottom 808 > 768). 데스크탑만 고치면 유저가
 * 창을 조금 좁히는 순간 되돌아온다 — 분기가 둘일 뿐 결함은 하나다.
 */
test.describe("③ 데스크탑 분기 바로 아래 — 같은 결함이 남지 않는다", () => {
  for (const vp of [
    { name: "1023x768", width: 1023, height: 768 },
    { name: "900x700", width: 900, height: 700 },
    { name: "820x640", width: 820, height: 640 },
  ]) {
    test(`${vp.name} — 후반 지시 입력칸이 뷰포트 안`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "FIRST_HALF");
      await page.getByTestId("stage-tab-brief").click();
      await expect(page.getByTestId("stage-panel-brief")).toHaveCount(1);

      const prompt = await box(page, "brief-team-prompt");
      expect(prompt.inViewport, `${vp.name}: 입력칸 bottom ${prompt.bottom} > 뷰포트 ${prompt.vh}`).toBe(true);
      expect(prompt.hitSelf, `${vp.name}: 입력칸 중심을 다른 것이 받는다`).toBe(true);

      const canvas = await box(page, "stage-canvas");
      expect(canvas.h, `${vp.name}: 자리를 만든다고 무대를 없애면 안 된다`).toBeGreaterThan(120);
    });
  }
});

/** ④ 폰(390)은 회귀하지 않는다 — 폰에선 무대 높이를 **가로**가 정해서 상한 규칙이 안 걸린다. */
test.describe("④ 폰 대조군 — 무회귀", () => {
  test("390×844 에서 입력칸·칩·CTA 가 그대로 화면 안", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();
    expect((await box(page, "brief-team-prompt")).inViewport).toBe(true);
    expect((await box(page, "brief-targets")).inViewport).toBe(true);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, "HALFTIME");
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("halftime-panel")).toHaveCount(1);
    expect((await box(page, "resume-button")).inViewport).toBe(true);
  });
});
