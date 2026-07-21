// @vitest-environment jsdom
/**
 * CharAvatar 폴백 3단 계약 (#145 B안) + 에셋 번들 로더.
 * 실제 발행물 manifest 를 읽어 태우므로 손픽스처 드리프트가 없다.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharAvatar, initialsOf } from "./CharAvatar";
import {
  charIdFor,
  fetchCharAssets,
  loadCharAssets,
  resetCharAssetsCache,
  type CharAssets,
} from "./char-assets-store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const distDir = join(repoRoot, "design", "characters", "dist");

const charactersManifest = JSON.parse(readFileSync(join(distDir, "characters", "manifest.json"), "utf8"));
const placeholderManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
const mappingFile = JSON.parse(readFileSync(join(repoRoot, "data", "players", "player-chars.v1.json"), "utf8"));

/** 스테이징된 3파일을 그대로 돌려주는 fetch 스텁. `missing` 에 든 경로는 404. */
function stubFetch(missing: string[] = []) {
  return vi.fn(async (url: string) => {
    const body = url.endsWith("/characters/manifest.json")
      ? charactersManifest
      : url.endsWith("/player-chars.json")
        ? { version: mappingFile.version, players: mappingFile.players }
        : placeholderManifest;
    if (missing.some((m) => url.endsWith(m))) return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

/** 프로바이더 없이 그대로 렌더한다 — 아바타가 어떤 컨텍스트도 요구하지 않는다는 게 계약이다. */
function renderAvatar(node: ReactNode) {
  return render(node);
}

beforeEach(() => {
  resetCharAssetsCache();
  vi.stubGlobal("fetch", stubFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("initialsOf", () => {
  it("성+이름의 앞글자를 쓴다", () => {
    expect(initialsOf("Lev Yashin")).toBe("LY");
    expect(initialsOf("Park Ji-sung")).toBe("PJ");
  });
  it("한 덩어리 이름은 앞 2글자", () => {
    expect(initialsOf("Pelé")).toBe("PE");
  });
  it("빈 이름도 터지지 않는다", () => {
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("에셋 번들 로더", () => {
  it("세 파일을 모아 온다", async () => {
    const assets = await fetchCharAssets();
    expect(assets.characters?.characters.aura).toBeTruthy();
    expect(Object.keys(assets.placeholders!.players)).toHaveLength(172);
    expect(assets.mapping?.players.P001).toBe("aura");
  });

  it("일부가 404 여도 나머지는 쓴다(부분 열화 — 전체 실패 아님)", async () => {
    vi.stubGlobal("fetch", stubFetch(["/player-chars.json"]));
    const assets = await fetchCharAssets();
    expect(assets.mapping).toBeNull();
    expect(assets.placeholders).not.toBeNull(); // 폴백 축은 살아 있다
  });

  it("네트워크가 통째로 죽어도 reject 하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchCharAssets()).resolves.toEqual({
      characters: null,
      placeholders: null,
      mapping: null,
    });
  });

  it("동시 호출이 한 번만 fetch 한다(모듈 싱글턴)", async () => {
    const spy = stubFetch();
    vi.stubGlobal("fetch", spy);
    await Promise.all([loadCharAssets(), loadCharAssets(), loadCharAssets()]);
    expect(spy).toHaveBeenCalledTimes(3); // 파일 3개 × 1회 — 번들 자체는 1회만 로드
  });
});

describe("charIdFor", () => {
  const assets: CharAssets = {
    characters: null,
    placeholders: null,
    mapping: { players: { P001: "aura" } },
  };
  it("매핑된 선수는 charId 를 준다", () => {
    expect(charIdFor(assets, "P001")).toBe("aura");
  });
  it("매핑에 없거나 id 가 없으면 null", () => {
    expect(charIdFor(assets, "P999")).toBeNull();
    expect(charIdFor(assets, null)).toBeNull();
    expect(charIdFor({ characters: null, placeholders: null, mapping: null }, "P001")).toBeNull();
  });

  it("프로토타입 상속 키를 매핑으로 오인하지 않는다(선언 타입 string|null 유지)", () => {
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(charIdFor(assets, key), key).toBeNull();
    }
  });
});

describe("CharAvatar 폴백 3단", () => {
  it("로딩 전에는 CSS 플레이스홀더 — 레이아웃이 비지 않는다", () => {
    renderAvatar(h(CharAvatar, { playerId: "P001", name: "Lev Yashin", grade: "LEGEND" }));
    expect(screen.getByTestId("char-avatar-P001").dataset.avatarKind).toBe("placeholder-css");
  });

  it("매핑된 선수는 확정 캐릭터 타일을 쓴다", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P001", name: "Lev Yashin", grade: "LEGEND" }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P001").dataset.avatarKind).toBe("character"),
    );
    const style = screen.getByTestId("char-avatar-P001").style;
    expect(style.backgroundImage).toContain("/chars/characters/avatars-64.png");
  });

  it("B안: 비-LEGEND 선수도 캐릭터가 붙는다(플레이스holder 로 안 떨어진다)", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P050", name: "Some Player", grade: "GOLD" }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P050").dataset.avatarKind).toBe("character"),
    );
  });

  it("매핑 파일이 없으면 플레이스홀더 아틀라스로 떨어진다(깨짐 0)", async () => {
    vi.stubGlobal("fetch", stubFetch(["/player-chars.json"]));
    renderAvatar(h(CharAvatar, { playerId: "P050", name: "Some Player", grade: "GOLD" }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P050").dataset.avatarKind).toBe("placeholder"),
    );
    expect(screen.getByTestId("char-avatar-P050").style.backgroundImage).toContain("/chars/avatars-64.png");
  });

  it("에셋이 전부 없으면 CSS 플레이스홀더 + 이니셜(외부 요청 0)", async () => {
    vi.stubGlobal("fetch", stubFetch(["/manifest.json", "/player-chars.json"]));
    renderAvatar(h(CharAvatar, { playerId: "P050", name: "Some Player", grade: "GOLD" }));
    await waitFor(() => expect(screen.getByText("SP")).toBeTruthy());
    expect(screen.getByTestId("char-avatar-P050").dataset.avatarKind).toBe("placeholder-css");
  });

  it("모르는 선수 id 도 터지지 않고 CSS 폴백", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P999", name: "Ghost", grade: "BRONZE" }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P999").dataset.avatarKind).toBe("placeholder-css"),
    );
  });

  it("size 를 주면 타일이 그 크기로 스케일된다", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P001", name: "Lev Yashin", size: 32 }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P001").dataset.avatarKind).toBe("character"),
    );
    const style = screen.getByTestId("char-avatar-P001").style;
    expect(style.width).toBe("32px");
    // 64px 타일 4×4 시트를 32px 로 → 시트 128px
    expect(style.backgroundSize).toBe("128px 128px");
  });

  it("alt 를 주면 접근성 이미지, 없으면 장식(aria-hidden)", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P001", name: "Lev Yashin", alt: "Lev Yashin 초상" }));
    await waitFor(() => expect(screen.getByLabelText("Lev Yashin 초상")).toBeTruthy());
    cleanup();
    renderAvatar(h(CharAvatar, { playerId: "P002", name: "Franz Beckenbauer" }));
    expect(screen.getByTestId("char-avatar-P002").getAttribute("aria-hidden")).toBe("true");
  });
});
