// cardart-preview.mjs — #187 카드 풀아트 배치안 **로컬 프리뷰** 한 방 실행.
//
//   vite dev (127.0.0.1:8161) 만 띄운다. 목 API·백엔드·엔진 전부 불필요 —
//   `/design/cards` 는 정적 에셋(`/chars/**`)만 쓰고 API 를 한 번도 부르지 않는다.
//
// 실행: cd apps/web && npm run cardart:preview
//   포트 변경: CARDART_PORT=9161 npm run cardart:preview
//
// 다른 세션 프리뷰(8131/8132 = #169 관전)와 포트가 겹치지 않게 8161 을 고정으로 쓴다.
// 종료는 이 프로세스 PID 로만 한다(패턴 kill 금지 — 다른 세션 스택을 죽인다).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const PORT = Number(process.env.CARDART_PORT ?? 8161);

const child = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: webRoot,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});

child.on("exit", (code) => process.exit(code ?? 0));
const stop = () => {
  if (child.exitCode == null) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(
  [
    "",
    "[cardart-preview] #187 카드 풀아트 배치안 프리뷰",
    `  · 데스크탑  http://localhost:${PORT}/design/cards`,
    `  · 모바일390 http://localhost:${PORT}/design/cards?frame=phone`,
    `  · 섹션 직행 ?s=matrix | gacha | codex | deck | trade | icons`,
    "  종료: Ctrl-C (또는 이 프로세스 PID 로 kill — 패턴 kill 금지)",
    "",
  ].join("\n"),
);
