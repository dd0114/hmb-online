import { useEffect, useRef, useState } from "react";

/**
 * 코치마크가 화면을 놓은 뒤 공지를 열기까지의 **정착 시간**(ms).
 *
 * 0 이면 안 되는 이유: 온보딩 완료 저장(`persistTutorialDone`)이 `["me"]`·`["deck"]` 캐시를
 * 무효화하고, 서버는 그 호출에서 **덱을 지급한다**(#209). 그 응답이 도착하는 프레임에 홈은
 * 타일 상태가 통째로 바뀐다 — 그 위에 공지를 얹으면 유저는 방금 받은 것을 못 본다.
 * 그래서 "미룸"은 남기되 **방문 전체가 아니라 이 창만큼**으로 줄인다.
 *
 * ⚠️ **이건 고정 타이머지 "무효화가 끝났다"는 신호가 아니다**(독립검증 MIN-1). 느린 네트워크에서
 * 완료 왕복이 600ms 를 넘으면 원래 피하려던 그 프레임이 그대로 돌아온다. 계약이 박제하는 것도
 * **창이 존재한다**까지고(충분한가는 계약화할 수 없다), 그 잔여는 알고 남긴 것이다. 정확히 닫으려면
 * 완료 왕복의 완료 신호를 이 훅까지 들고 와야 하는데, 그러면 공지 노출이 **서버 응답을 기다리게**
 * 된다 — 응답이 안 오면 영영 안 뜬다(지금 고친 결함과 같은 모양). 지금은 창 쪽을 택한다.
 */
export const TUTORIAL_SETTLE_MS = 600;

/**
 * "저절로 뜨는 팝업을 지금 미뤄야 하는가" (#386, hero 확정 2026-08-01).
 *
 * ⚠️ **이전 구조(`tutorialHeldThisVisit` 래치)를 되살리지 마라.** 그건 *이번 홈 마운트 동안 한 번
 * 이라도 튜토리얼이 돌았으면 계속 참*이라, 공지를 "다음 홈 진입"으로 미뤘다. 그 자체는 의도였지만
 * (#248b) **온보딩이 완료 저장되지 않는 경로**와 겹치면서 그 "다음 진입"이 영영 오지 않았다:
 * 접속할 때마다 코치마크가 처음부터 다시 도니 매 세션 첫 홈이 곧 튜토리얼 방문이었고, 홈에서
 * 바로 경기하러 가는 신규 유저는 공지를 **한 번도 못 봤다**(#386 W1 실측).
 *
 * 지금 규칙은 하나다: **코치마크가 도는 동안 + 그 직후 정착 시간 동안만 미룬다.** 그 창이 지나면
 * 같은 화면에서 그대로 열린다. 튜토리얼이 아예 안 돈 방문(=완료 유저)에서는 지연이 없다.
 */
export function useUnbiddenPopupHold(active: boolean, settleMs: number = TUTORIAL_SETTLE_MS): boolean {
  const [settling, setSettling] = useState(false);
  /** 이 마운트에서 코치마크가 실제로 떠 있었나 — 안 떴으면 정착 지연 자체가 없다. */
  const ranThisMount = useRef(false);

  useEffect(() => {
    if (active) {
      ranThisMount.current = true;
      setSettling(false);
      return;
    }
    if (!ranThisMount.current) return;
    ranThisMount.current = false;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), settleMs);
    return () => clearTimeout(timer);
  }, [active, settleMs]);

  return active || settling;
}
