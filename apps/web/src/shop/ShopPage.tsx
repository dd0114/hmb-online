import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useGacha, useMe, type GachaResponse } from "../api/hooks";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { GachaReveal } from "./GachaReveal";
import styles from "./ShopPage.module.css";

/**
 * 표시용 뽑기 비용 (D6 — 실제 과금은 서버 economy.v1.json이 SoT, 여기는 UI 라벨).
 * 서버 잔액 검증(INSUFFICIENT_POINTS)이 최종 게이트.
 */
export const GACHA_COST_SINGLE = 300;
export const GACHA_COST_TEN = 3000;

export function ShopPage() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const gacha = useGacha();
  const [reveal, setReveal] = useState<GachaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const singleShort = points < GACHA_COST_SINGLE;
  const tenShort = points < GACHA_COST_TEN;

  return (
    <Layout header={header}>
      <div className={styles.pulls}>
        <div className={styles.pullCard}>
          <h2 className={styles.pullTitle}>단뽑</h2>
          <p className={styles.pullDesc}>선수 1명</p>
          <button
            type="button"
            className={styles.pullButton}
            data-testid="gacha-single"
            disabled={gacha.isPending || singleShort}
            onClick={() => pull("single")}
          >
            {GACHA_COST_SINGLE.toLocaleString("ko-KR")} P
          </button>
          {singleShort && <p className={styles.shortNote}>포인트가 부족합니다</p>}
        </div>

        <div className={styles.pullCard}>
          <h2 className={styles.pullTitle}>10연뽑</h2>
          <p className={styles.pullDesc}>선수 11명 · 골드 이상 1명 보장</p>
          <button
            type="button"
            className={styles.pullButton}
            data-testid="gacha-ten"
            disabled={gacha.isPending || tenShort}
            onClick={() => pull("ten")}
          >
            {GACHA_COST_TEN.toLocaleString("ko-KR")} P
          </button>
          {tenShort && <p className={styles.shortNote}>포인트가 부족합니다</p>}
        </div>
      </div>

      {gacha.isPending && <p className={styles.pending}>뽑는 중…</p>}
      <ErrorToast message={error} onDismiss={() => setError(null)} />

      {reveal && <GachaReveal response={reveal} onClose={() => setReveal(null)} />}
    </Layout>
  );
}
