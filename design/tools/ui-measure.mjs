// 화면별 주요 요소 기하 실측(bounding box) — 프롬프트 팩의 "버튼 위치"를 추론이 아니라 측정으로.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = "http://localhost:5175";
const OUT = process.argv[2];
const MODE = process.argv[3] || "mobile";
const VP = MODE === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VP, isMobile: MODE === "mobile", hasTouch: MODE === "mobile" });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const result = { mode: MODE, viewport: VP, screens: {} };

async function measure(key) {
  const items = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const push = (label, el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const k = `${label}|${Math.round(r.x)}|${Math.round(r.y)}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({
        label,
        x: Math.round(r.x), y: Math.round(r.y + window.scrollY),
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.textContent || "").trim().slice(0, 40),
      });
    };
    document.querySelectorAll("[data-testid]").forEach((el) => push(`#${el.getAttribute("data-testid")}`, el));
    document.querySelectorAll("button, a, input, textarea, select").forEach((el) => {
      if (el.hasAttribute("data-testid")) return;
      const t = (el.textContent || el.placeholder || el.tagName).trim().slice(0, 24);
      push(`${el.tagName.toLowerCase()}:${t}`, el);
    });
    return out;
  });
  const doc = await page.evaluate(() => ({ scrollH: document.documentElement.scrollHeight }));
  result.screens[key] = { docHeight: doc.scrollH, items };
  console.log(key, items.length, "elements, docH", doc.scrollH);
}

// 로그인
await page.goto(`${BASE}/login`); await page.waitForTimeout(700);
await measure("login");
await page.getByTestId("provider-guest").click();
await page.waitForTimeout(400);
await measure("login-nickname");
const nick = `m${MODE[0]}${Math.floor(Date.now() / 1000) % 100000}`;
await page.getByPlaceholder("2~16자").fill(nick);
await page.getByRole("button", { name: "계속" }).click();
await page.waitForTimeout(1500);
await measure("login-starterpack");
await page.getByRole("button", { name: "확인" }).click();
await page.waitForURL(/\/lobby$/, { timeout: 20000 });
await page.waitForTimeout(800);
await measure("lobby");
await page.getByTestId("play-cta").click(); await page.waitForTimeout(500);
await measure("lobby-mode-modal");
await page.keyboard.press("Escape"); await page.waitForTimeout(300);

for (const [route, key] of [["/shop", "shop"], ["/codex", "codex"], ["/trade", "trade"], ["/logs", "logs"], ["/league", "league-empty"]]) {
  await page.goto(BASE + route); await page.waitForTimeout(1400);
  await measure(key);
}

await page.evaluate(async () => {
  const token = localStorage.getItem("hmb.auth.token");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const players = await (await fetch("/api/players", { headers })).json();
  const owned = players.filter((p) => p.owned);
  const gk = owned.find((p) => p.position === "GK");
  const ordered = [gk, ...owned.filter((p) => p.id !== gk.id)];
  const slots = [
    ...ordered.slice(0, 11).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i })),
    ...ordered.slice(11, 16).map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i })),
  ];
  await fetch("/api/deck", { method: "PUT", headers, body: JSON.stringify({ formation: "4-4-2", slots }) });
});

await page.goto(`${BASE}/deck`); await page.waitForTimeout(1800);
await measure("deck");
await page.locator('[data-testid^="token-"]').first().click();
await page.getByTestId("player-sheet").waitFor(); await page.waitForTimeout(600);
await measure("deck-player-sheet");

await page.goto(`${BASE}/lobby`); await page.waitForTimeout(800);
await page.getByTestId("play-cta").click(); await page.waitForTimeout(400);
await page.getByTestId("mode-practice").click();
await page.waitForURL(/\/match\//, { timeout: 30000 });
await page.getByTestId("briefing-panel").waitFor(); await page.waitForTimeout(1500);
await measure("match-briefing");
await page.getByTestId("editor-team-prompt").fill("측면 활용");
await page.getByTestId("kickoff-button").click();
await page.waitForTimeout(2000);
await measure("match-genwait");
await page.getByTestId("halftime-panel").waitFor({ timeout: 120000 });
await page.waitForTimeout(2000);
await measure("match-halftime");
await page.getByTestId("resume-button").click();
await page.getByTestId("result-page").waitFor({ timeout: 120000 });
await page.waitForTimeout(2000);
await measure("match-result");

fs.writeFileSync(`${OUT}/measure-${MODE}.json`, JSON.stringify(result, null, 1));
await browser.close();
console.log("MEASURED", MODE);
