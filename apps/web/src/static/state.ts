/**
 * 스태틱 모드 유저/매치 상태 (#444) — 브라우저가 곧 서버다.
 *
 * <b>영속 규칙</b>: 유저와 **매치의 입력**만 localStorage 에 남긴다. 하프 로그(수 MB)는 저장하지
 * 않는다 — 엔진이 결정론이라 `(seed + selectData + TacticalInput)` 만 있으면 **같은 로그가 다시
 * 나온다**(루트 §3 재현 계약). 새로고침 복구는 재시뮬로 한다(하프당 0.2~0.6초).
 *
 * ⚠️ `Math.random`·`Date.now` 는 **이 계층(=서버 역할)에만** 있다. 엔진 경계 안으로는 시드와
 * 입력만 넘어간다(결정론 불변 — 루트 §2-5).
 */
import type { SelectData, TacticalInput } from "@hmb/shared";
import { SEED_ECONOMY } from "./data";

const STORE_KEY = "hmb.static.state.v1";

export interface StaticDeckSlot {
  playerId: string;
  role: "starter" | "bench";
  slotIndex: number;
  promptText?: string | null;
}

export interface StaticDeck {
  id: string;
  formation: string;
  teamPrompt?: string | null;
  slots: StaticDeckSlot[];
  updatedAt: string;
}

export interface StaticPreset {
  id: string;
  name: string;
  promptText: string;
  createdAt: string;
}

export type StaticMatchState =
  | "BRIEFING"
  | "GEN1"
  | "FIRST_HALF"
  | "HALFTIME"
  | "GEN2"
  | "SECOND_HALF"
  | "FINISHED"
  | "ABANDONED";

export interface StaticMatchPrompts {
  team: string;
  players: Record<string, string>;
}

export interface StaticMatch {
  id: string;
  botId: string;
  state: StaticMatchState;
  createdAt: string;
  finishedAt?: string | null;
  auto: boolean;
  /** 엔진 재현 3종세트 — 이것만 있으면 로그를 언제든 다시 만든다. */
  seed: string;
  selectData: SelectData;
  homeInput: TacticalInput | null;
  awayInput: TacticalInput | null;
  /** 후반 입력(감독시간 반영). null 이면 전반 입력을 그대로 쓴다. */
  homeInput2: TacticalInput | null;
  awayInput2: TacticalInput | null;
  prompts: { pre: StaticMatchPrompts; halftime: StaticMatchPrompts };
  /** 덱 스냅샷(결과·감독시간 화면이 읽는다). */
  deck: StaticDeck;
  substitutions: { out: string; in: string }[];
  scoreH1Home: number | null;
  scoreH1Away: number | null;
  scoreHome: number | null;
  scoreAway: number | null;
  /** 현재 단계 창(서버 권위 시계의 흉내) — epoch ms. */
  phaseStartMs: number | null;
  phaseEndsMs: number | null;
  kickoffMs: number | null;
  /** 하프별 재생 길이(ms) — viewer-core autoPaceDurationMs 산출. */
  playbackMs: { 1: number | null; 2: number | null };
  /** AI 로 만든 입력인가(배너 문구가 이 값을 읽는다). */
  aiGenerated: boolean;
}

export interface StaticState {
  user: {
    id: string;
    nickname: string;
    provider: string;
    points: number;
    gems: number;
    wins: number;
    draws: number;
    losses: number;
    rating: number;
    tutorialDone: boolean;
  } | null;
  owned: Record<string, number>;
  deck: StaticDeck | null;
  presets: StaticPreset[];
  starterGrantId: string | null;
  match: StaticMatch | null;
  /** 시드 RNG 커서 — 뽑기 등 "서버 난수"를 재현 가능하게 둔다. */
  rngCursor: number;
}

const EMPTY: StaticState = {
  user: null,
  owned: {},
  deck: null,
  presets: [],
  starterGrantId: null,
  match: null,
  rngCursor: 1,
};

let state: StaticState = EMPTY;
let loaded = false;

function load(): StaticState {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) state = { ...EMPTY, ...(JSON.parse(raw) as StaticState) };
  } catch {
    state = EMPTY; // 깨진 저장은 초기화로 흡수 — 화면이 죽는 것보다 낫다.
  }
  return state;
}

export function getState(): StaticState {
  return load();
}

/** 상태 변경 + 영속. **로그는 담기지 않는다**(입력만 저장한다 — 파일 상단 주석). */
export function save(): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(load()));
  } catch {
    // 용량 초과·프라이빗 모드 — 메모리 상태로는 계속 돈다.
  }
}

export function resetState(): void {
  state = { ...EMPTY, owned: {}, presets: [] };
  loaded = true;
  save();
}

/** 시드 LCG — 같은 커서면 같은 값. 서버 난수 자리에만 쓴다(엔진 아님). */
export function nextRandom(): number {
  const s = load();
  s.rngCursor = (s.rngCursor * 1664525 + 1013904223) >>> 0;
  return s.rngCursor / 0x1_0000_0000;
}

/** ULID 흉내 — 정렬 가능한 26자 id(형태만 맞추면 화면·라우팅이 동일하게 돈다). */
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newId(prefix = ""): string {
  let out = prefix;
  for (let i = out.length; i < 26; i += 1) {
    out += ID_ALPHABET[Math.floor(nextRandom() * ID_ALPHABET.length)] ?? "0";
  }
  return out;
}

export function ensureUser(nickname: string, provider: string): StaticState {
  const s = load();
  if (!s.user) {
    // ⚠️ 커서를 1 로 두면 **모든 신규 유저가 같은 시드를 받아** 매번 같은 스코어의 같은 경기가
    // 나온다(실제로 두 번 돌려 같은 0:1 이 나왔다). 여기는 서버 역할이라 시각을 읽어도 되고,
    // 엔진에는 이 커서에서 뽑은 **시드 문자열만** 넘어가므로 결정론 계약은 그대로다(루트 §2-5).
    s.rngCursor = (Date.now() ^ 0x9e3779b9) >>> 0 || 1;
    s.user = {
      id: newId(),
      nickname,
      provider,
      points: SEED_ECONOMY.initialPoints,
      gems: SEED_ECONOMY.initialGems,
      wins: 0,
      draws: 0,
      losses: 0,
      rating: 0,
      tutorialDone: false,
    };
  } else {
    s.user.nickname = nickname;
    s.user.provider = provider;
  }
  save();
  return s;
}
