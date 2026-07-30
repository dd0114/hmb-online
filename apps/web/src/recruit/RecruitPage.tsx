import { useState } from "react";
import { useMe } from "../api/hooks";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
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
  const { data: me } = useMe();
  const initial: Tab =
    new URLSearchParams(window.location.search).get("tab") === "trade" ? "trade" : "gacha";
  const [tab, setTab] = useState<Tab>(initial);

  /**
   * ⚠️ **지갑은 여기서 그린다.** 얹히는 화면들(`ShopPage`·`TradePage`)은 `embedded` 라 자기
   * 헤더를 그리지 않으므로, 상위가 안 그리면 **살 것을 고르는 화면에서 잔액이 사라진다**
   * (실제로 그렇게 됐고 growth-mock 계약이 잡았다). 뽑기·트레이드 둘 다 돈을 쓰는 자리다.
   */
  const header = (
    <div className={styles.headerRow}>
      <h1 className={styles.pageTitle}>영입</h1>
      {typeof me?.wallet?.points === "number" && (
        <PointsBadge points={me.wallet.points} gems={me.wallet.gems ?? 0} />
      )}
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
        {/* 트레이드 설명 (#286 W3, hero 지적: "튜토리얼에 트레이드 설명이 빠져 있음 → 추가").
            ⚠️ **상시 안내 카드**로 둔다. 코치마크만 두면 한 번 보고 넘긴 사람은 영영 못 본다 —
            트레이드는 자주 오지 않아서(슬롯이 시간을 두고 열린다) 다시 볼 자리가 필요하다.
            튜토리얼 코치마크는 이 카드를 **가리키는** 것으로 따로 붙는다(tutorial-steps). */}
        {tab === "trade" && (
          <section className={styles.guide} data-testid="trade-guide">
            <b className={styles.guideTitle}>트레이드란?</b>
            <p className={styles.guideBody}>
              일정 시간마다 <b>이적 제안</b>이 들어옵니다. <b>FA</b>는 재화를 내고 데려오고,
              <b> 맞교환</b>은 내 선수를 내주고 바꿉니다. 제안은 시간이 지나야 공개되고,
              재화로 <b>앞당길</b> 수 있습니다.
            </p>
          </section>
        )}
        {tab === "gacha" ? <ShopPage embedded /> : <TradePage embedded />}
      </div>
    </Layout>
  );
}
