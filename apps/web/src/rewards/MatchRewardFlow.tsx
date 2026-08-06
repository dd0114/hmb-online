import { useEffect, useMemo, useState } from "react";
import { useMatch, useMatchResult, useMe } from "../api/hooks";
import { Amount, useCurrency } from "../common/Amount";
import { ReportCardStack, type ReportStackCard } from "../match/HalfReportModal";
import type { MatchEndHandoff } from "../match/flow/match-flow";
import type { RewardCurrencyEntry } from "./types";
import { currencyEntriesOf, rewardBundleOf } from "./types";
import { matchDailyRewardOf, matchRewardCards, type MatchRewardCard } from "./match-reward-cards";
import styles from "./MatchRewardFlow.module.css";

/**
 * **경기 종료 보상 — 순차 카드** (#456 S4 · B3 웨이브 1 = AC1·AC2).
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
 * 뜨고, 재화가 **두 곳에서 보인다**. 알고 남긴 상태다 — 시트에는 미션(#408)처럼 `[받기]` 를
 * 눌러야 지급되는 섹션이 섞일 수 있고(`registry.unclaimed`), 선수별 레벨업 선택도 아직 그쪽에만
 * 있다. 지금 ack 를 치면 그 두 개가 **화면에서 사라진 채 미수령으로 남는다** = 실제 손실이다.
 * 시트 폐기("탭 폐기")는 **선수별 순차 카드(AC3)와 정보 감량(AC4)이 이 스택에 들어온 뒤**다.
 */
export interface MatchRewardFlowProps {
  handoff: MatchEndHandoff;
  onDone: () => void;
}

export function MatchRewardFlow({ handoff, onDone }: MatchRewardFlowProps) {
  const { data: match } = useMatch(handoff.matchId);
  const resultQuery = useMatchResult(handoff.matchId);
  const { data: me } = useMe();

  /*
   * 조회가 **끝났나**(성공이든 실패든). 전역 쿼리 클라이언트가 `retry: false` 라 실패는 즉시
   * 확정된다(`api/query-client.ts`). 도착 전에 카드 수를 세면 "보상이 없다"로 읽어 유저가
   * 보상을 통째로 건너뛴다 — 이 게이트가 그 경주를 없앤다.
   */
  const settled = !resultQuery.isPending;
  const result = resultQuery.data;

  const cards = useMemo<MatchRewardCard[]>(
    () =>
      settled
        ? matchRewardCards({
            mode: match?.mode,
            currencies: currencyEntriesOf(rewardBundleOf(result)),
            dailyReward: matchDailyRewardOf(result),
            rating: me?.rating,
          })
        : [],
    [settled, match?.mode, result, me?.rating],
  );

  const [index, setIndex] = useState(0);

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

  if (!settled) {
    return (
      <p className={styles.pending} data-testid="match-reward-loading">
        보상을 확인하는 중입니다…
      </p>
    );
  }
  if (cards.length === 0) return null;

  const stack: ReportStackCard[] = cards.map(cardOf);
  const last = index + 1 >= stack.length;

  return (
    <ReportCardStack
      cards={stack}
      index={index}
      onAdvance={() => (last ? onDone() : setIndex((i) => i + 1))}
      testIdBase="match-reward"
      // 스코어는 앞선 브릿지 카드가 이미 말했다 — 같은 줄을 다시 그리면 스택이 장마다 되풀이된다.
      score={null}
      finalCtaLabel="결과 보기"
    />
  );
}

/** 카드 하나의 **그림**. 순서·유무는 `match-reward-cards.ts` 가 이미 정했다. */
function cardOf(card: MatchRewardCard): ReportStackCard {
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
