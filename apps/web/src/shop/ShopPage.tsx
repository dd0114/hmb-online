import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useGacha, useMe, type GachaResponse } from "../api/hooks";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { GachaReveal } from "./GachaReveal";
import { TopupPanel } from "./TopupPanel";
import { DicePanel } from "./DicePanel";
import { gachaButtonState } from "./shop-logic";
import type { ShopTab } from "./topup-logic";
import styles from "./ShopPage.module.css";

/**
 * 표시용 뽑기 비용 (D6 — 실제 과금은 서버 economy.v1.json이 SoT, 여기는 UI 라벨).
 * 서버 잔액 검증(INSUFFICIENT_POINTS)이 최종 게이트.
 */
export const GACHA_COST_SINGLE = 300;
export const GACHA_COST_TEN = 3000;

export function ShopPage() {
  const navigate = useNavigate();
  const { data: me, isLoading: meLoading, isError: meError } = useMe();
  const gacha = useGacha();
  const [reveal, setReveal] = useState<GachaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 탭 전환은 순수 로컬 상태 — 어떤 fetch/invalidate 도 유발하지 않는다(AC-D1).
  const [tab, setTab] = useState<ShopTab>("gacha");

  const points = me?.wallet.points ?? 0;

  function pull(kind: "single" | "ten") {
    setError(null);
    gacha.mutate(
      { kind },
      {
        onSuccess: (res) => setReveal(res),
        onError: (err) => {
          if (err instanceof ApiError) {
            setError(
              err.code === "INSUFFICIENT_POINTS" ? `포인트가 부족합니다 — ${err.message}` : err.message,
            );
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
      {me && <PointsBadge points={points} />}
    </div>
  );

  // 잔액을 아직 모를 때는 '부족' 문구를 띄우지 않는다(#73 P0 — points ?? 0 로 오판하던 플래시 방지).
  const single = gachaButtonState({ loaded: !!me, points, cost: GACHA_COST_SINGLE, pending: gacha.isPending });
  const ten = gachaButtonState({ loaded: !!me, points, cost: GACHA_COST_TEN, pending: gacha.isPending });

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
      </div>

      {tab === "topup" ? (
        <TopupPanel />
      ) : tab === "dice" ? (
        <DicePanel points={points} />
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
            {GACHA_COST_SINGLE.toLocaleString("ko-KR")} P
          </button>
          {single.showShort && <p className={styles.shortNote}>포인트가 부족합니다</p>}
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
            {GACHA_COST_TEN.toLocaleString("ko-KR")} P
          </button>
          {ten.showShort && <p className={styles.shortNote}>포인트가 부족합니다</p>}
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
