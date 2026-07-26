import { useState } from "react";
import type { GachaResponse } from "../api/hooks";
import { Modal } from "../common/Modal";
import { RevealCard } from "../common/RevealCard";
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
 *
 * #187 (hero 확정 A안): 공개된 카드는 **전부 풀아트**다 — 수집의 하이라이트라 아이콘으로
 * 때우지 않는다. 이름·포지션·등급은 카드 프레임의 하단 밴드가 이미 자리를 갖고 있어
 * `FullArtCard` 가 그 위에 얹는다(카드 밖 텍스트 중복 제거).
 * 카드 폭은 `FULL_ART_SIZES.grid` 토큰 — 크기 조정은 `full-art.ts` 한 줄.
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
          {response.results.map((item, i) => (
            /* 카드 1장의 뒤집기·풀아트·NEW 뱃지는 공용 RevealCard 가 그린다(#209 로 추출 —
               가입 최상위 지급 연출과 같은 컴포넌트를 쓴다). 여기 남은 것은 그리드와 진행 제어뿐. */
            <RevealCard
              key={`${item.player.id}-${i}`}
              playerId={item.player.id}
              name={item.player.name}
              grade={item.player.grade}
              position={item.player.position}
              revealed={isCardRevealed(state, i)}
              isNew={item.isNew}
              size="grid"
              testId={`gacha-card-${i}`}
              onClick={handleAdvance}
            />
          ))}
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
