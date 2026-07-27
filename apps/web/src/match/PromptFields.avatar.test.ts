// @vitest-environment jsdom
/**
 * 플레이 화면(선수별 프롬프트 목록) 캐릭터 얼굴 배선 계약 (#145 B안 잔여).
 *
 * 왜 이 파일이 필요한가: `playerId` 를 잘못 잡으면 **타입은 통과하는데 화면만 전부 CSS
 * 폴백**으로 떨어진다. 검증자가 이 파일의 배선을 상수로 바꿔봤을 때 커밋된 스위트가 전부
 * 통과했다(계약 공백) — 트레이드 카드와 대칭이 되게 여기도 박제한다.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptFields, type RosterEntry } from "./PromptFields";
import { resetCharAssetsCache } from "../common/char-assets-store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const distDir = join(repoRoot, "design", "characters", "dist");
const charactersManifest = JSON.parse(readFileSync(join(distDir, "characters", "manifest.json"), "utf8"));
const placeholderManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
const unitsManifest = JSON.parse(readFileSync(join(distDir, "units", "manifest.json"), "utf8"));
const mappingFile = JSON.parse(readFileSync(join(repoRoot, "data", "players", "player-chars.v2.json"), "utf8"));

const ROSTER: RosterEntry[] = [
  { playerId: "P001", name: "Lev Yashin", position: "GK", role: "starter" },
  { playerId: "P050", name: "Some Player", position: "MF", role: "bench" },
];

function renderFields() {
  return render(
    h(PromptFields, {
      roster: ROSTER,
      teamPrompt: "",
      onTeamChange: () => {},
      playerPrompts: {},
      onPlayerChange: () => {},
      idPrefix: "briefing",
    }),
  );
}

beforeEach(() => {
  resetCharAssetsCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/characters/manifest.json")
        ? charactersManifest
        : url.endsWith("/units/manifest.json")
          ? unitsManifest
          : url.endsWith("/player-chars.json")
            ? { players: mappingFile.players }
            : placeholderManifest;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PromptFields 아바타", () => {
  it("roster 의 playerId 로 각 행에 실아트 타일을 그린다(축은 매핑이 정한다)", async () => {
    // #207 이후 축이 둘이다 — P001(비활성 LEGEND) = characters, P050(GOLD) = units 디폴트.
    // 여기서 지키는 건 "행마다 배선이 살아 있다"(= CSS 폴백으로 안 떨어진다)이지 특정 축이 아니다.
    renderFields();
    for (const r of ROSTER) {
      await waitFor(() =>
        expect(["character", "unit"], r.playerId).toContain(
          screen.getByTestId(`char-avatar-${r.playerId}`).dataset.avatarKind,
        ),
      );
    }
    expect(screen.getByTestId("char-avatar-P001").dataset.avatarKind).toBe("character");
    expect(screen.getByTestId("char-avatar-P050").dataset.avatarKind).toBe("unit");
  });

  it("행마다 서로 다른 선수의 아바타가 붙는다(한 선수로 고정 배선 방지)", async () => {
    renderFields();
    await waitFor(() => expect(screen.getByTestId("char-avatar-P001")).toBeTruthy());
    expect(screen.getByTestId("char-avatar-P050")).toBeTruthy();
  });

  it("기존 행 정보(포지션·이름·역할·펼침 토글)는 그대로다", () => {
    renderFields();
    expect(screen.getByText("Lev Yashin")).toBeTruthy();
    expect(screen.getByText("GK")).toBeTruthy();
    expect(screen.getByText("선발")).toBeTruthy();
    expect(screen.getByTestId("briefing-player-toggle-P001").getAttribute("aria-expanded")).toBe("false");
  });

  it("에셋을 못 받아도 행이 살아있다(깨짐 0)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    renderFields();
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P001").dataset.avatarKind).toBe("placeholder-css"),
    );
    expect(screen.getByText("Lev Yashin")).toBeTruthy();
  });
});
