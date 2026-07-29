/**
 * 서버 아트 번들 ↔ 구운 폴백 (#309 W2).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 이 계약이 지키는 것은 <b>두 방향</b>이고, 한쪽만 검사하면 반대쪽이 조용히 깨진다.
 *
 *  1) 활성 번들이 있으면 **백엔드 오리진**을 쓴다 — 그게 "웹 재배포 없이 아트 교체"의 전부다.
 *  2) 없거나 이상하면 **웹 빌드에 구운 `/chars`** 로 떨어진다 — 아트 배포 채널이 죽어도 화면이
 *     성립해야 한다(#309 요구 ③).
 *
 * ⚠️ (2)에서 "이상하면"이 핵심이다. **HTTP 200 만 보고 채택하면** 목·프록시·구 서버가 주는
 *    `{}` 하나가 "아트 0개"를 정상처럼 통과시켜 전 화면이 조용히 이니셜 폴백이 된다 —
 *    깨진 화면이 아니라 **밋밋한 화면**이라 아무도 버그로 신고하지 않는다.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRuntimeConfig } from "../api/client";
import { CHARS_BASE, charsBase, setCharsBase } from "./char-manifest";
import { isUsableBundleIndex, loadCharAssets, resetCharAssetsCache, resolveCharsBase } from "./char-assets-store";

const VALID_INDEX = { revision: "01ABC", fileCount: 40, byteSize: 1234, requiredEntries: ["manifest.json"] };

function stubFetch(handler: (url: string) => Response) {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  resetCharAssetsCache();
  __resetRuntimeConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCharAssetsCache();
});

describe("isUsableBundleIndex — 형태로 판정한다", () => {
  it("서버가 자기 리비전과 필수 파일 목록을 말해 줄 때만 유효하다", () => {
    expect(isUsableBundleIndex(VALID_INDEX)).toBe(true);
  });

  it("⚠️ 빈 객체·부분 응답은 유효하지 않다(200 이어도) — 이게 조용한 실패를 막는 지점이다", () => {
    expect(isUsableBundleIndex({})).toBe(false);
    expect(isUsableBundleIndex({ revision: "01ABC" })).toBe(false);
    expect(isUsableBundleIndex({ revision: "01ABC", requiredEntries: [] })).toBe(false);
    expect(isUsableBundleIndex({ requiredEntries: ["a"] })).toBe(false);
    expect(isUsableBundleIndex(null)).toBe(false);
    expect(isUsableBundleIndex("ok")).toBe(false);
  });
});

describe("resolveCharsBase", () => {
  it("활성 번들이 있으면 백엔드 오리진 base 를 준다", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    stubFetch(() => json(VALID_INDEX));

    await expect(resolveCharsBase()).resolves.toBe("https://api.example.com/api/chars");
  });

  it("404(활성 번들 없음)면 null → 구운 폴백", async () => {
    stubFetch(() => json({ code: "NOT_FOUND" }, 404));

    await expect(resolveCharsBase()).resolves.toBeNull();
  });

  it("⚠️ 200 인데 형태가 아니면 null — 캐치올 목이 아트를 지우지 못하게", async () => {
    stubFetch(() => json({}));

    await expect(resolveCharsBase()).resolves.toBeNull();
  });

  it("네트워크가 죽어도 throw 하지 않는다(아트 채널 장애가 화면을 죽이면 안 된다)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    await expect(resolveCharsBase()).resolves.toBeNull();
  });
});

describe("loadCharAssets — 정해진 base 로 매니페스트를 읽는다", () => {
  it("활성 번들이 있으면 매니페스트도 **그 오리진에서** 읽는다", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    const spy = stubFetch((url) =>
      url.includes("/api/chars/index") ? json(VALID_INDEX) : json({ version: 1 }),
    );

    await loadCharAssets();

    const urls = spy.mock.calls.map((c) => String(c[0]));
    // 매니페스트만 서버에서 읽고 이미지는 웹 오리진에서 찾으면 전부 404 다 → base 는 한 곳에서 정한다.
    expect(charsBase()).toBe("https://api.example.com/api/chars");
    expect(urls).toContain("https://api.example.com/api/chars/units/manifest.json");
    expect(urls.some((u) => u.startsWith("/chars/"))).toBe(false);
  });

  it("⚠️ 번들이 없으면 **구운 폴백**을 읽는다 — 서버가 죽어도 화면이 성립한다", async () => {
    const spy = stubFetch((url) =>
      url.includes("/api/chars/index") ? json({ code: "NOT_FOUND" }, 404) : json({ version: 1 }),
    );

    await loadCharAssets();

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(charsBase()).toBe(CHARS_BASE);
    expect(urls).toContain("/chars/units/manifest.json");
  });

  it("base 를 명시하면 조회를 건너뛴다(프리뷰·테스트 하니스가 특정 트리를 겨냥할 수 있게)", async () => {
    const spy = stubFetch(() => json({ version: 1 }));

    await loadCharAssets("/fixture-chars");

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/chars/index"))).toBe(false);
    expect(urls).toContain("/fixture-chars/manifest.json");
  });
});

describe("setCharsBase — 롤백 경로", () => {
  it("null·빈값이면 구운 폴백으로 되돌린다(운영자가 번들을 전부 끈 상태)", () => {
    setCharsBase("https://api.example.com/api/chars");
    expect(charsBase()).not.toBe(CHARS_BASE);

    setCharsBase(null);
    expect(charsBase()).toBe(CHARS_BASE);
    setCharsBase("   ");
    expect(charsBase()).toBe(CHARS_BASE);
  });

  it("끝 슬래시를 정규화한다(assetUrl 이 `//` 를 만들지 않게)", () => {
    setCharsBase("https://api.example.com/api/chars/");
    expect(charsBase()).toBe("https://api.example.com/api/chars");
  });
});
