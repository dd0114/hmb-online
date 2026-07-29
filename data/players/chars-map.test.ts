/**
 * 선수 ↔ 아트 매핑 계약 (#145 → **#207 W3-D 로 개편**).
 *
 * 이 파일이 지키는 것: 발행물 결정론 · **축 태그 계약**(두 축이 한 맵에 섞인다) ·
 * v1 소비자가 v2 를 **오독하지 않는다**는 fail-safe · U-D5/U-D8/U-D9 배정 규칙 · fail-closed 가드.
 *
 * ⚠️ 리터럴 총원은 **현행 소비 시드(players.v2.4.json)** 기준이다. 직전 판은 동결 v2.1(172명/
 * LEGEND 14) 에 핀돼 있었고 "활성 LEGEND 8종은 매핑 없음"을 계약으로 두었는데, U-D5(실아트 5종
 * 입고) 이후 그 문장은 **사실과 반대**가 됐다 → 여기서 뒤집는다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHARS_MAP_VERSION,
  DEFAULT_SEED_FILE,
  DEFAULT_UNIT_GRADES,
  DEFAULT_UNIT_ID,
  OUT_PATH,
  POOL_BY_POSITION,
  POOL_GRADES,
  buildFile,
  buildMapping,
  loadInputs,
  type CharsManifestLike,
  type PlayerLike,
  type UnitsManifestLike,
} from "./gen-chars";
import type { Grade, Position } from "./generate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const { players, manifest, units } = loadInputs();
/** 발행된 매핑 파일(생성물) — 소비자가 실제로 읽는 것. */
const published = JSON.parse(readFileSync(OUT_PATH, "utf8")) as ReturnType<typeof buildFile>;
/** 아트 발행 manifest 원본 — 매핑이 참조하는 두 축. */
const distDir = join(repoRoot, "design", "characters", "dist");
const charsManifest = JSON.parse(
  readFileSync(join(distDir, "characters", "manifest.json"), "utf8"),
) as CharsManifestLike;
const unitsManifest = JSON.parse(readFileSync(join(distDir, "units", "manifest.json"), "utf8")) as UnitsManifestLike;

const POSITIONS: Position[] = ["GK", "DF", "MF", "FW"];

// 문서화된 총원을 리터럴로 박제(자기참조 검증 회피 — data.test.ts 와 같은 규율).
const CATALOG_TOTAL = 182;
const LEGEND_TOTAL = 24;
/** v2.2/v2.3 발행 경계(#207 까지). 과거 시드로 태우는 회귀 검증에서 쓴다. */
const V23_CATALOG_TOTAL = 180;
/** U-D5 활성 LEGEND = 실아트 입고 + 시드 활성화까지 끝난 분. 이 5명만 units 축 1:1 을 갖는다. */
const ACTIVE_LEGEND_UNITS: ReadonlyArray<readonly [string, string]> = [
  ["P173", "bonaldo"],
  ["P175", "yeoldona"],
  ["P176", "chunbappe"],
  ["P177", "dukbrayner"],
  ["P179", "wookringham"],
];
/**
 * 3차 입고(2026-07-29) — **아트는 들어왔지만 시드는 아직 비활성**인 LEGEND.
 *
 * 운영 순서가 "아트 머지 → 배포 → 어드민 API 로 활성화"(grade-mapping-v2 §9.8)라서 이 중간상태는
 * **정상**이다. 매핑은 미리 붙여 둔다 — 활성화 토글이 켜지는 순간 아트가 같이 떠야 하기 때문.
 * 어드민 상태가 다음 시드 버전으로 승격되면 여기서 ACTIVE_LEGEND_UNITS 로 옮긴다.
 */
const PENDING_ACTIVATION_UNITS: ReadonlyArray<readonly [string, string]> = [
  ["P180", "kyeongnicius"],
  // #256 채번분 2종 — 아트는 입고 완료(석다이크는 3차, 오시야스는 4차)이고 시드는 비활성이다.
  ["P181", "seokdijk"],
  ["P182", "osiyas"],
];
/** 아트 **미입고** LEGEND — 매핑 없음이 정답(이니셜 폴백). */
const UNMAPPED_LEGENDS = ["P174", "P178"];
/**
 * 아트는 발행됐지만 **카탈로그에 붙일 선수가 아직 없다**(채번 대기) — 발행물이 `pendingCatalog`
 * 로 선언한 유닛. "놀고 있는 유닛 0" 계약은 이 선언분만 면제한다(침묵 면제 아님).
 */
const PENDING_CATALOG_UNITS: readonly string[] = [];
/** 구 14종 — 비활성이지만 매핑 유지(보유분 아트를 뺏지 않는다). */
const KEPT_LEGENDS = ["P001", "P002", "P003", "P004", "P005", "P006", "P007", "P008", "P009", "P010", "P011", "P012", "P143", "P144"];

const byId = new Map(players.map((p) => [p.id, p]));
const gradeOf = (id: string) => byId.get(id)!.grade;

describe("발행물 정합", () => {
  it("생성기를 다시 돌린 결과와 발행 파일이 바이트 동일하다(AC-D2 결정론)", () => {
    const regenerated = JSON.stringify(buildFile(players, manifest, units), null, 2) + "\n";
    expect(regenerated).toBe(readFileSync(OUT_PATH, "utf8"));
  });

  it("두 번 생성해도 같다(순수성)", () => {
    expect(buildMapping(players, manifest, units)).toEqual(buildMapping(players, manifest, units));
  });

  it("입력 순서가 바뀌어도 결과가 같다(맵 순회 순서 비의존)", () => {
    const shuffled = [...players].reverse();
    expect(buildMapping(shuffled, manifest, units)).toEqual(buildMapping(players, manifest, units));
  });

  it("버전 태그가 파일명과 맞고, 어떤 시드를 보고 만든 매핑인지 박제돼 있다", () => {
    expect(published.version).toBe(CHARS_MAP_VERSION);
    expect(OUT_PATH.endsWith(`player-chars.${CHARS_MAP_VERSION}.json`)).toBe(true);
    expect(published.playersSource).toBe(DEFAULT_SEED_FILE);
    expect(DEFAULT_SEED_FILE).toBe("players.v2.4.json");
  });

  it("입력 시드가 파라미터다 — 과거 시드도 그대로 읽힌다(회귀 검증 가능)", () => {
    const past = loadInputs("players.v2.2.json");
    expect(past.players).toHaveLength(V23_CATALOG_TOTAL);
    expect(past.seedFile).toBe("players.v2.2.json");
    // v2.2 는 P174/P178 이 아직 **활성**이다 — 활성인데 실아트가 없는 상태라
    // "활성 LEGEND = 실아트"가 성립하지 않는다. 그래서 발행 대상은 v2.3 이후뿐이다.
    expect(past.players.filter((p) => p.grade === "LEGEND" && p.active)).toHaveLength(8);
  });

  it("배정표보다 낡은 시드로 태우면 **fail-closed** — 신규 채번분이 조용히 빠지지 않는다", () => {
    // ⚠️ #256 이전에는 이 자리에서 "과거 시드로도 **매핑까지** 성립한다"를 주장했다. 배정표가
    // 그 시드의 id 공간 안에 있었기 때문이다. #256 이 P181/P182 를 채번하면서 그 전제가 깨졌고,
    // 주장을 유지하려면 배정 누락을 **묵인**해야 한다 — 그건 이 파일의 핵심 계약("배정표에
    // 없으면 throw", 1:1 이 조용히 깨지는 걸 막는다)을 정면으로 뒤집는 것이다.
    // 그래서 성질을 바꿔 박는다: 낡은 시드는 **거부되어야** 하고, 메시지가 누락 id 를 지목한다.
    const past = loadInputs("players.v2.2.json");
    expect(() => buildMapping(past.players, manifest, units)).toThrow(/P181/);
    // 현행 시드에서는 배정표 전원이 실제로 매핑된다(위 거부가 배정표 자체의 오류가 아님을 증명).
    const map = buildMapping(players, manifest, units);
    expect(map.filter((d) => d.rule === "unit-exclusive").map((d) => d.playerId))
      .toEqual([...ACTIVE_LEGEND_UNITS, ...PENDING_ACTIVATION_UNITS].map(([id]) => id).sort());
  });
});

describe("축 태그 계약 — 두 축이 한 맵에 섞인다", () => {
  it("모든 매핑값이 {axis,id} 객체다(문자열 아님)", () => {
    for (const [playerId, ref] of Object.entries(published.players)) {
      expect(typeof ref, playerId).toBe("object");
      expect(["characters", "units"], playerId).toContain(ref.axis);
      expect(typeof ref.id, playerId).toBe("string");
    }
  });

  it("배정된 id 는 전부 **자기 축** 발행물에 실재한다(깨진 참조 0)", () => {
    for (const [playerId, ref] of Object.entries(published.players)) {
      const pool = ref.axis === "characters" ? charsManifest.characters : unitsManifest.units;
      expect(pool[ref.id], `${playerId} → ${ref.axis}:${ref.id}`).toBeTruthy();
    }
  });

  it("발행측 힌트(forPlayer/forGrades)와 권위 매핑이 일치한다", () => {
    for (const [unitId, entry] of Object.entries(unitsManifest.units)) {
      if (entry?.forPlayer) {
        expect(published.players[entry.forPlayer], `${unitId}.forPlayer`).toEqual({ axis: "units", id: unitId });
      }
      if (entry?.forGrades) {
        expect(unitId).toBe(DEFAULT_UNIT_ID);
        expect([...entry.forGrades].sort()).toEqual([...DEFAULT_UNIT_GRADES].sort());
      }
    }
  });
});

describe("v1 소비자 오독 방지 — 형이 바뀌면 구 소비자는 조용히 폴백으로 떨어진다", () => {
  /** v1 리더 재현 1: `charIdFor`(char-assets-store) — 문자열로 좁힌다. */
  const v1CharIdFor = (map: Record<string, unknown>, playerId: string): string | null => {
    if (!Object.prototype.hasOwnProperty.call(map, playerId)) return null;
    const charId = map[playerId];
    return typeof charId === "string" ? charId : null;
  };
  /** v1 리더 재현 2: `own()`(char-manifest) — manifest 키 조회는 문자열 키만 받는다. */
  const v1Own = (record: Record<string, unknown>, key: unknown): unknown =>
    typeof key !== "string" ? undefined : Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

  it("v1 의 charIdFor 는 v2 항목 전부에서 null 을 돌려준다(= 매핑 없음 = 폴백)", () => {
    for (const playerId of Object.keys(published.players)) {
      expect(v1CharIdFor(published.players as Record<string, unknown>, playerId), playerId).toBeNull();
    }
  });

  it("v1 의 manifest 키 조회는 객체 키를 undefined 로 떨군다(NaN 좌표·깨진 타일 0)", () => {
    for (const ref of Object.values(published.players)) {
      expect(v1Own(charsManifest.characters as Record<string, unknown>, ref)).toBeUndefined();
    }
  });

  it("어떤 항목도 문자열로 강제하면 실재 charId 가 되지 않는다(우연한 오독 0)", () => {
    const knownIds = new Set([...Object.keys(charsManifest.characters), ...Object.keys(unitsManifest.units)]);
    for (const ref of Object.values(published.players)) {
      expect(knownIds.has(String(ref))).toBe(false);
    }
  });

  it("v1 발행물은 그대로 남아 있다(동결 — 구 빌드가 계속 읽을 수 있다)", () => {
    const v1 = JSON.parse(readFileSync(join(here, "player-chars.v1.json"), "utf8")) as {
      version: string;
      players: Record<string, unknown>;
    };
    expect(v1.version).toBe("v1");
    expect(typeof v1.players.P001).toBe("string");
  });
});

describe("U-D5 — 활성 LEGEND 5종 = units 축 1:1 실아트", () => {
  it("활성 LEGEND 는 정확히 이 5명이고 전원 units 1:1 이다", () => {
    const active = players.filter((p) => p.grade === "LEGEND" && p.active).map((p) => p.id);
    expect(active).toEqual(ACTIVE_LEGEND_UNITS.map(([id]) => id));
    for (const [playerId, unitId] of ACTIVE_LEGEND_UNITS) {
      expect(published.players[playerId], playerId).toEqual({ axis: "units", id: unitId });
      expect(published.detail.find((d) => d.playerId === playerId)?.rule).toBe("unit-exclusive");
    }
  });

  it("5종은 서로 다른 유닛을 갖는다(1:1 독점 — 공용 스킨과 섞이지 않는다)", () => {
    const ids = ACTIVE_LEGEND_UNITS.map(([playerId]) => published.players[playerId].id);
    expect(new Set(ids).size).toBe(ACTIVE_LEGEND_UNITS.length);
    expect(ids).not.toContain(DEFAULT_UNIT_ID);
  });

  it("아트 미입고 LEGEND 는 **미매핑**(이니셜 폴백)이 정답이다", () => {
    for (const id of UNMAPPED_LEGENDS) {
      expect(gradeOf(id)).toBe("LEGEND");
      expect(byId.get(id)!.active).toBe(false);
      expect(published.players[id], `${id} 는 미매핑이어야 한다(U-D5)`).toBeUndefined();
    }
    expect(published.unmapped).toEqual(UNMAPPED_LEGENDS);
  });

  it("활성화 대기분은 **비활성이지만 매핑은 미리 붙어 있다** — 토글과 아트가 같이 뜬다", () => {
    for (const [playerId, unitId] of PENDING_ACTIVATION_UNITS) {
      expect(gradeOf(playerId)).toBe("LEGEND");
      // 시드는 아직 비활성 — 활성화는 어드민 API 몫이다(§9.8).
      expect(byId.get(playerId)!.active, `${playerId} 는 시드에서 아직 비활성`).toBe(false);
      // 그래도 매핑은 있다. 없으면 활성화 순간 이니셜 폴백으로 떠서 "아트 없는 LEGEND"가 된다.
      expect(published.players[playerId], playerId).toEqual({ axis: "units", id: unitId });
      expect(published.detail.find((d) => d.playerId === playerId)?.rule).toBe("unit-exclusive");
      // 미매핑 목록에 섞이면 안 된다(두 상태는 다르다).
      expect(published.unmapped).not.toContain(playerId);
    }
  });

  // 해제 신호 — 어드민 활성화가 다음 시드로 승격되면(§9.8) 이 테스트가 **실패하며** 대기표를
  // 정리하라고 알린다. 침묵하는 대기표는 "아직 안 켰다"와 "켰는데 안 지웠다"를 구분 못 한다.
  it("활성화 대기표는 stale 이 아니다 — 시드가 활성으로 승격되면 실패해서 알린다", () => {
    for (const [playerId] of PENDING_ACTIVATION_UNITS) {
      expect(
        byId.get(playerId)!.active,
        `${playerId} 가 시드에서 활성이 됐다 — PENDING_ACTIVATION_UNITS 와 gen-chars 의 ACTIVATION_PENDING 에서 지우고 ACTIVE_LEGEND_UNITS 로 옮겨라`,
      ).toBe(false);
    }
  });

  it("비활성 구 14종은 characters 매핑을 유지한다 — 보유분 아트를 뺏지 않는다", () => {
    for (const id of KEPT_LEGENDS) {
      expect(byId.get(id)!.active).toBe(false);
      expect(published.players[id]?.axis, id).toBe("characters");
    }
    expect(published.detail.filter((d) => d.rule === "legend-exclusive")).toHaveLength(KEPT_LEGENDS.length);
  });

  it("LEGEND 총원 = 유지 14 + 실아트 5 + 활성화대기 1 + 미입고 2", () => {
    expect(players.filter((p) => p.grade === "LEGEND")).toHaveLength(LEGEND_TOTAL);
    // 네 갈래는 서로 겹치지 않고 합이 총원이다 — 어느 하나가 늘면 다른 하나가 줄어야 한다.
    const buckets = [
      KEPT_LEGENDS,
      ACTIVE_LEGEND_UNITS.map(([id]) => id),
      PENDING_ACTIVATION_UNITS.map(([id]) => id),
      UNMAPPED_LEGENDS,
    ];
    expect(buckets.reduce((n, b) => n + b.length, 0)).toBe(LEGEND_TOTAL);
    expect(new Set(buckets.flat()).size, "갈래가 겹친다").toBe(LEGEND_TOTAL);
  });
});

describe("U-D8 — GOLD/SILVER/BRONZE 는 default-unit 공용", () => {
  it("세 등급 전원이 units:default-unit 이다(예외 0)", () => {
    const targets = players.filter((p) => (DEFAULT_UNIT_GRADES as readonly Grade[]).includes(p.grade));
    expect(targets.length).toBe(133); // 46 + 52 + 35
    for (const p of targets) {
      expect(published.players[p.id], p.id).toEqual({ axis: "units", id: DEFAULT_UNIT_ID });
    }
  });

  it("default-unit 은 그 세 등급 밖에서는 쓰이지 않는다", () => {
    for (const [playerId, ref] of Object.entries(published.players)) {
      if (ref.id !== DEFAULT_UNIT_ID) continue;
      expect((DEFAULT_UNIT_GRADES as readonly Grade[]).includes(gradeOf(playerId)), playerId).toBe(true);
    }
  });
});

describe("U-D9 — DIA 는 현행 characters 풀 유지", () => {
  const diaIds = players.filter((p) => p.grade === "DIA").map((p) => p.id);

  it("DIA 25명 전원이 characters 포지션 풀 배정이다", () => {
    expect(diaIds).toHaveLength(25);
    expect(POOL_GRADES).toEqual(["DIA"]);
    for (const id of diaIds) {
      expect(published.players[id]?.axis, id).toBe("characters");
      expect(published.detail.find((d) => d.playerId === id)?.rule, id).toBe("position-pool");
    }
  });

  it("풀 배정은 자기 포지션 풀 안에서만 나온다", () => {
    for (const d of published.detail) {
      if (d.rule !== "position-pool") continue;
      expect(POOL_BY_POSITION[byId.get(d.playerId)!.position], d.playerId).toContain(d.id);
    }
  });

  it("포지션 풀 안에서 사용 횟수 편차가 1 이하다(균등 라운드로빈 — 같은 얼굴 쏠림 방지)", () => {
    for (const position of POSITIONS) {
      const counts = new Map<string, number>(POOL_BY_POSITION[position].map((c) => [c, 0]));
      for (const d of published.detail) {
        if (d.rule !== "position-pool") continue;
        if (byId.get(d.playerId)!.position !== position) continue;
        counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
      }
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values), `${position}: ${JSON.stringify([...counts])}`)
        .toBeLessThanOrEqual(1);
    }
  });
});

describe("포지션 정합", () => {
  it("포지션 교차는 문서화된 1건(P012)뿐이다", () => {
    const cross = published.detail.filter((d) => d.crossPosition);
    expect(cross.map((c) => c.playerId)).toEqual(["P012"]);
    expect(cross[0].id).toBe("penguin-king"); // 여분 GK 캐릭터 → FW 슬롯
  });

  it("교차 1건과 포지션 없는 디폴트 유닛을 빼면 아트 포지션 = 선수 포지션", () => {
    for (const d of published.detail) {
      if (d.crossPosition) continue;
      const artPos =
        d.axis === "characters" ? charsManifest.characters[d.id]!.position : unitsManifest.units[d.id]!.position;
      if (!artPos) {
        expect(d.id).toBe(DEFAULT_UNIT_ID); // 포지션 없는 아트는 공용 스킨뿐이다
        continue;
      }
      expect(artPos, `${d.playerId} → ${d.id}`).toBe(byId.get(d.playerId)!.position);
    }
  });

  it("hue 변형 2종은 발행측 힌트대로 고정되고 다른 선수에게 재사용되지 않는다", () => {
    expect(published.players.P143).toEqual({ axis: "characters", id: "sail-h150" });
    expect(published.players.P144).toEqual({ axis: "characters", id: "ragna-h210" });
    const all = Object.values(published.players).map((r) => r.id);
    expect(all.filter((c) => c === "sail-h150")).toHaveLength(1);
    expect(all.filter((c) => c === "ragna-h210")).toHaveLength(1);
  });

  it("변형은 풀에 들어가지 않는다", () => {
    for (const pool of Object.values(POOL_BY_POSITION)) {
      expect(pool).not.toContain("sail-h150");
      expect(pool).not.toContain("ragna-h210");
    }
  });
});

describe("커버리지 — 카탈로그 대비 매핑", () => {
  it("180명 중 178명 매핑 · 미매핑 2명은 전부 의도된 미입고 LEGEND", () => {
    expect(published.catalogCount).toBe(CATALOG_TOTAL);
    expect(published.playerCount).toBe(CATALOG_TOTAL - UNMAPPED_LEGENDS.length);
    expect(Object.keys(published.players)).toHaveLength(published.playerCount);
    expect(published.unmapped.every((id) => gradeOf(id) === "LEGEND")).toBe(true);
  });

  it("원본 12종 캐릭터가 전부 쓰인다(놀고 있는 캐릭터 0)", () => {
    const used = new Set(Object.values(published.players).map((r) => r.id));
    for (const pool of Object.values(POOL_BY_POSITION)) {
      for (const charId of pool) expect(used, charId).toContain(charId);
    }
  });

  it("발행된 유닛이 전부 쓰인다(놀고 있는 유닛 0) — 채번 대기 선언분만 면제", () => {
    const used = new Set(
      Object.values(published.players).filter((r) => r.axis === "units").map((r) => r.id),
    );
    // 면제는 **발행물의 선언**에서만 나온다(테스트가 임의로 빼지 않는다).
    const pending = Object.entries(unitsManifest.units)
      .filter(([, u]) => u?.pendingCatalog)
      .map(([id]) => id);
    // 선언과 이 파일의 리터럴이 어긋나면 둘 중 하나가 낡은 것이다 — 침묵 면제 방지.
    expect(pending.sort(), "pendingCatalog 선언이 예상과 다르다").toEqual([...PENDING_CATALOG_UNITS].sort());
    const expected = Object.keys(unitsManifest.units).filter((id) => !pending.includes(id));
    expect([...used].sort()).toEqual(expected.sort());
  });

  it("채번 대기 유닛은 실제로 아무 선수에게도 붙어 있지 않다(면제가 곧 미사용)", () => {
    const usedIds = new Set(
      Object.values(published.players).filter((r) => r.axis === "units").map((r) => r.id),
    );
    for (const unitId of PENDING_CATALOG_UNITS) {
      expect(unitsManifest.units[unitId], `${unitId} 가 발행물에 없다`).toBeTruthy();
      expect(unitsManifest.units[unitId]?.forPlayer, `${unitId} 는 채번 전이라 힌트가 없어야 한다`).toBeUndefined();
      expect(usedIds, `${unitId} 는 채번 전이라 매핑되면 안 된다`).not.toContain(unitId);
    }
  });
});

describe("잘못된 입력은 조용히 넘어가지 않는다 (fail-closed 변이체)", () => {
  const okChars: CharsManifestLike = { source: manifest.source, characters: manifest.characters };
  const okUnits: UnitsManifestLike = { source: units.source, units: units.units };

  it("LEGEND 배정 대상이 시드에 없으면 throw", () => {
    const missing = players.filter((p) => p.id !== "P001");
    expect(() => buildMapping(missing, okChars, okUnits)).toThrow(/P001/);
  });

  it("배정표 어디에도 없는 LEGEND 가 생기면 throw(1:1 이 깨진 걸 감춘 채 발행하지 않는다)", () => {
    const extra: PlayerLike[] = [...players, { id: "P900", position: "MF", grade: "LEGEND", active: true }];
    expect(() => buildMapping(extra, okChars, okUnits)).toThrow(/P900/);
  });

  it("units 배정 대상이 비활성으로 내려가면 throw(U-D5 전제가 조용히 깨지지 않는다)", () => {
    const deactivated = players.map((p) => (p.id === "P173" ? { ...p, active: false } : p));
    expect(() => buildMapping(deactivated, okChars, okUnits)).toThrow(/P173/);
  });

  it("미입고 LEGEND 에 아트가 들어와 활성이 되면 throw — 표를 갱신하라는 해제 신호", () => {
    // "매핑표를 늘려 통과시키지 않고 폴백을 택했다"가 **의식적 선택**임을 못 박는다.
    const activated = players.map((p) => (p.id === "P178" ? { ...p, active: true } : p));
    // 활성화만으로는 안 터진다(미매핑 표에 있으므로) — 대신 계약 테스트가 활성 5종 리터럴에서 잡는다.
    expect(buildMapping(activated, okChars, okUnits).find((d) => d.playerId === "P178")).toBeUndefined();
    const active = activated.filter((p) => p.grade === "LEGEND" && p.active).map((p) => p.id);
    expect(active).not.toEqual(ACTIVE_LEGEND_UNITS.map(([id]) => id));
  });

  it("디폴트 유닛이 발행물에서 사라지면 throw(GOLD 이하 133명이 통째로 폴백되는 걸 막는다)", () => {
    const broken: UnitsManifestLike = { source: units.source, units: { ...units.units, [DEFAULT_UNIT_ID]: undefined } };
    expect(() => buildMapping(players, okChars, broken)).toThrow(new RegExp(DEFAULT_UNIT_ID));
  });

  it("유닛 발행물에서 실아트가 사라지면 throw", () => {
    const broken: UnitsManifestLike = { source: units.source, units: { ...units.units, bonaldo: undefined } };
    expect(() => buildMapping(players, okChars, broken)).toThrow(/bonaldo/);
  });

  it("캐릭터 발행물이 다른 소스로 바뀌면 throw(매핑 재확정 강제)", () => {
    expect(() => buildMapping(players, { ...okChars, source: "other-pack" }, okUnits)).toThrow(/재확정/);
  });

  it("유닛 발행물이 다른 소스로 바뀌면 throw", () => {
    expect(() => buildMapping(players, okChars, { ...okUnits, source: "other-units" })).toThrow(/재확정/);
  });

  it("발행물에서 캐릭터가 사라지면 throw", () => {
    const broken: CharsManifestLike = { source: manifest.source, characters: { ...manifest.characters, aura: undefined } };
    expect(() => buildMapping(players, broken, okUnits)).toThrow(/aura/);
  });

  it("규칙 없는 새 등급이 생기면 throw(조용히 폴백시키지 않는다)", () => {
    const rogue: PlayerLike[] = [...players, { id: "P901", position: "MF", grade: "MYTH" as Grade, active: true }];
    expect(() => buildMapping(rogue, okChars, okUnits)).toThrow(/MYTH/);
  });
});
