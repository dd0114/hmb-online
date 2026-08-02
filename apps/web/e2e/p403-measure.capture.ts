import { test } from "@playwright/test";
import { MATCH_ID, mockApi } from "./p403-mocks";

/**
 * #403 W2 — **시트 등급 값 실측 하네스**(계약 아님, `.capture.ts` 라 기본 실행에서 빠진다).
 *
 * ⚠️ **목 구성이 수치를 바꾼다**(독립검증 A-2). 예전 이 파일은 자기 목을 따로 적었고 `mode` 가
 * 없어 스코어바가 19px 짧았다 → 무대 수치가 낙관적으로 나왔다. 이제 **계약과 같은 목**
 * (`p403-mocks.mockApi`, `mode:"league"`)을 쓰고 **상태별로** 잰다 — 스코어바 높이가 상태마다
 * 다르기 때문이다(FIRST_HALF 는 `후반 지시` 탭까지 있어 더 두껍다).
 *
 * 실행: 파일을 `*.spec.ts` 로 복사해 1회 실행(`CI=1 WEB_E2E_PORT=51xx npx playwright test …`).
 */

const VPS = [
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1024x640", width: 1024, height: 640 },
  { name: "1280x600", width: 1280, height: 600 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1440x560", width: 1440, height: 560 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "3440x1440", width: 3440, height: 1440 },
  { name: "390x844(폰)", width: 390, height: 844 },
];

for (const state of ["SECOND_HALF", "FIRST_HALF"]) {
test(`선수 탭 지오메트리 실측 — ${state}`, async ({ page }) => {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });

  for (const vp of VPS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/match/${MATCH_ID}`);
    await page.getByTestId("stage-tab-players").click();
    await page.waitForSelector("[data-testid^='players-row-away-']");
    const m = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement | null;
      const sheet = q('[data-testid="stage-sheet"]')!;
      const panel = sheet.querySelector("div:not([role])")!.parentElement!;
      const tabs = q('[role="tablist"]')!;
      const seg = q('[data-testid="players-teams"]')!;
      const cap = q('[data-testid="players-live-caption"]');
      const sort = q('[data-testid="players-sort"]')!;
      const thead = document.querySelector("[data-testid='players-table'] thead") as HTMLElement;
      const rows = Array.from(document.querySelectorAll("[data-testid^='players-row-away-']")) as HTMLElement[];
      const body = q('[data-testid="stage-panel-players"]')!;
      const canvas = q('[data-testid="stage-canvas"]')!;
      const r = (e: HTMLElement | null) => (e ? Math.round(e.getBoundingClientRect().height) : 0);
      const visible = rows.filter((x) => x.getBoundingClientRect().bottom <= window.innerHeight + 1).length;
      return {
        vh: window.innerHeight,
        sheet: r(sheet),
        tabs: r(tabs),
        seg: r(seg),
        cap: r(cap),
        sort: r(sort),
        thead: r(thead),
        row: r(rows[0] ?? null),
        rows: rows.length,
        visibleRows: visible,
        content: r(body),
        canvas: r(canvas),
        panelH: Math.round(body.parentElement!.getBoundingClientRect().height),
      };
    });
    // eslint-disable-next-line no-console
    console.log(
      `[${state}] ${vp.name.padEnd(14)} sheet=${String(m.sheet).padStart(4)} 패널=${m.panelH} ` +
        `크롬(세그${m.seg}+캡${m.cap}+칩${m.sort}+머리${m.thead}) 행h=${m.row} ` +
        `**화면안 행=${m.visibleRows}** 무대=${m.canvas}`,
    );
  }
});
}
