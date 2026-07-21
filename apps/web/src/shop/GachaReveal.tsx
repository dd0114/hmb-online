import { useState } from "react";
import type { GachaResponse } from "../api/hooks";
import { Modal } from "../common/Modal";
import { GRADE_COLORS, GRADE_LABELS, isHighGrade } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import {
  initialReveal,
  isAllRevealed,
  isCardRevealed,
  revealAll,
  revealNext,
} from "./reveal-logic";
import styles from "./GachaReveal.module.css";

interface GachaRevealProps {
  response: GachaResponse;
  onClose: () => void;
}

/**
 * 뽑기 결과 연출 (AC-W3): 카드 뒤집기 순차 공개(CSS transition), 골드↑ 하이라이트, isNew 뱃지.
 * 순차 진행 상태는 reveal-logic.ts(순수, 테스트됨)가 소유.
 */
export function GachaReveal({ response, onClose }: GachaRevealProps) {
  const [state, setState] = useState(() => initialReveal(response.results.length));
  const done = isAllRevealed(state);

  function handleAdvance() {
    setState((s) => revealNext(s));
  }

  return (
    // 공개 도중에는 Escape/백드롭으로 닫히지 않게 dismissable=done (실수로 결과를 놓치지 않도록).
    <Modal
      onClose={onClose}
      labelledBy="gacha-reveal-title"
      dismissable={done}
      overlayClassName={styles.overlay}
      className={styles.sheet}
      testId="gacha-reveal"
    >
      <h2 id="gacha-reveal-title" className={styles.title}>
        뽑기 결과 ({response.results.length}명)
      </h2>

        <div className={styles.grid}>
          {response.results.map((item, i) => {
            const revealed = isCardRevealed(state, i);
            const grade = item.player.grade;
            const high = isHighGrade(grade);
            return (
              <button
                key={`${item.player.id}-${i}`}
                type="button"
                className={[
                  styles.card,
                  revealed ? styles.flipped : "",
                  revealed && high ? styles.high : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-testid={`gacha-card-${i}`}
                data-revealed={revealed ? "true" : "false"}
                aria-label={
                  revealed
                    ? `${item.player.name} · ${item.player.position} · ${GRADE_LABELS[grade]}${item.isNew ? " · 신규" : ""}`
                    : "카드 공개"
                }
                onClick={handleAdvance}
              >
                <span className={styles.cardInner}>
                  <span className={styles.cardBack}>?</span>
                  <span className={styles.cardFace} style={{ borderColor: GRADE_COLORS[grade] }}>
                    {item.isNew && <span className={styles.newBadge}>NEW</span>}
                    {/* 공개된 카드만 얼굴을 그린다 — 뒷면 상태에서 미리 새지 않게. */}
                    {revealed && (
                      <CharAvatar
                        playerId={item.player.id}
                        name={item.player.name}
                        grade={grade}
                        size={64}
                        className={styles.cardFaceArt}
                      />
                    )}
                    <span className={styles.cardName}>{item.player.name}</span>
                    <span className={styles.cardPos}>{item.player.position}</span>
                    <span className={styles.cardGrade} style={{ color: GRADE_COLORS[grade] }}>
                      {GRADE_LABELS[grade]}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.actions}>
          {!done ? (
            <>
              <button type="button" className={styles.primary} data-testid="gacha-reveal-next" onClick={handleAdvance}>
                다음 공개 ({state.revealed}/{state.total})
              </button>
              <button
                type="button"
                className={styles.secondary}
                data-testid="gacha-reveal-all"
                onClick={() => setState((s) => revealAll(s))}
              >
                모두 공개
              </button>
            </>
          ) : (
            <button type="button" className={styles.primary} data-testid="gacha-close" onClick={onClose}>
              확인
            </button>
          )}
        </div>
    </Modal>
  );
}
