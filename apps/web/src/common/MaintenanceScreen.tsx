import styles from "./MaintenanceScreen.module.css";
import { SUPPORT_CONTACT } from "./support-contact";

/**
 * 점검 안내 화면 (#477) — 백엔드에 못 닿을 때 앱 대신 뜨는 유일한 화면.
 *
 * <b>이 화면이 답해야 하는 것은 셋뿐이다.</b> ①내 폰이 고장난 게 아니다 ②언제 되나 ③어디에 물어보나.
 * 그래서 안내문·재시도·연락처 외에는 아무것도 넣지 않는다(로그인·메뉴 전부 못 쓰는 상태다).
 *
 * 연락처는 {@link SUPPORT_CONTACT} 를 **그대로** 렌더한다 — 여기서 URL 을 조립하면 교체 지점이
 * 둘이 된다(support-contact.ts 주석 참조).
 */
export function MaintenanceScreen({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className={styles.wrap} data-testid="maintenance-screen" role="alert">
      <div className={styles.card}>
        <div className={styles.icon} aria-hidden="true">
          🛠
        </div>
        <h1 className={styles.title}>점검 중입니다</h1>
        {/* ⚠️ 마지막 문장은 장식이 아니다 — 우리는 "백엔드가 죽었다"와 "유저 wifi 가 끊겼다"를
            구분하지 못한다(구분 수단인 navigator.onLine 은 신뢰도가 낮다). 구분 못 하는 것을
            단정적으로 안내하면 오프라인 유저에게 거짓말이 된다. */}
        <p className={styles.text}>
          서버 점검·복구 작업이 진행 중이에요. 앱을 지우거나 다시 설치할 필요는 없습니다.
          잠시 후 다시 시도해 주시고, 계속 이 화면이 보이면 네트워크 연결도 확인해 주세요.
        </p>

        <button
          type="button"
          className={styles.retry}
          data-testid="maintenance-retry"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "확인 중…" : "다시 시도"}
        </button>
        <p className={styles.hint}>복구되면 자동으로 다시 연결됩니다.</p>

        <div className={styles.contact}>
          <p className={styles.contactLabel}>문의 · 공지</p>
          <a
            className={styles.contactLink}
            data-testid="maintenance-contact"
            href={SUPPORT_CONTACT.kakaoOpenChatUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            카카오톡 오픈채팅으로 문의하기
          </a>
          <p className={styles.contactCode} data-testid="maintenance-contact-code">
            오픈채팅 코드: {SUPPORT_CONTACT.kakaoOpenChatCode}
          </p>
        </div>
      </div>
    </div>
  );
}
