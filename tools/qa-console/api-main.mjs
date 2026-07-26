#!/usr/bin/env node
// QA 콘솔 API 진입점 (#191). `tools/qa-console.mjs start` 가 detached 로 띄운다.
// 서버 로직은 server.mjs(테스트 대상) — 여기는 배선만 둔다.
import { createApiServer, listen } from "./server.mjs";
import { registryHome } from "./registry.mjs";

const port = Number(process.env.HMB_QA_API_PORT ?? 8301);
const home = registryHome();
const server = createApiServer({ home });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // 열린 커넥션이 붙잡고 있어도 확실히 내려간다(콘솔은 재기동이 흔한 도구다).
    setTimeout(() => process.exit(0), 1500);
  });
}

const bound = await listen(server, port);
process.stdout.write(`[qa-api] 127.0.0.1:${bound} · 레지스트리 ${home}\n`);
