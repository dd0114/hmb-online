import { useState } from "react";
import { ApiError } from "../api/client";
import { useAppConfigValue } from "../common/AppConfigContext";
import { useGemTopup } from "../api/growth-hooks";
import { Amount, useCurrency } from "../common/Amount";
import { CURRENCY_GEM, CURRENCY_POINT } from "../common/currency";
import { ErrorToast } from "../common/ErrorToast";
import styles from "./GemTopupPanel.module.css";

interface GemTopupPanelProps {
  points: number;
  gems: number;
}

/**
 * 유상재화 충전(목업) — `POST /api/shop/gems/topup`.
 *
 * <p><b>왜 여기 있나.</b> 이 섹션은 원래 상점 [다이스] 탭(`DicePanel`) 안에 있었는데, #247 로
 * 다이스 구매가 사라지면서 그 탭이 통째로 없어졌다. 충전은 다이스와 아무 관계가 없으므로
 * 같이 지우지 않고 <b>[충전] 탭으로 옮겼다</b> — 게이팅 플래그도 원래 같았다
 * ({@code shop.gemTopup.enabled}).
 *
 * <p>비활성일 때는 이 컴포넌트가 렌더되지 않는다(호출부가 플래그로 가른다) — 그리면 클릭이
 * 403 TOPUP_DISABLED 로 떨어지는 죽은 UI 가 된다. 실결제가 붙으면 플래그만 켜면 되므로
 * 코드는 남긴다(#212 가 무제한 무료 수도꼭지를 잠갔다).
 *
 * <p>⚠️ 금액·팩·재화 표기는 <b>전부 서버 config</b>에서 온다(#232). 미러 상수를 되살리지 마라.
 */
export function GemTopupPanel({ points, gems }: GemTopupPanelProps) {
  const gemTopup = useGemTopup();
  const config = useAppConfigValue();
  const gemCurrency = useCurrency(CURRENCY_GEM);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const topupCfg = config?.shop?.gemTopup ?? null;
  if (!topupCfg?.enabled) return null;

  function topup(packId: string) {
    setError(null);
    gemTopup.mutate(
      { packId },
      {
        onSuccess: () => {
          setFlash(true);
          window.setTimeout(() => setFlash(false), 500);
        },
        onError: (err) => {
          setError(err instanceof ApiError ? err.message : "충전에 실패했습니다");
        },
      },
    );
  }

  return (
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
            <Amount className={styles.gemAmount} code={CURRENCY_GEM} value={pack.gems} icon />
            <span className={styles.gemPrice}>{pack.mockPrice}</span>
          </button>
        ))}
      </div>

      <p
        className={flash ? `${styles.walletLine} ${styles.walletFlash}` : styles.walletLine}
        data-testid="gem-topup-wallet-flash"
      >
        지갑 <Amount code={CURRENCY_POINT} value={points} icon /> ·{" "}
        <Amount code={CURRENCY_GEM} value={gems} icon />
      </p>

      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </section>
  );
}
