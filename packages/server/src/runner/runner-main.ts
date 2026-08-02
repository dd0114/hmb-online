import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { EngineConfigOverrides, SimulateRequest } from "@hmb/shared";
import { defaultEngineConfig } from "@hmb/engine";
import { simulate } from "./simulate.js";
import { OverrideError } from "./config-overlay.js";
import { SmokeError, knobCatalog, validateOverrides } from "./config-validate.js";

/**
 * 엔진러너(서번트①) HTTP 엔트리 — 무상태 RPC. env RUNNER_PORT(기본 8790).
 * GET /health → {engineVersion}. POST /simulate → SimulateRequest/Response(zod, shared).
 * 시뮬 경로에 Math.random/Date.now 없음(결정론, §2-5) — simulate.ts 참고.
 *
 * #383 계수 오버레이: GET /config/knobs(오버레이 가능한 리프 전수) · POST /config/validate
 * (드라이런 — server-java admin 이 원장에 쓰기 **전에** 부른다). 러너는 여전히 **무상태**다 —
 * "지금 걸린 오버레이"를 보유하지 않는다. 권위는 Java 하나이고, 러너는 요청에 실린 값만 본다.
 */

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * 오류 본문. `issues` 를 **따로 실어 준다** — 운영자는 curl 로 이걸 읽는다(#383 §9).
 * 문제 여럿을 한 번에 돌려주지 않으면 오타 하나마다 왕복이 한 번씩 는다.
 */
/**
 * `/config/validate` 실패의 HTTP 코드.
 *
 * ⚠️ **모든 예외를 400 으로 뭉개지 않는다**(독립검증 m5). 400 = "운영자가 보낸 값이 문제다",
 * 5xx = "러너가 고장났다" — 합치면 러너 내부 결함이 "계수 검증 실패"로 보고돼 운영자가
 * <b>고칠 수 없는 것을 고치려 든다</b>(계수를 계속 바꿔 보며 헤맨다). 두 상황에서 취할 행동이
 * 완전히 다르므로 코드도 달라야 한다.
 *
 * 함수로 뽑아 둔 이유: 인라인 삼항이면 그 분기에 계약을 걸 자리가 없어 **400 고정으로 되돌려도
 * 전 스위트가 통과했다**(5차 m5 실측).
 */
export function validateStatusFor(e: unknown): number {
  return e instanceof OverrideError || e instanceof SmokeError ? 400 : 500;
}

function errorBody(e: unknown): { error: string; issues?: string[] } {
  const error = e instanceof Error ? e.message : String(e);
  if (e instanceof OverrideError || e instanceof SmokeError) return { error, issues: e.issues };
  return { error };
}

/** 서버 인스턴스 생성(listen 은 호출부 책임 — 테스트에서 임의 포트로 기동 가능). */
export function createRunnerServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";

      if (req.method === "GET" && url === "/health") {
        json(res, 200, { engineVersion: defaultEngineConfig.version });
        return;
      }

      if (req.method === "GET" && url === "/config/knobs") {
        json(res, 200, knobCatalog());
        return;
      }

      if (req.method === "POST" && url === "/config/validate") {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch (e) {
          json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        const parsed = EngineConfigOverrides.optional().safeParse(
          (body as { overrides?: unknown } | null)?.overrides,
        );
        if (!parsed.success) {
          json(res, 400, {
            error: "invalid overrides",
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
          return;
        }
        try {
          json(res, 200, validateOverrides(parsed.data));
        } catch (e) {
          // ⚠️ **모든 예외를 400 으로 뭉치지 않는다**(독립검증 m5). 400 = "운영자가 보낸 값이
          // 문제다", 500 = "러너가 고장났다" — 둘을 합치면 러너 내부 결함이 운영자에게
          // "계수 검증 실패"로 보고돼, 고칠 수 없는 것을 고치려 들게 된다.
          json(res, validateStatusFor(e), errorBody(e));
        }
        return;
      }

      if (req.method === "POST" && url === "/simulate") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          return;
        }

        let rawJson: unknown;
        try {
          rawJson = JSON.parse(raw || "{}");
        } catch (e) {
          json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }

        const parsed = SimulateRequest.safeParse(rawJson);
        if (!parsed.success) {
          json(res, 400, {
            error: "invalid SimulateRequest",
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          });
          return;
        }

        try {
          const response = simulate(parsed.data);
          json(res, 200, response);
        } catch (e) {
          // resumeState 형태 불량/버전 불일치, configOverrides 검증 실패 모두 malformed-request(400).
          json(res, 400, errorBody(e));
        }
        return;
      }

      json(res, 404, { error: "not found" });
    })();
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const PORT = Number(process.env["RUNNER_PORT"] ?? 8790);
  const server = createRunnerServer();
  server.listen(PORT, () => {
    console.log(
      `[@hmb/server runner] :${PORT} (GET /health, POST /simulate) engine=${defaultEngineConfig.version}`,
    );
  });
}
