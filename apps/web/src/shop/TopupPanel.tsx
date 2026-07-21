import { useState } from "react";
import { Modal } from "../common/Modal";
import {
  TOPUP_PACKAGES,
  bestValuePackageId,
  bonusPercent,
  formatKrw,
  formatPoints,
  totalPoints,
  type TopupPackage,
} from "./topup-logic";
import styles from "./TopupPanel.module.css";

/**
 * 충전 탭 (P3-D5 목업 / AC-D1).
 *
 * ⚠️ **어떤 상태 변화도 일으키지 않는다** — API 호출 0, 지갑/포인트 변화 0, 쿼리 invalidate 0.
 * 카드 클릭은 로컬 useState 로 안내 모달만 연다. 여기에 mutation·fetch·queryClient 를
 * 들이는 순간 AC-D1 이 깨진다(E2E `p3-topup-mock.spec.ts` 가 요청 카운트로 감시).
 *
 * ── 실 결제 연동 지점 ───────────────────────────────────────────────────────
 * `openPackage()` 가 현재는 setSelected 만 한다. 실연동 시:
 *   웹  → PG 결제창 호출(pkg.priceKrw / pkg.productId) → 콜백 영수증을 서버 검증 API 로 전달
 *   앱  → Capacitor 인앱결제 SDK purchase(pkg.productId) → 영수증을 서버 검증 API 로 전달
 * 지갑 증액은 **서버가 영수증 검증 후** 수행하고, 클라이언트는 성공 후 me/wallet 쿼리를
 * invalidate 하기만 한다. 클라이언트가 포인트를 직접 더하지 않는다.
 * 상품 카탈로그도 그때는 서버/스토어가 SoT (topup-logic.ts 주석 참조).
 * ───────────────────────────────────────────────────────────────────────────
 */
export function TopupPanel() {
  const [selected, setSelected] = useState<TopupPackage | null>(null);
  const bestId = bestValuePackageId();

  return (
    <div data-testid="topup-panel">
      <p className={styles.notice} data-testid="topup-notice">
        결제 준비 중입니다. 포인트 충전은 현재 <strong>admin 수동 지급</strong>으로만 가능합니다.
      </p>

      <div className={styles.grid}>
        {TOPUP_PACKAGES.map((pkg) => {
          const bonus = bonusPercent(pkg);
          return (
            <button
              key={pkg.id}
              type="button"
              className={styles.card}
              data-testid={`topup-package-${pkg.id}`}
              data-points={totalPoints(pkg)}
              onClick={() => setSelected(pkg)}
            >
              {pkg.id === bestId && (
                <span className={styles.bestBadge} data-testid="topup-best-badge">
                  최고 혜택
                </span>
              )}
              <span className={styles.cardLabel}>{pkg.label}</span>
              <span className={styles.cardPoints}>{formatPoints(totalPoints(pkg))}</span>
              <span className={styles.cardBonus}>
                {bonus > 0 ? `기본 ${formatPoints(pkg.basePoints)} + 보너스 ${bonus}%` : "보너스 없음"}
              </span>
              <span className={styles.cardPrice}>{formatKrw(pkg.priceKrw)}</span>
            </button>
          );
        })}
      </div>

      <p className={styles.disclaimer}>* 가격은 목업 표기이며 실제로 결제되지 않습니다.</p>

      {selected && (
        <Modal
          onClose={() => setSelected(null)}
          labelledBy="topup-modal-title"
          overlayClassName={styles.overlay}
          className={styles.sheet}
          testId="topup-modal"
          overlayTestId="topup-modal-overlay"
        >
          <h2 id="topup-modal-title" className={styles.modalTitle}>
            결제 준비 중
          </h2>
          <p className={styles.modalPackage} data-testid="topup-modal-package">
            {selected.label} · {formatPoints(totalPoints(selected))} · {formatKrw(selected.priceKrw)}
          </p>
          <p className={styles.modalBody}>
            결제 준비 중 — 충전은 admin에게 문의하세요.
          </p>
          <p className={styles.modalContact} data-testid="topup-modal-contact">
            운영 admin에게 <strong>충전 희망 금액과 본인 계정 ID</strong>를 전달하시면 포인트를 수동으로
            지급해 드립니다. 문의처는 테스터 안내 채널을 확인해 주세요.
          </p>
          <button
            type="button"
            className={styles.modalConfirm}
            data-testid="topup-modal-confirm"
            onClick={() => setSelected(null)}
          >
            확인
          </button>
        </Modal>
      )}
    </div>
  );
}
