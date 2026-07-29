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

  /**
   * ⚠️ **서버가 "번들 있다"고 해 놓고 파일을 못 주는 상태**가 실제로 있다 — 볼륨을 잃고 DB 만
   * 복원하면 그렇다(독립검증 MAJOR-2). 서버가 index 에서 걸러 주지만 그건 서버가 옳게 답할
   * 때의 이야기고, 이 백스톱이 없으면 화면이 통째로 이니셜이 되며 **되돌아갈 길이 없다**.
   */
  it("서버 base 를 채택했는데 매니페스트가 하나도 안 오면 구운 폴백으로 되돌린다", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    const spy = stubFetch((url) => {
      if (url.includes("/api/chars/index")) return json(VALID_INDEX);
      // 번들은 "있다"는데 파일이 전부 없다(볼륨 유실 후 DB 만 복원된 상태).
      if (url.startsWith("https://api.example.com")) return json({ code: "NOT_FOUND" }, 404);
      return json({ version: 1 });
    });

    const assets = await loadCharAssets();

    expect(charsBase(), "구운 폴백으로 되돌아왔다").toBe(CHARS_BASE);
    expect(assets.units, "폴백 트리에서 다시 읽어 화면이 성립한다").not.toBeNull();
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain("/chars/units/manifest.json");
  });

  it("base 를 명시하면 조회를 건너뛴다(프리뷰·테스트 하니스가 특정 트리를 겨냥할 수 있게)", async () => {
    const spy = stubFetch(() => json({ version: 1 }));

    await loadCharAssets("/fixture-chars");

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/chars/index"))).toBe(false);
    expect(urls).toContain("/fixture-chars/manifest.json");
  });
});

/**
 * ⚠️ **§7.2 전환의 실체가 여기 있다** — 독립검증 MAJOR-1.
 *
 * 앞의 테스트들은 `charsBase()` 반환값과 **매니페스트 fetch URL** 만 봤다. 그래서 URL 조립
 * 함수들의 기본값을 `charsBase()` → `CHARS_BASE` 로 **되돌리는 변이체가 살아남았다**(전 스위트
 * 1334건이 그대로 통과). 그 변이체가 만드는 상태는 `char-assets-store` 주석이 스스로 경고하는
 * 그것 — **매니페스트만 서버에서 읽고 이미지는 웹 오리진에서 찾아 전부 404**. 아바타·카드·
 * 프레임·아틀라스·경기장 스킨 전 축이 조용히 죽는다.
 *
 * e2e 는 백엔드가 없어 **구조적으로** 이 축을 검증할 수 없다(설계상 항상 폴백). 그래서 여기서 건다.
 */
describe("URL 조립이 해석된 base 를 따라온다 (아트가 실제로 어디서 로드되나)", () => {
  const SERVER = "https://api.example.com/api/chars";

  const CHARACTERS = {
    atlases: { "avatars-64": { file: "characters/avatars-64.png", tile: 64, cols: 4, rows: 4 } },
    characters: { aura: { col: 1, row: 0, position: "FW", card: "characters/card-aura.png" } },
  };
  const UNITS = {
    atlases: { "avatars-64": { file: "units/avatars-64.png", tile: 64, cols: 3, rows: 3 } },
    units: {
      bonaldo: {
        col: 0, row: 0, name: "보날두", position: "FW",
        card: { file: "units/art-bonaldo.png", kind: "frameless-art" as const, w: 512, h: 768 },
      },
    },
  };
  /**
   * ⚠️ 실제 플레이스홀더 manifest 의 `atlases` 에는 **격자가 아닌 항목이 섞여 있다**
   * (`frame-<GRADE>` = `{file,w,h}` — `AtlasSpec` 이 아니다). 그래서 `isGridAtlas`/`frameUrl` 이
   * 따로 있는 것이고, 픽스처도 **그 실제 모양 그대로** 둔다(타입에 맞춰 다듬으면 프레임 URL 이
   * 실제로 어떤 항목에서 나오는지를 검사하지 못한다). 발행물은 런타임 JSON 이라 캐스트가 정직하다.
   */
  const PLACEHOLDERS = {
    atlases: {
      "avatars-64": { file: "avatars-64.png", tile: 64, cols: 14, rows: 13 },
      "frame-GOLD": { file: "frame-GOLD.png", w: 226, h: 425 },
    },
    players: { P001: { col: 0, row: 0, grade: "GOLD", initials: "P1" } },
  } as unknown as import("./char-manifest").PlaceholderManifest;

  afterEach(() => setCharsBase(null));

  it("아틀라스·카드·프레임 URL 이 전부 서버 오리진을 가리킨다", async () => {
    const m = await import("./char-manifest");
    setCharsBase(SERVER);

    // 유닛 축(활성 LEGEND 실아트) · 캐릭터 축 · 플레이스홀더 축 — **세 축 전부**.
    expect(m.unitTile(UNITS, "bonaldo", "avatars-64")?.url).toBe(`${SERVER}/units/avatars-64.png`);
    expect(m.characterTile(CHARACTERS, "aura", "avatars-64")?.url).toBe(
      `${SERVER}/characters/avatars-64.png`,
    );
    expect(m.placeholderTile(PLACEHOLDERS, "P001", "avatars-64")?.url).toBe(`${SERVER}/avatars-64.png`);
    // 풀아트 카드와 등급 프레임(합성 경로의 두 입력)도 같이 따라와야 카드가 성립한다.
    expect(m.characterCardUrl(CHARACTERS, "aura")).toBe(`${SERVER}/characters/card-aura.png`);
    expect(m.frameUrl(PLACEHOLDERS, "GOLD")).toBe(`${SERVER}/frame-GOLD.png`);
    expect(m.assetUrl("units/art-bonaldo.png")).toBe(`${SERVER}/units/art-bonaldo.png`);
  });

  it("매핑을 따라가는 통합 경로(resolveTile)도 같은 base 를 쓴다", async () => {
    const m = await import("./char-manifest");
    setCharsBase(SERVER);

    const resolved = m.resolveTile({
      characters: CHARACTERS,
      units: UNITS,
      placeholders: PLACEHOLDERS,
      ref: { axis: "units", id: "bonaldo" },
      playerId: "P173",
      atlas: "avatars-64",
    });

    expect(resolved?.kind).toBe("unit");
    expect(resolved?.tile.url).toBe(`${SERVER}/units/avatars-64.png`);
  });

  it("⚠️ 번들을 끄면 **같은 함수들이** 구운 폴백을 가리킨다(롤백이 화면까지 닿는다)", async () => {
    const m = await import("./char-manifest");
    setCharsBase(SERVER);
    setCharsBase(null);

    expect(m.unitTile(UNITS, "bonaldo", "avatars-64")?.url).toBe(`${CHARS_BASE}/units/avatars-64.png`);
    expect(m.frameUrl(PLACEHOLDERS, "GOLD")).toBe(`${CHARS_BASE}/frame-GOLD.png`);
    expect(m.assetUrl("units/art-bonaldo.png")).toBe(`${CHARS_BASE}/units/art-bonaldo.png`);
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
