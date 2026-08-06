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

/**
 * 데스크탑 분기(≥1024px) 안에서 실제로 쓰이는 비율대 + 분기 하한 + **세로가 짧은 창**.
 * 세로 짧은 축이 중요하다 — 브라우저 확대(125%)·툴바 많은 창이 여기로 떨어지고, 실제로
 * 이 대역에서만 상태 줄이 18px 모자라 밖으로 나갔다(독립검증 MAJOR-1).
 */
const DESKTOP = [
  { name: "1024x768", width: 1024, height: 768 }, // 분기 하한
  { name: "1024x640", width: 1024, height: 640 }, // 1280×800 을 125% 확대한 CSS 뷰포트
  { name: "1280x600", width: 1280, height: 600 }, // 세로가 가장 빡빡하다
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1280x800", width: 1280, height: 800 }, // hero 제보 비율대
  { name: "1440x560", width: 1440, height: 560 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1512x945", width: 1512, height: 945 }, // MacBook Pro 14"
  { name: "1680x1050", width: 1680, height: 1050 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "3440x1440", width: 3440, height: 1440 }, // 울트라와이드
];

/**
 * 데스크탑 분기 **바로 아래**의 "넓고 낮은 창" (#354). 창을 조금 좁혔거나 브라우저를 확대한 상태 —
 * 실사용에서 흔하다(853×533 = 1280×800 을 150% 확대한 CSS 뷰포트).
 * ⚠️ 이 밴드를 "모바일"로 부르지 마라 — 폰(390)은 멀쩡했고, 깨지는 조건은 **가로가 넓은 것**이다.
 */
const WIDE_LOW = [
  { name: "1023x768", width: 1023, height: 768 }, // 분기 바로 아래
  { name: "1023x900", width: 1023, height: 900 },
  { name: "960x1040", width: 960, height: 1040 },
  { name: "900x800", width: 900, height: 800 },
  { name: "853x533", width: 853, height: 533 }, // 1280×800 @150%
  { name: "820x640", width: 820, height: 640 },
  { name: "768x900", width: 768, height: 900 },
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
async function mockApi(page: Page, state: string, growth = false, mode?: string) {
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
          // FINISHED 에서만 의미 있는 값들 — 다른 상태에서는 서버도 주지 않는다.
          scoreHome: state === "FINISHED" ? 2 : null,
          scoreAway: state === "FINISHED" ? 3 : null,
          result: state === "FINISHED" ? "LOSS" : null,
          createdAt: "2026-07-29T09:00:00Z",
          opponent: { name: "봇 FC" },
          userDeckSnapshot: SNAPSHOT,
          clock: null,
          /*
           * ⚠️ **`mode` 를 안 실으면 결과 화면의 다음 경기 CTA 가 렌더되지 않는다**(#456 B5).
           * 그 상태로 이 파일 전체가 green 이었고, 정작 CTA 가 그려지는 리그·원정에서 아래 ⑥ 의
           * 세로 예산이 깨져 있었다 — apps/web CLAUDE.md "초록으로 거짓말하는 방식" **#4**
           * (픽스처가 두 상태를 뭉갠다) 그대로다. 기본은 계속 미탑재(= 연습, 구 표본 보존)이고
           * ⑥-b 가 그 팔을 따로 태운다.
           */
          ...(mode ? { mode } : {}),
        },
      });
    }
    /*
     * 결과 패널의 실제 내용(#355). `pointsAwarded` + `dailyReward`(#368 리그 보상 칸)까지 실어야
     * 라이브와 같은 높이가 나온다 — 이슈가 잰 449px 은 보상 줄이 없던 표본이고, 리그 매치에서는
     * 더 크다. **표본이 계약의 절반이다**(CLAUDE.md 함정 4).
     */
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: {
          matchId: MATCH_ID,
          result: "LOSS",
          scoreHome: 2,
          scoreAway: 3,
          pointsAwarded: 40,
          dailyReward: { slotNo: 3, currency: "DIA", amount: 5, awarded: true },
        },
      });
    }
    /*
     * 성장 리포트(#286 S1) — 기용 선수 수만큼 행이 붙는다. **결과 패널 높이에 상한이 없다**는
     * 증거이고, 그래서 이 화면의 CTA 는 높이 튜닝이 아니라 **스크롤 밖 고정층**으로만 지킬 수 있다.
     * 기본은 없음(404 = 서버 계약상 정상).
     */
    if (url.pathname.startsWith("/api/growth/report/")) {
      return growth
        ? route.fulfill({
            json: {
              matchId: MATCH_ID,
              // #405 W2b 모양 — 구 `statXp`/`levelUps`/`ovrBefore/After` 는 서버가 더는 만들지 않는다.
              // 목이 옛 모양을 흉내 내면 이 계약이 실제 화면 대신 자기가 만든 세계를 재게 된다(#342).
              entries: PLAYERS.slice(0, 11).map((p, i) => ({
                playerId: p.id,
                name: p.name,
                position: p.position,
                grade: p.grade,
                xpGained: 90 + i * 5,
                levelBefore: 6,
                levelAfter: i === 0 ? 7 : 6,
                pendingChoices: [],
              })),
            },
          })
        : route.fulfill({ status: 404, json: {} });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: MATCH_LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string, growth = false, mode?: string) {
  await mockApi(page, state, growth, mode);
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

      /*
       * **상태 줄까지가 이 패널의 세로 예산이다** (독립검증 MAJOR-1).
       * #284 결정 C 로 저장 버튼이 없어서 이 줄이 **유일한 피드백**이다 — 자동 저장이 실패했는데
       * 이게 화면 밖이면 유저는 적어둔 게 서버에 있다고 믿은 채 감독시간을 놓친다. 처음 잡은
       * 320/44svh 는 입력칸은 넣고 이 줄을 18px 차이로 밀어냈다(1280×720 실측 b735 > 720).
       */
      const status = await box(page, "brief-save-status");
      expect(
        status.inViewport,
        `${vp.name}: 저장 상태 줄이 화면 밖 — bottom ${status.bottom} > ${status.vh}. 저장 버튼이 없는 화면에서 유일한 피드백이다`,
      ).toBe(true);
    });
  }

  /**
   * 자동 저장이 **실패했을 때** 그 사실이 실제로 보이나 — 상태 줄 자리만 잡혀 있고 실패 문구가
   * 밀려나면 화면은 타이핑 전과 완전히 같다("버튼 먹통"으로 읽힌 #294 와 같은 사고).
   * 세로가 가장 빡빡한 창에서 잰다.
   */
  test("저장 실패 안내가 화면 안에 뜬다 — 세로 짧은 데스크탑 창", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openMatch(page, "FIRST_HALF");
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/prompts") && route.request().method() === "POST") {
        return route.fulfill({ status: 500, json: { code: "INTERNAL", message: "서버 오류" } });
      }
      return route.fallback();
    });
    await page.getByTestId("stage-tab-brief").click();
    await page.getByTestId("brief-team-prompt").fill("후반은 라인 내리고 역습");
    await expect(page.getByTestId("brief-save-status")).toHaveAttribute("data-status", "error");

    const err = await box(page, "brief-error");
    expect(err.inViewport, `실패 안내가 화면 밖 — bottom ${err.bottom} > ${err.vh}`).toBe(true);
    expect(err.hitSelf, "실패 안내 중심을 다른 것이 받는다").toBe(true);
  });

  /**
   * 무대는 남는다(#169 AC-W1-1) — 그리고 **자기 행을 남김없이 쓴다**.
   *
   * ⚠️ `h > 160` 같은 절대 하한만으로는 부족하다(독립검증 MINOR-1): 데스크탑에서 무대 상한이
   * 잘못 걸리면(예: `.bodyInput .stage{max-height:38svh}` 의 `@media (max-width:1023px)` 래퍼를
   * 벗기면) 무대가 363 → 304px 로 눌리고 그 행에 위아래 30px 빈 띠가 생기는데, 하한 단언은
   * 그대로 통과한다. 그래서 **시트와의 관계**(무대 아래 빈 띠)로 잰다 — 자기 임계가 아니라
   * 레이아웃이 만족해야 하는 성질이다.
   */
  for (const vp of DESKTOP) {
    test(`${vp.name} — 무대가 남고, 자기 행에 빈 띠를 남기지 않는다 (#169 AC-W1-1)`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "FIRST_HALF");
      await page.getByTestId("stage-tab-brief").click();
      await expect(page.getByTestId("stage-panel-brief")).toHaveCount(1);

      const canvas = await box(page, "stage-canvas");
      const sheet = await box(page, "stage-sheet");
      expect(canvas.h, `${vp.name}: 무대가 사라지거나 실질적으로 0 이 되면 안 된다`).toBeGreaterThan(120);
      expect(canvas.y, `${vp.name}: 무대는 화면 안에서 시작한다`).toBeGreaterThanOrEqual(-1);
      expect(
        sheet.y - canvas.bottom,
        `${vp.name}: 무대와 시트 사이 빈 띠 ${sheet.y - canvas.bottom}px — 무대가 자기 행보다 작게 눌렸다`,
      ).toBeLessThanOrEqual(8);
    });
  }

  // ⚠️ 제목이 **전 탭**이라고 말하면 실제로 전 탭을 돌아야 한다 — `players`(#403)를 빠뜨린 채
  //    두면 이름이 사실과 어긋나고, 새 탭의 오버플로가 이 스윕을 조용히 비켜간다(독립검증 m3).
  test("문서 스크롤 0 · 시트 폭 ≤ 뷰포트 (데스크톱 전 비율, 전 탭)", async ({ page }) => {
    for (const vp of DESKTOP) {
      await page.setViewportSize(vp);
      await openMatch(page, "FIRST_HALF");
      for (const key of ["stats", "players", "log", "brief"]) {
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

/**
 * ⑤ **감독시간 — 넓고 낮은 창(데스크탑 분기 아래)** · #354
 *
 * ② 는 ≥1024 만 잰다. 그 분기 **아래**에서는 `HalftimePanel` 이 단일 컬럼이라 보드가 가로폭에
 * 비례해 세로로 자라고, 그 아래에 붙는 지시 레일(= `감독의 한마디` 입력칸)이 통째로 밀려났다.
 * 실측(수정 전): 1023×768 y955 · 1023×900 y1076 · 960×1040 y1028 · 853×533 y798(=1280×800@150%)
 * · 820×640 y778 · 768×900 y881 — **전부 화면 밖**이고 중심점 히트테스트 0.
 *
 * ⚠️ `후반 지시`(③)와 달리 **되찾을 빈 공간이 없다** — 감독시간 시트는 이미 세로를 100% 쓴다.
 * 그래서 값 조정이 아니라 **레이아웃**이 답이다: 보드 옆에 레일을 세워 입력칸이 보드 높이와
 * 무관해지게 한다(데스크탑이 이미 그렇게 동작한다 — 그 밴드를 넓힌 것).
 * 계약은 그 구현이 아니라 **성질**을 잰다: 입력칸이 보드 아래로 밀리지 않는다.
 */
test.describe("⑤ 감독시간 — 넓고 낮은 창(분기 아래)에서 입력칸이 화면 안", () => {
  for (const vp of WIDE_LOW) {
    test(`${vp.name} — 감독의 한마디 입력칸 · [후반 시작] 이 화면 안`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "HALFTIME");
      await expect(page.getByTestId("halftime-panel")).toHaveCount(1);

      const prompt = await box(page, "editor-team-prompt");
      expect(
        prompt.inViewport,
        `${vp.name}: 감독 한마디 입력칸이 화면 밖 — bottom ${prompt.bottom} > 뷰포트 ${prompt.vh}`,
      ).toBe(true);
      expect(prompt.hitSelf, `${vp.name}: 입력칸 중심을 다른 것이 받는다(덮였거나 잘렸다)`).toBe(true);
      expect(prompt.h, `${vp.name}: 입력칸이 한 줄로 찌그러지면 "보이긴 한다"가 성립해도 못 쓴다`).toBeGreaterThanOrEqual(60);

      const cta = await box(page, "resume-button");
      expect(cta.inViewport, `${vp.name}: [후반 시작] 이 화면 밖`).toBe(true);
      expect(cta.hitSelf, `${vp.name}: [후반 시작] 중심을 다른 것이 받는다`).toBe(true);

      /*
       * ⚠️ **자리를 만든다고 보드를 없애면 안 된다.** 감독시간의 다른 절반이 배치·교체이고
       * 그건 보드에서만 한다. 입력칸만 보는 계약이면 "보드 display:none" 이 통과한다.
       */
      const board = await box(page, "tactics-board");
      expect(board.h, `${vp.name}: 전술보드가 실질적으로 사라지면 안 된다`).toBeGreaterThan(120);
      expect(board.hitSelf, `${vp.name}: 전술보드 중심을 다른 것이 받는다`).toBe(true);
    });
  }
});

/**
 * ⑦ **2컬럼 임계 아래의 잔여 밴드** · #354 독립검증 MAJOR-1
 *
 * ⑤ 의 2컬럼은 컨테이너 640px = **뷰포트 688px** 부터 걸린다. 그 아래 폭(480~687)에서는 같은
 * 증상이 남아 있었다 — 640×800 b807/800 OUT · 673×900 b910/900 OUT · 687×768 b838/768 OUT ·
 * 600×800 은 뷰포트 안이지만 중심이 **[후반 시작] 에 피격**. 실사용에 있는 창들이다
 * (1280 모니터 반쪽 스냅 640 · Galaxy Z Fold 내부 673).
 *
 * 여긴 2컬럼으로 못 간다(레일을 빼면 보드가 234px 라 토큰 4열이 겹친다) → `TacticsBoard` 가 이미
 * 쓰는 "짧을수록 피치가 양보한다" 스텝을 감독시간 안에서 한 단계 더 쓰고, **세로 ≤720 인 창은
 * 비율이 아니라 높이 상한(190px)** 으로 자른다(비율을 더 내리면 넓은 쪽에 맞춘 값이 좁은 쪽을
 * 필요 이상으로 누른다).
 *
 * ⚠️ **480×800 은 결함 케이스가 아니라 하한 가드다** — 수정 전에도 in+hit 이었다(독립검증 확인).
 * 임계를 480 위로 올리면 여기서 죽는다. 결함이던 창은 나머지 5개 + 640×700 · 680×700 이다.
 * ⚠️ **미해소 = 폭 478~479 × 세로 ≤~709 (2px 짜리 띠)**. 그 폭의 실기기·스냅 폭이 없어 영향이
 * 사실상 0 이라 #380 에 기록만 했다. **`test.fail` 핀은 박지 않았다** — 기대실패는 "passed" 로
 * 집계돼 다음 사람을 속인다(CLAUDE.md 함정 1).
 */
test.describe("⑦ 2컬럼 임계 아래 — 보드가 양보해 입력칸이 살아난다", () => {
  for (const vp of [
    { name: "480x800", width: 480, height: 800 }, // 하한 가드(원래 정상)
    { name: "540x720", width: 540, height: 720 },
    { name: "600x800", width: 600, height: 800 },
    { name: "640x700", width: 640, height: 700 }, // 세로 짧은 창 — 높이 상한이 여기서 일한다
    { name: "640x800", width: 640, height: 800 }, // 1280 모니터 반쪽 스냅
    { name: "673x900", width: 673, height: 900 }, // Galaxy Z Fold 내부 화면
    { name: "680x700", width: 680, height: 700 },
    { name: "687x720", width: 687, height: 720 },
    { name: "687x768", width: 687, height: 768 }, // 2컬럼 임계 바로 아래
  ]) {
    test(`${vp.name} — 입력칸이 화면 안 + CTA 에 안 덮인다`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "HALFTIME");
      await expect(page.getByTestId("halftime-panel")).toHaveCount(1);

      const prompt = await box(page, "editor-team-prompt");
      expect(prompt.inViewport, `${vp.name}: 입력칸 bottom ${prompt.bottom} > 뷰포트 ${prompt.vh}`).toBe(true);
      /*
       * ⚠️ 이 밴드의 실제 실패 양상은 "뷰포트 밖"이 아니라 **[후반 시작] 에 덮임**이었다
       * (600×800 b781 은 뷰포트 안인데 중심 히트가 `resume-button`). 좌표만 재면 통과한다.
       */
      expect(prompt.hitSelf, `${vp.name}: 입력칸 중심을 다른 것이 받는다([후반 시작]에 덮였을 가능성)`).toBe(true);

      // 자리를 만든다고 보드를 없애지 않았다 — 배치·교체가 여기서만 가능하다.
      const board = await box(page, "tactics-board");
      expect(board.h, `${vp.name}: 전술보드가 실질적으로 사라지면 안 된다`).toBeGreaterThan(120);
      expect(board.hitSelf, `${vp.name}: 전술보드 중심을 다른 것이 받는다`).toBe(true);
    });
  }

  /** 폰과 그 바로 위(479)는 규칙이 안 걸린다 — 보드 비율이 그대로여야 한다. */
  test("폰·479 이하는 이 스텝이 안 걸린다 (무회귀)", async ({ page }) => {
    for (const vp of [
      { name: "390x844", width: 390, height: 844 },
      { name: "360x740", width: 360, height: 740 },
      { name: "412x915", width: 412, height: 915 },
    ]) {
      await page.setViewportSize(vp);
      await openMatch(page, "HALFTIME");
      await expect(page.getByTestId("halftime-panel")).toHaveCount(1);
      const board = await box(page, "tactics-board");
      const prompt = await box(page, "editor-team-prompt");
      expect(prompt.inViewport, `${vp.name}: 폰 입력칸이 화면 밖`).toBe(true);
      expect(prompt.hitSelf, `${vp.name}: 폰 입력칸이 덮였다`).toBe(true);
      /*
       * 폰 피치는 `TacticsBoard` 의 기존 스텝(68/52 · 68/44 · 68/40)만 받는다 — 480 이상에만 거는
       * 새 스텝(68/30)이 새 나가면 이 하한이 죽는다. 68/40 → w/h = 1.70, 68/30 → 2.27.
       */
      expect(
        board.w / board.h,
        `${vp.name}: 폰 보드가 새 스텝(68/30 = 2.27)까지 눌렸다 — 실측 ${(board.w / board.h).toFixed(2)}`,
      ).toBeLessThan(2.0);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
});

/**
 * ⑥ **결과 화면 [로비로] CTA** · #355
 *
 * 뿌리는 #348 과 같다(`.sheetState` 고정 높이)지만 **모든** 데스크탑 비율에서 깨져 있었다 —
 * 3440×1440 에서도 CTA bottom 1576 > 1440. "화면이 크면 괜찮다"는 예외가 여기엔 없다.
 *
 * ⚠️ **높이를 키우는 것만으로는 못 고친다.** 결과 패널 내용에는 상한이 없다 —
 * `GrowthReportSection` 이 기용 선수 수만큼 행을 붙인다(11명이면 수백 px). 그래서 계약을
 * **두 축**으로 건다: ⓐ 성장 리포트가 있든 없든 CTA 가 화면 안 ⓑ 패널을 끝까지 스크롤해도
 * CTA 가 **움직이지 않는다**(= 스크롤 밖 고정층에 산다). ⓑ 가 없으면 "시트를 조금 키웠다"가
 * 통과하고, 다음에 결과 카드에 줄 하나가 붙는 순간 같은 결함이 이름만 바꿔 돌아온다.
 */
test.describe("⑥ 결과 화면 — [로비로] 가 어느 데스크탑 비율에서도 화면 안", () => {
  for (const vp of DESKTOP) {
    test(`${vp.name} — [로비로] · 결과 카드가 화면 안`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "FINISHED");
      await expect(page.getByTestId("result-page")).toHaveCount(1);

      const cta = await box(page, "to-lobby");
      expect(
        cta.inViewport,
        `${vp.name}: [로비로] 가 화면 밖 — bottom ${cta.bottom} > 뷰포트 ${cta.vh}`,
      ).toBe(true);
      expect(cta.hitSelf, `${vp.name}: [로비로] 중심을 다른 것이 받는다`).toBe(true);

      // 스코어(이 화면에 온 이유)는 스크롤 없이 보인다.
      const score = await box(page, "final-score");
      expect(score.inViewport, `${vp.name}: 최종 스코어가 화면 밖 — bottom ${score.bottom}`).toBe(true);
      expect(score.hitSelf, `${vp.name}: 최종 스코어 중심을 다른 것이 받는다`).toBe(true);

      /*
       * 결과 카드는 **통째로** 보인다 — 승패·스코어·보상이 한 덩어리라 잘리면 "얼마 받았지"가 남는다.
       * (`reward-daily` 는 #368 리그 보상 칸 — 카드의 마지막 줄이다.)
       */
      const reward = await box(page, "reward-daily");
      expect(
        reward.inViewport,
        `${vp.name}: 결과 카드 마지막 줄(오늘의 보상)이 잘렸다 — bottom ${reward.bottom} > ${reward.vh}`,
      ).toBe(true);

      /*
       * **다음 섹션의 시작까지 보인다** — 스코어 카드 하나만 뜨면 "이게 전부"로 읽혀 아무도
       * 스크롤하지 않는다(#348 이 배운 것: "스크롤하면 닿는다"는 변론이 못 된다).
       * `sheetHeight("result")` 등급이 사는 이유가 정확히 이것이다 — 등급을 `state`(40svh)로
       * 되돌리면 1024×768 · 1280×720 · 1280×800 에서 이 단언이 죽는다(변이 주입으로 확인).
       *
       * ⚠️ 세로 ≤ 700 창(1024×640 · 1280×600 · 1440×560)은 **제외**한다 — 시트를 아무리 키워도
       * 무대가 남지 않아 구조적으로 불가능하다. 못 지키는 것을 계약에 적으면 다음 사람이 무대를
       * 죽이는 방향으로 고치게 된다. 그 창에서도 위 CTA·결과 카드 단언은 그대로 걸린다.
       */
      if (vp.height >= 700) {
        const statsTopVisible = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="team-stats"]') as HTMLElement | null;
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.top + 6 >= window.innerHeight) return false;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 6);
          return !!hit && (hit === el || el.contains(hit));
        });
        expect(
          statsTopVisible,
          `${vp.name}: 결과 카드 아래 팀 스탯의 시작조차 안 보인다 — 이 화면이 "스코어 카드 하나"로 읽힌다`,
        ).toBe(true);
      }
    });
  }

  /**
   * ⑥-b **다음 경기 CTA 가 그려지는 모드**(#456 B5) — 이 대역이 통째로 비어 있었다.
   *
   * 위 ⑥ 의 목은 `mode` 를 안 실어 CTA 가 **렌더되지 않는다**. 그래서 리그·원정에서 바닥 버튼이
   * 하나 더 생겨 `.scroll` 이 62px 줄어든 것을 **아무도 재지 않았고**, `p348`+`p403`+`p456`
   * 126건이 전부 green 인 채로 1024×768 · 1280×720 에서 팀 스탯 머리가 잘려 있었다
   * (독립검증 blocker-1 실측: statsTop 잔량 4px / 0px).
   *
   * ⚠️ **단언은 ⑥ 과 같은 것을 쓴다** — 새 임계를 만들면 두 대역이 서로 다른 약속을 하게 된다.
   * 여기서 재는 것은 "CTA 가 늘어도 그 약속이 그대로인가" 하나다.
   * ⚠️ 전 비율 스윕은 **리그만** 돈다 — 이 축의 변수는 **바닥 버튼 개수**이지 라벨이 아니라
   * 원정은 같은 지오메트리다(가장 빠듯한 비율에서 한 점만 대조로 확인한다).
   */
  const CTA_MODE_VIEWPORTS = DESKTOP.filter((v) => v.height >= 700);

  for (const vp of CTA_MODE_VIEWPORTS) {
    test(`⑥-b ${vp.name} — 리그(다음 경기 CTA)에서도 팀 스탯의 시작이 보인다`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "FINISHED", false, "league");
      await expect(page.getByTestId("result-page")).toHaveCount(1);
      // 전제: 이 팔은 CTA 가 **실제로** 그려져야 의미가 있다(안 그려지면 ⑥ 과 같은 화면이다).
      await expect(page.getByTestId("result-next-cta")).toHaveCount(1);

      const cta = await box(page, "to-lobby");
      expect(cta.inViewport, `${vp.name}: [로비로] 가 화면 밖 — bottom ${cta.bottom} > ${cta.vh}`).toBe(true);
      expect(cta.hitSelf, `${vp.name}: [로비로] 중심을 다른 것이 받는다`).toBe(true);

      const next = await box(page, "result-next-cta");
      expect(next.inViewport, `${vp.name}: 다음 경기 CTA 가 화면 밖 — bottom ${next.bottom}`).toBe(true);
      expect(next.hitSelf, `${vp.name}: 다음 경기 CTA 중심을 다른 것이 받는다`).toBe(true);

      const reward = await box(page, "reward-daily");
      expect(
        reward.inViewport,
        `${vp.name}: 결과 카드 마지막 줄이 잘렸다 — bottom ${reward.bottom} > ${reward.vh}`,
      ).toBe(true);

      const statsTopVisible = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="team-stats"]') as HTMLElement | null;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.top + 6 >= window.innerHeight) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 6);
        return !!hit && (hit === el || el.contains(hit));
      });
      expect(
        statsTopVisible,
        `${vp.name}: 다음 경기 CTA 가 생기자 팀 스탯의 시작이 잘렸다 — 이 화면이 "스코어 카드 하나"로 읽힌다`,
      ).toBe(true);
    });
  }

  test("⑥-b 원정도 같은 지오메트리다 — 가장 빠듯한 비율 한 점 대조 (1280×720)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openMatch(page, "FINISHED", false, "away");
    await expect(page.getByTestId("result-next-cta")).toHaveText("다음 원정 떠나기");
    const statsTopVisible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="team-stats"]') as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.top + 6 >= window.innerHeight) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 6);
      return !!hit && (hit === el || el.contains(hit));
    });
    expect(statsTopVisible, "원정 CTA 에서 팀 스탯의 시작이 잘렸다").toBe(true);
  });

  test("성장 리포트가 붙어도(내용 상한 없음) CTA 는 화면 안 — 1280×800", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMatch(page, "FINISHED", true);
    await expect(page.getByTestId("growth-report")).toHaveCount(1);

    const cta = await box(page, "to-lobby");
    expect(cta.inViewport, `성장 리포트 11행에서 CTA bottom ${cta.bottom} > ${cta.vh}`).toBe(true);
    expect(cta.hitSelf, "성장 리포트가 CTA 를 덮는다").toBe(true);
  });

  /**
   * CTA 는 **스크롤 밖**에 산다 — 패널을 끝까지 굴려도 자리가 그대로다.
   * (높이 튜닝으로만 고친 구현을 죽이는 축. 실제로 그 구현은 스크롤하면 CTA 가 따라 올라간다.)
   */
  test("패널을 끝까지 스크롤해도 CTA 자리가 그대로다 (스크롤 밖 고정층)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMatch(page, "FINISHED", true);
    const before = await box(page, "to-lobby");

    /*
     * 스크롤러가 **어디에 있든** 끝까지 굴린다 — 자손(고쳐진 모양)이든 조상(고치기 전 모양,
     * 시트 패널이 스크롤을 소유하고 CTA 가 그 안에 있었다)이든. 그래서 이 단언은 구현이 아니라
     * 성질을 잰다: 조상이 스크롤러면 CTA 가 같이 올라가 **죽는다**.
     */
    const scrolled = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="result-page"]') as HTMLElement | null;
      if (!root) return -1;
      const candidates: HTMLElement[] = [
        ...Array.from(root.querySelectorAll<HTMLElement>("*")),
        ...(function up(node: HTMLElement | null, acc: HTMLElement[] = []): HTMLElement[] {
          return node ? up(node.parentElement, [...acc, node]) : acc;
        })(root),
      ];
      for (const node of candidates) {
        if (node.scrollHeight - node.clientHeight > 8) {
          node.scrollTop = node.scrollHeight;
          if (node.scrollTop > 8) return node.scrollTop;
        }
      }
      return -1;
    });
    expect(scrolled, "결과 패널에 스크롤 영역이 없다 — 이 계약이 공허해진다").toBeGreaterThan(8);
    await page.waitForTimeout(120);

    const after = await box(page, "to-lobby");
    expect(Math.abs(after.y - before.y), `스크롤 후 CTA 가 ${after.y - before.y}px 움직였다`).toBeLessThanOrEqual(1);
    expect(after.inViewport, "스크롤 끝에서 CTA 가 화면 밖").toBe(true);
    expect(after.hitSelf, "스크롤 끝에서 CTA 중심을 다른 것이 받는다").toBe(true);
  });

  /**
   * CTA 는 **자기 높이만** 쓴다 — 스크롤 영역의 몫을 먹지 않는다(독립검증 MINOR-2).
   * `.toLobby { flex: none }` 을 `flex: 1 1 auto` 로 되돌리면 버튼이 52 → **175px** 로 부풀어
   * 읽을 자리를 삼키는데, 위 단언들은 전부 통과한다(CTA 는 여전히 화면 안이라서). 그 변이를
   * 죽이는 건 이 계약뿐이다 — **CTA 는 문이지 콘텐츠가 아니다.**
   */
  test("CTA 가 스크롤 영역의 몫을 먹지 않는다 (flex:none)", async ({ page }) => {
    for (const vp of [
      { name: "1280x800", width: 1280, height: 800 },
      { name: "1920x1080", width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(vp);
      await openMatch(page, "FINISHED");
      await expect(page.getByTestId("result-page")).toHaveCount(1);
      const cta = await box(page, "to-lobby");
      const sheet = await box(page, "stage-sheet");
      expect(cta.h, `${vp.name}: CTA 높이 ${cta.h}px — 버튼 한 줄보다 커졌다(스크롤 몫을 먹는다)`).toBeLessThanOrEqual(90);
      expect(
        cta.h / sheet.h,
        `${vp.name}: CTA 가 시트의 ${Math.round((cta.h / sheet.h) * 100)}% 를 차지한다`,
      ).toBeLessThan(0.25);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("문서 스크롤 0 — 결과 탭(데스크톱 전 비율)", async ({ page }) => {
    for (const vp of DESKTOP) {
      await page.setViewportSize(vp);
      await openMatch(page, "FINISHED");
      await expect(page.getByTestId("result-page")).toHaveCount(1);
      const s = await pageScroll(page);
      expect(s.v, `${vp.name}: 문서 세로 스크롤 0`).toBeLessThanOrEqual(1);
      expect(s.h, `${vp.name}: 가로 오버플로 0`).toBeLessThanOrEqual(1);
    }
  });
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

  /**
   * #354 는 폰을 **단일 컬럼으로 남긴다** — 390px 에서 보드 옆에 레일을 세우면 둘 다 못 쓴다.
   * 그래서 폰의 성질은 "입력칸이 보드 옆"이 아니라 **보드가 짧아 입력칸이 스크롤 0 에서 보인다**
   * (#244 AC1). 그 성질을 여기서 붙잡아 둔다 — 2컬럼 전환 임계를 잘못 내리면 여기서 죽는다.
   */
  test("390×844 감독시간 — 보드는 단일 컬럼이고 입력칸이 그 아래에서 보인다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMatch(page, "HALFTIME");
    await expect(page.getByTestId("halftime-panel")).toHaveCount(1);

    const board = await box(page, "tactics-board");
    const prompt = await box(page, "editor-team-prompt");
    expect(prompt.inViewport, `폰 입력칸 bottom ${prompt.bottom} > ${prompt.vh}`).toBe(true);
    expect(prompt.hitSelf).toBe(true);
    // 단일 컬럼 = 입력칸이 보드 **아래**에 온다(옆이 아니다).
    expect(prompt.y, "폰에서는 보드 아래에 입력칸이 온다").toBeGreaterThanOrEqual(board.bottom - 1);
  });

  /** #355 무회귀 — 폰 결과 화면에서도 [로비로] 가 화면 안에 있고 스크롤 밖에 고정이다. */
  test("390×844 결과 — [로비로] 가 화면 안", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMatch(page, "FINISHED", true);
    const cta = await box(page, "to-lobby");
    expect(cta.inViewport, `폰 [로비로] bottom ${cta.bottom} > ${cta.vh}`).toBe(true);
    expect(cta.hitSelf).toBe(true);
  });
});

/**
 * ⑧ **피치가 실제로 얼마나 그려지나** — #456 S2-R1(독립검증 major-1).
 *
 * ⚠️ 이 파일은 18개 뷰포트를 돌면서 **캔버스·피치 크기를 한 번도 재지 않았다**(grep 0건).
 * 그래서 #456 B0 이 컨트롤을 무대 행 안으로 들이며 **세로가 상한/`1fr` 에 걸리는 모든 창에서**
 * 피치가 컨트롤 높이만큼 줄어든 것을 이 스윕이 전혀 못 봤다(실측 1280×800 −16% · 844×390 −38%).
 * 커밋 본문이 *"컨트롤이 먹는 만큼 시트가 양보하므로 피치는 줄지 않는다"* 라고 **일반 명제**로
 * 적혀 있었는데, 그건 **폰 세로에서만 참**이다 — 데스크탑 시트는 고정 높이라 양보하지 않는다.
 *
 * 그래서 두 축을 건다:
 *  ⓐ **컨트롤 층이 무대 행에서 가져가는 몫의 상한** — 성질이지 튜닝값이 아니다. 이 층은 예전에
 *    토글·스킵이 쌓이며 130px 띠로 자란 전례가 있고(#406 W10 M-1), 그때는 오버레이라 피치를
 *    덮었지만 지금은 **피치를 깎는다**. 줄이 하나 더 쌓이면 여기서 죽는다.
 *  ⓑ **피치 실그림 높이의 회귀선** — `object-fit: contain` 기준으로 실제 그려지는 크기다
 *    (캔버스 박스는 레터박스를 포함해 부풀 수 있어 박스만 재면 축소를 놓친다).
 *    ⚠️ 이 숫자들은 **설계 목표가 아니라 지금 실측치**다(S2-R1 착지 시점, −2px 여유).
 *    시트 높이 등급(#348/#355)이나 컨트롤 구성이 바뀌면 같이 갱신하되, **내리려면 근거를 적어라** —
 *    이 축이 없던 동안 −38% 가 조용히 지나갔다.
 */
test.describe("⑧ 피치 실그림 크기 — 컨트롤이 무대 행에 들어와도 회귀하지 않는다 (#456)", () => {
  /** S2-R1 착지 시점 실측(−2px). 폰 세로만 두 줄 컨트롤이라 상한이 다르다. */
  const PITCH_FLOOR: Record<string, { h: number; ctlMax: number }> = {
    "1024x768": { h: 431, ctlMax: 56 },
    "1024x640": { h: 333, ctlMax: 56 },
    "1280x600": { h: 293, ctlMax: 56 },
    "1280x720": { h: 396, ctlMax: 56 },
    "1280x800": { h: 455, ctlMax: 56 },
    "1440x560": { h: 253, ctlMax: 56 },
    "1440x900": { h: 529, ctlMax: 56 },
    "1512x945": { h: 562, ctlMax: 56 },
    "1680x1050": { h: 640, ctlMax: 56 },
    "1920x1080": { h: 662, ctlMax: 56 },
    "3440x1440": { h: 963, ctlMax: 56 },
    "1023x768": { h: 393, ctlMax: 56 },
    "1023x900": { h: 470, ctlMax: 56 },
    "960x1040": { h: 551, ctlMax: 56 },
    "900x800": { h: 412, ctlMax: 56 },
    "853x533": { h: 257, ctlMax: 56 },
    "820x640": { h: 319, ctlMax: 56 },
    "768x900": { h: 470, ctlMax: 56 },
    // 폰 가로 — B0 이 가장 크게 깎은 자리다(226 → 140 → S2-R1 176).
    "844x390": { h: 174, ctlMax: 56 },
    // 폰 세로 = hero 가 본 화면. 여기만 시트가 양보해 **B0 전과 같다**(252.57px).
    "390x844": { h: 251, ctlMax: 92 },
    // 작은 폰(세로 568) — `match-stage i` 의 절대선 252 는 390×844 **한 점**의 값이라 이 창을
    // 못 봤다(독립검증 minor-2). ⚠️ 여기는 세로가 짧아 컨트롤이 한 줄로 접히고(위 CSS 임계
    // `max-height: 720`), 그 덕에 피치가 폰 세로와 **같은 253px** 다 — S2 착지 시점엔 243 이었다.
    "390x568": { h: 251, ctlMax: 56 },
  };

  for (const vp of [
    ...DESKTOP,
    ...WIDE_LOW,
    { name: "844x390", width: 844, height: 390 },
    { name: "390x844", width: 390, height: 844 },
    { name: "390x568", width: 390, height: 568 },
  ]) {
    test(`${vp.name} — 피치가 컨트롤에 깎이지 않는다`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openMatch(page, "FIRST_HALF");
      await page.waitForSelector('[data-testid^="viewer-canvas-half"]');

      const m = await page.evaluate(() => {
        const c = document.querySelector('[data-testid^="viewer-canvas-half"]') as HTMLElement | null;
        const ctl = document.querySelector("[data-p406-controls]") as HTMLElement | null;
        if (!c) return null;
        const r = c.getBoundingClientRect();
        // 캔버스 backing 은 1050×680 이고 `object-fit: contain` 이라 실그림은 그 비율로 갇힌다.
        const s = Math.min(r.width / 1050, r.height / 680);
        return {
          drawH: Math.round(680 * s),
          drawW: Math.round(1050 * s),
          ctlH: ctl ? Math.round(ctl.getBoundingClientRect().height) : 0,
        };
      });
      expect(m, "캔버스가 없다").not.toBeNull();

      const want = PITCH_FLOOR[vp.name];
      expect(want, `${vp.name}: 기준선이 표에 없다 — 뷰포트를 추가했으면 실측해서 같이 적어라`).toBeTruthy();

      expect(
        m!.ctlH,
        `${vp.name}: 컨트롤 층이 ${m!.ctlH}px — 줄이 더 쌓이면 그만큼 피치가 깎인다`,
      ).toBeLessThanOrEqual(want.ctlMax);
      expect(
        m!.drawH,
        `${vp.name}: 피치 실그림 ${m!.drawW}×${m!.drawH} (기준선 높이 ${want.h})`,
      ).toBeGreaterThanOrEqual(want.h);
    });
  }
});
