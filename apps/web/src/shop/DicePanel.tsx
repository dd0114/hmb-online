import { useState } from "react";
import { ApiError } from "../api/client";
import { useAppConfigValue } from "../common/AppConfigContext";
import { INSUFFICIENT_GEMS_CODE } from "../api/growth";
import { useBuyDice, useDiceBalance, useGemTopup } from "../api/growth-hooks";
import { Amount, useCurrency } from "../common/Amount";
import { CURRENCY_GEM, CURRENCY_POINT, shortageMessage } from "../common/currency";
import { ErrorToast } from "../common/ErrorToast";
import styles from "./DicePanel.module.css";

interface DicePanelProps {
  points: number;
  /** V2.2 재화 이원화(에픽 #179 hero 확정) — 캐시 다이스는 유상재화 결제. */
  gems: number;
}

/**
 * 상점 다이스 구매 섹션(에픽 #179 §V2-6, V2.2 §스펙) — 노말=무료재화 / 캐시=유상재화.
 *
 * ⚠️ **가격·재화·충전팩은 전부 서버 config 에서 온다** (#232). 예전엔 `growth-config.ts` 의
 * 미러 상수를 그렸는데, 서버가 노말 다이스를 5,000 으로 올린 뒤에도 화면은 "500 P" 를 그리고
 * 있었다 — 눌러서 성공하면 지갑이 10배로 줄어드는 화면이었다. 미러를 되살리지 마라.
 */
export function DicePanel({ points, gems }: DicePanelProps) {
  const buyDice = useBuyDice();
  const gemTopup = useGemTopup();
  const config = useAppConfigValue();
  const { data: balance } = useDiceBalance();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const dice = config?.shop?.dice ?? null;
  const topupCfg = config?.shop?.gemTopup ?? null;
  const gemCurrency = useCurrency(CURRENCY_GEM);
  const pointCurrency = useCurrency(CURRENCY_POINT);

  function flashWallet() {
    setFlash(true);
    window.setTimeout(() => setFlash(false), 500);
  }

  /** 유상재화 부족 안내 — 이름은 서버 표기 메타에서 온다(충전이 열려 있을 때만 유도 문구를 붙인다). */
  function gemShortage(): string {
    const base = shortageMessage(gemCurrency);
    return topupCfg?.enabled ? `${base} — 아래 충전에서 채워 주세요` : base;
  }

  function buy(kind: "NORMAL" | "CASH") {
    setError(null);
    const price = kind === "NORMAL" ? dice?.normal : dice?.cash;
    if (!price) return; // config 미로딩 — 버튼도 잠겨 있다.
    const wallet = price.currency === CURRENCY_GEM ? gems : points;
    if (wallet < price.cost) {
      setError(price.currency === CURRENCY_GEM ? gemShortage() : shortageMessage(pointCurrency));
      return;
    }
    buyDice.mutate(
      { kind, count: 1 },
      {
        onSuccess: () => flashWallet(),
        onError: (err) => {
          if (err instanceof ApiError && err.code === INSUFFICIENT_GEMS_CODE) {
            setError(gemShortage());
          } else {
            // 서버가 표기 메타로 문구를 만든다 — 클라가 재화 이름을 지어내지 않는다.
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
          setError(err instanceof ApiError ? err.message : "충전에 실패했습니다");
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
            disabled={buyDice.isPending || !dice}
            onClick={() => buy("NORMAL")}
          >
            {dice && (
              <>
                <Amount
                  data-testid="dice-normal-price"
                  code={dice.normal.currency}
                  value={dice.normal.cost}
                />{" "}
                로 구매
              </>
            )}
          </button>
        </div>
        <div className={styles.card}>
          <h2 className={styles.title}>캐시 다이스</h2>
          <p className={styles.desc}>보유 {balance?.cash ?? 0}개 — 상위 옵션 가중</p>
          <button
            type="button"
            className={styles.buyButton}
            data-testid="dice-buy-cash"
            disabled={buyDice.isPending || !dice}
            onClick={() => buy("CASH")}
          >
            {dice && (
              <>
                <Amount
                  data-testid="dice-cash-price"
                  code={dice.cash.currency}
                  value={dice.cash.cost}
                  icon
                />{" "}
                로 구매
              </>
            )}
          </button>
        </div>
      </div>

      <p
        className={flash ? `${styles.walletLine} ${styles.walletFlash}` : styles.walletLine}
        data-testid="dice-wallet-flash"
      >
        지갑 <Amount code={CURRENCY_POINT} value={points} icon /> ·{" "}
        <Amount code={CURRENCY_GEM} value={gems} icon />
      </p>

      {/*
        충전 목업은 서버 플래그를 따른다 (#212 → #232). 비활성일 때 그리면 클릭이 403 TOPUP_DISABLED 로
        떨어지는 죽은 UI 가 된다. 실결제가 붙으면 플래그만 켜면 되므로 코드는 남긴다.
      */}
      {topupCfg?.enabled && (
        <section className={styles.topupSection} data-testid="gem-topup-section">
          <h2 className={styles.title}>{gemCurrency.name} 충전 (목업)</h2>
          <p className={styles.topupNotice}>목업 — 실결제 없음. 클릭하면 즉시 지급됩니다.</p>
          <div className={styles.gemGrid}>
            {topupCfg.packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                className={styles.gemCard}
                data-testid={`gem-topup-${pack.id}`}
                disabled={gemTopup.isPending}
                onClick={() => topup(pack.id)}
              >
                <Amount
                  className={styles.gemAmount}
                  code={CURRENCY_GEM}
                  value={pack.gems}
                  icon
                />
                <span className={styles.gemPrice}>{pack.mockPrice}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
