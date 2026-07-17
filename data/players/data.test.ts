import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PlayerCard } from "@hmb/shared";
import { generateAll, type PlayerSeed, type Position, type Grade } from "./generate";
import { REAL_NAME_DENYLIST } from "./names";

const POSITIONS: Position[] = ["GK", "DF", "MF", "FW"];
const GRADES: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];

// LLD-data §2 리터럴 값을 테스트에 직접 박제 — generate.ts 의 상수(GRADE_BANDS 등)를
// 재사용하면 자기참조 검증이 되어 generate.ts 오타를 못 잡는다(독립 QA minor-3).
const BANDS: Record<Grade, readonly [number, number]> = {
  BRONZE: [40, 55],
  SILVER: [50, 65],
  GOLD: [60, 75],
  DIA: [70, 85],
  LEGEND: [80, 95],
};
const PRIMARY: Record<Position, readonly (keyof PlayerSeed["attributes"])[]> = {
  GK: ["positioning", "mental"],
  DF: ["tackling", "positioning"],
  MF: ["passing", "stamina"],
  FW: ["shooting", "pace"],
};
const RANK: Record<Grade, number> = { BRONZE: 0, SILVER: 1, GOLD: 2, DIA: 3, LEGEND: 4 };

const { players, economy, bots } = generateAll();

describe("players.v1 — counts/distribution (AC-D1)", () => {
  it("총 110명", () => {
    expect(players.length).toBe(110);
  });

  it("포지션 분포 GK12/DF36/MF36/FW26", () => {
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of players) counts[p.position]++;
    expect(counts).toEqual({ GK: 12, DF: 36, MF: 36, FW: 26 });
  });

  it("등급 분포 BRONZE40/SILVER30/GOLD20/DIA14/LEGEND6", () => {
    const counts: Record<Grade, number> = {
      BRONZE: 0,
      SILVER: 0,
      GOLD: 0,
      DIA: 0,
      LEGEND: 0,
    };
    for (const p of players) counts[p.grade]++;
    expect(counts).toEqual({ BRONZE: 40, SILVER: 30, GOLD: 20, DIA: 14, LEGEND: 6 });
  });

  it("포지션×등급 교차 분포 — 행/열 합이 각 총원과 일치", () => {
    const table: Record<Position, Record<Grade, number>> = {
      GK: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      DF: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      MF: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      FW: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
    };
    for (const p of players) table[p.position][p.grade]++;

    for (const pos of POSITIONS) {
      const rowSum = GRADES.reduce((s, g) => s + table[pos][g], 0);
      const expected = { GK: 12, DF: 36, MF: 36, FW: 26 }[pos];
      expect(rowSum, `${pos} 행 합`).toBe(expected);
    }
    for (const g of GRADES) {
      const colSum = POSITIONS.reduce((s, pos) => s + table[pos][g], 0);
      const expected = { BRONZE: 40, SILVER: 30, GOLD: 20, DIA: 14, LEGEND: 6 }[g];
      expect(colSum, `${g} 열 합`).toBe(expected);
    }
  });

  it("GK는 등급별 최소 1명씩 보유", () => {
    const gkGradeCounts: Record<Grade, number> = {
      BRONZE: 0,
      SILVER: 0,
      GOLD: 0,
      DIA: 0,
      LEGEND: 0,
    };
    for (const p of players) if (p.position === "GK") gkGradeCounts[p.grade]++;
    for (const g of GRADES) {
      expect(gkGradeCounts[g], `GK ${g}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("players.v1 — ID/이름 유일성", () => {
  it("ID가 P001..P110 순차·유일", () => {
    const ids = players.map((p) => p.id);
    expect(new Set(ids).size).toBe(110);
    const expectedIds = Array.from(
      { length: 110 },
      (_, i) => `P${String(i + 1).padStart(3, "0")}`,
    );
    expect(ids).toEqual(expectedIds);
  });

  it("이름이 전부 유일", () => {
    const names = players.map((p) => p.name);
    expect(new Set(names).size).toBe(110);
  });

  it("실선수 이름 형태가 아닌 가상 한글 이름(음절 조합, 3자)", () => {
    for (const p of players) {
      expect(p.name).toMatch(/^[가-힣]{3}$/);
    }
  });

  it("실선수 거부 목록(REAL_NAME_DENYLIST)과 충돌 0 — 실선수 이름 금지", () => {
    expect(REAL_NAME_DENYLIST.length).toBeGreaterThanOrEqual(100);
    const deny = new Set(REAL_NAME_DENYLIST);
    const collisions = players.filter((p) => deny.has(p.name)).map((p) => `${p.id}:${p.name}`);
    expect(collisions, `실선수 이름 충돌: ${collisions.join(", ")}`).toEqual([]);
  });
});

describe("players.v1 — 능력치 밴드 (AC-D1)", () => {
  const ATTR_KEYS = [
    "technical",
    "mental",
    "physical",
    "passing",
    "shooting",
    "tackling",
    "pace",
    "stamina",
    "positioning",
  ] as const;

  it("모든 능력치가 해당 등급 밴드 내(clamp 포함) — LLD 리터럴 밴드 기준", () => {
    for (const p of players) {
      const [lo, hi] = BANDS[p.grade];
      for (const key of ATTR_KEYS) {
        const v = p.attributes[key];
        expect(v, `${p.id} ${p.grade} ${key}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${p.id} ${p.grade} ${key}`).toBeLessThanOrEqual(hi);
        expect(Number.isInteger(v), `${p.id} ${key} integer`).toBe(true);
      }
    }
  });

  it("포지션 주스탯 평균이 비주스탯 평균보다 높다(+5 바이어스 효과, 모집단 단위)", () => {
    for (const pos of POSITIONS) {
      const posPlayers = players.filter((p) => p.position === pos);
      const primary = PRIMARY[pos];
      const primaryAvg =
        posPlayers.reduce(
          (s, p) => s + primary.reduce((s2, k) => s2 + p.attributes[k], 0) / primary.length,
          0,
        ) / posPlayers.length;
      const otherKeys = ATTR_KEYS.filter((k) => !primary.includes(k));
      const otherAvg =
        posPlayers.reduce(
          (s, p) => s + otherKeys.reduce((s2, k) => s2 + p.attributes[k], 0) / otherKeys.length,
          0,
        ) / posPlayers.length;
      expect(primaryAvg, `${pos} 주스탯 평균 > 비주스탯 평균`).toBeGreaterThan(otherAvg);
    }
  });
});

describe("players.v1 — zod PlayerCard 호환 (AC-D3)", () => {
  it("모든 선수가 shared PlayerCard 스키마로 파싱된다(id→playerId 매핑)", () => {
    for (const p of players) {
      const card = PlayerCard.parse({
        playerId: p.id,
        name: p.name,
        position: p.position,
        attributes: p.attributes,
      });
      expect(card.playerId).toBe(p.id);
    }
  });
});

describe("economy.v1 — 스타터팩·확률표", () => {
  it("economy.version === 'v1'", () => {
    expect(economy.version).toBe("v1");
  });

  it("initialPoints === 3000", () => {
    expect(economy.initialPoints).toBe(3000);
  });

  it("starterPack 14명: GK1/DF5/MF5/FW3, 전원 브론즈~실버", () => {
    expect(economy.starterPack.length).toBe(14);
    expect(new Set(economy.starterPack).size).toBe(14);

    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const id of economy.starterPack) {
      const p = byId.get(id);
      expect(p, `starterPack id ${id} exists in players.v1`).toBeDefined();
      if (!p) continue;
      counts[p.position]++;
      expect(
        p.grade === "BRONZE" || p.grade === "SILVER",
        `${id} grade ${p.grade} within BRONZE~SILVER`,
      ).toBe(true);
    }
    expect(counts).toEqual({ GK: 1, DF: 5, MF: 5, FW: 3 });
  });

  it("gacha 확률 합 === 1", () => {
    const sum = Object.values(economy.gacha.rates).reduce((s, r) => s + r, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("gacha 수치 — 단뽑300/10연뽑3000/11개/GOLD pity", () => {
    expect(economy.gacha.singleCost).toBe(300);
    expect(economy.gacha.tenCost).toBe(3000);
    expect(economy.gacha.tenCount).toBe(11);
    expect(economy.gacha.tenPityMinGrade).toBe("GOLD");
  });

  it("rewards — 승500/무200/패100", () => {
    expect(economy.rewards).toEqual({ win: 500, draw: 200, loss: 100 });
  });
});

describe("bots.v1 — 덱 유효성(서버 규칙: 11명·GK≥1·중복 금지)", () => {
  it("봇 3종 존재: BOT_ATK/BOT_DEF/BOT_BAL", () => {
    expect(bots.map((b) => b.id).sort()).toEqual(["BOT_ATK", "BOT_BAL", "BOT_DEF"]);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발 11명 + 벤치 4명, 중복 없음", (botId) => {
    const bot = bots.find((b) => b.id === botId);
    expect(bot).toBeDefined();
    if (!bot) return;
    expect(bot.deck.starters.length).toBe(11);
    expect(bot.deck.bench.length).toBe(4);

    const allIds = [...bot.deck.starters.map((s) => s.playerId), ...bot.deck.bench];
    expect(new Set(allIds).size).toBe(15);

    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    for (const id of allIds) {
      expect(byId.get(id), `${botId} 선수 ${id} exists`).toBeDefined();
    }
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발에 GK 최소 1명", (botId) => {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) return;
    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const gkCount = bot.deck.starters.filter((s) => byId.get(s.playerId)?.position === "GK")
      .length;
    expect(gkCount).toBeGreaterThanOrEqual(1);
  });

  it("BOT_ATK: FW 2명에 promptText('적극 침투') 부여", () => {
    const bot = bots.find((b) => b.id === "BOT_ATK");
    expect(bot).toBeDefined();
    if (!bot) return;
    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const promptedFw = bot.deck.starters.filter(
      (s) => byId.get(s.playerId)?.position === "FW" && s.promptText === "적극 침투",
    );
    expect(promptedFw.length).toBe(2);
  });

  it("BOT_ATK: 미드필더/공격수가 GOLD 이상 위주", () => {
    const bot = bots.find((b) => b.id === "BOT_ATK");
    expect(bot).toBeDefined();
    if (!bot) return;
    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const mfFw = bot.deck.starters.filter((s) => {
      const pos = byId.get(s.playerId)?.position;
      return pos === "MF" || pos === "FW";
    });
    const goldUp = mfFw.filter((s) => RANK[byId.get(s.playerId)!.grade] >= RANK.GOLD);
    expect(goldUp.length).toBe(mfFw.length);
  });

  it("BOT_DEF: 수비수가 GOLD 이상 위주", () => {
    const bot = bots.find((b) => b.id === "BOT_DEF");
    expect(bot).toBeDefined();
    if (!bot) return;
    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const df = bot.deck.starters.filter((s) => byId.get(s.playerId)?.position === "DF");
    const goldUp = df.filter((s) => RANK[byId.get(s.playerId)!.grade] >= RANK.GOLD);
    expect(goldUp.length).toBe(df.length);
  });

  it("BOT_BAL: 등급 혼합·실버 중심(LLD §4) — SILVER 과반 + BRONZE≥1 + GOLD 1~2, DIA/LEGEND 없음", () => {
    const bot = bots.find((b) => b.id === "BOT_BAL");
    expect(bot).toBeDefined();
    if (!bot) return;
    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const counts: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    for (const s of bot.deck.starters) {
      const p = byId.get(s.playerId);
      expect(p, s.playerId).toBeDefined();
      if (p) counts[p.grade]++;
    }
    expect(counts.SILVER, "실버 과반(중심)").toBeGreaterThan(11 / 2);
    expect(counts.BRONZE, "혼합 — 브론즈 포함").toBeGreaterThanOrEqual(1);
    expect(counts.GOLD, "혼합 — 골드 1~2(첫 승리 가능 수준)").toBeGreaterThanOrEqual(1);
    expect(counts.GOLD).toBeLessThanOrEqual(2);
    expect(counts.DIA + counts.LEGEND, "고등급 없음(비등한 전력)").toBe(0);
  });
});

describe("발행 파일 동기화 — v1 파일 = generateAll() 직렬화 결과", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases: readonly [string, unknown][] = [
    ["players.v1.json", players],
    ["economy.v1.json", economy],
    ["bots.v1.json", bots],
  ];

  it.each(cases)("%s 가 디스크에서 바이트 동일(수정·재생성 누락 검출)", (file, data) => {
    const onDisk = readFileSync(join(here, file as string), "utf8");
    expect(onDisk).toBe(JSON.stringify(data, null, 2) + "\n");
  });
});

describe("재생성 결정론 (AC-D2)", () => {
  it("generateAll()을 두 번 호출하면 바이트(JSON.stringify) 동일", () => {
    const a = generateAll();
    const b = generateAll();
    expect(JSON.stringify(a.players, null, 2)).toBe(JSON.stringify(b.players, null, 2));
    expect(JSON.stringify(a.economy, null, 2)).toBe(JSON.stringify(b.economy, null, 2));
    expect(JSON.stringify(a.bots, null, 2)).toBe(JSON.stringify(b.bots, null, 2));
  });
});
