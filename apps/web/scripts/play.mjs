// play.mjs — "클론해서 바로 플레이" 진입점 (#444).
//
// 백엔드·DB·Java 없이 web 을 **스태틱 모드**로 띄운다(GitHub Pages 빌드와 같은 경로).
// `--ai` 를 주면 로컬 AI 브리지(scripts/ai-bridge.ts)를 같이 띄워 Claude Code 로그인이 있는 사람은
// 프롬프트가 실제 AI 전술 인풋이 되게 한다 — 로그인이 없으면 웹이 알아서 스태틱 폴백 + 안내다.
//
// 두 프로세스를 한 커맨드로 묶는 이유는 편의가 아니라 **정리**다: 터미널을 닫으면 브리지도 같이
// 죽어야 한다(안 그러면 브리지 포트를 물고 있는 유령이 다음 실행을 막는다).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..");
const withAi = process.argv.includes("--ai");
const bridgePort = process.env.HMB_AI_BRIDGE_PORT ?? "8801"; // 8790대는 엔진 러너가 쓴다
const webPort = process.env.HMB_PLAY_PORT ?? "5180";

const children = [];

function run(cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: webDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
}
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);

if (withAi) {
  run("npx", ["tsx", "scripts/ai-bridge.ts"], { HMB_AI_BRIDGE_PORT: bridgePort });
}

// 캐릭터 아트 스테이징(기존 predev 훅과 같은 것) → dev 서버.
run("node", ["scripts/ensure-chars.mjs"], {}).on("close", () => {
  const vite = run("npx", ["vite", "--port", webPort, "--strictPort"], {
    VITE_STATIC_MODE: "1",
    ...(withAi ? { VITE_AI_BRIDGE_URL: `http://127.0.0.1:${bridgePort}` } : {}),
  });
  vite.on("close", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
});
