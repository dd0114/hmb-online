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
  unitCard,
  unitIconBackground,
  unitIsSharedDefault,
  unitTile,
  type CharactersManifest,
  type PlaceholderManifest,
  type UnitsManifest,
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
const unitsManifest: UnitsManifest = JSON.parse(readFileSync(join(distDir, "units", "manifest.json"), "utf8"));

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

describe("resolveTile 폴백 체인 — 축 태그가 어느 manifest 를 볼지 정한다", () => {
  const common = {
    characters: charsManifest,
    units: unitsManifest,
    placeholders: placeholderManifest,
    atlas: "avatars-64",
  };

  it("characters 축 참조는 캐릭터 아틀라스를 쓴다", () => {
    const r = resolveTile({ ...common, ref: { axis: "characters", id: "aura" }, playerId: "P001" });
    expect(r?.kind).toBe("character");
    expect(r?.tile.url).toBe("/chars/characters/avatars-64.png");
  });

  it("units 축 참조는 **유닛 아틀라스**를 쓴다(축을 섞지 않는다)", () => {
    const r = resolveTile({ ...common, ref: { axis: "units", id: "bonaldo" }, playerId: "P173" });
    expect(r?.kind).toBe("unit");
    expect(r?.tile.url).toBe("/chars/units/avatars-64.png");
    // 같은 id 를 캐릭터 축에서 찾으면 없다 — 축을 잘못 고르면 폴백으로 떨어진다는 뜻.
    expect(characterTile(charsManifest, "bonaldo", "avatars-64")).toBeNull();
  });

  it("GOLD 이하 공용 디폴트 유닛도 유닛 축 타일이다", () => {
    const r = resolveTile({ ...common, ref: { axis: "units", id: "default-unit" }, playerId: "P050" });
    expect(r?.kind).toBe("unit");
    expect(r?.tile.url).toBe("/chars/units/avatars-64.png");
  });

  it("매핑이 없으면 플레이스홀더 축으로 떨어진다", () => {
    const r = resolveTile({ ...common, ref: null, playerId: "P050" });
    expect(r?.kind).toBe("placeholder");
    expect(r?.tile.url).toBe("/chars/avatars-64.png");
  });

  it("id 가 미등록이어도(오타·구버전) 플레이스홀더로 떨어진다 — 두 축 모두", () => {
    expect(resolveTile({ ...common, ref: { axis: "characters", id: "ghost" }, playerId: "P050" })?.kind)
      .toBe("placeholder");
    expect(resolveTile({ ...common, ref: { axis: "units", id: "ghost" }, playerId: "P050" })?.kind)
      .toBe("placeholder");
  });

  it("구 v1 문자열 매핑이 흘러들어와도 characters 축으로 해석한다(롤백 안전)", () => {
    const r = resolveTile({ ...common, ref: "aura", playerId: "P001" });
    expect(r?.kind).toBe("character");
  });

  it("유닛 manifest 가 아직 안 왔으면 units 참조도 플레이스홀더로 떨어진다(깨짐 0)", () => {
    const r = resolveTile({ ...common, units: null, ref: { axis: "units", id: "bonaldo" }, playerId: "P050" });
    expect(r?.kind).toBe("placeholder");
  });

  it("둘 다 없으면 null — 호출부가 CSS 플레이스홀더로 간다", () => {
    expect(resolveTile({ ...common, ref: null, playerId: "P999" })).toBeNull();
    expect(resolveTile({ ...common, ref: { axis: "units", id: "ghost" }, playerId: null })).toBeNull();
  });

  it("manifest 가 아직 안 왔어도(로딩 중) 터지지 않고 null", () => {
    expect(
      resolveTile({
        characters: null,
        units: null,
        placeholders: null,
        ref: { axis: "characters", id: "aura" },
        playerId: "P001",
        atlas: "avatars-64",
      }),
    ).toBeNull();
  });
});

describe("유닛 축 접근자 (#207 W3-B 발행 계약)", () => {
  // 격자 크기는 발행 유닛 수에 따라 자란다(3차 입고에서 3×2 → 3×3). 리터럴로 박으면 입고마다
  // 깨지므로 **발행물이 선언한 격자**를 기준으로 검사한다 — 계약은 "전원이 자기 격자 안에 있고
  // 좌표가 안 겹친다"이지 "격자가 3×2 다"가 아니다.
  it("발행물 전종이 선언된 격자 안에 있고 좌표가 겹치지 않는다", () => {
    const grid = unitsManifest.atlases["avatars-64"]!;
    const ids = Object.keys(unitsManifest.units);
    const seen = new Set<string>();
    for (const [unitId, entry] of Object.entries(unitsManifest.units)) {
      const tile = unitTile(unitsManifest, unitId, "avatars-64");
      expect(tile, unitId).toBeTruthy();
      expect(entry!.col).toBeLessThan(grid.cols);
      expect(entry!.row).toBeLessThan(grid.rows);
      const key = `${entry!.col},${entry!.row}`;
      expect(seen.has(key), `${unitId} 좌표 충돌 ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(ids.length);
    // 격자가 전원을 담을 수 있어야 한다(행이 모자라면 마지막 유닛이 시트 밖으로 나간다).
    expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(ids.length);
  });

  it("세 해상도 아틀라스가 모두 잡힌다", () => {
    for (const [atlas, tile] of [["avatars-64", 64], ["avatars-32", 32], ["avatars-16", 16]] as const) {
      expect(unitTile(unitsManifest, "bonaldo", atlas)?.tile, atlas).toBe(tile);
    }
  });

  /**
   * 발행 구성(어느 유닛이 complete 인가)은 **발행측이 정한다** — 재발행 한 번으로 바뀐다.
   * 실제로 #207 재발행에서 보날두·욱링엄이 완성 카드 → 프레임리스 아트가 되어 `complete` 이
   * 0종이 됐다. 그래서 여기서는 **구성이 아니라 해석 규칙**을 건다(이름·개수 하드핀 금지).
   * `complete` 분기 자체는 바로 아래 픽스처 테스트가 발행 구성과 무관하게 지킨다.
   */
  it("card.kind — 발행물의 모든 유닛이 선언된 두 kind 중 하나로 해석된다(모르는 kind 0)", () => {
    const kinds = Object.fromEntries(
      Object.keys(unitsManifest.units).map((id) => [id, unitCard(unitsManifest, id)?.kind]),
    );
    expect(Object.values(kinds).every((k) => k === "complete" || k === "frameless-art")).toBe(true);
    // manifest 가 선언한 종류만 실린다 — 선언에 없는 kind 가 발행되면 잡힌다.
    const declared = Object.keys(
      (unitsManifest as unknown as { cardKinds: Record<string, string> }).cardKinds,
    );
    expect(declared).toContain("complete"); // 0종이어도 선언은 남는다(재발행 여지 = 계약)
    for (const k of Object.values(kinds)) expect(declared).toContain(k);
    // 현 구성 스냅샷(정보성): complete 0 · frameless-art 6.
    expect(Object.values(kinds).filter((k) => k === "frameless-art"))
      .toHaveLength(Object.keys(unitsManifest.units).length
        - Object.values(kinds).filter((k) => k === "complete").length);
  });

  /**
   * **`complete` 해석 계약은 발행 구성과 무관하게 살아 있어야 한다.**
   * 실 manifest 에 complete 이 0종이라 실물 기반 단언만 남기면 이 분기가 조용히 죽는다
   * (= 나중에 완성 카드를 다시 실었을 때 프레임 두 겹을 아무도 못 잡는다).
   */
  it("`complete` 분기 — 픽스처로 직접 검증(발행에 0종이어도 계약은 산다)", () => {
    const fixture = {
      ...unitsManifest,
      units: {
        ...unitsManifest.units,
        "fixture-complete": {
          col: 0, row: 0,
          card: { file: "units/card-fixture.png", kind: "complete", w: 512, h: 768 },
        },
      },
    } as unknown as UnitsManifest;
    expect(unitCard(fixture, "fixture-complete")).toEqual({
      url: "/chars/units/card-fixture.png",
      kind: "complete",
      pixelArt: false,
      w: 512,
      h: 768,
    });
  });

  it("디폴트 유닛만 pixelArt — 도트 원본이라 확대해도 보간하면 안 된다", () => {
    expect(unitCard(unitsManifest, "default-unit")?.pixelArt).toBe(true);
    for (const id of Object.keys(unitsManifest.units)) {
      if (id === "default-unit") continue;
      expect(unitCard(unitsManifest, id)?.pixelArt, id).toBe(false);
    }
  });

  it("**모르는 kind 는 null** — 새 종류를 기존 두 경로 중 하나로 넘겨짚지 않는다", () => {
    const mutated: UnitsManifest = {
      ...unitsManifest,
      units: { ...unitsManifest.units, x: { col: 0, row: 0, card: { file: "u.png", kind: "sticker", w: 1, h: 1 } } },
    } as unknown as UnitsManifest;
    expect(unitCard(mutated, "x")).toBeNull();
  });

  it("손상 card(경로 탈출·0 크기·비객체)는 null 로 떨어지고 throw 하지 않는다", () => {
    const bads = [
      { file: "../../etc/x.png", kind: "complete", w: 1, h: 1 },
      { file: "u.png", kind: "complete", w: 0, h: 10 },
      { file: "u.png", kind: "complete", w: 10, h: -1 },
      "u.png",
      null,
    ];
    for (const card of bads) {
      const m = { ...unitsManifest, units: { ...unitsManifest.units, x: { col: 0, row: 0, card } } };
      expect(() => unitCard(m as unknown as UnitsManifest, "x")).not.toThrow();
      expect(unitCard(m as unknown as UnitsManifest, "x"), JSON.stringify(card)).toBeNull();
    }
  });

  it("iconBackground — 레전더리 5종은 불투명 다크, 디폴트 유닛은 투명", () => {
    for (const id of ["bonaldo", "yeoldona", "chunbappe", "dukbrayner", "wookringham"]) {
      expect(unitIconBackground(unitsManifest, id), id).toBe("opaque-dark");
    }
    expect(unitIconBackground(unitsManifest, "default-unit")).toBe("transparent");
    // 모르는 값·미등록·manifest 부재는 전부 기존 계약(투명)으로 떨어진다.
    expect(unitIconBackground(unitsManifest, "ghost")).toBe("transparent");
    expect(unitIconBackground(null, "bonaldo")).toBe("transparent");
  });

  it("공용 디폴트 판정은 발행물의 forGrades 선언으로 한다(유닛명 하드코딩 금지 — #218)", () => {
    // 경기장이 "고유 아트만 태운다"(U-D8)를 판단하는 기준. 발행이 바뀌면 값이 따라 바뀌어야 한다.
    for (const id of ["bonaldo", "yeoldona", "chunbappe", "dukbrayner", "wookringham"]) {
      expect(unitIsSharedDefault(unitsManifest, id), id).toBe(false);
    }
    expect(unitIsSharedDefault(unitsManifest, "default-unit")).toBe(true);
    // 빈 배열은 "공용" 이 아니다(누구에게도 안 걸린 선언) + 미등록/부재는 false.
    const emptied = {
      ...unitsManifest,
      units: { ...unitsManifest.units, x: { col: 0, row: 0, forGrades: [] } },
    } as unknown as UnitsManifest;
    expect(unitIsSharedDefault(emptied, "x")).toBe(false);
    expect(unitIsSharedDefault(unitsManifest, "ghost")).toBe(false);
    expect(unitIsSharedDefault(null, "default-unit")).toBe(false);
  });

  it("프로토타입 상속 키를 유닛으로 오인하지 않는다", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(unitTile(unitsManifest, key, "avatars-64"), key).toBeNull();
      expect(unitCard(unitsManifest, key), key).toBeNull();
      expect(unitIsSharedDefault(unitsManifest, key), key).toBe(false);
    }
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
        units: unitsManifest,
        placeholders: placeholderManifest,
        ref: { axis: "characters", id: "aura" },
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
