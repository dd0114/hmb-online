/**
 * 경기장 스킨 페이로드 계약 (#145 → #207 U-D8). 발행물 실물 + 실제 매핑을 읽어 태운다.
 *
 * 뷰어 규약: `byPlayer` 에 셀이 **없는 선수는 팀색 원**(홈 파랑/어웨이 빨강)으로 그려진다
 * (`viewer.impl.mjs` 의 `if (!cell)` 분기). 즉 "빼는 것"이 곧 U-D8 의 표현이다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARENA_ATLAS, ARENA_AXIS, buildViewerSkins, jerseyNumbers } from "./viewer-skins";
import type { CharAssets } from "../common/char-assets-store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const characters = JSON.parse(
  readFileSync(join(repoRoot, "design", "characters", "dist", "characters", "manifest.json"), "utf8"),
);
const placeholders = JSON.parse(
  readFileSync(join(repoRoot, "design", "characters", "dist", "manifest.json"), "utf8"),
);
const units = JSON.parse(
  readFileSync(join(repoRoot, "design", "characters", "dist", "units", "manifest.json"), "utf8"),
);
const mappingFile = JSON.parse(
  readFileSync(join(repoRoot, "data", "players", "player-chars.v2.json"), "utf8"),
);
const seed = JSON.parse(readFileSync(join(repoRoot, "data", "players", "players.v2.3.json"), "utf8")) as Array<{
  id: string;
  grade: string;
}>;
const gradeOf = new Map(seed.map((p) => [p.id, p.grade]));

const full: CharAssets = {
  characters,
  units,
  placeholders,
  mapping: { version: mappingFile.version, players: mappingFile.players },
};

describe("buildViewerSkins", () => {
  it("경기장은 characters 축만 태운다 — 그 축 39명(DIA 25 + 비활성 LEGEND 14)", () => {
    const skins = buildViewerSkins(full)!;
    expect(ARENA_AXIS).toBe("characters");
    const charactersAxis = Object.entries(mappingFile.players).filter(
      ([, ref]) => (ref as { axis: string }).axis === "characters",
    );
    expect(Object.keys(skins.byPlayer)).toHaveLength(charactersAxis.length);
    expect(charactersAxis).toHaveLength(39);
  });

  it("**U-D8: GOLD/SILVER/BRONZE 는 개별 아이콘을 안 탄다 → 팀색 원**", () => {
    const skins = buildViewerSkins(full)!;
    const teamCircleGrades = ["GOLD", "SILVER", "BRONZE"];
    const offenders = Object.keys(skins.byPlayer).filter((id) => teamCircleGrades.includes(gradeOf.get(id)!));
    expect(offenders).toEqual([]);
    // 그 등급 선수 수가 0 이라 통과한 게 아님을 못 박는다(공허참 방지).
    expect(seed.filter((p) => teamCircleGrades.includes(p.grade))).toHaveLength(133);
  });

  it("DIA 는 현행대로 개별 얼굴을 유지한다(무회귀)", () => {
    const skins = buildViewerSkins(full)!;
    const dia = seed.filter((p) => p.grade === "DIA").map((p) => p.id);
    expect(dia).toHaveLength(25);
    for (const id of dia) expect(skins.byPlayer[id], id).toBeTruthy();
  });

  it("⚠️ 알려진 갭 — 활성 LEGEND 5종의 units 실아트는 경기장에 아직 못 뜬다", () => {
    // 페이로드가 단일 아틀라스라 units 축을 같이 실을 수 없다(viewer-skins.ts 헤더 주석).
    // viewer-core 가 아틀라스별 셀을 받게 되면 이 테스트가 **실패하며** 해제 신호를 준다 —
    // 침묵하는 0 은 "의도"와 "빠뜨림"을 구분하지 못한다.
    const skins = buildViewerSkins(full)!;
    for (const id of ["P173", "P175", "P176", "P177", "P179"]) {
      expect(gradeOf.get(id)).toBe("LEGEND");
      expect(skins.byPlayer[id], `${id} — 갭이 닫혔으면 이 테스트를 갱신하라`).toBeUndefined();
    }
    expect(skins.atlasUrl).toBe("/chars/characters/avatars-64.png");
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
      const charId = mappingFile.players[playerId].id;
      expect(cell, playerId).toEqual({
        col: characters.characters[charId].col,
        row: characters.characters[charId].row,
      });
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(4);
      expect(cell.row).toBeLessThan(4);
    }
  });

  it("구 v1 문자열 매핑도 그대로 태운다(롤백 안전)", () => {
    const skins = buildViewerSkins({ ...full, mapping: { players: { P001: "aura", P002: "lupus" } } })!;
    expect(Object.keys(skins.byPlayer).sort()).toEqual(["P001", "P002"]);
  });

  it("매핑/매니페스트가 없으면 null — 뷰어는 현행 단색 원으로 떨어진다(무회귀)", () => {
    expect(buildViewerSkins({ characters: null, units: null, placeholders: null, mapping: null })).toBeNull();
    expect(buildViewerSkins({ ...full, mapping: null })).toBeNull();
    expect(buildViewerSkins({ ...full, characters: null })).toBeNull();
  });

  it("매핑이 발행물에 없는 캐릭터를 가리키면 그 선수만 빠진다(전체 실패 아님)", () => {
    const skins = buildViewerSkins({
      ...full,
      mapping: {
        players: {
          P001: { axis: "characters", id: "aura" },
          P002: { axis: "characters", id: "ghost-char" },
        },
      },
    })!;
    expect(Object.keys(skins.byPlayer)).toEqual(["P001"]);
  });

  it("쓸 수 있는 선수가 하나도 없으면 null", () => {
    expect(buildViewerSkins({ ...full, mapping: { players: { P001: { axis: "characters", id: "ghost" } } } }))
      .toBeNull();
    // units 축만 있는 매핑도 마찬가지 — 경기장은 그 축을 안 탄다.
    expect(buildViewerSkins({ ...full, mapping: { players: { P173: { axis: "units", id: "bonaldo" } } } }))
      .toBeNull();
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
