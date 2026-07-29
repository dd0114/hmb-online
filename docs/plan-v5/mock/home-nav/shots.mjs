// #286 AFTER 프로토타입 스크린샷 생성기 — 보드의 IA 비교 이미지(tabbar.png)와 정적 백업 컷.
//
//   cd <repo> && node docs/plan-v5/mock/home-nav/shots.mjs
//
// 보드(index.html)는 AFTER 를 **live iframe** 으로 띄우므로 이 이미지들이 없어도 동작한다.
// 다만 IA 섹션의 탭바 비교(after/tabbar.png)만은 이미지라 프로토타입을 고치면 다시 돌린다.
// 경로는 리포 루트 기준이다(cwd = 리포 루트).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const dir = "docs/plan-v5/mock/home-nav/after/";
mkdirSync(dir, { recursive: true });
const file = "file://" + process.cwd() + "/docs/plan-v5/mock/home-nav/after.html";
const shots = [
  ["00-home", "?screen=home"],
  ["00b-home-locked", "?screen=home&sub=lock"],
  ["01-game", "?screen=game"],
  ["01b-game-locked", "?screen=game&sub=lock"],
  ["02-league-intro", "?screen=league"],
  ["03-league-run", "?screen=league&sub=run"],
  ["04-away", "?screen=away"],
  ["05-revenge-sheet", "?screen=away&sheet=revenge"],
  ["06-deck", "?screen=deck"],
  ["06b-deck-locked", "?screen=deck&sub=lock"],
  ["08-growth-sheet", "?screen=players&sheet=growth"],
  ["09-players-owned", "?screen=players"],
  ["10-players-all", "?screen=players&sub=all"],
  ["11-recruit-gacha", "?screen=recruit"],
  ["12-recruit-trade", "?screen=recruit&sub=trade"],
  ["13-me", "?screen=me"],
];
const b = await chromium.launch();
for (const [name, q] of shots) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(file + q);
  await p.waitForTimeout(300);
  const h = await p.evaluate(() => Math.max(document.documentElement.scrollHeight, 844));
  await p.setViewportSize({ width: 390, height: Math.min(h, 3200) });
  await p.waitForTimeout(200);
  await p.screenshot({ path: dir + name + ".png" });
  await p.close();
}
const t = await b.newPage({ viewport: { width: 390, height: 844 } });
// ⚠️ 홈에서는 탭바가 숨는다(hero 4R) — 탭바 컷은 다른 화면에서 찍는다.
await t.goto(file + "?screen=game&notes=0");
await t.waitForTimeout(300);
await t.locator(".tabbar").screenshot({ path: dir + "tabbar.png" });
await t.close();
await b.close();
console.log("after shots done");
