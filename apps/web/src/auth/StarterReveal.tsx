import { useState } from "react";
import { Modal } from "../common/Modal";
import { RevealCard } from "../common/RevealCard";
import { GRADE_LABELS, type Grade } from "../common/grades";
import type { StarterGrantResponse } from "../api/p3";
import styles from "./StarterReveal.module.css";

/**
 * 가입 지급 연출 (#209 AC3) — "좋은 걸 받았다"가 첫 화면에서 전달돼야 한다.
 *
 * 예전에는 "선수 14명과 3,000P가 지급되었습니다" 텍스트 한 줄이었다. 개편으로 가입 지급의
 * 하이라이트가 **최상위 유닛 1장**이 됐으므로, 그 한 장을 뽑기와 같은 방식으로 뒤집어 보여준다
 * (`RevealCard` = GachaReveal 에서 추출한 공용 카드, 풀아트 #187 자산 그대로).
 *
 * 최상위 지급이 없으면(개편 이전 계정·구 economy 파일) 카드 없이 기존 문구만 보여준다 —
 * 연출이 없다고 가입 동선이 막히지는 않는다.
 */
export interface StarterRevealProps {
  /** GET /api/me/starter-grant. 아직 로딩 중이거나 실패면 undefined/null 로 준다. */
  grant?: StarterGrantResponse | null;
  /** 기본팩 장수 안내(문구용). */
  basicCount?: number;
  initialPoints?: number;
  onClose: () => void;
}

export function StarterReveal({ grant, basicCount = 14, initialPoints = 3000, onClose }: StarterRevealProps) {
  const player = grant?.granted ? grant.player : null;
  // 카드가 없으면 공개할 것도 없다 — 곧바로 확인 버튼만 있는 상태로 연다.
  const [revealed, setRevealed] = useState(false);
  const done = !player || revealed;

  return (
    <Modal
      onClose={onClose}
      labelledBy="starter-reveal-title"
      /* 공개 전에는 백드롭/ESC 로 닫히지 않게 — 실수로 지급 연출을 놓치지 않도록(GachaReveal 과 같은 규칙). */
      dismissable={done}
      overlayClassName={styles.overlay}
      className={styles.sheet}
      testId="starter-reveal"
    >
      <h2 id="starter-reveal-title" className={styles.title}>
        스타터 팩 지급
      </h2>
      <p className={styles.lead}>신규 감독님을 환영합니다!</p>

      {player && (
        <>
          <div className={styles.stage}>
            <RevealCard
              playerId={player.id}
              name={player.name}
              grade={player.grade as Grade}
              position={player.position}
              revealed={revealed}
              size="detail"
              testId="starter-reveal-card"
              onClick={() => setRevealed(true)}
            />
          </div>
          {!revealed ? (
            <p className={styles.hint}>카드를 눌러 최상위 선수를 확인하세요</p>
          ) : (
            <p className={styles.grant} data-testid="starter-reveal-grant">
              <span className={styles.grantName}>{player.name}</span> ·{" "}
              {GRADE_LABELS[player.grade as Grade]} 영입!
              <br />
              선수 {basicCount + 1}명과 {initialPoints.toLocaleString()}P가 지급되었습니다.
            </p>
          )}
        </>
      )}

      {!player && (
        <p className={styles.grant}>
          선수 {basicCount}명과 {initialPoints.toLocaleString()}P가 지급되었습니다.
        </p>
      )}

      <div className={styles.actions}>
        {!done ? (
          <button
            type="button"
            className={styles.primary}
            data-testid="starter-reveal-open"
            onClick={() => setRevealed(true)}
          >
            카드 공개
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            data-testid="starter-reveal-close"
            onClick={onClose}
          >
            확인
          </button>
        )}
      </div>
    </Modal>
  );
}
