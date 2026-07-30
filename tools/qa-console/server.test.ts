// 콘솔 API 계약 (#191 AC2/AC3/AC4). UI 가 이 응답만 보고 그리므로 여기가 화면의 계약이다.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { buildTab, ensureHome, readFeedback, writeAck, writeTab } from "./registry.mjs";
import { createApiServer, listen } from "./server.mjs";

/**
 * ⚠️ **시간 예산이지 판정 완화가 아니다.**
 *
 * 피드백 POST 한 건이 핸들러 안에서 `ensureGitRepo` + `commitRegistry` 로 **git 서브프로세스를
 * 3~4회 동기 실행**한다(기록 계층 §3.1). 한가할 땐 파일 전체가 7초면 끝나지만, 루트 `npm test` 는
 * 이 파일을 **CPU 를 꽉 쓰는 엔진 리얼리즘 테스트와 병렬로** 돌린다. 그러면 POST 하나가 초 단위로
 * 늘어나 **POST 3회짜리 테스트**("연속 전송이 seq 를…")가 vitest 기본 5초를 넘겨 죽었다.
 *
 * 실측(재현: `npx vitest run tools/ packages/engine/src/realism/shot-frequency.test.ts`):
 *  · 단독 실행 = 16/16 green, 파일 전체 7.4s
 *  · 엔진 부하와 병렬 = 그 한 건이 5.9~6.0s 로 **`Test timed out in 5000ms`**
 *  · **clean origin/main 에서도 재현** — 이 파일의 선행 결함이지 특정 브랜치 문제가 아니다.
 *
 * 즉 단언이 틀린 적은 없다. 늘리는 것은 **한계가 아니라 여유**다 — 판정(seq 1,2,3)은 그대로다.
 * 루트 `npm test` 가 §2.5 필수 게이트인데 여기가 랜덤하게 빨개지면 **세션들이 게이트를 믿지 않게 된다**
 * (그게 진짜 손해다).
 *
 * 되돌리기 = 이 `vi.setConfig` 한 줄 삭제. 근본은 "요청 경로에서 git 을 동기로 돈다"는 설계라
 * 그쪽을 손대려면 기록 내구성 트레이드오프를 같이 봐야 한다(#191 소관, 이슈에 관찰 기록).
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let home: string;
let server: Server;
let base: string;
let logA: string;
let logB: string;
const T = "2026-07-26T04:00:00.000Z";

async function boot() {
  server = createApiServer({ home });
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "qa-api-test-"));
  ensureHome(home);
  mkdirSync(join(home, "logs"), { recursive: true });
  logA = join(home, "logs", "after.json");
  logB = join(home, "logs", "before.json");
  writeFileSync(logA, JSON.stringify({ tickSnapshots: [{ tick: 0 }], marker: "after" }));
  writeFileSync(logB, JSON.stringify({ tickSnapshots: [{ tick: 0 }], marker: "before" }));
  await boot();
});
afterEach(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

function tab(id = "182-corner-stay", over: Record<string, unknown> = {}) {
  return writeTab(
    home,
    buildTab({
      tabId: id,
      issue: 182,
      title: "코너 잔류",
      status: "waiting",
      summary: "s",
      ask: "a",
      views: [
        { id: "after", label: "after", logPath: logA },
        { id: "before", label: "before", logPath: logB },
      ],
      watch: [{ tick: 754, label: "첫 코너" }],
      now: T,
      ...over,
    }),
  );
}

describe("GET /qa-api/tabs", () => {
  it("목록과 집계를 낸다", async () => {
    tab();
    tab("176-deadball", { issue: 176 });
    const r = await fetch(`${base}/qa-api/tabs`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.tabs.map((v: { tab: { tabId: string } }) => v.tab.tabId).sort()).toEqual([
      "176-deadball",
      "182-corner-stay",
    ]);
    expect(body.counts).toMatchObject({ total: 2, waiting: 2, unread: 0 });
  });

  it("탭이 없어도 200 + 빈 목록(콘솔이 흰 화면이 되지 않게)", async () => {
    const body = await (await fetch(`${base}/qa-api/tabs`)).json();
    expect(body.tabs).toEqual([]);
    expect(body.counts.total).toBe(0);
  });
});

describe("GET /qa-api/tabs/:id", () => {
  it("브리핑·확인포인트·피드백·ack 을 한 번에 준다 — UI 가 한 요청으로 그린다", async () => {
    tab();
    const body = await (await fetch(`${base}/qa-api/tabs/182-corner-stay`)).json();
    expect(body.tab.title).toBe("코너 잔류");
    expect(body.tab.watch[0]).toMatchObject({ tick: 754 });
    expect(body.feedback).toEqual([]);
    expect(body.ack.cursor).toBe(0);
  });

  it("없는 탭은 404, 형식이 틀린 id 는 400", async () => {
    expect((await fetch(`${base}/qa-api/tabs/ghost-tab`)).status).toBe(404);
    expect((await fetch(`${base}/qa-api/tabs/${encodeURIComponent("../etc")}`)).status).toBe(400);
  });
});

describe("GET /qa-api/tabs/:id/log/:viewId (AC2)", () => {
  it("탭이 가리키는 로그를 그대로 서빙한다 — 복사 없음", async () => {
    tab();
    const body = await (await fetch(`${base}/qa-api/tabs/182-corner-stay/log/after`)).json();
    expect(body.marker).toBe("after");
  });

  it("뷰마다 다른 로그를 준다(before/after 비교)", async () => {
    tab();
    const before = await (await fetch(`${base}/qa-api/tabs/182-corner-stay/log/before`)).json();
    expect(before.marker).toBe("before");
  });

  it("없는 뷰는 404 + 가진 뷰 목록을 알려준다", async () => {
    tab();
    const r = await fetch(`${base}/qa-api/tabs/182-corner-stay/log/nope`);
    expect(r.status).toBe(404);
    expect((await r.json()).have).toEqual(["after", "before"]);
  });

  it("ETag 가 붙고 재요청은 304 — 수 MB 로그를 왕복마다 다시 안 받게", async () => {
    tab();
    const first = await fetch(`${base}/qa-api/tabs/182-corner-stay/log/after`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await fetch(`${base}/qa-api/tabs/182-corner-stay/log/after`, {
      headers: { "if-none-match": etag as string },
    });
    expect(second.status).toBe(304);
  });

  it("탭 파일이 허용 밖 경로를 가리키면 서빙을 거부한다(서빙 시점 재검증)", async () => {
    const t = tab();
    // 탭 파일은 다른 프로세스가 쓰는 입력이다 → 검증을 등록 시점에만 두면 뚫린다.
    writeFileSync(
      join(home, "tabs", "182-corner-stay.json"),
      JSON.stringify({ ...t, views: [{ id: "after", label: "x", logPath: "/etc/hosts" }] }),
    );
    const r = await fetch(`${base}/qa-api/tabs/182-corner-stay/log/after`);
    expect(r.status).toBe(403);
  });
});

describe("POST /qa-api/tabs/:id/feedback (AC3)", () => {
  it("hero 문장을 그대로 저장하고 seq 를 준다", async () => {
    tab();
    const r = await fetch(`${base}/qa-api/tabs/182-corner-stay/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "comment", body: "3명이 GK 옆에 뭉쳐 있다", view: "after", tick: 760 }),
    });
    expect(r.status).toBe(201);
    expect((await r.json()).feedback.seq).toBe(1);
    const saved = readFeedback(home, "182-corner-stay");
    expect(saved[0].body).toBe("3명이 GK 옆에 뭉쳐 있다");
    expect(saved[0].clock).toBe("12'40\"");
  });

  it("연속 전송이 seq 를 겹치지 않게 쌓는다", async () => {
    tab();
    for (const b of ["a", "b", "c"]) {
      await fetch(`${base}/qa-api/tabs/182-corner-stay/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "comment", body: b }),
      });
    }
    expect(readFeedback(home, "182-corner-stay").map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("사유 없는 거부는 400 + 이유를 화면에 보여줄 메시지로", async () => {
    tab();
    const r = await fetch(`${base}/qa-api/tabs/182-corner-stay/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "reject", body: "   " }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/사유/);
  });

  it("탭이 여러 개여도 각자 파일에만 쌓인다(AC4)", async () => {
    tab();
    tab("176-deadball", { issue: 176 });
    await fetch(`${base}/qa-api/tabs/182-corner-stay/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "comment", body: "182 것" }),
    });
    await fetch(`${base}/qa-api/tabs/176-deadball/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "comment", body: "176 것" }),
    });
    expect(readFeedback(home, "182-corner-stay").map((f) => f.body)).toEqual(["182 것"]);
    expect(readFeedback(home, "176-deadball").map((f) => f.body)).toEqual(["176 것"]);
  });

  it("ack 상태가 목록에 실려 콘솔이 '세션 수신' 배지를 그릴 수 있다", async () => {
    tab();
    await fetch(`${base}/qa-api/tabs/182-corner-stay/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "comment", body: "x" }),
    });
    writeAck(home, "182-corner-stay", { cursor: 1, items: { 1: { state: "working", note: null, at: T } } }, T);
    const body = await (await fetch(`${base}/qa-api/tabs/182-corner-stay`)).json();
    expect(body.ack.cursor).toBe(1);
    expect(body.ack.items["1"].state).toBe("working");
    expect(body.unread).toBe(0);
  });
});

describe("잡다", () => {
  it("health 로 살아있는지·어느 레지스트리를 보는지 확인된다", async () => {
    const body = await (await fetch(`${base}/qa-api/health`)).json();
    expect(body.ok).toBe(true);
    expect(body.home).toBe(home);
  });

  it("모르는 경로는 404 JSON(HTML 에러 페이지 대신)", async () => {
    const r = await fetch(`${base}/qa-api/nope`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBeTruthy();
  });
});
