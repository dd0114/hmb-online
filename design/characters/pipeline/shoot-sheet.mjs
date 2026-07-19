#!/usr/bin/env node
// 대조 시트 HTML → PNG 캡처 (#104 hero 게이트 제출물).
// contact-sheet.png 는 손으로 만들면 out/ 이 바뀔 때 조용히 stale 이 된다 → 스크립트로 고정.
//
//   node design/characters/pipeline/shoot-sheet.mjs
//
// playwright 가 이 워크트리에 없으면 스크래치패드 등 다른 위치에서 해석되도록
// PLAYWRIGHT_PATH 로 경로를 넘길 수 있다.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const html = path.join(ROOT, 'contact-sheet.html');
const out = path.join(ROOT, 'contact-sheet.png');

const mod = process.env.PLAYWRIGHT_PATH
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_PATH).href)
  : await import('playwright');

const browser = await mod.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(html).href);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`✓ contact-sheet.png ← ${path.basename(html)}`);
