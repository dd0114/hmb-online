import { useState } from "react";
import { ApiError } from "../api/client";
import { INSUFFICIENT_GEMS_CODE } from "../api/growth";
import { useBuyDice, useDiceBalance, useGemTopup } from "../api/growth-hooks";
import { ErrorToast } from "../common/ErrorToast";
import { DICE_BUY_COST, DICE_CASH_GEM_COST, GEM_TOPUP_PACKS } from "../growth/growth-config";
import styles from "./DicePanel.module.css";

interface DicePanelProps {
  points: number;
  /** V2.2 재화 이원화(에픽 #179 hero 확정) — 캐시 다이스는 젬 결제. */
  gems: number;
}

/**
 * 상점 다이스 구매 섹션(에픽 #179 §V2-6, V2.2 §스펙) — 노말 500P(포인트 결제) /
 * 캐시 10젬(젬 결제, 구 5,000P 목업 폐기). 구매 시 지갑 플래시(hero 피드백: 재화 소모 가시화) +
 * 잠재 다이스 잔고 즉시 갱신(useBuyDice). 젬 부족(INSUFFICIENT_GEMS) 시 안내 + 아래 젬 충전
 * (목업) 섹션으로 유도 — 충전은 실결제 없이 클릭 즉시 지급(useGemTopup).
 */
export function DicePanel({ points, gems }: DicePanelProps) {
  const buyDice = useBuyDice();
  const gemTopup = useGemTopup();
  const { data: balance } = useDiceBalance();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  function flashWallet() {
    setFlash(true);
    window.setTimeout(() => setFlash(false), 500);
  }

  function buy(kind: "NORMAL" | "CASH") {
    setError(null);
    if (kind === "NORMAL" && points < DICE_BUY_COST.NORMAL) {
      setError("포인트가 부족합니다");
      return;
    }
    if (kind === "CASH" && gems < DICE_CASH_GEM_COST) {
      setError("젬이 부족합니다 — 아래 젬 충전에서 채워 주세요");
      return;
    }
    buyDice.mutate(
      { kind, count: 1 },
      {
        onSuccess: () => flashWallet(),
        onError: (err) => {
          if (err instanceof ApiError && err.code === INSUFFICIENT_GEMS_CODE) {
            setError("젬이 부족합니다 — 아래 젬 충전에서 채워 주세요");
          } else {
            setError(err instanceof ApiError ? err.message : "다이스 구매에 실패했습니다");
          }
        },
      },
    );
  }

  function topup(packId: string) {
    setError(null);
    gemTopup.mutate(
      { packId },
      {
        onSuccess: () => flashWallet(),
        onError: (err) => {
          setError(err instanceof ApiError ? err.message : "젬 충전에 실패했습니다");
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
            <span data-testid="dice-cash-price">💎 {DICE_CASH_GEM_COST}</span> 로 구매
          </button>
        </div>
      </div>

      <p
        className={flash ? `${styles.walletLine} ${styles.walletFlash}` : styles.walletLine}
        data-testid="dice-wallet-flash"
      >
        지갑 {points.toLocaleString("ko-KR")} P · 💎 {gems.toLocaleString("ko-KR")}
      </p>

      <section className={styles.topupSection} data-testid="gem-topup-section">
        <h2 className={styles.title}>젬 충전 (목업)</h2>
        <p className={styles.topupNotice}>목업 — 실결제 없음. 클릭하면 즉시 지급됩니다.</p>
        <div className={styles.gemGrid}>
          {GEM_TOPUP_PACKS.map((pack) => (
            <button
              key={pack.id}
              type="button"
              className={styles.gemCard}
              data-testid={`gem-topup-${pack.id}`}
              disabled={gemTopup.isPending}
              onClick={() => topup(pack.id)}
            >
              <span className={styles.gemAmount}>💎 {pack.gems.toLocaleString("ko-KR")}</span>
              <span className={styles.gemPrice}>{pack.mockPrice}</span>
            </button>
          ))}
        </div>
      </section>

      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
