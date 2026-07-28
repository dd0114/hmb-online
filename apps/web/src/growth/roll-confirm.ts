/**
 * 잠재 재설정 확인 다이얼로그의 "다시 묻지 않기" 저장소 (#247, hero 확정 2026-07-29).
 *
 * <p><b>왜 로컬인가.</b> 이건 계정 데이터가 아니라 **이 기기에서의 조작 편의**다. 서버에 두면
 * 확인 문구 하나에 API·마이그레이션·동기화가 붙는데, 잘못돼도 결과는 "한 번 더 물어본다"뿐이다.
 * 반대로 재화 차감·잔액 판정 같은 **결과가 있는 판단은 전부 서버 권위**로 남아 있다.
 *
 * <p><b>왜 순수 모듈인가.</b> localStorage 는 사파리 프라이빗 모드·쿠키 차단에서 접근 자체가
 * throw 한다. 컴포넌트 안에서 직접 부르면 그 예외가 강화 상세를 통째로 하얗게 만든다 —
 * 여기서 삼키고 "확인을 띄운다"(안전한 쪽)로 떨어뜨린다.
 */

const KEY = "hmb.growth.rollConfirmSkipped";

/** 저장된 "다시 묻지 않기" 여부. 읽을 수 없으면 false = **확인을 띄운다**(안전한 기본값). */
export function rollConfirmSkipped(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** "다시 묻지 않기" 저장. 실패해도 조용히 넘어간다 — 다음에 한 번 더 묻는 것뿐이다. */
export function persistSkipRollConfirm(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    /* 저장 불가 환경 — 확인이 계속 뜨는 것은 사고가 아니다. */
  }
}

/** 테스트·설정 리셋용. */
export function clearSkipRollConfirm(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
