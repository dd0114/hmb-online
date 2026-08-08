/**
 * 유저 문의 연락처 — **교체 지점은 이 파일 한 곳이다** (#477).
 *
 * ┌─ 오픈채팅방 교체 절차 ────────────────────────────────────────────────────────────────┐
 * │ 1. 카카오톡에서 방을 만들고 ①링크(`https://open.kakao.com/o/XXXXXXXX`)와 ②QR 이미지를    │
 * │    받는다(카톡 방 설정 → 공유).                                                        │
 * │ 2. 아래 `KAKAO_OPEN_CHAT_CODE` 를 그 `XXXXXXXX` 로 바꾼다.                              │
 * │ 3. QR 이미지를 `apps/web/public/support/kakao-openchat-qr.jpg` 에 **덮어쓴다**           │
 * │    (파일명 그대로 — 경로는 아래 `kakaoOpenChatQrSrc` 하나만 안다).                       │
 * │ 4. web 재배포: `bash infra/deploy-pages.sh <백엔드URL>`                                │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ **2번과 3번은 한 쌍이다.** 코드만 바꾸고 QR 을 그대로 두면 링크는 새 방으로 가는데 QR 을
 * 찍은 사람은 죽은 방으로 간다(그 반대도 같다). 둘이 같은 방을 가리키는지는 사람이 봐야 하는
 * 마지막 한 칸이다 — **바꾼 뒤 폰 카메라로 그 이미지를 직접 찍어** 아래 코드의 방으로 들어가는지
 * 확인해라(자동 검증은 없다. QR 디코더를 이 리포의 의존성으로 들이지 않았다).
 *
 * (2026-08-09 출하 시점 실측: 이 이미지는 `https://open.kakao.com/o/gfI71WHi` 로 디코드된다.
 *  = 아래 상수와 일치. 방을 바꾸면 이 줄도 같이 갱신해라.)
 *
 * ⚠️ **다른 파일에 오픈채팅 URL 을 적지 마라.** 화면·안내문이 각자 URL 을 들면 교체 때 하나가
 * 남아 유저를 죽은 링크로 보낸다. 계약(`MaintenanceScreen.test.ts`)이 `src/**` 를 스캔해
 * `open.kakao.com` 사용처가 이 파일 하나뿐임을 강제한다.
 */

/** 오픈채팅방 코드(링크의 `/o/` 뒤). **여기 한 줄만 바꾸면 된다.** */
const KAKAO_OPEN_CHAT_CODE = "gfI71WHi";

export const SUPPORT_CONTACT = {
  /** 방 코드 — 링크를 못 여는 환경(PC·카톡 미설치)에서 글자로 보여 준다. */
  kakaoOpenChatCode: KAKAO_OPEN_CHAT_CODE,
  /** 실제 링크. 코드만 갈아 끼우므로 호출부가 문자열을 조립할 일이 없다. */
  kakaoOpenChatUrl: `https://open.kakao.com/o/${KAKAO_OPEN_CHAT_CODE}`,
  /**
   * QR 이미지 — **웹 오리진 정적 에셋이다**(`apps/web/public/`).
   *
   * ⚠️ 백엔드를 거치는 경로(`/api/...`)에 두면 안 된다. 이 화면이 뜨는 상황이 곧 **백엔드가
   * 죽은 상황**이라, 그때 QR 만 깨져서 유일한 연락 수단이 사라진다. web 은 CF Pages 정적이라
   * 백엔드와 무관하게 살아 있다.
   */
  kakaoOpenChatQrSrc: "/support/kakao-openchat-qr.jpg",
} as const;
