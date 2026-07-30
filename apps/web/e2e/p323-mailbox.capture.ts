import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";

/**
 * #323 우편함 실화면 캡처 — 390px 실규격.
 *
 * <p>계약이 아니라 <b>증빙</b>이다(캡처 설정은 `*.capture.ts` 만 돌아 판정 게이트에 섞이지 않는다):
 * 헤더 진입점 두 개(공지 · 우편)가 겹치거나 잘리지 않는지, 목록에서 안 읽음/받기/수령 완료/만료가
 * 한눈에 구별되는지를 <b>사람이 눈으로</b> 본다(좌표 추론 금지, 루트 §2-2).
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
    body: "리그 승급 판정 오류로 불편을 드려 죄송합니다. 보상을 첨부하니 받아 주세요.",
    attachments: { points: 5000, gems: 10, players: [{ playerId: "P001", count: 1 }] },
    sentAt: "2026-07-30T00:00:00Z",
    expiresAt: "2026-08-13T00:00:00Z",
    readAt: null,
    claimedAt: null,
    state: "UNREAD",
  },
  {
    id: "M2",
    title: "오픈베타 참여 감사",
    body: "오픈베타에 참여해 주셔서 감사합니다. 작은 선물을 보냅니다.",
    attachments: { points: 0, gems: 30, players: [] },
    sentAt: "2026-07-29T00:00:00Z",
    expiresAt: null,
    readAt: "2026-07-29T01:00:00Z",
    claimedAt: null,
    state: "READ",
  },
  {
    id: "M3",
    title: "[안내] 주말 점검 완료",
    body: "주말 점검이 완료되었습니다. 이용에 불편을 드려 죄송합니다.",
    attachments: { points: 1000, gems: 0, players: [] },
    sentAt: "2026-07-27T00:00:00Z",
    expiresAt: null,
    readAt: "2026-07-27T01:00:00Z",
    claimedAt: "2026-07-27T02:00:00Z",
    state: "CLAIMED",
  },
  {
    id: "M4",
    title: "신규 감독 환영 선물",
    body: "HMB 온라인에 오신 것을 환영합니다. 첫 덱 구성에 보태 쓰세요.",
    attachments: { points: 3000, gems: 0, players: [] },
    sentAt: "2026-07-09T00:00:00Z",
    expiresAt: "2026-07-16T00:00:00Z",
    readAt: "2026-07-09T01:00:00Z",
    claimedAt: null,
    state: "EXPIRED",
  },
];

test("#323 캡처: 홈 헤더 우편함 + 목록 + 상세 (390px)", async ({ page }) => {
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
        mail: { unread: 2 },
      }),
    ),
  );
  await page.route((u) => u.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((u) => u.pathname === "/api/notices/active", (r) =>
    r.fulfill(json({ notices: [{ id: "N1", revision: 1, title: "점검 안내", body: "본문", priority: 0 }] })),
  );
  await page.route((u) => u.pathname === "/api/players", (r) =>
    r.fulfill(json([{ id: "P001", name: "카밀 프란체스코", grade: "DIA", position: "FW", owned: true }])),
  );
  await page.route((u) => u.pathname === "/api/mails", (r) =>
    r.fulfill(json({ mails: MAILS, unread: 2 })),
  );

  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();
  // 공지 팝업이 홈을 덮는다 — 헤더를 보려면 먼저 치운다(공지 자체는 벨로 남는다).
  await page.getByTestId("notice-close").click();
  await expect(page.getByTestId("notice-popup")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}p323-home-header.png` });

  // 헤더 폭 실측 — 우편 진입점이 닉네임을 얼마나 밀어내는지(있을 때 / 없을 때).
  const withMail = await page.evaluate(() => {
    const nick = document.querySelector('header [class*="nickname"]') as HTMLElement | null;
    return { nick: Math.round(nick?.getBoundingClientRect().width ?? 0),
             header: Math.round(document.querySelector("header")!.getBoundingClientRect().height) };
  });
  const withoutMail = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="mail-center-open"]') as HTMLElement | null;
    if (btn) btn.style.display = "none";
    const nick = document.querySelector('header [class*="nickname"]') as HTMLElement | null;
    const out = { nick: Math.round(nick?.getBoundingClientRect().width ?? 0),
                  header: Math.round(document.querySelector("header")!.getBoundingClientRect().height) };
    if (btn) btn.style.display = "";
    return out;
  });
  console.log(`[p323] nickname width  with=${withMail.nick}px  without=${withoutMail.nick}px`);
  console.log(`[p323] header height   with=${withMail.header}px  without=${withoutMail.header}px`);
  const parts = await page.evaluate(() => {
    const w = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? Math.round(el.getBoundingClientRect().width) : -1;
    };
    return {
      nickname: w('header [class*="nickname"]'),
      notice: w('[data-testid="notice-center-open"]'),
      mail: w('[data-testid="mail-center-open"]'),
      wallet: w('header [class*="PointsBadge"], header [class*="badge"]'),
      logout: w('header button[class*="logout"]'),
      right: w('header [class*="headerRight"]'),
      left: w('header [class*="headerLeft"]'),
    };
  });
  console.log(`[p323] parts = ${JSON.stringify(parts)}`);

  await page.getByTestId("mail-center-open").click();
  await expect(page.getByTestId("mail-center")).toBeVisible();
  await page.screenshot({ path: `${OUT}p323-mail-list.png` });

  await page.getByTestId("mail-item").first().locator("button").first().click();
  await expect(page.getByTestId("mail-claim")).toBeVisible();
  await page.screenshot({ path: `${OUT}p323-mail-detail.png` });

  // 만료 행 — [받기]가 잠긴 모습까지 눈으로 남긴다.
  await page.locator('[data-testid="mail-item"][data-state="EXPIRED"] button').first().click();
  await page.screenshot({ path: `${OUT}p323-mail-expired.png` });
});
