/**
 * 목업 실화면 캡처 — 좌표·마크업 추론 대신 눈으로 본다(§2.5 실화면 검증).
 * 사용: node docs/plan-v5/mock/mailbox/shots.mjs [출력디렉토리]
 * PNG 는 리포에 커밋하지 않는다(기본 출력 = /tmp).
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? "/tmp";
const URL = "file://" + path.join(here, "index.html");

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1180, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(URL);
await p.screenshot({ path: `${OUT}/mail-pair.png`, fullPage: true });

await p.click('#pA .glyph[title="우편함"]');
await p.waitForTimeout(150);
await p.locator("#pA").screenshot({ path: `${OUT}/mail-list.png` });

await p.click("#sheetA .mail");
await p.waitForTimeout(150);
await p.locator("#pA").screenshot({ path: `${OUT}/mail-detail.png` });

await p.click("#claimA");
await p.waitForTimeout(150);
await p.locator("#pA").screenshot({ path: `${OUT}/mail-claimed.png` });

await p.click('#pB .tile:has-text("내 정보")');
await p.waitForTimeout(150);
await p.locator("#pB").screenshot({ path: `${OUT}/mail-b-me.png` });

await b.close();
console.log("captured →", OUT);
