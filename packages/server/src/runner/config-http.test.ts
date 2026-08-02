import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig } from "@hmb/engine";
import { createRunnerServer, validateStatusFor } from "./runner-main.js";
import { OverrideError } from "./config-overlay.js";
import { SmokeError, smokeIssues } from "./config-validate.js";

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

  it("스모크 게이트가 **판정을 한다** — 경기가 성립하지 않는 결과를 통과시키지 않는다 (T-R7 후반)", () => {
    // 이 스모크는 배포 게이트를 없앤 대가로 존재하는 **유일한 대체 게이트**다(AC5). 경로/타입
    // 오류만 테스트하면 게이트가 조용히 죽어도 아무 데서도 빨간불이 안 켜진다(독립검증 M4).
    //
    // ⚠️ 원래 이 계약은 `{"matchMinutes":1}` 로 게이트를 태웠다. 그런데 `matchMinutes` 가 거부
    // 목록으로 가면서(W0 부록 2항) **게이트를 발화시킬 오버레이 입력이 없어졌다** — 극단값을
    // 넣어도 엔진이 이벤트·패스·소유 전환을 계속 만든다(실측: speed.maxPerTick:0 ·
    // ball.passSpeed:0 · contest.passBase:0 전부 ev≈200~450). 엔진이 견고한 것은 좋은 일이지만
    // 그 때문에 게이트가 관측 불가가 되면 M4 로 되돌아간다. 그래서 **판정 자체**를 태운다.
    for (const broken of [
      { seed: "s", ticks: 0, events: 0, passEventsHome: 0, passEventsAway: 0, ownerChanges: 0 },
      { seed: "s", ticks: 100, events: 0, passEventsHome: 1, passEventsAway: 1, ownerChanges: 1 },
      { seed: "s", ticks: 100, events: 10, passEventsHome: 0, passEventsAway: 1, ownerChanges: 1 },
      { seed: "s", ticks: 100, events: 10, passEventsHome: 1, passEventsAway: 0, ownerChanges: 1 },
      { seed: "s", ticks: 100, events: 10, passEventsHome: 1, passEventsAway: 1, ownerChanges: 0 },
    ]) {
      expect(smokeIssues(broken).length, `${JSON.stringify(broken)} 가 통과했다`).toBeGreaterThan(0);
    }
    // 정상 결과는 통과시킨다 — 게이트가 전부를 막으면 기능이 죽는다.
    expect(smokeIssues({ seed: "s", ticks: 1350, events: 300, passEventsHome: 100, passEventsAway: 100, ownerChanges: 400 }))
      .toEqual([]);
  });

  it("POST /config/validate — 무효 노브(#338)는 400 (죽은 노브를 '적용됨'으로 보이게 하지 않는다)", async () => {
    const res = await post("/config/validate", { overrides: { "decisionWeights.shoot": 0.2 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: string[] }).issues.join(" ")).toContain("실행 경로가 없는 노브");
  });

  it("GET /config/knobs — 목록이 **실효를 보장하지 않는다**는 단서가 응답에 실린다 (독립검증 M5)", async () => {
    // 이 목록은 엔진 #338 **등재분**만 거른다. 등재 밖에도 무효 노브가 15개 더 있다(#393).
    // 단서를 문서에만 두면 API 소비자는 목록을 전수로 믿는다 — 그게 이 웨이브가 인용한 사고의 형태다.
    const body = (await (await fetch(`${base}/config/knobs`)).json()) as { caveat?: string };
    expect(body.caveat, "단서가 사라졌다 — 목록이 '실효 보장'으로 읽힌다").toBeTruthy();
    expect(body.caveat).toContain("실제 경기 관측");
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

  it("`/config/validate` 실패 분류 — 값 문제만 400, 러너 결함은 500 (독립검증 m5)", () => {
    // 이 분기가 인라인 삼항이었을 땐 400 고정으로 되돌려도 전 스위트가 통과했다. 러너에
    // 내부 결함을 주입할 손잡이가 없으므로 **분류 함수 자체**를 계약으로 건다.
    expect(validateStatusFor(new OverrideError(["x"]))).toBe(400);
    expect(validateStatusFor(new SmokeError(["y"]))).toBe(400);
    expect(validateStatusFor(new Error("러너가 터졌다")), "러너 결함을 400 으로 말하면 운영자가 " +
      "고칠 수 없는 것을 고치려 든다").toBe(500);
    expect(validateStatusFor(new TypeError("undefined is not a function"))).toBe(500);
  });

  it("POST /simulate — 미지 경로는 **200 + droppedOverrides**(400 이 아니다, B3)", async () => {
    // 재생 경로다. 400 을 내면 그 오버레이가 박힌 진행 중 매치가 FAILED 가 되고, 원장의 현재
    // 리비전이 그 키를 든 한 신규 매치도 전부 h1 에서 죽는다(자동 복구 경로 0). 노브 삭제는
    // 엔진 열차의 정상 활동이라 그 정상 활동이 게임 루프를 멈추면 안 된다.
    const res = await post("/simulate", {
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 1,
      configOverrides: { "nope.nope": 1 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { droppedOverrides?: { path: string; reason: string }[] };
    expect(body.droppedOverrides?.map((d) => d.path)).toEqual(["nope.nope"]);
  });

  it("POST /config/validate — `matchMinutes` 는 **구조 경로**라 400 (W0 부록 2항)", async () => {
    const res = await post("/config/validate", { overrides: { matchMinutes: 100000 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: string[] }).issues.join(" ")).toContain("구조 경로");
  });

  it("POST /simulate — 그 값이 이미 박혀 있으면 **200 + 버림**(진행 중 매치를 죽이지 않는다)", async () => {
    const res = await post("/simulate", {
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 1,
      configOverrides: { matchMinutes: 100000 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { droppedOverrides?: { path: string }[] };
    expect(body.droppedOverrides?.map((d) => d.path)).toEqual(["matchMinutes"]);
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
