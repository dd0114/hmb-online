/**
 * 스태틱 모드 목 백엔드 (#444) — `apiFetch` 가 네트워크 대신 여기로 온다.
 *
 * <b>설계 원칙 3개</b>
 *  1. **화면을 고치지 않는다.** 응답은 실서버(openapi V1 + v2 델타)와 같은 모양이고, 경기 흐름도
 *     같은 상태머신(BRIEFING→GEN1→FIRST_HALF→HALFTIME→GEN2→SECOND_HALF→FINISHED) + 같은
 *     시계 계약(`MatchClock`)이다. 그래서 뷰어·흐름 브릿지(#424)·라이브 게이트가 그대로 돈다.
 *  2. **모르는 경로는 조용히 성립한다.** 스태틱 빌드가 다루지 않는 메타(리그·트레이드·원정·메일·
 *     관리자)는 에러가 아니라 **빈 응답**을 준다 — 데모 빌드에서 화면 하나가 흰 화면이 되는 것보다
 *     "여기는 비어 있다"가 낫다. 진짜 없는 것만 404 다.
 *  3. **엔진 경계를 넘지 않는다.** 여기(=서버 역할)에는 `Date.now`·난수가 있어도 되지만, 엔진에는
 *     시드와 입력만 넘어간다(결정론 불변 — 루트 §2-5).
 */
import type { MatchLog, SelectData, TacticalInput, TeamInputJobContext } from "@hmb/shared";
import { formationBasePositions } from "@hmb/shared";
import { ApiError } from "../api/client";
import { playerNameOf } from "../common/player-names";
import {
  OPEN_PLAYERS,
  SEED_BOTS,
  SEED_ECONOMY,
  SEED_PLAYERS,
  scaleAttributes,
  seedPlayer,
  type SeedBot,
} from "./data";
import {
  ensureUser,
  getState,
  newId,
  nextRandom,
  save,
  type StaticDeck,
  type StaticMatch,
  type StaticMatchState,
} from "./state";
import { buildTacticalInput } from "./tactics";
import { simulateFirstHalf, simulateSecondHalf, type SimSession } from "./sim";

/* ─────────────────────────────── 튜닝 노브 (조정 포인트) ───────────────────────────────
 * 값만 바꾸면 되는 것들이다 — 구조가 아니다(#444 W0 §7).
 */
/** 감독시간(ms). 실서버 기본은 60초. */
const HALFTIME_MS = 60_000;
/** 생성(GEN1/GEN2) 최소 노출 시간(ms) — 시뮬이 0.3초에 끝나 화면이 깜빡이는 것을 막는다. */
const GEN_MIN_MS = 900;
/**
 * 스태틱 데모는 **앞서가기를 막지 않는다**. 심사·시연에서 8분을 기다리게 하지 않기 위함이고,
 * 라이브 서버 정책(`seekForwardBlocked=true`)과 다른 유일한 지점이다.
 */
const SEEK_FORWARD_BLOCKED = false;

/* ─────────────────────────────── 응답 헬퍼 ─────────────────────────────── */

function fail(status: number, code: string, message: string, detail?: Record<string, unknown>): never {
  throw new ApiError(status, { code, message, detail: detail ?? null });
}

const iso = (ms: number): string => new Date(ms).toISOString();

/* ─────────────────────────────── 카탈로그 ─────────────────────────────── */

/**
 * 선수 이름은 **초크포인트로만**(#406). 여기는 서버 역할이라 이 값이 API 응답·엔진 `SelectData` ·
 * 이벤트 이름으로 그대로 나간다 — `?? playerId` 로 폴백하면 화면에 `P077` 이 뜨는 그 패턴이
 * 데이터 층에서 재생산된다. 못 찾으면 `미상 선수` 다(사다리 3단).
 */
const nameOf = (playerId: string): string => playerNameOf(seedPlayer(playerId), "full");

function catalogPlayers(): unknown[] {
  const { owned } = getState();
  return SEED_PLAYERS.map((p) => ({
    id: p.id,
    name: p.name,
    position: p.position,
    grade: p.grade,
    attributes: p.attributes,
    owned: (owned[p.id] ?? 0) > 0,
    ownedCount: owned[p.id] ?? 0,
    active: p.active !== false,
    ...(p.personality ? { personality: p.personality } : {}),
  }));
}

function appConfig(): unknown {
  const point = {
    code: "POINT",
    symbol: "P",
    name: "포인트",
    icon: "🪙",
    position: "suffix" as const,
    separator: " ",
  };
  const gem = {
    code: "GEM",
    symbol: "G",
    name: "젬",
    icon: "💎",
    position: "suffix" as const,
    separator: " ",
  };
  return {
    currencies: [point, gem],
    shop: {
      gacha: {
        single: { currency: "GEM", cost: SEED_ECONOMY.gacha.singleCost },
        ten: { currency: "GEM", cost: SEED_ECONOMY.gacha.tenCost },
        tenCount: SEED_ECONOMY.gacha.tenCount,
      },
      dice: null,
      gemTopup: null,
    },
    grants: { initialPoints: SEED_ECONOMY.initialPoints, initialGems: SEED_ECONOMY.initialGems },
  };
}

function meResponse(): unknown {
  const s = getState();
  if (!s.user) fail(401, "UNAUTHORIZED", "로그인이 필요합니다");
  const u = s.user;
  return {
    user: { id: u.id, nickname: u.nickname, isAdmin: false, tutorialDone: u.tutorialDone },
    wallet: { points: u.points, gems: u.gems },
    records: { wins: u.wins, draws: u.draws, losses: u.losses },
    rating: u.rating,
    league: null,
    mail: { unread: 0, total: 0 },
  };
}

/* ─────────────────────────────── 덱 ─────────────────────────────── */

/** 스타터 팩으로 기본 덱을 만든다(포지션을 보고 4-4-2 슬롯에 채운다). */
function grantStarter(): void {
  const s = getState();
  if (Object.keys(s.owned).length > 0) return;
  for (const id of SEED_ECONOMY.starterPack) s.owned[id] = (s.owned[id] ?? 0) + 1;
  // 스타터 최상위 연출용 1장 — 오픈된 풀에서 가장 높은 등급을 고른다.
  const order = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];
  const best = SEED_ECONOMY.starterPack
    .map((id) => seedPlayer(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .sort((a, b) => order.indexOf(b.grade) - order.indexOf(a.grade))[0];
  s.starterGrantId = best?.id ?? null;
  s.deck ??= autoDeck();
  save();
}

const SLOT_POSITIONS_442: readonly string[] = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"];

/** 보유 선수로 4-4-2 를 자동 구성한다(포지션 우선, 모자라면 아무나). */
function autoDeck(): StaticDeck {
  const { owned } = getState();
  const pool = Object.keys(owned)
    .map((id) => seedPlayer(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  const used = new Set<string>();
  const slots: StaticDeck["slots"] = [];
  SLOT_POSITIONS_442.forEach((want, slotIndex) => {
    const pick =
      pool.find((p) => !used.has(p.id) && p.position === want) ??
      pool.find((p) => !used.has(p.id) && want !== "GK" && p.position !== "GK") ??
      pool.find((p) => !used.has(p.id));
    if (!pick) return;
    used.add(pick.id);
    slots.push({ playerId: pick.id, role: "starter", slotIndex });
  });
  pool
    .filter((p) => !used.has(p.id))
    .slice(0, 7)
    .forEach((p, i) => slots.push({ playerId: p.id, role: "bench", slotIndex: i }));
  return {
    id: newId(),
    formation: "4-4-2",
    teamPrompt: null,
    slots,
    updatedAt: iso(Date.now()),
  };
}

/* ─────────────────────────────── 매치 ─────────────────────────────── */

/** 시뮬 세션(로그 포함)은 **메모리에만** 산다. 새로고침하면 입력으로 다시 만든다. */
const sessions = new Map<string, SimSession>();

function pickBot(botId?: string | null): SeedBot {
  if (botId) {
    const found = SEED_BOTS.find((b) => b.id === botId);
    if (found) return found;
  }
  return SEED_BOTS[Math.floor(nextRandom() * SEED_BOTS.length)] ?? SEED_BOTS[0]!;
}

function starterSlots(deck: StaticDeck): StaticDeck["slots"] {
  return [...deck.slots.filter((s) => s.role === "starter")].sort((a, b) => a.slotIndex - b.slotIndex);
}

function buildSelectData(deck: StaticDeck, bot: SeedBot, nickname: string): SelectData {
  const mul = bot.strengthMul ?? 1;
  const home = starterSlots(deck).map((slot) => {
    const p = seedPlayer(slot.playerId);
    return {
      playerId: slot.playerId,
      name: nameOf(slot.playerId),
      position: p?.position ?? "MF",
      attributes: p?.attributes ?? seedPlayer("P001")!.attributes,
    };
  });
  const away = [...bot.deck.starters]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((slot) => {
      const p = seedPlayer(slot.playerId);
      return {
        playerId: slot.playerId,
        name: nameOf(slot.playerId),
        position: p?.position ?? "MF",
        attributes: scaleAttributes(p?.attributes ?? seedPlayer("P001")!.attributes, mul),
      };
    });
  return {
    home: { name: nickname, players: home },
    away: { name: bot.name, players: away },
  } as SelectData;
}

/** side·half 별 파생 시드(문자열). 서버가 하는 일과 같은 역할이고 값 규칙만 우리 것이다. */
function halfSeed(seed: string, side: "home" | "away", half: 1 | 2): string {
  let h = 2166136261;
  for (const ch of `${seed}:${side}:${half}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return String(h);
}

function jobContext(
  match: StaticMatch,
  side: "home" | "away",
  half: 1 | 2,
  phase: "pre" | "halftime",
): TeamInputJobContext {
  const isHome = side === "home";
  const bot = pickBot(match.botId);
  const roster = isHome
    ? effectiveStarters(match).map((slot, i) => {
        const p = seedPlayer(slot.playerId);
        return {
          playerId: slot.playerId,
          name: nameOf(slot.playerId),
          position: p?.position ?? "MF",
          attributes: p?.attributes ?? seedPlayer("P001")!.attributes,
          slotIndex: i,
        };
      })
    : [...bot.deck.starters]
        .sort((a, b) => a.slotIndex - b.slotIndex)
        .map((slot, i) => {
          const p = seedPlayer(slot.playerId);
          return {
            playerId: slot.playerId,
            name: nameOf(slot.playerId),
            position: p?.position ?? "MF",
            attributes: scaleAttributes(p?.attributes ?? seedPlayer("P001")!.attributes, bot.strengthMul ?? 1),
            slotIndex: i,
          };
        });

  const prompts = match.prompts[phase];
  const teamPrompt = isHome
    ? prompts.team || match.deck.teamPrompt || ""
    : bot.persona;
  const playerPrompts = isHome
    ? { ...deckPlayerPrompts(match.deck), ...prompts.players }
    : Object.fromEntries(
        bot.deck.starters.filter((s) => s.promptText).map((s) => [s.playerId, s.promptText!]),
      );

  const opponentRoster = (isHome ? bot.deck.starters : effectiveStarters(match)).map((slot) => {
    const p = seedPlayer(slot.playerId);
    return { playerId: slot.playerId, name: nameOf(slot.playerId), position: p?.position ?? "MF" };
  });

  return {
    kind: "team-input",
    matchId: match.id,
    side,
    half,
    seed: halfSeed(match.seed, side, half),
    formation: isHome ? match.deck.formation : bot.deck.formation,
    roster,
    teamPrompt,
    playerPrompts,
    opponentRoster,
  } as TeamInputJobContext;
}

function deckPlayerPrompts(deck: StaticDeck): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of deck.slots) if (s.promptText) out[s.playerId] = s.promptText;
  return out;
}

/** 교체를 반영한 실효 선발 11명. */
function effectiveStarters(match: StaticMatch): StaticDeck["slots"] {
  const slots = starterSlots(match.deck).map((s) => ({ ...s }));
  for (const sub of match.substitutions) {
    const at = slots.findIndex((s) => s.playerId === sub.out);
    if (at >= 0) slots[at] = { ...slots[at]!, playerId: sub.in };
  }
  return slots;
}

/**
 * 슬롯 좌표를 포메이션 계약(#324)으로 맞춘다 — 스텁은 `ctx.formation` 을 보지만 AI 응답도 같은
 * 규약을 지켜야 하므로 여기서 한 번 더 못 박는다(유저가 보드에서 잡은 좌우가 살아 있게).
 */
function pinBasePositions(input: TacticalInput, formation: string): TacticalInput {
  const slots = formationBasePositions(formation);
  input.players.forEach((p, i) => {
    const slot = slots[i];
    if (slot) p.basePosition = { x: slot.x, y: slot.y };
  });
  input.team.formation = formation;
  return input;
}

/* ── 상태 전이 ─────────────────────────────────────────────────────────── */

/** 진행 중인 비동기 생성 — 같은 매치에 두 번 돌지 않게 잡아 둔다. */
const generating = new Map<string, Promise<void>>();

function ensureSession(match: StaticMatch): SimSession {
  const found = sessions.get(match.id);
  if (found) return found;
  if (!match.homeInput || !match.awayInput) fail(409, "INVALID_STATE", "아직 전술 인풋이 없습니다");
  // 새로고침 복구 = 재시뮬(결정론이라 같은 로그가 나온다).
  const session = simulateFirstHalf(match.seed, match.homeInput, match.awayInput, match.selectData);
  sessions.set(match.id, session);
  if (match.state === "SECOND_HALF" || match.state === "FINISHED") {
    simulateSecondHalf(session, match.homeInput2 ?? match.homeInput, match.awayInput2 ?? match.awayInput);
  }
  return session;
}

function startGeneration(match: StaticMatch, half: 1 | 2): void {
  if (generating.has(match.id)) return;
  const startedAt = Date.now();
  const phase = half === 1 ? "pre" : "halftime";
  const task = (async () => {
    const [home, away] = await Promise.all([
      buildTacticalInput(jobContext(match, "home", half, phase)),
      buildTacticalInput(jobContext(match, "away", half, phase)),
    ]);
    const bot = pickBot(match.botId);
    const homeInput = pinBasePositions(home.input, match.deck.formation);
    const awayInput = pinBasePositions(away.input, bot.deck.formation);
    match.aiGenerated = home.aiGenerated;
    if (half === 1) {
      match.homeInput = homeInput;
      match.awayInput = awayInput;
      match.selectData = buildSelectData(match.deck, bot, getState().user?.nickname ?? "나의 팀");
      const session = simulateFirstHalf(match.seed, homeInput, awayInput, match.selectData);
      sessions.set(match.id, session);
      match.playbackMs[1] = session.half1.playbackMs;
      match.scoreH1Home = session.half1.score.home;
      match.scoreH1Away = session.half1.score.away;
    } else {
      match.homeInput2 = homeInput;
      match.awayInput2 = awayInput;
      const session = ensureSession(match);
      const h2 = simulateSecondHalf(session, homeInput, awayInput);
      match.playbackMs[2] = h2.playbackMs;
      match.scoreHome = h2.score.home;
      match.scoreAway = h2.score.away;
    }
    // 생성 화면이 깜빡이지 않게 최소 노출 시간을 채운다.
    const rest = GEN_MIN_MS - (Date.now() - startedAt);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    openHalf(match, half);
  })().finally(() => generating.delete(match.id));
  generating.set(match.id, task);
}

function openHalf(match: StaticMatch, half: 1 | 2): void {
  const now = Date.now();
  match.state = half === 1 ? "FIRST_HALF" : "SECOND_HALF";
  match.phaseStartMs = now;
  match.phaseEndsMs = now + (match.playbackMs[half] ?? 60_000);
  if (half === 1) match.kickoffMs = now;
  save();
}

function finishMatch(match: StaticMatch): void {
  const s = getState();
  match.state = "FINISHED";
  match.finishedAt = iso(Date.now());
  match.phaseStartMs = null;
  match.phaseEndsMs = null;
  const home = match.scoreHome ?? 0;
  const away = match.scoreAway ?? 0;
  if (s.user) {
    if (home > away) {
      s.user.wins += 1;
      s.user.points += SEED_ECONOMY.rewards.win;
      s.user.rating += 20;
    } else if (home === away) {
      s.user.draws += 1;
      s.user.points += SEED_ECONOMY.rewards.draw;
    } else {
      s.user.losses += 1;
      s.user.points += SEED_ECONOMY.rewards.loss;
      s.user.rating -= 10;
    }
  }
  save();
}

/** 시각이 만든 전이를 밟는다. 모든 매치 조회 앞에서 호출된다(서버 스위퍼의 역할). */
function advance(match: StaticMatch): void {
  const now = Date.now();
  for (let guard = 0; guard < 8; guard += 1) {
    if (match.state === "GEN1") {
      startGeneration(match, 1);
      return;
    }
    if (match.state === "GEN2") {
      startGeneration(match, 2);
      return;
    }
    if (match.state === "FIRST_HALF") {
      if (match.phaseEndsMs != null && now >= match.phaseEndsMs) {
        if (match.auto) {
          match.state = "GEN2";
          continue;
        }
        match.state = "HALFTIME";
        match.phaseStartMs = now;
        match.phaseEndsMs = now + HALFTIME_MS;
        save();
      }
      return;
    }
    if (match.state === "HALFTIME") {
      if (match.phaseEndsMs != null && now >= match.phaseEndsMs) {
        match.state = "GEN2";
        continue;
      }
      return;
    }
    if (match.state === "SECOND_HALF") {
      if (match.phaseEndsMs != null && now >= match.phaseEndsMs) {
        finishMatch(match);
      }
      return;
    }
    return;
  }
}

const LIVE_PHASES: StaticMatchState[] = ["FIRST_HALF", "HALFTIME", "SECOND_HALF"];

function matchDetail(match: StaticMatch): unknown {
  const bot = pickBot(match.botId);
  const live = LIVE_PHASES.includes(match.state);
  const half = match.state === "SECOND_HALF" ? 2 : 1;
  const result =
    match.state === "FINISHED"
      ? (match.scoreHome ?? 0) > (match.scoreAway ?? 0)
        ? "WIN"
        : (match.scoreHome ?? 0) === (match.scoreAway ?? 0)
          ? "DRAW"
          : "LOSS"
      : null;
  return {
    id: match.id,
    state: match.state,
    createdAt: match.createdAt,
    finishedAt: match.finishedAt ?? null,
    auto: match.auto,
    opponent: {
      name: bot.name,
      analysisText: bot.analysisText,
      deck: [...bot.deck.starters]
        .sort((a, b) => a.slotIndex - b.slotIndex)
        .map((slot) => {
          const p = seedPlayer(slot.playerId);
          return {
            playerId: slot.playerId,
            name: nameOf(slot.playerId),
            position: p?.position ?? "MF",
            grade: p?.grade ?? "BRONZE",
          };
        }),
    },
    scoreH1Home: match.scoreH1Home,
    scoreH1Away: match.scoreH1Away,
    // 후반 스코어는 FINISHED 전까지 내보내지 않는다(재생 중 스포일러 금지 — 실서버와 같은 규칙).
    scoreHome: match.state === "FINISHED" ? match.scoreHome : null,
    scoreAway: match.state === "FINISHED" ? match.scoreAway : null,
    result,
    mode: "practice",
    ownerName: getState().user?.nickname ?? null,
    homeName: getState().user?.nickname ?? null,
    awayName: bot.name,
    userDeckSnapshot: deckSnapshot(match),
    clock: live
      ? {
          phase: match.state,
          kickoffAt: match.kickoffMs ? iso(match.kickoffMs) : null,
          phaseStartAt: match.phaseStartMs ? iso(match.phaseStartMs) : null,
          phaseEndsAt: match.phaseEndsMs ? iso(match.phaseEndsMs) : null,
          serverNow: iso(Date.now()),
          halfRealMs: match.playbackMs[half] ?? 60_000,
          halftimeMs: HALFTIME_MS,
          seekForwardBlocked: SEEK_FORWARD_BLOCKED,
          seekGraceMs: 3000,
        }
      : null,
  };
}

function deckSnapshot(match: StaticMatch): unknown {
  const toSlot = (s: StaticDeck["slots"][number]) => ({
    playerId: s.playerId,
    slotIndex: s.slotIndex,
    promptText: s.promptText ?? null,
  });
  return {
    formation: match.deck.formation,
    teamPrompt: match.deck.teamPrompt ?? null,
    starters: effectiveStarters(match).map(toSlot),
    bench: match.deck.slots.filter((s) => s.role === "bench").map(toSlot),
    teamTactics: null,
  };
}

function halfLog(match: StaticMatch, half: 1 | 2): MatchLog {
  const session = ensureSession(match);
  if (half === 1) return session.half1.matchLog;
  if (!session.half2) fail(404, "NOT_FOUND", "후반 로그가 아직 없습니다");
  return session.half2.matchLog;
}

/* ─────────────────────────────── 라우터 ─────────────────────────────── */

type Handler = (ctx: { body: unknown; params: string[]; query: URLSearchParams }) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  const pattern = new RegExp(`^${path.replace(/\{[^}]+\}/g, "([^/]+)")}$`);
  routes.push({ method, pattern, handler });
}

/* 인증 --------------------------------------------------------------- */

route("POST", "/api/auth/login", ({ body }) => {
  const b = (body ?? {}) as { nickname?: string; provider?: string };
  const isNew = getState().user === null;
  const s = ensureUser(b.nickname?.trim() || "게스트", b.provider ?? "guest");
  grantStarter();
  return { token: `static.${s.user!.id}`, user: { id: s.user!.id, nickname: s.user!.nickname }, isNew };
});
route("POST", "/api/auth/register", ({ body }) => {
  const b = (body ?? {}) as { nickname?: string };
  const isNew = getState().user === null;
  const s = ensureUser(b.nickname?.trim() || "게스트", "local");
  grantStarter();
  return { token: `static.${s.user!.id}`, user: { id: s.user!.id, nickname: s.user!.nickname }, isNew };
});

/* 부트스트랩 --------------------------------------------------------- */

route("GET", "/api/config", () => appConfig());
route("GET", "/api/me", () => meResponse());
route("GET", "/api/modes", () => [
  { id: "single", available: true },
  { id: "multi", available: false, label: "준비중" },
]);
route("GET", "/api/players", () => catalogPlayers());
route("GET", "/api/me/starter-grant", () => {
  const id = getState().starterGrantId;
  const p = id ? seedPlayer(id) : undefined;
  if (!p) return { granted: false, player: null };
  return {
    granted: true,
    player: { id: p.id, name: p.name, position: p.position, grade: p.grade, attributes: p.attributes },
  };
});
route("POST", "/api/me/tutorial-complete", () => {
  const s = getState();
  const deckGranted = s.deck === null;
  if (s.user) s.user.tutorialDone = true;
  s.deck ??= autoDeck();
  save();
  return { tutorialDone: true, deckGranted };
});
route("GET", "/api/me/record", () => {
  const u = getState().user;
  return {
    records: { wins: u?.wins ?? 0, draws: u?.draws ?? 0, losses: u?.losses ?? 0 },
    rating: u?.rating ?? 0,
    personalRecords: { totalMatches: (u?.wins ?? 0) + (u?.draws ?? 0) + (u?.losses ?? 0) },
  };
});

/* 덱·프리셋 ---------------------------------------------------------- */

route("GET", "/api/deck", () => {
  const s = getState();
  if (!s.deck) fail(404, "NOT_FOUND", "덱이 없습니다");
  return s.deck;
});
route("PUT", "/api/deck", ({ body }) => {
  const b = (body ?? {}) as { formation?: string; teamPrompt?: string | null; slots?: StaticDeck["slots"] };
  const slots = b.slots ?? [];
  const starters = slots.filter((s) => s.role === "starter");
  if (starters.length !== 11) fail(400, "DECK_INVALID", "선발은 11명이어야 합니다");
  const s = getState();
  s.deck = {
    id: s.deck?.id ?? newId(),
    formation: b.formation ?? "4-4-2",
    teamPrompt: b.teamPrompt ?? null,
    slots,
    updatedAt: iso(Date.now()),
  };
  save();
  return s.deck;
});
route("GET", "/api/presets", () => getState().presets);
route("POST", "/api/presets", ({ body }) => {
  const b = (body ?? {}) as { name?: string; promptText?: string };
  const preset = {
    id: newId(),
    name: b.name ?? "프리셋",
    promptText: b.promptText ?? "",
    createdAt: iso(Date.now()),
  };
  getState().presets.push(preset);
  save();
  return preset;
});
route("DELETE", "/api/presets/{id}", ({ params }) => {
  const s = getState();
  s.presets = s.presets.filter((p) => p.id !== params[0]);
  save();
  return undefined;
});
route("GET", "/api/presets/team", () => []);
route("GET", "/api/relations", () => ({
  morale: 60,
  streak: 0,
  players: Object.keys(getState().owned).map((id) => ({
    playerId: id,
    trust: 60,
    personality: seedPlayer(id)?.personality ?? "CALM",
  })),
}));
route("GET", "/api/conditions/today", () => {
  const out: Record<string, number> = {};
  for (const id of Object.keys(getState().owned)) out[id] = 0.9 + nextRandom() * 0.2;
  return out;
});

/* 경기 --------------------------------------------------------------- */

route("GET", "/api/me/active-match", () => {
  const s = getState();
  if (!s.match) return { match: null, locked: false, abandonable: false };
  advance(s.match);
  const done = s.match.state === "FINISHED" || s.match.state === "ABANDONED";
  if (done) return { match: null, locked: false, abandonable: false };
  return { match: matchDetail(s.match), locked: true, abandonable: true };
});

route("POST", "/api/matches", ({ body }) => {
  const s = getState();
  if (s.match && s.match.state !== "FINISHED" && s.match.state !== "ABANDONED") {
    fail(409, "MATCH_IN_PROGRESS", "진행 중인 매치가 있습니다", {
      matchId: s.match.id,
      state: s.match.state,
      action: "create",
    });
  }
  if (!s.deck) fail(400, "DECK_INVALID", "덱을 먼저 구성하세요");
  const b = (body ?? {}) as { botId?: string | null };
  const bot = pickBot(b.botId);
  const match: StaticMatch = {
    id: newId(),
    botId: bot.id,
    state: "BRIEFING",
    createdAt: iso(Date.now()),
    auto: false,
    seed: String(Math.floor(nextRandom() * 4_294_967_296)),
    selectData: buildSelectData(s.deck, bot, s.user?.nickname ?? "나의 팀"),
    homeInput: null,
    awayInput: null,
    homeInput2: null,
    awayInput2: null,
    prompts: { pre: { team: "", players: {} }, halftime: { team: "", players: {} } },
    deck: JSON.parse(JSON.stringify(s.deck)) as StaticDeck,
    substitutions: [],
    scoreH1Home: null,
    scoreH1Away: null,
    scoreHome: null,
    scoreAway: null,
    phaseStartMs: null,
    phaseEndsMs: null,
    kickoffMs: null,
    playbackMs: { 1: null, 2: null },
    aiGenerated: false,
  };
  s.match = match;
  sessions.clear();
  save();
  return matchDetail(match);
});

function currentMatch(id: string): StaticMatch {
  const s = getState();
  if (!s.match || s.match.id !== id) fail(404, "NOT_FOUND", "매치를 찾을 수 없습니다");
  return s.match;
}

route("GET", "/api/matches/{id}", ({ params }) => {
  const match = currentMatch(params[0]!);
  advance(match);
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/prompts", ({ params, body }) => {
  const match = currentMatch(params[0]!);
  const b = (body ?? {}) as { phase?: "pre" | "halftime"; scope?: "team" | "player"; playerId?: string; text?: string };
  const bucket = match.prompts[b.phase === "halftime" ? "halftime" : "pre"];
  if (b.scope === "player" && b.playerId) bucket.players[b.playerId] = b.text ?? "";
  else bucket.team = b.text ?? "";
  save();
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/kickoff", ({ params }) => {
  const match = currentMatch(params[0]!);
  if (match.state !== "BRIEFING") fail(409, "INVALID_STATE", "이미 시작된 경기입니다");
  // 브리핑 화면의 편집(라인업·포메이션·선수 지시)은 **덱에 저장**되고 킥오프에 반영된다 —
  // 화면이 그렇게 말한다(AC-B2). 생성 시점 스냅샷을 그대로 쓰면 그 문장이 거짓말이 된다.
  const deck = getState().deck;
  if (deck) match.deck = JSON.parse(JSON.stringify(deck)) as StaticDeck;
  match.state = "GEN1";
  save();
  advance(match);
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/resume", ({ params }) => {
  const match = currentMatch(params[0]!);
  if (match.state !== "HALFTIME") fail(409, "INVALID_STATE", "감독시간이 아닙니다");
  match.state = "GEN2";
  save();
  advance(match);
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/auto", ({ params, body }) => {
  const match = currentMatch(params[0]!);
  match.auto = Boolean((body as { auto?: boolean } | null)?.auto);
  save();
  advance(match);
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/halftime", ({ params, body }) => {
  const match = currentMatch(params[0]!);
  const b = (body ?? {}) as {
    substitutions?: { out: string; in: string }[];
    formation?: string;
    starters?: { playerId: string; slotIndex: number; promptText?: string | null }[];
  };
  if (b.substitutions) {
    if (b.substitutions.length > 3) fail(400, "SUBSTITUTION_INVALID", "교체는 3명까지입니다");
    match.substitutions = b.substitutions;
  }
  if (b.formation && b.starters) {
    match.deck = {
      ...match.deck,
      formation: b.formation,
      slots: [
        ...b.starters.map((s) => ({
          playerId: s.playerId,
          role: "starter" as const,
          slotIndex: s.slotIndex,
          promptText: s.promptText ?? null,
        })),
        ...match.deck.slots.filter((s) => s.role === "bench"),
      ],
    };
    match.substitutions = [];
  }
  save();
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/skip", ({ params, body }) => {
  const match = currentMatch(params[0]!);
  const phase = (body as { phase?: string } | null)?.phase;
  if (phase !== match.state) fail(409, "INVALID_STATE", "이미 다음 단계입니다");
  match.phaseEndsMs = Date.now();
  advance(match);
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/abandon", ({ params }) => {
  const match = currentMatch(params[0]!);
  match.state = "ABANDONED";
  match.phaseEndsMs = null;
  save();
  return matchDetail(match);
});

route("POST", "/api/matches/{id}/retry", ({ params }) => matchDetail(currentMatch(params[0]!)));

route("GET", "/api/matches/{id}/halves/{half}/log", ({ params }) => {
  const match = currentMatch(params[0]!);
  const half = params[1] === "2" ? 2 : 1;
  return halfLog(match, half);
});

route("GET", "/api/matches/{id}/result", ({ params }) => {
  const match = currentMatch(params[0]!);
  if (match.state !== "FINISHED") fail(409, "INVALID_STATE", "아직 끝나지 않았습니다");
  const home = match.scoreHome ?? 0;
  const away = match.scoreAway ?? 0;
  const result = home > away ? "WIN" : home === away ? "DRAW" : "LOSS";
  return {
    matchId: match.id,
    scoreHome: home,
    scoreAway: away,
    result,
    pointsAwarded: SEED_ECONOMY.rewards[result === "WIN" ? "win" : result === "DRAW" ? "draw" : "loss"],
  };
});

/* 상점(뽑기) --------------------------------------------------------- */

function rollGrade(): string {
  const rates = SEED_ECONOMY.gacha.rates;
  let r = nextRandom();
  for (const [grade, p] of Object.entries(rates)) {
    r -= p;
    if (r <= 0) return grade;
  }
  return "BRONZE";
}

route("POST", "/api/shop/gacha", ({ body }) => {
  const s = getState();
  if (!s.user) fail(401, "UNAUTHORIZED", "로그인이 필요합니다");
  const kind = (body as { kind?: string } | null)?.kind === "ten" ? "ten" : "single";
  const cost = kind === "ten" ? SEED_ECONOMY.gacha.tenCost : SEED_ECONOMY.gacha.singleCost;
  if (s.user.gems < cost) fail(400, "INSUFFICIENT_POINTS", "젬이 부족합니다");
  s.user.gems -= cost;
  const count = kind === "ten" ? SEED_ECONOMY.gacha.tenCount : 1;
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const grade = rollGrade();
    const pool = OPEN_PLAYERS.filter((p) => p.grade === grade);
    const pick = (pool.length ? pool : OPEN_PLAYERS)[Math.floor(nextRandom() * (pool.length || OPEN_PLAYERS.length))]!;
    const isNew = (s.owned[pick.id] ?? 0) === 0;
    s.owned[pick.id] = (s.owned[pick.id] ?? 0) + 1;
    results.push({
      player: {
        id: pick.id,
        name: playerNameOf(pick, "full"),
        position: pick.position,
        grade: pick.grade,
        attributes: pick.attributes,
        owned: true,
        ownedCount: s.owned[pick.id]!,
      },
      isNew,
    });
  }
  save();
  return { results, wallet: { points: s.user.points, gems: s.user.gems } };
});

/* 이 데모가 다루지 않는 메타 — 빈 응답(원칙 2) ------------------------ */

const EMPTY_ROUTES: [string, string, unknown][] = [
  ["GET", "/api/notices/active", []],
  ["GET", "/api/missions/daily", { missions: [] }],
  ["GET", "/api/me/away-reports", { reports: [], summary: null, unseen: 0 }],
  ["POST", "/api/me/away-reports/ack", { acked: 0 }],
  ["GET", "/api/trade", { slots: [], wallet: { points: 0, gems: 0 } }],
  ["GET", "/api/league", { season: null }],
  ["GET", "/api/league/rankings", { leaderboard: [], me: null }],
  ["GET", "/api/away/rankings", { leaderboard: [], me: null }],
  ["GET", "/api/away/revenge", { reports: [] }],
  ["GET", "/api/away/candidates", { candidates: [], streak: 0, seasonNo: 0, seasonEndsAt: "", remainingToday: 0 }],
  ["GET", "/api/rankings", { leaderboard: [], me: null, personalRecords: {} }],
  ["GET", "/api/logs/matches", []],
  ["GET", "/api/logs/trades", []],
  ["GET", "/api/mails", { mails: [] }],
  ["GET", "/api/growth/choices", { choices: [] }],
];
for (const [method, path, value] of EMPTY_ROUTES) route(method, path, () => value);

/* ─────────────────────────────── 진입점 ─────────────────────────────── */

/** 이 요청은 브라우저 안에서 끝난다. `apiFetch` 가 네트워크 대신 이 함수를 부른다. */
export async function handleStaticRequest<T>(
  path: string,
  method: string,
  body: unknown,
): Promise<T> {
  const url = new URL(path, "http://static.local");
  const pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const out = r.handler({ body, params: m.slice(1), query: url.searchParams });
    return (out instanceof Promise ? await out : out) as T;
  }
  fail(404, "NOT_FOUND", `스태틱 데모 빌드에는 ${method} ${pathname} 이 없습니다`);
}
