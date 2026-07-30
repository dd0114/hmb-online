import { describe, expect, it } from "vitest";
import {
  LOBBY_PATH,
  RETURN_TO_PARAM,
  loginPathWithReturn,
  resolveReturnTo,
  safeReturnTo,
} from "./return-to";

/**
 * 복귀 경로 화이트리스트 (#298 AC3).
 *
 * `RequireAuth` → `/login?returnTo=…` → `LoginPage` 는 **전 라우트가 지나는 공용 경로**다.
 * 여기서 값을 그대로 믿으면 오픈 리다이렉트(피싱 착지)가 된다 — 그래서 "내부 경로인가"를
 * `startsWith("/")` 로 판정하지 않는다. `//evil.test` 는 그 검사를 통과하지만 브라우저는
 * **프로토콜 상대 URL**로 읽어 외부 호스트로 나간다.
 */
describe("safeReturnTo — 허용", () => {
  it("공유 딥링크를 그대로 돌려준다", () => {
    expect(safeReturnTo("/share/notice/N1")).toBe("/share/notice/N1");
  });

  it("쿼리를 보존한다", () => {
    expect(safeReturnTo("/share/notice/N1?from=kakao&x=1")).toBe("/share/notice/N1?from=kakao&x=1");
  });

  it("해시를 보존한다", () => {
    expect(safeReturnTo("/share/notice/N1#body")).toBe("/share/notice/N1#body");
  });

  it("주요 앱 경로를 허용한다", () => {
    for (const p of ["/lobby", "/deck", "/shop", "/growth", "/codex", "/trade", "/logs", "/league"]) {
      expect(safeReturnTo(p), p).toBe(p);
    }
  });

  it("매치 경로(하위)를 허용한다", () => {
    expect(safeReturnTo("/match/M-1")).toBe("/match/M-1");
  });
});

describe("safeReturnTo — 차단 (오픈 리다이렉트)", () => {
  const hostile: [string, unknown][] = [
    ["외부 절대 URL(https)", "https://evil.test/share/notice/N1"],
    ["외부 절대 URL(http)", "http://evil.test/"],
    // ⚠️ 변이체 킬 — 검증을 `startsWith("/")` 로만 낮추면 이 두 줄이 통과해 버린다.
    ["프로토콜 상대", "//evil.test"],
    ["프로토콜 상대 + 경로", "//evil.test/share/notice/N1"],
    ["백슬래시(브라우저가 // 로 정규화)", "/\\evil.test"],
    ["역슬래시 혼합", "/share/notice\\..\\..\\evil"],
    ["javascript 스킴", "javascript:alert(1)"],
    ["data 스킴", "data:text/html,<script>1</script>"],
    ["상대 경로", "share/notice/N1"],
    ["경로 traversal", "/share/notice/../../evil"],
    ["비허용 내부 경로", "/nope/deep"],
    ["admin(화이트리스트 밖)", "/admin"],
    ["접두사만 같고 하위가 없음", "/share/notice/"],
    ["앞 공백으로 스킴 위장", " //evil.test"],
    ["개행 삽입", "/lobby\nhttps://evil.test"],
    ["탭 삽입", "/lob\tby"],
    ["빈 문자열", ""],
    ["null", null],
    ["undefined", undefined],
    ["문자열이 아님", { toString: () => "/lobby" }],
  ];

  for (const [name, raw] of hostile) {
    it(`${name} → null`, () => {
      expect(safeReturnTo(raw)).toBeNull();
    });
  }
});

describe("resolveReturnTo — 폴백은 언제나 기본 착지", () => {
  it("안전하면 그 경로", () => {
    expect(resolveReturnTo("/share/notice/N1")).toBe("/share/notice/N1");
  });

  it("외부·프로토콜 상대·비허용은 전부 로비", () => {
    for (const raw of ["https://evil.test", "//evil.test", "/nope", null, ""]) {
      expect(resolveReturnTo(raw)).toBe(LOBBY_PATH);
    }
  });

  it("기본 착지는 홈이다 (#286: 로비가 홈으로 대체됐다)", () => {
    // 상수 이름은 호환을 위해 남았지만 값은 홈이다. `/lobby` 로 두면 착지 때마다 리다이렉트를
    // 한 번 더 타고(로비는 이제 리다이렉트로만 존재), 그 사이 화면이 한 번 깜빡인다.
    expect(LOBBY_PATH).toBe("/home");
  });
});

describe("loginPathWithReturn", () => {
  it("안전한 경로는 인코딩해 파라미터로 싣는다", () => {
    const path = loginPathWithReturn("/share/notice/N1?from=kakao");
    expect(path).toBe(`/login?${RETURN_TO_PARAM}=${encodeURIComponent("/share/notice/N1?from=kakao")}`);
    // 라운드트립 — 붙였다 떼면 원본이다.
    const raw = new URLSearchParams(path.split("?")[1]).get(RETURN_TO_PARAM);
    expect(resolveReturnTo(raw)).toBe("/share/notice/N1?from=kakao");
  });

  it("위험한 경로는 파라미터 없이 로그인만 — 그 값을 URL 에 실어 나르지 않는다", () => {
    expect(loginPathWithReturn("https://evil.test")).toBe("/login");
    expect(loginPathWithReturn("//evil.test")).toBe("/login");
  });

  it("기본 착지로 가려다 튕긴 경우는 파라미터를 붙이지 않는다", () => {
    expect(loginPathWithReturn("/home")).toBe("/login");
  });
});
