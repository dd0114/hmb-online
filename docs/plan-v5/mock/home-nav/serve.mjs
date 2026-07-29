// #286 UI 보드 로컬 서버 — hero 가 클릭 탐색하는 창구.
//
//   node docs/plan-v5/mock/home-nav/serve.mjs        → http://127.0.0.1:8286/
//   PORT=9286 node .../serve.mjs                     → 포트 변경
//
// ⚠️ 로컬 전용이다(127.0.0.1 고정). Artifact·외부 호스팅 금지 규칙 때문에 보드는 이 경로로만 본다.
// file:// 로 열어도 대부분 보이지만 iframe 프로토타입이 브라우저에 따라 막히므로 이 서버를 권장한다.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8286);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const raw = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const rel = normalize(raw === "/" ? "/index.html" : raw).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found: " + rel);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[#286 UI 보드] http://127.0.0.1:${PORT}/`);
});
