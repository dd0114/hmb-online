/**
 * 공지 본문 **마크업 파서** (#248 W2, hero Q7 확정: 글 + 서식 + 링크 + 이미지).
 *
 * ⚠️ 이 모듈이 존재하는 이유는 편의가 아니라 **보안**이다. `dangerouslySetInnerHTML` 을 쓰면
 * admin 계정 하나가 뚫렸을 때 **전 유저 브라우저에 스크립트가 배포되는 경로**가 된다. 그래서
 * 본문을 여기서 파싱해 **화이트리스트 노드(text/bold/italic/link/image/list/paragraph)** 로만
 * 바꾸고, 그 외 입력(`<script>`, `<img onerror=…>`, `javascript:` 링크)은 **전부 텍스트로 강등**한다.
 * 렌더러(NoticeBody)는 이 AST 만 그리므로 HTML 문자열이 DOM 에 들어갈 통로 자체가 없다.
 *
 * 살균은 **문자열 필터링이 아니라 구조 변환**이다 — 블랙리스트(`<script>` 지우기)는 우회되지만,
 * "허용된 노드 타입만 만든다"는 우회할 대상이 없다.
 */

export type NoticeInline =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "link"; text: string; href: string }
  | { type: "image"; alt: string; src: string };

export type NoticeBlock =
  | { type: "paragraph"; spans: NoticeInline[] }
  | { type: "list"; items: NoticeInline[][] };

/**
 * URL 스킴 화이트리스트. 통과하는 것은 셋뿐 — `http`, `https`, **앱 자체 경로**(`/assets/…`).
 *
 * - `javascript:` · `data:` · `vbscript:` 등은 여기서 null → 호출부가 원문을 **텍스트로 강등**한다.
 * - `//evil.com`(프로토콜 상대)도 거부한다. 앱 경로처럼 생겼지만 실제로는 **외부 호스트**로 나간다 —
 *   "앱 자체 경로 허용"이 외부 링크의 뒷문이 되면 화이트리스트의 의미가 없다.
 * - ⚠️ **역슬래시도 같이 막는다.** URL 파서는 authority 자리에서 `\` 를 `/` 로 취급하므로
 *   `/\evil.example.com/x` 가 실브라우저에서 `http://evil.example.com/x` 로 해석된다
 *   (실측: `<img>` 가 실제로 외부 호스트에 요청을 보냈다). `//` 만 막는 것은 반쪽짜리였다 —
 *   두 번째 문자가 슬래시 계열이면 전부 거부한다.
 */
export function safeNoticeUrl(raw: string | null | undefined): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return null;
  if (/^\/[\\/]/.test(t)) return null; // `//host` · `/\host` = 앱 경로 위장 외부 호스트
  if (t.startsWith("/")) return t;
  return /^https?:\/\//i.test(t) ? t : null;
}

/**
 * 인라인 토큰 — 순서가 계약이다. `![alt](url)` 를 `[text](url)` 보다 **먼저** 시도해야
 * 이미지가 링크로 잘못 잡히지 않고, `**굵게**` 를 `*기울임*` 보다 먼저 시도해야 별 두 개가
 * "빈 기울임 + 별"로 쪼개지지 않는다.
 * 각 패턴이 `\n` 을 배제하므로 토큰은 **줄을 넘지 못한다**(열린 대괄호 하나가 본문 전체를 삼키지 않게).
 */
const INLINE_RE =
  /!\[([^\]\n]*)\]\(([^)\s\n]*)\)|\[([^\]\n]+)\]\(([^)\s\n]*)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;

function parseInline(text: string): NoticeInline[] {
  const out: NoticeInline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += value;
    else out.push({ type: "text", value });
  };

  let cursor = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    pushText(text.slice(cursor, m.index));
    cursor = m.index + m[0].length;

    if (m[1] !== undefined) {
      const src = safeNoticeUrl(m[2]);
      if (src) out.push({ type: "image", alt: m[1], src });
      else pushText(m[0]); // 스킴 거부 → 원문 그대로 텍스트
    } else if (m[3] !== undefined) {
      const href = safeNoticeUrl(m[4]);
      if (href) out.push({ type: "link", text: m[3], href });
      else pushText(m[0]);
    } else if (m[5] !== undefined) {
      out.push({ type: "bold", value: m[5] });
    } else if (m[6] !== undefined) {
      out.push({ type: "italic", value: m[6] });
    }
  }
  pushText(text.slice(cursor));
  return out;
}

const LIST_ITEM_RE = /^\s*-\s+/;

/**
 * 본문 → 블록 목록. 빈 줄이 문단을 가르고, 연속한 `- ` 줄이 하나의 목록이 된다.
 * 문단 안의 단일 개행은 **그대로 보존**한다(렌더러가 `pre-wrap` 으로 그린다) — 운영자가
 * 친 줄바꿈이 사라지면 점검 안내처럼 줄 단위로 쓰는 글이 한 덩어리가 된다.
 */
export function parseNoticeBody(body: unknown): NoticeBlock[] {
  const text = typeof body === "string" ? body.replace(/\r\n?/g, "\n") : "";
  if (!text) return [];

  const blocks: NoticeBlock[] = [];
  let para: string[] = [];
  let items: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const spans = parseInline(para.join("\n"));
    if (spans.length > 0) blocks.push({ type: "paragraph", spans });
    para = [];
  };
  const flushList = () => {
    if (items.length === 0) return;
    blocks.push({ type: "list", items: items.map(parseInline) });
    items = [];
  };

  for (const line of text.split("\n")) {
    if (LIST_ITEM_RE.test(line)) {
      flushPara();
      items.push(line.replace(LIST_ITEM_RE, ""));
      continue;
    }
    flushList();
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushList();
  flushPara();
  return blocks;
}
