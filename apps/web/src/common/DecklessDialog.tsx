import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { decklessBranch, type DecklessBranch } from "./deckless";
import styles from "./DecklessDialog.module.css";

/**
 * 덱 없는 유저 안내 (#286 W3.5) — **세 진입점이 공유하는 한 화면**.
 *
 * 진입점은 셋이다: 홈 `[게임 시작]` 타일 · `/game` 모드 버튼 · 서버 거부 응답. 문구가 갈라지면
 * 셋 중 하나가 조용히 낡으므로 컴포넌트를 하나만 둔다.
 *
 * 분기는 `decklessBranch` 가 정한다 — 카드가 모자란 유저에게 "덱을 구성하시겠습니까?"를 띄우면
 * **할 수 없는 일을 시키는 안내**가 된다(hero Q8 = C).
 */
export function DecklessDialog({
  ownedCount,
  onClose,
}: {
  /** 서버가 준 보유 카드 수. 모르면 `null` — 그때는 덱 구성 분기로 떨어진다. */
  ownedCount: number | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const branch: DecklessBranch = decklessBranch(ownedCount);

  return (
    <Modal
      onClose={onClose}
      labelledBy="deckless-title"
      testId="deckless-dialog"
      overlayClassName={styles.overlay}
      className={styles.dialog}
    >
      <div className={styles.body}>
        {branch.kind === "build" ? (
          <>
            <h2 className={styles.title} id="deckless-title">
              현재 덱이 없습니다
            </h2>
            {/* hero 문안 그대로. 질문형이라 [예]/[아니오] 가 짝이다. */}
            <p className={styles.text}>덱을 구성하러 가시겠습니까?</p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                data-testid="deckless-cancel"
                onClick={onClose}
              >
                아니오
              </button>
              <button
                type="button"
                className={styles.primary}
                data-testid="deckless-go-deck"
                onClick={() => navigate("/deck?setup=1")}
              >
                예
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className={styles.title} id="deckless-title">
              선수가 부족합니다
            </h2>
            {/* 실수치를 보여준다 — 몇 명이 모자란지 모르면 다음 행동을 정할 수 없다. */}
            <p className={styles.text} data-testid="deckless-shortage">
              현재 {branch.owned}/{branch.required}명입니다. 영입에서 선수를 모아주세요.
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                data-testid="deckless-cancel"
                onClick={onClose}
              >
                닫기
              </button>
              <button
                type="button"
                className={styles.primary}
                data-testid="deckless-go-recruit"
                onClick={() => navigate("/recruit")}
              >
                영입 가기
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
