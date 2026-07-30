/**
 * 홈 런처의 **순수 로직** (#286 W2). 화면(`HomePage`)은 이 값을 그리기만 한다.
 *
 * 여기 있는 문자열이 곧 hero 가 확정한 것들이라, 바꾸려면 이 파일 하나만 보면 된다.
 */
import type { CatalogPlayer, Deck, MeResponse } from "../api/hooks";
import type { Grade } from "../common/grades";
import type { TradeSlot } from "../api/v2";

export interface HomeTile {
  key: "game" | "deck" | "recruit" | "me" | "players";
  /** hero 지정 **풀 네임**. 하단 탭바는 축약형을 쓴다(6칸에 안 들어간다) — 의도적인 짝. */
  label: string;
  icon: string;
  to: string;
  /** 홈의 주인공. 하나만 크고 색을 갖는다(#244 색 규칙 = 의미 있는 색 4개). */
  primary?: boolean;
}

/**
 * ⚠️ **순서까지 hero 지정이다** — "게임시작, 덱구성, 영입, 내 정보, 선수 도감으로가자".
 * 계약(`e2e/p286-home-nav.spec.ts`)이 DOM 순서를 이 배열과 대조하므로 임의로 정렬하지 말 것.
 */
export const HOME_TILES: readonly HomeTile[] = [
  { key: "game", label: "게임 시작", icon: "⚽", to: "/game", primary: true },
  { key: "deck", label: "덱 구성", icon: "📋", to: "/deck" },
  { key: "recruit", label: "영입", icon: "✨", to: "/recruit" },
  { key: "me", label: "내 정보", icon: "🙋", to: "/me" },
  { key: "players", label: "선수 도감", icon: "👥", to: "/players" },
];

export interface TileState {
  /** 부제 = **무엇을 센 숫자인지 말하는 자리**. 뱃지는 숫자만 갖는다(hero 6R). */
  sub: string;
  /** 0 이면 뱃지를 그리지 않는다. */
  count: number;
}

export interface HomeTileInput {
  me: MeResponse | undefined;
  deck: Deck | undefined | null;
  ownedTotal: number;
  ownedCount: number;
  openTrades: number;
}

/** 공개된(=지금 처리할 수 있는) 트레이드 제안 수. 서버 상태를 세기만 한다. */
export function openTradeCount(slots: TradeSlot[] | undefined): number {
  // 배열이 아니면 0 — 구 서버 200 `{}` 로도 홈이 죽지 않게(위 §주석과 같은 이유).
  return Array.isArray(slots) ? slots.filter((s) => s.state === "OPEN").length : 0;
}

/**
 * 지시가 채워진 선발 수 / 전체 선발 수. 덱이 없으면 null.
 *
 * ⚠️ **응답 형태를 믿지 않는다.** 구 서버·빈 응답이 200 `{}` 를 주면 `deck.slots` 가 undefined 라
 * `.filter` 가 던지고 **홈 전체가 흰 화면**이 된다 — #245 가 로비에서 정확히 이걸로 당했고
 * (`data.reports.length`), 그때 남긴 규칙이 "부가 기능이 앱 진입점을 죽이면 안 된다"였다.
 * 홈은 이제 그 진입점이라 더 세게 지킨다. 계약 = e2e/p248-notice-popup(캐치올 `{}` 로 진입).
 */
export function directiveProgress(deck: Deck | undefined | null): { done: number; total: number } | null {
  if (!deck || !Array.isArray(deck.slots)) return null;
  const starters = deck.slots.filter((s) => s.role === "starter");
  if (starters.length === 0) return null;
  const done = starters.filter((s) => (s.promptText ?? "").trim().length > 0).length;
  return { done, total: starters.length };
}

/**
 * 타일마다 "지금 상태 한 줄".
 *
 * ⚠️ **값이 없으면 문장을 지어내지 않는다** — 구 서버·첫 진입에서 필드가 비면 그 조각을 빼고
 * 남은 것만 잇는다. 없는 숫자를 0 으로 채우면 화면이 거짓말을 한다(#262 BL-1 과 같은 부류).
 */
export function homeTileState(input: HomeTileInput): Record<HomeTile["key"], TileState> {
  const { me, deck, ownedTotal, ownedCount, openTrades } = input;

  const gameBits: string[] = [];
  if (me?.league?.divisionName) gameBits.push(me.league.divisionName);
  if (me?.rating !== undefined) gameBits.push(`원정 레이팅 ${me.rating}`);

  const dir = directiveProgress(deck);
  const deckBits: string[] = [];
  if (typeof deck?.formation === "string") deckBits.push(deck.formation);
  if (dir) deckBits.push(`지시 ${dir.done}/${dir.total} 작성`);

  const rec = me?.records;
  const meBits: string[] = [];
  if (rec && typeof rec.wins === "number") meBits.push(`${rec.wins}승 ${rec.draws}무 ${rec.losses}패`);
  if (me?.league?.divisionName) meBits.push(me.league.divisionName);

  return {
    game: { sub: gameBits.join(" · ") || "연습 · 리그 · 원정", count: 0 },
    deck: { sub: deckBits.join(" · ") || "선발과 지시를 짠다", count: 0 },
    recruit: {
      sub: openTrades > 0 ? `뽑기 · 트레이드 제안 ${openTrades}건 공개` : "뽑기 · 트레이드",
      count: openTrades,
    },
    me: { sub: meBits.join(" · ") || "전적과 순위", count: 0 },
    players: {
      sub: ownedTotal > 0 ? `보유 ${ownedCount} / ${ownedTotal}` : "보유 선수와 도감",
      count: 0,
    },
  };
}

/**
 * 홈 맨 아래 **알림 한 줄** — hero 컨펌 목업(`docs/plan-v5/mock/home-nav/after.html` `.notifrow`)의
 * 요소. "오늘 할 일 목록"을 홈에서 걷어내는 대신(그러면 홈이 다시 대시보드가 된다) **건수만**
 * 알리고 눌러서 가게 한 자리다.
 *
 * ⚠️ **셀 게 없으면 아예 그리지 않는다** — 빈 줄이 남으면 "알림이 없다"가 아니라 "고장 났다"로
 * 읽힌다. 헤더 벨(`NoticeCenter`)과는 다른 축이다: 벨은 공지, 이 줄은 **내 차례가 온 것들**.
 */
export interface HomeNotice {
  count: number;
  /** 무엇이 몇 건인지 — 뱃지가 아니라 여기가 말한다(카운트 뱃지 단일 형식과 같은 원칙). */
  text: string;
  to: string;
}

export function homeNotice(input: { unseenAwayReports: number; openTrades: number }): HomeNotice | null {
  const bits: string[] = [];
  if (input.unseenAwayReports > 0) bits.push(`원정 피침공 ${input.unseenAwayReports}건`);
  if (input.openTrades > 0) bits.push(`트레이드 제안 ${input.openTrades}건`);
  const count = input.unseenAwayReports + input.openTrades;
  if (count === 0) return null;
  return {
    count,
    text: `새 소식 ${count}건 — ${bits.join(" · ")}`,
    // 원정 쪽이 있으면 거기가 우선이다(피침공은 시간이 지나면 밀려나 사라진다).
    to: input.unseenAwayReports > 0 ? "/game" : "/recruit",
  };
}

export interface TeamLine {
  teamName: string;
  sub: string;
  rating: number | null;
  captainId: string | null;
  /** 아이콘 노출 정책(#285)이 등급으로 판정한다 — 모르면 아트를 안 그리는 쪽으로 닫힌다. */
  captainGrade: Grade | null;
}

/**
 * 홈 상단 팀 한 줄.
 *
 * 디비전 이름은 **서버가 준 값 그대로** 쓴다 — 클라가 `level` 로 만들면 사다리 끝에서 없는
 * 디비전을 표시한다(#262 BL-1). 없으면 그 조각을 뺀다.
 */
export function teamLine(
  me: MeResponse | undefined,
  deck: Deck | undefined | null,
  roster: CatalogPlayer[] = [],
): TeamLine {
  const bits: string[] = [];
  if (me?.league?.divisionName) bits.push(me.league.divisionName);
  if (typeof deck?.formation === "string") bits.push(deck.formation);

  // 위와 같은 이유로 배열인지 먼저 본다 — 여기서 던지면 홈이 통째로 흰 화면이다.
  const captain = Array.isArray(deck?.slots)
    ? (deck.slots.find((s) => s.role === "starter" && s.playerId)?.playerId ?? null)
    : null;

  const captainGrade = captain
    ? ((roster.find((p) => p.id === captain)?.grade as Grade | undefined) ?? null)
    : null;

  return {
    teamName: me?.user?.nickname ? `${me.user.nickname}의 팀` : "내 팀",
    sub: bits.join(" · ") || "덱을 구성해 팀을 만드세요",
    rating: me?.rating ?? null,
    captainId: captain,
    captainGrade,
  };
}
