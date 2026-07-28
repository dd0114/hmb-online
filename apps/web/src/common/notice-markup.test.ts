/**
 * 공지 본문 파서 계약 (#248 W2 / hero Q7).
 *
 * 두 축을 박제한다:
 *  ① 허용한 서식(굵게·기울임·목록·링크·이미지·문단)이 실제로 **구조**가 된다
 *  ② 그 밖의 입력은 **어떤 경우에도 실행 가능한 노드가 되지 않는다** — HTML·javascript:·data: 는
 *    전부 텍스트로 강등된다(변이체 킬: 화이트리스트를 지우면 여기서 깨진다)
 */
import { describe, expect, it } from "vitest";
import { parseNoticeBody, safeNoticeUrl, type NoticeBlock } from "./notice-markup";

function spansOf(blocks: NoticeBlock[], i = 0) {
  const b = blocks[i];
  if (!b || b.type !== "paragraph") throw new Error(`block ${i} is not a paragraph`);
  return b.spans;
}

function itemsOf(blocks: NoticeBlock[], i: number) {
  const b = blocks[i];
  if (!b || b.type !== "list") throw new Error(`block ${i} is not a list`);
  return b.items;
}

describe("safeNoticeUrl — 스킴 화이트리스트", () => {
  it("http/https/앱 경로만 통과한다", () => {
    expect(safeNoticeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeNoticeUrl("http://example.com")).toBe("http://example.com");
    expect(safeNoticeUrl("HTTPS://EXAMPLE.com")).toBe("HTTPS://EXAMPLE.com");
    expect(safeNoticeUrl("/assets/chars/p173.png")).toBe("/assets/chars/p173.png");
    expect(safeNoticeUrl("  /shop  ")).toBe("/shop");
  });

  it("실행 가능한 스킴과 프로토콜 상대 URL 을 거부한다", () => {
    expect(safeNoticeUrl("javascript:alert(1)")).toBeNull();
    expect(safeNoticeUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeNoticeUrl("  javascript:alert(1)")).toBeNull();
    expect(safeNoticeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeNoticeUrl("vbscript:msgbox(1)")).toBeNull();
    // 앱 경로처럼 보이지만 외부 호스트로 나간다 — "/" 허용의 뒷문을 막는다.
    expect(safeNoticeUrl("//evil.example.com/x")).toBeNull();
    // ⚠️ 역슬래시 우회 — URL 파서가 authority 자리의 `\` 를 `/` 로 취급해 실브라우저에서
    //    `http://evil.example.com/x` 로 해석됐다(실측: 외부 호스트로 요청이 나갔다).
    expect(safeNoticeUrl("/\\evil.example.com/x")).toBeNull();
    expect(safeNoticeUrl("/\\\\evil.example.com")).toBeNull();
    expect(safeNoticeUrl("\\\\evil.example.com")).toBeNull();
    // 정상 앱 경로는 계속 통과한다(과잉 차단 회귀 가드).
    expect(safeNoticeUrl("/assets/a.png")).toBe("/assets/a.png");
    expect(safeNoticeUrl("/a/b/c")).toBe("/a/b/c");
    expect(safeNoticeUrl("")).toBeNull();
    expect(safeNoticeUrl(null)).toBeNull();
  });
});

describe("parseNoticeBody — 허용 서식", () => {
  it("빈 줄로 문단을 가르고, 문단 안 개행은 보존한다", () => {
    const blocks = parseNoticeBody("첫 줄\n둘째 줄\n\n다음 문단");
    expect(blocks).toHaveLength(2);
    expect(spansOf(blocks, 0)).toEqual([{ type: "text", value: "첫 줄\n둘째 줄" }]);
    expect(spansOf(blocks, 1)).toEqual([{ type: "text", value: "다음 문단" }]);
  });

  it("**굵게** 와 *기울임* 을 각각 구분한다", () => {
    expect(spansOf(parseNoticeBody("a **굵게** b *기울임* c"))).toEqual([
      { type: "text", value: "a " },
      { type: "bold", value: "굵게" },
      { type: "text", value: " b " },
      { type: "italic", value: "기울임" },
      { type: "text", value: " c" },
    ]);
  });

  it("연속한 `- ` 줄을 하나의 목록으로 묶는다", () => {
    const blocks = parseNoticeBody("안내\n- 하나\n- **둘**\n끝");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
    const items = itemsOf(blocks, 1);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual([{ type: "text", value: "하나" }]);
    expect(items[1]).toEqual([{ type: "bold", value: "둘" }]);
  });

  it("링크와 이미지를 구조로 만든다 (이미지가 링크보다 먼저 잡힌다)", () => {
    expect(spansOf(parseNoticeBody("![새 유닛](/assets/u.png) 와 [상점](https://x.test/s)"))).toEqual([
      { type: "image", alt: "새 유닛", src: "/assets/u.png" },
      { type: "text", value: " 와 " },
      { type: "link", text: "상점", href: "https://x.test/s" },
    ]);
  });

  it("빈 본문·비문자열은 빈 블록 목록이다(렌더가 터지지 않는다)", () => {
    expect(parseNoticeBody("")).toEqual([]);
    expect(parseNoticeBody(undefined)).toEqual([]);
    expect(parseNoticeBody(42)).toEqual([]);
    expect(parseNoticeBody("   \n\n  ")).toEqual([]);
  });
});

describe("parseNoticeBody — 강등(변이체 킬)", () => {
  it("HTML 은 어떤 노드도 만들지 않고 텍스트로 남는다", () => {
    const raw = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    const spans = spansOf(parseNoticeBody(raw));
    expect(spans).toEqual([{ type: "text", value: raw }]);
    // 파서가 만들 수 있는 타입 집합에 "html"·"raw" 같은 통로가 없다는 것이 계약이다.
    for (const s of spans) {
      expect(["text", "bold", "italic", "link", "image"]).toContain(s.type);
    }
  });

  it("javascript: 링크는 링크가 되지 않고 원문 텍스트로 남는다", () => {
    const raw = "[눌러](javascript:alert)";
    expect(spansOf(parseNoticeBody(raw))).toEqual([{ type: "text", value: raw }]);
    const withParens = "[눌러](javascript:alert(1))";
    const spans = spansOf(parseNoticeBody(withParens));
    expect(spans.some((s) => s.type === "link")).toBe(false);
    expect(spans.map((s) => (s.type === "text" ? s.value : "")).join("")).toBe(withParens);
  });

  it("거부된 스킴의 이미지도 img 노드가 되지 않는다", () => {
    const spans = spansOf(parseNoticeBody("![x](data:text/html,<script>alert(1)</script>)"));
    expect(spans.some((s) => s.type === "image")).toBe(false);
    expect(spans.every((s) => s.type === "text")).toBe(true);
  });

  it("링크 문구 안의 HTML 도 문자열일 뿐이다", () => {
    const spans = spansOf(parseNoticeBody("[<b>굵은</b> 링크](https://x.test)"));
    expect(spans).toEqual([
      { type: "link", text: "<b>굵은</b> 링크", href: "https://x.test" },
    ]);
  });
});
