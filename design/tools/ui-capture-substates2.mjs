// 3차 캡처 — 포인트 소모 없이(가챠 생략) 트레이드 OPEN·랭킹 탭·브리핑 마킹 패널.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5175";
const OUT = process.argv[2];
const MODE = process.argv[3] || "mobile";
const VP = MODE === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
fs.mkdirSync(path.join(OUT, MODE), { recursive: true });

let n = 200;
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

await page.goto(`${BASE}/login`);
await page.getByTestId("provider-guest").click();
const nick = `p3${MODE[0]}${Math.floor(Date.now() / 1000) % 100000}`;
await page.getByPlaceholder("2~16자").fill(nick);
await page.getByRole("button", { name: "계속" }).click();
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "확인" }).click();
await page.waitForURL(/\/lobby$/, { timeout: 20000 });

// 트레이드 — 포인트로 단축해 OPEN 상태 3종
await page.goto(`${BASE}/trade`); await page.waitForTimeout(1200);
for (const s of [1, 2, 3]) {
  await safe(`speedup-${s}`, async () => {
    await page.getByTestId(`trade-slot-${s}-speedup`).click();
    await page.waitForTimeout(2500);
    await shot(page, `trade-after-speedup-${s}`);
  });
}
await safe("propose", async () => {
  const chips = page.locator('[data-testid^="propose-chip-"]');
  await chips.first().click();
  await page.waitForTimeout(400);
  if (await chips.count() > 1) { await chips.nth(1).click(); await page.waitForTimeout(400); }
  await shot(page, "trade-propose-filled");
});

// 랭킹 / 트레이드 로그 탭 (role=tab)
await page.goto(`${BASE}/logs`); await page.waitForTimeout(1200);
for (const [t, name] of [["트레이드", "trades"], ["랭킹", "ranking"]]) {
  await safe(`tab-${t}`, async () => {
    await page.getByRole("tab", { name: t }).click();
    await page.waitForTimeout(1200);
    await shot(page, `logs-tab-${name}`);
  });
}

// 덱 시드 → 브리핑 마킹
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

await page.goto(`${BASE}/lobby`); await page.waitForTimeout(800);
await safe("briefing", async () => {
  await page.getByTestId("play-cta").click();
  await page.waitForTimeout(400);
  await page.getByTestId("mode-practice").click();
  await page.waitForURL(/\/match\//, { timeout: 30000 });
  await page.getByTestId("briefing-panel").waitFor();
  await page.waitForTimeout(1500);
  await safe("mark", async () => {
    await page.getByRole("button", { name: "마크" }).first().click();
    await page.getByTestId("mark-panel").waitFor();
    await page.waitForTimeout(600);
    await page.getByTestId("mark-panel").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, "briefing-mark-panel", false);
    await safe("confirm", async () => {
      await page.getByTestId("mark-confirm").click();
      await page.waitForTimeout(900);
      await shot(page, "briefing-mark-applied", false);
    });
  });
  // 포메이션 변경 상태
  await safe("formation", async () => {
    await page.getByTestId("formation-select").selectOption({ index: 2 });
    await page.waitForTimeout(1000);
    await page.getByTestId("formation-select").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, "briefing-formation-changed", false);
  });
});

await browser.close();
console.log("DONE3", MODE);
