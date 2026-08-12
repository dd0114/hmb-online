/**
 * #493 W7-v3 — **온레일 튜토리얼**의 행동 신호선.
 *
 * hero(리플랜 v3): *"거의 정해진 화면에서 유저가 선택할 여유가 없이 강제해야돼."* 온레일은
 * 설명형([다음]만 누르는 코치마크)이 아니라 **유저가 그 행동을 실제로 해야** 다음으로 넘어간다.
 *
 * ── 왜 커스텀 이벤트인가 (DOM 셀렉터 폴링이 아니라) ─────────────────────────────────────
 * (설계는 구 W6 부분작업 `evidence/493/w6-old-partial/guide-actions.ts` 에서 가져왔다 — 그 판단은
 *  이 웨이브에서도 그대로 유효하다.)
 *
 * "AUTO 를 눌렀다"·"한마디를 썼다"·"승급했다"는 **DOM 에 안 남는다**. 보드는 채우기 전후가 같은
 * 모양의 토큰이고, 프롬프트 값은 draft(React state)에만 있으며, 승급은 성★ 숫자가 하나 오를 뿐
 * 그것도 서버 응답이 도착한 뒤다. 폴링으로 흉내내려면 온레일이 각 화면의 내부 상태 모양을 알아야
 * 하고(= 그 화면을 리팩터하면 조용히 죽는다), 무엇보다 **"방금 그 행동을 했다"** 와 **"원래 그
 * 상태였다"** 를 구분할 수 없다.
 *
 * 그래서 **행동이 일어난 그 자리**(버튼 클릭 · blur · 뮤테이션 성공)에서 한 줄로 알린다.
 * 온레일이 안 돌고 있으면 아무도 안 듣는다(리스너 0) — 화면 코드가 온레일을 몰라도 된다.
 *
 * ⚠️ **id 는 "무엇을 했나"이지 "어느 스텝인가"가 아니다.** 스텝 순서를 바꿔도 발화 지점은
 * 그대로여야 한다 — 발화 지점이 스텝을 알면 시나리오 데이터와 화면 코드가 양방향으로 묶인다.
 */
export const ONRAIL_ACTION_EVENT = "hmb:onrail-action";

/**
 * 지금 발화하는 행동들 (#493 W7-v3 = 스토리보드 S2·S4·S5·S6).
 *
 * 새 행동을 더할 때는 **여기에 먼저** 적어라 — 문자열을 화면에 직접 적으면 오타가 조용히
 * "영영 안 오는 신호"가 되고, 온레일은 그 스텝에서 갇힌다(탈출구는 [홈으로]뿐).
 */
export type OnRailActionId =
  // ── S2 덱셋팅 ────────────────────────────────────────────────────────────
  /** [⚡ 자동 채우기] 를 눌렀다. */
  | "deck-auto"
  /** 보드에서 선수 토큰을 눌러 지시 대상으로 세웠다(레일이 그 선수가 됐다). */
  | "deck-player"
  /** 선수 한마디를 쓰고 입력을 마쳤다(blur, 빈 문자열 제외). */
  | "deck-prompt"
  /** 덱 저장이 **성공**했다(PUT /api/deck 200). */
  | "deck-save"
  // ── S5 성장 ─────────────────────────────────────────────────────────────
  //
  // ⚠️ S4(결과)에는 행동 신호가 없다. 첫 결과 열람 보상은 **보상 봉투 ack** 이 서버에서 태우고
  // 그 시트는 자기 모달이라 온레일이 비켜난다(`onrail-script` RESULT_STEPS 주석). 여기에 신호를
  // 하나 더 만들면 "누가 그 보상의 주인인가"가 두 벌이 된다.
  /** 선수 카드를 눌러 성장 상세를 열었다. */
  | "growth-open"
  /** 성★ 승급이 **성공**했다(`POST /api/growth/star` 200). 강화(잠재)의 선행 조건이다. */
  | "growth-promote"
  /** 능력치 3지선다를 적용했다(`POST /api/growth/choices/{id}` 200). */
  | "growth-choice"
  /** 잠재 강화가 **성공**했다(`POST /api/growth/dice` 200 — 첫 회는 무료 쿠폰). */
  | "growth-enhance"
  // ── S6 트레이드 ─────────────────────────────────────────────────────────
  /** 트레이드를 시작했다(슬롯 start 성공). */
  | "trade-start"
  /** 단축(즉시 받기)을 눌러 성공했다. */
  | "trade-rush"
  /** 결과를 수령했다(accept 성공). */
  | "trade-accept";

/** 행동 하나를 알린다. 듣는 사람이 없으면 아무 일도 안 일어난다. */
export function emitOnRailAction(id: OnRailActionId): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(ONRAIL_ACTION_EVENT, { detail: { id } }));
  } catch {
    /* CustomEvent 미지원(구 환경) — 온레일이 안 넘어갈 뿐 화면 조작은 그대로다 */
  }
}

/** 이벤트에서 행동 id 를 꺼낸다. 모양이 아니면 null(남의 이벤트를 삼키지 않는다). */
export function onRailActionIdOf(e: Event): string | null {
  const detail = (e as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const id = (detail as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
