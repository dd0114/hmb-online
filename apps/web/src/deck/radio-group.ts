/**
 * WAI-ARIA APG `radiogroup` 키보드 상호작용 — **순수 계산**만 담는다(DOM/포커스는 호출자).
 *
 * ── 왜 필요한가 (#106 R3b, 독립 검증 지적) ────────────────────────────────────────────────
 * R3b 에서 역할 세그먼트·팀 지시 5스텝을 `role="radiogroup"`/`radio` 로 바꿨다(배타 선택이므로
 * toggle 버튼보다 정확한 시맨틱이고, SR 이 "radio, 3 of 5" 로 읽어준다). 그런데 **role 만 바꾸고
 * 상호작용은 안 넣어** 방향키가 무반응이고 탭스톱이 5개로 남았다 — SR 이 라디오라고 안내한 뒤
 * 라디오처럼 동작하지 않는 **의미-동작 불일치**를 새로 들인 셈이다(Enter/Space 는 되므로 WCAG
 * 2.1.1 자체는 충족이지만, 어중간한 상태가 제일 나쁘다는 판정).
 *
 * → role 을 되돌리는 대신 **APG 를 마저 구현**한다:
 *   · 방향키(←→↑↓)로 이동하고 **선택이 포커스를 따라간다**(APG radiogroup 기본 동작).
 *   · Home/End 로 양 끝.
 *   · **roving tabindex** — 그룹 전체가 탭스톱 하나(선택된 항목만 `tabIndex=0`).
 *   · 좌우 방향키는 순환(wrap)한다(APG 권장).
 */

/** 방향키 → 이동 결과 인덱스. 처리 대상이 아닌 키면 null(호출자가 기본 동작을 막지 않는다). */
export function radioKeyIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * roving tabindex 의 탭스톱 인덱스.
 *
 * APG: 선택된 라디오가 탭스톱이고, **아무것도 선택되지 않았으면 첫 번째**가 탭스톱이 된다.
 * 팀 지시의 "근사"(저장값이 단계 사이 — 어느 스텝도 checked 아님)가 정확히 그 경우다. 이때는
 * 첫 스텝이 아니라 **가장 가까운 스텝**을 탭스톱으로 둔다: 사용자가 탭으로 들어오면 지금 값과
 * 가장 가까운 자리에서 시작하는 편이 자연스럽고, 어차피 방향키로 즉시 옮길 수 있다.
 */
export function rovingTabIndex(index: number, selectedIndex: number): 0 | -1 {
  return index === selectedIndex ? 0 : -1;
}
