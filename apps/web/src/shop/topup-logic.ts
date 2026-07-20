/**
 * 충전 패키지 목업 (P3-D5 / AC-D1).
 *
 * ⚠️ 실 결제 미연동 — 이 모듈은 **표시용 데이터**만 소유한다. 여기서 파생되는 어떤 값도
 * 지갑/포인트에 반영되지 않으며, 클릭은 안내 모달만 띄운다(API 호출 0 · invalidate 0).
 *
 * ── 실 결제 연동 지점 ───────────────────────────────────────────────────────
 * 실제 충전을 붙일 때 갈아끼울 곳은 두 군데다.
 *  1) 가격/상품 정의: 아래 TOPUP_PACKAGES 의 priceKrw·basePoints·bonusPoints 는 목업 상수다.
 *     실서비스에서는 **서버(economy) 또는 스토어 상품 카탈로그가 SoT** 가 되어야 한다
 *     (웹 PG = 상품 테이블, 앱 인앱결제 = App Store / Google Play product id 조회).
 *     → `productId` 필드를 스토어 상품 id 로 매핑해 사용한다.
 *  2) 결제 실행: ShopPage 의 패키지 클릭 핸들러가 현재는 모달만 연다.
 *     실연동 시 여기서 PG 결제창(웹) 또는 인앱결제 SDK(Capacitor) 를 호출하고,
 *     **영수증을 서버에 검증 요청**한 뒤 서버가 지갑을 증액한다.
 *     클라이언트가 포인트를 직접 더하는 구현은 금지(권위 = 서버).
 * ───────────────────────────────────────────────────────────────────────────
 */

export interface TopupPackage {
  /** UI/testid 용 안정 식별자. 실연동 시 스토어 상품 id 와 매핑되는 키. */
  id: string;
  /** 스토어 상품 id 자리(목업 — 실결제 연동 시 실제 product id 로 교체). */
  productId: string;
  label: string;
  /** 기본 지급 포인트. */
  basePoints: number;
  /** 보너스 포인트(0 가능). */
  bonusPoints: number;
  /** 목업 표기 가격(원). 실제 청구 없음. */
  priceKrw: number;
}

/** 목업 카탈로그 — 총 지급액 1,000 / 5,500 / 12,000 / 30,000 P. */
export const TOPUP_PACKAGES: readonly TopupPackage[] = [
  { id: "starter", productId: "mock.topup.starter", label: "스타터", basePoints: 1_000, bonusPoints: 0, priceKrw: 1_200 },
  { id: "basic", productId: "mock.topup.basic", label: "베이직", basePoints: 5_000, bonusPoints: 500, priceKrw: 6_000 },
  { id: "plus", productId: "mock.topup.plus", label: "플러스", basePoints: 10_000, bonusPoints: 2_000, priceKrw: 12_000 },
  { id: "mega", productId: "mock.topup.mega", label: "메가", basePoints: 25_000, bonusPoints: 5_000, priceKrw: 30_000 },
];

/** 실제 지급되는 총 포인트(기본 + 보너스). */
export function totalPoints(pkg: TopupPackage): number {
  return pkg.basePoints + pkg.bonusPoints;
}

/** 보너스 비율(%) — 기본 포인트 대비, 정수 반올림. base 0 이면 0. */
export function bonusPercent(pkg: TopupPackage): number {
  if (pkg.basePoints <= 0) return 0;
  return Math.round((pkg.bonusPoints / pkg.basePoints) * 100);
}

/** 1원당 포인트 — 패키지 간 가치 비교용. price 0 이면 0. */
export function pointsPerKrw(pkg: TopupPackage): number {
  if (pkg.priceKrw <= 0) return 0;
  return totalPoints(pkg) / pkg.priceKrw;
}

/**
 * 가장 이득인 패키지 id("최고 혜택" 배지). 동률이면 앞선 항목,
 * 보너스가 하나도 없으면 배지를 달지 않는다(null).
 */
export function bestValuePackageId(packages: readonly TopupPackage[] = TOPUP_PACKAGES): string | null {
  let best: TopupPackage | null = null;
  for (const pkg of packages) {
    if (pkg.bonusPoints <= 0) continue;
    if (!best || pointsPerKrw(pkg) > pointsPerKrw(best)) best = pkg;
  }
  return best?.id ?? null;
}

/** 목업 가격 표기(원). */
export function formatKrw(krw: number): string {
  return `₩${krw.toLocaleString("ko-KR")}`;
}

/** 포인트 표기. */
export function formatPoints(points: number): string {
  return `${points.toLocaleString("ko-KR")} P`;
}

export function findPackage(id: string, packages: readonly TopupPackage[] = TOPUP_PACKAGES): TopupPackage | null {
  return packages.find((p) => p.id === id) ?? null;
}

export type ShopTab = "gacha" | "topup";
