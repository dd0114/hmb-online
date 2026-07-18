import type { CatalogPlayer } from "../api/hooks";
import type { FaProposeRequest, TradeSlot } from "../api/v2";
import { PointsBadge } from "../common/PointsBadge";
import { ProposeBuilder } from "./ProposeBuilder";
import { TradePlayerCard } from "./TradePlayerCard";
import {
  formatCountdown,
  formatProbability,
  slotView,
  speedupButtonState,
} from "./trade-logic";
import styles from "./TradeSlotCard.module.css";

interface TradeSlotCardProps {
  slot: TradeSlot;
  /** Live countdown for WAITING (parent ticks it once/second). */
  liveRemainingSec: number;
  walletPoints: number;
  walletLoaded: boolean;
  /** playerId → catalog entry, for enriching PlayerRef with attributes·personality. */
  catalog: Map<string, CatalogPlayer>;
  /** My owned players (FA offer pool). */
  owned: CatalogPlayer[];
  busy: boolean;
  onSpeedup: (slot: number) => void;
  onPropose: (slot: number, body: FaProposeRequest) => void;
  onAccept: (slot: number) => void;
  onDecline: (slot: number) => void;
}

export function TradeSlotCard(props: TradeSlotCardProps) {
  const { slot, liveRemainingSec, walletPoints, walletLoaded, catalog, owned, busy } = props;
  const view = slotView(slot);
  const target = slot.target ? catalog.get(slot.target.playerId) : undefined;
  const demand = slot.demand ? catalog.get(slot.demand.playerId) : undefined;

  return (
    <section
      className={styles.card}
      data-testid={`trade-slot-${slot.slot}`}
      data-view={view}
    >
      <header className={styles.head}>
        <span className={styles.slotNo}>슬롯 {slot.slot}</span>
        <span className={styles.badge} data-testid={`trade-slot-${slot.slot}-badge`}>
          {view === "WAITING" && "대기 중"}
          {view === "OPEN_FA" && "FA 영입"}
          {view === "OPEN_TRADE" && "트레이드 제안"}
          {view === "RESOLVING" && "처리 중"}
        </span>
      </header>

      {view === "WAITING" && (
        <WaitingBody
          slot={slot}
          liveRemainingSec={liveRemainingSec}
          walletPoints={walletPoints}
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
            />
          </div>
          {slot.acceptProbability != null && (
            <p className={styles.prob} data-testid={`trade-slot-${slot.slot}-prob`}>
              성공 확률 <strong>{formatProbability(slot.acceptProbability)}</strong>
            </p>
          )}
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
            <button
              type="button"
              className={styles.decline}
              data-testid={`trade-slot-${slot.slot}-decline`}
              disabled={busy}
              onClick={() => props.onDecline(slot.slot)}
            >
              거절
            </button>
          </div>
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

function WaitingBody({
  slot,
  liveRemainingSec,
  walletPoints,
  walletLoaded,
  busy,
  onSpeedup,
}: {
  slot: TradeSlot;
  liveRemainingSec: number;
  walletPoints: number;
  walletLoaded: boolean;
  busy: boolean;
  onSpeedup: (slot: number) => void;
}) {
  const btn = speedupButtonState({
    loaded: walletLoaded,
    points: walletPoints,
    cost: slot.speedupCost,
    pending: busy,
  });
  return (
    <div className={styles.body}>
      <div className={styles.countdown} data-testid={`trade-slot-${slot.slot}-countdown`} data-remaining={liveRemainingSec}>
        <span className={styles.countdownLabel}>다음 선수까지</span>
        <span className={styles.countdownTime}>{formatCountdown(liveRemainingSec)}</span>
      </div>
      {slot.speedupCost != null && (
        <div className={styles.speedupRow}>
          <span className={styles.speedupCost}>
            단축 비용 <PointsBadge points={slot.speedupCost} />
          </span>
          <button
            type="button"
            className={styles.speedup}
            data-testid={`trade-slot-${slot.slot}-speedup`}
            disabled={btn.disabled}
            onClick={() => onSpeedup(slot.slot)}
          >
            포인트로 단축
          </button>
        </div>
      )}
      {btn.showShort && <p className={styles.short}>포인트가 부족합니다</p>}
    </div>
  );
}
