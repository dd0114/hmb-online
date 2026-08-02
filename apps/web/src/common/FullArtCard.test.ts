// @vitest-environment jsdom
/**
 * FullArtCard — **`card.kind` 분기가 실제 DOM 으로 나오는가** (#207 U-D8 · W3-D).
 *
 * `full-art.test.ts` 는 순수 해석(층 URL·fit)을 태우고, 여기서는 그 결과가 실제로
 * "프레임 이미지를 요청하지 않는다 / 라벨을 이중으로 얹지 않는다"로 이어지는지 본다 —
 * 계약 위반이 눈에 보이기 전에 DOM 에서 잡히도록.
 *
 * 실제 발행물 manifest + 실제 매핑을 읽어 태운다(손픽스처 드리프트 0).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FullArtCard } from "./FullArtCard";
import { resetCharAssetsCache } from "./char-assets-store";
import { DEFAULT_CARD_GEOMETRY, fullArtLayout } from "./full-art";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const distDir = join(repoRoot, "design", "characters", "dist");

const charactersManifest = JSON.parse(readFileSync(join(distDir, "characters", "manifest.json"), "utf8"));
const unitsManifest = JSON.parse(readFileSync(join(distDir, "units", "manifest.json"), "utf8"));
const placeholderManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
const mappingFile = JSON.parse(readFileSync(join(repoRoot, "data", "players", "player-chars.v2.json"), "utf8"));

/**
 * **완성 카드(`complete`) 픽스처** — 발행물에 실물이 0종이어도 DOM 계약이 살아 있게.
 *
 * #207 재발행에서 보날두·욱링엄이 완성 카드 → 프레임리스 아트가 되며 실 manifest 의
 * `complete` 이 0종이 됐다. 실물만 태우면 이 describe 가 통째로 공허해진다(= 다음에 완성
 * 카드를 다시 실었을 때 "프레임 두 겹"을 아무도 못 잡는다). 그래서 발행 구성과 분리된
 * 픽스처 유닛 + 픽스처 매핑을 주입해 **분기 자체**를 태운다.
 */
const FIXTURE_UNIT = "fixture-complete";
const FIXTURE_PLAYER = "P901";
const unitsWithFixture = {
  ...unitsManifest,
  units: {
    ...unitsManifest.units,
    [FIXTURE_UNIT]: {
      index: 99, name: "픽스처", position: "FW", col: 0, row: 0,
      card: { file: `units/card-${FIXTURE_UNIT}.png`, kind: "complete", w: 512, h: 768 },
      face: "units/face-bonaldo.png",
      faceSize: { w: 256, h: 256 },
      iconBackground: "opaque-dark",
      forPlayer: FIXTURE_PLAYER,
    },
  },
};
const playersWithFixture = {
  ...mappingFile.players,
  [FIXTURE_PLAYER]: { axis: "units", id: FIXTURE_UNIT },
};

function stubFetch() {
  return vi.fn(async (url: string) => {
    const body = url.endsWith("/characters/manifest.json")
      ? charactersManifest
      : url.endsWith("/units/manifest.json")
        ? unitsWithFixture
        : url.endsWith("/player-chars.json")
          ? { version: mappingFile.version, players: playersWithFixture }
          : placeholderManifest;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

/**
 * 완성 카드 표본 = **픽스처 + 실 발행물에 있는 것 전부**.
 * 발행측이 다시 complete 를 실으면 그 실물도 자동으로 같은 계약을 받는다(유닛명 하드코딩 0).
 */
const completeUnits = Object.entries<{ card?: { kind?: string }; forPlayer?: string }>(unitsWithFixture.units)
  .filter(([, u]) => u.card?.kind === "complete" && u.forPlayer)
  .map(([id, u]) => [id, u.forPlayer!] as const);
const framelessLegend = Object.entries<{ card?: { kind?: string }; forPlayer?: string }>(unitsWithFixture.units)
  .filter(([, u]) => u.card?.kind === "frameless-art" && u.forPlayer)
  .map(([id, u]) => [id, u.forPlayer!] as const);

const card = (playerId: string) => screen.getByTestId(`full-art-${playerId}`);
const layers = (playerId: string, layer: string) =>
  card(playerId).querySelectorAll(`[data-art-layer="${layer}"]`);

beforeEach(() => {
  resetCharAssetsCache();
  vi.stubGlobal("fetch", stubFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("완성 카드(kind=complete) — 합성 경로를 타지 않는다", () => {
  it("프레임 이미지를 **한 장도 요청하지 않고** 아트만 통짜로 그린다", async () => {
    // 픽스처가 항상 1건은 보장한다 — 발행 구성이 0종이어도 이 계약이 공허해지지 않는다.
    expect(completeUnits.length).toBeGreaterThan(0);
    for (const [unitId, playerId] of completeUnits) {
      render(h(FullArtCard, { playerId, name: unitId, grade: "LEGEND", position: "FW" }));
      await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-complete"));
      expect(layers(playerId, "frame"), `${unitId} 프레임 층`).toHaveLength(0);
      const art = layers(playerId, "art");
      expect(art).toHaveLength(1);
      expect(art[0]!.getAttribute("src")).toContain(`/chars/units/card-${unitId}.png`);
      expect((art[0] as HTMLElement).dataset.artFit).toBe("whole");
      cleanup();
    }
  });

  it("이름·등급·포지션뱃지 오버레이를 얹지 않는다(아트에 이미 구워져 있다)", async () => {
    const [unitId, playerId] = completeUnits[0]!;
    render(h(FullArtCard, { playerId, name: unitId, grade: "LEGEND", position: "FW", showLabels: true }));
    await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-complete"));
    expect(screen.queryByTestId(`card-label-${playerId}`)).toBeNull();
    expect(card(playerId).textContent).toBe("");
  });

  it("종횡비가 발행 규격 그대로다 — 226×425 카드 비율로 눌러 담지 않는다", async () => {
    const [unitId, playerId] = completeUnits[0]!;
    const spec = unitsWithFixture.units[unitId].card;
    render(h(FullArtCard, { playerId, name: unitId, grade: "LEGEND" }));
    await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-complete"));
    expect(card(playerId).style.aspectRatio).toBe(`${spec.w} / ${spec.h}`);
  });

  it('variant="art" 여도 통짜다 — 잘라낼 프레임 밴드가 따로 없는 에셋이다', async () => {
    const [unitId, playerId] = completeUnits[0]!;
    render(h(FullArtCard, { playerId, name: unitId, grade: "LEGEND", variant: "art" }));
    await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-complete"));
    expect(layers(playerId, "frame")).toHaveLength(0);
    expect((layers(playerId, "art")[0] as HTMLElement).dataset.artFit).toBe("whole");
  });
});

describe("프레임리스 아트(kind=frameless-art) — 기존 합성 경로", () => {
  it("등급 프레임 위에 아트를 얹고, 아트는 창을 채운다(크롭 오프셋 없음)", async () => {
    // 개수는 발행이 정한다(재발행으로 완성 카드 2종이 이쪽으로 넘어와 현재 5종, #207).
    // 여기서 박는 건 "표본이 비지 않는다" 뿐 — 비면 아래 루프가 아무것도 검사하지 않는다.
    expect(framelessLegend.length).toBeGreaterThan(0);
    for (const [unitId, playerId] of framelessLegend) {
      render(h(FullArtCard, { playerId, name: unitId, grade: "LEGEND", position: "MF" }));
      await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-art"));
      expect(layers(playerId, "frame")).toHaveLength(1);
      expect(layers(playerId, "frame")[0]!.getAttribute("src")).toBe("/chars/frame-LEGEND.png");
      const art = layers(playerId, "art")[0] as HTMLElement;
      expect(art.dataset.artFit).toBe("fill");
      expect(art.getAttribute("src")).toContain(`/chars/units/art-${unitId}.png`);
      cleanup();
    }
  });

  /**
   * **아트가 이름판을 덮으면 안 된다** (#207 재발행 실화면에서 잡힘).
   *
   * `.artFill` 은 `inset: 0` = **카드 통짜**다. 프레임을 같이 그리는 `variant="card"` 에서
   * 그걸 쓰면 `object-fit: contain` 이 카드 전체(226×425)에 맞춰지는데, 아트는 2:3 이라
   * 세로가 남아 **네임플레이트(y=330~) 아래까지 흘러내린다** — 실측 침범 열라도나 12px ·
   * 보날두 21.8px · 욱링엄 34.4px(발·공이 이름 글자를 덮었다). 2차 입고분이 인물을 더 아래까지
   * 그려서 드러났을 뿐, 축 자체의 결함이다.
   *
   * 계약: 프레임을 그리는 경로에서 아트 컨테이너는 **아트 창**(inset~artBottom)이어야 한다.
   * 절대 픽셀이 아니라 `fullArtLayout` 이 계산한 값과 대조해 규격 변경(cardGeometry)을 따라간다.
   */
  it("프레임 합성 카드에서 아트는 **아트 창 안**에 갇힌다(이름판 침범 0)", async () => {
    const L = fullArtLayout(DEFAULT_CARD_GEOMETRY);
    for (const [unitId, playerId] of framelessLegend) {
      render(h(FullArtCard, { playerId, name: unitId, grade: "LEGEND", position: "MF" }));
      await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-art"));
      const win = (layers(playerId, "art")[0] as HTMLElement).parentElement!;
      expect(win.style.top, `${unitId} 창 top`).toBe(L.window.top);
      expect(win.style.height, `${unitId} 창 height`).toBe(L.window.height);
      // 창 아래끝 = 발행 규격의 아트 영역 끝(`artBottom`). 네임플레이트가 시작하는 지점이다
      // — 아트는 여기서 잘린다. 카드 통짜(100%)면 이름·등급 밴드를 덮는다.
      const g = DEFAULT_CARD_GEOMETRY;
      const bottom = parseFloat(L.window.top) + parseFloat(L.window.height);
      expect(bottom, `${unitId} 창 아래끝`).toBeCloseTo((g.artBottom / g.h) * 100, 3);
      expect(bottom).toBeLessThan(100);
      expect(bottom - (g.nameY / g.h) * 100).toBeLessThan(1); // 밴드 위로 1% 이상 침범 금지
      cleanup();
    }
  });

  it("이름·포지션 오버레이는 그대로 얹는다(프레임에 구워진 MF 를 덮어야 한다)", async () => {
    const [, playerId] = framelessLegend[0]!;
    render(h(FullArtCard, { playerId, name: "열라도나", grade: "LEGEND", position: "MF" }));
    await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-art"));
    expect(screen.getByTestId(`card-label-${playerId}`).textContent).toBe("열라도나");
  });

  /*
   * 🪦 은퇴 — "GOLD 이하 공용 디폴트 유닛은 도트라 pixelated 로 그린다".
   * 그 아트를 **더 이상 그리지 않는다**(#285). 도트 렌더링 규칙 자체(`pixelArt` → `pixelated`)는
   * 살아 있고 아래 픽스처 완성 카드·유닛 아트 계약이 계속 태운다 — 사라진 건 골드 이하 표본뿐이다.
   */
  it("#285: GOLD 이하는 풀아트를 그리지 않는다 — 프레임 + 이니셜만", async () => {
    // 표본이 실제로 매핑돼 있어야 계약이 공허하지 않다.
    expect(mappingFile.players.P050).toBeTruthy();
    render(h(FullArtCard, { playerId: "P050", name: "Gold Player", grade: "GOLD", position: "MF" }));
    await waitFor(() => expect(card("P050").dataset.artKind).toBe("frame-only"));
    expect(layers("P050", "art"), "아트 층 0").toHaveLength(0);
    // 카드는 남는다 — 프레임·이름·등급색 이니셜로 "누구인지"는 계속 읽힌다.
    expect(layers("P050", "frame")).toHaveLength(1);
    expect(screen.getByTestId("card-label-P050").textContent).toBe("Gold Player");
    const icon = screen.getByTestId("char-avatar-P050");
    expect(icon.dataset.avatarKind).toBe("placeholder-css");
    expect(icon.dataset.artPolicy).toBe("hidden");
  });

  it("사진형 실아트는 pixelated 가 아니다(축소 시 계단 방지)", async () => {
    const [, playerId] = framelessLegend[0]!;
    render(h(FullArtCard, { playerId, name: "열라도나", grade: "LEGEND" }));
    await waitFor(() => expect(card(playerId).dataset.artKind).toBe("unit-art"));
    expect((layers(playerId, "art")[0] as HTMLElement).style.imageRendering).toBe("auto");
  });
});

describe("무회귀 — characters 축과 폴백 계단", () => {
  it("characters 축은 기존 크롭 합성 그대로", async () => {
    render(h(FullArtCard, { playerId: "P001", name: "Lev Yashin", grade: "LEGEND", position: "GK" }));
    await waitFor(() => expect(card("P001").dataset.artKind).toBe("full-art"));
    expect(layers("P001", "frame")).toHaveLength(1);
    expect((layers("P001", "art")[0] as HTMLElement).dataset.artFit).toBe("crop");
    expect(screen.getByTestId("card-label-P001").textContent).toBe("Lev Yashin");
  });

  it("아트 미입고 LEGEND 는 프레임 + 아이콘 폴백(깨진 이미지 0)", async () => {
    // ⚠️ 표본을 **리터럴로 박지 않는다.** 여기 P174(권씨)가 박혀 있었는데 #389 로 아트가
    // 입고되며 이 테스트가 깨졌다 — 성질("미입고면 폴백")은 그대로인데 표본만 낡은 것이다.
    // 발행물이 스스로 선언하는 `unmapped` 에서 뽑으면 다음 입고에도 자동으로 따라간다.
    // (남은 미입고 = P178 석신. 전원 입고되면 아래 단언이 그 사실을 알린다.)
    const unmapped = mappingFile.unmapped as string[];
    expect(unmapped.length, "미입고 LEGEND 가 0 이다 — 이 폴백 계약은 픽스처로 태워야 한다").toBeGreaterThan(0);
    const playerId = unmapped[0]!;
    render(h(FullArtCard, { playerId, name: "미입고 LEGEND", grade: "LEGEND" }));
    await waitFor(() => expect(card(playerId).dataset.artKind).toBe("frame-only"));
    expect(layers(playerId, "art")).toHaveLength(0);
    expect(screen.getByTestId(`char-avatar-${playerId}`).dataset.avatarKind).toBe("placeholder-css");
  });
});
