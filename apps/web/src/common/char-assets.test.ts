import { afterEach, describe, expect, it } from "vitest";
import {
  __clearLegendDotAssets,
  __setLegendDotAsset,
  avatarInitial,
  initialsOf,
  resolveCharId,
  resolvePlayerAvatar,
  type AvatarPlayer,
} from "./char-assets";

const STUB = "data:image/png;base64,iVBORw0KGgo=";

function player(overrides: Partial<AvatarPlayer> = {}): AvatarPlayer {
  return { id: "P001", grade: "LEGEND", name: "레전드선수", ...overrides };
}

afterEach(() => __clearLegendDotAssets());

describe("resolvePlayerAvatar — 분기", () => {
  it("LEGEND + 에셋 있음 → legend-dot(src 전달)", () => {
    __setLegendDotAsset("P001", STUB);
    expect(resolvePlayerAvatar(player())).toEqual({ kind: "legend-dot", src: STUB });
  });

  it("LEGEND + 에셋 없음 → placeholder (레지스트리 비어있는 현 상태)", () => {
    expect(resolvePlayerAvatar(player())).toEqual({ kind: "placeholder" });
  });

  it("비-LEGEND 는 에셋이 있어도 placeholder", () => {
    __setLegendDotAsset("P001", STUB);
    expect(resolvePlayerAvatar(player({ grade: "GOLD" }))).toEqual({ kind: "placeholder" });
    expect(resolvePlayerAvatar(player({ grade: "DIA" }))).toEqual({ kind: "placeholder" });
    expect(resolvePlayerAvatar(player({ grade: "BRONZE" }))).toEqual({ kind: "placeholder" });
  });

  it("imageRef.charId 로 매핑된다(id 와 다른 charId)", () => {
    __setLegendDotAsset("LEG_07", STUB);
    const p = player({ id: "P099", imageRef: { charId: "LEG_07" } });
    expect(resolveCharId(p)).toBe("LEG_07");
    expect(resolvePlayerAvatar(p)).toEqual({ kind: "legend-dot", src: STUB });
  });

  it("imageRef 부재 시 player.id 로 폴백 매핑(잠정 계약)", () => {
    __setLegendDotAsset("P001", STUB);
    expect(resolveCharId(player())).toBe("P001");
    expect(resolvePlayerAvatar(player())).toEqual({ kind: "legend-dot", src: STUB });
  });

  it("LEGEND 지만 charId 미등록 → placeholder", () => {
    __setLegendDotAsset("OTHER", STUB);
    expect(resolvePlayerAvatar(player({ id: "P001" }))).toEqual({ kind: "placeholder" });
  });
});

/**
 * ⚠️ **규칙이 하나로 합쳐졌다**(#406 W1b 수리). 예전엔 `avatarInitial` 이 "첫 글자 한 개"
 * (`손흥민`→`손`)였고 형제 함수 `CharAvatar.initialsOf` 는 "마지막 토큰 2글자"(`레프 야신`→`야신`)
 * 라 **같은 질문에 답이 둘**이었다. 지금은 `avatarInitial === initialsOf` 다 — 그래서 여기 기대값도
 * 한글 2글자·로마자 이니셜로 바뀐다. 화면 영향 0(유일 소비자 `PlayerAvatar` 를 쓰는 화면이 없다).
 */
describe("avatarInitial — initialsOf 와 같은 규칙(별칭)", () => {
  it("한글은 마지막 토큰 2글자, 로마자는 첫+끝 이니셜", () => {
    expect(avatarInitial("손흥민")).toBe("손흥");
    expect(avatarInitial("레프 야신")).toBe("야신");
    expect(avatarInitial("  Ada Lovelace")).toBe("AL");
  });
  it("빈 이름 → '?'", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });
  it("두 이름이 실제로 같은 함수다 — 규칙이 다시 갈라지면 죽는다", () => {
    expect(avatarInitial).toBe(initialsOf);
    for (const n of ["손흥민", "레프 야신", "Paolo Maldini", "", "   ", "크바라츠헬리아"]) {
      expect(avatarInitial(n)).toBe(initialsOf(n));
    }
  });
});
