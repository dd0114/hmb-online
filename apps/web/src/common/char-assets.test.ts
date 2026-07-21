import { afterEach, describe, expect, it } from "vitest";
import {
  __clearLegendDotAssets,
  __setLegendDotAsset,
  avatarInitial,
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

describe("avatarInitial", () => {
  it("이름 첫 글자", () => {
    expect(avatarInitial("손흥민")).toBe("손");
    expect(avatarInitial("  Ada Lovelace")).toBe("A");
  });
  it("빈 이름 → '?'", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });
});
