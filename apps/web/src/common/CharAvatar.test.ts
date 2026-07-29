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
  charRefFor,
  fetchCharAssets,
  loadCharAssets,
  resetCharAssetsCache,
  type CharAssets,
} from "./char-assets-store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const distDir = join(repoRoot, "design", "characters", "dist");

const charactersManifest = JSON.parse(readFileSync(join(distDir, "characters", "manifest.json"), "utf8"));
const unitsManifest = JSON.parse(readFileSync(join(distDir, "units", "manifest.json"), "utf8"));
const placeholderManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
const mappingFile = JSON.parse(readFileSync(join(repoRoot, "data", "players", "player-chars.v2.json"), "utf8"));

/** 스테이징된 4파일을 그대로 돌려주는 fetch 스텁. `missing` 에 든 경로는 404. */
function stubFetch(missing: string[] = []) {
  return vi.fn(async (url: string) => {
    const body = url.endsWith("/characters/manifest.json")
      ? charactersManifest
      : url.endsWith("/units/manifest.json")
        ? unitsManifest
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
  it("네 파일을 모아 온다(유닛 축 포함)", async () => {
    const assets = await fetchCharAssets();
    expect(assets.characters?.characters.aura).toBeTruthy();
    expect(assets.units?.units["default-unit"]).toBeTruthy();
    expect(Object.keys(assets.placeholders!.players)).toHaveLength(172);
    expect(assets.mapping?.players.P001).toEqual({ axis: "characters", id: "aura" });
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
      units: null,
      placeholders: null,
      mapping: null,
    });
  });

  it("동시 호출이 한 번만 fetch 한다(모듈 싱글턴)", async () => {
    const spy = stubFetch();
    vi.stubGlobal("fetch", spy);
    await Promise.all([loadCharAssets(), loadCharAssets(), loadCharAssets()]);
    expect(spy).toHaveBeenCalledTimes(4); // 파일 4개 × 1회 — 번들 자체는 1회만 로드
  });
});

describe("charRefFor — 두 발행 형(v1 문자열 / v2 축 객체)을 다 받는다", () => {
  const empty = { characters: null, units: null, placeholders: null };
  const v2: CharAssets = {
    ...empty,
    mapping: { players: { P001: { axis: "characters", id: "aura" }, P173: { axis: "units", id: "bonaldo" } } },
  };
  const v1: CharAssets = { ...empty, mapping: { players: { P001: "aura" } } };

  it("v2 항목은 축 태그 그대로 나온다", () => {
    expect(charRefFor(v2, "P001")).toEqual({ axis: "characters", id: "aura" });
    expect(charRefFor(v2, "P173")).toEqual({ axis: "units", id: "bonaldo" });
  });

  it("v1 문자열은 characters 축으로 정규화된다(구 발행물 롤백 안전)", () => {
    expect(charRefFor(v1, "P001")).toEqual({ axis: "characters", id: "aura" });
  });

  it("매핑에 없거나 id 가 없으면 null", () => {
    expect(charRefFor(v2, "P999")).toBeNull();
    expect(charRefFor(v2, null)).toBeNull();
    expect(charRefFor({ ...empty, mapping: null }, "P001")).toBeNull();
  });

  it("모르는 축·손상 항목은 null — 엉뚱한 manifest 를 뒤지지 않는다", () => {
    const broken: CharAssets = {
      ...empty,
      mapping: {
        players: {
          A: { axis: "sprites", id: "x" },
          B: { axis: "units" },
          C: { id: "x" },
          D: "",
          E: 7,
        } as never,
      },
    };
    for (const k of ["A", "B", "C", "D", "E"]) expect(charRefFor(broken, k), k).toBeNull();
  });

  it("charIdFor 는 characters 축일 때만 charId 를 준다(units 는 null)", () => {
    expect(charIdFor(v2, "P001")).toBe("aura");
    expect(charIdFor(v2, "P173")).toBeNull();
  });

  it("프로토타입 상속 키를 매핑으로 오인하지 않는다", () => {
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(charRefFor(v2, key), key).toBeNull();
      expect(charIdFor(v2, key), key).toBeNull();
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

  it("활성 LEGEND 는 **유닛 축** 실아트 얼굴을 쓴다(#207 U-D5)", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P173", name: "보날두", grade: "LEGEND" }));
    await waitFor(() => expect(screen.getByTestId("char-avatar-P173").dataset.avatarKind).toBe("unit"));
    const el = screen.getByTestId("char-avatar-P173");
    expect(el.style.backgroundImage).toContain("/chars/units/avatars-64.png");
    // 불투명 다크 배경 전제 → 원형 마스크를 씌우지 않는다(글로우·수염선 보호).
    expect(el.dataset.iconBg).toBe("opaque-dark");
    expect(el.className).toContain("opaqueBg");
  });

  it("GOLD 이하는 공용 디폴트 유닛 얼굴이다(U-D8) — 등급이 달라도 같은 타일", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P050", name: "Gold Player", grade: "GOLD" }));
    renderAvatar(h(CharAvatar, { playerId: "P160", name: "Bronze Player", grade: "BRONZE" }));
    await waitFor(() => expect(screen.getByTestId("char-avatar-P050").dataset.avatarKind).toBe("unit"));
    const gold = screen.getByTestId("char-avatar-P050");
    const bronze = screen.getByTestId("char-avatar-P160");
    expect(bronze.dataset.avatarKind).toBe("unit");
    expect(gold.style.backgroundPosition).toBe(bronze.style.backgroundPosition);
    expect(gold.style.backgroundImage).toContain("/chars/units/avatars-64.png");
    // 디폴트 유닛은 투명 배경 계약 → 기존 원형 마스크를 유지한다.
    expect(gold.dataset.iconBg).toBe("transparent");
    expect(gold.className).not.toContain("opaqueBg");
  });

  it("DIA 는 현행 characters 축 유지(U-D9)", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P013", name: "Dia Player", grade: "DIA" }));
    await waitFor(() => expect(screen.getByTestId("char-avatar-P013").dataset.avatarKind).toBe("character"));
    expect(screen.getByTestId("char-avatar-P013").style.backgroundImage)
      .toContain("/chars/characters/avatars-64.png");
  });

  it("아트 미입고 LEGEND(P174/P178)는 이니셜 폴백이다 — 깨진 이미지 0", async () => {
    for (const [id, name] of [["P174", "권씨"], ["P178", "석신"]] as const) {
      renderAvatar(h(CharAvatar, { playerId: id, name, grade: "LEGEND" }));
      await waitFor(() =>
        expect(screen.getByTestId(`char-avatar-${id}`).dataset.avatarKind).toBe("placeholder-css"),
      );
      cleanup();
    }
  });

  // 3차 입고(2026-07-29) — 아트가 들어온 순간 폴백이 아니라 **실아트**로 떠야 한다. 시드에선
  // 아직 비활성이지만 매핑은 붙어 있으므로(활성화는 어드민 API 몫), 아바타는 units 축을 탄다.
  it("3차 입고 LEGEND(P180 경니시우스)는 units 축 실아트로 뜬다 — 폴백 아님", async () => {
    renderAvatar(h(CharAvatar, { playerId: "P180", name: "경니시우스", grade: "LEGEND" }));
    await waitFor(() => expect(screen.getByTestId("char-avatar-P180").dataset.avatarKind).toBe("unit"));
    expect(screen.getByTestId("char-avatar-P180").style.backgroundImage)
      .toContain("/chars/units/avatars-64.png");
  });

  it("유닛 manifest 만 없으면 유닛 매핑 선수는 플레이스홀더 축으로 떨어진다(부분 열화)", async () => {
    vi.stubGlobal("fetch", stubFetch(["/units/manifest.json"]));
    renderAvatar(h(CharAvatar, { playerId: "P050", name: "Gold Player", grade: "GOLD" }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P050").dataset.avatarKind).toBe("placeholder"),
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
