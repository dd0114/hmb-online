// QA 콘솔 API (#191). 레지스트리를 읽어 콘솔 UI 에 내고, hero 피드백을 append 한다.
//
// 경계:
//  · **127.0.0.1 전용**(인증 없음 = 로컬 도구). 0.0.0.0 바인딩 금지, 외부 호스팅 금지.
//  · `feedback/*.jsonl` 의 **유일한 writer** 가 이 프로세스다(단일 프로세스 → append 경합 0, AC4).
//  · match-log 는 복사하지 않고 탭이 가리키는 절대경로에서 읽어 서빙한다(allowlist 검증 필수).
// node 표준만 쓴다(의존성 0) — 세션이 어느 체크아웃에서든 바로 띄운다.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { createGzip } from "node:zlib";

import {
  appendFeedback,
  ensureHome,
  listTabViews,
  logPathAllowed,
  readAck,
  readFeedback,
  readTab,
  tabView,
} from "./registry.mjs";
import { commitRegistry, ensureGitRepo } from "./git.mjs";

const json = (res, code, value) => {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
};

/** 요청 본문(작은 JSON 만 받는다 — 큰 페이로드는 이 API 의 용도가 아니다). */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("본문이 너무 크다"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 이 아니다"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * match-log 서빙. 리얼 풀매치 로그는 수 MB 라 **gzip** 으로 내고 mtime 기반 ETag 로 재로드를 줄인다
 * (hero 가 탭을 왕복할 때마다 수 MB 를 다시 파싱하면 관전이 끊긴다).
 */
function serveLog(req, res, logPath) {
  let st;
  try {
    st = statSync(logPath);
  } catch {
    return json(res, 404, { error: "match-log 을 읽을 수 없다", logPath });
  }
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  const accepts = String(req.headers["accept-encoding"] ?? "").includes("gzip");
  const headers = { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" };
  if (accepts) headers["content-encoding"] = "gzip";
  res.writeHead(200, headers);
  const stream = createReadStream(logPath);
  stream.on("error", () => res.destroy());
  if (accepts) stream.pipe(createGzip()).pipe(res);
  else stream.pipe(res);
}

/**
 * 라우터. 테스트에서 http 서버 없이도 부를 수 있게 순수하게 분리해 둔다.
 * 경로: `/qa-api/tabs` · `/qa-api/tabs/:id` · `/qa-api/tabs/:id/feedback` · `/qa-api/tabs/:id/log/:viewId`
 */
export async function handleRequest(req, res, { home, now = () => Date.now() }) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/qa-api/health") {
    return json(res, 200, { ok: true, home, tabs: listTabViews(home, now()).length });
  }

  if (path === "/qa-api/tabs" && req.method === "GET") {
    const views = listTabViews(home, now());
    return json(res, 200, {
      tabs: views,
      counts: {
        total: views.length,
        waiting: views.filter((v) => v.tab.status === "waiting").length,
        unread: views.reduce((n, v) => n + v.unread, 0),
        stale: views.filter((v) => v.stale).length,
      },
    });
  }

  const m = path.match(/^\/qa-api\/tabs\/([^/]+)(?:\/(feedback|log)(?:\/([^/]+))?)?$/);
  if (!m) return json(res, 404, { error: "그런 경로가 없다", path });

  const rawId = decodeURIComponent(m[1]);
  let view;
  try {
    view = tabView(home, rawId, now());
  } catch {
    return json(res, 400, { error: "탭 id 형식이 아니다", id: rawId });
  }
  if (!view) return json(res, 404, { error: "없는 탭이다", id: rawId });
  const tabId = view.tab.tabId;

  // 탭 전문
  if (!m[2]) {
    if (req.method !== "GET") return json(res, 405, { error: "GET 만" });
    return json(res, 200, { ...view, feedback: readFeedback(home, tabId), ack: readAck(home, tabId) });
  }

  // 피드백
  if (m[2] === "feedback") {
    if (req.method === "GET") {
      return json(res, 200, { feedback: readFeedback(home, tabId), ack: readAck(home, tabId) });
    }
    if (req.method !== "POST") return json(res, 405, { error: "GET 또는 POST" });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: String(e.message ?? e) });
    }
    let record;
    try {
      record = appendFeedback(home, tabId, {
        verdict: body.verdict ?? "comment",
        body: body.body ?? "",
        view: body.view ?? null,
        tick: body.tick ?? null,
        now: new Date().toISOString(),
      });
    } catch (e) {
      // 거부인데 사유가 없는 등 — hero 화면에 그대로 보여줄 메시지다
      return json(res, 400, { error: String(e.message ?? e) });
    }
    // 기록 계층(§3.1). 실패해도 피드백은 이미 파일에 있다 — 왕복을 막지 않는다.
    ensureGitRepo(home);
    commitRegistry(home, `qa(${tabId}): feedback #${record.seq} ${record.verdict}`);
    return json(res, 201, { feedback: record });
  }

  // match-log
  const viewId = m[3] ? decodeURIComponent(m[3]) : null;
  const target = view.tab.views.find((v) => v.id === viewId);
  if (!target) return json(res, 404, { error: "없는 뷰다", viewId, have: view.tab.views.map((v) => v.id) });
  // 등록 때 검증했지만 **서빙 시점에 다시** 본다: 탭 파일은 다른 프로세스가 쓰는 입력이다.
  if (!logPathAllowed(target.logPath)) {
    return json(res, 403, { error: "허용되지 않은 로그 경로다", logPath: target.logPath });
  }
  return serveLog(req, res, target.logPath);
}

/** 127.0.0.1 전용 API 서버. */
export function createApiServer({ home, now } = {}) {
  const root = ensureHome(home);
  return createServer((req, res) => {
    handleRequest(req, res, { home: root, now }).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
      else res.destroy();
    });
  });
}

/** @returns 실제 바인딩된 포트(0 을 주면 임의 포트 — 테스트가 쓴다). */
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}
