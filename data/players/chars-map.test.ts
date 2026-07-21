import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHARS_MAP_VERSION,
  OUT_PATH,
  POOL_BY_POSITION,
  buildFile,
  buildMapping,
  loadInputs,
  type CharsManifestLike,
  type PlayerLike,
} from "./gen-chars";
import type { Position } from "./generate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const { players, manifest } = loadInputs();
/** 발행된 매핑 파일(생성물) — 소비자가 실제로 읽는 것. */
const published = JSON.parse(readFileSync(OUT_PATH, "utf8")) as ReturnType<typeof buildFile>;
/** 캐릭터 발행 manifest 원본 — 매핑이 참조하는 캐릭터 축. */
const charsManifest = JSON.parse(
  readFileSync(join(repoRoot, "design", "characters", "dist", "characters", "manifest.json"), "utf8"),
) as CharsManifestLike;

const POSITIONS: Position[] = ["GK", "DF", "MF", "FW"];
// 문서화된 총원을 리터럴로 박제(자기참조 검증 회피 — data.test.ts 와 같은 규율).
const TOTAL = 172;
const LEGEND_TOTAL = 14;

describe("발행물 정합", () => {
  it("생성기를 다시 돌린 결과와 발행 파일이 바이트 동일하다(AC-D2 결정론)", () => {
    const regenerated = JSON.stringify(buildFile(players, manifest), null, 2) + "\n";
    expect(regenerated).toBe(readFileSync(OUT_PATH, "utf8"));
  });

  it("두 번 생성해도 같다(순수성)", () => {
    expect(buildMapping(players, manifest)).toEqual(buildMapping(players, manifest));
  });

  it("입력 순서가 바뀌어도 결과가 같다(맵 순회 순서 비의존)", () => {
    const shuffled = [...players].reverse();
    expect(buildMapping(shuffled, manifest)).toEqual(buildMapping(players, manifest));
  });

  it("버전 태그가 파일명과 맞는다", () => {
    expect(published.version).toBe(CHARS_MAP_VERSION);
    expect(OUT_PATH.endsWith(`player-chars.${CHARS_MAP_VERSION}.json`)).toBe(true);
  });
});

describe("B안 커버리지 — 폴백으로 떨어지는 선수가 없다", () => {
  it("172명 전원이 매핑된다", () => {
    expect(published.playerCount).toBe(TOTAL);
    expect(Object.keys(published.players)).toHaveLength(TOTAL);
    for (const p of players) {
      expect(published.players[p.id], p.id).toBeTruthy();
    }
  });

  it("배정된 charId 는 전부 캐릭터 발행물에 실재한다(깨진 참조 0)", () => {
    for (const [playerId, charId] of Object.entries(published.players)) {
      expect(charsManifest.characters[charId], `${playerId} → ${charId}`).toBeTruthy();
    }
  });
});

describe("LEGEND 1:1 독점", () => {
  const legendIds = players.filter((p) => p.grade === "LEGEND").map((p) => p.id);

  it("LEGEND 는 14명이고 서로 다른 캐릭터를 갖는다(LEGEND 끼리 중복 0)", () => {
    expect(legendIds).toHaveLength(LEGEND_TOTAL);
    const chars = legendIds.map((id) => published.players[id]);
    expect(new Set(chars).size).toBe(LEGEND_TOTAL);
  });

  it("hue 변형 2종은 발행측 힌트대로 고정되고 다른 선수에게 재사용되지 않는다", () => {
    expect(published.players.P143).toBe("sail-h150");
    expect(published.players.P144).toBe("ragna-h210");
    const all = Object.values(published.players);
    expect(all.filter((c) => c === "sail-h150")).toHaveLength(1);
    expect(all.filter((c) => c === "ragna-h210")).toHaveLength(1);
  });

  it("변형은 비-LEGEND 풀에 들어가지 않는다", () => {
    for (const pool of Object.values(POOL_BY_POSITION)) {
      expect(pool).not.toContain("sail-h150");
      expect(pool).not.toContain("ragna-h210");
    }
  });

  it("대표 배정이 고정돼 있다(규칙이 바뀌면 여기서 걸린다)", () => {
    expect(published.players.P001).toBe("aura"); // Lev Yashin, GK
    expect(published.players.P009).toBe("ragna"); // Pelé, FW
    expect(published.detail.find((d) => d.playerId === "P001")?.rule).toBe("legend-exclusive");
  });
});

describe("포지션 정합", () => {
  it("포지션 교차는 문서화된 1건(P012)뿐이다", () => {
    const cross = published.detail.filter((d) => d.crossPosition);
    expect(cross.map((c) => c.playerId)).toEqual(["P012"]);
    expect(cross[0].charId).toBe("penguin-king"); // 여분 GK 캐릭터 → FW 슬롯
  });

  it("교차 1건을 빼면 캐릭터 포지션 = 선수 포지션", () => {
    const byId = new Map(players.map((p) => [p.id, p]));
    for (const d of published.detail) {
      if (d.crossPosition) continue;
      const charPos = charsManifest.characters[d.charId]!.position;
      expect(charPos, `${d.playerId} → ${d.charId}`).toBe(byId.get(d.playerId)!.position);
    }
  });

  it("비-LEGEND 는 자기 포지션 풀 안에서만 배정된다", () => {
    const byId = new Map(players.map((p) => [p.id, p]));
    for (const d of published.detail) {
      if (d.rule !== "position-pool") continue;
      expect(POOL_BY_POSITION[byId.get(d.playerId)!.position], d.playerId).toContain(d.charId);
    }
  });
});

describe("중복 분산 — 같은 얼굴 쏠림 방지", () => {
  it("포지션 풀 안에서 사용 횟수 편차가 1 이하다(균등 라운드로빈)", () => {
    const byId = new Map(players.map((p) => [p.id, p]));
    for (const position of POSITIONS) {
      const counts = new Map<string, number>(POOL_BY_POSITION[position].map((c) => [c, 0]));
      for (const d of published.detail) {
        if (d.rule !== "position-pool") continue;
        if (byId.get(d.playerId)!.position !== position) continue;
        counts.set(d.charId, (counts.get(d.charId) ?? 0) + 1);
      }
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values), `${position}: ${JSON.stringify([...counts])}`)
        .toBeLessThanOrEqual(1);
    }
  });

  it("원본 12종이 전부 쓰인다(놀고 있는 캐릭터 0)", () => {
    const used = new Set(Object.values(published.players));
    for (const pool of Object.values(POOL_BY_POSITION)) {
      for (const charId of pool) expect(used, charId).toContain(charId);
    }
  });
});

describe("잘못된 입력은 조용히 넘어가지 않는다", () => {
  const okManifest: CharsManifestLike = { source: manifest.source, characters: manifest.characters };

  it("LEGEND 배정 대상이 시드에 없으면 throw", () => {
    const missing = players.filter((p) => p.id !== "P001");
    expect(() => buildMapping(missing, okManifest)).toThrow(/P001/);
  });

  it("배정표에 없는 LEGEND 가 생기면 throw(1:1 이 깨진 걸 감춘 채 발행하지 않는다)", () => {
    const extra: PlayerLike[] = [...players, { id: "P900", position: "MF", grade: "LEGEND" }];
    expect(() => buildMapping(extra, okManifest)).toThrow(/P900/);
  });

  it("캐릭터 발행물이 다른 소스로 바뀌면 throw(매핑 재확정 강제)", () => {
    expect(() => buildMapping(players, { ...okManifest, source: "other-pack" })).toThrow(/재확정/);
  });

  it("발행물에서 캐릭터가 사라지면 throw", () => {
    const broken: CharsManifestLike = {
      source: manifest.source,
      characters: { ...manifest.characters, aura: undefined },
    };
    expect(() => buildMapping(players, broken)).toThrow(/aura/);
  });
});
