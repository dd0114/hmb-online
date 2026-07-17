import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SimulateRequest, SimulateResponse } from "@hmb/shared";

/**
 * docs/plan-v2/fixtures/matchlog-h{1,2}.json (server-java WireMock 재생용, 커밋 산출물) 회귀 가드:
 * zod 계약 파싱 + h1→h2 resumeState 승계 정합성. 생성 스크립트/계약이 바뀌어 fixture 가 깨지면 여기서 잡힌다.
 * 재생성: npm run fixtures:runner --workspace=@hmb/server (단축 config 샘플 — fixtures/README.md 참고).
 */

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "docs", "plan-v2", "fixtures",
);

const h1Path = join(FIXTURES_DIR, "matchlog-h1.json");
const h2Path = join(FIXTURES_DIR, "matchlog-h2.json");

describe("published runner fixtures (docs/plan-v2/fixtures)", () => {
  it("matchlog-h1.json / matchlog-h2.json exist (커밋 산출물)", () => {
    expect(existsSync(h1Path)).toBe(true);
    expect(existsSync(h2Path)).toBe(true);
  });

  it("both pairs parse under the shared zod contract and stay under 1MB", () => {
    for (const p of [h1Path, h2Path]) {
      const raw = readFileSync(p, "utf8");
      expect(raw.length).toBeLessThan(1_000_000);
      const pair = JSON.parse(raw) as { request: unknown; response: unknown };
      expect(SimulateRequest.safeParse(pair.request).success).toBe(true);
      expect(SimulateResponse.safeParse(pair.response).success).toBe(true);
    }
  });

  it("h2 request carries h1 response's resumeState (승계 정합)", () => {
    const h1 = JSON.parse(readFileSync(h1Path, "utf8")) as { response: { resumeState: unknown } };
    const h2 = JSON.parse(readFileSync(h2Path, "utf8")) as {
      request: { half: number; resumeState: unknown };
      response: { resumeState?: unknown };
    };
    expect(h2.request.half).toBe(2);
    expect(h2.request.resumeState).toEqual(h1.response.resumeState);
    // 매치 종료 — h2 응답엔 이어갈 resumeState 가 없다.
    expect(h2.response.resumeState).toBeUndefined();
  });
});
