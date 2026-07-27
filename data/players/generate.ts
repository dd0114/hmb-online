/**
 * generate.ts — 선수·경제·봇 시드 데이터 결정론 생성기 (v2 = 실선수).
 *
 * 실행: `npx tsx data/players/generate.ts` (players.v2.json / economy.v2.json / bots.v2.json 재생성)
 * 결정론(AC-D2): SEED 고정 + 시드 RNG만 사용(Math.random/Date.now 금지) — 재실행 바이트 동일.
 *
 * v2(이슈 #84): 이름·포지션·등급은 큐레이션 로스터(`roster.ts`, 실선수 150명)에서 오고,
 * 능력치 9종만 시드 RNG로 등급 밴드 내에서 결정론 파생한다(포지션 주스탯 +5, trait +6, 밴드 클램프).
 * ⚠️ 실명 사용 — 상용화 전 라이선스 해결 필수(백로그, data/CLAUDE.md·PRD-v2 D4 참조).
 *
 * 순서: 이 파일을 import 만 해도(부수효과 없음) `generateAll()`을 호출해 세 산출물을 순수 계산할
 * 수 있다. 파일 쓰기는 CLI로 직접 실행했을 때만 일어난다(맨 아래 entrypoint 가드).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRng } from "./rng";
import { ROSTER } from "./roster";
import { PERSONALITY } from "./personality";

/** 생성 결정론 시드. 절대 변경 금지 — 바꾸면 새 버전 발행 대상. */
export const SEED = "hmb-players-v2";

/** 발행 버전 태그(파일명·economy.version). */
export const DATA_VERSION = "v2";

/** players 성격 부여 버전(additive, PRD-v3 P2-D7). players.v2 위에 personality 만 추가. */
export const PLAYERS_V21_VERSION = "v2.1";

/** league 시드 데이터 버전(봇 클럽명·성향 프리셋·순위 보상). */
export const LEAGUE_VERSION = "v1";

export type Position = "GK" | "DF" | "MF" | "FW";
export type Grade = "BRONZE" | "SILVER" | "GOLD" | "DIA" | "LEGEND";
/** 선수 성격 4종 (PRD-v3 P2-D7 / ERD-v2 players.personality enum). */
export type Personality = "FIERY" | "CALM" | "GLASS" | "AMBITIOUS";

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

/**
 * players.v2.1 = players.v2 에 personality 만 **뒤에 덧붙인** additive 확장.
 * id/name/position/grade/attributes 는 v2 와 바이트 동일(같은 시드 파생) — personality 만 추가.
 */
export interface PlayerSeedV21 extends PlayerSeed {
  personality: Personality;
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

/** trait 시그니처 능력치 바이어스(+, 밴드 상한 클램프). */
const TRAIT_BIAS = 6;

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

/**
 * 시드 RNG로 한 선수의 능력치 9종을 굴린다.
 * 등급 밴드 내 균등 롤 → 포지션 주스탯 +5 → 개인 trait +6 (모두 밴드 상한 클램프).
 * RNG 소비는 base 롤 9회뿐 — 바이어스는 순수 결정론 가산이라 재현 바이트 동일.
 */
function rollAttributes(
  rng: ReturnType<typeof createRng>,
  grade: Grade,
  position: Position,
  traits: readonly (keyof PlayerAttributes)[],
): PlayerAttributes {
  const [lo, hi] = GRADE_BANDS[grade];
  const attrs = {} as PlayerAttributes;
  for (const key of ATTR_KEYS) {
    attrs[key] = lo + rng.nextInt(hi - lo + 1);
  }
  for (const key of PRIMARY_STATS[position]) {
    attrs[key] = clamp(attrs[key] + 5, lo, hi);
  }
  for (const key of traits) {
    attrs[key] = clamp(attrs[key] + TRAIT_BIAS, lo, hi);
  }
  return attrs;
}

/**
 * 트레이드 수치 (PRD-v3 P2-D9 / LLD-p2-server §5). 서버(server-java)는 이 블록만 읽는다 — 하드코딩 금지.
 * - waitHours: 레어도별 오퍼 공개 대기시간(h). BRONZE 1 ~ LEGEND 72 (AC-D1).
 * - kindWeights: 오퍼 종류 FA/TRADE 가중(합=1). §5 "kind 50/50".
 * - targetRarityWeights: 등장 대상 선수의 레어도 가중(합=1). §5 "target 레어도 가중".
 * - speedup: 대기 단축 비용 = ceil(잔여h × pointsPerHour), 최소 minPoints (AC-D4 잔여시간 비례).
 * - fa: FA 성공 확률 p = clamp(base + k×(offerValue/targetValue − 1), minProb, maxProb) (AC-D2).
 *       reproposalCooldownHours = 실패 후 재제안 쿨타임.
 * - tradeOffer.acceptProb: TRADE 수락 시 성공 확률(AC-D3, 예 0.8).
 * - value: 가치함수 = byGrade[등급] + (능력치 9종 합) × attrSumCoeff (§8 문서화). offerValue/targetValue 계산에 사용.
 */
export interface TradeConfig {
  slots: number;
  kindWeights: { FA: number; TRADE: number };
  waitHours: Record<Grade, number>;
  targetRarityWeights: Record<Grade, number>;
  speedup: { pointsPerHour: number; minPoints: number };
  fa: {
    base: number;
    k: number;
    minProb: number;
    maxProb: number;
    reproposalCooldownHours: number;
  };
  tradeOffer: { acceptProb: number };
  value: { byGrade: Record<Grade, number>; attrSumCoeff: number };
}

/** 리그 보상 참조 — 실 보상표는 league.v1.json#rewards (LLD-p2-data §3 "리그 보상 참조"). */
export interface EconomyLeagueRef {
  rewardsFile: string;
  rewardsRef: string;
  /**
   * #212: 리그 상위 입상 젬 보상. `maxRank` 이내 순위에만 `[min, max]` 균등 랜덤 지급
   * (서버가 시즌 seed 로 결정론 추출 — `Math.random` 금지). hero 확정 "우승 시에만".
   */
  gemReward: { maxRank: number; min: number; max: number };
}

/** 능력치 9종 성장 방향 벡터(합=1, 정규화). §4 방향 w 의 포지션 baseline. */
export interface GrowthBaselineVec {
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

/** 이벤트→스탯 XP 가중 (v2 §7 eventStatMap). match-log 이벤트 타입별 스탯 가산치. */
export type EventStatBonus = Partial<Record<keyof PlayerAttributes, number>>;

/**
 * 스탯 성장(경기·무과금 트랙) config — 매치 정산 스탯별 xp·레벨 임계·방향.
 * #179 V2 스펙(issues/2026-07-26-growth-dual-track.md V2-5) — 구 enhance/growth(강화·complete
 * Matches 등)는 메이플 피벗으로 폐기, 이 블록이 대체한다(하드코딩 금지 — server/servants 는
 * 이 블록만 읽는다).
 */
export interface GrowthConfig {
  xpBase: number;
  xpLvBase: number;
  xpLvGrowth: number;
  gradeXpMult: Record<Grade, number>;
  minutesMult: { starter: number; partial: number; bench: number };
  /** 포지션별 성장 방향 baseline(각 벡터 합=1). */
  baselineByPosition: Record<Position, GrowthBaselineVec>;
  /** match-log 이벤트 타입 → 스탯 가중(§B①, "헤딩 노림→heading류" 세분화 훅). */
  eventStatMap: Record<string, EventStatBonus>;
}

/** 성(★, 중복 승급) config — 구 한계돌파 개칭·확장. V2-5 `star` 블록. */
export interface StarConfig {
  /** ★승급에 필요한 중복 소모량(누진) — 2★=2장 / 3★=3장 / 4★=5장. */
  copies: Record<"2" | "3" | "4", number>;
  /** ★별 스탯 성장 천장 개방 비율 — cap_i(star) = base_i + starFrac × (band.hi − base_i). */
  starFrac: Record<"1" | "2" | "3" | "4", number>;
}

export type PotentialTier = "RARE" | "EPIC" | "UNIQUE";
export type PotentialOptionType = "STAT_PCT" | "STAT_FLAT" | "CONDITION_RECOVERY" | "TEAM_MORALE";

/**
 * 잠재능력 옵션 풀 항목 (티어별 테이블 1행). `premium`=해당 (type,stat) 범위의 상위값 —
 * 캐시 다이스는 이 옵션들의 weight 에 `potential.cashPremiumMult` 를 곱해 좋은 옵션 확률을 올린다
 * (구현 단순화 택1 — RATIONALE: issues/2026-07-26-growth-dual-track.md V2-2 참고).
 */
export interface PotentialOption {
  type: PotentialOptionType;
  /** STAT_PCT/STAT_FLAT 에서만 사용. */
  stat?: keyof PlayerAttributes;
  value: number;
  weight: number;
  premium: boolean;
}

/** 잠재능력(다이스) config — 메이플 이식. V2-5 `potential` 블록. */
export interface PotentialConfig {
  /** 등급별 잠재 줄 수 — 브/실 1 · 골 2 · 다/레 3. */
  linesByGrade: Record<Grade, number>;
  /** 등급 캡 — 티어 상한(min(등급 캡, 성 캡) 중 등급 쪽). */
  gradeTierCap: Record<Grade, PotentialTier>;
  /** 성 캡 — 2★=레어 / 3★=에픽 / 4★=유니크. */
  starTierCap: Record<"2" | "3" | "4", PotentialTier>;
  /** 티어 승급 확률(노말 다이스만). */
  tierUp: { rareToEpic: number; epicToUnique: number };
  /** 천장 배수(기댓값 대비) — ceil(ceilingMult / p) 회 미승급 시 확정 승급. */
  ceilingMult: number;
  /** 캐시 다이스가 premium 옵션 weight 에 곱하는 배수(하드코딩 금지 — config화). */
  cashPremiumMult: number;
  /** 티어별 옵션 풀. */
  tables: Record<PotentialTier, PotentialOption[]>;
}

/** 다이스(큐브 아날로그) 상점 비용. V2-5 `dice` 블록, V2.2 재화 이원화로 캐시 다이스는 젬 결제로 개정
 * (`cashCost` P 결제 폐기 → `cashGemCost` 젬 결제). */
export interface DiceConfig {
  normalCost: number;
  cashGemCost: number;
}

/** 젬 충전(목업) 팩 1개. */
export interface GemTopupPack {
  id: string;
  gems: number;
  mockPrice: string;
}

/** V2.2 재화 이원화: 충전형 젬 상점 config(`gems` 블록). */
export interface GemsConfig {
  /**
   * #212: 목업 충전 수도꼭지 스위치. 뽑기가 젬 결제로 바뀐 뒤 무제한 무료 충전이 살아있으면
   * 경제가 붕괴하므로 기본 false. 실결제가 붙을 때 다시 연다.
   */
  topupEnabled: boolean;
  topupPacks: GemTopupPack[];
}

/** 승/무/패 지급액 한 벌. */
export interface RewardTable {
  win: number;
  draw: number;
  loss: number;
}

export interface EconomySeed {
  version: string;
  initialPoints: number;
  /** #212: 가입 시 지급하는 젬. 젬 수급원은 이것 + 리그 우승 둘뿐(목업 충전 폐지). */
  initialGems: number;
  starterPack: string[];
  gacha: {
    /** #212: 뽑기 결제 재화. hero 확정 "뽑기 = 젬(유료 재화)". */
    currency: "POINT" | "GEM";
    singleCost: number;
    tenCost: number;
    tenCount: number;
    rates: Record<Grade, number>;
    tenPityMinGrade: Grade;
  };
  /**
   * 매치 승/무/패 보상. flat 값은 레거시 폴백이고, 실제 지급은 `byMode[매치모드]` 가 결정한다(#212)
   * — hero 목표 곡선 "연습 적게 &lt; 리그 매판 적당 &lt; 리그 최종성적 가파르게".
   */
  rewards: RewardTable & { byMode: { practice: RewardTable; league: RewardTable } };
  /** P2 추가(additive): 트레이드 수치. */
  trade: TradeConfig;
  /** P2 추가(additive): 리그 보상표 참조. */
  league: EconomyLeagueRef;
  /** #179 추가(additive), V2 메이플 피벗으로 개정: 스탯 성장(경기·무과금 트랙) config. */
  growth: GrowthConfig;
  /** V2 신규: 성(★, 중복 승급) config. */
  star: StarConfig;
  /** V2 신규: 잠재능력(다이스) config. */
  potential: PotentialConfig;
  /** V2 신규: 다이스 상점 비용. */
  dice: DiceConfig;
  /** V2.2 신규(additive): 충전형 젬 상점(목업). */
  gems: GemsConfig;
}

/** 팀 성향 프리셋 — 봇 팀 성격 + 유저 수동 전술 프리셋(P2-D4/D10). tactics 는 0..1 (line/press/tempo/width). */
export interface LeaguePersonaPreset {
  id: string;
  name: string;
  description: string;
  formation: string;
  tactics: { line: number; press: number; tempo: number; width: number };
}

/** 순위별 리그 보상(포인트) — 시즌 종료 정산 (AC-F4, config). */
export interface LeagueReward {
  rank: number;
  points: number;
}

/** league.v1.json — 봇 클럽명 풀·성향 프리셋·순위 보상표 (LLD-p2-data §2). */
export interface LeagueSeed {
  version: string;
  /** 가상 클럽명 풀(실클럽명 금지, denylist 테스트). 봇 9팀 이름 시드 배정 원천. */
  clubNames: string[];
  /** 팀 성향 프리셋 6종+. */
  personaPresets: LeaguePersonaPreset[];
  /** 순위별 포인트 보상(10팀, rank 1..10). */
  rewards: LeagueReward[];
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
  /** players.v2 + personality (additive, players.v2.1.json). */
  playersV21: PlayerSeedV21[];
  economy: EconomySeed;
  bots: BotSeed[];
  /** league.v1.json — 봇 클럽명·성향 프리셋·순위 보상. */
  league: LeagueSeed;
}

/** players.v2 에 personality(이름 조회)를 뒤에 덧붙여 v2.1 을 만든다. 매핑 누락은 즉시 에러(결정론·완전성). */
function buildPlayersV21(players: PlayerSeed[]): PlayerSeedV21[] {
  return players.map((p) => {
    const personality = PERSONALITY[p.name];
    if (!personality) {
      throw new Error(`personality 매핑 누락: ${p.id}:${p.name} (data/players/personality.ts)`);
    }
    // v2 필드 순서 유지 + personality 를 마지막에 추가(순수 additive).
    return { ...p, personality };
  });
}

/**
 * league.v1.json — 정적 큐레이션 시드(봇 리그, PRD-v3 P2-D10 / LLD-p2-data §2 / LLD-p2-server §6).
 * 결정론: RNG 미사용(순수 상수). 봇 팀명은 이 풀에서 시즌 시드로 배정(server-java).
 */
function buildLeague(): LeagueSeed {
  // 가상 클럽명 24개 — 실클럽명 금지(색상·자연물 조합, 기존 봇명 "레드 스톰" 톤 계승). denylist 테스트가 가드.
  const clubNames = [
    "Ironclad FC",
    "Crimson Vanguard",
    "Azure Sentinels",
    "Emerald Dynamo",
    "Golden Griffins",
    "Shadow Wolves",
    "Thunder Bay United",
    "Silver Phoenix",
    "Obsidian Rovers",
    "Scarlet Lions",
    "Cobalt Titans",
    "Frostgard FC",
    "Ember Athletic",
    "Nova Rangers",
    "Stormbreak United",
    "Onyx Harbor",
    "Verdant Stallions",
    "Crimson Peak",
    "Aurora Athletic",
    "Granite Guardians",
    "Zephyr FC",
    "Blazing Comets",
    "Twilight Wanderers",
    "Halcyon United",
  ];

  // 팀 성향 프리셋 7종 — tactics 0..1 (line/press/tempo/width). 봇 성격 + 유저 수동 전술 프리셋 겸용(P2-D4/D6).
  const personaPresets: LeaguePersonaPreset[] = [
    {
      id: "BALANCED",
      name: "밸런스",
      description: "특정 강점 없이 고르게 — 점유·수비 균형. 어느 상대에도 무난.",
      formation: "4-4-2",
      tactics: { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 },
    },
    {
      id: "ATTACK",
      name: "공격형",
      description: "하이라인·빠른 템포로 전방 압박. 뒷공간 역습에 취약.",
      formation: "4-3-3",
      tactics: { line: 0.75, press: 0.65, tempo: 0.7, width: 0.7 },
    },
    {
      id: "DEFENSE",
      name: "수비형",
      description: "로우블록·낮은 라인으로 진영을 지킴. 지공에 빈틈을 내주기도.",
      formation: "5-3-2",
      tactics: { line: 0.3, press: 0.35, tempo: 0.4, width: 0.4 },
    },
    {
      id: "GEGENPRESS",
      name: "압박",
      description: "강한 전방 압박·즉시 회수. 체력 소모가 크고 라인이 높다.",
      formation: "4-2-3-1",
      tactics: { line: 0.8, press: 0.85, tempo: 0.75, width: 0.55 },
    },
    {
      id: "COUNTER",
      name: "역습",
      description: "낮게 서다 빠른 전환으로 배후 침투. 지공 전개는 느리다.",
      formation: "4-4-2",
      tactics: { line: 0.35, press: 0.45, tempo: 0.8, width: 0.5 },
    },
    {
      id: "POSSESSION",
      name: "점유",
      description: "느린 템포·짧은 패스로 볼 소유. 결정력 부족 시 무득점 위험.",
      formation: "4-3-3",
      tactics: { line: 0.55, press: 0.55, tempo: 0.35, width: 0.55 },
    },
    {
      id: "WING_PLAY",
      name: "측면",
      description: "넓은 폭·측면 크로스 중심. 중앙이 비어 역습 허용 가능.",
      formation: "4-2-3-1",
      tactics: { line: 0.55, press: 0.5, tempo: 0.6, width: 0.85 },
    },
  ];

  // 순위별 포인트 보상(10팀, AC-F4).
  // #212 hero 확정 곡선: **우승을 통 크게, 그 밑은 급감**(1위 = 2위의 5배). 시즌 총수입에서
  // 최종성적이 지배 레버가 되게 한다 — 이전 곡선(3000→200, 단조 완만)은 매판 누적에 묻혔다.
  // 전원 참가 보상(≥500)은 유지.
  const rewards: LeagueReward[] = [
    { rank: 1, points: 100000 },
    { rank: 2, points: 20000 },
    { rank: 3, points: 10000 },
    { rank: 4, points: 6000 },
    { rank: 5, points: 4000 },
    { rank: 6, points: 3000 },
    { rank: 7, points: 2000 },
    { rank: 8, points: 1500 },
    { rank: 9, points: 1000 },
    { rank: 10, points: 500 },
  ];

  return { version: LEAGUE_VERSION, clubNames, personaPresets, rewards };
}

/**
 * 티어 하나의 STAT_PCT/STAT_FLAT 옵션 9종×4스텝(V2.1-2, 잭팟형 편차 확대)을 만든다.
 * `steps`/`weights` 는 작은→큰 순 길이 4. premium = 상위 2스텝(3·4번째 — 캐시 다이스가 이
 * 옵션들의 weight 를 `cashPremiumMult` 배 해서 좋은 옵션 확률을 올린다, V2-2/V2.1-2).
 */
function buildStatOptions(
  type: "STAT_PCT" | "STAT_FLAT",
  steps: readonly [number, number, number, number],
  weights: readonly [number, number, number, number],
): PotentialOption[] {
  const options: PotentialOption[] = [];
  for (const stat of ATTR_KEYS) {
    steps.forEach((value, i) => {
      options.push({ type, stat, value, weight: weights[i], premium: i >= 2 });
    });
  }
  return options;
}

/**
 * 티어별 잠재 옵션 테이블 — RARE/EPIC/UNIQUE (V2.1-2 수치 그대로, 밸런스 재조절은 이 함수
 * 호출 인자만 변경). STAT_PCT/STAT_FLAT 은 9종×4스텝+가중(잭팟 희소) 동일 스텝값을 공유.
 * CONDITION_RECOVERY·TEAM_MORALE 은 2스텝(저/고)만 있어 "premium=상위 2스텝" 룰을 그대로
 * 적용하면 테이블 전체가 premium 이 돼 STAT 계열과의 구조 일관성이 깨진다 → **택1: 상위
 * 1스텝(고값)만 premium** 으로 스텝수 비례 적용(4스텝의 절반=2, 2스텝의 절반=1과 동일 규칙).
 */
function buildPotentialTable(
  statSteps: readonly [number, number, number, number],
  statWeights: readonly [number, number, number, number],
  recoveryMoraleSteps: readonly [number, number],
  recoveryMoraleWeights: readonly [number, number],
): PotentialOption[] {
  // M3(#179 gverify): CONDITION_RECOVERY·TEAM_MORALE 는 서버 효과 배선 전까지 테이블에서 제외 —
  // 유상재화(캐시 다이스)로 뽑는 옵션이 "표시만 되고 효과 없음"은 배포 불가. 배선 후 복원(후속 이슈).
  // (recoveryMoraleSteps/Weights 인자는 복원 대비 시그니처 유지 — 미사용.)
  void recoveryMoraleSteps;
  void recoveryMoraleWeights;
  return [
    ...buildStatOptions("STAT_PCT", statSteps, statWeights),
    ...buildStatOptions("STAT_FLAT", statSteps, statWeights),
  ];
}

/**
 * V2-5 `potential` 블록 전체 — 등급/성 캡 매트릭스(안 ㄴ) + 티어별 옵션 테이블.
 * V2.1-1: `breakout` 필드 제거(전줄 동일 티어로 의미 소멸 — 서버·GM6 이 소비).
 * V2.1-2: 티어 바닥 = 아래 티어 천장(EPIC 최소 4 = RARE 최대, UNIQUE 최소 8 = EPIC 최대).
 */
function buildPotentialConfig(): PotentialConfig {
  return {
    linesByGrade: { BRONZE: 1, SILVER: 1, GOLD: 2, DIA: 3, LEGEND: 3 },
    gradeTierCap: { BRONZE: "RARE", SILVER: "RARE", GOLD: "EPIC", DIA: "UNIQUE", LEGEND: "UNIQUE" },
    starTierCap: { "2": "RARE", "3": "EPIC", "4": "UNIQUE" },
    tierUp: { rareToEpic: 0.06, epicToUnique: 0.018 },
    ceilingMult: 1.5,
    cashPremiumMult: 2,
    tables: {
      RARE: buildPotentialTable([1, 2, 3, 4], [40, 30, 20, 10], [2, 4], [70, 30]),
      EPIC: buildPotentialTable([4, 5, 6, 8], [35, 30, 25, 10], [5, 8], [70, 30]),
      UNIQUE: buildPotentialTable([8, 10, 12, 15], [35, 30, 25, 10], [9, 15], [70, 30]),
    },
  };
}

/** 순수 함수 — SEED + ROSTER 로부터 세 산출물을 계산한다(부수효과 없음, 파일 I/O 없음). */
export function generateAll(): GeneratedData {
  const rng = createRng(SEED);
  const players: PlayerSeed[] = [];

  // 로스터 순서 = ID 배정 순서(P001..). 능력치만 시드 RNG로 밴드 내 결정론 파생.
  ROSTER.forEach((entry, i) => {
    const id = `P${String(i + 1).padStart(3, "0")}`;
    const attributes = rollAttributes(rng, entry.grade, entry.position, entry.traits);
    players.push({ id, name: entry.name, position: entry.position, grade: entry.grade, attributes });
  });

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
    version: DATA_VERSION,
    initialPoints: 3000,
    // #212: 가입 젬 = 10연차 2회분(tenCost 3000 × 2). 젬 수급원은 이것 + 리그 우승 둘뿐.
    initialGems: 6000,
    starterPack,
    gacha: {
      // #212: 뽑기는 젬(유료 재화) 결제. 비용 숫자는 그대로 두고 통화만 바꿨다 —
      // 가입 6000젬이 정확히 10연차 2회가 되게 하는 값이다.
      currency: "GEM",
      singleCost: 300,
      tenCost: 3000,
      tenCount: 11,
      rates: { BRONZE: 0.45, SILVER: 0.3, GOLD: 0.15, DIA: 0.08, LEGEND: 0.02 },
      tenPityMinGrade: "GOLD",
    },
    // #212 hero 확정 곡선. flat 값은 구서버 폴백용으로 남기고, 실제 지급은 byMode 가 결정한다.
    // 연습(500/200/100) = 리그(5000/2000/1000)의 1/10 — 연습은 육성장(match_xp 는 동일하게 쌓인다),
    // 리그가 수입원. 골드(P)는 트레이드·무료강화 전용 재화다.
    rewards: {
      win: 500,
      draw: 200,
      loss: 100,
      byMode: {
        practice: { win: 500, draw: 200, loss: 100 },
        league: { win: 5000, draw: 2000, loss: 1000 },
      },
    },
    // -- P2 트레이드 수치 (P2-D9 / LLD-p2-server §5) — 서버는 이 블록만 읽음(하드코딩 금지) --
    trade: {
      slots: 3,
      kindWeights: { FA: 0.5, TRADE: 0.5 },
      // 레어도별 대기시간(h): 낮은 등급일수록 빨리 열림, 상위 등급은 희소·기다림 (AC-D1).
      waitHours: { BRONZE: 1, SILVER: 6, GOLD: 24, DIA: 48, LEGEND: 72 },
      // 등장 대상 선수 레어도 가중(합=1): 저등급이 흔하게, 레전드는 극소수 노출.
      targetRarityWeights: { BRONZE: 0.3, SILVER: 0.3, GOLD: 0.22, DIA: 0.13, LEGEND: 0.05 },
      // 대기 단축(AC-D4): 비용 = ceil(잔여h × pointsPerHour), 최소 minPoints — 잔여시간 비례.
      // #212: 리그 매판 수입이 ×10 됐으므로 P 싱크도 ×10 (구매력 비율 보존).
      speedup: { pointsPerHour: 500, minPoints: 200 },
      // FA 성공 확률 곡선(AC-D2): p = clamp(base + k×(offerValue/targetValue − 1), minProb, maxProb).
      fa: { base: 0.5, k: 0.8, minProb: 0.05, maxProb: 0.95, reproposalCooldownHours: 6 },
      // TRADE 수락 성공 확률(AC-D3).
      tradeOffer: { acceptProb: 0.8 },
      // 가치함수(§8): value = byGrade[등급] + (능력치 9종 합) × attrSumCoeff.
      // #212: byGrade 와 attrSumCoeff 를 함께 ×10 — 카드 대 카드 비율(=FA 확률)은 불변이고,
      // "포인트로 선수를 사는 환율"만 ×10 경제에 맞춰진다.
      value: {
        byGrade: { BRONZE: 1000, SILVER: 2500, GOLD: 6000, DIA: 14000, LEGEND: 30000 },
        attrSumCoeff: 20,
      },
    },
    // 리그 순위 보상표는 league.v1.json#rewards 참조(단일 원천, 중복 금지) — LLD-p2-data §3.
    league: {
      rewardsFile: `league.${LEAGUE_VERSION}.json`,
      rewardsRef: "rewards",
      // #212: 우승(1위)에만 젬 500~3000 랜덤. 젬을 플레이로 버는 유일한 경로다.
      gemReward: { maxRank: 1, min: 500, max: 3000 },
    },
    // -- #179 V2 스탯 성장(경기·무과금 트랙) config (issues/2026-07-26-growth-dual-track.md V2-2/V2-5)
    // — server/servants 는 이 블록만 읽음(하드코딩 금지). 구 growth(xpPerLevel·completeMatches·
    // benchGrowthMult·execMatchDefault·speedMaxMult)는 메이플 피벗으로 폐기.
    // xp_i = xpBase × (baseline_i + eventBonus_i) × minutesMult × gradeXpMult[grade].
    // 레벨 임계: xpToNext(lv) = xpLvBase × xpLvGrowth^lv (지수) → 자동 레벨업, 스탯 +1/Lv.
    // baselineByPosition: 성장 방향 w 의 포지션 baseline(각 벡터 합=1, 정규화) — 유지.
    growth: {
      xpBase: 100,
      xpLvBase: 100,
      xpLvGrowth: 1.7,
      gradeXpMult: { BRONZE: 0.4, SILVER: 0.4, GOLD: 1.0, DIA: 1.5, LEGEND: 3.0 },
      minutesMult: { starter: 1.0, partial: 0.5, bench: 0 },
      baselineByPosition: {
        FW: { shooting: 0.22, pace: 0.18, positioning: 0.15, technical: 0.13, passing: 0.1, stamina: 0.08, physical: 0.07, mental: 0.05, tackling: 0.02 },
        MF: { passing: 0.2, technical: 0.16, stamina: 0.14, positioning: 0.12, mental: 0.1, pace: 0.1, shooting: 0.08, tackling: 0.06, physical: 0.04 },
        DF: { tackling: 0.22, positioning: 0.18, physical: 0.15, mental: 0.12, passing: 0.1, stamina: 0.09, pace: 0.08, technical: 0.04, shooting: 0.02 },
        GK: { positioning: 0.24, mental: 0.2, physical: 0.14, tackling: 0.12, passing: 0.1, stamina: 0.08, pace: 0.06, technical: 0.04, shooting: 0.02 },
      },
      // 이벤트→스탯 가중(§B① "헤딩 노림→heading류" 세분화 훅) — v2 이벤트 카탈로그 7종.
      // M2(#179 gverify): 단위를 baseline(0.02~0.24)과 같은 스케일로 — 이벤트는 "편향"이지
      // 성장 총량의 지배자가 아니다(구 1~3은 baseline 의 10~100배라 첫 경기에 성장 트랙 60% 소진).
      eventStatMap: {
        goal: { shooting: 0.3, positioning: 0.1 },
        shot: { shooting: 0.2, positioning: 0.1 },
        pass: { passing: 0.2, technical: 0.1 },
        interception: { tackling: 0.2, positioning: 0.1 },
        tackle: { tackling: 0.2, physical: 0.1 },
        save: { positioning: 0.3, mental: 0.1 },
        dribble: { pace: 0.2, technical: 0.1 },
      },
    },
    // -- V2 신규: 성(★, 중복 승급) config (V2-5 `star`) — 구 한계돌파 개칭·확장 --
    star: {
      copies: { "2": 2, "3": 3, "4": 5 },
      starFrac: { "1": 0.25, "2": 0.5, "3": 0.75, "4": 1.0 },
    },
    // -- V2 신규: 잠재능력(다이스) config (V2-5 `potential`) — 메이플 이식, 안 ㄴ(성 게이트형) --
    potential: buildPotentialConfig(),
    // -- V2 신규 → V2.2 재화 이원화로 개정: 다이스 상점 비용 (`dice`, POST /api/shop/dice 목업).
    // 캐시 다이스는 P 결제(cashCost) 폐기 → 젬 결제(cashGemCost)로 전환. --
    // #212: 무료(노말) 다이스는 골드 싱크라 리그 수입 ×10 에 맞춰 상향. 캐시 다이스(젬)는
    // 젬 경제 쪽이라 무변경 — 젬 가격 튜닝은 #201 밸런스 트랙 소관.
    dice: { normalCost: 5000, cashGemCost: 10 },
    // -- V2.2 신규: 충전형 젬 상점(목업, POST /api/shop/gems/topup) --
    // #212: hero 확정으로 수도꼭지를 잠근다(topupEnabled=false). 팩 정의는 실결제 배선 때
    // 되살릴 수 있게 남겨둔다.
    gems: {
      topupEnabled: false,
      topupPacks: [
        { id: "p1", gems: 60, mockPrice: "₩1,200" },
        { id: "p2", gems: 330, mockPrice: "₩5,900" },
        { id: "p3", gems: 720, mockPrice: "₩11,900" },
      ],
    },
  };

  // -- bots.v1.json -------------------------------------------------------
  // BOT_ATK 공격형 — FW/MF 골드 위주 (LLD §4). DIA/LEGEND(rank 3~4)은 봇에 쓰지 않고
  // 가챠 열망 카드로 예약 — 모든 봇 픽은 maxRank=GOLD(2) 로 캡한다.
  const botAtkDeck = buildBotDeck(players, {
    starterGroups: [
      { position: "GK", count: 1, minRank: 0, maxRank: 2 },
      { position: "DF", count: 4, minRank: 0, maxRank: 2 },
      { position: "MF", count: 3, minRank: 2, maxRank: 2 },
      { position: "FW", count: 3, minRank: 2, maxRank: 2 },
    ],
    fwPromptCount: 2,
    fwPromptText: "적극 침투",
    benchMinRank: 0,
    benchMaxRank: 2,
  });
  botAtkDeck.formation = "4-3-3";

  // BOT_DEF 수비형 — DF 골드 위주 (LLD §4)
  const botDefDeck = buildBotDeck(players, {
    starterGroups: [
      { position: "GK", count: 1, minRank: 0, maxRank: 2 },
      { position: "DF", count: 5, minRank: 2, maxRank: 2 },
      { position: "MF", count: 3, minRank: 0, maxRank: 2 },
      { position: "FW", count: 2, minRank: 0, maxRank: 2 },
    ],
    fwPromptCount: 0,
    fwPromptText: "",
    benchMinRank: 0,
    benchMaxRank: 2,
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

  const playersV21 = buildPlayersV21(players);
  const league = buildLeague();

  return { players, playersV21, economy, bots, league };
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
  const { players, playersV21, economy, bots, league } = generateAll();
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(here, `players.${DATA_VERSION}.json`), JSON.stringify(players, null, 2) + "\n");
  writeFileSync(
    join(here, `players.${PLAYERS_V21_VERSION}.json`),
    JSON.stringify(playersV21, null, 2) + "\n",
  );
  writeFileSync(join(here, `economy.${DATA_VERSION}.json`), JSON.stringify(economy, null, 2) + "\n");
  writeFileSync(join(here, `bots.${DATA_VERSION}.json`), JSON.stringify(bots, null, 2) + "\n");
  writeFileSync(join(here, `league.${LEAGUE_VERSION}.json`), JSON.stringify(league, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(
    `generated ${players.length} players (+v2.1 personality), economy.${DATA_VERSION}.json, ` +
      `${bots.length} bots, league.${LEAGUE_VERSION}.json -> data/players/`,
  );
}
