// 폴링 계약 (#191 AC3). 세션이 hero 를 기다리는 표면 — 여기가 깨지면 왕복 자체가 성립하지 않는다.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFeedback, buildTab, ensureHome, removeTab, writeAck, writeTab } from "./registry.mjs";
import { pendingFeedback, waitForFeedback } from "./wait.mjs";

let home: string;
let logFile: string;
const T = "2026-07-26T04:00:00.000Z";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qa-wait-test-"));
  ensureHome(home);
  mkdirSync(join(home, "logs"), { recursive: true });
  logFile = join(home, "logs", "log.json");
  writeFileSync(logFile, "{}");
  writeTab(
    home,
    buildTab({
      tabId: "182-corner-stay",
      title: "t",
      views: [{ id: "after", label: "after", logPath: logFile }],
      now: T,
    }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const add = (body: string) =>
  appendFeedback(home, "182-corner-stay", { verdict: "comment", body, now: T });

describe("pendingFeedback", () => {
  it("ack 커서 이후만 준다", () => {
    add("a");
    add("b");
    writeAck(home, "182-corner-stay", { cursor: 1, items: {} }, T);
    expect(pendingFeedback(home, "182-corner-stay").map((f) => f.body)).toEqual(["b"]);
  });

  it("--since 를 주면 ack 대신 그 값을 기준으로 본다(재시작한 세션이 놓친 것부터)", () => {
    add("a");
    add("b");
    writeAck(home, "182-corner-stay", { cursor: 2, items: {} }, T);
    expect(pendingFeedback(home, "182-corner-stay", 0).map((f) => f.body)).toEqual(["a", "b"]);
  });
});

describe("waitForFeedback", () => {
  it("이미 미수신이 있으면 즉시 돌려준다 — 기다리다 놓치는 창이 없어야 한다", async () => {
    add("먼저 와 있던 것");
    const r = await waitForFeedback({ home, tabId: "182-corner-stay", timeoutMs: 5000 });
    expect(r.status).toBe("feedback");
    expect(r.items.map((f: { body: string }) => f.body)).toEqual(["먼저 와 있던 것"]);
  });

  it("대기 중에 도착하면 깨어난다", async () => {
    const p = waitForFeedback({ home, tabId: "182-corner-stay", timeoutMs: 5000, pollMs: 50 });
    setTimeout(() => add("나중에 도착"), 80);
    const r = await p;
    expect(r.status).toBe("feedback");
    expect(r.items[0].body).toBe("나중에 도착");
  });

  it("아무것도 안 오면 timeout 으로 끝난다(무한 대기 금지)", async () => {
    const r = await waitForFeedback({ home, tabId: "182-corner-stay", timeoutMs: 150, pollMs: 50 });
    expect(r.status).toBe("timeout");
    expect(r.items).toEqual([]);
  });

  it("이미 ack 한 피드백으로는 깨지 않는다 — 같은 일을 두 번 하지 않게", async () => {
    add("처리 완료된 것");
    writeAck(home, "182-corner-stay", { cursor: 1, items: {} }, T);
    const r = await waitForFeedback({ home, tabId: "182-corner-stay", timeoutMs: 150, pollMs: 50 });
    expect(r.status).toBe("timeout");
  });

  it("대기 중 탭이 지워지면 gone 으로 알린다 — 세션이 영원히 매달리지 않게", async () => {
    const p = waitForFeedback({ home, tabId: "182-corner-stay", timeoutMs: 5000, pollMs: 50 });
    setTimeout(() => removeTab(home, "182-corner-stay"), 80);
    expect((await p).status).toBe("gone");
  });

  it("없는 탭을 기다리면 즉시 실패한다 — 오타를 조용히 삼키지 않는다", async () => {
    await expect(waitForFeedback({ home, tabId: "ghost-tab", timeoutMs: 100 })).rejects.toThrow(/없는 탭/);
  });

  it("여러 건이 몰려도 한 번에 전부 준다", async () => {
    const p = waitForFeedback({ home, tabId: "182-corner-stay", timeoutMs: 5000, pollMs: 50 });
    setTimeout(() => {
      add("첫째");
      add("둘째");
    }, 80);
    const r = await p;
    expect(r.items.map((f: { body: string }) => f.body)).toEqual(["첫째", "둘째"]);
  });
});
