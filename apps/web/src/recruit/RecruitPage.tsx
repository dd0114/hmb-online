import { useState } from "react";
import { Layout } from "../common/Layout";
import { ShopPage } from "../shop/ShopPage";
import { TradePage } from "../trade/TradePage";
import styles from "./RecruitPage.module.css";

type Tab = "gacha" | "trade";

/**
 * 영입 (#286 W2) — **뽑기 + 트레이드를 한 화면**으로(hero 결정).
 *
 * 둘 다 "선수를 새로 들이는" 행위라 탭을 나눌 이유가 없었다. 지금은 기존 두 화면을
 * `embedded` 로 얹기만 한다(내용 심화·튜토리얼 설명은 W3).
 *
 * ⚠️ 구 URL `/shop`·`/trade` 는 여기로 리다이렉트된다 — 북마크와 기존 링크가 죽지 않게.
 * 그래서 **트레이드가 기본 탭이 되는 경로가 필요**하다: `/recruit?tab=trade` 로 들어오면
 * 트레이드가 열린다(리다이렉트가 그 쿼리를 붙인다). 안 그러면 `/trade` 북마크가 뽑기로 떨어진다.
 */
export function RecruitPage() {
  const initial: Tab =
    new URLSearchParams(window.location.search).get("tab") === "trade" ? "trade" : "gacha";
  const [tab, setTab] = useState<Tab>(initial);

  const header = (
    <div className={styles.headerRow}>
      <h1 className={styles.pageTitle}>영입</h1>
    </div>
  );

  return (
    <Layout header={header} nav>
      <div className={styles.seg} role="tablist" aria-label="영입 방법">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "gacha"}
          className={tab === "gacha" ? `${styles.segItem} ${styles.segOn}` : styles.segItem}
          data-testid="recruit-tab-gacha"
          onClick={() => setTab("gacha")}
        >
          뽑기
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trade"}
          className={tab === "trade" ? `${styles.segItem} ${styles.segOn}` : styles.segItem}
          data-testid="recruit-tab-trade"
          onClick={() => setTab("trade")}
        >
          트레이드
        </button>
      </div>

      <div data-testid="recruit-page">
        {tab === "gacha" ? <ShopPage embedded /> : <TradePage embedded />}
      </div>
    </Layout>
  );
}
