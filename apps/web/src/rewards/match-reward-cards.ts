/**
 * **경기 종료 보상 카드 순서** — 순수 판정 (#456 S4 · B3 AC2).
 *
 * hero: *"경기 종료 보상 페이지를 순차화 — 골드 보상 → 레이팅 보상 → 선수별 스탯 선택"*.
 * 이 모듈이 답하는 것은 **무엇이 몇 장 서는가**뿐이고, 그리는 일은 `MatchRewardFlow` 가 한다.
 *
 * ── 이 파일이 존재하는 이유 두 가지 ────────────────────────────────────────────────────
 * ① **모드별 두 번째 카드는 "없음"이 정상인 경우가 많다** — 연습·구 서버·트랙 정보 미도착.
 *    화면에서 `toHaveCount(0)` 으로 재면 "아직 안 그려짐"도 통과한다(apps/web CLAUDE.md 표 #6).
 * ② **금액을 클라가 만들지 않는다**(#232). hero 확정값 *"예 30잼"* 은 코드 상수가 아니라
 *    `data/players/economy.v3.json` 의 `league.dailyReward.small` 이고, 그 값은 운영이 무배포로
 *    돌린다. 여기서는 **서버가 준 것을 그대로 옮기기만** 한다 — 기본값·폴백·재계산이 없다.
 *    (`growth-config.ts` 의 `DICE_BUY_COST = 500` 미러가 지갑을 10배로 줄인 전례가 #213 이다.)
 *
 * ── 모드별 축이 무엇에서 오는가 ────────────────────────────────────────────────────────
 * · **리그 = 잼** → `GET /api/matches/{id}/result` 의 additive `dailyReward`(#368) = 그 판이
 *   소비한 **오늘의 보상 칸**. 서버는 리그 매치에만 이 블록을 싣는다(`MatchService.MatchResult`).
 *   ⚠️ `pointsAwarded` 로 대신할 수 없다 — 다이아 칸에서는 늘 0이고 **재화를 말하지 못한다**.
 * · **원정 = 레이팅** → `GET /api/me` 의 additive `rating`(#245, `away/RatingService`).
 *   ⚠️ **이 매치의 증감폭(`ratingDelta`)은 오늘 클라가 알 수 없다** — 서버가 그 값을 싣는 곳은
 *   `away_reports`(내가 **당한** 경기)뿐이라 `/api/me/away-reports` 로만 나오고, 내가 **친**
 *   경기의 델타를 주는 표면이 없다. 클라가 이전 값과 빼서 만들면 그건 #262 가 금지한
 *   "클라가 서버 규칙을 재구현" 이다(무승부 취급·시즌 리셋이 서버 규칙이다). → 현재 값만 말한다.
 * · **연습 = 없음** — 골드에서 곧장 다음 단계로.
 *
 * ── 그 뒤가 **선수별**이다 (AC3, S4-W2) ────────────────────────────────────────────────
 * 레벨업으로 생긴 선택권 하나가 카드 한 장이다. 순서는 봉투가 준 순서(= 성장 섹션 행 순서) 그대로 —
 * 여기서 정렬하지 않는다. **아직 안 고른 것만** 세는데, 그 권위는 봉투 스냅샷이 아니라
 * `GET /api/growth/choices` 다(`types.openChoicesOf` 주석 — 봉투는 "그때 무슨 일이 있었나"의 기록이라
 * 유저가 고른 뒤에도 그대로다). 교차는 호출부가 하고 이 함수는 **받은 목록을 카드로 옮기기만** 한다.
 */
import type { MatchDailyReward } from "../api/p3";
import type { PendingChoice } from "../api/growth";
import type { RewardCurrencyEntry, RewardGrowthEntry } from "./types";

export type MatchRewardCard =
  /** 봉투 재화 섹션 전량(코드+수량). 이름·심볼은 `<Amount>`(#232)가 붙인다. */
  | { id: "currency"; entries: RewardCurrencyEntry[] }
  /** 리그 — 그 판이 소비한 오늘의 보상 칸. `awarded:false` = 소멸, `amount:0` = 트랙 소진. */
  | { id: "daily"; slotNo: number; currency: string; amount: number; awarded: boolean }
  /** 원정 — 정산 후 내 레이팅. */
  | { id: "rating"; rating: number }
  /**
   * 선수 한 명의 레벨업 선택권 한 건.
   *
   * `player` 는 그 선수의 성장 행(이름·등급·포지션) — **없을 수 있다**(봉투 성장 섹션에 그 행이
   * 없는 경우). 없으면 화면이 이름·아바타를 지어내지 않고 id 로 조회한 이름만 쓴다.
   */
  | { id: "choice"; choice: PendingChoice; player: RewardGrowthEntry | null };

export type MatchRewardCardId = MatchRewardCard["id"];

export interface MatchRewardInput {
  /** `MatchDetail.mode`. **모르면 두 번째 카드를 추측하지 않는다**(`ResultPanel` CTA 와 같은 규율). */
  mode: string | null | undefined;
  currencies: readonly RewardCurrencyEntry[];
  dailyReward: MatchDailyReward | null | undefined;
  /** `MeResponse.rating` — 구 서버엔 없다(optional). `?? 0` 폴백 금지. */
  rating: number | null | undefined;
  /**
   * **아직 안 고른** 선택권(호출부가 `openChoicesOf` 로 교차한 결과). 순서 = 봉투 순서.
   * 여기서 다시 거르지 않는다 — 두 곳이 세면 두 화면의 대기 수가 갈린다(#405 §2.5 규율).
   */
  choices?: readonly PendingChoice[] | undefined;
  /** 봉투 성장 섹션 행 — 카드의 이름·아바타 재료. 없는 선수는 `player: null` 이다. */
  growth?: readonly RewardGrowthEntry[] | undefined;
}

/**
 * 결과 응답의 additive `dailyReward` 블록을 꺼낸다 — **응답 형태를 믿지 않는다**(#245·#251).
 * 200 `{}` 를 주는 구 서버·프록시가 실재하고, 리그가 아닌 경기는 `null` 이다.
 */
export function matchDailyRewardOf(result: unknown): MatchDailyReward | null {
  const raw = (result as { dailyReward?: unknown } | null | undefined)?.dailyReward;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const reward = raw as MatchDailyReward;
  return Number.isFinite(reward.slotNo) ? reward : null;
}

/**
 * 이 경기의 보상 카드 — **골드 → 모드별** 순서. 웨이브 2 가 선수별 순차를 이 뒤에 붙인다.
 *
 * 빈 배열이면 보여 줄 것이 없다는 뜻이고, 그때 흐름은 **멈추지 않고** 결과 화면으로 간다
 * (`MatchRewardFlow` 가 그 자리에서 `onDone`).
 */
export function matchRewardCards(input: MatchRewardInput): MatchRewardCard[] {
  const cards: MatchRewardCard[] = [];

  // 봉투에 실린 것만 — 봉투가 없던 시절 매치(W2b 이전)·생성이 삼켜진 경우엔 줄이 0 이다.
  const entries = input.currencies.filter(
    (e) => typeof e?.code === "string" && Number.isFinite(e?.amount),
  );
  if (entries.length > 0) cards.push({ id: "currency", entries: [...entries] });

  if (input.mode === "league") {
    const daily = input.dailyReward;
    /*
     * ⚠️ **소멸(`awarded:false`)과 트랙 소진(`amount:0`)도 카드로 남긴다.** 안 보여주면 유저는
     * 칸이 소비된 줄 모르고, 다음 판에서 트랙이 한 칸 앞서 있는 이유를 알 방법이 없다 —
     * 얼마짜리를 날렸는지 말해 주는 것이 규칙을 가르치는 유일한 순간이다(#368 `DailyRewardLine`).
     */
    if (daily && Number.isFinite(daily.slotNo)) {
      cards.push({
        id: "daily",
        slotNo: daily.slotNo,
        currency: daily.currency,
        amount: Number.isFinite(daily.amount) ? daily.amount : 0,
        awarded: daily.awarded === true,
      });
    }
  } else if (input.mode === "away") {
    // ⚠️ `0` 은 유효한 레이팅이다(가입 초기값). truthy 검사로 바꾸면 신규 유저만 카드가 사라진다.
    if (typeof input.rating === "number" && Number.isFinite(input.rating)) {
      cards.push({ id: "rating", rating: input.rating });
    }
  }

  /*
   * 선수별 — **모드와 무관하다**(연습에서도 레벨업은 난다). 받은 순서 그대로 옮긴다:
   * 서버가 성장 행 순서로 내려 주고 그 순서가 곧 결과 화면 성장 목록의 순서다.
   */
  for (const choice of input.choices ?? []) {
    if (!choice || typeof choice.choiceId !== "string" || typeof choice.playerId !== "string") continue;
    const player = (input.growth ?? []).find((e) => e.playerId === choice.playerId) ?? null;
    cards.push({ id: "choice", choice, player });
  }

  return cards;
}
