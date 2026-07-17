import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { demoSeed, demoHome, demoAway, demoSelect } from "@hmb/engine";
import type { SimulateRequest, SimulateResponse } from "@hmb/shared";
import { createRunnerServer } from "./runner-main.js";

/** HTTP 레이어(zod 파싱·400·health) 검증 — 실제 소켓으로 왕복(임의 포트). */
describe("runner HTTP (GET /health, POST /simulate)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createRunnerServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("GET /health returns engineVersion", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engineVersion: string };
    expect(body.engineVersion).toMatch(/^engine@/);
  });

  it("POST /simulate half=1 round-trips a valid SimulateResponse", async () => {
    const request: SimulateRequest = {
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 1,
    };
    const res = await fetch(`${base}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SimulateResponse;
    expect(body.matchLog.tickSnapshots.length).toBeGreaterThan(0);
    expect(body.resumeState).toBeDefined();
    expect(body.lastHash).toBe(
      body.matchLog.tickSnapshots[body.matchLog.tickSnapshots.length - 1]!.hash,
    );
  });

  it("POST /simulate with malformed body → 400 with zod error summary", async () => {
    const res = await fetch(`${base}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: "42", half: 3 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe("invalid SimulateRequest");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });

  it("POST /simulate with invalid JSON body → 400", async () => {
    const res = await fetch(`${base}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("unknown route → 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
