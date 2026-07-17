/**
 * generate.ts — 선수·경제·봇 시드 데이터 결정론 생성기.
 *
 * 실행: `npx tsx data/players/generate.ts` (players.v1.json / economy.v1.json / bots.v1.json 재생성)
 * 결정론(AC-D2): SEED 고정 + 시드 RNG만 사용(Math.random/Date.now 금지) — 재실행 바이트 동일.
 *
 * 순서: 이 파일을 import 만 해도(부수효과 없음) `generateAll()`을 호출해 세 산출물을 순수 계산할
 * 수 있다. 파일 쓰기는 CLI로 직접 실행했을 때만 일어난다(맨 아래 entrypoint 가드).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRng } from "./rng";
import { nextUniqueName } from "./names";

/** 생성 결정론 시드(LLD-data §2). 절대 변경 금지 — 바꾸면 v2 발행 대상. */
export const SEED = "hmb-players-v1";

export type Position = "GK" | "DF" | "MF" | "FW";
export type Grade = "BRONZE" | "SILVER" | "GOLD" | "DIA" | "LEGEND";

export interface PlayerAttributes {
  technical: number;
  mental: number;
  physical: number;
  passing: number;
  shooting: number;
  tackling: number;
  pace: number;
  stamina: number;
  positioning: number;
}

export interface PlayerSeed {
  id: string;
  name: string;
  position: Position;
  grade: Grade;
  attributes: PlayerAttributes;
}

const ATTR_KEYS: readonly (keyof PlayerAttributes)[] = [
  "technical",
  "mental",
  "physical",
  "passing",
  "shooting",
  "tackling",
  "pace",
  "stamina",
  "positioning",
];

const POSITIONS: readonly Position[] = ["GK", "DF", "MF", "FW"];
const GRADES: readonly Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];

/** 포지션 총원 (LLD §2). 합계 110. */
const POSITION_TOTALS: Record<Position, number> = { GK: 12, DF: 36, MF: 36, FW: 26 };

/** 등급 총원 (LLD §2). 합계 110. */
const GRADE_TOTALS: Record<Grade, number> = {
  BRONZE: 40,
  SILVER: 30,
  GOLD: 20,
  DIA: 14,
  LEGEND: 6,
};

/**
 * 포지션×등급 분포 행렬 — "비례 배분, GK는 등급별 최소 1" (LLD §2).
 *
 * 유도: 행(포지션)마다 등급 비중(40/30/20/14/6 / 110)에 largest-remainder 방법으로 반올림
 * 배분 → 열(등급) 합이 GRADE_TOTALS 와 어긋나는 만큼(BRONZE -1 / GOLD -1 / DIA +1 / LEGEND +1)을
 * 행 합을 보존하며 DF 행 내부에서 재배분(DIA→BRONZE +1, LEGEND→GOLD +1)해 양쪽 합을 정확히
 * 맞췄다. GK 행은 largest-remainder 결과 자체로 이미 등급별 ≥1 을 만족한다.
 * 행 합계 = POSITION_TOTALS, 열 합계 = GRADE_TOTALS 를 data.test.ts 가 기계 검증한다.
 */
const DISTRIBUTION: Record<Position, Record<Grade, number>> = {
  GK: { BRONZE: 4, SILVER: 3, GOLD: 2, DIA: 2, LEGEND: 1 },
  DF: { BRONZE: 14, SILVER: 10, GOLD: 7, DIA: 4, LEGEND: 1 },
  MF: { BRONZE: 13, SILVER: 10, GOLD: 6, DIA: 5, LEGEND: 2 },
  FW: { BRONZE: 9, SILVER: 7, GOLD: 5, DIA: 3, LEGEND: 2 },
};

/** 등급별 능력치 밴드 [min, max] (LLD §2). */
export const GRADE_BANDS: Record<Grade, readonly [number, number]> = {
  BRONZE: [40, 55],
  SILVER: [50, 65],
  GOLD: [60, 75],
  DIA: [70, 85],
  LEGEND: [80, 95],
};

/** 포지션 주스탯(밴드 상한 클램프 +5 바이어스 대상) (LLD §2). */
export const PRIMARY_STATS: Record<Position, readonly (keyof PlayerAttributes)[]> = {
  GK: ["positioning", "mental"],
  DF: ["tackling", "positioning"],
  MF: ["passing", "stamina"],
  FW: ["shooting", "pace"],
};

/** 등급 랭크(낮을수록 낮은 등급) — 봇 덱 선별 등에 사용. */
export const GRADE_RANK: Record<Grade, number> = {
  BRONZE: 0,
  SILVER: 1,
  GOLD: 2,
  DIA: 3,
  LEGEND: 4,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 시드 RNG로 한 선수의 능력치 9종을 굴린다(등급 밴드 + 포지션 주스탯 +5 클램프). */
function rollAttributes(
  rng: ReturnType<typeof createRng>,
  grade: Grade,
  position: Position,
): PlayerAttributes {
  const [lo, hi] = GRADE_BANDS[grade];
  const attrs = {} as PlayerAttributes;
  for (const key of ATTR_KEYS) {
    attrs[key] = lo + rng.nextInt(hi - lo + 1);
  }
  for (const key of PRIMARY_STATS[position]) {
    attrs[key] = clamp(attrs[key] + 5, lo, hi);
  }
  return attrs;
}

export interface EconomySeed {
  version: string;
  initialPoints: number;
  starterPack: string[];
  gacha: {
    singleCost: number;
    tenCost: number;
    tenCount: number;
    rates: Record<Grade, number>;
    tenPityMinGrade: Grade;
  };
  rewards: { win: number; draw: number; loss: number };
}

export interface BotDeckStarter {
  playerId: string;
  slotIndex: number;
  promptText?: string;
}

export interface BotSeed {
  id: string;
  name: string;
  persona: string;
  analysisText: string;
  deck: {
    formation: string;
    starters: BotDeckStarter[];
    bench: string[];
  };
}

/** 필터에 맞는 선수를 id 순서(=생성 순서)로 n명 뽑는다. exclude 는 이미 뽑힌 선수 id 집합. */
function pickPlayers(
  players: PlayerSeed[],
  opts: {
    position?: Position;
    minRank?: number;
    maxRank?: number;
    count: number;
    exclude: Set<string>;
  },
): PlayerSeed[] {
  const { position, minRank = 0, maxRank = 4, count, exclude } = opts;
  const picked: PlayerSeed[] = [];
  for (const p of players) {
    if (picked.length >= count) break;
    if (exclude.has(p.id)) continue;
    if (position && p.position !== position) continue;
    const rank = GRADE_RANK[p.grade];
    if (rank < minRank || rank > maxRank) continue;
    picked.push(p);
    exclude.add(p.id);
  }
  if (picked.length < count) {
    throw new Error(
      `pickPlayers: 요청 ${count}명, 확보 ${picked.length}명 (position=${position ?? "any"}, rank=${minRank}..${maxRank})`,
    );
  }
  return picked;
}

/** 선발 구성 그룹 — position 에서 등급 랭크 범위로 count 명. 그룹 순서 = 슬롯 순서. */
interface StarterGroup {
  position: Position;
  count: number;
  minRank: number;
  maxRank: number;
}

function buildBotDeck(
  players: PlayerSeed[],
  spec: {
    /** 합계 11명(GK 포함). 등급 혼합은 같은 포지션 그룹을 여러 개 두면 된다(LLD §4 BOT_BAL). */
    starterGroups: StarterGroup[];
    fwPromptCount: number;
    fwPromptText: string;
    benchMinRank: number;
    benchMaxRank: number;
  },
): BotSeed["deck"] {
  const used = new Set<string>();
  const startersOrder: PlayerSeed[] = [];
  for (const g of spec.starterGroups) {
    startersOrder.push(
      ...pickPlayers(players, {
        position: g.position,
        minRank: g.minRank,
        maxRank: g.maxRank,
        count: g.count,
        exclude: used,
      }),
    );
  }
  if (startersOrder.length !== 11) {
    throw new Error(`buildBotDeck: 선발은 11명이어야 함 (현재 ${startersOrder.length})`);
  }
  let fwPromptsAssigned = 0;
  const starters: BotDeckStarter[] = startersOrder.map((p, slotIndex) => {
    const entry: BotDeckStarter = { playerId: p.id, slotIndex };
    if (p.position === "FW" && fwPromptsAssigned < spec.fwPromptCount) {
      entry.promptText = spec.fwPromptText;
      fwPromptsAssigned++;
    }
    return entry;
  });

  const benchGk = pickPlayers(players, {
    position: "GK",
    minRank: spec.benchMinRank,
    maxRank: spec.benchMaxRank,
    count: 1,
    exclude: used,
  });
  const benchDf = pickPlayers(players, {
    position: "DF",
    minRank: spec.benchMinRank,
    maxRank: spec.benchMaxRank,
    count: 1,
    exclude: used,
  });
  const benchMf = pickPlayers(players, {
    position: "MF",
    minRank: spec.benchMinRank,
    maxRank: spec.benchMaxRank,
    count: 1,
    exclude: used,
  });
  const benchFw = pickPlayers(players, {
    position: "FW",
    minRank: spec.benchMinRank,
    maxRank: spec.benchMaxRank,
    count: 1,
    exclude: used,
  });
  const bench = [...benchGk, ...benchDf, ...benchMf, ...benchFw].map((p) => p.id);

  return { formation: "", starters, bench };
}

export interface GeneratedData {
  players: PlayerSeed[];
  economy: EconomySeed;
  bots: BotSeed[];
}

/** 순수 함수 — SEED 로부터 세 산출물을 계산한다(부수효과 없음, 파일 I/O 없음). */
export function generateAll(): GeneratedData {
  const rng = createRng(SEED);
  const used = new Set<string>();
  const players: PlayerSeed[] = [];
  let seq = 1;

  for (const position of POSITIONS) {
    for (const grade of GRADES) {
      const count = DISTRIBUTION[position][grade];
      for (let i = 0; i < count; i++) {
        const id = `P${String(seq).padStart(3, "0")}`;
        seq++;
        const name = nextUniqueName(rng, used);
        const attributes = rollAttributes(rng, grade, position);
        players.push({ id, name, position, grade, attributes });
      }
    }
  }

  // -- economy.v1.json --------------------------------------------------
  const starterExclude = new Set<string>();
  const starterGk = pickPlayers(players, {
    position: "GK",
    minRank: 0,
    maxRank: 1,
    count: 1,
    exclude: starterExclude,
  });
  const starterDf = pickPlayers(players, {
    position: "DF",
    minRank: 0,
    maxRank: 1,
    count: 5,
    exclude: starterExclude,
  });
  const starterMf = pickPlayers(players, {
    position: "MF",
    minRank: 0,
    maxRank: 1,
    count: 5,
    exclude: starterExclude,
  });
  const starterFw = pickPlayers(players, {
    position: "FW",
    minRank: 0,
    maxRank: 1,
    count: 3,
    exclude: starterExclude,
  });
  const starterPack = [...starterGk, ...starterDf, ...starterMf, ...starterFw].map((p) => p.id);

  const economy: EconomySeed = {
    version: "v1",
    initialPoints: 3000,
    starterPack,
    gacha: {
      singleCost: 300,
      tenCost: 3000,
      tenCount: 11,
      rates: { BRONZE: 0.45, SILVER: 0.3, GOLD: 0.15, DIA: 0.08, LEGEND: 0.02 },
      tenPityMinGrade: "GOLD",
    },
    rewards: { win: 500, draw: 200, loss: 100 },
  };

  // -- bots.v1.json -------------------------------------------------------
  // BOT_ATK 공격형 — FW/MF 골드↑ 위주 (LLD §4)
  const botAtkDeck = buildBotDeck(players, {
    starterGroups: [
      { position: "GK", count: 1, minRank: 0, maxRank: 4 },
      { position: "DF", count: 4, minRank: 0, maxRank: 4 },
      { position: "MF", count: 3, minRank: 2, maxRank: 4 },
      { position: "FW", count: 3, minRank: 2, maxRank: 4 },
    ],
    fwPromptCount: 2,
    fwPromptText: "적극 침투",
    benchMinRank: 0,
    benchMaxRank: 4,
  });
  botAtkDeck.formation = "4-3-3";

  // BOT_DEF 수비형 — DF 골드↑ 위주 (LLD §4)
  const botDefDeck = buildBotDeck(players, {
    starterGroups: [
      { position: "GK", count: 1, minRank: 0, maxRank: 4 },
      { position: "DF", count: 5, minRank: 2, maxRank: 4 },
      { position: "MF", count: 3, minRank: 0, maxRank: 4 },
      { position: "FW", count: 2, minRank: 0, maxRank: 4 },
    ],
    fwPromptCount: 0,
    fwPromptText: "",
    benchMinRank: 0,
    benchMaxRank: 4,
  });
  botDefDeck.formation = "5-3-2";

  // BOT_BAL 밸런스 — 등급 혼합·실버 중심 (LLD §4): BRONZE 2 + SILVER 8 + GOLD 1.
  // 스타터 팩(브론즈~실버)과 비등 — 첫 승리 가능하도록 골드는 1명만.
  const botBalDeck = buildBotDeck(players, {
    starterGroups: [
      { position: "GK", count: 1, minRank: 1, maxRank: 1 },
      { position: "DF", count: 2, minRank: 0, maxRank: 0 },
      { position: "DF", count: 2, minRank: 1, maxRank: 1 },
      { position: "MF", count: 4, minRank: 1, maxRank: 1 },
      { position: "FW", count: 1, minRank: 1, maxRank: 1 },
      { position: "FW", count: 1, minRank: 2, maxRank: 2 },
    ],
    fwPromptCount: 0,
    fwPromptText: "",
    benchMinRank: 0,
    benchMaxRank: 1,
  });
  botBalDeck.formation = "4-4-2";

  const bots: BotSeed[] = [
    {
      id: "BOT_ATK",
      name: "레드 스톰",
      persona: "하이라인·강한 압박·빠른 템포로 공격적으로",
      analysisText:
        "공격적인 팀. 하이라인과 강한 압박으로 빠른 템포를 유지하며, 골드 이상 등급의 미드필더·공격수가 " +
        "적극적으로 침투한다. 뒷공간을 노리는 빠른 역습에 취약할 수 있다.",
      deck: botAtkDeck,
    },
    {
      id: "BOT_DEF",
      name: "블루 월",
      persona: "로우블록·역습·안전한 패스",
      analysisText:
        "수비적인 팀. 로우블록으로 진영을 낮게 유지하다 빠른 역습을 노린다. 골드 이상 등급의 " +
        "수비진이 두껍고 패스는 안전 위주 — 측면 크로스나 지공 상황에서 빈틈을 찾아야 한다.",
      deck: botDefDeck,
    },
    {
      id: "BOT_BAL",
      name: "그린 밸런스",
      persona: "균형 잡힌 점유율 축구",
      analysisText:
        "실버 등급 중심의 균형 잡힌 팀. 특정 강점 없이 고르게 점유율 축구를 구사한다 — " +
        "초기 스타터 팩 수준의 덱으로도 충분히 승산이 있다.",
      deck: botBalDeck,
    },
  ];

  return { players, economy, bots };
}

// -- CLI entrypoint (파일로 실행됐을 때만 쓰기 수행) -----------------------
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { players, economy, bots } = generateAll();
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(here, "players.v1.json"), JSON.stringify(players, null, 2) + "\n");
  writeFileSync(join(here, "economy.v1.json"), JSON.stringify(economy, null, 2) + "\n");
  writeFileSync(join(here, "bots.v1.json"), JSON.stringify(bots, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(
    `generated ${players.length} players, economy.v1.json, ${bots.length} bots -> data/players/`,
  );
}
