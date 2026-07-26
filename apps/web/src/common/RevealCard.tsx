import { GRADE_LABELS, isHighGrade, type Grade } from "./grades";
import { FullArtCard } from "./FullArtCard";
import { fullArtWidth, type FullArtSize } from "./full-art";
import styles from "./RevealCard.module.css";

/**
 * 뒤집어 공개하는 카드 1장 — **뽑기 결과와 가입 최상위 지급이 공유하는 연출 단위** (#209).
 *
 * 원래는 `shop/GachaReveal` 안에만 있었다. 가입 지급 연출(#209 AC3)이 "좋은 걸 받는 느낌"을
 * 요구하는데, 그 느낌은 이미 뽑기에서 만들어 둔 것이다 — 비슷한 카드를 하나 더 그리는 대신
 * 같은 컴포넌트를 쓴다(모양이 갈라지지 않는다).
 *
 * 뒷면 상태에서는 풀아트를 **그리지 않는다** — 이미지 요청조차 나가지 않아 결과가 미리 새지 않는다.
 */
export interface RevealCardProps {
  playerId: string;
  name: string;
  grade: Grade;
  position?: string;
  /** 뒤집혀 앞면(=풀아트)이 보이는가. */
  revealed: boolean;
  /** NEW 뱃지(뽑기의 신규 획득 표시). */
  isNew?: boolean;
  /** 카드 폭 토큰 — `FULL_ART_SIZES`(full-art.ts) 한 곳이 실제 px 을 정한다. */
  size?: FullArtSize;
  onClick?: () => void;
  testId?: string;
}

export function RevealCard({
  playerId,
  name,
  grade,
  position,
  revealed,
  isNew = false,
  size = "grid",
  onClick,
  testId,
}: RevealCardProps) {
  const high = isHighGrade(grade);
  return (
    <button
      type="button"
      className={[styles.card, revealed ? styles.flipped : "", revealed && high ? styles.high : ""]
        .filter(Boolean)
        .join(" ")}
      /* 셀 폭 = 카드 폭. 토큰이 유일한 출처라 CSS 에 픽셀을 또 적지 않는다. */
      style={{ width: fullArtWidth(size) }}
      data-testid={testId}
      data-revealed={revealed ? "true" : "false"}
      aria-label={
        revealed
          ? `${name} · ${position ?? ""} · ${GRADE_LABELS[grade]}${isNew ? " · 신규" : ""}`
          : "카드 공개"
      }
      onClick={onClick}
    >
      <span className={styles.cardInner}>
        <span className={styles.cardBack}>?</span>
        <span className={styles.cardFace}>
          {isNew && <span className={styles.newBadge}>NEW</span>}
          {revealed && (
            <FullArtCard
              playerId={playerId}
              name={name}
              grade={grade}
              position={position}
              size={size}
              className={styles.cardFaceArt}
            />
          )}
        </span>
      </span>
    </button>
  );
}
