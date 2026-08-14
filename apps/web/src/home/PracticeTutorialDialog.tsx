import { Modal } from "../common/Modal";
import styles from "./PracticeTutorialDialog.module.css";

/**
 * 연습경기 튜토리얼 제안 (#493 W5) — **게임 화면에 도착한 순간에** 뜬다.
 *
 * ⚠️ **파일은 `home/` 에 있지만 소비처는 `game/GamePage` 다**(#504 D1-A, hero 결정 2026-08-15).
 * W5 는 홈 타일 클릭을 판정 지점으로 삼았는데, 게임 화면으로 가는 나머지 길(하단탭 [게임]·덱
 * 화면의 `navigate("/game")`·URL 직접·뒤로가기)이 그 판정을 **평가조차 하지 않아** 신규 유저가
 * 온레일을 모른 채 통과했다. 판정은 이제 도착 지점 하나이고(`onrail/practice-offer`), 아래
 * *"왜 여기인가"* 의 hero 인용은 **모달의 존재 이유**로는 그대로 유효하다(누른 뒤에 제안한다).
 * 옮기지 않은 이유는 testid·계약이 이 경로에 묶여 있어서고, 옮길 거라면 그것만 따로 하는 편이 싸다.
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
 * ⚠️ **[건너뛰기]는 막다른 길이 아니다** — 원래 가려던 게임 탭으로 그대로 보낸다(DecklessDialog 와
 * 같은 규율: 안내가 동선을 끊지 않는다). 행동 보상 5종(덱 저장·결과 열람·강화·트레이드·뽑기)은
 * 서버가 그 행동 시점에 태우므로 **건너뛴 유저도 그대로 받는다** — 못 받는 것은 완주 보상뿐이다.
 *
 * ## W7-v3: 이 모달은 이제 **온레일의 문**이다
 *
 * W5 에서는 [예]가 곧 매치 생성이었다. 리플랜 v3 이 순서를 뒤집어(*"게임 시작하면 셋팅부터
 * 알려줘야하는데"*) [시작하기]는 **덱 화면으로 데려가는 것**이 됐고, 경기는 덱을 저장한 뒤
 * 온레일이 만든다. 서버도 같은 순서를 요구한다(덱 없이 튜토리얼 매치를 만들면 400 `DECK_REQUIRED`).
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
          같이 한 판 해볼까요?
        </h2>
        <p className={styles.text}>
          스쿼드를 짜고 연습경기를 치르는 것까지 순서대로 안내해 드립니다. 따라 하다 보면 젬도
          쌓여요. 언제든 그만둘 수 있습니다.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            data-testid="practice-tutorial-decline"
            disabled={pending}
            onClick={onDecline}
          >
            건너뛰기
          </button>
          <button
            type="button"
            className={styles.primary}
            data-testid="practice-tutorial-accept"
            disabled={pending}
            onClick={onAccept}
          >
            {pending ? "준비 중…" : "시작하기"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
