import type { CatalogPlayer } from "../api/hooks";
import type { TradeResolveResponse } from "../api/v2";
import { Modal } from "../common/Modal";
import { playerNameOf } from "../common/player-names";
import { formatProbability } from "./trade-logic";
import { TradePlayerCard } from "./TradePlayerCard";
import styles from "./TradeResultModal.module.css";

interface TradeResultModalProps {
  result: TradeResolveResponse;
  catalog: Map<string, CatalogPlayer>;
  onClose: () => void;
}

/**
 * Trade result 연출 (AC-D): SUCCESS reveals the acquired player card, FAIL shows the cooldown
 * note, DECLINED shows the re-wait note. (GachaReveal is shape-coupled to the multi-card
 * GachaResponse; a single-card reveal is a cleaner fit here — reuse evaluated, not forced.)
 */
export function TradeResultModal({ result, catalog, onClose }: TradeResultModalProps) {
  const acquired = result.acquired;
  const prob = formatProbability(result.probability);

  const title =
    result.result === "SUCCESS" ? "트레이드 성공!" :
    result.result === "FAIL" ? "트레이드 실패" :
    result.result === "DECLINED" ? "제안 거절" : "만료됨";

  return (
    <Modal
      onClose={onClose}
      labelledBy="trade-result-title"
      overlayClassName={styles.overlay}
      className={styles.sheet}
      testId="trade-result"
    >
      <h2 id="trade-result-title" className={styles.title} data-result={result.result}>
        {title}
      </h2>

      {result.result === "SUCCESS" && acquired && (
        <div className={styles.revealWrap}>
          <TradePlayerCard
            player={acquired}
            detail={catalog.get(acquired.playerId)}
            caption="영입 완료"
            testId="trade-result-acquired"
          />
          {result.released && (
            <p className={styles.released} data-testid="trade-result-released">
              {/* 같은 사다리(카탈로그 우선 → 서버가 준 이름 → `미상 선수`)를 쓴다 — 여기만 서버
                  `PlayerRef.name` 을 직독하면 이 한 줄만 옛 이름으로 남는다(#406 요구 6). */}
              {playerNameOf(catalog.get(result.released.playerId), "full", result.released.name)}{" "}
              선수가 팀을 떠났습니다.
            </p>
          )}
        </div>
      )}

      {result.result === "FAIL" && (
        <p className={styles.note} data-testid="trade-result-fail-note">
          아쉽게 실패했습니다. 잠시 후 다시 제안할 수 있습니다 (쿨타임).
        </p>
      )}

      {result.result === "DECLINED" && (
        <p className={styles.note} data-testid="trade-result-declined-note">
          제안을 거절했습니다. 슬롯이 다시 대기 상태로 돌아갑니다.
        </p>
      )}

      {prob && (
        <p className={styles.prob}>
          판정 확률 <strong>{prob}</strong>
        </p>
      )}

      <button type="button" className={styles.close} data-testid="trade-result-close" onClick={onClose}>
        확인
      </button>
    </Modal>
  );
}
