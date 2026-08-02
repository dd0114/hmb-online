import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SimulateRequest, SimulateResponse, EngineConfigOverrides } from "./simulate.js";

/**
 * #383 W1 — `configOverrides`/`effectiveConfigHash` **additive optional** 계약 (T-S1·T-S2).
 *
 * 이 파일이 지키는 것 하나: **구 서버·구 러너 조합이 계속 통과한다.** 계약을 additive 로 여는
 * 것이 이 웨이브를 W2/W3 과 독립적으로 머지 가능하게 만드는 유일한 근거다.
 *
 * 그래서 T-S1 은 손으로 지어낸 최소 객체가 아니라 **커밋된 발행 픽스처**
 * (`docs/plan-v2/fixtures/matchlog-h1.json` — server-java WireMock 이 재생하는 바로 그 바이트)로
 * 판정한다. 지어낸 객체는 스키마가 좁아지면 같이 좁아져 "구 요청이 통과한다"를 증명하지 못한다.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "docs", "plan-v2", "fixtures", "matchlog-h1.json",
);

const pair = JSON.parse(readFileSync(FIXTURE, "utf8")) as { request: unknown; response: unknown };

describe("T-S1 additive — 오버레이 이전에 발행된 요청/응답이 그대로 통과", () => {
  it("발행 픽스처 요청(configOverrides 없음)이 통과한다", () => {
    const parsed = SimulateRequest.safeParse(pair.request);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.configOverrides).toBeUndefined();
  });

  it("발행 픽스처 응답(effectiveConfigHash 없음)이 통과한다 — 구 러너 호환", () => {
    const parsed = SimulateResponse.safeParse(pair.response);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.effectiveConfigHash).toBeUndefined();
  });

  it("같은 요청에 오버레이를 얹어도 통과한다(새 필드가 기존 필드를 막지 않는다)", () => {
    const withOverlay = { ...(pair.request as object), configOverrides: { "contest.shootRange": 19 } };
    expect(SimulateRequest.safeParse(withOverlay).success).toBe(true);
  });
});

describe("T-S2 값 타입 — number|boolean 만", () => {
  const req = (configOverrides: unknown) => ({ ...(pair.request as object), configOverrides });

  it("number·boolean 오버레이는 통과", () => {
    expect(SimulateRequest.safeParse(req({ "contest.shootRange": 19, "vision.enabled": false })).success)
      .toBe(true);
  });

  it("문자열·객체·배열·null 값은 거부 — 계수가 아닌 것이 계수 자리로 들어오지 못한다", () => {
    for (const bad of [{ "a.b": "19" }, { "a.b": { c: 1 } }, { "a.b": [1] }, { "a.b": null }]) {
      expect(SimulateRequest.safeParse(req(bad)).success).toBe(false);
    }
  });

  it("빈 맵은 유효하다 — '오버레이 없음'을 명시하는 정상 표현이다(롤백 경로)", () => {
    expect(EngineConfigOverrides.safeParse({}).success).toBe(true);
  });

  it("경로 문자열의 **모양은 여기서 판정하지 않는다** — 유효 경로는 엔진을 손에 든 러너만 안다", () => {
    // 계약 레이어에서 정규식으로 흉내내면 엔진이 바뀔 때 조용히 어긋난다(진실이 두 곳에 적힌다).
    expect(EngineConfigOverrides.safeParse({ "무엇이든.문자열": 1 }).success).toBe(true);
  });
});
