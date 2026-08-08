/**
 * 유저 문의 연락처 — **교체 지점은 이 파일 한 곳이다** (#477).
 *
 * ┌─ 오픈채팅 코드 교체 절차 ────────────────────────────────────────────────────────────┐
 * │ 1. 카카오톡에서 오픈채팅방을 만들고 링크를 복사한다(`https://open.kakao.com/o/XXXXXXXX`). │
 * │ 2. 아래 `KAKAO_OPEN_CHAT_CODE` 의 값을 그 `XXXXXXXX` 로 바꾼다. **다른 곳은 없다.**      │
 * │ 3. web 재배포: `bash infra/deploy-pages.sh <백엔드URL>`                                │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 지금 값은 **임시 placeholder** 다(방이 아직 없다). hero 가 개설한 뒤 위 절차로 교체한다.
 *
 * ⚠️ **다른 파일에 오픈채팅 URL 을 적지 마라.** 화면·안내문이 각자 URL 을 들면 교체 때 하나가
 * 남아 유저를 죽은 링크로 보낸다. 계약(`MaintenanceScreen.test.ts`)이 `src/**` 를 스캔해
 * `open.kakao.com` 사용처가 이 파일 하나뿐임을 강제한다.
 */

/** 오픈채팅방 코드(링크의 `/o/` 뒤). **여기 한 줄만 바꾸면 된다.** */
const KAKAO_OPEN_CHAT_CODE = "hmbonline-temp";

export const SUPPORT_CONTACT = {
  /** 방 코드 — 링크를 못 여는 환경(PC·카톡 미설치)에서 글자로 보여 준다. */
  kakaoOpenChatCode: KAKAO_OPEN_CHAT_CODE,
  /** 실제 링크. 코드만 갈아 끼우므로 호출부가 문자열을 조립할 일이 없다. */
  kakaoOpenChatUrl: `https://open.kakao.com/o/${KAKAO_OPEN_CHAT_CODE}`,
} as const;
