/**
 * 공유 딥링크 OG 썸네일 — Cloudflare Pages **Function** (#299, 에픽 #293).
 *
 * 라우트 = `/share/notice/:id` (파일 경로가 곧 라우트다: `functions/share/notice/[id].js`).
 *
 * ── 왜 이 모양인가 (뒤집기 전에 반드시 읽을 것) ───────────────────────────────────
 *
 * 1) **`_redirects` 로는 못 푼다.** `/* /index.html 200` 은 `/assets/*.js|css` 까지 rewrite 해
 *    백지 화면을 만들고 `_headers` 도 무력화한다(`infra/pages/_redirects` 주석에 실패가 박제돼 있다).
 *
 * 2) **`_worker.js`(advanced mode)를 쓰지 않는다.** 그건 라우팅을 통째로 가져가면서 `_headers` 를
 *    적용하지 않는다 → `X-Frame-Options: SAMEORIGIN` 이 사라지고 **뷰어 iframe(경기 재생)이 죽는다**
 *    (`apps/web/src/match/viewer-bridge.ts` 의 `/viewer-embed.html` 임베드). route 기반 `functions/`
 *    디렉토리는 정적 에셋·헤더 처리를 Pages 에 그대로 남긴다 — 그래서 이쪽이다.
 *
 * 3) **경로가 `/notice/` 가 아니라 `/share/notice/` 인 것이 계약이다.** `/notice/hero-*.webp` 는
 *    실제 정적 에셋이다(81.8KB). Function 을 `/notice/*` 로 넓히면 그 이미지를 삼켜 공지 화면이
 *    깨진다(에픽 #293 R3). 이 파일을 `functions/notice/[id].js` 로 옮기지 마라.
 *
 * 4) **UA 스니핑을 하지 않는다.** 크롤러/사람을 가르지 않고 **항상 같은 SPA 셸**을 돌려주되
 *    `<head>` 에 og/twitter 메타만 주입한다. 크롤러는 메타를 읽고, 사람은 평소와 똑같은 앱을 받아
 *    `/share/notice/:id` 라우트(#298)가 그 공지를 연다. UA 목록은 반드시 낡고, 갈라진 두 경로는
 *    한쪽만 조용히 썩는다.
 *
 * 5) **백엔드 URL 을 굽지 않는다.** 백엔드는 ephemeral quick tunnel 이라 주소가 바뀐다. 같은
 *    사이트의 **`/config.json`**(`Cache-Control: no-store`)을 **요청 시각에** 읽는다 — #183 워치독은
 *    터널 교체 시 그 파일만 갈아끼우므로 Function 이 자동으로 따라간다.
 *    ⚠️ 백엔드 오리진을 이 파일에 문자열로 적는 순간, 다음 터널 재시작에서 미리보기가 죽는다.
 *    (계약: 이 파일에 백엔드 호스트 리터럴이 0건이어야 한다 — og-function.e2e.sh AC3.)
 *
 * 6) **어떤 실패도 흰 화면이 되지 않는다.** 공지 조회가 404/410/타임아웃/손상 응답이면 **기본 메타로
 *    셸을 그대로** 돌려준다 — 앱이 자기 안내 화면을 그린다(`ShareNoticePage`).
 */

/** 공지 id = ULID(26자). 넉넉히 받되 URL 조작 문자는 막는다 — 이 값이 백엔드 경로에 들어간다. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 백엔드가 죽었을 때 크롤러를 붙잡아 두지 않는다. 미리보기보다 응답이 먼저다. */
const API_TIMEOUT_MS = 2500;

/** og:description 길이 상한(대부분의 스크래퍼가 이 근처에서 자른다). */
const DESC_MAX = 160;

const SITE_NAME = "HMB 온라인";
const DEFAULT_TITLE = "HMB 온라인";
const DEFAULT_DESC = "선수 한 명 한 명에게 지시를 적어 넣는 축구 매니지먼트 게임.";

/**
 * 본문에 이미지가 없는 공지의 폴백 썸네일.
 * ⚠️ 아직 1200×630 전용 OG 이미지가 없어 사이트 아이콘을 쓴다(SVG 를 못 읽는 스크래퍼는 썸네일 없이
 * 제목·설명만 보여 준다 — 잘못된 이미지를 보여 주는 것보다 낫다). 전용 이미지가 생기면
 * Pages 환경변수 `OG_DEFAULT_IMAGE` 로 갈아끼운다(코드 수정 불필요).
 */
const DEFAULT_IMAGE_PATH = "/favicon.svg";

export async function onRequestGet(context) {
  const { request, params, env } = context;
  const url = new URL(request.url);
  const id = typeof params.id === "string" ? params.id : "";

  const shell = await loadShell(context, url);
  // 셸이 HTML 이 아니면(= 배포 산출물이 이상하면) 손대지 않고 그대로 흘린다.
  if (!isHtml(shell)) return shell;

  let meta = defaultMeta(url, id, env);
  try {
    const notice = await fetchNotice(context, url, id);
    if (notice) meta = noticeMeta(url, notice, id, env);
  } catch {
    // 타임아웃·네트워크·JSON 파싱 실패 — 기본 메타로 간다(6번 규칙).
  }
  return renderShell(shell, meta);
}

/** SPA 셸(index.html). 라우트가 `/share/notice/*` 라 자기 경로로는 정적 에셋이 없다 — 명시적으로 집는다. */
async function loadShell(context, url) {
  const indexUrl = new URL("/index.html", url.origin).toString();
  const assets = context.env && context.env.ASSETS;
  if (assets && typeof assets.fetch === "function") {
    return await assets.fetch(new Request(indexUrl, { headers: { accept: "text/html" } }));
  }
  return await context.next(indexUrl);
}

function isHtml(res) {
  return res && res.ok && /text\/html/i.test(res.headers.get("content-type") || "");
}

/**
 * 백엔드 주소 = **같은 사이트의 `/config.json`**. 굽지 않는 이유는 머리말 5번.
 * 없거나 http(s) 가 아니면 null → 조회를 건너뛰고 기본 메타로 간다.
 */
async function readApiBase(context, url) {
  const cfgUrl = new URL("/config.json", url.origin).toString();
  const assets = context.env && context.env.ASSETS;
  const res = assets && typeof assets.fetch === "function"
    ? await assets.fetch(new Request(cfgUrl, { headers: { accept: "application/json" } }))
    : await fetch(cfgUrl);
  if (!res || !res.ok) return null;
  const cfg = await res.json();
  const base = typeof cfg?.apiBase === "string" ? cfg.apiBase.trim().replace(/\/+$/, "") : "";
  return /^https?:\/\/[^\s]+$/i.test(base) ? base : null;
}

/** `GET {apiBase}/api/notices/{id}` — LIVE 200 / EXPIRED·OFF 410 / 그 외 404 (#297). 200 만 쓴다. */
async function fetchNotice(context, url, id) {
  if (!ID_RE.test(id)) return null;
  const base = await readApiBase(context, url);
  if (!base) return null;
  const res = await fetch(`${base}/api/notices/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) return null; // 410/404 = 본문을 가린다 → 기본 메타
  const notice = await res.json();
  if (!notice || typeof notice.title !== "string" || !notice.title.trim()) return null;
  return notice;
}

function canonical(url, id) {
  return new URL(`/share/notice/${encodeURIComponent(id)}`, url.origin).toString();
}

function defaultMeta(url, id, env) {
  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESC,
    image: absolutize(defaultImagePath(env), url) || "",
    canonical: id ? canonical(url, id) : new URL("/", url.origin).toString(),
  };
}

function noticeMeta(url, notice, id, env) {
  const desc = truncate(plainText(notice.body), DESC_MAX) || DEFAULT_DESC;
  const image =
    absolutize(firstImagePath(notice.body), url) || absolutize(defaultImagePath(env), url) || "";
  return { title: notice.title.trim(), description: desc, image, canonical: canonical(url, id) };
}

function defaultImagePath(env) {
  const configured = env && typeof env.OG_DEFAULT_IMAGE === "string" ? env.OG_DEFAULT_IMAGE.trim() : "";
  return configured || DEFAULT_IMAGE_PATH;
}

/** 본문 마크다운의 **첫 이미지**: `![alt](/notice/x.webp)`. */
function firstImagePath(body) {
  const m = /!\[[^\]]*\]\(\s*([^)\s]+)/.exec(String(body || ""));
  return m ? m[1] : "";
}

/**
 * og:image 는 **절대 URL** 이어야 한다(상대경로를 읽는 스크래퍼가 없다).
 * 이미 절대면 그대로, `/`로 시작하면 이 사이트 오리진을 붙인다. 그 외(`javascript:`·상대경로)는 버린다.
 */
function absolutize(src, url) {
  const s = String(src || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return new URL(s, url.origin).toString();
  return "";
}

/** 마크다운 부분집합 → 평문(설명용). 렌더가 아니라 요약이라 관대해도 된다. */
function plainText(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 이미지는 설명에서 뺀다
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 링크는 텍스트만
    .replace(/`{1,3}/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** 속성값으로 들어가므로 반드시 이스케이프한다(공지 본문은 운영자가 쓰는 자유 텍스트다). */
function attr(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function metaHtml(m) {
  const rows = [
    ["name", "description", m.description],
    ["property", "og:type", "article"],
    ["property", "og:site_name", SITE_NAME],
    ["property", "og:title", m.title],
    ["property", "og:description", m.description],
    ["property", "og:url", m.canonical],
    ["property", "og:image", m.image],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", m.title],
    ["name", "twitter:description", m.description],
    ["name", "twitter:image", m.image],
  ];
  return rows
    .filter(([, , v]) => v)
    .map(([k, n, v]) => `<meta ${k}="${n}" content="${attr(v)}" />`)
    .join("\n    ");
}

/**
 * 셸 HTML 에 메타만 얹는다. **HTMLRewriter** 로 스트리밍 변환 — 문자열 치환은 셸이 바뀌면 조용히
 * 빗나간다(`</head>` 대소문자·공백).
 *
 * ⚠️ 원본 헤더를 그대로 물려주지 않는다: 본문을 바꿨으므로 `content-length`·`etag` 가 거짓이 된다.
 * 보안 헤더는 여기서 다시 쓰지 않는다 — `_headers` 가 계속 적용돼야 하고, 같은 헤더를 양쪽에서
 * 쓰면 중복돼 브라우저가 무시할 수 있다.
 */
function renderShell(shell, meta) {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // index.html 과 같은 정책(해시 없는 문서 = 캐시 금지). 공지 내용이 바뀌면 즉시 반영돼야 한다.
    "cache-control": "no-cache",
  });
  const base = new Response(shell.body, { status: 200, headers });
  return new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on("head", {
      element(el) {
        el.append(`\n    ${metaHtml(meta)}\n  `, { html: true });
      },
    })
    .transform(base);
}
