import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig } from "@hmb/engine";
import { createRunnerServer } from "./runner-main.js";

/**
 * #383 W1 — 러너 HTTP 표면 (T-R3 매핑 · T-R7 validate/knobs).
 * server-java admin 이 실제로 부르는 모양 그대로 소켓 왕복한다.
 */
describe("runner HTTP — 계수 오버레이 (#383)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createRunnerServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET /config/knobs — 오버레이 가능한 경로 전수 + 현재 기본값", async () => {
    const res = await fetch(`${base}/config/knobs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engineVersion: string;
      knobs: { path: string; type: string; value: number | boolean }[];
    };
    expect(body.engineVersion).toBe(defaultEngineConfig.version);
    expect(body.knobs.length).toBeGreaterThan(100);
    const shootRange = body.knobs.find((k) => k.path === "contest.shootRange");
    expect(shootRange).toEqual({
      path: "contest.shootRange",
      type: "number",
      value: defaultEngineConfig.contest.shootRange,
    });
    // 구조 경로는 목록에 없다 — 운영자가 "왜 400 이지"를 겪기 전에 목록에서부터 안 보인다.
    expect(body.knobs.some((k) => k.path === "version" || k.path.startsWith("pitch."))).toBe(false);
  });

  it("POST /config/validate — 정상값이면 200 + changed diff + 스모크 결과", async () => {
    const res = await post("/config/validate", {
      overrides: { "contest.shootRange": 22 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      effectiveConfigHash: string;
      changed: { path: string; from: number; to: number }[];
      smoke: { seed: string; events: number; passEventsHome: number; passEventsAway: number }[];
    };
    expect(body.changed).toEqual([
      { path: "contest.shootRange", from: defaultEngineConfig.contest.shootRange, to: 22 },
    ]);
    expect(body.effectiveConfigHash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.smoke.length).toBe(2);
    for (const s of body.smoke) {
      expect(s.events).toBeGreaterThan(0);
      expect(s.passEventsHome).toBeGreaterThan(0);
      expect(s.passEventsAway).toBeGreaterThan(0);
    }
  });

  it("POST /config/validate — 빈 오버레이도 200(현행 그대로가 유효한 상태다 = 롤백 경로)", async () => {
    const res = await post("/config/validate", { overrides: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: unknown[] }).changed).toEqual([]);
  });

  it("POST /config/validate — 오타 경로는 400 + issues 에 그 경로가 찍힌다", async () => {
    const res = await post("/config/validate", { overrides: { "contest.shootXgThreshhold": 0.07 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.issues.join(" ")).toContain("contest.shootXgThreshhold");
  });

  it("POST /config/validate — 값 타입이 계약 밖(문자열)이면 400", async () => {
    const res = await post("/config/validate", { overrides: { "contest.shootRange": "22" } });
    expect(res.status).toBe(400);
  });

  it("POST /config/validate — **경기가 성립하지 않는 값**은 400 (스모크 게이트 발화, T-R7 후반)", async () => {
    // 이 스모크는 배포 게이트를 없앤 대가로 존재하는 **유일한 대체 게이트**다(AC5). 경로/타입
    // 오류만 테스트하면 이 게이트가 조용히 죽어도 아무 데서도 빨간불이 안 켜진다(독립검증 M4).
    // matchMinutes=1 은 경로도 타입도 멀쩡하다 — 돌려 봐야만 "경기가 안 된다"를 알 수 있다.
    const res = await post("/config/validate", { overrides: { matchMinutes: 1 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues.join(" ")).toMatch(/패스가 0건|이벤트가 하나도|소유자가 한 번도|예외로 죽었/);
  });

  it("POST /config/validate — 무효 노브(#338)는 400 (죽은 노브를 '적용됨'으로 보이게 하지 않는다)", async () => {
    const res = await post("/config/validate", { overrides: { "decisionWeights.shoot": 0.2 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: string[] }).issues.join(" ")).toContain("실행 경로가 없는 노브");
  });

  it("GET /config/knobs — 무효 노브는 settable 목록이 아니라 `inertKnobs` 에 사유와 함께 있다", async () => {
    const body = (await (await fetch(`${base}/config/knobs`)).json()) as {
      knobs: { path: string }[];
      inertKnobs: { path: string; reason: string }[];
    };
    expect(body.knobs.some((k) => k.path === "decisionWeights.shoot")).toBe(false);
    const inert = body.inertKnobs.find((k) => k.path === "decisionWeights.shoot");
    expect(inert?.reason).toContain("실행 경로가 없다");
  });

  it("POST /simulate — 잘못된 오버레이는 400 + issues (500 이 아니다)", async () => {
    const res = await post("/simulate", {
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 1,
      configOverrides: { "nope.nope": 1 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: string[] }).issues.join(" ")).toContain("nope.nope");
  });

  it("POST /simulate — 유효한 오버레이는 200 + effectiveConfigHash 동반", async () => {
    const body = {
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 1,
    };
    const plain = await (await post("/simulate", body)).json() as { lastHash: string; effectiveConfigHash: string };
    const tuned = await (await post("/simulate", { ...body, configOverrides: { "contest.shootRange": 40 } }))
      .json() as { lastHash: string; effectiveConfigHash: string };

    expect(tuned.lastHash).not.toBe(plain.lastHash);
    expect(tuned.effectiveConfigHash).not.toBe(plain.effectiveConfigHash);
  });
});
