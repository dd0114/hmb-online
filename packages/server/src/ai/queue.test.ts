import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJobQueue } from "./queue.js";
import type { AiJob } from "./protocol.js";

const job = (id: string): AiJob => ({ id, kind: "coach", context: { directive: "x" }, enqueuedAt: "t" });

describe("FileJobQueue — 내구 파일 큐", () => {
  let q: FileJobQueue;
  beforeEach(() => {
    q = new FileJobQueue(mkdtempSync(join(tmpdir(), "aiq-")));
  });

  it("enqueue → claim → complete(ok) 라이프사이클 + 상태/결과 조회", async () => {
    expect(await q.enqueue(job("aaaaaaaa"))).toBe("enqueued");
    expect(await q.status("aaaaaaaa")).toBe("pending");
    const claimed = await q.claim();
    expect(claimed?.id).toBe("aaaaaaaa");
    expect(await q.status("aaaaaaaa")).toBe("claimed");
    await q.complete({ id: "aaaaaaaa", kind: "coach", ok: true, output: { v: 1 } });
    expect(await q.status("aaaaaaaa")).toBe("done");
    expect((await q.result("aaaaaaaa"))?.ok).toBe(true);
  });

  it("enqueue 는 멱등 — 같은 id 는 exists (done 이후에도)", async () => {
    await q.enqueue(job("bbbbbbbb"));
    expect(await q.enqueue(job("bbbbbbbb"))).toBe("exists");
    await q.claim();
    await q.complete({ id: "bbbbbbbb", kind: "coach", ok: true, output: {} });
    expect(await q.enqueue(job("bbbbbbbb"))).toBe("exists"); // 결과 있음 → 재실행 안 함
  });

  it("실패는 failed 로 + 에러 보존", async () => {
    await q.enqueue(job("cccccccc"));
    await q.claim();
    await q.complete({ id: "cccccccc", kind: "coach", ok: false, error: "boom" });
    expect(await q.status("cccccccc")).toBe("failed");
    expect((await q.result("cccccccc"))?.error).toBe("boom");
  });

  it("빈 큐 claim 은 null", async () => {
    expect(await q.claim()).toBeNull();
  });

  it("recoverClaimed — 크래시로 남은 claimed 를 pending 으로 복구", async () => {
    await q.enqueue(job("dddddddd"));
    await q.claim(); // 처리 중 크래시 가정(complete 안 함)
    expect(await q.recoverClaimed()).toBe(1);
    expect(await q.status("dddddddd")).toBe("pending");
    expect((await q.claim())?.id).toBe("dddddddd"); // 재처리 가능(멱등키)
  });
});
