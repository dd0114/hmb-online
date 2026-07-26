import { useState } from "react";
import { ApiError } from "../api/client";
import { useBuyDice, useDiceBalance } from "../api/growth-hooks";
import { ErrorToast } from "../common/ErrorToast";
import { DICE_BUY_COST } from "../growth/growth-config";
import styles from "./DicePanel.module.css";

interface DicePanelProps {
  points: number;
}

/**
 * 상점 다이스 구매 섹션(에픽 #179 §V2-6) — 노말 500P / 캐시 5,000P 목업(포인트 결제).
 * 구매 시 지갑 플래시(hero 피드백: 재화 소모 가시화) + 잠재 다이스 잔고 즉시 갱신(useBuyDice).
 */
export function DicePanel({ points }: DicePanelProps) {
  const buyDice = useBuyDice();
  const { data: balance } = useDiceBalance();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  function buy(kind: "NORMAL" | "CASH") {
    setError(null);
    const cost = kind === "NORMAL" ? DICE_BUY_COST.NORMAL : DICE_BUY_COST.CASH;
    if (points < cost) {
      setError("포인트가 부족합니다");
      return;
    }
    buyDice.mutate(
      { kind, count: 1 },
      {
        onSuccess: () => {
          setFlash(true);
          window.setTimeout(() => setFlash(false), 500);
        },
        onError: (err) => {
          setError(err instanceof ApiError ? err.message : "다이스 구매에 실패했습니다");
        },
      },
    );
  }

  return (
    <div data-testid="dice-panel">
      <p className={styles.notice}>잠재능력 다이스 — 도감 카드 상세에서 잠재 줄을 리롤합니다.</p>
      <div className={styles.grid}>
        <div className={styles.card}>
          <h2 className={styles.title}>노말 다이스</h2>
          <p className={styles.desc}>보유 {balance?.normal ?? 0}개 — 티어업 가능</p>
          <button
            type="button"
            className={styles.buyButton}
            data-testid="dice-buy-normal"
            disabled={buyDice.isPending}
            onClick={() => buy("NORMAL")}
          >
            {DICE_BUY_COST.NORMAL.toLocaleString("ko-KR")} P 로 구매
          </button>
        </div>
        <div className={styles.card}>
          <h2 className={styles.title}>캐시 다이스</h2>
          <p className={styles.desc}>보유 {balance?.cash ?? 0}개 — 상위 옵션 가중</p>
          <button
            type="button"
            className={styles.buyButton}
            data-testid="dice-buy-cash"
            disabled={buyDice.isPending}
            onClick={() => buy("CASH")}
          >
            {DICE_BUY_COST.CASH.toLocaleString("ko-KR")} P 로 구매
          </button>
        </div>
      </div>

      <p className={flash ? `${styles.walletLine} ${styles.walletFlash}` : styles.walletLine} data-testid="dice-wallet-flash">
        지갑 {points.toLocaleString("ko-KR")} P
      </p>

      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
