/**
 * 모바일 하단 독 기하 (#106 R3a r2·m5·m6·m7) — **순수 계산**만 담는다(DOM 접근은 DeckEditor).
 *
 * 폰(390)에서 독을 펼치면 ~52vh 를 덮어 (r2) "지금 누구에게 쓰는지" 맥락이 끊기고,
 * (m5) A안의 핵심 전달물인 `AI에 전달될 지시문` 이 독 fold 아래로 밀린다. 해결은 셋의 조합인데
 * 여기 있는 건 그중 **스크롤 계산 두 개**다(나머지 하나 = 미리보기 sticky 고정은 CSS).
 *
 *   ① `scrollDeltaForToken` — 독을 펼치는 순간 선택된 토큰을 시트 바와 독 사이의 **가시 띠**로
 *      끌어올린다. 보드가 덮여도 "내가 지시를 쓰는 대상"이 화면에 남는다.
 *   ② `runwayPx` — 독이 덮은 만큼만 문서를 늘린다. 예전엔 `padding-bottom:60vh` 고정치라
 *      최대 스크롤에서 리스트↔독 사이에 죽은 띠(실측 175px)가 남고 접을 때 507px 튀었다(m6/m7).
 *      실측 기반이면 필요한 만큼만 늘어난다.
 */

export interface TokenStripInput {
  /** 선택된 토큰의 뷰포트 좌표. */
  tokenTop: number;
  tokenBottom: number;
  /** 펼친 독의 상단(가시 띠의 아래 경계). */
  dockTop: number;
  /** sticky 시트 바의 하단(가시 띠의 위 경계). */
  headerBottom: number;
  /** 가시 띠 안에서 토큰 주위에 남길 여백. */
  pad?: number;
}

/**
 * 토큰을 가시 띠 안에 넣기 위해 필요한 `window.scrollBy(0, delta)` 량. 0 이면 이미 보인다.
 * 띠가 토큰보다 좁으면(작은 화면) 위쪽 정렬을 우선한다 — 토큰이 시트 바에 잘리는 게 더 나쁘다.
 */
export function scrollDeltaForToken(i: TokenStripInput): number {
  const pad = i.pad ?? 8;
  const top = i.headerBottom + pad;
  const bottom = i.dockTop - pad;
  if (bottom <= top) return 0; // 띠가 없다 — 스크롤해봐야 의미 없음
  if (i.tokenBottom > bottom) {
    const delta = i.tokenBottom - bottom;
    // 아래로 내리다 토큰 상단이 띠 위로 잘리면 위 정렬로 되돌린다.
    return i.tokenTop - delta < top ? i.tokenTop - top : delta;
  }
  if (i.tokenTop < top) return i.tokenTop - top; // 음수 = 위로
  return 0;
}

export interface RunwayInput {
  /** 뷰포트 높이. */
  innerHeight: number;
  /** 펼친 독의 상단 y (fixed 라 스크롤과 무관). */
  dockTop: number;
  /** 런웨이가 0 일 때 **시트 아래**에 남아 있는 문서 높이(뒤따르는 블록들 + 그 여백). */
  trailingHeight: number;
  /** 가림 방지 여유. */
  margin?: number;
}

/**
 * 펼친 독이 덮는 높이에서 이미 있는 뒷여백을 뺀 만큼만 문서를 늘린다.
 * 결과가 0 이면 늘릴 필요가 없다(뒤 블록들만으로 이미 독 위로 올릴 수 있다).
 */
export function runwayPx(i: RunwayInput): number {
  const covered = Math.max(0, i.innerHeight - i.dockTop);
  return Math.max(0, Math.round(covered - i.trailingHeight + (i.margin ?? 8)));
}
