import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  CHARS_BASE,
  assetUrl,
  characterCardUrl,
  characterTile,
  frameUrl,
  placeholderTile,
  resolveTile,
  tileFrom,
  tileStyle,
  type CharactersManifest,
  type PlaceholderManifest,
} from "./char-manifest";

// 발행물 원본을 그대로 읽는다 — 손으로 만든 픽스처가 계약과 드리프트하는 걸 막는다.
const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "..", "..", "..", "design", "characters", "dist");
const charsManifest: CharactersManifest = JSON.parse(
  readFileSync(join(distDir, "characters", "manifest.json"), "utf8"),
);
const placeholderManifest: PlaceholderManifest = JSON.parse(
  readFileSync(join(distDir, "manifest.json"), "utf8"),
);

describe("assetUrl", () => {
  it("manifest 상대경로를 스테이징 오리진 경로로 만든다", () => {
    expect(assetUrl("characters/avatars-64.png")).toBe("/chars/characters/avatars-64.png");
    expect(assetUrl("avatars-32.png")).toBe("/chars/avatars-32.png");
  });

  it("선행 ./ 나 / 를 중복 없이 흡수한다", () => {
    expect(assetUrl("./avatars-32.png")).toBe("/chars/avatars-32.png");
    expect(assetUrl("/avatars-32.png")).toBe("/chars/avatars-32.png");
  });

  it("base 를 갈아끼울 수 있다(테스트/CDN 이관 대비)", () => {
    expect(assetUrl("avatars-32.png", "/cdn/x")).toBe("/cdn/x/avatars-32.png");
  });

  it("경로 탈출(..)과 빈 값은 거부한다", () => {
    expect(assetUrl("../../etc/passwd")).toBeNull();
    expect(assetUrl("characters/../../x.png")).toBeNull();
    expect(assetUrl("")).toBeNull();
    expect(assetUrl(undefined as unknown as string)).toBeNull();
  });
});

describe("tileFrom", () => {
  const atlases = { "a-8": { file: "a-8.png", tile: 8, cols: 4, rows: 3 } };

  it("격자 좌표를 픽셀 오프셋과 시트 크기로 환산한다", () => {
    expect(tileFrom(atlases, "a-8", { col: 2, row: 1 })).toEqual({
      url: "/chars/a-8.png",
      tile: 8,
      x: 16,
      y: 8,
      sheetWidth: 32,
      sheetHeight: 24,
    });
  });

  it("격자 밖 좌표는 null — 빈 타일을 그리지 않는다", () => {
    expect(tileFrom(atlases, "a-8", { col: 4, row: 0 })).toBeNull();
    expect(tileFrom(atlases, "a-8", { col: 0, row: 3 })).toBeNull();
    expect(tileFrom(atlases, "a-8", { col: -1, row: 0 })).toBeNull();
  });

  it("정수가 아닌 좌표(손상 manifest)는 null", () => {
    expect(tileFrom(atlases, "a-8", { col: 1.5, row: 0 })).toBeNull();
    expect(tileFrom(atlases, "a-8", { col: NaN, row: 0 })).toBeNull();
  });

  it("모르는 아틀라스 이름은 null", () => {
    expect(tileFrom(atlases, "a-64", { col: 0, row: 0 })).toBeNull();
  });

  // 회귀: JSON.parse 결과는 Object.prototype 을 갖는다 → 상속 멤버가 truthy 로 잡혀
  // 형상 가드를 통과한 뒤 undefined 필드에서 throw 했다(검증자 blocker B1).
  it("프로토타입 상속 키를 아틀라스로 오인하지 않는다 — throw 없이 null", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => tileFrom(atlases, key, { col: 0, row: 0 }), key).not.toThrow();
      expect(tileFrom(atlases, key, { col: 0, row: 0 }), key).toBeNull();
    }
  });

  // 회귀: 격자가 아닌 아틀라스(tile/cols/rows 없음)는 `0 >= undefined === false` 로 범위 가드를
  // 통과해 NaN 좌표를 흘렸다(검증자 blocker B2).
  it("격자 형상이 아닌 항목은 null — NaN 좌표를 흘리지 않는다", () => {
    const mixed = {
      grid: { file: "g.png", tile: 8, cols: 2, rows: 2 },
      frame: { file: "f.png", w: 226, h: 425, stars: 6 } as never,
      noFile: { tile: 8, cols: 2, rows: 2 } as never,
      zero: { file: "z.png", tile: 0, cols: 2, rows: 2 },
      fractional: { file: "q.png", tile: 8, cols: 2.5, rows: 2 },
    };
    expect(tileFrom(mixed, "grid", { col: 1, row: 1 })).not.toBeNull();
    for (const key of ["frame", "noFile", "zero", "fractional"]) {
      expect(tileFrom(mixed, key, { col: 0, row: 0 }), key).toBeNull();
    }
  });

  it("cell 자체가 없어도 throw 하지 않는다", () => {
    expect(() => tileFrom(atlases, "a-8", undefined as never)).not.toThrow();
    expect(tileFrom(atlases, "a-8", undefined as never)).toBeNull();
  });
});

describe("캐릭터 축 (발행물 실물)", () => {
  it("확정 14종 전부 요청한 모든 아틀라스에서 타일이 잡힌다", () => {
    const ids = Object.keys(charsManifest.characters);
    expect(ids.length).toBe(14);
    for (const id of ids) {
      for (const atlas of ["avatars-64", "avatars-32", "sprites-32", "sprites-8"]) {
        expect(characterTile(charsManifest, id, atlas), `${id}/${atlas}`).not.toBeNull();
      }
    }
  });

  it("아바타 타일 URL·크기가 발행 규격(4×4, 64px)과 일치한다", () => {
    expect(characterTile(charsManifest, "aura", "avatars-64")).toEqual({
      url: "/chars/characters/avatars-64.png",
      tile: 64,
      x: 3 * 64,
      y: 0,
      sheetWidth: 4 * 64,
      sheetHeight: 4 * 64,
    });
  });

  it("풀아트 카드 URL 이 14종 전부 잡힌다", () => {
    for (const id of Object.keys(charsManifest.characters)) {
      expect(characterCardUrl(charsManifest, id), id).toMatch(/^\/chars\/characters\/card-.+\.png$/);
    }
  });

  it("미등록 charId·null 은 타일도 카드도 null(폴백으로 떨어진다)", () => {
    expect(characterTile(charsManifest, "no-such-char", "avatars-64")).toBeNull();
    expect(characterTile(charsManifest, null, "avatars-64")).toBeNull();
    expect(characterCardUrl(charsManifest, "no-such-char")).toBeNull();
    expect(characterTile(null, "aura", "avatars-64")).toBeNull();
  });
});

describe("플레이스홀더 축 (발행물 실물)", () => {
  it("172명 전원 아바타·스프라이트 타일이 잡힌다 — 폴백에 구멍이 없다", () => {
    const ids = Object.keys(placeholderManifest.players);
    expect(ids.length).toBe(172);
    for (const id of ids) {
      expect(placeholderTile(placeholderManifest, id, "avatars-64"), id).not.toBeNull();
      expect(placeholderTile(placeholderManifest, id, "sprites-32"), id).not.toBeNull();
    }
  });

  it("모르는 playerId 는 null", () => {
    expect(placeholderTile(placeholderManifest, "P999", "avatars-64")).toBeNull();
  });
});

describe("resolveTile 폴백 체인", () => {
  const common = {
    characters: charsManifest,
    placeholders: placeholderManifest,
    atlas: "avatars-64",
  };

  it("캐릭터 매핑이 있으면 캐릭터 축을 쓴다", () => {
    const r = resolveTile({ ...common, charId: "aura", playerId: "P001" });
    expect(r?.kind).toBe("character");
    expect(r?.tile.url).toBe("/chars/characters/avatars-64.png");
  });

  it("캐릭터 매핑이 없으면 플레이스홀더 축으로 떨어진다", () => {
    const r = resolveTile({ ...common, charId: null, playerId: "P050" });
    expect(r?.kind).toBe("placeholder");
    expect(r?.tile.url).toBe("/chars/avatars-64.png");
  });

  it("charId 가 미등록이어도(오타·구버전) 플레이스홀더로 떨어진다", () => {
    const r = resolveTile({ ...common, charId: "ghost", playerId: "P050" });
    expect(r?.kind).toBe("placeholder");
  });

  it("둘 다 없으면 null — 호출부가 CSS 플레이스홀더로 간다", () => {
    expect(resolveTile({ ...common, charId: null, playerId: "P999" })).toBeNull();
    expect(resolveTile({ ...common, charId: "ghost", playerId: null })).toBeNull();
  });

  it("manifest 가 아직 안 왔어도(로딩 중) 터지지 않고 null", () => {
    expect(
      resolveTile({ characters: null, placeholders: null, charId: "aura", playerId: "P001", atlas: "avatars-64" }),
    ).toBeNull();
  });
});

describe("tileStyle", () => {
  it("요청 크기에 맞춰 시트와 오프셋을 같은 배율로 스케일한다", () => {
    const tile = characterTile(charsManifest, "aura", "avatars-64")!;
    const s = tileStyle(tile, 32); // 64px 타일을 32px 로 → k = 0.5
    expect(s.width).toBe("32px");
    expect(s.height).toBe("32px");
    expect(s.backgroundSize).toBe("128px 128px");
    expect(s.backgroundPosition).toBe("-96px -0px");
  });

  it("도트 원본이라 확대해도 보간하지 않는다", () => {
    const tile = characterTile(charsManifest, "aura", "avatars-32")!;
    expect(tileStyle(tile, 96).imageRendering).toBe("pixelated");
  });
});

describe("등급 프레임 (격자 아닌 축)", () => {
  it("발행물의 5등급 프레임 URL 이 전부 잡힌다", () => {
    for (const grade of ["LEGEND", "DIA", "GOLD", "SILVER", "BRONZE"]) {
      expect(frameUrl(placeholderManifest, grade), grade).toBe(`/chars/frame-${grade}.png`);
    }
  });

  it("모르는 등급·null 은 null", () => {
    expect(frameUrl(placeholderManifest, "MYTHIC")).toBeNull();
    expect(frameUrl(placeholderManifest, null)).toBeNull();
    expect(frameUrl(null, "GOLD")).toBeNull();
  });

  it("프레임을 격자 접근자로 부르면 null — 소비자가 NaN 타일을 받지 않는다", () => {
    expect(tileFrom(placeholderManifest.atlases, "frame-LEGEND", { col: 0, row: 0 })).toBeNull();
    expect(placeholderTile(placeholderManifest, "P001", "frame-GOLD")).toBeNull();
    expect(
      resolveTile({
        characters: charsManifest,
        placeholders: placeholderManifest,
        charId: "aura",
        playerId: "P001",
        atlas: "frame-DIA",
      }),
    ).toBeNull();
  });
});

describe("발행물 전수 스윕 — 어떤 조합도 NaN 을 만들지 않는다", () => {
  it("두 manifest 의 모든 아틀라스 이름 × 대표 엔트리에서 좌표가 유한하거나 null", () => {
    const names = [
      ...Object.keys(placeholderManifest.atlases),
      ...Object.keys(charsManifest.atlases),
      "constructor",
      "__proto__",
      "nope",
    ];
    for (const name of names) {
      const a = placeholderTile(placeholderManifest, "P001", name);
      const c = characterTile(charsManifest, "aura", name);
      for (const [label, t] of [["placeholder", a], ["character", c]] as const) {
        if (t === null) continue;
        for (const v of [t.tile, t.x, t.y, t.sheetWidth, t.sheetHeight]) {
          expect(Number.isFinite(v), `${label}/${name}`).toBe(true);
        }
        const style = tileStyle(t, 48);
        expect(style.backgroundSize, `${label}/${name}`).not.toContain("NaN");
        expect(style.backgroundPosition, `${label}/${name}`).not.toContain("NaN");
      }
    }
  });
});

describe("스테이징 계약", () => {
  it("소비 base 는 build-chars.mjs 출력 경로(/chars)와 일치한다", () => {
    expect(CHARS_BASE).toBe("/chars");
  });
});
