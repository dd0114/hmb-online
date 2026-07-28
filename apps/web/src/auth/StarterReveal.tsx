import { useState } from "react";
import { Modal } from "../common/Modal";
import { RevealCard } from "../common/RevealCard";
import { GRADE_LABELS, type Grade } from "../common/grades";
import { useCurrency } from "../common/Amount";
import { useAppConfigValue } from "../common/AppConfigContext";
import { CURRENCY_GEM, CURRENCY_POINT, formatAmount, withIga } from "../common/currency";
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
  /**
   * 지급액 오버라이드(테스트·스토리용). **평소엔 넘기지 않는다** — 서버 config 가 SoT 다(#232).
   * 예전엔 기본값 3,000 이 박혀 있었고 호출부가 넘기지도 않아 화면이 늘 상수를 그렸는데,
   * 운영이 무배포 override 로 지급액을 올린 뒤에도(#209) 그대로였다.
   */
  initialPoints?: number;
  onClose: () => void;
}

export function StarterReveal({ grant, basicCount = 14, initialPoints, onClose }: StarterRevealProps) {
  // 지급액·표기 모두 서버에서 (#232). 문장 안이라 컴포넌트가 아니라 문자열로 만든다.
  const grants = useAppConfigValue()?.grants ?? null;
  const pointCurrency = useCurrency(CURRENCY_POINT);
  const gemCurrency = useCurrency(CURRENCY_GEM);
  const points = initialPoints ?? grants?.initialPoints ?? 0;
  const gems = grants?.initialGems ?? 0;
  // config 를 못 받으면 금액 문구가 **빠진다**(선수 장수만 안내). 다른 자리의 폴백은 "코드를 그대로
  // 노출"인데 여기만 침묵인 이유: 거기서 모르는 것은 **표기**(금액은 안다)고, 여기서 모르는 것은
  // **금액 자체**다. 모르는 숫자를 지어내는 것은 폴백이 아니라 거짓말이라 문장에서 뺀다.
  // 지급 문구 — 받은 재화를 빠뜨리지 않는다(우승 유상재화가 화면에 없던 것과 같은 형태였다).
  const grantedAmounts = [
    points > 0 ? formatAmount(pointCurrency, points) : null,
    gems > 0 ? formatAmount(gemCurrency, gems) : null,
  ].filter(Boolean).join(" · ");
  // 조사도 표기를 따라간다 — 같은 커밋이 그러려고 헬퍼를 만들어 놓고 여기서 "이"를 박았었다
  // (심볼이 "Z" 면 "…Z가", "G" 면 "…G가", 받침 있는 이름이면 "…이"). 문장 끝만 맞추면 된다.
  const grantedSentence = grantedAmounts ? `과 ${withIga(grantedAmounts)} 지급되었습니다.` : "이 지급되었습니다.";
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
              선수 {basicCount + 1}명{grantedSentence}
            </p>
          )}
        </>
      )}

      {!player && (
        <p className={styles.grant}>
          선수 {basicCount}명{grantedSentence}
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
