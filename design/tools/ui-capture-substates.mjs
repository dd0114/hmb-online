// 2차 캡처 — 1차에서 셀렉터로 놓친 서브상태(가챠·선수시트·피커·프리셋·마킹·트레이드 OPEN·랭킹·뷰어 재생).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5175";
const OUT = process.argv[2];
const MODE = process.argv[3] || "mobile";
const VP = MODE === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
fs.mkdirSync(path.join(OUT, MODE), { recursive: true });

let n = 100;
const shot = async (page, name, full = true) => {
  n += 1;
  const f = path.join(OUT, MODE, `${n}-${name}.png`);
  await page.screenshot({ path: f, fullPage: full });
  console.log("SHOT", f);
};
const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log("SKIP", label, String(e).split("\n")[0]); } };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 2, isMobile: MODE === "mobile", hasTouch: MODE === "mobile" });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

// 로그인 — OAuth 동의 목 화면 포함
await page.goto(`${BASE}/login`);
await page.waitForTimeout(600);
await safe("consent", async () => {
  await page.getByTestId("provider-mock:google").click();
  await page.waitForTimeout(600);
  await shot(page, "login-consent-mock");
  await page.getByTestId("consent-continue").click();
  await page.waitForTimeout(600);
  await shot(page, "login-nickname-step");
});
const nick = `p2${MODE[0]}${Math.floor(Date.now() / 1000) % 100000}`;
await safe("nick", async () => {
  await page.getByPlaceholder("2~16자").fill(nick);
  await page.getByRole("button", { name: "계속" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "확인" }).click();
});
await page.waitForURL(/\/lobby$/, { timeout: 20000 });
await page.waitForTimeout(800);

// 가챠 연출
await page.goto(`${BASE}/shop`); await page.waitForTimeout(1000);
await safe("gacha", async () => {
  await page.getByTestId("gacha-ten").click();
  await page.waitForTimeout(2000);
  await shot(page, "gacha-reveal-1");
  await page.getByTestId("gacha-reveal-next").click();
  await page.waitForTimeout(900);
  await shot(page, "gacha-reveal-2");
  await page.getByTestId("gacha-reveal-all").click();
  await page.waitForTimeout(1200);
  await shot(page, "gacha-reveal-all");
  await page.getByTestId("gacha-close").click();
});

// 도감 필터 상태
await page.goto(`${BASE}/codex`); await page.waitForTimeout(1200);
await safe("codex-filter", async () => {
  await page.getByTestId("codex-grade-LEGEND").click();
  await page.waitForTimeout(700);
  await shot(page, "codex-filter-legend");
});

// 덱 시드 후 서브상태
const ok = await page.evaluate(async () => {
  const token = localStorage.getItem("hmb.auth.token");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const players = await (await fetch("/api/players", { headers })).json();
  const owned = players.filter((p) => p.owned);
  const gk = owned.find((p) => p.position === "GK");
  if (!gk || owned.length < 11) return false;
  const ordered = [gk, ...owned.filter((p) => p.id !== gk.id)];
  const slots = [
    ...ordered.slice(0, 11).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i })),
    ...ordered.slice(11, 16).map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i })),
  ];
  const res = await fetch("/api/deck", { method: "PUT", headers, body: JSON.stringify({ formation: "4-4-2", slots }) });
  return res.ok;
});
console.log("SEEDED", ok);

await page.goto(`${BASE}/deck`); await page.waitForTimeout(1800);
await safe("player-sheet", async () => {
  await page.locator('[data-testid^="token-"]').first().click();
  await page.getByTestId("player-sheet").waitFor();
  await page.waitForTimeout(700);
  await shot(page, "deck-player-sheet-open");
  // 지시 칩 몇 개 선택된 상태
  await safe("chips", async () => {
    const chips = page.locator('[data-testid^="sheet-chip-"]');
    const c = Math.min(3, await chips.count());
    for (let i = 0; i < c; i += 1) { await chips.nth(i).click(); await page.waitForTimeout(150); }
    await page.waitForTimeout(400);
    await shot(page, "deck-player-sheet-chips-selected");
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});
await safe("picker", async () => {
  await page.locator('[data-testid^="board-slot-bench-"]').last().click();
  await page.waitForTimeout(900);
  await shot(page, "deck-player-picker-open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});
await safe("preset-create", async () => {
  await page.getByTestId("preset-name").fill("압박 전개");
  await page.getByTestId("preset-body").fill("전방에서 강하게 압박하고 볼 탈취 후 즉시 전진 패스");
  await page.getByTestId("preset-create").click();
  await page.waitForTimeout(1200);
  await page.getByTestId("preset-panel").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, "deck-preset-saved");
});
await safe("formation", async () => {
  await page.getByTestId("formation-select").selectOption({ index: 2 });
  await page.waitForTimeout(900);
  await shot(page, "deck-formation-changed");
});

// 트레이드 — 슬롯 단축해서 OPEN 상태
await page.goto(`${BASE}/trade`); await page.waitForTimeout(1200);
await safe("trade-open", async () => {
  await page.getByTestId("trade-slot-1-speedup").click();
  await page.waitForTimeout(2500);
  await shot(page, "trade-slot-opened");
  await safe("propose", async () => {
    await page.locator('[data-testid^="propose-chip-"]').first().click();
    await page.waitForTimeout(500);
    await page.locator('[data-testid^="propose-chip-"]').nth(1).click();
    await page.waitForTimeout(800);
    await shot(page, "trade-propose-filled");
  });
});
await safe("trade-open2", async () => {
  await page.getByTestId("trade-slot-2-speedup").click();
  await page.waitForTimeout(2500);
  await shot(page, "trade-slot2-opened");
});

// 랭킹 탭
await page.goto(`${BASE}/logs`); await page.waitForTimeout(1200);
await safe("ranking", async () => {
  await page.getByRole("button", { name: "랭킹" }).first().click();
  await page.waitForTimeout(1200);
  await shot(page, "logs-ranking");
});

// 매치 — 마킹 패널 + 뷰어 실재생
await page.goto(`${BASE}/lobby`); await page.waitForTimeout(800);
await safe("match", async () => {
  await page.getByTestId("play-cta").click();
  await page.waitForTimeout(500);
  await page.getByTestId("mode-practice").click();
  await page.waitForURL(/\/match\//, { timeout: 30000 });
  await page.getByTestId("briefing-panel").waitFor();
  await page.waitForTimeout(1500);
  await safe("mark", async () => {
    await page.getByTestId("mark-chip").first().click();
    await page.waitForTimeout(700);
    await shot(page, "briefing-mark-panel");
    await safe("mark-confirm", async () => {
      await page.getByTestId("mark-defender-select").selectOption({ index: 1 });
      await page.getByTestId("mark-confirm").click();
      await page.waitForTimeout(800);
      await shot(page, "briefing-mark-applied");
    });
  });
  await page.getByTestId("editor-team-prompt").fill("측면을 넓게 쓰고 뒷공간을 노려라");
  await page.getByTestId("kickoff-button").click();
  await page.getByTestId("halftime-panel").waitFor({ timeout: 120000 });
  await page.waitForTimeout(2000);
  // 뷰어 시각 재생
  await safe("viewer", async () => {
    await page.getByTestId("viewer-tab-visual-half1").click();
    await page.waitForTimeout(1500);
    await page.getByTestId("viewer-visual-half1").scrollIntoViewIfNeeded();
    await page.waitForTimeout(4000);
    await shot(page, "match-viewer-visual", false);
    await safe("timeline", async () => {
      await page.getByTestId("viewer-tab-timeline-half1").click();
      await page.waitForTimeout(1200);
      await page.getByTestId("viewer-timeline-half1").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shot(page, "match-viewer-timeline", false);
    });
  });
});

await browser.close();
console.log("DONE2", MODE);
