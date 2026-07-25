import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PlayerCard } from "@hmb/shared";
import { generateAll, type PlayerSeed, type Position, type Grade, type Personality } from "./generate";
import { ROSTER } from "./roster";
import { PERSONALITY } from "./personality";

const POSITIONS: Position[] = ["GK", "DF", "MF", "FW"];
const GRADES: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];

// 문서화된 총원(LLD-data §2 v2 / grade-mapping-v2.md)을 테스트에 직접 박제 — roster/generate 의
// 상수를 재사용하면 자기참조 검증이 되어 데이터 드리프트를 못 잡는다. 리터럴로 독립 검증한다.
const TOTAL = 172;
const POSITION_TOTALS: Record<Position, number> = { GK: 13, DF: 53, MF: 59, FW: 47 };
const GRADE_TOTALS: Record<Grade, number> = {
  BRONZE: 35,
  SILVER: 52,
  GOLD: 46,
  DIA: 25,
  LEGEND: 14,
};

// hero 요청(#84): 한국 유명 선수 추가. 대표 선수의 존재·등급을 명시 검증(도감 반영 보장).
const EXPECTED_KOREANS: readonly { name: string; grade: Grade }[] = [
  { name: "Son Heung-min", grade: "DIA" },
  { name: "Kim Min-jae", grade: "DIA" },
  { name: "Park Ji-sung", grade: "LEGEND" },
  { name: "Cha Bum-kun", grade: "LEGEND" },
  { name: "Lee Kang-in", grade: "GOLD" },
  { name: "Hwang Hee-chan", grade: "GOLD" },
  { name: "Cho Hyun-woo", grade: "SILVER" },
  { name: "Yang Min-hyuk", grade: "BRONZE" },
];
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

const PERSONALITIES: Personality[] = ["FIERY", "CALM", "GLASS", "AMBITIOUS"];

// personality 목표 분포(PRD-v3 P2-D7): 대략 FIERY 25 / CALM 40 / GLASS 15 / AMBITIOUS 20 (%).
// "대략" 이므로 밴드로 검증(정확 카운트 강제 금지 — 큐레이션 여지 유지). data 독립 리터럴.
const PERSONALITY_BANDS: Record<Personality, readonly [number, number]> = {
  FIERY: [0.2, 0.3],
  CALM: [0.34, 0.46],
  GLASS: [0.1, 0.2],
  AMBITIOUS: [0.15, 0.25],
};

// 리그 봇 클럽명 실클럽 denylist — data 와 독립인 리터럴(유명 실클럽 정규화 풀네임 + 도시/고유 토큰).
// 가상 클럽명이 이 중 하나와 같거나(정확 일치) 도시 토큰을 포함하면 실패.
const REAL_CLUB_NAMES: readonly string[] = [
  "Manchester United",
  "Manchester City",
  "Liverpool",
  "Chelsea",
  "Arsenal",
  "Tottenham Hotspur",
  "Newcastle United",
  "Aston Villa",
  "West Ham United",
  "Real Madrid",
  "Barcelona",
  "Atletico Madrid",
  "Sevilla",
  "Valencia",
  "Bayern Munich",
  "Borussia Dortmund",
  "RB Leipzig",
  "Bayer Leverkusen",
  "Juventus",
  "Inter Milan",
  "AC Milan",
  "Napoli",
  "AS Roma",
  "Paris Saint-Germain",
  "Marseille",
  "Ajax",
  "PSV Eindhoven",
  "Feyenoord",
  "Benfica",
  "Porto",
  "Sporting CP",
  "Celtic",
  "Rangers",
];
// 실클럽 고유 도시/식별 토큰(가상명에 섞이면 안 됨) — 일반 접미사(United/FC/Athletic 등)는 제외.
const REAL_CLUB_TOKENS: readonly string[] = [
  "Manchester",
  "Liverpool",
  "Chelsea",
  "Arsenal",
  "Tottenham",
  "Newcastle",
  "Madrid",
  "Barcelona",
  "Atletico",
  "Sevilla",
  "Munich",
  "Dortmund",
  "Leipzig",
  "Leverkusen",
  "Juventus",
  "Napoli",
  "Milan",
  "Roma",
  "Ajax",
  "Benfica",
  "Porto",
  "Celtic",
];

const { players, playersV21, economy, bots, league } = generateAll();

describe("players.v2 — counts/distribution (AC-PL1)", () => {
  it(`총 ${TOTAL}명`, () => {
    expect(players.length).toBe(TOTAL);
  });

  it("포지션 분포 GK13/DF53/MF59/FW47 (GK 비중 축소)", () => {
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of players) counts[p.position]++;
    expect(counts).toEqual(POSITION_TOTALS);
  });

  it("GK 비중이 낮다 — 컬렉션의 12% 미만(팀당 선발 1명, hero 지적 반영)", () => {
    const gk = players.filter((p) => p.position === "GK").length;
    expect(gk / players.length).toBeLessThan(0.12);
  });

  it("등급 분포 BRONZE35/SILVER52/GOLD46/DIA25/LEGEND14 (레전드 희소)", () => {
    const counts: Record<Grade, number> = {
      BRONZE: 0,
      SILVER: 0,
      GOLD: 0,
      DIA: 0,
      LEGEND: 0,
    };
    for (const p of players) counts[p.grade]++;
    expect(counts).toEqual(GRADE_TOTALS);
  });

  it("등급 희소성 단조 — LEGEND < DIA < GOLD, 저등급이 더 흔함(수집 열망)", () => {
    const counts: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    for (const p of players) counts[p.grade]++;
    expect(counts.LEGEND).toBeLessThan(counts.DIA);
    expect(counts.DIA).toBeLessThan(counts.GOLD);
  });

  it("포지션×등급 교차 — 행/열 합이 각 총원과 일치", () => {
    const table: Record<Position, Record<Grade, number>> = {
      GK: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      DF: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      MF: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      FW: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
    };
    for (const p of players) table[p.position][p.grade]++;

    for (const pos of POSITIONS) {
      const rowSum = GRADES.reduce((s, g) => s + table[pos][g], 0);
      expect(rowSum, `${pos} 행 합`).toBe(POSITION_TOTALS[pos]);
    }
    for (const g of GRADES) {
      const colSum = POSITIONS.reduce((s, pos) => s + table[pos][g], 0);
      expect(colSum, `${g} 열 합`).toBe(GRADE_TOTALS[g]);
    }
  });

  it("GK는 등급별 최소 1명씩 보유(전 등급 GK 확보)", () => {
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

describe("players.v2 — ID/이름 유일성 + 실선수(로스터 일치)", () => {
  it(`ID가 P001..P${TOTAL} 순차·유일`, () => {
    const ids = players.map((p) => p.id);
    expect(new Set(ids).size).toBe(TOTAL);
    const expectedIds = Array.from(
      { length: TOTAL },
      (_, i) => `P${String(i + 1).padStart(3, "0")}`,
    );
    expect(ids).toEqual(expectedIds);
  });

  it("이름이 전부 유일", () => {
    const names = players.map((p) => p.name);
    expect(new Set(names).size).toBe(TOTAL);
  });

  it("실선수 이름(로스터 allowlist) — 생성 이름 = ROSTER 이름 (순서·값 일치)", () => {
    // v2는 실명 허용(이슈 #84). 이름은 큐레이션 로스터에서만 오고, 절차 생성 가상 이름이 아니다.
    expect(ROSTER.length).toBe(TOTAL);
    expect(players.map((p) => p.name)).toEqual(ROSTER.map((r) => r.name));
    const allow = new Set(ROSTER.map((r) => r.name));
    for (const p of players) expect(allow.has(p.name), `${p.id}:${p.name}`).toBe(true);
  });

  it("이름이 실선수 형태(라틴 문자 포함) — 구 가상 한글 3음절 패턴 아님", () => {
    for (const p of players) {
      expect(p.name, `${p.id} 라틴 문자 포함`).toMatch(/[A-Za-z]/);
      expect(p.name, `${p.id} 구 가상 패턴 아님`).not.toMatch(/^[가-힣]{3}$/);
    }
  });

  it("로스터 position/grade 가 생성 선수와 일치(파생 정합)", () => {
    players.forEach((p, i) => {
      expect(p.position).toBe(ROSTER[i].position);
      expect(p.grade).toBe(ROSTER[i].grade);
    });
  });

  it("한국 유명 선수 포함(hero 요청 #84) — 대표 선수 존재 + 등급 일치", () => {
    const byName = new Map(players.map((p) => [p.name, p]));
    for (const k of EXPECTED_KOREANS) {
      const p = byName.get(k.name);
      expect(p, `한국 선수 ${k.name} 존재`).toBeDefined();
      expect(p?.grade, `${k.name} 등급`).toBe(k.grade);
    }
  });
});

describe("players.v2 — 능력치 밴드 + trait 반영 (AC-PL1)", () => {
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

  it("각 선수의 trait 스탯이 밴드 내 상위(비trait 평균 이상) — 시그니처 반영", () => {
    // trait 는 +6 바이어스 대상. 개별 롤 편차가 있으므로 모집단(전체 trait vs 전체 비trait) 평균으로 검증.
    let traitSum = 0,
      traitN = 0,
      restSum = 0,
      restN = 0;
    players.forEach((p, i) => {
      const traits = new Set(ROSTER[i].traits as string[]);
      for (const key of ATTR_KEYS) {
        if (traits.has(key)) {
          traitSum += p.attributes[key];
          traitN++;
        } else {
          restSum += p.attributes[key];
          restN++;
        }
      }
    });
    expect(traitSum / traitN, "trait 평균 > 비trait 평균").toBeGreaterThan(restSum / restN);
  });
});

describe("players.v2 — zod PlayerCard 호환 (AC-PL1)", () => {
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

describe("economy.v2 — 스타터팩·확률표", () => {
  it("economy.version === 'v2'", () => {
    expect(economy.version).toBe("v2");
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
      expect(p, `starterPack id ${id} exists in players.v2`).toBeDefined();
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

  it("gacha 레전드 희소 — LEGEND rate ≤ DIA ≤ GOLD (희소성 반영)", () => {
    const r = economy.gacha.rates;
    expect(r.LEGEND).toBeLessThanOrEqual(r.DIA);
    expect(r.DIA).toBeLessThanOrEqual(r.GOLD);
  });

  it("rewards — 승500/무200/패100", () => {
    expect(economy.rewards).toEqual({ win: 500, draw: 200, loss: 100 });
  });
});

describe("economy.v2 — 성장/강화 config (#179 §7, additive)", () => {
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

  it("growth 블록 존재 + 스칼라 수치(hero 확정 C1~C6)", () => {
    const g = economy.growth;
    expect(g).toBeDefined();
    expect(g.xpBase).toBe(100);
    expect(g.xpPerLevel).toBe(300);
    expect(g.completeMatches).toBe(36);
    expect(g.benchGrowthMult).toBe(0.2);
    expect(g.execMatchDefault).toBe(0.6);
    expect(g.speedMaxMult).toBe(3.0);
  });

  it("baselineByPosition — 4포지션 전부 존재 · 9종 능력치 완비 · 각 값 양수", () => {
    const b = economy.growth.baselineByPosition;
    for (const pos of POSITIONS) {
      const vec = b[pos];
      expect(vec, `${pos} baseline 존재`).toBeDefined();
      const keys = Object.keys(vec).sort();
      expect(keys, `${pos} 능력치 9종`).toEqual([...ATTR_KEYS].sort());
      for (const k of ATTR_KEYS) {
        expect(vec[k], `${pos}.${k} > 0`).toBeGreaterThan(0);
      }
    }
  });

  it("각 baseline 벡터 합 = 1.0 (정규화)", () => {
    const b = economy.growth.baselineByPosition;
    for (const pos of POSITIONS) {
      const sum = ATTR_KEYS.reduce((s, k) => s + b[pos][k], 0);
      expect(sum, `${pos} 벡터 합=1`).toBeCloseTo(1, 10);
    }
  });

  it("포지션 주스탯이 성장 방향 최대치(baseline 최상위)", () => {
    // 성장 방향은 포지션 주스탯을 가장 크게 밀어야 한다(§4 방향 w).
    const b = economy.growth.baselineByPosition;
    const topOf = (pos: Position) =>
      ATTR_KEYS.reduce((best, k) => (b[pos][k] > b[pos][best] ? k : best), ATTR_KEYS[0]);
    expect(topOf("FW")).toBe("shooting");
    expect(topOf("MF")).toBe("passing");
    expect(topOf("DF")).toBe("tackling");
    expect(topOf("GK")).toBe("positioning");
  });

  it("enhance 블록 존재 + 수치(강화5/돌파3장/최대돌파4/비용200)", () => {
    const e = economy.enhance;
    expect(e).toBeDefined();
    expect(e.maxEnhance).toBe(5);
    expect(e.enhanceStep).toBe(2.0);
    expect(e.autoFillRatio).toBe(0.25);
    expect(e.limitBreakCopies).toBe(3);
    expect(e.maxLimitBreak).toBe(4);
    expect(e.pointCost).toBe(200);
  });

  it("불변식 — autoFillRatio ∈ (0,1) (과금은 cap↑·소량만 채움)", () => {
    expect(economy.enhance.autoFillRatio).toBeGreaterThan(0);
    expect(economy.enhance.autoFillRatio).toBeLessThan(1);
  });
});

describe("bots.v2 — 덱 유효성(서버 규칙: 11명·GK≥1·중복 금지)", () => {
  const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));

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
    for (const id of allIds) {
      expect(byId.get(id), `${botId} 선수 ${id} exists`).toBeDefined();
    }
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발에 GK 최소 1명", (botId) => {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) return;
    const gkCount = bot.deck.starters.filter((s) => byId.get(s.playerId)?.position === "GK")
      .length;
    expect(gkCount).toBeGreaterThanOrEqual(1);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])(
    "%s: DIA/LEGEND 미편성 — 상위 등급은 가챠 열망 카드로 예약",
    (botId) => {
      const bot = bots.find((b) => b.id === botId);
      if (!bot) return;
      const allIds = [...bot.deck.starters.map((s) => s.playerId), ...bot.deck.bench];
      for (const id of allIds) {
        const g = byId.get(id)!.grade;
        expect(RANK[g], `${botId} ${id} ${g} ≤ GOLD`).toBeLessThanOrEqual(RANK.GOLD);
      }
    },
  );

  it("BOT_ATK: FW 2명에 promptText('적극 침투') 부여", () => {
    const bot = bots.find((b) => b.id === "BOT_ATK");
    expect(bot).toBeDefined();
    if (!bot) return;
    const promptedFw = bot.deck.starters.filter(
      (s) => byId.get(s.playerId)?.position === "FW" && s.promptText === "적극 침투",
    );
    expect(promptedFw.length).toBe(2);
  });

  it("BOT_ATK: 미드필더/공격수가 GOLD 위주", () => {
    const bot = bots.find((b) => b.id === "BOT_ATK");
    expect(bot).toBeDefined();
    if (!bot) return;
    const mfFw = bot.deck.starters.filter((s) => {
      const pos = byId.get(s.playerId)?.position;
      return pos === "MF" || pos === "FW";
    });
    const goldUp = mfFw.filter((s) => RANK[byId.get(s.playerId)!.grade] >= RANK.GOLD);
    expect(goldUp.length).toBe(mfFw.length);
  });

  it("BOT_DEF: 수비수가 GOLD 위주", () => {
    const bot = bots.find((b) => b.id === "BOT_DEF");
    expect(bot).toBeDefined();
    if (!bot) return;
    const df = bot.deck.starters.filter((s) => byId.get(s.playerId)?.position === "DF");
    const goldUp = df.filter((s) => RANK[byId.get(s.playerId)!.grade] >= RANK.GOLD);
    expect(goldUp.length).toBe(df.length);
  });

  it("BOT_BAL: 등급 혼합·실버 중심(LLD §4) — SILVER 과반 + BRONZE≥1 + GOLD 1~2, DIA/LEGEND 없음", () => {
    const bot = bots.find((b) => b.id === "BOT_BAL");
    expect(bot).toBeDefined();
    if (!bot) return;
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

describe("players.v2.1 — personality 부여 (PRD-v3 P2-D7, additive)", () => {
  it(`v2.1 도 ${TOTAL}명 — v2 와 동일 개수`, () => {
    expect(playersV21.length).toBe(TOTAL);
  });

  it("v2.1 = v2 필드 완전 동일 + personality 만 additive(id/name/position/grade/attributes 무변경)", () => {
    playersV21.forEach((p, i) => {
      const base = players[i]!;
      expect(p.id).toBe(base.id);
      expect(p.name).toBe(base.name);
      expect(p.position).toBe(base.position);
      expect(p.grade).toBe(base.grade);
      expect(p.attributes).toEqual(base.attributes);
      // personality 를 뺀 나머지가 v2 와 정확히 같아야 한다(순수 additive).
      const { personality, ...rest } = p;
      expect(rest).toEqual(base);
      expect(personality).toBeDefined();
    });
  });

  it("모든 personality 가 4종 enum(FIERY/CALM/GLASS/AMBITIOUS) 내", () => {
    for (const p of playersV21) {
      expect(PERSONALITIES, `${p.id}:${p.name} personality`).toContain(p.personality);
    }
  });

  it("PERSONALITY 매핑 ↔ ROSTER 이름 전단사(bijection) — 누락/잉여 0", () => {
    const rosterNames = new Set(ROSTER.map((r) => r.name));
    const mapNames = new Set(Object.keys(PERSONALITY));
    // 모든 로스터 선수가 매핑을 가진다.
    for (const n of rosterNames) expect(mapNames.has(n), `매핑 누락: ${n}`).toBe(true);
    // 매핑에 로스터 밖 이름(오타 등)이 없다.
    for (const n of mapNames) expect(rosterNames.has(n), `로스터 밖 매핑 키: ${n}`).toBe(true);
    expect(mapNames.size).toBe(TOTAL);
  });

  it("분포가 목표 밴드 내 — 대략 FIERY25/CALM40/GLASS15/AMBITIOUS20 (%)", () => {
    const counts: Record<Personality, number> = { FIERY: 0, CALM: 0, GLASS: 0, AMBITIOUS: 0 };
    for (const p of playersV21) counts[p.personality]++;
    for (const k of PERSONALITIES) {
      const ratio = counts[k] / TOTAL;
      const [lo, hi] = PERSONALITY_BANDS[k];
      expect(ratio, `${k} 비율 ${(ratio * 100).toFixed(1)}% in [${lo * 100},${hi * 100}]%`).toBeGreaterThanOrEqual(lo);
      expect(ratio, `${k} 비율`).toBeLessThanOrEqual(hi);
    }
  });

  it("CALM 이 최다(기본 성격) — 나머지 3종보다 많다", () => {
    const counts: Record<Personality, number> = { FIERY: 0, CALM: 0, GLASS: 0, AMBITIOUS: 0 };
    for (const p of playersV21) counts[p.personality]++;
    expect(counts.CALM).toBeGreaterThan(counts.FIERY);
    expect(counts.CALM).toBeGreaterThan(counts.AMBITIOUS);
    expect(counts.CALM).toBeGreaterThan(counts.GLASS);
  });

  it("큐레이션 대표 선수 성격 고정(회귀 가드)", () => {
    const byName = new Map(playersV21.map((p) => [p.name, p.personality]));
    expect(byName.get("Toni Kroos")).toBe("CALM");
    expect(byName.get("Antonio Rüdiger")).toBe("FIERY");
    expect(byName.get("Marcus Rashford")).toBe("GLASS");
    expect(byName.get("Erling Haaland")).toBe("AMBITIOUS");
    expect(byName.get("Park Ji-sung")).toBe("AMBITIOUS");
    expect(byName.get("Son Heung-min")).toBe("CALM");
  });
});

describe("league.v1 — 봇 리그 시드(클럽명·성향·보상)", () => {
  it("version === 'v1'", () => {
    expect(league.version).toBe("v1");
  });

  it("가상 클럽명 20개+ · 전부 유일", () => {
    expect(league.clubNames.length).toBeGreaterThanOrEqual(20);
    expect(new Set(league.clubNames).size).toBe(league.clubNames.length);
    for (const n of league.clubNames) expect(n.trim().length).toBeGreaterThan(0);
  });

  it("실클럽 denylist — 어떤 클럽명도 실클럽 풀네임과 정확 일치하지 않음(대소문자 무시)", () => {
    const deny = new Set(REAL_CLUB_NAMES.map((n) => n.toLowerCase()));
    for (const n of league.clubNames) {
      expect(deny.has(n.toLowerCase()), `가상 클럽명 "${n}" 이 실클럽과 일치`).toBe(false);
    }
  });

  it("실클럽 고유 도시/식별 토큰 미포함(일반 접미사 제외) — 실명 유출 방지", () => {
    for (const n of league.clubNames) {
      for (const tok of REAL_CLUB_TOKENS) {
        expect(n.includes(tok), `클럽명 "${n}" 에 실클럽 토큰 "${tok}" 포함`).toBe(false);
      }
    }
  });

  it("팀 성향 프리셋 6종+ · id 유일 · tactics 4축 0..1", () => {
    expect(league.personaPresets.length).toBeGreaterThanOrEqual(6);
    const ids = league.personaPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of league.personaPresets) {
      expect(preset.name.length, `${preset.id} name`).toBeGreaterThan(0);
      expect(preset.description.length, `${preset.id} description`).toBeGreaterThan(0);
      expect(preset.formation.length, `${preset.id} formation`).toBeGreaterThan(0);
      for (const axis of ["line", "press", "tempo", "width"] as const) {
        const v = preset.tactics[axis];
        expect(v, `${preset.id}.${axis}`).toBeGreaterThanOrEqual(0);
        expect(v, `${preset.id}.${axis}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("순위 보상표 — rank 1..10 연속 · 포인트 단조 감소 · 전원 양수", () => {
    expect(league.rewards.length).toBe(10);
    league.rewards.forEach((r, i) => {
      expect(r.rank, `보상[${i}].rank`).toBe(i + 1);
      expect(r.points, `rank ${r.rank} points>0`).toBeGreaterThan(0);
      if (i > 0) {
        expect(r.points, `rank ${r.rank} < rank ${i}`).toBeLessThan(league.rewards[i - 1]!.points);
      }
    });
  });
});

describe("economy.v2 — 트레이드 수치(P2-D9 / LLD-p2-server §5)", () => {
  const t = economy.trade;

  it("슬롯 3 · kindWeights 합=1", () => {
    expect(t.slots).toBe(3);
    expect(t.kindWeights.FA + t.kindWeights.TRADE).toBeCloseTo(1, 10);
  });

  it("레어도별 대기시간 — BRONZE1/SILVER6/GOLD24/DIA48/LEGEND72 (h)", () => {
    expect(t.waitHours).toEqual({ BRONZE: 1, SILVER: 6, GOLD: 24, DIA: 48, LEGEND: 72 });
  });

  it("대기시간 단조 증가 — 레어도 높을수록 길다", () => {
    const order: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];
    for (let i = 1; i < order.length; i++) {
      expect(t.waitHours[order[i]!]).toBeGreaterThan(t.waitHours[order[i - 1]!]);
    }
  });

  it("target 레어도 가중 합=1 · 전부 양수 · 저등급이 더 흔함", () => {
    const w = t.targetRarityWeights;
    const sum = (Object.values(w) as number[]).reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 10);
    for (const g of GRADES) expect(w[g], `${g} weight>0`).toBeGreaterThan(0);
    expect(w.LEGEND).toBeLessThan(w.DIA);
    expect(w.DIA).toBeLessThan(w.GOLD);
  });

  it("단축 비용 계수 — pointsPerHour>0, minPoints>0 (잔여시간 비례, AC-D4)", () => {
    expect(t.speedup.pointsPerHour).toBeGreaterThan(0);
    expect(t.speedup.minPoints).toBeGreaterThan(0);
  });

  it("FA 확률 곡선 — base/k 범위 · minProb<maxProb · 쿨타임>0 (AC-D2)", () => {
    expect(t.fa.base).toBeGreaterThanOrEqual(0);
    expect(t.fa.base).toBeLessThanOrEqual(1);
    expect(t.fa.k).toBeGreaterThan(0);
    expect(t.fa.minProb).toBeGreaterThanOrEqual(0);
    expect(t.fa.maxProb).toBeLessThanOrEqual(1);
    expect(t.fa.minProb).toBeLessThan(t.fa.maxProb);
    expect(t.fa.reproposalCooldownHours).toBeGreaterThan(0);
  });

  it("TRADE 수락 확률 = 0.8 (AC-D3) · 0..1", () => {
    expect(t.tradeOffer.acceptProb).toBe(0.8);
    expect(t.tradeOffer.acceptProb).toBeGreaterThan(0);
    expect(t.tradeOffer.acceptProb).toBeLessThanOrEqual(1);
  });

  it("가치함수 — 등급 기본값 단조 증가 · attrSumCoeff>0", () => {
    const v = t.value;
    const order: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];
    for (let i = 1; i < order.length; i++) {
      expect(v.byGrade[order[i]!], `${order[i]} value`).toBeGreaterThan(v.byGrade[order[i - 1]!]);
    }
    expect(v.attrSumCoeff).toBeGreaterThan(0);
  });

  it("리그 보상 참조 — league.v1.json#rewards 를 가리킨다(단일 원천)", () => {
    expect(economy.league.rewardsFile).toBe("league.v1.json");
    expect(economy.league.rewardsRef).toBe("rewards");
  });
});

describe("발행 파일 동기화 — v2 파일 = generateAll() 직렬화 결과", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases: readonly [string, unknown][] = [
    ["players.v2.json", players],
    ["players.v2.1.json", playersV21],
    ["economy.v2.json", economy],
    ["bots.v2.json", bots],
    ["league.v1.json", league],
  ];

  it.each(cases)("%s 가 디스크에서 바이트 동일(수정·재생성 누락 검출)", (file, data) => {
    const onDisk = readFileSync(join(here, file as string), "utf8");
    expect(onDisk).toBe(JSON.stringify(data, null, 2) + "\n");
  });
});

describe("재생성 결정론 (AC-PL1)", () => {
  it("generateAll()을 두 번 호출하면 바이트(JSON.stringify) 동일", () => {
    const a = generateAll();
    const b = generateAll();
    expect(JSON.stringify(a.players, null, 2)).toBe(JSON.stringify(b.players, null, 2));
    expect(JSON.stringify(a.playersV21, null, 2)).toBe(JSON.stringify(b.playersV21, null, 2));
    expect(JSON.stringify(a.economy, null, 2)).toBe(JSON.stringify(b.economy, null, 2));
    expect(JSON.stringify(a.bots, null, 2)).toBe(JSON.stringify(b.bots, null, 2));
    expect(JSON.stringify(a.league, null, 2)).toBe(JSON.stringify(b.league, null, 2));
  });
});
