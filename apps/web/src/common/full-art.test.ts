import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_CARD_GEOMETRY,
  FULL_ART_SIZES,
  cardAspect,
  cardLayers,
  fullArtLayers,
  fullArtLayout,
  fullArtWidth,
  gradeFrameUrl,
  gradeRingShadow,
  preloadUrls,
  resolveCardGeometry,
  type CardGeometry,
} from "./full-art";
import { GRADE_COLORS, GRADE_ORDER } from "./grades";
import type { CharactersManifest, PlaceholderManifest, UnitsManifest } from "./char-manifest";

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

/** PNG IHDR 에서 폭·높이만 뽑는다(디코더 없이 — 규격 대조에는 이걸로 충분). */
function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("카드 규격 — 발행물과의 정합", () => {
  it("기본 규격이 실제 프레임 PNG 크기와 같다 (드리프트 가드)", () => {
    // 파이프라인이 CARD 규격을 바꾸면 여기서 먼저 터진다 → cardGeometry 발행 or 기본값 갱신.
    for (const grade of GRADE_ORDER) {
      const size = pngSize(join(distDir, `frame-${grade}.png`));
      expect(size, `frame-${grade}.png`).toEqual({
        w: DEFAULT_CARD_GEOMETRY.w,
        h: DEFAULT_CARD_GEOMETRY.h,
      });
    }
  });

  it("캐릭터 카드 PNG 도 같은 규격이다 — 두 층이 픽셀 단위로 맞물려야 합성이 성립한다", () => {
    for (const [charId, entry] of Object.entries(charsManifest.characters)) {
      if (!entry?.card) continue;
      const size = pngSize(join(distDir, "..", "dist", entry.card));
      expect(size, `card-${charId}`).toEqual({
        w: DEFAULT_CARD_GEOMETRY.w,
        h: DEFAULT_CARD_GEOMETRY.h,
      });
    }
  });
});

describe("resolveCardGeometry — 에셋 교체 경로", () => {
  it("manifest 에 cardGeometry 가 없으면 기본값", () => {
    expect(resolveCardGeometry(charsManifest)).toEqual(DEFAULT_CARD_GEOMETRY);
    expect(resolveCardGeometry(null)).toEqual(DEFAULT_CARD_GEOMETRY);
    expect(resolveCardGeometry(undefined)).toEqual(DEFAULT_CARD_GEOMETRY);
  });

  it("발행물이 실어 보내면 그 값이 이긴다 (web 코드 수정 없이 규격 변경)", () => {
    const m = { ...charsManifest, cardGeometry: { w: 300, h: 500, inset: 14, artBottom: 400 } };
    const g = resolveCardGeometry(m as CharactersManifest);
    expect(g.w).toBe(300);
    expect(g.h).toBe(500);
    expect(g.inset).toBe(14);
    expect(g.artBottom).toBe(400);
    // 안 실은 필드는 기본값이 남는다(부분 발행 허용).
    expect(g.nameY).toBe(DEFAULT_CARD_GEOMETRY.nameY);
    expect(g.badge).toEqual(DEFAULT_CARD_GEOMETRY.badge);
  });

  it("손상 필드는 그 필드만 기본값으로 떨어진다 (전체가 무너지지 않는다)", () => {
    const m = {
      ...charsManifest,
      cardGeometry: { w: "wide", h: NaN, inset: -3, nameY: 100, badge: { x: null, w: 50 } },
    };
    const g = resolveCardGeometry(m as unknown as CharactersManifest);
    expect(g.w).toBe(DEFAULT_CARD_GEOMETRY.w);
    expect(g.h).toBe(DEFAULT_CARD_GEOMETRY.h);
    expect(g.inset).toBe(DEFAULT_CARD_GEOMETRY.inset);
    expect(g.nameY).toBe(100); // 정상 필드는 살아남는다
    expect(g.badge.x).toBe(DEFAULT_CARD_GEOMETRY.badge.x);
    expect(g.badge.w).toBe(50);
  });

  it("아트 영역이 성립하지 않는 조합은 통째로 기본값 (렌더 불가 상태를 만들지 않는다)", () => {
    const tooThick = { ...charsManifest, cardGeometry: { w: 100, inset: 60 } };
    expect(resolveCardGeometry(tooThick as CharactersManifest)).toEqual(DEFAULT_CARD_GEOMETRY);
    const inverted = { ...charsManifest, cardGeometry: { inset: 200, artBottom: 100 } };
    expect(resolveCardGeometry(inverted as CharactersManifest)).toEqual(DEFAULT_CARD_GEOMETRY);
  });

  it("어떤 쓰레기 입력에도 throw 하지 않는다", () => {
    for (const bad of [{ cardGeometry: null }, { cardGeometry: 7 }, { cardGeometry: "x" }, { cardGeometry: [] }]) {
      expect(() => resolveCardGeometry({ ...charsManifest, ...bad } as CharactersManifest)).not.toThrow();
    }
  });
});

describe("fullArtLayout — 층 좌표", () => {
  const L = fullArtLayout();
  const num = (s: string) => Number.parseFloat(s);

  it("아트 창이 프레임 인셋 안에 정확히 앉는다", () => {
    const g = DEFAULT_CARD_GEOMETRY;
    expect(num(L.window.left)).toBeCloseTo((g.inset / g.w) * 100, 3);
    expect(num(L.window.width)).toBeCloseTo(((g.w - g.inset * 2) / g.w) * 100, 3);
    // 창 오른쪽 끝 = 100% - 왼쪽 인셋 → 좌우 대칭
    expect(num(L.window.left) + num(L.window.width)).toBeCloseTo(100 - (g.inset / g.w) * 100, 3);
  });

  it("창 안 이미지의 가시 구간이 원본 아트 영역과 정확히 일치한다", () => {
    // 창 폭을 1 로 두면, 이미지 폭 w/artW · 오프셋 -inset/artW 라서
    // 창 왼쪽 = 원본 inset, 창 오른쪽 = 원본 inset+artW 가 나와야 한다.
    const g = DEFAULT_CARD_GEOMETRY;
    const artW = g.w - g.inset * 2;
    const imgW = num(L.art.width) / 100; // 창 폭 배수
    const left = num(L.art.left) / 100;
    const scale = imgW / g.w; // 원본 1px 이 창 폭에서 차지하는 비율
    // 허용오차 3자리: 퍼센트 문자열이 소수 4자리라 원본 좌표로 환산하면 ~1e-4px 오차가 남는다
    // (서브픽셀 이하 — 시각적으로 0). 여기서 잡고 싶은 건 반올림이 아니라 **좌표 공식**이다.
    expect(-left / scale).toBeCloseTo(g.inset, 3); // 창 왼쪽이 보는 원본 x
    expect((1 - left) / scale).toBeCloseTo(g.inset + artW, 3); // 창 오른쪽이 보는 원본 x

    const artH = g.artBottom - g.inset;
    const imgH = num(L.art.height) / 100;
    const top = num(L.art.top) / 100;
    const scaleY = imgH / g.h;
    expect(-top / scaleY).toBeCloseTo(g.inset, 3);
    expect((1 - top) / scaleY).toBeCloseTo(g.inset + artH, 3);
  });

  it("이름·설명 밴드가 아트 창 아래이고 카드 안에 들어간다 (겹침·넘침 0)", () => {
    expect(num(L.name.top)).toBeGreaterThanOrEqual(num(L.window.top) + num(L.window.height) - 0.5);
    expect(num(L.desc.top)).toBeGreaterThan(num(L.name.top));
    expect(num(L.desc.top) + num(L.desc.height)).toBeLessThanOrEqual(100);
  });

  it("규격이 바뀌면 좌표도 따라 바뀐다 (하드코딩된 퍼센트가 아니다)", () => {
    const g2: CardGeometry = { ...DEFAULT_CARD_GEOMETRY, inset: 20 };
    const L2 = fullArtLayout(g2);
    expect(num(L2.window.left)).toBeCloseTo((20 / g2.w) * 100, 3);
    expect(L2.window.left).not.toBe(L.window.left);
  });

  it("cardAspect 가 규격을 따른다", () => {
    expect(cardAspect()).toBe("226 / 425");
    expect(cardAspect({ ...DEFAULT_CARD_GEOMETRY, w: 300, h: 500 })).toBe("300 / 500");
  });
});

describe("fullArtLayers — 폴백 3단", () => {
  const base = { characters: charsManifest, placeholders: placeholderManifest };
  const firstChar = Object.keys(charsManifest.characters)[0]!;

  it("매핑 O + 프레임 O → full-art", () => {
    const r = fullArtLayers({ ...base, charId: firstChar, grade: "LEGEND" });
    expect(r.kind).toBe("full-art");
    expect(r.art).toMatch(/^\/chars\/characters\/card-.+\.png$/);
    expect(r.frame).toBe("/chars/frame-LEGEND.png");
  });

  it("매핑 X → frame-only (프레임 + 아이콘)", () => {
    const r = fullArtLayers({ ...base, charId: null, grade: "GOLD" });
    expect(r.kind).toBe("frame-only");
    expect(r.art).toBeNull();
    expect(r.frame).toBe("/chars/frame-GOLD.png");
  });

  it("에셋 번들 자체가 없으면 none (CSS 폴백으로)", () => {
    const r = fullArtLayers({ characters: null, placeholders: null, charId: firstChar, grade: "GOLD" });
    expect(r).toEqual({ art: null, frame: null, kind: "none" });
  });

  it("등급이 이상하면 프레임을 못 찾고 none — throw 하지 않는다", () => {
    for (const bad of [null, undefined, "", "PLATINUM", "__proto__", "constructor"]) {
      const r = fullArtLayers({ ...base, charId: firstChar, grade: bad });
      expect(r.kind).toBe("none");
      expect(r.frame).toBeNull();
    }
  });

  it("전 등급이 프레임 URL 을 갖는다 (발행물 커버리지)", () => {
    for (const g of GRADE_ORDER) {
      expect(gradeFrameUrl(placeholderManifest, g), g).toBe(`/chars/frame-${g}.png`);
    }
  });

  it("preloadUrls 는 실제로 받을 것만 돌려준다", () => {
    expect(preloadUrls(fullArtLayers({ ...base, charId: firstChar, grade: "DIA" }))).toHaveLength(2);
    expect(preloadUrls(fullArtLayers({ ...base, charId: null, grade: "DIA" }))).toHaveLength(1);
    expect(preloadUrls({ art: null, frame: null })).toHaveLength(0);
  });
});

describe("디자인 토큰", () => {
  it("크기 토큰은 이름으로 쓰고, 픽셀도 받는다", () => {
    expect(fullArtWidth("grid")).toBe(FULL_ART_SIZES.grid);
    expect(fullArtWidth("hero")).toBe(FULL_ART_SIZES.hero);
    expect(fullArtWidth(123)).toBe(123);
  });

  it("그리드 토큰은 모바일 390 에서 3열이 나오는 폭이다", () => {
    // 실측 근거: 뽑기 시트 = 오버레이 패딩 + 시트 패딩(폰에서 각각 10/12 로 줄였다,
    // GachaReveal.module.css @media 430) + 열 간격 9×2.
    // ⚠️ 처음엔 12/12 로 어림했다가 실화면에서 2열로 떨어졌다 — 어림값이 아니라 CSS 실값이다.
    const usable = 390 - (10 + 12) * 2 - 9 * 2;
    expect(Math.floor(usable / FULL_ART_SIZES.grid)).toBe(3);
  });

  it("이름이 읽히는 하한(104px) 아래로 그리드 토큰이 내려가지 않는다", () => {
    // 웨이브1 실측: 96px 에서는 카드 안 이름이 안 읽혔다.
    expect(FULL_ART_SIZES.grid).toBeGreaterThanOrEqual(104);
  });

  it("등급 링이 web 등급색을 그대로 쓴다 — LEGEND 는 프레임 금색과 다른 축이어야 한다", () => {
    for (const g of GRADE_ORDER) {
      expect(gradeRingShadow(g)).toContain(GRADE_COLORS[g]);
    }
    // D4 의 핵심: LEGEND 링이 프레임 에셋의 금색(#e4991c)과 달라야 GOLD 와 갈린다.
    expect(GRADE_COLORS.LEGEND.toLowerCase()).not.toBe("#e4991c");
    expect(gradeRingShadow(null)).toBeUndefined();
  });
});

describe("cardLayers — `card.kind` 분기 (#207 U-D8)", () => {
  const base = { characters: charsManifest, units: unitsManifest, placeholders: placeholderManifest };
  const firstChar = Object.keys(charsManifest.characters)[0]!;
  /** 발행 manifest 가 권위 — 유닛 이름을 테스트에도 박지 않는다. */
  const completeIds = Object.entries(unitsManifest.units)
    .filter(([, u]) => u?.card?.kind === "complete")
    .map(([id]) => id);
  const framelessIds = Object.entries(unitsManifest.units)
    .filter(([, u]) => u?.card?.kind === "frameless-art")
    .map(([id]) => id);

  /**
   * **픽스처 manifest 로 `complete` 분기 자체를 태운다.**
   * 발행 구성은 재발행 한 번으로 바뀐다 — 실제로 #207 재발행에서 보날두·욱링엄이 프레임리스
   * 아트가 되어 `complete` 이 0종이 됐다. 실물 기반 단언만 두면 그 순간 이 계약이 **공허하게
   * 통과하며 죽는다**(다음에 완성 카드를 다시 실었을 때 프레임 두 겹을 아무도 못 잡는다).
   * 그래서 계약은 픽스처가 지키고, 실 발행물은 아래 테스트가 "있으면 규칙대로"만 확인한다.
   */
  const FIXTURE_ID = "fixture-complete";
  const withFixtureComplete = {
    ...unitsManifest,
    units: {
      ...unitsManifest.units,
      [FIXTURE_ID]: {
        col: 0, row: 0,
        card: { file: "units/card-fixture.png", kind: "complete", w: 512, h: 768 },
      },
    },
  } as unknown as typeof unitsManifest;

  it("완성 카드는 **frame-<GRADE> 합성 경로를 타지 않는다**(프레임 두 겹 방지) — 픽스처", () => {
    const r = cardLayers({
      ...base, units: withFixtureComplete, ref: { axis: "units", id: FIXTURE_ID }, grade: "LEGEND",
    });
    expect(r.kind).toBe("unit-complete");
    expect(r.frame).toBeNull(); // ← 여기가 계약의 핵심
    expect(r.fit).toBe("whole");
    expect(r.art).toBe("/chars/units/card-fixture.png");
    // 종횡비는 **발행 규격 그대로**(226×425 카드 비율에 욱여넣으면 구워진 프레임이 잘린다).
    expect(r.aspect).toBe("512 / 768");
    // 등급을 바꿔도 프레임은 안 붙는다 — 등급 축과 무관한 통짜 에셋이다.
    for (const g of GRADE_ORDER) {
      expect(cardLayers({
        ...base, units: withFixtureComplete, ref: { axis: "units", id: FIXTURE_ID }, grade: g,
      }).frame, g).toBeNull();
    }
  });

  it("실 발행물에 완성 카드가 **있으면** 같은 규칙을 따른다(0종이면 vacuous)", () => {
    for (const id of completeIds) {
      const r = cardLayers({ ...base, ref: { axis: "units", id }, grade: "LEGEND" });
      expect(r.kind, id).toBe("unit-complete");
      expect(r.frame, id).toBeNull();
      expect(r.fit, id).toBe("whole");
      expect(r.art, id).toBe(`/chars/${unitsManifest.units[id]!.card!.file}`);
      expect(r.aspect, id).toBe(`${unitsManifest.units[id]!.card!.w} / ${unitsManifest.units[id]!.card!.h}`);
    }
    // 발행 구성 스냅샷 — 재발행으로 바뀌면 여기서 알린다(수치를 정답으로 쓰지는 않는다).
    expect(completeIds.length + framelessIds.length).toBe(Object.keys(unitsManifest.units).length);
  });

  it("프레임리스 아트는 기존 합성 경로를 그대로 탄다(등급 프레임 + 아트)", () => {
    expect(framelessIds.length).toBeGreaterThan(0);
    for (const id of framelessIds) {
      const r = cardLayers({ ...base, ref: { axis: "units", id }, grade: "GOLD" });
      expect(r.kind, id).toBe("unit-art");
      expect(r.frame, id).toBe("/chars/frame-GOLD.png"); // ← 합성 경로
      expect(r.fit, id).toBe("fill"); // 잘라낼 프레임이 없으니 크롭 오프셋을 쓰지 않는다
      expect(r.art, id).toBe(`/chars/${unitsManifest.units[id]!.card!.file}`);
    }
  });

  it("디폴트 유닛만 pixelArt=true — 도트가 뭉개지면 안 된다", () => {
    const dot = cardLayers({ ...base, ref: { axis: "units", id: "default-unit" }, grade: "BRONZE" });
    expect(dot.pixelArt).toBe(true);
    // 나머지 유닛은 전부 보간(사진형 아트가 계단지면 안 된다) — 완성/프레임리스 구분 없이.
    const others = Object.keys(unitsManifest.units).filter((id) => id !== "default-unit");
    expect(others.length).toBeGreaterThan(0);
    for (const id of others) {
      expect(cardLayers({ ...base, ref: { axis: "units", id }, grade: "LEGEND" }).pixelArt, id).toBe(false);
    }
  });

  it("characters 축은 기존 크롭 합성 그대로(무회귀)", () => {
    const r = cardLayers({ ...base, ref: { axis: "characters", id: firstChar }, grade: "DIA" });
    expect(r.kind).toBe("full-art");
    expect(r.fit).toBe("crop");
    expect(r.frame).toBe("/chars/frame-DIA.png");
    expect(r.pixelArt).toBe(false);
    expect(r.aspect).toBeNull();
  });

  it("매핑이 없으면 frame-only, 프레임도 없으면 none (폴백 계단 유지)", () => {
    expect(cardLayers({ ...base, ref: null, grade: "GOLD" }).kind).toBe("frame-only");
    expect(cardLayers({ ...base, ref: null, grade: "PLATINUM" }).kind).toBe("none");
  });

  it("유닛 축인데 에셋이 없거나 모르는 kind 면 폴백 — 틀린 그림을 그리지 않는다", () => {
    expect(cardLayers({ ...base, ref: { axis: "units", id: "ghost" }, grade: "GOLD" }).kind).toBe("frame-only");
    expect(cardLayers({ ...base, units: null, ref: { axis: "units", id: "bonaldo" }, grade: "LEGEND" }).kind)
      .toBe("frame-only");
    const weird = {
      ...unitsManifest,
      units: { ...unitsManifest.units, x: { col: 0, row: 0, card: { file: "u.png", kind: "sticker", w: 1, h: 1 } } },
    } as unknown as UnitsManifest;
    expect(cardLayers({ ...base, units: weird, ref: { axis: "units", id: "x" }, grade: "GOLD" }).kind)
      .toBe("frame-only");
  });

  it("어떤 쓰레기 입력에도 throw 하지 않는다", () => {
    for (const grade of [null, undefined, "", "__proto__", "constructor"]) {
      for (const ref of [null, { axis: "units" as const, id: "__proto__" }, { axis: "characters" as const, id: "" }]) {
        expect(() => cardLayers({ ...base, ref, grade })).not.toThrow();
      }
    }
  });

  it("발행 유닛 카드 PNG 가 manifest 규격과 일치한다(드리프트 가드)", () => {
    for (const [id, entry] of Object.entries(unitsManifest.units)) {
      const card = entry!.card!;
      expect(pngSize(join(distDir, card.file)), id).toEqual({ w: card.w, h: card.h });
    }
  });
});
