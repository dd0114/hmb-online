/**
 * #493 W6 — **행동 완료형 가이드**의 신호선.
 *
 * hero: *"덱셋팅도 하나씩 움직여보게해서 auto누르게하고 한마디 써보게하고 그다음 저장하면
 * 보상주고."* — 덱 화면만은 설명형([다음] 클릭)이 아니라 **유저가 그 행동을 실제로 해야**
 * 다음 스텝으로 넘어간다.
 *
 * ── 왜 커스텀 이벤트인가 (DOM 셀렉터 폴링이 아니라) ─────────────────────────────────────
 * "선수를 옮겼다"·"한마디를 썼다"는 **DOM 에 안 남는다**. 보드는 옮기기 전후가 같은 모양의
 * 토큰이고, 프롬프트는 값이 draft(React state)에만 있다. 폴링으로 흉내내려면 가이드가 덱의
 * 내부 상태 모양을 알아야 하고(= 덱을 리팩터하면 조용히 죽는다), 무엇보다 **"방금 그 행동을
 * 했다"** 와 **"원래 그 상태였다"** 를 구분할 수 없다.
 *
 * 그래서 **행동이 일어난 그 자리**(드롭/버튼 클릭/blur/저장 성공)에서 한 줄로 알린다.
 * 가이드가 안 돌고 있으면 아무도 안 듣는다(리스너 0) — 화면 코드가 가이드를 몰라도 된다.
 *
 * ⚠️ **id 는 "무엇을 했나"이지 "어느 스텝인가"가 아니다.** 스텝 순서를 바꿔도 발화 지점은
 * 그대로여야 한다 — 발화 지점이 스텝을 알면 가이드 데이터와 화면 코드가 양방향으로 묶인다.
 */
export const GUIDE_ACTION_EVENT = "hmb:guide-action";

/**
 * 지금 발화하는 행동들 (#493 W6 = 덱 4종).
 *
 * 새 행동을 더할 때는 **여기에 먼저** 적어라 — 문자열을 화면에 직접 적으면 오타가 조용히
 * "영영 안 오는 신호"가 되고, 그 스텝은 [건너뛰기] 말고는 빠져나갈 길이 없다.
 */
export type GuideActionId =
  /** 선수를 슬롯으로 옮겼다(드래그 드롭 · 엔트리 자리 지정 · 목록 선택 — 전부 같은 이동이다). */
  | "deck-move"
  /** [⚡ 자동 채우기] 를 눌렀다. */
  | "deck-auto"
  /** 선수 한마디를 쓰고 입력을 마쳤다(blur, 빈 문자열 제외). */
  | "deck-prompt"
  /** 덱 저장이 **성공**했다(PUT /api/deck 200). */
  | "deck-save";

/** 행동 하나를 알린다. 듣는 사람이 없으면 아무 일도 안 일어난다. */
export function emitGuideAction(id: GuideActionId): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(GUIDE_ACTION_EVENT, { detail: { id } }));
  } catch {
    /* CustomEvent 미지원(구 환경) — 가이드가 안 넘어갈 뿐 덱 조작은 그대로다 */
  }
}

/** 이벤트에서 행동 id 를 꺼낸다. 모양이 아니면 null(남의 이벤트를 삼키지 않는다). */
export function guideActionIdOf(e: Event): string | null {
  const detail = (e as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const id = (detail as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
