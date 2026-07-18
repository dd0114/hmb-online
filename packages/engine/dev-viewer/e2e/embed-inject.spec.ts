import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadViewer, VIEWER_URL } from "./fixture";

// #65 뷰어 소비 주입 계약(정식화). iframe 임베드 시 부모에 {type:'viewerReady'} 송신,
// 부모로부터 {type:'loadMatchLog', matchLog} 수신 시 그 로그로 (재)초기화. web(build-viewer.mjs)의
// fetch-가로채기 브리지를 대체할 네이티브 지원. 계약 = viewer-bridge.ts 의 2메시지 그대로.

const here = dirname(fileURLToPath(import.meta.url));
const HOST_URL = "file://" + join(here, "embed-host.html");

// 주입 검증용 최소 MatchLog(데모와 구분되는 마커: seed/스코어/이벤트).
const INJECT_LOG = {
  configVersion: "embed-test@1",
  seed: "inject-marker-777",
  finalScore: { home: 3, away: 0 },
  events: [
    { tick: 2, minute: 0, type: "shot", team: "home", playerId: "H9" },
    { tick: 3, minute: 0, type: "goal", team: "home", playerId: "H9" },
  ],
  tickSnapshots: [
    { tick: 0, minute: 0, ball: { x: 52.5, y: 34 }, ballOwner: "H9", players: [{ playerId: "H9", team: "home", pos: { x: 52.5, y: 34 } }] },
    { tick: 1, minute: 0, ball: { x: 80, y: 34 }, ballOwner: "H9", players: [{ playerId: "H9", team: "home", pos: { x: 80, y: 34 } }] },
    { tick: 2, minute: 0, ball: { x: 100, y: 34 }, ballOwner: "H9", players: [{ playerId: "H9", team: "home", pos: { x: 100, y: 34 } }] },
    { tick: 3, minute: 0, ball: { x: 105, y: 34 }, ballOwner: null, players: [{ playerId: "H9", team: "home", pos: { x: 103, y: 34 } }] },
  ],
};

// AC1/AC3: 임베드(iframe) 로드 시 viewerReady 송신 → 부모가 loadMatchLog 주입 → 그 로그로 재초기화.
test("#65 임베드 핸드셰이크: viewerReady 송신 + loadMatchLog 주입으로 (재)초기화", async ({ page }) => {
  await page.goto(HOST_URL); // 동종 오리진(file://) 호스트가 viewer-test.html 을 임베드.
  // AC1: iframe 이 viewerReady 를 송신 → 호스트가 loadMatchLog 주입.
  await page.waitForFunction(() => (window as any).__HANDSHAKE__ && (window as any).__HANDSHAKE__.done, null, { timeout: 15000 });
  const readyCount = await page.evaluate(() => (window as any).__HANDSHAKE__.readyCount);
  expect(readyCount, "iframe 이 viewerReady 를 송신해야").toBeGreaterThan(0);
  // AC2/AC3: 주입 로그로 재초기화 검증 — Playwright frame API(CDP)로 iframe 내부 __viewer 접근(크로스프레임 JS 우회).
  const frame = page.frames().find((f) => f.url().includes("viewer-test.html"));
  expect(frame, "viewer iframe 프레임").toBeTruthy();
  await frame!.waitForFunction(() => (window as any).__viewer && (window as any).__viewer.events().length === 2, null, { timeout: 8000 });
  const evs = await frame!.evaluate(() => (window as any).__viewer.events());
  expect(evs.length, "주입 로그 이벤트 수 반영").toBe(2);
  expect(evs.some((e: any) => e.type === "goal" && e.team === "home"), "주입 로그의 home 골 반영").toBe(true);
  const status = await frame!.evaluate(() => document.getElementById("status")?.textContent || "");
  expect(status, "주입 마커 seed 반영").toContain("inject-marker-777");
});

// AC2/AC3(재주입): 톱레벨에서도 loadMatchLog 리스너 동작(멱등 재초기화) — 임베드 아니어도 주입 수신.
test("#65 loadMatchLog 리스너: 주입 로그로 재초기화(재주입 멱등)", async ({ page }) => {
  await loadViewer(page, VIEWER_URL); // 데모(6:5) 로드됨.
  const before = await page.evaluate(() => (window as any).__viewer.events().length);
  const after = await page.evaluate((log) => {
    return new Promise((resolve) => {
      window.postMessage({ type: "loadMatchLog", matchLog: log }, "*");
      setTimeout(() => resolve((window as any).__viewer.events()), 400);
    });
  }, INJECT_LOG);
  expect((after as any[]).length, `주입 전 ${before} → 주입 후 2 (재초기화)`).toBe(2);
  expect((after as any[]).some((e) => e.type === "goal")).toBe(true);
});

// #65 하드닝: 손상 MatchLog 주입(신뢰 경계 밖)이 렌더 루프를 죽이지 않고, 이후 유효 주입으로 회복.
// (독립 QA 발견 — 서버 스키마 드리프트/하프 손상 시 뷰어 통째로 멈추던 리스크.)
test("#65 손상 페이로드 주입해도 뷰어가 죽지 않고 회복한다", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await loadViewer(page, VIEWER_URL); // 데모 로드.
  // 손상 주입(events/tickSnapshots 없음) → 원자적 검증이 상태 변경 전에 막고 상태줄에 실패 표시.
  await page.evaluate(() => window.postMessage({ type: "loadMatchLog", matchLog: { foo: 1 } }, "*"));
  await page.waitForTimeout(200);
  const status = await page.evaluate(() => document.getElementById("status")?.textContent || "");
  expect(status, "손상 주입은 실패 표시").toContain("실패");
  // 유효 로그 재주입 → 회복(events 반영 + play 로 tick 진행 = 렌더 루프 살아있음).
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), INJECT_LOG);
  await page.waitForFunction(() => (window as any).__viewer.events().length === 2, null, { timeout: 5000 });
  const advanced = await page.evaluate(async () => {
    const v = (window as any).__viewer; v.seek(0); v.play();
    const t0 = v.cur().tick;
    await new Promise((r) => setTimeout(r, 600));
    return { t0, t1: v.cur().tick };
  });
  expect(advanced.t1, `재주입 후 play 진행(t${advanced.t0}→t${advanced.t1}) — 렌더 안 죽음`).toBeGreaterThan(advanced.t0);
  expect(pageErrors.length, `uncaught pageerror 없음: ${pageErrors.join("; ")}`).toBe(0);
});
