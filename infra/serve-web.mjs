// web dist 정적 서버 (호스트 체크 없음 → quick tunnel 로 안전 노출).
// vite preview 는 allowedHosts 로 터널 도메인을 막으므로 이 단순 서버를 쓴다.
//
//   node infra/serve-web.mjs [port] [distDir]
//
// SPA 폴백: 실제 파일 있으면 그거, 없으면 index.html (React 라우팅).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] || process.env.WEB_PORT || 4321);
const DIST = path.resolve(process.argv[3] || "apps/web/dist");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`[serve-web] ${DIST}/index.html 없음 — 먼저 web 빌드 필요`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let f = path.join(DIST, urlPath === "/" ? "/index.html" : urlPath);
  // 디렉토리 이탈 방지
  if (!f.startsWith(DIST)) { res.writeHead(403); return res.end("forbidden"); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(f));
});
server.listen(PORT, () => console.log(`[serve-web] ${DIST} → http://localhost:${PORT}`));
