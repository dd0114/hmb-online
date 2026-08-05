/**
 * 로컬 AI 브리지 (#444) — "Claude Code 로그인이 되어 있으면 프롬프트가 AI 전술이 된다".
 *
 * <b>이 스크립트는 새 AI 파이프라인이 아니다.</b> 브라우저(스태틱 모드)는 잡 컨텍스트만 보내고,
 * 여기서는 기존 자산을 그대로 부른다:
 *   · `claudeCodeExecutor`  — `claude` CLI 서브프로세스(정액제 구독, ADR-1)
 *   · `KINDS["team-input"]` — 프롬프트 빌드 + 산출 검증 게이트(`prompt/coach.ts`)
 * 실패하면 브라우저가 **스태틱 폴백**(`stubExecutor`)으로 내려가고 화면엔 안내 배너만 뜬다 —
 * 즉 이 프로세스가 죽어 있어도 게임은 끝까지 플레이된다(hero 지시).
 *
 * 기동: `npm run play:ai` (apps/web) — web dev 서버와 이 브리지를 같이 띄운다.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { claudeCodeExecutor } from "../../../packages/server/src/executor/executors/claude-code.js";
import { KINDS, type ExecutorJob } from "../../../packages/server/src/executor/kinds.js";

const PORT = Number(process.env["HMB_AI_BRIDGE_PORT"] ?? 8791);
/** 브라우저(다른 오리진: vite dev 5173 / preview 4181)가 부르므로 CORS 를 연다. 로컬 전용이다. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

/**
 * `claude` CLI 가 있고 **로그인돼 있는가**. 실행 가능 여부만 보는 게 아니라 실제로 한 마디
 * 물어본다 — 설치돼 있는데 로그인이 안 된 상태가 이 기능의 핵심 분기이기 때문이다.
 * 실패는 전부 "로그인 안 됨"으로 흡수한다(사유만 남긴다).
 */
function probeClaude(): Promise<{ loggedIn: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ loggedIn: false, reason: "probe timeout" });
    }, 30_000);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ loggedIn: false, reason: "claude CLI not found" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve({ loggedIn: true });
      else resolve({ loggedIn: false, reason: (err || `exit ${code}`).slice(0, 200) });
    });
    child.stdin.end("ping");
  });
}

/**
 * ⚠️ **기동 시점에 미리 확인한다.** 요청을 받고 나서 확인하면 첫 `/ai/health` 가 CLI 왕복만큼
 * 늦고(실측 수 초~30초), 브라우저 쪽 프로브는 그보다 훨씬 짧은 상한을 건다 — 그러면 브리지가
 * **살아 있는데도** 웹이 "브리지 없음"으로 판정해 스태틱 폴백으로 내려간다(실제로 그랬다).
 */
let health: Promise<{ loggedIn: boolean; reason?: string }> | null = null;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/ai/health") {
      health ??= probeClaude();
      const h = await health;
      send(res, 200, {
        loggedIn: h.loggedIn,
        model: process.env["AI_MODEL"] ?? "sonnet",
        ...(h.reason ? { reason: h.reason } : {}),
      });
      return;
    }

    if (url.pathname === "/ai/team-input" && req.method === "POST") {
      try {
        const body = (await readBody(req)) as { context?: unknown };
        const context = body.context;
        const spec = KINDS["team-input"];
        // 컨텍스트 형태부터 본다 — 여기서 걸러야 CLI 왕복 비용을 안 쓴다(executor-loop 와 같은 순서).
        spec.contextSchema.parse(context);
        const job: ExecutorJob = { id: "static-mode", kind: "team-input", context };
        const raw = await claudeCodeExecutor().execute(job);
        // 검증 게이트도 기존 것 그대로 — 통과 못 하면 브라우저가 스태틱 폴백으로 내려간다.
        send(res, 200, spec.validate(raw, context));
      } catch (e) {
        send(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    send(res, 404, { error: "not found" });
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ai-bridge] http://127.0.0.1:${PORT}  (health: /ai/health)`);
  console.log("[ai-bridge] claude 로그인 상태를 확인합니다 — 안 되어 있으면 웹은 스태틱 모드로 진행합니다.");
  health ??= probeClaude();
  void health.then((h) =>
    console.log(
      h.loggedIn
        ? "[ai-bridge] ✅ 로그인 확인 — 프롬프트가 AI 전술 인풋이 됩니다."
        : `[ai-bridge] ⚠️ 로그인 없음(${h.reason ?? "unknown"}) — 웹은 스태틱 엔진 계산으로 진행합니다.`,
    ),
  );
});
