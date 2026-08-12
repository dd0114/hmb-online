import { Modal } from "../common/Modal";
import styles from "./PracticeTutorialDialog.module.css";

/**
 * 연습경기 튜토리얼 제안 (#493 W5) — **홈 [게임 시작]을 누른 순간에만** 뜬다.
 *
 * ## 왜 여기인가
 *
 * W1 은 신규 가입의 착지를 `/welcome`(60초 리플레이 관전)으로 바꿨는데 hero 판정으로 걷혔다:
 * *"처음 60초는 왜 보여주는거야? 게임시작 눌렀을때 '연습경기로 튜토리얼을 해보시겠습니까?' 하고
 * 미리 준비한 덱으로 돌려서 보여줘야 자연스럽다."* 유저가 **스스로 누른 뒤**에 제안하고, 보여주는
 * 것도 녹화가 아니라 **자기 팀의 진짜 경기**다.
 *
 * ## 규율
 *
 * ⚠️ **묻는 것은 딱 한 번이다.** 수락이든 거절이든 그 계정에 답이 기록되고 다시 뜨지 않는다
 * (`guide-storage.markPracticeTutorialAnswered`). 매번 물으면 이건 안내가 아니라 방해다.
 *
 * ⚠️ **[아니오]는 막다른 길이 아니다** — 원래 가려던 게임 탭으로 그대로 보낸다(DecklessDialog 와
 * 같은 규율: 안내가 동선을 끊지 않는다).
 */
export function PracticeTutorialDialog({
  onAccept,
  onDecline,
  pending,
}: {
  onAccept: () => void;
  onDecline: () => void;
  /** 매치 생성 중 — 버튼을 잠그고 라벨로 진행을 알린다(연타로 매치가 둘 생기지 않게). */
  pending?: boolean;
}) {
  return (
    <Modal
      // 백드롭·ESC 로 닫으면 "묻지 않은 것"이 되어 다음 클릭에 또 뜬다 — 답을 받는 다이얼로그라
      // 두 버튼 중 하나를 반드시 누르게 한다(Modal 의 dismissable=false 용도 그 자체).
      onClose={onDecline}
      dismissable={false}
      labelledBy="practice-tutorial-title"
      testId="practice-tutorial-dialog"
      overlayClassName={styles.overlay}
      className={styles.dialog}
      initialFocus='[data-testid="practice-tutorial-accept"]'
    >
      <div className={styles.body}>
        <h2 className={styles.title} id="practice-tutorial-title">
          첫 경기를 시작할까요?
        </h2>
        <p className={styles.text}>
          연습경기로 튜토리얼을 해보시겠습니까? 지급된 스쿼드로 봇과 한 판 치르며 경기가 어떻게
          흘러가는지 직접 봅니다. 기록에는 남지 않습니다.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            data-testid="practice-tutorial-decline"
            disabled={pending}
            onClick={onDecline}
          >
            아니오
          </button>
          <button
            type="button"
            className={styles.primary}
            data-testid="practice-tutorial-accept"
            disabled={pending}
            onClick={onAccept}
          >
            {pending ? "경기 준비 중…" : "예, 해볼게요"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
