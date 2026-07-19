// 전 화면 실캡처 — 격리 스택(web 5175 / java 8085) 대상. 데모(5173/8080) 무접촉.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5175";
const OUT = process.argv[2] || "/tmp/shots";
const MODE = process.argv[3] || "mobile"; // mobile | desktop
const VP = MODE === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };

fs.mkdirSync(path.join(OUT, MODE), { recursive: true });
let n = 0;
const shot = async (page, name, full = true) => {
  n += 1;
  const f = path.join(OUT, MODE, `${String(n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: f, fullPage: full });
  console.log("SHOT", f);
};
const safe = async (label, fn) => {
  try { await fn(); } catch (e) { console.log("SKIP", label, String(e).split("\n")[0]); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 2, isMobile: MODE === "mobile", hasTouch: MODE === "mobile" });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

// ---------- 1. 로그인 ----------
await page.goto(`${BASE}/login`);
await page.waitForTimeout(800);
await shot(page, "login");

await safe("provider-modal", async () => {
  await page.getByTestId("provider-google").click();
  await page.waitForTimeout(500);
  await shot(page, "login-consent-google");
  // 모달 닫기(취소) 후 게스트로 진행
  const cancel = page.getByRole("button", { name: /취소|닫기/ });
  if (await cancel.count()) await cancel.first().click();
});
await page.waitForTimeout(300);

const nick = `d_${MODE}_${Math.floor(Date.now() / 1000) % 100000}`;
await page.getByTestId("provider-guest").click();
await page.waitForTimeout(500);
await shot(page, "login-nickname");
await page.getByPlaceholder("2~16자").fill(nick);
await page.getByRole("button", { name: "계속" }).click();
await page.waitForTimeout(1200);
await shot(page, "starter-pack-modal");
await safe("confirm", () => page.getByRole("button", { name: "확인" }).click());
await page.waitForURL(/\/lobby$/, { timeout: 20000 });
await page.waitForTimeout(1000);

// ---------- 2. 로비 ----------
await shot(page, "lobby");
await safe("play-modal", async () => {
  await page.getByTestId("play-cta").click();
  await page.waitForTimeout(600);
  await shot(page, "lobby-mode-modal");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

// ---------- 3. 상점 / 가챠 ----------
await page.goto(`${BASE}/shop`); await page.waitForTimeout(1200);
await shot(page, "shop");
await safe("gacha", async () => {
  const b = page.getByTestId("gacha-10").or(page.getByRole("button", { name: /뽑기|10\+1/ }));
  await b.first().click();
  await page.waitForTimeout(2500);
  await shot(page, "shop-gacha-reveal");
  const close = page.getByRole("button", { name: /확인|닫기/ });
  if (await close.count()) await close.first().click();
});

// ---------- 4. 도감 ----------
await page.goto(`${BASE}/codex`); await page.waitForTimeout(1200);
await shot(page, "codex");
await safe("codex-detail", async () => {
  await page.getByTestId(/player-card/).first().click();
  await page.waitForTimeout(600);
  await shot(page, "codex-player-detail");
  await page.keyboard.press("Escape");
});

// ---------- 5. 덱 / 전술보드 ----------
// 덱 시드(11선발+벤치) — 슬롯 채워진 실물 상태로 캡처하기 위함
const seeded = await page.evaluate(async () => {
  const token = localStorage.getItem("hmb.auth.token");
  if (!token) return false;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const players = await (await fetch("/api/players", { headers })).json();
  const owned = players.filter((p) => p.owned);
  const gk = owned.find((p) => p.position === "GK");
  if (!gk || owned.length < 11) return false;
  const ordered = [gk, ...owned.filter((p) => p.id !== gk.id)];
  const starters = ordered.slice(0, 11).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i }));
  const bench = ordered.slice(11, 18).map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i }));
  const res = await fetch("/api/deck", { method: "PUT", headers, body: JSON.stringify({ formation: "4-4-2", slots: [...starters, ...bench] }) });
  return res.ok;
});
console.log("SEEDED", seeded);

await page.goto(`${BASE}/deck`); await page.waitForTimeout(1800);
await shot(page, "deck");
await safe("player-sheet", async () => {
  await page.getByTestId(/^slot-|^token-/).first().click();
  await page.waitForTimeout(800);
  await shot(page, "deck-player-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});
await safe("player-picker", async () => {
  const b = page.getByTestId("open-picker").or(page.getByRole("button", { name: /선수 (선택|추가)|리스트/ }));
  await b.first().click();
  await page.waitForTimeout(800);
  await shot(page, "deck-player-picker");
  await page.keyboard.press("Escape");
});
await safe("preset-panel", async () => {
  const b = page.getByTestId("preset-panel").or(page.getByRole("button", { name: /프리셋/ }));
  await b.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, "deck-presets");
});

// ---------- 6. 트레이드 ----------
await page.goto(`${BASE}/trade`); await page.waitForTimeout(1500);
await shot(page, "trade");
await safe("trade-propose", async () => {
  const b = page.getByTestId(/propose|offer/).or(page.getByRole("button", { name: /제안/ }));
  await b.first().click();
  await page.waitForTimeout(800);
  await shot(page, "trade-propose-builder");
  await page.keyboard.press("Escape");
});

// ---------- 7. 로그 / 랭킹 ----------
await page.goto(`${BASE}/logs`); await page.waitForTimeout(1500);
await shot(page, "logs-matches");
for (const t of ["트레이드", "랭킹"]) {
  await safe(`logs-${t}`, async () => {
    await page.getByRole("button", { name: t }).or(page.getByRole("tab", { name: t })).first().click();
    await page.waitForTimeout(1000);
    await shot(page, `logs-${t === "트레이드" ? "trades" : "ranking"}`);
  });
}

// ---------- 8. 리그 ----------
await page.goto(`${BASE}/league`); await page.waitForTimeout(1500);
await shot(page, "league-empty");
await safe("league-start", async () => {
  const b = page.getByTestId("start-season").or(page.getByRole("button", { name: /시즌 시작|시작/ }));
  await b.first().click();
  await page.waitForTimeout(2500);
  await shot(page, "league-dashboard");
  for (const t of ["일정", "순위"]) {
    await safe(`league-${t}`, async () => {
      await page.getByRole("button", { name: t }).or(page.getByRole("tab", { name: t })).first().click();
      await page.waitForTimeout(900);
      await shot(page, `league-${t === "일정" ? "schedule" : "standings"}`);
    });
  }
});

// ---------- 9. 매치 풀플로우 ----------
await page.goto(`${BASE}/lobby`); await page.waitForTimeout(1000);
await safe("match", async () => {
  await page.getByTestId("play-cta").click();
  await page.waitForTimeout(500);
  await page.getByTestId("mode-practice").click();
  await page.waitForURL(/\/match\//, { timeout: 30000 });
  await page.waitForTimeout(2000);
  await shot(page, "match-briefing");

  await safe("opponent-analysis", async () => {
    await page.getByTestId("opponent-analysis").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, "match-briefing-opponent");
  });
  await safe("player-prompt-sheet", async () => {
    await page.getByTestId(/^slot-|^token-/).first().click();
    await page.waitForTimeout(700);
    await shot(page, "match-briefing-player-sheet");
    await page.keyboard.press("Escape");
  });

  await page.getByTestId("editor-team-prompt").fill("초반부터 강하게 압박하고 측면을 적극 활용해라");
  await page.waitForTimeout(300);
  await shot(page, "match-briefing-filled");
  await page.getByTestId("kickoff-button").click();
  await page.waitForTimeout(1500);
  await shot(page, "match-genwait");

  await page.getByTestId("halftime-panel").waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500);
  await shot(page, "match-halftime");
  await safe("viewer1", async () => {
    await page.getByTestId("match-viewer-half1").scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await shot(page, "match-viewer-half1", false);
  });

  // 교체 1건
  await safe("sub", async () => {
    const outSelect = page.getByTestId("sub-out-select");
    const v = await outSelect.evaluate((el) => {
      const sel = el; const opt = [...sel.options].find((o) => o.value !== "" && !/^GK\b/.test(o.textContent ?? ""));
      return opt?.value ?? "";
    });
    await outSelect.selectOption(v);
    await page.getByTestId("sub-in-select").selectOption({ index: 1 });
    await page.getByTestId("sub-add").click();
    await page.waitForTimeout(500);
    await shot(page, "match-halftime-sub-added");
  });
  await page.getByTestId("halftime-team-prompt").fill("후반은 점유율 위주로 안정적으로 운영");
  await page.getByTestId("resume-button").click();
  await page.waitForTimeout(1500);
  await shot(page, "match-genwait2");

  await page.getByTestId("result-page").waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500);
  await shot(page, "match-result");
  await safe("viewer2", async () => {
    await page.getByTestId("match-viewer-half2").scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await shot(page, "match-viewer-half2", false);
  });
});

// 최종 로비(전적 반영)
await page.goto(`${BASE}/lobby`); await page.waitForTimeout(1200);
await shot(page, "lobby-after-match");

await browser.close();
console.log("DONE", MODE);
