/**
 * 경기장 스킨 페이로드 계약 (#145). 발행물 실물 + 실제 매핑을 읽어 태운다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARENA_ATLAS, buildViewerSkins, jerseyNumbers } from "./viewer-skins";
import type { CharAssets } from "../common/char-assets-store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const characters = JSON.parse(
  readFileSync(join(repoRoot, "design", "characters", "dist", "characters", "manifest.json"), "utf8"),
);
const placeholders = JSON.parse(
  readFileSync(join(repoRoot, "design", "characters", "dist", "manifest.json"), "utf8"),
);
const mappingFile = JSON.parse(
  readFileSync(join(repoRoot, "data", "players", "player-chars.v1.json"), "utf8"),
);

const full: CharAssets = {
  characters,
  placeholders,
  mapping: { version: mappingFile.version, players: mappingFile.players },
};

describe("buildViewerSkins", () => {
  it("172명 전원의 타일 좌표를 담는다(B안 — 경기장에서도 전원 캐릭터)", () => {
    const skins = buildViewerSkins(full)!;
    expect(Object.keys(skins.byPlayer)).toHaveLength(172);
  });

  it("A/B 실측 결론대로 얼굴 아틀라스(avatars-64)를 쓴다", () => {
    const skins = buildViewerSkins(full)!;
    expect(ARENA_ATLAS).toBe("avatars-64");
    expect(skins.atlasUrl).toBe("/chars/characters/avatars-64.png");
    expect(skins.tile).toBe(64);
  });

  it("좌표가 발행물 격자 안이고 캐릭터 manifest 와 일치한다", () => {
    const skins = buildViewerSkins(full)!;
    for (const [playerId, cell] of Object.entries(skins.byPlayer)) {
      const charId = mappingFile.players[playerId];
      expect(cell, playerId).toEqual({
        col: characters.characters[charId].col,
        row: characters.characters[charId].row,
      });
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(4);
      expect(cell.row).toBeLessThan(4);
    }
  });

  it("매핑/매니페스트가 없으면 null — 뷰어는 현행 단색 원으로 떨어진다(무회귀)", () => {
    expect(buildViewerSkins({ characters: null, placeholders: null, mapping: null })).toBeNull();
    expect(buildViewerSkins({ ...full, mapping: null })).toBeNull();
    expect(buildViewerSkins({ ...full, characters: null })).toBeNull();
  });

  it("매핑이 발행물에 없는 캐릭터를 가리키면 그 선수만 빠진다(전체 실패 아님)", () => {
    const skins = buildViewerSkins({
      ...full,
      mapping: { players: { P001: "aura", P002: "ghost-char" } },
    })!;
    expect(Object.keys(skins.byPlayer)).toEqual(["P001"]);
  });

  it("쓸 수 있는 선수가 하나도 없으면 null", () => {
    expect(buildViewerSkins({ ...full, mapping: { players: { P001: "ghost" } } })).toBeNull();
  });
});

describe("jerseyNumbers — 토큰에 선수 id 가 찍히는 문제 해결", () => {
  const log = {
    tickSnapshots: [
      {
        players: [
          { playerId: "P010", team: "home" },
          { playerId: "P044", team: "home" },
          { playerId: "P077", team: "away" },
          { playerId: "P099", team: "away" },
        ],
      },
    ],
  };

  it("팀별 등장 순서로 1부터 매긴다(라인업 슬롯 순서)", () => {
    expect(jerseyNumbers(log)).toEqual({ P010: "1", P044: "2", P077: "1", P099: "2" });
  });

  it("실제 데모 로그에서 팀당 1~11 이 나온다", () => {
    const demo = JSON.parse(
      readFileSync(join(repoRoot, "packages", "engine", "dev-viewer", "match-log.json"), "utf8"),
    );
    const nums = Object.values(jerseyNumbers(demo));
    expect(nums).toHaveLength(22);
    expect([...new Set(nums)].sort((a, b) => Number(a) - Number(b))).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    );
  });

  it("로그가 없거나 형상이 다르면 빈 표(뷰어는 기존 방식으로 폴백)", () => {
    expect(jerseyNumbers(null)).toEqual({});
    expect(jerseyNumbers({})).toEqual({});
    expect(jerseyNumbers({ tickSnapshots: [] })).toEqual({});
    expect(jerseyNumbers({ tickSnapshots: [{}] })).toEqual({});
  });

  it("로그를 주면 스킨 셀에 등번호가 실린다", () => {
    const withLog = buildViewerSkins(full, {
      tickSnapshots: [{ players: [{ playerId: "P001", team: "home" }] }],
    })!;
    expect(withLog.byPlayer.P001?.num).toBe("1");
    // 로그 없이 만들면 등번호 없이(뷰어 기존 방식) 나간다.
    expect(buildViewerSkins(full)!.byPlayer.P001?.num).toBeUndefined();
  });
});
