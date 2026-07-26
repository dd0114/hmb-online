// design-preview.mjs — S1 관전 화면(#169) 디자인 리뷰용 **로컬 서버 한 방 실행**.
//
//   목 API 서버(127.0.0.1:8132) + vite dev(127.0.0.1:8131, /api → 목 서버 프록시)
//
// 실행: cd apps/web && npm run design:preview
//   포트 변경: DESIGN_PORT=9131 DESIGN_MOCK_PORT=9132 npm run design:preview
//
// 백엔드(server-java)·엔진 실행 불필요. 로컬 전용이며 배포와 무관하다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

const PORT = Number(process.env.DESIGN_PORT ?? 8131);
const MOCK_PORT = Number(process.env.DESIGN_MOCK_PORT ?? 8132);

// DESIGN_LOG=real 이면 리얼 config 풀매치 픽스처를 먹인다(목 서버와 같은 규약).
const REAL_LOG = (process.env.DESIGN_LOG ?? "").toLowerCase() === "real";
const LOG_FILE = REAL_LOG
  ? join(repoRoot, "packages", "engine", "dev-viewer", "e2e", "fixture-real.json")
  : join(repoRoot, "packages", "engine", "dev-viewer", "match-log.json");
if (!existsSync(LOG_FILE)) {
  console.error(
    REAL_LOG
      ? "[design-preview] fixture-real.json 이 없다 → `npx vitest run packages/engine/dev-viewer/e2e/gen-fixtures.test.ts`"
      : "[design-preview] match-log.json 이 없다 → 먼저 `npm run build:viewer` 를 돌려라.",
  );
  process.exit(1);
}

const children = [];
function run(label, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: webRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => {
    console.log(`[design-preview] ${label} 종료(code ${code}) — 전체를 내린다.`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  // 패턴 kill 금지 — 내가 띄운 PID 만 정확히 내린다(다른 세션 프로세스 보호).
  for (const c of children) {
    if (c.exitCode == null) c.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("mock-api", process.execPath, [join(here, "design-mock-server.mjs"), "--port", String(MOCK_PORT)]);
run(
  "vite",
  "npx",
  ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
  { VITE_API_TARGET: `http://127.0.0.1:${MOCK_PORT}` },
);

console.log(
  [
    "",
    "[design-preview] 관전 화면(S1) 디자인 프리뷰",
    `  · 데스크탑   http://localhost:${PORT}/design/stage`,
    `  · 모바일     http://localhost:${PORT}/design/stage?frame=phone`,
    `  · 상태 전환  ?state=FIRST_HALF | H1_BREAK | FINISHED  (화면 우하단 칩으로도 전환)`,
    `  · 제품 경로  http://localhost:${PORT}/match/h1break , /match/finished`,
    "  종료: Ctrl-C",
    "",
  ].join("\n"),
);
