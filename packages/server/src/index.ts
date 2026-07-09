import { createServer, type IncomingMessage } from "node:http";
import { runFromDirective } from "./pipeline.js";

// 서버 권위 엔트리(스켈레톤). 환경이 "일하는" 최소치: /health 로 기동 확인, /tactical 로 파이프라인 배선.
// 실제 프롬프트→TacticalInput(Claude) 은 S3b 서버 트랙이 coach.ts 에 채운다.
const PORT = Number(process.env.PORT ?? 8787);

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "@hmb/server", version: "0.0.1" }));
      return;
    }
    if (req.method === "POST" && url === "/tactical") {
      try {
        const raw = await readBody(req);
        const { directive, seed } = JSON.parse(raw || "{}") as { directive?: string; seed?: string };
        if (!directive) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "directive(감독 지시) 필요" }));
          return;
        }
        const log = await runFromDirective(directive, seed ?? "4815162342");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ finalScore: log.finalScore, events: log.events.length, ticks: log.tickSnapshots.length }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const notImpl = msg.startsWith("NOT_IMPLEMENTED");
        res.writeHead(notImpl ? 501 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  })();
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[@hmb/server] listening on :${PORT}  (GET /health, POST /tactical)`);
});
