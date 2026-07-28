import type { CatalogPlayer } from "../api/hooks";
import type { FaProposeRequest, TradeSlot } from "../api/v2";
import { Amount, useCurrency } from "../common/Amount";
import { balanceFor, CURRENCY_POINT, shortageMessage } from "../common/currency";
import { ProposeBuilder } from "./ProposeBuilder";
import { TradePlayerCard } from "./TradePlayerCard";
import {
  formatCountdown,
  formatProbability,
  gradeColor,
  gradeContactLabel,
  slotBadgeLabel,
  slotView,
  speedupButtonState,
  startButtonState,
  waitingCountdownLabel,
  waitingReveal,
  type SlotView,
  type WaitingReveal,
} from "./trade-logic";
import styles from "./TradeSlotCard.module.css";

interface TradeSlotCardProps {
  slot: TradeSlot;
  /** Live countdown for WAITING (parent ticks it once/second). */
  liveRemainingSec: number;
  walletPoints: number;
  /**
   * 유상재화 잔액 — 서버가 speedupCurrency 로 유상재화를 지정할 수 있으므로 같이 받는다(#232).
   * `undefined` = **모름**(구서버 응답에 필드가 없다). 0 과 구분해야 거짓 잠금이 안 생긴다.
   */
  walletGems: number | undefined;
  walletLoaded: boolean;
  /** playerId → catalog entry, for enriching PlayerRef with attributes·personality. */
  catalog: Map<string, CatalogPlayer>;
  /** My owned players (FA offer pool). */
  owned: CatalogPlayer[];
  busy: boolean;
  /** POST /{slot}/start — IDLE=[장 시작!], OPEN=[거래 안함] (#149). */
  onStart: (slot: number) => void;
  onSpeedup: (slot: number) => void;
  onPropose: (slot: number, body: FaProposeRequest) => void;
  onAccept: (slot: number) => void;
}

export function TradeSlotCard(props: TradeSlotCardProps) {
  const { slot, liveRemainingSec, walletPoints, walletGems, walletLoaded, catalog, owned, busy } = props;
  const view = slotView(slot);
  const reveal = waitingReveal(slot);
  const target = slot.target ? catalog.get(slot.target.playerId) : undefined;
  const demand = slot.demand ? catalog.get(slot.demand.playerId) : undefined;

  return (
    <section
      className={styles.card}
      data-testid={`trade-slot-${slot.slot}`}
      data-view={view}
      data-reveal={reveal}
    >
      <header className={styles.head}>
        <span className={styles.slotNo}>슬롯 {slot.slot}</span>
        <span className={styles.badge} data-testid={`trade-slot-${slot.slot}-badge`}>
          {slotBadgeLabel(view)}
        </span>
      </header>

      {view === "IDLE" && (
        <div className={styles.body}>
          <div className={styles.emptyMarket} aria-hidden="true">
            <span className={styles.emptyIcon}>🤝</span>
            <span className={styles.emptyText}>장이 닫혀 있습니다</span>
          </div>
          <StartButton
            slotNo={slot.slot}
            view={view}
            busy={busy}
            onStart={props.onStart}
          />
          <p className={styles.startHint}>
            장을 열면 접촉 선수의 <strong>등급</strong>이 먼저 공개되고, 대기 시간이 끝나면 거래할 수
            있습니다.
          </p>
        </div>
      )}

      {view === "WAITING" && (
        <WaitingBody
          slot={slot}
          reveal={reveal}
          targetDetail={target}
          liveRemainingSec={liveRemainingSec}
          walletPoints={walletPoints}
          walletGems={walletGems}
          walletLoaded={walletLoaded}
          busy={busy}
          onSpeedup={props.onSpeedup}
        />
      )}

      {view === "OPEN_FA" && slot.target && (
        <div className={styles.body}>
          <TradePlayerCard
            player={slot.target}
            detail={target}
            caption="영입 대상"
            testId={`trade-slot-${slot.slot}-target`}
            /* 협상의 주인공만 풀아트 (#187) — 대가/요구는 아이콘 유지. */
            fullArt
          />
          {slot.targetValue != null && (
            <p className={styles.targetValue} data-testid={`trade-slot-${slot.slot}-value`}>
              선수 가치 <strong>{Math.round(slot.targetValue)}</strong>
            </p>
          )}
          <ProposeBuilder
            owned={owned}
            maxPoints={walletPoints}
            pending={busy}
            onSubmit={(body) => props.onPropose(slot.slot, body)}
          />
          <StartButton slotNo={slot.slot} view={view} busy={busy} onStart={props.onStart} />
        </div>
      )}

      {view === "OPEN_TRADE" && slot.target && slot.demand && (
        <div className={styles.body}>
          <div className={styles.tradePair}>
            <TradePlayerCard
              player={slot.demand}
              detail={demand}
              caption="요구 (내 선수)"
              testId={`trade-slot-${slot.slot}-demand`}
            />
            <span className={styles.swap} aria-hidden="true">⇄</span>
            <TradePlayerCard
              player={slot.target}
              detail={target}
              caption="대가"
              testId={`trade-slot-${slot.slot}-target`}
              /* 트레이드 오퍼에서도 `slot.target` 이 **내가 받는 선수** = 영입 대상이다 (#187).
                 요구(내 선수)는 아이콘 유지 — 둘 다 풀아트로 하면 390 에서 안 읽힌다. */
              fullArt
            />
          </div>
          {slot.acceptProbability != null && (
            <p className={styles.prob} data-testid={`trade-slot-${slot.slot}-prob`}>
              성공 확률 <strong>{formatProbability(slot.acceptProbability)}</strong>
            </p>
          )}
          {/*
            #149: 액션은 [수락] + [거래 안함] 둘뿐. 구 [거절](POST /decline → 장 닫힘)은 [거래 안함]
            (POST /start → 즉시 새 오퍼)과 유저 입장에서 구분이 안 돼 UI 에서 제거했다.
          */}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.accept}
              data-testid={`trade-slot-${slot.slot}-accept`}
              disabled={busy}
              onClick={() => props.onAccept(slot.slot)}
            >
              수락
            </button>
          </div>
          <StartButton slotNo={slot.slot} view={view} busy={busy} onStart={props.onStart} />
        </div>
      )}

      {view === "RESOLVING" && (
        <div className={styles.body}>
          <p className={styles.resolving}>결과를 처리하는 중입니다…</p>
        </div>
      )}
    </section>
  );
}

/**
 * 같은 엔드포인트(POST /{slot}/start)를 문맥에 따라 다른 얼굴로 노출 — IDLE 은 큰 [장 시작!],
 * OPEN 은 공개된 선수를 버리는 [거래 안함]. 게이팅/문구는 trade-logic 이 결정한다(#149).
 */
function StartButton({
  slotNo,
  view,
  busy,
  onStart,
}: {
  slotNo: number;
  view: SlotView;
  busy: boolean;
  onStart: (slot: number) => void;
}) {
  const btn = startButtonState(view);
  if (!btn.visible) return null;
  const isStart = btn.kind === "start";
  return (
    <button
      type="button"
      className={isStart ? styles.start : styles.skip}
      data-testid={`trade-slot-${slotNo}-${isStart ? "start" : "skip"}`}
      disabled={busy}
      onClick={() => onStart(slotNo)}
    >
      {btn.label}
    </button>
  );
}

function WaitingBody({
  slot,
  reveal,
  targetDetail,
  liveRemainingSec,
  walletPoints,
  walletGems,
  walletLoaded,
  busy,
  onSpeedup,
}: {
  slot: TradeSlot;
  reveal: WaitingReveal;
  targetDetail: CatalogPlayer | undefined;
  liveRemainingSec: number;
  walletPoints: number;
  /**
   * 유상재화 잔액 — 서버가 speedupCurrency 로 유상재화를 지정할 수 있으므로 같이 받는다(#232).
   * `undefined` = **모름**(구서버 응답에 필드가 없다). 0 과 구분해야 거짓 잠금이 안 생긴다.
   */
  walletGems: number | undefined;
  walletLoaded: boolean;
  busy: boolean;
  onSpeedup: (slot: number) => void;
}) {
  // 단축 비용의 재화 — 서버가 준 코드를 그대로 쓴다(없으면 무료재화로 폴백).
  const speedupCode = slot.speedupCurrency ?? CURRENCY_POINT;
  const speedupCurrency = useCurrency(speedupCode);
  // ⚠️ 잔액도 **그 재화**로 고른다. 표기만 서버를 따르고 게이팅은 무료재화로 두면
  // "500 Z 인데 골드가 모자라서 잠김"이 된다(#213 의 후반부와 같은 형태).
  // 모르는 재화·잔액 미수신(구서버)이면 **잠그지 않는다** — 판정 근거가 없다(balanceFor 주석).
  const balance = balanceFor(speedupCode, { points: walletPoints, gems: walletGems });
  const btn = speedupButtonState({
    loaded: walletLoaded,
    points: balance ?? Number.POSITIVE_INFINITY,
    cost: slot.speedupCost,
    pending: busy,
  });
  // 등급만 공개 — 이름·포지션·능력치는 서버가 아예 안 보낸다(카운트다운 만료 전 정체 비공개).
  const grade = gradeContactLabel(slot.targetGrade);
  return (
    <div className={styles.body}>
      {/* 이미 공개됐던 오퍼(재제안 쿨타임)는 선수 카드를 그대로 유지 — 도로 가리지 않는다. */}
      {reveal === "REVEALED" && slot.target && (
        <TradePlayerCard
          player={slot.target}
          detail={targetDetail}
          caption="영입 대상"
          testId={`trade-slot-${slot.slot}-target`}
          fullArt
        />
      )}
      {reveal === "MASKED" && grade && (
        <div
          className={styles.gradeReveal}
          data-testid={`trade-slot-${slot.slot}-grade`}
          data-grade={slot.targetGrade}
          style={{ borderColor: gradeColor(slot.targetGrade) }}
        >
          <span className={styles.gradeMask} aria-hidden="true">?</span>
          <span className={styles.gradeText} style={{ color: gradeColor(slot.targetGrade) }}>
            {grade}
          </span>
        </div>
      )}
      <div className={styles.countdown} data-testid={`trade-slot-${slot.slot}-countdown`} data-remaining={liveRemainingSec}>
        <span className={styles.countdownLabel}>{waitingCountdownLabel(reveal)}</span>
        <span className={styles.countdownTime}>{formatCountdown(liveRemainingSec)}</span>
      </div>
      {slot.speedupCost != null && (
        <div className={styles.speedupRow}>
          <span className={styles.speedupCost}>
            {/* 재화는 서버가 금액과 **함께** 준다(speedupCurrency, #232) — 클라가 단위를 추측하지 않는다. */}
            단축 비용{" "}
            <Amount
              className={styles.speedupAmount}
              code={slot.speedupCurrency ?? CURRENCY_POINT}
              value={slot.speedupCost}
              icon
            />
          </span>
          <button
            type="button"
            className={styles.speedup}
            data-testid={`trade-slot-${slot.slot}-speedup`}
            disabled={btn.disabled}
            onClick={() => onSpeedup(slot.slot)}
          >
            {speedupCurrency.symbol}로 단축
          </button>
        </div>
      )}
      {btn.showShort && <p className={styles.short}>{shortageMessage(speedupCurrency)}</p>}
    </div>
  );
}
