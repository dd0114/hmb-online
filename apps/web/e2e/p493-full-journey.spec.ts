import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";
import { skipSplash } from "./splash-mock";

/**
 * #493 W8-v3 — **온레일 튜토리얼 풀 저니** (route-mock · 390×844 · 실터치).
 *
 * SoT = `evidence/493/W7v3-scenario-storyboard.html`(hero 승인) 의 S0~S7 **한 줄기**.
 * 구 버전(W4)은 리플랜 v2 이전의 여정이었다 — 가입 → 코치마크 → 덱저장/뽑기/트레이드를 **각자
 * 따로** 밟고 우편함에서 만났다. 리플랜 v3 는 그 낱개들을 **온레일 한 줄기**로 묶었으므로
 * (hero: *"거의 정해진화면에서 유저가 선택할 여유가 없이 강제해야돼"*) 여정도 그 줄기를 걷는다.
 *
 * ## 이 스펙이 `p493-onrail.spec.ts` 와 갈리는 지점
 *
 * 그쪽은 **스텝별 계약**(막는가 · 행동을 요구하는가 · 기다리는가 · 가두지 않는가)을 하나씩 문다.
 * 여기서 보는 것은 하나뿐이다 — **신규 유저가 처음부터 끝까지 실제로 걸어갈 수 있는가.**
 * 그래서 중간에 한 칸이라도 못 넘어가면 이 스펙은 실패해야 한다(그게 유저가 갇히는 자리다).
 *
 * ## 목은 **실서버 형상**이다 (#342 규율)
 *
 * 특히 **경제 수치를 낮춰 잡지 않는다** — 신규 유저 지갑(`economy.v4.initialPoints` 3,000),
 * 노말 다이스 비용(5,000 G), 첫 트레이드 등급 DIA 의 대기(48h → 단축 24,000 G)를 **운영값
 * 그대로** 쓴다. 여기서 "테스트 편의로" 잔액을 올리면 이 여정은 **아무도 못 걷는 길을 초록으로
 * 통과**한다(실제로 그 두 자리가 이번 웨이브의 blocker 였다 — 무료 쿠폰이 있는데 화면이 잔액으로
 * 잠갔다).
 *
 * ⚠️ 라우트 매칭은 **오리진 앵커**(pathname 술어) — glob 은 vite 소스까지 먹어 흰 화면이 된다.
 */

const PHONE = { width: 390, height: 844 };
const USER_ID = "u493w8";
const MATCH_ID = "m493w8";
/** 스타터에 고정으로 들어오는 튜토리얼 카드 (`hmb.tutorial.starter.card-id`). */
const TUTORIAL_CARD = "P122";

/**
 * 운영 경제값 — **발행물에서 읽는다**(상수로 베끼지 않는다).
 *
 * ⚠️ 이 스펙의 존재 이유가 *"경제 수치를 낮춰 잡지 않는다"* 인데, 그 보증을 수기 상수에 걸면
 * `economy.v4.json` 이 바뀌는 날 스펙은 **낡은 값으로 조용히 초록**이 되고 가드가 실효한다
 * (독립 검증 1R minor-2 — 리포 메모리 `hand-measured-numbers-go-stale` 부류). 그래서 파일이 SoT 다.
 */
const ECONOMY = JSON.parse(
  readFileSync(new URL("../../../data/players/economy.v4.json", import.meta.url).pathname, "utf8"),
) as {
  initialPoints: number;
  initialGems: number;
  dice: { normalCost: number };
  rewards: { byMode: { practice: { win: number } } };
  trade: { waitHours: Record<string, number>; speedup: { pointsPerHour: number; minPoints: number } };
};
const INITIAL_POINTS = ECONOMY.initialPoints;
const INITIAL_GEMS = ECONOMY.initialGems;
const DICE_NORMAL_COST = ECONOMY.dice.normalCost;
/** 연습경기 승리 보상 — 튜토리얼 매치도 `mode='practice'` 다(모드 값을 늘리지 않았다, W6-v3). */
const WIN_POINTS = ECONOMY.rewards.byMode.practice.win;
/**
 * 튜토리얼 첫 오퍼는 **DIA 확정**(`hmb.tutorial.trade.first-grade`)이라 대기가 그 등급의 것이다.
 * 식은 서버와 같다 — `TradeService.speedupCost` = `max(minPoints, ceil(시간 × pointsPerHour))`.
 */
const SPEEDUP_COST = Math.max(
  ECONOMY.trade.speedup.minPoints,
  Math.ceil((ECONOMY.trade.waitHours.DIA ?? 1) * ECONOMY.trade.speedup.pointsPerHour),
);

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** 관전 무대가 실제로 서려면 진짜 로그가 있어야 한다(`p493-onrail` 과 같은 픽스처·같은 이유). */
const HALF_LOG = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
) as unknown;

const TITLES: Record<string, string> = {
  TUTORIAL_DONE: "튜토리얼 완주 보상",
  FIRST_RESULT_VIEW: "첫 경기 결과 확인 보상",
  FIRST_DECK_SAVE: "첫 스쿼드 저장 보상",
  FIRST_ENHANCE: "첫 강화 보상",
  FIRST_TRADE: "첫 트레이드 보상",
};

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

/**
 * 스타터 지급 결과 — `economy.v4.starterPack`(14종) + starterTop 1종 = **15명**.
 * 튜토리얼 카드(P122)는 그 팩 안에 있고 **장수만** 1 + `star.copies[2]`(2) = 3 으로 온다.
 */
const PACK = ["P074", "P161", "P077", "P078", "P079", "P080", TUTORIAL_CARD, "P093", "P094",
  "P095", "P096", "P106", "P107", "P108", "P900"];
const POSITIONS: Record<string, string> = {};
["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW", "DF", "MF", "FW", "FW"].forEach(
  (pos, i) => { POSITIONS[PACK[i]!] = pos; },
);
const OWNED = PACK.map((id) => ({
  id,
  name: `선수${id}`,
  position: POSITIONS[id],
  grade: id === TUTORIAL_CARD ? "BRONZE" : "SILVER",
  owned: true,
  // 튜토리얼 카드만 3장(승급 재료) — 나머지는 1장.
  ownedCount: id === TUTORIAL_CARD ? 3 : 1,
  attributes: attrs(60),
  active: true,
  personality: "CALM",
}));

/**
 * 온보딩 완료가 지급하는 덱 — **선발 11 + 벤치 4**(`StarterDeckBuilder`, benchMax 7 이지만 보유가
 * 15 명이라 4 명만 앉는다).
 *
 * ⚠️ 이 모양이 **S2 AUTO 스텝의 운명을 정한다** — `hasEmptySlotGap` 은 선발 빈칸 또는 벤치 앞
 * `BENCH_GAP_SLOTS`(3) 칸의 빈칸을 보는데, 여기서는 둘 다 차 있다 = `auto-fill` 이 **뜨지 않는다**.
 */
const STARTERS = PACK.slice(0, 11);
const BENCH = PACK.slice(11);
const DECK = {
  id: "d493",
  formation: "4-4-2",
  teamPrompt: null,
  slots: [
    ...STARTERS.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    ...BENCH.map((playerId, i) => ({ playerId, role: "bench", slotIndex: i, promptText: null })),
  ],
};

/** 스타터 XP 프리필이 남긴 3지선다 — W6-v3 "강화 1회 가능"의 정의(정확히 1장). */
interface Pending {
  choiceId: string;
  playerId: string;
  level: number;
  candidates: { stat: string; gain: number; core?: boolean }[];
}

interface Journey {
  /** 우편 캠페인 — 서버와 같은 축(액션당 1통, 반복 무증가). */
  granted: Set<string>;
  pendingChoices: Pending[];
  mails: { id: string; action: string; claimed: boolean }[];
  points: number;
  gems: number;
  /** `/api/me.coupons` — 0 인 종류도 키가 산다(W6-v3 계약). */
  coupons: Record<string, number>;
  deck: { formation: string; slots: unknown[]; teamPrompt: string | null };
  /** `POST /api/matches` 요청 바디 기록 — `{tutorial:true}` 의 증거. */
  creates: unknown[];
  matchState: string;
  acked: string[];
  star: number;
  potentialUnlocked: boolean;
  diceCalls: { kind: string }[];
  /** 단축에 실제로 나간 금액(서버 `spent`) — 쿠폰이면 0. */
  speedupSpent: number | null;
  trade: { state: string; offerKind: string | null; revealed: boolean };
  tradeStarts: number;
}

function mailView(m: Journey["mails"][number]) {
  return {
    id: m.id,
    title: TITLES[m.action],
    body: "행동 보상이 도착했습니다. 받아 주세요.",
    attachments: { points: 0, gems: 300, players: [] },
    sentAt: "2026-08-13T00:00:00Z",
    expiresAt: null,
    readAt: m.claimed ? "2026-08-13T01:00:00Z" : null,
    claimedAt: m.claimed ? "2026-08-13T01:00:00Z" : null,
    state: m.claimed ? "CLAIMED" : "UNREAD",
  };
}

function cardOf(j: Journey) {
  const base = attrs(60);
  const caps = Object.fromEntries(Object.keys(base).map((k) => [k, 73]));
  return {
    playerId: TUTORIAL_CARD,
    grade: "BRONZE",
    star: j.star,
    attributes: base,
    prePotential: base,
    base,
    caps,
    statAdd: {},
    cardLevel: 2,
    cardXp: 10,
    xpToNext: 200,
    maxLevel: 40,
    growCeil: 72,
    starCeilBonus: 1,
    attrHardCap: 99,
    startLo: 40,
    pendingChoices: j.pendingChoices,
    statLevels: Object.fromEntries(Object.keys(base).map((k) => [k, { lv: 1, xp: 20 }])),
    potential: {
      unlocked: j.potentialUnlocked,
      tier: "RARE",
      maxTier: "RARE",
      lines: j.potentialUnlocked
        ? [{ slot: 1, tier: "RARE", type: "STAT_PCT", stat: "pace", value: 3 }]
        : [],
      rollsSinceTierUp: 0,
      ceilingAt: 9,
    },
    ovr: 55,
    completion: 0.2,
  };
}

async function mockJourney(page: Page, opts: { deckReady?: boolean } = {}): Promise<Journey> {
  const j: Journey = {
    granted: new Set(),
    mails: [],
    points: INITIAL_POINTS,
    gems: INITIAL_GEMS,
    // 가입 tx 가 심는 세 장(W6-v3 `TutorialStarterService`).
    coupons: { FREE_ENHANCE: 1, FREE_TRADE_RUSH: 1, FIRST_TRADE_EPIC: 1 },
    deck: { formation: DECK.formation, slots: DECK.slots, teamPrompt: null },
    creates: [],
    matchState: "FIRST_HALF",
    acked: [],
    star: 1,
    potentialUnlocked: false,
    diceCalls: [],
    speedupSpent: null,
    trade: { state: "IDLE", offerKind: null, revealed: false },
    tradeStarts: 0,
    pendingChoices: [
      {
        choiceId: "tc1",
        playerId: TUTORIAL_CARD,
        level: 2,
        candidates: [
          { stat: "pace", gain: 2.0, core: true },
          { stat: "passing", gain: 1.8, core: true },
          { stat: "tackling", gain: 2.4, core: false },
        ],
      },
    ],
  };
  const grant = (action: string) => {
    if (j.granted.has(action)) return;
    j.granted.add(action);
    j.mails.push({ id: `M-${action}`, action, claimed: false });
  };
  // 온보딩을 이미 끝낸 계정으로 시작하는 시나리오(여정 밖 스펙)는 덱이 서 있다.
  let deckExists = opts.deckReady === true;

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req: Request = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();

    if (p === "/api/me") {
      return route.fulfill(json({
        user: { id: USER_ID, nickname: "여정감독", tutorialDone: deckExists },
        wallet: { points: j.points, gems: j.gems },
        // 서버 실물 그대로 — `records{wins,draws,losses}`(`MeController` 머리말), `mail{unread,total}`
        // (둘 다 필수다 — `total` 이 없으면 우편함 진입점이 서버가 만들 수 없는 상태로 그려진다).
        records: { wins: 0, draws: 0, losses: 0 },
        rating: 1000,
        coupons: { ...j.coupons },
        mail: {
          unread: j.mails.filter((m) => !m.claimed).length,
          total: j.mails.length,
        },
      }));
    }
    if (p === "/api/auth/register") {
      return route.fulfill(json({ token: "tok_w8", user: { id: USER_ID, nickname: "여정감독" }, isNew: true }));
    }
    if (p === "/api/me/starter-grant") return route.fulfill(json({ granted: false, player: null }));
    if (p === "/api/me/tutorial-complete") {
      // 서버 훅 ①(`OnboardingService`) — ⚠️ 완주 보상은 **온레일 완주가 아니라 여기서** 태워진다.
      grant("TUTORIAL_DONE");
      deckExists = true;
      return route.fulfill(json({ tutorialDone: true, deckGranted: true, deck: DECK }));
    }
    if (p === "/api/players") return route.fulfill(json(OWNED));
    if (p === "/api/presets") return route.fulfill(json([]));
    if (p === "/api/presets/team") {
      return route.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null }))));
    }
    if (p === "/api/relations") return route.fulfill(json({ morale: 60, streak: 0, players: [] }));
    if (p === "/api/conditions/today") {
      return route.fulfill(json(Object.fromEntries(OWNED.map((o, i) => [o.id, 0.3 + (i % 5) * 0.15]))));
    }
    if (p === "/api/me/active-match") {
      const live = j.matchState !== "FINISHED" && j.creates.length > 0;
      return route.fulfill(json({
        match: live ? { id: MATCH_ID, state: j.matchState } : null,
        locked: false,
        abandonable: live,
      }));
    }
    if (p === "/api/deck") {
      if (method === "PUT") {
        const b = req.postDataJSON();
        j.deck = { formation: b.formation, slots: b.slots, teamPrompt: b.teamPrompt ?? null };
        grant("FIRST_DECK_SAVE"); // 서버 훅 ③(`DeckController`)
        deckExists = true;
      }
      return deckExists
        ? route.fulfill(json({ id: DECK.id, ...j.deck }))
        : route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404));
    }

    // ── 매치 ────────────────────────────────────────────────────────────
    if (p === "/api/matches" && method === "POST") {
      j.creates.push(req.postDataJSON() ?? {});
      // 서버는 **201** 로 만든다(`MatchController.create`) — 목이 200 이면 여정이 겪지 않는 응답이다.
      return route.fulfill(json(matchDetail(j), 201));
    }
    if (p === `/api/matches/${MATCH_ID}`) return route.fulfill(json(matchDetail(j)));
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(p)) return route.fulfill(json(HALF_LOG));
    if (p === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill(json({
        matchId: MATCH_ID,
        scoreHome: 4, scoreAway: 2, result: "WIN", pointsAwarded: 500,
        rewardBundle: {
          bundleId: "B493w8", source: "MATCH", sourceRef: MATCH_ID,
          acknowledgedAt: j.acked.length > 0 ? "2026-08-13T01:00:00Z" : null,
          sections: [{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 500 }] }],
        },
      }));
    }
    if (/^\/api\/rewards\/[^/]+\/ack$/.test(p)) {
      const id = req.url().split("/api/rewards/")[1]!.split("/")[0]!;
      if (j.acked.length === 0) {
        j.points += WIN_POINTS;      // 승리 보상(practice win) — 그래도 다이스 비용에 못 미친다.
        grant("FIRST_RESULT_VIEW");  // 서버 훅 ②(`RewardBundleService`)
      }
      j.acked.push(id);
      return route.fulfill(json({
        bundleId: "B493w8", source: "MATCH", sourceRef: MATCH_ID,
        acknowledgedAt: "2026-08-13T01:00:00Z",
        sections: [{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 500 }] }],
      }));
    }

    // ── 성장 ────────────────────────────────────────────────────────────
    if (p === "/api/growth/choices" && method === "GET") {
      return route.fulfill(json({ choices: j.pendingChoices }));
    }
    if (p === `/api/growth/card/${TUTORIAL_CARD}`) return route.fulfill(json(cardOf(j)));
    if (/^\/api\/growth\/choices\/[^/]+$/.test(p) && method === "POST") {
      const id = p.split("/").pop()!;
      const idx = j.pendingChoices.findIndex((c) => c.choiceId === id);
      if (idx < 0) return route.fulfill(json({ code: "CHOICE_ALREADY_MADE", message: "이미 선택했습니다" }, 409));
      const body = req.postDataJSON() as { stat: string };
      const cand = j.pendingChoices[idx]!.candidates.find((c) => c.stat === body.stat);
      if (!cand) return route.fulfill(json({ code: "VALIDATION_ERROR", message: "후보 밖" }, 400));
      j.pendingChoices.splice(idx, 1);
      return route.fulfill(json({
        choiceId: id, playerId: TUTORIAL_CARD, level: 2, stat: body.stat, gain: cand.gain,
        card: cardOf(j),
      }));
    }
    if (p === "/api/growth/star" && method === "POST") {
      // 승급 재료 = **중복 카드**(골드가 아니다 — 스토리보드 조정 ③ 이 어긋나는 지점).
      j.star += 1;
      j.potentialUnlocked = j.star >= 2;
      return route.fulfill(json({
        playerId: TUTORIAL_CARD, star: j.star, spentCopies: 2,
        potentialUnlocked: j.potentialUnlocked, maxTier: "RARE",
      }));
    }
    if (p === "/api/growth/dice" && method === "POST") {
      const body = req.postDataJSON() as { kind: "NORMAL" | "CASH" };
      if (!j.potentialUnlocked) {
        return route.fulfill(json({ code: "POTENTIAL_LOCKED", message: "2★부터 가능합니다" }, 400));
      }
      // W6-v3: 쿠폰이 있으면 **잔액을 보지 않는다**(서버가 명시). 없으면 잔액 검사 후 차감.
      const free = body.kind === "NORMAL" && (j.coupons.FREE_ENHANCE ?? 0) > 0;
      if (free) j.coupons.FREE_ENHANCE = (j.coupons.FREE_ENHANCE ?? 0) - 1;
      else if (body.kind === "NORMAL") {
        if (j.points < DICE_NORMAL_COST) {
          return route.fulfill(json({ code: "INSUFFICIENT_POINTS", message: "골드가 부족합니다" }, 400));
        }
        j.points -= DICE_NORMAL_COST;
      }
      j.diceCalls.push({ kind: body.kind });
      grant("FIRST_ENHANCE"); // 서버 훅 ⑥(`GrowthService`)
      return route.fulfill(json({
        playerId: TUTORIAL_CARD, kind: body.kind,
        tierBefore: "RARE", tierAfter: "RARE", tierUp: false, byCeiling: false,
        lines: [{ slot: 1, tier: "RARE", type: "STAT_PCT", stat: "pace", value: 5 }],
        rollsSinceTierUp: 1, ceilingAt: 9,
        wallet: { points: j.points, gems: j.gems },
        freeByCoupon: free,
      }));
    }

    // ── 트레이드 ────────────────────────────────────────────────────────
    if (p === "/api/trade" && method === "GET") return route.fulfill(json(tradeView(j)));
    if (p === "/api/trade/1/start" && method === "POST") {
      j.tradeStarts += 1;
      // 첫 트레이드 = 등급 확정(FIRST_TRADE_EPIC 소비) + DIA 대기(48h).
      if ((j.coupons.FIRST_TRADE_EPIC ?? 0) > 0) j.coupons.FIRST_TRADE_EPIC -= 1;
      j.trade = { state: "WAITING", offerKind: "TRADE", revealed: false };
      grant("FIRST_TRADE"); // 서버 훅 ⑤(`TradeService`)
      return route.fulfill(json({ slot: slotView(j), wallet: { points: j.points, gems: j.gems } }));
    }
    if (p === "/api/trade/1/speedup" && method === "POST") {
      const free = (j.coupons.FREE_TRADE_RUSH ?? 0) > 0;
      if (free) j.coupons.FREE_TRADE_RUSH -= 1;
      else if (j.points < SPEEDUP_COST) {
        return route.fulfill(json({ code: "INSUFFICIENT_POINTS", message: "골드가 부족합니다" }, 402));
      } else j.points -= SPEEDUP_COST;
      j.speedupSpent = free ? 0 : SPEEDUP_COST;
      j.trade = { state: "OPEN", offerKind: "TRADE", revealed: true };
      return route.fulfill(json({
        slot: slotView(j), wallet: { points: j.points, gems: j.gems }, spent: j.speedupSpent,
      }));
    }
    if (p === "/api/trade/1/accept" && method === "POST") {
      j.trade = { state: "IDLE", offerKind: null, revealed: false };
      return route.fulfill(json({
        slot: slotView(j), wallet: { points: j.points, gems: j.gems },
        result: "SUCCESS", gainedPlayerId: "P200", lostPlayerIds: ["P096"],
      }));
    }

    // ── 우편 ────────────────────────────────────────────────────────────
    if (p === "/api/mails") {
      return route.fulfill(json({
        mails: j.mails.map(mailView),
        unread: j.mails.filter((m) => !m.claimed).length,
      }));
    }
    if (/^\/api\/mails\/[^/]+\/claim$/.test(p)) {
      const id = req.url().split("/api/mails/")[1]!.split("/")[0]!;
      const mail = j.mails.find((m) => m.id === id);
      if (mail && !mail.claimed) {
        mail.claimed = true;
        j.gems += 300;
      }
      return route.fulfill(json({ applied: true, wallet: { points: j.points, gems: j.gems } }));
    }
    return route.fulfill(json({}));
  });
  // 다이스 가격도 발행물에서 온다 — `/api/config` 가 서버에서 그렇게 조립된다(`ConfigController.shopOf`).
  await mockAppConfig(page, {
    initialPoints: INITIAL_POINTS,
    initialGems: INITIAL_GEMS,
    diceNormalCost: DICE_NORMAL_COST,
  });
  return j;
}

function matchDetail(j: Journey) {
  const finished = j.matchState === "FINISHED";
  return {
    id: MATCH_ID,
    state: j.matchState,
    mode: "practice",
    /** W6-v3 additive — 온레일 정지·스킵 잠금과 하프타임 교체 차단이 이 불리언에 걸린다. */
    tutorial: true,
    auto: false,
    opponent: { name: "봇 FC", analysisText: "", deck: [] },
    createdAt: "2026-08-13T00:00:00Z",
    scoreH1Home: finished ? 1 : null, scoreH1Away: finished ? 1 : null,
    scoreHome: finished ? 4 : null, scoreAway: finished ? 2 : null,
    result: finished ? "WIN" : null,
  };
}

function slotView(j: Journey) {
  const waiting = j.trade.state === "WAITING";
  const open = j.trade.state === "OPEN";
  return {
    slot: 1,
    state: j.trade.state,
    offerKind: j.trade.offerKind,
    /*
     * 대기 중엔 등급만 공개(서버 마스킹). 단축 뒤에 정체가 열린다.
     * ⚠️ 키는 **`playerId`** 다(openapi `PlayerRef`) — `id` 로 쓰면 카탈로그 조회가 조용히 빗나가
     * 화면이 능력치 없는 카드를 그리고, 그 상태를 서버는 만들 수 없다(독립 검증 3R minor-2).
     */
    target: open
      ? { playerId: "P200", name: "다이아 유망주", position: "FW", grade: "DIA" }
      : null,
    demand: open ? { playerId: "P096", name: "선수P096", position: "MF", grade: "SILVER" } : null,
    targetGrade: waiting || open ? "DIA" : null,
    targetValue: null,
    // 서버 필드명은 `acceptProbability` 다(`TradeService:931`) — `prob` 은 이 리포에 없는 이름이었다.
    acceptProbability: open && j.trade.offerKind === "TRADE" ? 0.8 : null,
    opensAt: "2026-08-15T00:00:00Z",
    remainingSec: waiting ? 48 * 3600 : 0,
    speedupCost: waiting ? SPEEDUP_COST : null,
    speedupCurrency: waiting ? "POINT" : null,
  };
}

function tradeView(j: Journey) {
  return {
    wallet: { points: j.points, gems: j.gems },
    slots: [
      slotView(j),
      { slot: 2, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null, targetValue: null, acceptProbability: null, opensAt: null, remainingSec: 0, speedupCost: null, speedupCurrency: null },
      { slot: 3, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null, targetValue: null, acceptProbability: null, opensAt: null, remainingSec: 0, speedupCost: null, speedupCurrency: null },
    ],
  };
}

/**
 * 하프·경기 종료 **브릿지 리포트**(#421/#424)를 걷어낸다.
 *
 * 이 카드는 온레일 밖의 자기 모달이라 온레일이 비켜나 있고(`shieldFor`), 유저가 넘겨야 그 뒤의
 * 보상 시트·감독시간이 나온다. 여정은 유저가 하는 그대로 넘긴다(강제로 숨기지 않는다).
 */
async function passHalfReport(page: Page) {
  // 카드 스택은 셋이고 **이름이 다르다**: 하프 리포트(`half-report`) · 종료 브릿지(`flow-bridge`,
  // 리포트 없는 스택 — #421 i 계약이 둘을 섞지 않으려고 갈라 놨다) · 순차 보상(`match-reward`,
  // #456 S4 — 이 카드는 봉투를 ack 하지 않는다. 닫으면 #405 보상 시트가 그 자리에 이어서 뜬다).
  for (let i = 0; i < 12; i++) {
    const next = page.locator(
      '[data-testid="half-report-next"], [data-testid="flow-bridge-next"], [data-testid="match-reward-next"]',
    );
    if ((await next.count()) === 0) return;
    await next.first().tap();
    await page.waitForTimeout(300);
  }
}

/** 지금 떠 있는 온레일 스텝 id. */
async function stepId(page: Page): Promise<string | null> {
  const bubble = page.getByTestId("onrail-bubble");
  if ((await bubble.count()) === 0) return null;
  return bubble.first().getAttribute("data-step-id");
}

/**
 * 온보딩을 막 끝낸 계정 — 토큰 + 가이드 pending 래치(제안 모달의 발화 조건).
 * 여정 본편은 실제 가입을 지나지만, 그 앞 구간이 주제가 아닌 스펙은 여기서 출발한다.
 */
async function seedOnboardedUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);
}

async function expectStep(page: Page, id: string) {
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", id, { timeout: 20_000 });
}

test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

test("신규 유저 온레일 풀 저니 S0→S7 — 한 번도 갇히지 않고 걷는다 (실터치)", async ({ page }) => {
  // 뷰포트·터치 자기전제(#386 — 조용히 데스크탑으로 돌면 전부 초록이 된다).
  expect(page.viewportSize()).toEqual(PHONE);
  /*
   * **경제 자기전제** — 이 여정이 무료 쿠폰 경로를 실제로 태우려면 신규 유저가 두 값을 **못 내야**
   * 한다. 발행물이 바뀌어 낼 수 있게 되면 이 스펙은 통과하지만 **아무것도 검사하지 않는 상태**가
   * 되므로, 조용히 초록이 되는 대신 여기서 크게 깨진다(그때 할 일 = 시나리오 재검토).
   */
  expect(INITIAL_POINTS + WIN_POINTS,
    "신규 지갑이 다이스 비용을 감당하면 S5 쿠폰 경로가 검사되지 않는다").toBeLessThan(DICE_NORMAL_COST);
  expect(INITIAL_POINTS + WIN_POINTS,
    "신규 지갑이 단축 비용을 감당하면 S6 쿠폰 경로가 검사되지 않는다").toBeLessThan(SPEEDUP_COST);
  const j = await mockJourney(page);
  await skipSplash(page);
  test.setTimeout(180_000);

  // ── S0 가입 → 스타터 ────────────────────────────────────────────────────
  await page.goto("/login");
  await page.getByTestId("provider-local").tap();
  await page.getByTestId("local-mode-toggle").tap();
  await page.getByTestId("local-nickname").fill("journey493w8");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").tap();
  await page.getByTestId("starter-reveal-close").tap();

  // 온보딩 코치마크 완주 → 서버가 덱을 지급한다(= 온레일 S2 의 전제).
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  for (let i = 0; i < 12 && (await page.getByTestId("tutorial-overlay").count()) > 0; i++) {
    await page.getByTestId("tutorial-next").tap();
  }
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  /*
   * ⚠️ **완주 보상(`TUTORIAL_DONE`)이 여기서 이미 떨어진다** — 온레일을 한 발도 걷기 전에.
   * 리플랜 v2 가 W8 에 적어 둔 *"완주 보상 ① 재정의(= W5~W7 흐름 끝)"* 는 아직 이행되지 않았고,
   * 그래서 S7 말풍선의 "완주 보상 300 젬을 보냈습니다"는 **지금 보낸 것이 아니다**.
   * 이 단언은 그 사실을 박제한다(고치면 여기가 빨개져 여정을 다시 읽게 된다).
   */
  await expect.poll(() => j.granted.has("TUTORIAL_DONE"), { timeout: 10_000 }).toBe(true);

  // ── S1 게임 시작 → 튜토리얼 제안 모달 ────────────────────────────────────
  await page.getByTestId("home-tile-game").tap();
  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await page.getByTestId("practice-tutorial-accept").tap();
  await expect(page).toHaveURL(/\/deck$/);

  // ── S2 덱셋팅 ───────────────────────────────────────────────────────────
  /*
   * ⚠️ **W9 에서 뒤집혔다 — 그게 이 단언의 목적이었다.**
   *
   * W7-v3 는 이 자리에 *"AUTO 스텝은 실제 스타터 덱에서 한 번도 발화하지 않는다"* 를 박고
   * *"ⓐ 서버가 튜토리얼 시작 시 덱을 비우거나 ⓑ 시나리오가 AUTO 를 뺀다 — 둘 중 하나를 고르면
   * 이 단언이 빨개진다"* 고 적었다. W9 은 **ⓐ 의 클라 판**을 골랐다: 레일 시작이 이 화면의
   * 드래프트만 비운다(`PUT /api/deck` 없음 — 서버 덱은 유저가 [저장]할 때까지 그대로).
   * 그래서 각본 첫 칸이 실제로 발화하고, hero 지시("오토버튼 누르게 하고")가 성립한다.
   */
  await expectStep(page, "deck-auto");
  await expect(page.getByTestId("auto-fill")).toBeEnabled();
  await expect(page.getByTestId(`token-${STARTERS[0]}`)).toHaveCount(0); // 보드가 비어 있다
  await page.getByTestId("auto-fill").tap();
  await expectStep(page, "deck-player");

  // 폰은 토큰 탭이 **선수 메뉴**를 먼저 연다(#455 A2) — 온레일은 그 위에서 비켜난다.
  await page.getByTestId(`token-${STARTERS[0]}`).tap();
  await expect(page.getByTestId("player-menu")).toBeVisible();
  await page.getByTestId("pmenu-say").tap();
  await expectStep(page, "deck-prompt");

  const promptInput = page.getByTestId("rail-prompt-input");
  await expect(promptInput).toBeInViewport();
  await promptInput.fill("오늘 너만 믿는다");
  await promptInput.blur();
  await expectStep(page, "deck-save");

  await page.getByTestId("save-deck").tap();
  await expectStep(page, "deck-done");
  expect(j.granted.has("FIRST_DECK_SAVE")).toBe(true);
  const starters = (j.deck.slots as { role: string; promptText?: string | null }[])
    .filter((s) => s.role === "starter");
  expect(starters).toHaveLength(11);
  expect(starters.some((s) => (s.promptText ?? "").includes("오늘 너만 믿는다"))).toBe(true);

  // ── S3 경기 — 고정 매치 생성 + 화면 투어(정지·스킵 잠금) ───────────────────
  await page.getByTestId("onrail-next").tap(); // [경기 시작]
  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
  expect(j.creates).toHaveLength(1);
  expect(j.creates[0]).toMatchObject({ tutorial: true });

  // 투어 첫 스텝이 잡히면 [스킵]이 실제로 잠긴다(hero: "게임중에 바로 스킵 못누르게").
  await expectStep(page, "match-scoreboard");
  await expect(page.getByTestId("match-skip")).toBeDisabled();

  /*
   * 투어를 끝까지 민다 — 손잡이가 폰에서 없을 수 있는 스텝(시크바·정보 탭)은 각본이
   * `skipIfMissing` 이라 유예 뒤 스스로 넘어간다. 그래서 "몇 번 눌렀나"가 아니라
   * **"투어 밖으로 나왔나"** 로 종료를 판정한다.
   */
  const TOUR = new Set(["match-scoreboard", "match-pitch", "match-timeline", "match-controls",
    "match-stats", "match-skip"]);
  for (let i = 0; i < 30; i++) {
    const cur = await stepId(page);
    if (cur && !TOUR.has(cur)) break;
    const next = page.getByTestId("onrail-next");
    if (await next.count()) await next.tap().catch(() => {});
    await page.waitForTimeout(400);
  }
  expect(TOUR.has((await stepId(page)) ?? "")).toBe(false);

  // 투어가 끝나면 잠금이 풀린다 — "지금은 잠가 뒀어요"가 참이려면 뒤에 풀려야 한다.
  await expect(page.getByTestId("match-skip")).toBeEnabled({ timeout: 20_000 });

  // ── S4 결과(반드시 승리) → 보상 봉투 ack ────────────────────────────────
  j.matchState = "FINISHED"; // 서버 시계가 후반을 끝냈다(폴링이 잡는다).
  await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 30_000 });
  await passHalfReport(page); // 경기 종료 브릿지 → [보상 받기]
  await expect(page.getByTestId("reward-sheet")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("reward-confirm").tap();
  await expect(page.getByTestId("result-page")).toBeVisible();
  expect(j.acked).toEqual(["B493w8"]);
  expect(j.granted.has("FIRST_RESULT_VIEW")).toBe(true);

  await expectStep(page, "result-view");
  await page.getByTestId("onrail-next").tap(); // [선수 키우러 가기]
  await expect(page).toHaveURL(/\/players$/);

  // ── S5 성장 — 승급 → 3지선다 → 무료 강화 ─────────────────────────────────
  await expectStep(page, "growth-open");
  await page.getByTestId(`codex-card-${TUTORIAL_CARD}`).tap();
  await expectStep(page, "growth-promote");

  await page.getByTestId("growth-star-up").tap();
  await expectStep(page, "growth-choice");
  await page.getByTestId("choice-cand-pace").tap();
  await expectStep(page, "growth-enhance");

  /*
   * ⚠️ **여기가 이 웨이브의 blocker 1 이었다.** 신규 유저 지갑은 3,000 G(+승리 500) 인데 노말
   * 다이스는 5,000 G 다. 무료 강화권이 있어도 화면이 **잔액으로** 잠그면 이 버튼은 영영 안 눌리고
   * (각본에 `skipIfMissing` 이 없다) 유저는 S5 에서 갇힌다 — 서버는 반대로 *"무료면 잔액 검사도
   * 하지 않는다"* 고 못 박아 두었다(TradeService/GrowthService 머리말).
   */
  expect(j.points).toBeLessThan(DICE_NORMAL_COST);
  await expect(page.getByTestId("growth-dice-free")).toBeVisible();
  await expect(page.getByTestId("growth-dice-normal")).toBeEnabled();
  await page.getByTestId("growth-dice-normal").tap();
  const confirmOk = page.getByTestId("growth-roll-confirm-ok");
  if (await confirmOk.count()) await confirmOk.tap();
  await expect(page.getByTestId("growth-free-applied")).toBeVisible({ timeout: 20_000 });
  expect(j.diceCalls).toHaveLength(1);
  expect(j.granted.has("FIRST_ENHANCE")).toBe(true);
  // 쿠폰이 실제로 타 없어졌고, 화면이 그 사실을 다시 읽는다(`["me"]` 무효화).
  expect(j.coupons.FREE_ENHANCE).toBe(0);
  await expect(page.getByTestId("growth-dice-free")).toHaveCount(0, { timeout: 20_000 });

  await expectStep(page, "growth-done");
  await page.getByTestId("onrail-next").tap(); // [영입하러 가기]
  await expect(page).toHaveURL(/\/recruit/);

  // ── S6 트레이드 — DIA 확정 + 무료 단축 ──────────────────────────────────
  await expectStep(page, "trade-start");
  await page.getByTestId("trade-slot-1-start").tap();
  await expectStep(page, "trade-rush");
  expect(j.granted.has("FIRST_TRADE")).toBe(true);
  await expect(page.getByTestId("trade-slot-1-grade")).toHaveAttribute("data-grade", "DIA");

  /*
   * ⚠️ **blocker 2 — 같은 뿌리.** DIA 대기 48h → 단축 24,000 G 인데 유저 잔액은 3,500 G 다.
   * 무료 단축권이 있어도 잔액으로 잠그면 S6 에서 갇힌다.
   */
  expect(j.points).toBeLessThan(SPEEDUP_COST);
  await expect(page.getByTestId("trade-slot-1-rush-free")).toBeVisible();
  await expect(page.getByTestId("trade-slot-1-speedup")).toBeEnabled();
  await page.getByTestId("trade-slot-1-speedup").tap();
  await expectStep(page, "trade-accept");
  expect(j.coupons.FREE_TRADE_RUSH).toBe(0); // 서버가 그 트랜잭션에서 태웠다
  /*
   * ⚠️ **여기서 캐시 무효화를 주장하지 않는다** (독립 검증 3R minor-1 정정).
   * 단축이 성공하면 슬롯이 WAITING 을 떠나 무료권 칩을 소유한 블록 자체가 언마운트되므로, 이
   * 단언은 `["me"]` 재조회 여부와 **무관하게** 참이다(변이로 확인됨 — 무효화를 지워도 초록).
   * 쿠폰 표기가 서버 진실을 따라오는지는 **강화 쪽**(`growth-dice-free`, 아래 S5)이 문다 — 그 칩은
   * 같은 화면에 계속 살아 있는 버튼 위에 있어 재조회가 없으면 남는다. 무효화 규칙 자체의 계약은
   * `src/api/hooks-v2.test.ts`(선행) 소관이다.
   */
  await expect(page.getByTestId("trade-slot-1-rush-free")).toHaveCount(0);
  expect(j.speedupSpent).toBe(0); // 쿠폰이면 지출 0 (서버 `spent`)
  expect(j.points).toBe(INITIAL_POINTS + WIN_POINTS); // 지갑은 한 푼도 안 나갔다

  await page.getByTestId("trade-slot-1-accept").tap();
  // 영입 결과 모달은 **온레일 밖의 자기 모달**이다 — 온레일은 그 위에서 비켜나고(`shieldFor`),
  // 유저가 닫아야 완주 카드가 그 자리에 온다.
  await expect(page.getByTestId("trade-result")).toBeVisible();
  await page.getByTestId("trade-result-close").tap();

  // ── S7 완주 ─────────────────────────────────────────────────────────────
  await expectStep(page, "finish");
  await page.getByTestId("onrail-next").tap(); // [홈으로]
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("onrail-overlay")).toHaveCount(0);

  // ── 보상 5통이 우편함에 있고, 수령이 잔액을 올린다 ────────────────────────
  await page.getByTestId("mail-center-open").tap();
  for (const action of ["TUTORIAL_DONE", "FIRST_DECK_SAVE", "FIRST_RESULT_VIEW", "FIRST_ENHANCE", "FIRST_TRADE"]) {
    await expect(page.getByText(TITLES[action]!)).toBeVisible();
  }
  const gemsBefore = j.gems;
  await page.getByText(TITLES.FIRST_ENHANCE!).tap();
  await page.getByTestId("mail-claim").first().tap();
  await expect.poll(() => j.gems, { timeout: 10_000 }).toBe(gemsBefore + 300);

  mkdirSync(new URL("../.smoke/", import.meta.url).pathname, { recursive: true });
  await page.screenshot({ path: new URL("../.smoke/p493-w8v3-journey-end.png", import.meta.url).pathname });
});

/**
 * #493 W8-v3 — **재진입이 시나리오의 약속을 깨지 않는다** (독립 검증 2R B1).
 *
 * 저장 단위는 스텝인데 화면 상태(덱 draft)는 저장되지 않는다. 그래서 한마디를 치고 [저장] 전에
 * 새로고침하면 그 문장이 사라지는데, 스텝은 이미 `deck-save` 라 유저는 **한마디가 빠진 덱을 저장**
 * 하고(그 자리에서 첫 저장 보상까지 태워진다) 그 사실조차 모른다.
 */
test("한마디를 치고 저장 전에 새로고침하면 그 스텝으로 되감긴다 — 빈 덱이 저장되지 않는다", async ({ page }) => {
  const j = await mockJourney(page, { deckReady: true });
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      // 한마디를 치고 [저장]을 누르기 직전에 창을 닫은 유저의 상태 그대로.
      JSON.stringify({ status: "running", stepId: "deck-save", matchId: null }),
    );
  }, USER_ID);

  await page.goto("/deck");
  /*
   * 되감긴다 — 서버 덱에 한마디가 없으므로 그 스텝을 다시 시킨다.
   * ⚠️ 착지점은 `deck-prompt` 가 아니라 **`deck-player`** 다: 입력칸은 선수를 고른 뒤에만 존재해서
   * (폰은 선수 메뉴를 한 번 더 지난다) 그 앞에 세우면 오버레이가 hold 로 사라진다.
   */
  await expectStep(page, "deck-player");
  await page.getByTestId(`token-${STARTERS[0]}`).tap();
  await expect(page.getByTestId("player-menu")).toBeVisible();
  await page.getByTestId("pmenu-say").tap();
  await expectStep(page, "deck-prompt");

  // 다시 쓰면 정상 진행이고, 저장된 덱에 그 문장이 실제로 실린다.
  const input = page.getByTestId("rail-prompt-input");
  await expect(input).toBeInViewport();
  await input.fill("다시 쓴 한마디");
  await input.blur();
  await expectStep(page, "deck-save");
  await page.getByTestId("save-deck").tap();
  await expectStep(page, "deck-done");
  const starters = (j.deck.slots as { role: string; promptText?: string | null }[])
    .filter((s) => s.role === "starter");
  expect(starters.some((s) => (s.promptText ?? "").includes("다시 쓴 한마디"))).toBe(true);
});

/**
 * #493 W8-v3 — **되감기는 "복원 창"에서만 발화한다** (독립 검증 3R blocker-2).
 *
 * ⚠️ 이 계약은 **DOM 스냅샷으로는 쓸 수 없다.** 복원 창 가드(`restoredRef`)를 지워도 화면은 같아
 * 보인다 — 되감긴 두 스텝(`deck-player`·`deck-prompt`)이 둘 다 행동형이라 *"이번 run 에서 이미 한
 * 행동은 도착 즉시 통과"* 규칙이 그 자리에서 재생돼 곧바로 `deck-save` 로 돌아오기 때문이다.
 * 실측으로 확인됐다: 그 가드를 제거해도 이 파일 8건 + 온레일 스위트 18건이 **전부 초록**이었다.
 *
 * 그래서 상태가 아니라 **전이(transition)** 를 잰다 — 스텝 id 가 바뀔 때마다 기록해 두고
 * *"`deck-save` 에 도달한 뒤로는 뒤로 가지 않는다"* 를 문다. 가드가 없으면 그 기록에
 * `deck-save → deck-player` 가 남는다(화면에는 한 프레임도 안 남지만 기록에는 남는다).
 */
test("복원 창 밖에서는 되감지 않는다 — 전이 기록에 역행이 없다", async ({ page }) => {
  // 온보딩이 끝난 계정 = 덱이 이미 서 있다(그 덱에 한마디만 없다 — 되감기 조건의 나머지 절반).
  await mockJourney(page, { deckReady: true });
  await seedOnboardedUser(page);
  /*
   * 스텝 전이를 **전부** 받아 적는다 — 매 프레임 표본.
   * ⚠️ `MutationObserver` 로는 못 잡는다(실측): 말풍선은 `key={step.id}` 라 통째로 교체되는데
   * 그 관찰자를 `addInitScript` 단계에서 걸면 React 루트가 붙기 전이라 놓친다. rAF 는 화면이
   * 그려지는 매 프레임을 보므로 한 프레임짜리 역행도 남는다(이 계약이 재려는 것이 정확히 그것이다).
   */
  await page.addInitScript(() => {
    const w = window as unknown as { __railSteps: string[] };
    w.__railSteps = [];
    const tick = () => {
      const id = document
        .querySelector('[data-testid="onrail-bubble"]')
        ?.getAttribute("data-step-id");
      if (id && w.__railSteps[w.__railSteps.length - 1] !== id) w.__railSteps.push(id);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto("/home");
  await page.getByTestId("home-tile-game").tap();
  await page.getByTestId("practice-tutorial-accept").tap();
  await expect(page).toHaveURL(/\/deck$/);

  // S2 를 **이번 화면에서** 끝까지 밟는다(복원이 아니다 — 그래서 되감기가 발화하면 안 된다).
  // ⚠️ W9 부터 첫 칸은 AUTO 다(레일 시작이 드래프트를 비운다) — 보드가 비어 있어 여기서
  //    바로 토큰을 누르려 하면 대상이 없다.
  await expectStep(page, "deck-auto");
  await page.getByTestId("auto-fill").tap();
  await expectStep(page, "deck-player");
  await page.getByTestId(`token-${STARTERS[0]}`).tap();
  await page.getByTestId("pmenu-say").tap();
  const input = page.getByTestId("rail-prompt-input");
  await input.fill("복원 창 밖");
  await input.blur();
  // 이 시점 서버 덱에는 아직 한마디가 없다 = 되감기 **조건은 참**이다. 막는 것은 가드뿐이다.
  await page.waitForTimeout(1500);

  const seen = await page.evaluate(() => (window as unknown as { __railSteps: string[] }).__railSteps);
  const firstSave = seen.indexOf("deck-save");
  expect(firstSave, `전이 기록에 deck-save 가 없다: ${seen.join(" → ")}`).toBeGreaterThanOrEqual(0);
  expect(seen.slice(firstSave), `deck-save 뒤로 역행이 남았다: ${seen.join(" → ")}`)
    .toEqual(["deck-save"]);
});

test("이미 한마디가 저장돼 있으면 되감지 않는다 — 되감기는 손실이 있을 때만", async ({ page }) => {
  const j = await mockJourney(page, { deckReady: true });
  // 서버 덱에 한마디가 이미 실려 있다(저장까지 마친 뒤 새로고침한 유저).
  (j.deck.slots as { promptText?: string | null }[])[0]!.promptText = "이미 저장된 한마디";
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      JSON.stringify({ status: "running", stepId: "deck-save", matchId: null }),
    );
  }, USER_ID);

  await page.goto("/deck");
  await expectStep(page, "deck-save");
  // 되감기가 늦게 오는 것도 아니다 — 잠시 기다려도 그대로다.
  await page.waitForTimeout(1500);
  await expectStep(page, "deck-save");
});

/**
 * #493 W8-v3 — **[경기 시작]이 실패를 삼키지 않는다** (독립 검증 2R B4).
 *
 * 폴백 2종(자산 부재·1회 제한) 밖의 실패는 구 동작에서 **눌러도 아무 일 없는 버튼**이었다.
 * 딤이 화면을 덮고 있어 다른 화면의 안내·토스트는 유저에게 도달하지 않는다.
 */
test("[경기 시작]이 409 MATCH_IN_PROGRESS 를 만나면 그 매치로 이어간다", async ({ page }) => {
  const j = await mockJourney(page, { deckReady: true });
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      JSON.stringify({ status: "running", stepId: "deck-done", matchId: null }),
    );
  }, USER_ID);
  await page.route((url) => url.pathname === "/api/matches", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "MATCH_IN_PROGRESS",
        message: "진행 중인 경기가 있습니다",
        detail: { matchId: MATCH_ID, state: "FIRST_HALF", action: "resume" },
      }),
    });
  });

  await page.goto("/deck");
  await expectStep(page, "deck-done");
  await page.getByTestId("onrail-next").tap();

  // 막다른 길이 아니다 — 그 매치로 데려가고 투어가 이어진다(#217 규칙 재사용).
  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`), { timeout: 20_000 });
  expect(j.creates).toHaveLength(0); // 새 매치를 만들지 않았다
});

test("[경기 시작]이 폴백 밖의 실패를 만나면 **말풍선이 말한다** — 조용히 죽지 않는다", async ({ page }) => {
  await mockJourney(page, { deckReady: true });
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      JSON.stringify({ status: "running", stepId: "deck-done", matchId: null }),
    );
  }, USER_ID);
  await page.route((url) => url.pathname === "/api/matches", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "INTERNAL", message: "서버 오류가 발생했습니다" }),
    });
  });

  await page.goto("/deck");
  await expectStep(page, "deck-done");
  await page.getByTestId("onrail-next").tap();

  await expect(page.getByTestId("onrail-note")).toBeVisible({ timeout: 20_000 });
  // 스텝은 그대로라 다시 누를 수 있다(실패가 진행을 삼키지도, 되돌리지도 않는다).
  await expectStep(page, "deck-done");
  await expect(page).toHaveURL(/\/deck$/);
});

/**
 * #493 W8-v3 — **매치 스텝의 [이어서 하기]가 무동작 루프가 아니다** (독립 검증 2R B5).
 *
 * 구 동작은 매치 스텝을 `/home` 으로 돌려주고 "잠금 게이트가 되돌린다"고 적었는데, 그 전제는
 * 경기가 **진행 중일 때만** 참이다 — 결과 화면까지 온 뒤에는 되돌릴 잠금이 없어 홈에서 홈으로 간다.
 */
test("매치 스텝에서 나갔다 [이어서 하기] = 그 매치로 돌아간다", async ({ page }) => {
  await mockJourney(page, { deckReady: true });
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      JSON.stringify({ status: "running", stepId: "result-view", matchId: "m493w8" }),
    );
  }, USER_ID);

  await page.goto("/home");
  const resume = page.getByTestId("onrail-bubble");
  await expect(resume).toHaveAttribute("data-step-id", "onrail-resume");
  await resume.getByTestId("onrail-next").tap();
  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`), { timeout: 20_000 });
});

test("튜토리얼 매치의 하프타임은 교체·자리를 받지 않는다(구운 후반)", async ({ page }) => {
  const j = await mockJourney(page, { deckReady: true });
  j.matchState = "HALFTIME";
  j.creates.push({ tutorial: true });
  await skipSplash(page);
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_w8"));

  await page.goto(`/match/${MATCH_ID}`);
  await passHalfReport(page); // 전반 리포트를 넘겨야 감독시간이 나온다
  await expect(page.getByTestId("halftime-tutorial-note")).toBeVisible({ timeout: 30_000 });
  // 교체·자리 탭은 잠기고, [감독의 한마디]는 열려 있다(조정 ⑤ — 안내만).
  await expect(page.getByTestId("halftime-mode-sub")).toBeDisabled();
  await expect(page.getByTestId("halftime-mode-say")).toBeEnabled();
  // [자리]는 배치를 보낼 수 있는 매치에서만 뜬다(#276) — 뜨면 그것도 잠겨 있어야 한다.
  const move = page.getByTestId("halftime-mode-move");
  if (await move.count()) await expect(move).toBeDisabled();
});

test("튜토리얼 매치를 이미 했으면(409) 일반 연습경기로 착지한다 — 막다른 길 금지", async ({ page }) => {
  const j = await mockJourney(page, { deckReady: true });
  const bodies: unknown[] = [];
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_w8");
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      JSON.stringify({ status: "running", stepId: "deck-done", matchId: null }),
    );
  }, USER_ID);

  // 첫 호출(`tutorial:true`)만 409 로 거절한다 — 서버 `TUTORIAL_ALREADY_PLAYED` 와 같은 모양.
  await page.route((url) => url.pathname === "/api/matches", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() ?? {};
    bodies.push(body);
    if (body.tutorial === true) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TUTORIAL_ALREADY_PLAYED",
          message: "튜토리얼 경기는 한 번만 진행할 수 있습니다",
          detail: { played: 1 },
        }),
      });
    }
    j.creates.push(body);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(matchDetail(j)) });
  });

  await page.goto("/deck");
  await expectStep(page, "deck-done");
  await page.getByTestId("onrail-next").tap();

  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`), { timeout: 30_000 });
  // 두 번 보냈고, 두 번째는 플래그가 없다(일반 연습경기).
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ tutorial: true });
  expect(bodies[1]).toEqual({});
});
