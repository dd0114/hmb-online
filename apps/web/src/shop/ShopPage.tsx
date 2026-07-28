import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAppConfigValue } from "../common/AppConfigContext";
import { useGacha, useMe, type GachaResponse } from "../api/hooks";
import { Layout } from "../common/Layout";
import { Amount, useCurrency } from "../common/Amount";
import { balanceFor, shortageMessage } from "../common/currency";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { GachaReveal } from "./GachaReveal";
import { TopupPanel } from "./TopupPanel";
import { DicePanel } from "./DicePanel";
import { gachaButtonState } from "./shop-logic";
import type { ShopTab } from "./topup-logic";
import styles from "./ShopPage.module.css";

export function ShopPage() {
  const navigate = useNavigate();
  const { data: me, isLoading: meLoading, isError: meError } = useMe();
  const config = useAppConfigValue();
  const gacha = useGacha();
  const [reveal, setReveal] = useState<GachaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 탭 전환은 순수 로컬 상태 — 어떤 fetch/invalidate 도 유발하지 않는다(AC-D1).
  const [tab, setTab] = useState<ShopTab>("gacha");

  const points = me?.wallet.points ?? 0;
  const gems = me?.wallet.gems ?? 0;

  /**
   * 가격·결제 재화는 **서버 config 가 SoT** (#232/#213). 예전엔 여기 상수(300/3,000)를 두고 "P"로
   * 그렸는데, #212 가 뽑기를 다이아 결제로 바꾸면서 화면이 실제 결제와 어긋났다 — 표기만 고치면
   * "300 G" 라는 더 확실한 거짓말이 되므로 가격 자체를 서버에서 받는다.
   */
  const gachaCfg = config?.shop?.gacha ?? null;
  const payCurrencyCode = gachaCfg?.single.currency ?? "";
  const payCurrency = useCurrency(payCurrencyCode);
  // 잔액 판정은 **결제 재화 기준**이다. 모르는 재화면 잠그지 않고 서버 판정에 맡긴다(balanceFor 주석).
  const known = balanceFor(payCurrencyCode, { points, gems });
  const knownBalance = known !== null;
  const balance = known ?? Number.POSITIVE_INFINITY;

  function pull(kind: "single" | "ten") {
    setError(null);
    gacha.mutate(
      { kind },
      {
        onSuccess: (res) => setReveal(res),
        onError: (err) => {
          if (err instanceof ApiError) {
            // 서버가 표기 메타로 문구를 만들어 준다 — 클라가 재화 이름을 지어내지 않는다.
            setError(err.message);
          } else {
            setError("뽑기 요청에 실패했습니다");
          }
        },
      },
    );
  }

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>상점</h1>
      {me && <PointsBadge points={points} gems={gems} />}
    </div>
  );

  // 잔액/가격을 아직 모를 때는 '부족' 문구를 띄우지 않고 버튼만 잠근다
  // (#73 P0 — points ?? 0 로 오판하던 플래시 방지. config 미로딩도 같은 이유로 loaded=false).
  const loaded = !!me && !!gachaCfg;
  const single = gachaButtonState({
    loaded,
    points: balance,
    cost: gachaCfg?.single.cost ?? 0,
    pending: gacha.isPending,
  });
  const ten = gachaButtonState({
    loaded,
    points: balance,
    cost: gachaCfg?.ten.cost ?? 0,
    pending: gacha.isPending,
  });
  // 잔액을 모르는 재화면 "부족" 문구도 띄우지 않는다(우리가 판정할 근거가 없다).
  const short = knownBalance ? shortageMessage(payCurrency) : "";
  // 충전 탭은 서버 플래그를 따른다 — 비활성(#212 젬 수도꼭지 차단)인데 노출하면 누르는 족족 403 이다.
  const topupEnabled = config?.shop?.gemTopup?.enabled ?? false;

  return (
    <Layout header={header} nav>
      {meError && <ErrorToast message="지갑 정보를 불러오지 못했습니다" />}

      <div className={styles.tabs} role="tablist" aria-label="상점 탭">
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-testid="shop-tab-gacha"
          aria-selected={tab === "gacha"}
          data-active={tab === "gacha"}
          onClick={() => setTab("gacha")}
        >
          뽑기
        </button>
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-testid="shop-tab-dice"
          aria-selected={tab === "dice"}
          data-active={tab === "dice"}
          onClick={() => setTab("dice")}
        >
          다이스
        </button>
        {topupEnabled && (
          <button
            type="button"
            role="tab"
            className={styles.tab}
            data-testid="shop-tab-topup"
            aria-selected={tab === "topup"}
            data-active={tab === "topup"}
            onClick={() => setTab("topup")}
          >
            충전
          </button>
        )}
      </div>

      {tab === "topup" && topupEnabled ? (
        <TopupPanel />
      ) : tab === "dice" ? (
        <DicePanel points={points} gems={gems} />
      ) : (
        <>
      <div className={styles.pulls}>
        <div className={styles.pullCard}>
          <h2 className={styles.pullTitle}>단뽑</h2>
          <p className={styles.pullDesc}>선수 1명</p>
          <button
            type="button"
            className={styles.pullButton}
            data-testid="gacha-single"
            disabled={single.disabled}
            onClick={() => pull("single")}
          >
            {gachaCfg && <Amount code={gachaCfg.single.currency} value={gachaCfg.single.cost} />}
          </button>
          {single.showShort && short && <p className={styles.shortNote}>{short}</p>}
        </div>

        <div className={styles.pullCard}>
          <h2 className={styles.pullTitle}>10연뽑</h2>
          <p className={styles.pullDesc}>선수 11명 · 골드 이상 1명 보장</p>
          <button
            type="button"
            className={styles.pullButton}
            data-testid="gacha-ten"
            disabled={ten.disabled}
            onClick={() => pull("ten")}
          >
            {gachaCfg && <Amount code={gachaCfg.ten.currency} value={gachaCfg.ten.cost} />}
          </button>
          {ten.showShort && short && <p className={styles.shortNote}>{short}</p>}
        </div>
      </div>

      {meLoading && <p className={styles.pending}>지갑 불러오는 중…</p>}
      {gacha.isPending && <p className={styles.pending}>뽑는 중…</p>}
        </>
      )}

      <ErrorToast message={error} onDismiss={() => setError(null)} />

      {reveal && <GachaReveal response={reveal} onClose={() => setReveal(null)} />}
    </Layout>
  );
}
