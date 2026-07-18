/**
 * 뽑기 버튼 상태 (순수). 잔액을 아직 모를 때(me 미로딩/에러)는 "부족" 문구를 띄우지 않고
 * 버튼만 비활성화한다 — 새로고침 직후 points=0 으로 잘못 계산돼 "포인트 부족"이 번쩍이던
 * UX 버그(#73 P0)를 막는다. 최종 잔액 검증은 서버(INSUFFICIENT_POINTS)가 게이트.
 */
export interface GachaButtonState {
  disabled: boolean;
  showShort: boolean;
}

export function gachaButtonState(opts: {
  loaded: boolean;
  points: number;
  cost: number;
  pending: boolean;
}): GachaButtonState {
  const short = opts.loaded && opts.points < opts.cost;
  return {
    disabled: opts.pending || !opts.loaded || short,
    showShort: short,
  };
}
