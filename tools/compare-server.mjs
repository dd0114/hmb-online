#!/usr/bin/env node
// #279 볼 소유자 결정 코어 A/B 비교본 — 로컬 정적 서버.
//
// 왜 file:// 이 아니라 서버인가: 비교 페이지가 두 뷰어를 **iframe 으로 넣고 부모에서 동시 제어**한다.
// file:// 에서는 iframe 이 서로 다른 오리진(opaque)으로 취급돼 `contentWindow.__viewer` 접근이
// 막힌다 → 동시 재생·재동기화가 동작하지 않는다. 같은 http 오리진이면 그대로 된다.
//
// 실행: node tools/compare-server.mjs [port]
// 기본 포트 8321. 외부 노출 없음(127.0.0.1 바인드).

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "packages", "engine", "dev-viewer", "e2e");
const PORT = Number(process.argv[2] ?? 8321);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const rel = url === "/" ? "/compare.html" : decodeURIComponent(url);
  // 경로 탈출 차단(정적 서버지만 로컬이라도 지킨다).
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`not found: ${rel}\n\n비교본이 아직 안 만들어졌으면:\n  HMB_CHAIN_VIEW=1 npx vitest run packages/engine/dev-viewer/e2e/gen-chain-viewer.test.ts\n`);
    return;
  }
  if (!st.isFile()) {
    res.writeHead(404).end("not a file");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": "no-cache",
  });
  createReadStream(path).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[#279 compare] http://127.0.0.1:${PORT}/  (root: ${ROOT})`);
  // eslint-disable-next-line no-console
  console.log(`  A 현행 단독: http://127.0.0.1:${PORT}/viewer-weighted.html`);
  // eslint-disable-next-line no-console
  console.log(`  B 사슬 단독: http://127.0.0.1:${PORT}/viewer-chain.html`);
});
