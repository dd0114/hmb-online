import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { SimulateRequest } from "@hmb/shared";
import { defaultEngineConfig } from "@hmb/engine";
import { simulate } from "./simulate.js";

/**
 * 엔진러너(서번트①) HTTP 엔트리 — 무상태 RPC. env RUNNER_PORT(기본 8790).
 * GET /health → {engineVersion}. POST /simulate → SimulateRequest/Response(zod, shared).
 * 시뮬 경로에 Math.random/Date.now 없음(결정론, §2-5) — simulate.ts 참고.
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

/** 서버 인스턴스 생성(listen 은 호출부 책임 — 테스트에서 임의 포트로 기동 가능). */
export function createRunnerServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";

      if (req.method === "GET" && url === "/health") {
        json(res, 200, { engineVersion: defaultEngineConfig.version });
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
          // resumeState 형태 불량/버전 불일치 등도 malformed-request 취급(§ malformed → 400).
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
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
