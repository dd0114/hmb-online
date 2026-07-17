import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultEngineConfig, type EngineConfig } from "@hmb/engine";
import type {
  SelectData,
  TeamRoster,
  PlayerCard,
  TacticalInput,
  PlayerInput,
  PlayerBehavior,
  Duty,
  SimulateRequest,
} from "@hmb/shared";
import { simulate } from "../src/runner/simulate.js";

/**
 * server-java WireMock 테스트용 엔진러너 fixture 발행 스크립트(LLD-ts-servants §4).
 * data/players/bots.v1.json(BOT_ATK vs BOT_DEF) + players.v1.json 실 데이터로 SelectData 를 만들고,
 * 고정 시드로 half=1 → half=2(resumeState 승계) 실 시뮬레이션을 돌려 {request, response} 쌍을
 * docs/plan-v2/fixtures/matchlog-h1.json / matchlog-h2.json 에 발행한다.
 *
 * ⚠️ SHORT-MATCH 샘플(게임플레이 비현실적, 형태 검증용): git 에 영구 커밋되는 fixture 를 1MB 미만으로
 * 유지하기 위해 "여기서만" 단축 EngineConfig(matchMinutes 축소, 아래 fixtureConfig)로 시뮬한다.
 * 러너 운영 경로(runner-main.ts → simulate 기본 인자)는 계속 defaultEngineConfig(90분) 사용.
 * fixture 는 zod SimulateRequest/Response 스키마와 h1→h2(resumeState 승계) 정합성을 만족하는
 * WireMock 재생용 shape 샘플이지, 실경기 밸런스 증빙이 아니다(그건 tools/qa-match.mjs 몫).
 * 상세: docs/plan-v2/fixtures/README.md
 *
 * 실행: npx tsx packages/server/scripts/generate-runner-fixtures.ts
 * 결정론: 하드코딩 고정 시드만 사용(Math.random/Date.now 없음) — 재실행해도 바이트 동일 산출.
 */

/**
 * 단축 fixture 전용 config — dev-viewer/generate-demo.ts 의 showcaseConfig 와 같은 기법
 * (defaultEngineConfig 스프레드 + version 태그 + matchMinutes 단축). 4분 매치 = 240틱(하프 120틱).
 * version 태그를 별도로 두어, 이 resumeState 를 실 러너(기본 config)에 잘못 재생하면
 * deserializeCarry 의 버전 가드가 400 으로 거부한다(오용 방지).
 */
const fixtureConfig: EngineConfig = {
  ...defaultEngineConfig,
  version: `${defaultEngineConfig.version}-fixture-short`,
  matchMinutes: 4,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DATA_DIR = join(REPO_ROOT, "data", "players");
const FIXTURES_DIR = join(REPO_ROOT, "docs", "plan-v2", "fixtures");

const FIXTURE_SEED = "990011223344";

interface BotPlayerRef {
  playerId: string;
  slotIndex: number;
  promptText?: string;
}

interface BotDeck {
  id: string;
  name: string;
  persona: string;
  deck: { formation: string; starters: BotPlayerRef[]; bench: string[] };
}

interface RawPlayer {
  id: string;
  name: string;
  position: "GK" | "DF" | "MF" | "FW";
  grade: string;
  attributes: PlayerCard["attributes"];
}

const bots = JSON.parse(readFileSync(join(DATA_DIR, "bots.v1.json"), "utf8")) as BotDeck[];
const players = JSON.parse(readFileSync(join(DATA_DIR, "players.v1.json"), "utf8")) as RawPlayer[];
const playersById = new Map(players.map((p) => [p.id, p]));

/** 슬롯(0..10) 순서 라벨 — config.formations["4-3-3"] 순서와 1:1(config.ts 주석 그대로). */
const SLOT_META: { role: string; duty: Duty }[] = [
  { role: "GK", duty: "defend" },
  { role: "LB", duty: "support" },
  { role: "LCB", duty: "defend" },
  { role: "RCB", duty: "defend" },
  { role: "RB", duty: "support" },
  { role: "LCM", duty: "support" },
  { role: "CM", duty: "support" },
  { role: "RCM", duty: "support" },
  { role: "LW", duty: "attack" },
  { role: "ST", duty: "attack" },
  { role: "RW", duty: "attack" },
];

const BASE_BEHAVIOR: PlayerBehavior = {
  positioningFreedom: 0.4,
  forwardRunFreq: 0.4,
  widthTendency: 0.4,
  supportDepth: 0.5,
  pressAggression: 0.5,
  passRisk: 0.4,
  passDirectness: 0.5,
  dribbleTendency: 0.4,
  shootTendency: 0.4,
};

function behaviorFor(slotIndex: number): PlayerBehavior {
  const role = SLOT_META[slotIndex]!.role;
  if (role === "GK") return { ...BASE_BEHAVIOR, forwardRunFreq: 0.05, shootTendency: 0.02, passRisk: 0.2 };
  if (role === "LCB" || role === "RCB") return { ...BASE_BEHAVIOR, forwardRunFreq: 0.12, shootTendency: 0.08 };
  if (role === "LB" || role === "RB") return { ...BASE_BEHAVIOR, widthTendency: 0.75, shootTendency: 0.15 };
  if (role === "LW" || role === "RW") return { ...BASE_BEHAVIOR, widthTendency: 0.8, dribbleTendency: 0.7, shootTendency: 0.6 };
  if (role === "ST") return { ...BASE_BEHAVIOR, forwardRunFreq: 0.75, shootTendency: 0.85 };
  return { ...BASE_BEHAVIOR, forwardRunFreq: 0.5, shootTendency: 0.45 }; // 미드필드
}

function rosterFor(bot: BotDeck): TeamRoster {
  const cards: PlayerCard[] = [...bot.deck.starters]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((s) => {
      const p = playersById.get(s.playerId);
      if (!p) throw new Error(`fixture gen: unknown playerId ${s.playerId} in bot ${bot.id}`);
      return { playerId: p.id, name: p.name, position: p.position, attributes: p.attributes };
    });
  return { name: bot.name, players: cards };
}

function tacticalInputFor(bot: BotDeck, seed: string): TacticalInput {
  const slots = defaultEngineConfig.formations["4-3-3"]!;
  const starters = [...bot.deck.starters].sort((a, b) => a.slotIndex - b.slotIndex);
  const playerInputs: PlayerInput[] = starters.map((s) => {
    const slot = slots[s.slotIndex]!;
    const meta = SLOT_META[s.slotIndex]!;
    return {
      playerId: s.playerId,
      role: meta.role,
      duty: meta.duty,
      basePosition: { x: slot.x, y: slot.y },
      behavior: behaviorFor(s.slotIndex),
      mentalModifier: 0,
    } satisfies PlayerInput;
  });
  return {
    seed,
    team: {
      formation: bot.deck.formation,
      defensiveLineHeight: 0.55,
      compactness: 0.5,
      tempo: 0.5,
      width: 0.55,
      pressingScheme: { intensity: 0.55, triggerLine: 0.5 },
      offsideTrap: false,
    },
    players: playerInputs,
  };
}

const botHome = bots.find((b) => b.id === "BOT_ATK");
const botAway = bots.find((b) => b.id === "BOT_DEF");
if (!botHome || !botAway) throw new Error("fixture gen: BOT_ATK/BOT_DEF not found in bots.v1.json");

const selectData: SelectData = { home: rosterFor(botHome), away: rosterFor(botAway) };
const homeInput = tacticalInputFor(botHome, FIXTURE_SEED);
const awayInput = tacticalInputFor(botAway, FIXTURE_SEED);

mkdirSync(FIXTURES_DIR, { recursive: true });

// --- half 1 (단축 config — 러너 운영 경로가 아님, 위 fixtureConfig 주석 참고) ---
const reqH1: SimulateRequest = { seed: FIXTURE_SEED, selectData, homeInput, awayInput, half: 1 };
const resH1 = simulate(reqH1, fixtureConfig);
writeFileSync(join(FIXTURES_DIR, "matchlog-h1.json"), JSON.stringify({ request: reqH1, response: resH1 }, null, 2));

// --- half 2 (전반 상태 승계 재개) ---
const reqH2: SimulateRequest = {
  seed: FIXTURE_SEED,
  selectData,
  homeInput,
  awayInput,
  half: 2,
  resumeState: resH1.resumeState,
};
const resH2 = simulate(reqH2, fixtureConfig);
writeFileSync(join(FIXTURES_DIR, "matchlog-h2.json"), JSON.stringify({ request: reqH2, response: resH2 }, null, 2));

console.log(
  `[fixtures] wrote matchlog-h1.json(ticks=${resH1.matchLog.tickSnapshots.length}, score=${JSON.stringify(resH1.matchLog.finalScore)}) ` +
    `matchlog-h2.json(ticks=${resH2.matchLog.tickSnapshots.length}, score=${JSON.stringify(resH2.matchLog.finalScore)}) → ${FIXTURES_DIR}`,
);
