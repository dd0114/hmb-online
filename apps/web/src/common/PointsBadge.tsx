import { Amount } from "./Amount";
import { CURRENCY_GEM, CURRENCY_POINT } from "./currency";
import styles from "./PointsBadge.module.css";

interface PointsBadgeProps {
  points: number;
  /**
   * V2.2 재화 이원화(에픽 #179 hero 확정) — 지갑 두 재화 병기. 넘기지 않으면 무료재화 단독 배지
   * (비용 표기 호출부는 넘기지 않는다).
   */
  gems?: number;
}

/**
 * 지갑 배지 — 심볼·아이콘은 서버 표기 메타에서 온다 (#232).
 *
 * ⚠️ 여기(그리고 이 파일 어디에도) `P`·`💎` 같은 문자열을 다시 적지 마라. 그게 서버 주도 표기를
 * 되돌리는 방법이고, 되돌아가면 화면이 실제 결제와 어긋난 채로 조용히 굴러간다(#213).
 * testid(`points-badge`/`wallet-gems`)는 기존 계약이라 유지한다 — 바뀐 건 표기지 구조가 아니다.
 */
export function PointsBadge({ points, gems }: PointsBadgeProps) {
  return (
    <span className={styles.wrap}>
      <Amount
        className={styles.badge}
        data-testid="points-badge"
        data-points={points}
        code={CURRENCY_POINT}
        value={points}
        icon
      />
      {gems !== undefined && (
        <Amount
          className={styles.badge}
          data-testid="wallet-gems"
          data-gems={gems}
          code={CURRENCY_GEM}
          value={gems}
          icon
        />
      )}
    </span>
  );
}
