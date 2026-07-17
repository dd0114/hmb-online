import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FileJobQueue } from "./ai/queue.js";
import { ResultCache } from "./ai/cache.js";
import { AiService } from "./ai/service.js";
import { AiWorker } from "./ai/worker.js";
import { createResilientExecutor } from "./ai/executor.js";
import { claudeCodeAuthSelfCheck } from "./ai/executors/claude-code.js";
import { stubExecutor } from "./ai/executors/stub.js";
import { withFallback } from "./ai/executors/resilience.js";
import { CacheMetrics } from "./ai/metrics.js";
import { matchFingerprint, replayFromCache } from "./replay.js";
import { teamStat } from "./matchstats.js";
import { coachContext, runMatchWithHomeInput } from "./pipeline.js";
import type { AiJob } from "./ai/protocol.js";
import type { MatchLog } from "@hmb/shared";

/**
 * 게임서버 엔트리. AI 는 큐 프로토콜 뒤(에픽 #32) — 서버는 executor 를 모른다.
 * env: PORT(8787) · AI_DATA_DIR(.data) · AI_WAIT_MS(30000, /tactical long-poll)
 *      AI_EXECUTOR(stub|claude-code) · AI_INLINE_WORKER(1=서버 프로세스 안에서 워커 폴링, stub 기본 on)
 */
const PORT = Number(process.env["PORT"] ?? 8787);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env["AI_DATA_DIR"] ?? join(PKG_ROOT, ".data");
const WAIT_MS = Number(process.env["AI_WAIT_MS"] ?? 30_000);
const MATCH_WAIT_MS = Number(process.env["AI_MATCH_WAIT_MS"] ?? 180_000); // 라이브 AI 콜(~70s) 여유
const EXECUTOR_KIND = process.env["AI_EXECUTOR"] ?? "stub";
const INLINE_WORKER = (process.env["AI_INLINE_WORKER"] ?? (EXECUTOR_KIND === "stub" ? "1" : "0")) === "1";

const queue = new FileJobQueue(join(DATA_DIR, "ai-queue"));
const cache = new ResultCache(join(DATA_DIR, "ai-cache"));
const metrics = new CacheMetrics(); // W3 AC1: L1 히트율 + L2 프롬프트캐시 계측
const svc = new AiService(queue, cache, metrics);

// 인라인 워커(개발·stub 기본): 별도 프로세스 없이도 end-to-end 동작. 프로덕션 워커는 npm run worker.
if (INLINE_WORKER) {
  if (EXECUTOR_KIND === "claude-code") claudeCodeAuthSelfCheck();
  const worker = new AiWorker(queue, cache, createResilientExecutor({ onUsage: (u) => metrics.recordUsage(u) }));
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

    // 정적 페이지: / = 프롬프트 실험실(핵심 데모), /ops = W3 운영 대시보드.
    const page = url === "/" || url === "/lab" ? "lab.html" : url === "/ops" || url === "/dashboard" ? "dashboard.html" : null;
    if (req.method === "GET" && page) {
      try {
        const html = readFileSync(join(PKG_ROOT, "public", page), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        json(res, 404, { error: `${page} 없음` });
      }
      return;
    }

    if (req.method === "GET" && url === "/health") {
      json(res, 200, {
        ok: true,
        service: "@hmb/server",
        executor: EXECUTOR_KIND,
        fallback: process.env["AI_FALLBACK_EXECUTOR"] ?? null,
        maxRetries: Number(process.env["AI_MAX_RETRIES"] ?? 2),
        inlineWorker: INLINE_WORKER,
      });
      return;
    }

    // W3 AC1: 캐시 계측 리포트(L1 결과캐시 히트율 + L2 프롬프트캐시 토큰).
    if (req.method === "GET" && url === "/metrics") {
      json(res, 200, { cache: metrics.report(), summary: metrics.format() });
      return;
    }

    // W3 AC2: 모델 비교 리포트(npm run compare 가 쓴 것). 대시보드가 표로 렌더.
    if (req.method === "GET" && url === "/compare-report") {
      try {
        json(res, 200, JSON.parse(readFileSync(join(DATA_DIR, "compare-report.json"), "utf8")));
      } catch {
        json(res, 404, { error: "리포트 없음 — `npm run compare -w @hmb/server` 먼저 실행", hint: "AI_COMPARE_MODELS=sonnet,haiku" });
      }
      return;
    }

    // W3 AC5: 리플레이 계약 검증 — 저장 input 재실행이 같은 지문을 내는지(대시보드 ✅).
    const replayMatch = /^\/replay\/([0-9a-f]+)$/.exec(url);
    if (req.method === "GET" && replayMatch) {
      const id = replayMatch[1]!;
      try {
        const a = matchFingerprint(await replayFromCache(cache, id, "4815162342"));
        const b = matchFingerprint(await replayFromCache(cache, id, "4815162342"));
        json(res, 200, { id, reproducible: a.lastHash === b.lastHash, fingerprint: a, second: b });
      } catch (e) {
        json(res, 404, { id, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // W3 AC4: 폴백 데모 — primary 를 강제 CAP 시키고 stub 폴백이 무중단 서빙함을 시연.
    if (req.method === "POST" && url === "/fallback-demo") {
      try {
        const raw = await readBody(req);
        const { directive = "풀백 오버랩·와이드", seed = "4815162342" } = JSON.parse(raw || "{}") as { directive?: string; seed?: string };
        const cappedPrimary = { name: "claude-code:sonnet(강제CAP)", execute: (): Promise<unknown> => Promise.reject(new Error("CAP: usage limit reached (demo)")) };
        let servedBy = "primary";
        const ex = withFallback(cappedPrimary, stubExecutor(), () => (servedBy = "fallback:stub"));
        const job: AiJob = { id: "fallback-demo", kind: "coach", context: coachContext(directive, seed), enqueuedAt: "demo" };
        const out = await ex.execute(job);
        const players = (out as { players?: unknown[] }).players?.length ?? 0;
        json(res, 200, { primaryError: "CAP: usage limit reached (demo)", servedBy, ok: true, players, note: "잡은 큐에 남고 executor 만 폴백 — 게임서버 무중단" });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
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

    // 뷰 레이어(HMB 핵심): 선수별 프롬프트 → 라이브 AI → 결정론 시뮬 → 전체 MatchLog + 스탯.
    // A/B 실험실이 같은 seed 로 두 프롬프트 세트를 돌려 "경기가 실제로 달라짐" 을 재생·비교한다.
    if (req.method === "POST" && url === "/match") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as { directive?: string; seed?: string; playerPrompts?: Record<string, string>; sample?: number };
        const seed = body.seed ?? "4815162342";
        const directive = body.directive?.trim() || "균형 잡힌 기본 전술.";
        const ctx = coachContext(directive, seed, body.playerPrompts);
        const r = await svc.request("coach", ctx);
        let output: unknown;
        let cached = false;
        if (r.status === "cached") {
          output = r.output;
          cached = true;
        } else {
          const result = await svc.awaitResult(r.id, MATCH_WAIT_MS);
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
        const log = runMatchWithHomeInput(output, seed);
        json(res, 200, {
          jobId: r.id,
          cached,
          seed,
          input: output, // AI 가 만든 TacticalInput(선수별 behavior — 프롬프트가 파라미터로 번역된 증거)
          finalScore: log.finalScore,
          home: teamStat(log, "home"),
          away: teamStat(log, "away"),
          frames: downsample(log, Number(body.sample ?? 3)), // 재생용 경량 스냅샷
        });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  })();
});

/** 재생용 경량 프레임 — n틱마다 하나, hash/minute 제거하고 좌표만. */
function downsample(log: MatchLog, n: number): Array<{ t: number; ball: { x: number; y: number }; owner: string | null; players: Array<{ id: string; team: string; x: number; y: number }> }> {
  const step = Math.max(1, n | 0);
  const out = [];
  for (let i = 0; i < log.tickSnapshots.length; i += step) {
    const s = log.tickSnapshots[i]!;
    out.push({
      t: s.tick,
      ball: { x: s.ball.x, y: s.ball.y },
      owner: s.ballOwner,
      players: s.players.map((p) => ({ id: p.playerId, team: p.team, x: p.pos.x, y: p.pos.y })),
    });
  }
  return out;
}

server.listen(PORT, () => {
  console.log(
    `[@hmb/server] :${PORT} (GET /health, POST /tactical, GET /jobs/:id) executor=${EXECUTOR_KIND} inlineWorker=${INLINE_WORKER} data=${DATA_DIR}`,
  );
});
