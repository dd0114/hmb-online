import { useEffect, useMemo, useRef, useState } from "react";
import { useMatch, useMatchResult, useMe } from "../api/hooks";
import { Amount, useCurrency } from "../common/Amount";
import { CharAvatar, initialsOf } from "../common/CharAvatar";
import { GRADE_ORDER, type Grade } from "../common/grades";
import { usePlayerNames } from "../common/player-names";
import { useCardEffective, usePendingChoices } from "../api/growth-hooks";
import type { ChoiceResult } from "../api/growth";
import { ChoiceCandidates } from "../growth/ChoiceCards";
import { ReportCardStack, type ReportStackCard } from "../match/HalfReportModal";
import type { MatchEndHandoff } from "../match/flow/match-flow";
import type { RewardCurrencyEntry, RewardGrowthEntry } from "./types";
import {
  bundleChoicesOf,
  currencyEntriesOf,
  growthEntriesOf,
  openChoicesOf,
  rewardBundleOf,
} from "./types";
import { matchDailyRewardOf, matchRewardCards, type MatchRewardCard } from "./match-reward-cards";
import styles from "./MatchRewardFlow.module.css";

/**
 * **경기 종료 보상 — 순차 카드** (#456 S4 · B3 = AC1~AC4).
 *
 * hero: *"경기 종료 후 보상 페이지를 순차화하자 — 골드 보상, 레이팅 보상, 그리고 선수별로."*
 *
 * ── 이것이 앉는 자리 ──────────────────────────────────────────────────────────────────
 * `MatchFlowOverlay` 의 **`matchEndContinuation`** 확장점이다(#424 설계 §9.2). 그 prop 은
 * 타입·에러격리·멱등 `onDone` 까지 다 있는 채로 **프로덕션 호출부가 0** 이었고(`App.tsx` 가
 * 인자 없이 `MatchPage` 를 렌더했다), 이 웨이브가 그 호출부를 1 로 만든다. 그래서:
 *  · 라우트를 만들지 않는다 — `MatchLockGate`(#217)·뒤로가기·재입장이 전부 새 케이스가 된다(C3).
 *  · **여기서 던져도 결과 화면에 도달한다** — `ContinuationBoundary` 가 받아 `onDone` 을 부른다(C5).
 *  · `onDone` 은 멱등이다(C4) — 아래 "보여 줄 것이 없다" 경로가 렌더 중 그것을 부른다.
 *
 * ── 스택을 다시 짜지 않는다 ───────────────────────────────────────────────────────────
 * 카드 스택(뒤 카드·`1/N` 페이저·도트·본문 페이드·마지막 장 → 닫기)은 `HalfReportModal` 이 이미
 * 갖고 있다. 다만 그 컴포넌트를 통째로 쓰면 **다이얼로그가 2겹**이 된다(이 노드는 이미 열린
 * `flow-continuation` 모달 **안**에서 렌더된다) — `common/Modal` 포커스 트랩이 겹치는, 이 리포가
 * 설계 단계에서 기각한 사고 유형이다. 그래서 모달 셸과 카드 그림을 갈라(`ReportCardStack`)
 * **그림만** 재사용한다(#57 재발명 금지).
 *
 * ── 웨이브 경계(다음 사람에게) ────────────────────────────────────────────────────────
 * ⚠️ **이 화면은 봉투를 `ack` 하지 않는다.** 그래서 닫으면 #405 보상 시트(탭 구조)가 이어서
 * 뜨고, 재화가 **두 곳에서 보인다**. 알고 남긴 상태다.
 *
 * ⚠️ **잃는 것은 "안내"이지 "보상"이 아니다** — W1 이 이 자리에 *"실제 손실"* 이라고 적었고
 * 독립검증이 그것을 **반증**했다(major-1). 지금 ack 를 쳐서 시트를 건너뛰면 사라지는 것은
 * 그 두 가지를 **가리키는 화면**뿐이다:
 *  · 미션(#408) — `rewards/registry.ts:143` 이 `unclaimedHint: "원정 화면에서 기한 없이 받을 수
 *    있습니다"` 이고 그 옆 주석이 *"놓쳐도 사라지지 않는다 — 달성분은 기한 없이 남는다(§6.3)"*.
 *  · 레벨업 선택 — `codex/CardGrowthDetail.tsx` 의 `선택 대기 N` 배너가 그 자리에서 고르게
 *    한다. 이건 AC3 이 스스로 선언한 설계(*"전체 건너뛰기 = 선택권을 남긴다"*)와 **같은 것**이다.
 * 그래서 ack 유예는 *보수적인 선택*이지 손실 방지가 아니다 — 시트 폐기("탭 폐기")를 판단할 때
 * 이 비용을 **부풀려 계산하지 마라**(메모리 `false-absolute-claims-drive-decisions`).
 */
export interface MatchRewardFlowProps {
  handoff: MatchEndHandoff;
  onDone: () => void;
}

/**
 * 보상 조회를 기다리는 **상한**. 넘으면 나가는 문을 준다(W1 독립검증 major-3).
 *
 * ⚠️ 이 창의 그릇은 `dismissable={false}` 모달이라 ESC·백드롭 클릭이 안 먹고, 로딩 갈래에는
 * 컨트롤이 **0개**였다. `apiFetch` 에는 타임아웃이 없다(3s 타임아웃은 runtime config 조회 전용) —
 * 그래서 요청이 **에러 없이 매달리면** 유저는 끝난 경기의 결과에 영영 못 간다. 실패(500)는
 * `retry:false` 라 즉시 확정되지만 무응답은 그 갈래로 떨어지지 않는다.
 *
 * ⚠️ **자동으로 넘기지 않는다.** 늦게라도 응답이 오면 보상은 그대로 보여 줘야 하므로(그게 이
 * 화면의 존재 이유다) 결정은 유저에게 남긴다 — 상한은 *문을 여는* 시점일 뿐이다.
 */
const PENDING_ESCAPE_MS = 5_000;

export function MatchRewardFlow({ handoff, onDone }: MatchRewardFlowProps) {
  const { data: match } = useMatch(handoff.matchId);
  const resultQuery = useMatchResult(handoff.matchId);
  const { data: me } = useMe();
  /**
   * "지금 남은 것"의 권위 — 봉투의 `pendingChoices` 는 **정산 시점 스냅샷**이라 이미 고른 것도
   * 그대로 들어 있다(`types.bundleChoicesOf` 주석). 이걸 안 교차하면 강화탭에서 먼저 고른 선수가
   * 여기 또 선다.
   */
  const { data: openChoices } = usePendingChoices(undefined, true);

  /*
   * 조회가 **끝났나**(성공이든 실패든). 전역 쿼리 클라이언트가 `retry: false` 라 실패는 즉시
   * 확정된다(`api/query-client.ts`). 도착 전에 카드 수를 세면 "보상이 없다"로 읽어 유저가
   * 보상을 통째로 건너뛴다 — 이 게이트가 그 경주를 없앤다.
   */
  const settled = !resultQuery.isPending;
  const result = resultQuery.data;

  const live = useMemo<MatchRewardCard[]>(() => {
    if (!settled) return [];
    const bundle = rewardBundleOf(result);
    return matchRewardCards({
      mode: match?.mode,
      currencies: currencyEntriesOf(bundle),
      dailyReward: matchDailyRewardOf(result),
      rating: me?.rating,
      choices: openChoicesOf(bundleChoicesOf(bundle), openChoices),
      growth: growthEntriesOf(bundle),
    });
  }, [settled, match?.mode, result, me?.rating, openChoices]);

  /**
   * ⚠️ **스택은 열린 순간의 목록으로 박제된다.**
   *
   * 선택을 적용하면 `useApplyChoice` 가 `["growthChoices"]` 를 무효화하고, 그 응답이 오면 방금
   * 고른 선택권이 `openChoices` 에서 빠진다. 목록을 그대로 따라가면 **보고 있던 카드가 스택에서
   * 사라지고 인덱스가 밀려 다음 선수를 통째로 건너뛴다**(계약 `p456 l` 의 `3 / 3` 이 그것을 잰다).
   * 카드 수는 이 화면이 열릴 때 확정되고, 그 뒤의 변화는 이어지는 #405 시트가 반영한다.
   */
  const frozen = useRef<MatchRewardCard[] | null>(null);
  if (settled && frozen.current === null) frozen.current = live;
  const cards = frozen.current ?? [];

  const [index, setIndex] = useState(0);
  /** 이 흐름 안에서 **적용을 마친** 선택권 — 카드 바닥 버튼의 라벨이 그 사실을 따라간다. */
  const [appliedIds, setAppliedIds] = useState<readonly string[]>([]);

  /*
   * 보여 줄 것이 없으면 **스스로 비킨다** — 봉투가 없던 시절 매치(W2b 이전)·연습·조회 실패가
   * 그 자리다. 여기서 빈 카드를 세우면 유저는 아무것도 없는 오버레이 앞에서 [확인]을 한 번 더
   * 눌러야 하고(그 오버레이는 `dismissable={false}` 라 백드롭 닫기도 없다), 실패 경로에서는
   * 끝난 경기의 결과를 영영 못 본다.
   */
  const nothingToShow = settled && cards.length === 0;
  useEffect(() => {
    if (nothingToShow) onDone();
  }, [nothingToShow, onDone]);

  /** 조회가 상한을 넘겼나 — 넘으면 로딩 갈래에 **나가는 문**이 생긴다(위 `PENDING_ESCAPE_MS`). */
  const [pendingTimedOut, setPendingTimedOut] = useState(false);
  useEffect(() => {
    if (settled) return;
    const t = window.setTimeout(() => setPendingTimedOut(true), PENDING_ESCAPE_MS);
    return () => window.clearTimeout(t);
  }, [settled]);

  if (!settled) {
    return (
      <div className={styles.pending} data-testid="match-reward-loading">
        <p className={styles.pendingText}>보상을 확인하는 중입니다…</p>
        {pendingTimedOut && (
          <>
            <p className={styles.pendingHint}>
              응답이 늦어지고 있습니다. 보상은 서버에 기록돼 있으니 결과를 먼저 봐도 됩니다.
            </p>
            <button
              type="button"
              className={styles.pendingExit}
              data-testid="match-reward-pending-exit"
              onClick={onDone}
            >
              결과 보기
            </button>
          </>
        )}
      </div>
    );
  }
  if (cards.length === 0) return null;

  const last = index + 1 >= cards.length;
  const advance = () => (last ? onDone() : setIndex((i) => i + 1));

  const stack: ReportStackCard[] = cards.map((card, i) =>
    card.id === "choice"
      ? choiceCard(card, {
          applied: appliedIds.includes(card.choice.choiceId),
          onApplied: (res) => setAppliedIds((ids) => [...ids, res.choiceId]),
          // 라벨은 **이 장의 자리**가 정한다 — 마지막 장이면 목적지를 말해야 한다(`finalCtaLabel` 규율).
          last: i + 1 >= cards.length,
          advance,
          skipAll: onDone,
        })
      : cardOf(card),
  );

  return (
    <ReportCardStack
      cards={stack}
      index={index}
      onAdvance={advance}
      testIdBase="match-reward"
      // 스코어는 앞선 브릿지 카드가 이미 말했다 — 같은 줄을 다시 그리면 스택이 장마다 되풀이된다.
      score={null}
      finalCtaLabel="결과 보기"
    />
  );
}

interface ChoiceCardCtx {
  applied: boolean;
  onApplied: (res: ChoiceResult) => void;
  last: boolean;
  advance: () => void;
  skipAll: () => void;
}

/**
 * 선수 한 명의 레벨업 선택 (#456 AC3).
 *
 * ⚠️ **후보 3장·적용·축하·에러(409 이어하기)는 `ChoiceCandidates` 가 갖는다** — 보상 시트(#405 화면
 * ③)·강화탭(화면 ⑤)과 **같은 컴포넌트**다(설계 §2.10 *"두 자리에서 모양이 갈리면 안 된다"*).
 * 여기서 후보를 다시 그리면 세 자리가 되고, 그 순간 §2.10 이 지키던 것이 사라진다.
 *
 * ⚠️ **바닥 버튼 둘은 카드 본문이 아니라 `actions` 로 나간다** — 본문은 스크롤 영역이라 후보가
 * 길어지면 버튼이 화면 밖으로 나간다(#355 가 결과 패널에서 겪은 그 형태).
 */
function choiceCard(
  card: Extract<MatchRewardCard, { id: "choice" }>,
  ctx: ChoiceCardCtx,
): ReportStackCard {
  const { choice, player } = card;
  return {
    // ⚠️ **장마다 고유해야 한다** — 스택의 도트가 `key={c.id}` 로 돈다(같은 id 면 React 키 충돌).
    id: `choice-${choice.choiceId}`,
    kicker: "레벨업 보상",
    title: `Lv ${choice.level} → ${choice.level + 1}`,
    dataAttrs: {
      // 배정한 쪽이 다는 라벨(#456 B4 규율) — 계약이 "몇 번째가 누구냐"를 순서로 되추론하지 않게.
      "data-kind": "choice",
      "data-player": choice.playerId,
      "data-choice": choice.choiceId,
    },
    /*
     * ⚠️ **`key` 가 없으면 다음 선수 카드가 앞 선수의 상태를 물려받는다.** 스택은 한 번에 한 장만
     * 렌더하는데(`ReportCardStack` 의 `current.body`) 장이 바뀌어도 같은 컴포넌트 타입이라 React 가
     * **같은 인스턴스로 재조정**한다 → `ChoiceCandidates` 안의 `applied`/`celebrate` 가 그대로 남아
     * 두 번째 선수 카드에 **후보 3장 대신 앞 선수의 적용 결과**가 뜬다(실측으로 잡았다).
     * `RewardSheet` 이 `key={pick.choiceId}` 를 다는 것과 같은 이유이고, 같은 처방이다.
     */
    body: <ChoiceCardBody key={choice.choiceId} choice={choice} player={player} onApplied={ctx.onApplied} />,
    actions: (
      <>
        <button
          type="button"
          className={styles.primaryAction}
          data-testid="match-reward-choice-later"
          onClick={ctx.advance}
        >
          {/*
            ⚠️ **적용한 뒤에는 `다음에` 가 아니다.** 미룬 것이 없는데 "다음에"라고 쓰면 방금 한
            선택이 취소된 것처럼 읽힌다 — 라벨이 곧 그 순간의 뜻이다(`finalCtaLabel` 과 같은 규율).
          */}
          {ctx.applied ? (ctx.last ? "결과 보기" : "다음") : "다음에"}
        </button>
        <button
          type="button"
          className={styles.ghostAction}
          data-testid="match-reward-choice-skip-all"
          onClick={ctx.skipAll}
        >
          전체 건너뛰기
        </button>
      </>
    ),
  };
}

/** 등급을 아는 행만 아바타를 그린다(#285 fail-closed, `CharAvatar.grade` 는 필수 prop). */
function isGrade(g: string | null | undefined): g is Grade {
  return typeof g === "string" && (GRADE_ORDER as readonly string[]).includes(g);
}

function ChoiceCardBody({
  choice,
  player,
  onApplied,
}: {
  choice: Extract<MatchRewardCard, { id: "choice" }>["choice"];
  player: RewardGrowthEntry | null;
  onApplied: (res: ChoiceResult) => void;
}) {
  const { data: card } = useCardEffective(choice.playerId);
  /**
   * 선수명 초크포인트(#406 요구 6). 축 = **`full`** — 이름이 헤드에서 한 줄을 통째로 쓰고
   * 아바타(`aria-label`·이니셜)도 풀네임 전제다(모듈 CLAUDE.md 두 축 표).
   * 서버가 실어 보낸 `player.name` 은 **사다리 2단**으로만 넘긴다(카탈로그가 알면 그쪽이 이긴다).
   */
  const names = usePlayerNames();
  const name = names.full(choice.playerId, player?.name);
  return (
    <div className={styles.choice}>
      <div className={styles.choiceHead} data-testid="match-reward-choice-head">
        {isGrade(player?.grade) ? (
          <CharAvatar playerId={choice.playerId} name={name} grade={player.grade} size={40} />
        ) : (
          // 등급을 모르면(카탈로그 밖·구 정산) 아트를 안 그린다 — 자리만 지킨다.
          <span className={styles.choiceAvatarFallback} data-art-policy="hidden" aria-hidden="true">
            {initialsOf(name)}
          </span>
        )}
        <span className={styles.choiceWho}>
          <span className={styles.choiceName} data-testid="match-reward-choice-name">
            {name}
          </span>
          {player?.position && <span className={styles.choiceChip}>{player.position}</span>}
        </span>
      </div>
      <ChoiceCandidates choice={choice} card={card} onApplied={onApplied} />
    </div>
  );
}

/**
 * 카드 하나의 **그림**. 순서·유무는 `match-reward-cards.ts` 가 이미 정했다.
 * 선수별 선택(`choice`)은 훅을 쓰므로 컴포넌트(`choiceCard`)가 따로 맡는다.
 */
function cardOf(card: Exclude<MatchRewardCard, { id: "choice" }>): ReportStackCard {
  if (card.id === "currency") {
    return {
      id: "currency",
      kicker: "경기 보상",
      title: "보상을 받았습니다",
      body: (
        <ul className={styles.rows}>
          {card.entries.map((e) => (
            <CurrencyRow key={e.code} entry={e} />
          ))}
        </ul>
      ),
    };
  }
  if (card.id === "daily") return dailyCard(card);
  return {
    id: "rating",
    kicker: "원정 레이팅",
    title: "레이팅이 갱신됐습니다",
    body: (
      <div className={styles.big} data-testid="match-reward-rating">
        {/*
          ⚠️ **증감폭(±N)을 여기서 만들지 않는다.** 서버가 이 매치의 `ratingDelta` 를 주는 표면이
          없고(그 값은 `away_reports` = 내가 **당한** 경기에만 실린다), 이전 값과 빼서 만들면
          그건 클라가 서버 규칙을 재구현하는 것이다(#262 승률 규율). 값이 생기면 여기 한 줄이 는다.
        */}
        <b className={styles.bigValue} data-testid="match-reward-rating-value">
          {card.rating}
        </b>
        <span className={styles.bigLabel}>내 원정 레이팅</span>
      </div>
    ),
  };
}

/**
 * 리그 — 그 판이 소비한 **오늘의 보상 칸**(#368). hero 확정값 *"예 30잼"* 은 여기 `amount` 이고
 * 그 출처는 `data/players/economy.v3.json` 의 `league.dailyReward` 다. 화면은 옮기기만 한다.
 */
function dailyCard(card: Extract<MatchRewardCard, { id: "daily" }>): ReportStackCard {
  const slot = <span className={styles.slot}>{card.slotNo}번째 칸</span>;
  const body =
    card.amount === 0 ? (
      // 트랙을 다 쓴 뒤의 경기 — 칸은 세어지지만 값이 0이다. 지우면 "보상이 왜 안 들어왔지"가 된다.
      <div className={styles.big} data-testid="match-reward-daily-exhausted">
        {slot}
        <span className={styles.bigLabel}>오늘 칸을 모두 썼습니다</span>
      </div>
    ) : card.awarded ? (
      <div className={styles.big}>
        {slot}
        <b className={styles.bigValue}>
          +<Amount code={card.currency} value={card.amount} data-testid="match-reward-daily-amount" />
        </b>
      </div>
    ) : (
      <div className={styles.big}>
        {slot}
        <b className={`${styles.bigValue} ${styles.vanished}`} data-testid="match-reward-daily-vanished">
          <Amount code={card.currency} value={card.amount} data-testid="match-reward-daily-amount" /> 소멸
        </b>
        {/* 소멸도 보여준다 — 얼마짜리를 날렸는지 말해 주는 것이 규칙을 가르치는 유일한 순간이다. */}
        <span className={styles.bigLabel}>이긴 판에서만 지급됩니다</span>
      </div>
    );
  return {
    id: "daily",
    kicker: "오늘의 보상",
    title: card.awarded ? "칸 보상을 받았습니다" : "오늘의 보상 칸",
    // 배정한 쪽이 다는 라벨 — 계약이 지급 여부를 문구로 되추론하지 않게(#456 B4 규율).
    dataAttrs: { "data-awarded": card.awarded ? "1" : "0", "data-slot": String(card.slotNo) },
    body,
  };
}

/**
 * ⚠️ 이름·심볼·아이콘은 **하나도 여기서 적지 않는다**(#232) — 전부 `GET /api/config` 표기 메타에서
 * 온다. hero 가 "골드"라 부르는 재화의 표시명도 서버 값이고, 그래서 카드 제목에도 재화 이름이 없다.
 */
function CurrencyRow({ entry }: { entry: RewardCurrencyEntry }) {
  const currency = useCurrency(entry.code);
  return (
    <li
      className={styles.row}
      data-testid={`match-reward-currency-${entry.code}`}
      data-currency={entry.code}
      data-amount={entry.amount}
    >
      {currency.icon && (
        <span className={styles.icon} aria-hidden="true">
          {currency.icon}
        </span>
      )}
      <span className={styles.label}>{currency.name}</span>
      <span className={styles.amount}>
        +<Amount code={entry.code} value={entry.amount} />
      </span>
    </li>
  );
}
