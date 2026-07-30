/**
 * 경기장 스킨 페이로드 계약 (#145 → #207 U-D8 → #218 멀티 아틀라스). 발행물 실물 + 실제 매핑을
 * 읽어 태운다.
 *
 * 뷰어 규약: `byPlayer` 에 셀이 **없는 선수는 팀색 원 + 등번호**로 그려진다
 * (`viewer.impl.mjs` 의 `if (!cell)` 분기). 즉 "빼는 것"이 곧 U-D8 의 표현이다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARENA_ATLAS, ARENA_AXES, buildViewerSkins, jerseyNumbers } from "./viewer-skins";
import type { CharAssets } from "../common/char-assets-store";
import type { Grade } from "../common/grades";

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
/** 시드 파일명을 박지 않는다 — v2.4 가 나오면 조용히 낡은 시드로 카운트를 검증하게 된다. */
const seedFile = readdirSync(join(repoRoot, "data", "players"))
  .filter((f) => /^players\.v[\d.]+\.json$/.test(f))
  .sort((a, b) => {
    const num = (f: string) => f.slice(9, -5).split(".").map(Number);
    const [x, y] = [num(a), num(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
  })
  .pop()!;
const seed = JSON.parse(readFileSync(join(repoRoot, "data", "players", seedFile), "utf8")) as Array<{
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
  it("경기장이 두 축을 모두 태운다 — characters 39(DIA 25 + 비활성 LEGEND 14) + units 고유 8", () => {
    const skins = buildViewerSkins(full)!;
    expect([...ARENA_AXES]).toEqual(["characters", "units"]);
    const charactersAxis = Object.entries(mappingFile.players).filter(
      ([, ref]) => (ref as { axis: string }).axis === "characters",
    );
    // units 축 = 고유 실아트(활성 LEGEND) + 등급 공용 디폴트. 경기장은 고유분만 태운다(U-D8).
    const exclusiveUnits = Object.entries(mappingFile.players).filter(
      ([, ref]) => (ref as { axis: string; id: string }).axis === "units" && !units.units[(ref as { id: string }).id].forGrades,
    );
    expect(charactersAxis).toHaveLength(39);
    // 3차 입고(2026-07-29)로 경니시우스(P180)가 매핑되며 5 → 6, #256 채번으로 석다이크(P181)·
    // 오시야스(P182)가 붙어 6 → 8. 셋 다 활성화 전이라 시드에선 비활성이지만 **매핑은 미리
    // 붙어 있고**, 경기장은 활성 여부가 아니라 매핑 유무로 태운다.
    expect(exclusiveUnits).toHaveLength(8);
    expect(Object.keys(skins.byPlayer)).toHaveLength(47);
  });

  it("**U-D8: GOLD/SILVER/BRONZE 는 개별 아이콘을 안 탄다 → 팀색 원**", () => {
    const skins = buildViewerSkins(full)!;
    const teamCircleGrades = ["GOLD", "SILVER", "BRONZE"];
    const offenders = Object.keys(skins.byPlayer).filter((id) => teamCircleGrades.includes(gradeOf.get(id)!));
    expect(offenders).toEqual([]);
    // 그 등급 선수 수가 0 이라 통과한 게 아님을 못 박는다(공허참 방지).
    expect(seed.filter((p) => teamCircleGrades.includes(p.grade))).toHaveLength(133);
  });

  /*
   * #285 — 판정 근거를 **아트 종류에서 등급으로** 옮긴다.
   *
   * 구 근거는 `unitIsSharedDefault`("이 유닛이 등급 공용 디폴트냐")였다. 지금 데이터에선 공용
   * 디폴트 = 골드 이하 133명이라 위 U-D8 계약이 통과하지만 그건 **우연**이다 — 발행측이 골드
   * 한 명에게 고유 아트를 주면 그 순간 경기장에 골드 얼굴이 뜬다. 실 데이터로는 그 구멍을
   * 만들 수 없으므로(그런 선수가 없다) **픽스처로 그 상황을 만들어** 계약을 태운다.
   */
  describe("#285: 등급이 판정한다 — 공용/고유 여부가 아니라", () => {
    const GOLD_ID = seed.find((p) => p.grade === "GOLD")!.id;
    const DIA_ID = seed.find((p) => p.grade === "DIA")!.id;
    /** 고유 아트를 가진 유닛(= forGrades 없음) 하나를 빌려 온다 — 유닛명 하드코딩 금지. */
    const exclusiveUnitId = Object.entries<{ forGrades?: unknown }>(units.units)
      .find(([, u]) => !u.forGrades)![0];

    const withExclusiveGold: CharAssets = {
      ...full,
      mapping: {
        players: {
          ...mappingFile.players,
          // 골드에게 **고유** 유닛 아트를 붙인다 = 구 근거가 뚫리는 정확한 조건.
          [GOLD_ID]: { axis: "units", id: exclusiveUnitId },
        },
      },
    };

    it("고유 아트를 가진 GOLD 도 경기장에서 제외된다(구 근거가 뚫리던 자리)", () => {
      const grades = Object.fromEntries(seed.map((p) => [p.id, p.grade])) as Record<string, Grade>;
      const skins = buildViewerSkins(withExclusiveGold, undefined, grades)!;
      expect(skins.byPlayer[GOLD_ID], `${GOLD_ID}(GOLD, 고유 아트) 는 팀색 원`).toBeUndefined();
      // 대조군 — 같은 페이로드에서 다이아는 그대로 얼굴을 받는다(전부 지우는 게 아니다).
      expect(skins.byPlayer[DIA_ID], `${DIA_ID}(DIA) 는 얼굴 유지`).toBeTruthy();
    });

    it("변이체 킬: 등급표를 안 주면(구 코드 경로) 이 GOLD 가 새 나간다 — 그래서 배선이 계약이다", () => {
      const skins = buildViewerSkins(withExclusiveGold)!;
      // 등급을 모르면 구 백스톱(공용 디폴트 제외)만 남고, 고유 아트를 받은 골드는 통과한다.
      // 이 단언은 "등급 배선이 없으면 정책이 실제로 뚫린다"를 증명한다 = 위 계약이 공허하지 않다.
      expect(skins.byPlayer[GOLD_ID]).toBeTruthy();
    });

    it("등급 미상 선수는 백스톱(공용 디폴트 제외)이 계속 지킨다", () => {
      // 등급표에 아무도 없어도 실 데이터의 골드 이하 133명은 여전히 안 실린다.
      const skins = buildViewerSkins(full, undefined, {})!;
      const leaked = Object.keys(skins.byPlayer).filter((id) =>
        ["GOLD", "SILVER", "BRONZE"].includes(gradeOf.get(id)!),
      );
      expect(leaked).toEqual([]);
    });

    it("등급표를 줘도 다이아 이상 47명은 그대로다(무회귀)", () => {
      const grades = Object.fromEntries(seed.map((p) => [p.id, p.grade])) as Record<string, Grade>;
      const before = buildViewerSkins(full)!;
      const after = buildViewerSkins(full, undefined, grades)!;
      expect(Object.keys(after.byPlayer).sort()).toEqual(Object.keys(before.byPlayer).sort());
    });
  });

  it("DIA 는 현행대로 개별 얼굴을 유지한다(무회귀)", () => {
    const skins = buildViewerSkins(full)!;
    const dia = seed.filter((p) => p.grade === "DIA").map((p) => p.id);
    expect(dia).toHaveLength(25);
    for (const id of dia) expect(skins.byPlayer[id], id).toBeTruthy();
  });

  it("#218: 활성 LEGEND 5종의 units 실아트가 경기장에 뜬다 — 자기 아틀라스 인덱스로", () => {
    const skins = buildViewerSkins(full)!;
    const unitAtlas = skins.atlases.findIndex((a) => a.url === "/chars/units/avatars-64.png");
    expect(unitAtlas, "units 아틀라스가 페이로드에 실린다").toBeGreaterThanOrEqual(0);
    for (const id of ["P173", "P175", "P176", "P177", "P179"]) {
      expect(gradeOf.get(id)).toBe("LEGEND");
      const cell = skins.byPlayer[id]!;
      expect(cell, `${id} 셀`).toBeTruthy();
      expect(cell.atlas ?? 0, `${id} 는 units 아틀라스를 가리킨다`).toBe(unitAtlas);
      // 얼굴이 불투명 배경 위에 그려져 있으면 코어가 원형으로 자른다(사각 덩어리 방지).
      expect(cell.bg, `${id} 배경 전제`).toBe("opaque-dark");
      const u = units.units[mappingFile.players[id].id];
      expect({ col: cell.col, row: cell.row }).toEqual({ col: u.col, row: u.row });
    }
  });

  it("A/B 실측 결론대로 얼굴 아틀라스(avatars-64)를 쓴다 — 두 축 모두", () => {
    const skins = buildViewerSkins(full)!;
    expect(ARENA_ATLAS).toBe("avatars-64");
    expect(skins.atlases.map((a) => a.url).sort()).toEqual([
      "/chars/characters/avatars-64.png",
      "/chars/units/avatars-64.png",
    ]);
    for (const a of skins.atlases) expect(a.tile).toBe(64);
    // 구 단일 아틀라스 필드 = **characters 시트로 못 박는다**. `atlases[0]` 와 비교하면 항진명제라
    // 발행/매핑 키 순서가 바뀌어 0번이 units 로 뒤집혀도 통과한다 — 그러면 구 코어가 characters 축
    // 선수에게 units 시트 셀을 그린다(조용한 오배정).
    expect(skins.atlases[0]!.url).toBe("/chars/characters/avatars-64.png");
    expect(skins.atlasUrl).toBe("/chars/characters/avatars-64.png");
    expect(skins.tile).toBe(64);
  });

  it("아틀라스 순서가 매핑 키 순서에 좌우되지 않는다(축 순서 고정)", () => {
    // 매핑을 units 가 먼저 오도록 뒤집어도 0번 시트는 characters 여야 한다.
    const reversed = Object.fromEntries(Object.entries(mappingFile.players).reverse()) as CharAssets["mapping"] extends null ? never : Record<string, { axis: "characters" | "units"; id: string }>;
    const skins = buildViewerSkins({ ...full, mapping: { players: reversed } })!;
    expect(skins.atlases[0]!.url).toBe("/chars/characters/avatars-64.png");
  });

  it("좌표가 발행물 격자 안이고 해당 축 manifest 와 일치한다", () => {
    const skins = buildViewerSkins(full)!;
    for (const [playerId, cell] of Object.entries(skins.byPlayer)) {
      const ref = mappingFile.players[playerId] as { axis: string; id: string };
      const src = ref.axis === "units" ? units.units[ref.id] : characters.characters[ref.id];
      expect({ col: cell.col, row: cell.row }, playerId).toEqual({ col: src.col, row: src.row });
      // 격자는 **발행물이 선언한 값**을 쓴다 — 입고로 행이 늘 때(3차 입고 units 3×2 → 3×3)
      // 리터럴을 따라 고치는 대신 계약("좌표가 자기 시트 안") 자체가 유지되게 한다.
      const grid = ref.axis === "units" ? units.atlases["avatars-64"] : characters.atlases["avatars-64"];
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(grid.cols);
      expect(cell.row).toBeLessThan(grid.rows);
    }
  });

  it("구 v1 문자열 매핑도 그대로 태운다(롤백 안전)", () => {
    const skins = buildViewerSkins({ ...full, mapping: { players: { P001: "aura", P002: "lupus" } } })!;
    expect(Object.keys(skins.byPlayer).sort()).toEqual(["P001", "P002"]);
  });

  it("매핑/매니페스트가 없으면 null — 뷰어는 현행 단색 원으로 떨어진다(무회귀)", () => {
    expect(buildViewerSkins({ characters: null, units: null, placeholders: null, mapping: null })).toBeNull();
    expect(buildViewerSkins({ ...full, mapping: null })).toBeNull();
  });

  it("한 축의 manifest 가 없어도 다른 축은 그대로 뜬다(부분 열화 — #218)", () => {
    const noChars = buildViewerSkins({ ...full, characters: null })!;
    expect(noChars.atlases.map((a) => a.url)).toEqual(["/chars/units/avatars-64.png"]);
    expect(noChars.byPlayer.P173, "units 축은 살아있다").toBeTruthy();
    expect(noChars.byPlayer.P001, "characters 축은 팀색 원으로 떨어진다").toBeUndefined();

    const noUnits = buildViewerSkins({ ...full, units: null })!;
    expect(noUnits.atlases.map((a) => a.url)).toEqual(["/chars/characters/avatars-64.png"]);
    expect(noUnits.byPlayer.P001).toBeTruthy();
    expect(noUnits.byPlayer.P173).toBeUndefined();
  });

  it("아트가 하나도 없어도 등번호만으로 페이로드를 만든다(폴백 보장 — #218 AC2)", () => {
    // 코어는 셀이 없으면 `playerId` 에서 번호를 파생한다 → 실경기 id("P173")가 토큰을 덮는다.
    // 에셋 미배포에서도 그 일이 없게, 아트 0 이어도 등번호는 실어 보낸다.
    const log = { tickSnapshots: [{ players: [{ playerId: "P173", team: "home" }] }] };
    const skins = buildViewerSkins({ characters: null, units: null, placeholders: null, mapping: null }, log)!;
    expect(skins.byPlayer).toEqual({});
    expect(skins.atlases).toEqual([]);
    expect(skins.nums).toEqual({ "home:P173": "1" }); // #324 키 = (team, playerId)
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

  it("쓸 수 있는 셀도 등번호도 없으면 null", () => {
    expect(buildViewerSkins({ ...full, mapping: { players: { P001: { axis: "characters", id: "ghost" } } } }))
      .toBeNull();
    // 등급 공용 디폴트만 있는 매핑도 null — 같은 얼굴 22개는 태우지 않는다(U-D8).
    expect(buildViewerSkins({ ...full, mapping: { players: { P100: { axis: "units", id: "default-unit" } } } }))
      .toBeNull();
    // units 고유 아트는 이제 태운다(#218).
    expect(buildViewerSkins({ ...full, mapping: { players: { P173: { axis: "units", id: "bonaldo" } } } }))
      .not.toBeNull();
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

  // #324: 키가 `(team, playerId)` 로 바뀌었다 — 같은 playerId 가 양 팀에 뛰기 때문(상세는
  // viewer-skins.duplicate-id.test.ts). 번호를 매기는 규칙(팀별 등장 순서) 자체는 그대로다.
  it("팀별 등장 순서로 1부터 매긴다(라인업 슬롯 순서)", () => {
    expect(jerseyNumbers(log)).toEqual({
      "home:P010": "1", "home:P044": "2", "away:P077": "1", "away:P099": "2",
    });
  });

  it("나중 스냅샷에만 등장하는 선수(교체)도 번호를 받는다", () => {
    // 첫 스냅샷만 보면 교체 투입 선수는 번호가 없어 코어가 id 원문으로 떨어진다(#218 AC2 구멍).
    const withSub = {
      tickSnapshots: [
        { players: [{ playerId: "P010", team: "home" }, { playerId: "P077", team: "away" }] },
        { players: [{ playerId: "P010", team: "home" }, { playerId: "P099", team: "away" }] },
      ],
    };
    expect(jerseyNumbers(withSub)).toEqual({ "home:P010": "1", "away:P077": "1", "away:P099": "2" });
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

  it("등번호는 셀이 아니라 nums(팀 키)에 실린다 — 번호는 팀마다 다르다(#324)", () => {
    const withLog = buildViewerSkins(full, {
      tickSnapshots: [{ players: [{ playerId: "P001", team: "home" }] }],
    })!;
    // 셀은 **얼굴만** — 같은 선수가 양 팀에 뛰면 얼굴은 같아도 번호는 다르므로, 셀에 구우면
    // 팀 수만큼 아트 셀을 복제해야 한다. 코어는 셀에 num 이 없으면 nums 를 팀 키로 본다.
    expect(withLog.byPlayer.P001, "아트 셀은 있다").toBeTruthy();
    expect(withLog.byPlayer.P001?.num, "셀에는 번호를 굽지 않는다").toBeUndefined();
    expect(withLog.nums["home:P001"], "번호는 nums 에 팀 키로").toBe("1");
    // 로그 없이 만들면 등번호 표 자체가 비어 있다(뷰어 기존 방식으로 폴백).
    expect(buildViewerSkins(full)!.nums).toEqual({});
  });
});
