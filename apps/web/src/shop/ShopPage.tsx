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
import { GemTopupPanel } from "./GemTopupPanel";
import { gachaButtonState } from "./shop-logic";
import { GACHA_PROMO, PROMO_GRADES, rateRows, tenPullNote } from "./gacha-promo";
import { GRADE_COLORS, GRADE_GLOW_COLORS, GRADE_LABELS } from "../common/grades";
import type { ShopTab } from "./topup-logic";
import styles from "./ShopPage.module.css";

/**
 * ⚠️ `embedded` (#286 W2): 이 화면은 이제 **상위 탭 안에 얹혀** 산다(상점(뽑기)).
 * embedded 면 자기 `Layout`·헤더를 그리지 않는다 — 안 그러면 `app-container` 가 두 겹이 되어
 * 하단 네비 여백·최대폭이 이중으로 걸린다. 단독 라우트는 아직 리다이렉트로만 들어오므로
 * 비-embedded 경로도 남겨 둔다(구 URL 이 죽지 않게).
 */
export function ShopPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const { data: me, isLoading: meLoading, isError: meError } = useMe();
  const config = useAppConfigValue();
  const gacha = useGacha();
  const [reveal, setReveal] = useState<GachaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 탭 전환은 순수 로컬 상태 — 어떤 fetch/invalidate 도 유발하지 않는다(AC-D1).
  const [tab, setTab] = useState<ShopTab>("gacha");

  // ⚠️ `me?.wallet.points` 는 **`me` 가 `{}` 일 때 던진다** — 옵셔널 체이닝은 `me` 만 보고
  // `wallet` 은 안 본다. 구 서버·빈 응답의 200 `{}` 가 정확히 그 형태라 화면이 흰 화면이 됐다.
  // `/recruit` 는 이제 **상점에 가는 유일한 길**이라 더 세게 지킨다(#286 독립검증 MAJ-3).
  const points = me?.wallet?.points ?? 0;
  const gems = me?.wallet?.gems ?? 0;

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
      <button type="button" className={styles.back} onClick={() => navigate("/home")}>
        ← 홈
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
  // 홍보 구역 파생값 — 둘 다 **서버가 줄 때만** 내용이 생긴다(#457 C1 · #458).
  const rates = rateRows(gachaCfg);
  const tenNote = tenPullNote(gachaCfg);
  // 충전 탭은 서버 플래그를 따른다 — 비활성(#212 젬 수도꼭지 차단)인데 노출하면 누르는 족족 403 이다.
  const topupEnabled = config?.shop?.gemTopup?.enabled ?? false;

  const body = (
    <>
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
        {/* #247: [다이스] 탭 제거 — 잠재 리롤은 강화 상세에서 지갑으로 바로 결제한다(구매 단계 없음). */}
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
        <>
          <TopupPanel />
          {/* #247: DicePanel 이 사라지며 유상재화 충전(목업)이 여기로 왔다 — 게이팅 플래그는 원래 같다. */}
          <GemTopupPanel points={points} gems={gems} />
        </>
      ) : (
        <>
      {/*
        **홍보 구역** (#457 C1, hero: *"뽑기화면 너무 심심해 … 지금 레전드 선수를 뽑아보세요 같은
        홍보페이지 만들어"*). 그전에는 이 화면이 **버튼 카드 2장**이 전부였다.
        문구·확률표는 `gacha-promo.ts` 가 소유한다 — 화면은 그리기만 한다(문장을 여기 적으면
        톤을 바꿀 때 두 곳이 갈린다). 확률표는 서버가 `rates` 를 줄 때만 뜬다(#458).
      */}
      <section className={styles.promo} data-testid="gacha-promo">
        <p className={styles.promoKicker}>{GACHA_PROMO.kicker}</p>
        <h2 className={styles.promoTitle}>{GACHA_PROMO.title}</h2>
        <p className={styles.promoBody}>{GACHA_PROMO.body}</p>

        <ul className={styles.gradeRow} data-testid="gacha-promo-grades">
          {PROMO_GRADES.map((g) => (
            <li
              key={g}
              className={styles.gradeChip}
              style={{ ["--glow" as string]: GRADE_GLOW_COLORS[g], color: GRADE_COLORS[g] }}
              data-grade={g}
            >
              {GRADE_LABELS[g]}
            </li>
          ))}
        </ul>

        <ul className={styles.promoPoints}>
          {GACHA_PROMO.points.map((p) => (
            <li key={p.text} className={styles.promoPoint}>
              <span className={styles.promoIcon} aria-hidden="true">
                {p.icon}
              </span>
              {p.text}
            </li>
          ))}
        </ul>

        {/* 확률은 **서버 값일 때만** 말한다 — 모르면 이 표가 통째로 없다(#232 규율). */}
        {rates && (
          <div className={styles.rates} data-testid="gacha-rates">
            <span className={styles.ratesTitle}>등급별 확률</span>
            <ul className={styles.ratesList}>
              {rates.map((r) => (
                <li key={r.grade} className={styles.rateRow} data-testid={`gacha-rate-${r.grade}`}>
                  <span style={{ color: GRADE_COLORS[r.grade] }}>{r.label}</span>
                  <b>{r.text}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

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
          {/*
            ⚠️ 예전엔 여기 `"선수 11명 · 골드 이상 1명 보장"` 이 **손으로** 적혀 있었다(#457 C1 정리).
            개수(`tenCount`)도 보장 등급(`tenPityMinGrade`)도 서버 economy 값이라, 운영이
            무배포 override 로 바꾸면 화면만 옛말을 하게 된다 — #213 이 가격에서 만든 사고와 같은 형태다.
            ⚠️ **보장 등급은 아직 서버가 안 준다**(#458) → 그동안은 개수만 말한다. 지어내지 않는다.
          */}
          {tenNote && <p className={styles.pullDesc}>{tenNote}</p>}
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
    </>
  );

  if (embedded) return body;
  return (
    <Layout header={header} nav>
      {body}
    </Layout>
  );
}
