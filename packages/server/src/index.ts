import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FileJobQueue } from "./ai/queue.js";
import { ResultCache } from "./ai/cache.js";
import { AiService } from "./ai/service.js";
import { AiWorker } from "./ai/worker.js";
import { createExecutor } from "./ai/executor.js";
import { coachContext, runMatchWithHomeInput } from "./pipeline.js";

/**
 * 게임서버 엔트리. AI 는 큐 프로토콜 뒤(에픽 #32) — 서버는 executor 를 모른다.
 * env: PORT(8787) · AI_DATA_DIR(.data) · AI_WAIT_MS(30000, /tactical long-poll)
 *      AI_EXECUTOR(stub|claude-code) · AI_INLINE_WORKER(1=서버 프로세스 안에서 워커 폴링, stub 기본 on)
 */
const PORT = Number(process.env["PORT"] ?? 8787);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env["AI_DATA_DIR"] ?? join(PKG_ROOT, ".data");
const WAIT_MS = Number(process.env["AI_WAIT_MS"] ?? 30_000);
const EXECUTOR_KIND = process.env["AI_EXECUTOR"] ?? "stub";
const INLINE_WORKER = (process.env["AI_INLINE_WORKER"] ?? (EXECUTOR_KIND === "stub" ? "1" : "0")) === "1";

const queue = new FileJobQueue(join(DATA_DIR, "ai-queue"));
const cache = new ResultCache(join(DATA_DIR, "ai-cache"));
const svc = new AiService(queue, cache);

// 인라인 워커(개발·stub 기본): 별도 프로세스 없이도 end-to-end 동작. 프로덕션 워커는 npm run worker.
if (INLINE_WORKER) {
  const worker = new AiWorker(queue, cache, createExecutor(EXECUTOR_KIND));
  void worker.runLoop(300).catch((e) => console.error("[inline-worker] 종료:", e));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") {
      json(res, 200, { ok: true, service: "@hmb/server", executor: EXECUTOR_KIND, inlineWorker: INLINE_WORKER });
      return;
    }

    // AI 판단 잡 상태/결과 조회(202 를 받은 클라이언트 폴링용).
    const jobMatch = /^\/jobs\/([0-9a-f]+)$/.exec(url);
    if (req.method === "GET" && jobMatch) {
      const id = jobMatch[1]!;
      const status = await queue.status(id);
      const result = await queue.result(id);
      json(res, 200, { id, status, result });
      return;
    }

    if (req.method === "POST" && url === "/tactical") {
      try {
        const raw = await readBody(req);
        const { directive, seed = "4815162342" } = JSON.parse(raw || "{}") as { directive?: string; seed?: string };
        if (!directive) {
          json(res, 400, { error: "directive(감독 지시) 필요" });
          return;
        }
        const ctx = coachContext(directive, seed);
        const r = await svc.request("coach", ctx);
        let output: unknown;
        let cached = false;
        if (r.status === "cached") {
          output = r.output;
          cached = true;
        } else {
          const result = await svc.awaitResult(r.id, WAIT_MS);
          if (!result) {
            json(res, 202, { jobId: r.id, status: "queued", hint: `GET /jobs/${r.id}` });
            return;
          }
          if (!result.ok) {
            json(res, 502, { jobId: r.id, error: result.error ?? "AI 실패" });
            return;
          }
          output = result.output;
        }
        const log = runMatchWithHomeInput(output, seed); // 결정론 시뮬(서버 권위)
        json(res, 200, {
          jobId: r.id,
          cached,
          finalScore: log.finalScore,
          events: log.events.length,
          ticks: log.tickSnapshots.length,
        });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  })();
});

server.listen(PORT, () => {
  console.log(
    `[@hmb/server] :${PORT} (GET /health, POST /tactical, GET /jobs/:id) executor=${EXECUTOR_KIND} inlineWorker=${INLINE_WORKER} data=${DATA_DIR}`,
  );
});
