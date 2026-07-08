// Playwright: 뷰어 standalone 을 렌더링해 선방/골 순간을 스크린샷 + 자막 상태를 덤프한다.
// "선방인데 골처럼" 시각 진단용. 실행: node tools/shoot.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const viewer = "file://" + join(here, "..", "packages/engine/dev-viewer/viewer-standalone.html");
const outDir = join(here, "shots");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await page.goto(viewer);
await page.waitForFunction(() => window.__viewer && window.__viewer.ready(), { timeout: 10000 });

const events = await page.evaluate(() => window.__viewer.events());
const goals = events.filter((e) => e.type === "goal");
const saves = events.filter((e) => e.type === "save");
console.log(`goals ${goals.length}, saves ${saves.length}`);

async function shoot(name, tick, kind) {
  if (kind === "save") await page.evaluate((t) => window.__viewer.showSituationAt(t), tick);
  else await page.evaluate((t) => window.__viewer.seek(t), tick);
  await page.waitForTimeout(120); // 애니메이션 프레임 안정
  const caps = await page.evaluate(() => window.__viewer.captions());
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name} @t${tick}  flash="${caps.flash}" situation="${caps.situation}" banner="${caps.banner}" score=${caps.score} min=${caps.minute}`);
}

// 골 2개 + 선방 3개 스크린샷
for (let i = 0; i < Math.min(2, goals.length); i++) await shoot(`goal${i + 1}`, goals[i].tick, "goal");
for (let i = 0; i < Math.min(3, saves.length); i++) await shoot(`save${i + 1}`, saves[i].tick, "save");

await browser.close();
console.log("done → tools/shots/");
