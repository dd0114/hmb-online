import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";

/**
 * #323 — **홈 헤더 자리 부족** 실화면 비교(hero 컨펌용 증빙, 계약 아님).
 *
 * <p>390px 실측 폭 예산(내부 폭 362px):
 * <pre>
 *   왼쪽  닉네임 60 + 공지 28 + 우편 28 + gap 12 = 128
 *   오른쪽 지갑칩 102 × 2 + [로그아웃] 62 + gap    = 272
 *   합계 128 + 272 + 8 = 408  →  **46px 초과**
 * </pre>
 * 우편 진입점을 넣기 **전에도 12px 초과**였고, 그 몫을 닉네임이 혼자 흡수해 43px 로 눌려 있었다.
 * 그래서 이건 우편함이 만든 문제가 아니라 우편함이 **드러낸** 문제다.
 *
 * <p>각 안을 실제 홈 화면에 적용해 찍는다(목업 아님 — 같은 컴포넌트·같은 CSS).
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const MAILS = [
  {
    id: "M1",
    title: "v3.02 패치 보상",
    body: "보상을 첨부하니 받아 주세요.",
    attachments: { points: 5000, gems: 10, players: [] },
    sentAt: "2026-07-30T00:00:00Z",
    expiresAt: null,
    readAt: null,
    claimedAt: null,
    state: "UNREAD",
  },
];

test("#323 헤더 3안 비교 캡처 (390px)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  await page.route((u) => u.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((u) => u.pathname === "/api/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", nickname: "감독 박", tutorialDone: true },
        wallet: { points: 24300, gems: 1240 },
        records: { wins: 12, draws: 3, losses: 8 },
        rating: 1180,
        league: { division: 5, divisionName: "브론즈 D5" },
        mail: { unread: 2, total: MAILS.length },
      }),
    ),
  );
  await page.route((u) => u.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((u) => u.pathname === "/api/notices/active", (r) =>
    r.fulfill(json({ notices: [{ id: "N1", revision: 1, title: "점검 안내", body: "본문", priority: 0 }] })),
  );
  await page.route((u) => u.pathname === "/api/players", (r) => r.fulfill(json([])));
  await page.route((u) => u.pathname === "/api/mails", (r) =>
    r.fulfill(json({ mails: MAILS, unread: 2 })),
  );

  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();
  await page.getByTestId("notice-close").click();
  await expect(page.getByTestId("notice-popup")).toHaveCount(0);

  const header = () => page.locator("header");

  // 0. **닉네임이 있던 시절**의 겹침 — 이 캡처가 §5 의 근거다.
  //
  // ⚠️ 닉네임은 이미 제거됐으므로(hero 확정) 그냥 찍으면 A안과 **바이트 동일**한 그림이 나온다 —
  //    실제로 2차 독립검증이 "인용된 증거가 현 트리에서 재현 불가"(m8)로 잡았다. 그래서 여기서
  //    닉네임을 **다시 넣어** 문제 상태를 재현한다. 이건 목업이 아니라 제거 전 마크업 그대로다.
  const nickBack = await page.addStyleTag({
    content: `header [class*="headerLeft"]::before {
      content: "감독 박"; font-size: 15px; font-weight: 700; white-space: nowrap;
      min-width: 4em; color: var(--text);
    }`,
  });
  await header().screenshot({ path: `${OUT}p323-opt0-now.png` });
  await nickBack.evaluate((el) => el.remove());

  // D. 전부 유지하고 **두 줄 허용** — 무엇도 지우지 않는 대신 헤더가 한 줄 더 차지한다.
  const wrapStyle = await page.addStyleTag({
    content: `header [class*="headerRow"] { flex-wrap: wrap !important; }`,
  });
  await header().screenshot({ path: `${OUT}p323-optD-wrap.png` });
  await wrapStyle.evaluate((el) => el.remove());

  // A. 닉네임 제거 — 바로 아래 팀 카드가 "감독 박의 팀"으로 이미 이름을 말한다.
  await page.addStyleTag({ content: `header [class*="nickname"] { display: none !important; }` });
  await header().screenshot({ path: `${OUT}p323-optA-no-nickname.png` });
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
    if (s.textContent?.includes("nickname")) s.remove();
  }));

  // B. [로그아웃] 아이콘화 — 텍스트 62px → 28px.
  await page.addStyleTag({
    content: `
      header button[class*="logout"] { font-size: 0 !important; padding: 5px 7px !important; }
      header button[class*="logout"]::after { content: "⏻"; font-size: 13px; }
    `,
  });
  await header().screenshot({ path: `${OUT}p323-optB-logout-icon.png` });
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
    if (s.textContent?.includes("logout")) s.remove();
  }));

  // C. 지갑 칩 축약(1,000 단위 K 표기) — 칩 하나 102px → 약 68px.
  await page.addStyleTag({
    content: `header [class*="badge"], header [class*="chip"] { font-size: 10px !important; padding: 3px 6px !important; }`,
  });
  await page.evaluate(() => {
    document.querySelectorAll("header [data-amount]").forEach((el) => {
      const v = Number((el as HTMLElement).dataset.amount ?? "0");
      const short = v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
      (el as HTMLElement).textContent = `${short} ${(el as HTMLElement).dataset.currency === "GEM" ? "Z" : "G"}`;
    });
  });
  await header().screenshot({ path: `${OUT}p323-optC-short-wallet.png` });
});
