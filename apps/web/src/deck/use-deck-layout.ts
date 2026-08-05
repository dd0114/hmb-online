import { useEffect, useState } from "react";

/**
 * 덱셋팅 화면이 **어느 레이아웃으로 설 것인가** — #455 A1.
 *
 * ## 왜 폭으로 가르나
 * A1 이 만든 책갈피 탭(`layout="tabs"`)은 **세로가 모자란 화면**의 처방이다: 경기장이 68 상한까지
 * 먹고, 그 아래 남는 세로를 탭 하나가 전부 가져간다. 그런데 `DeckEditor` 는 데스크탑에서
 * **보드 | 지시 레일 2컬럼**으로 서고(그쪽은 세로가 남는다) 탭은 거기서 **살 것을 오히려 감춘다**.
 *
 * ⚠️ 처음엔 폭 구분 없이 `layout="tabs"` 를 박았고, 그게 데스크탑 2컬럼을 죽였다 —
 * `deck-teamsheet.spec.ts` R1(1280px)이 **레일이 보드 오른쪽에 선다**를 재는데 실측
 * `railLeft 216 < boardRight 405` 로 레일이 보드 **아래**로 내려갔다. 스펙이 낡은 게 아니라
 * 구현이 확정 계약(#455 comment 5196070445 = **폰 덱셋팅 화면** 개편)의 범위를 넘은 것이었다.
 *
 * ## 임계 = 1023px (새로 고른 값이 아니다)
 * 이미 이 화면의 단일컬럼 밴드가 그 값이다 —
 * - `DeckEditor.module.css` 의 `container-type` 이 `@media (min-width: 1024px)` 안에 있어
 *   1023 이하는 컨테이너 쿼리가 안 켜지고 **항상 단일 컬럼**이다(apps/web/CLAUDE.md #354 절).
 * - `TacticsBoard.module.css` 의 폰 비율 스텝(68/52 → 68/44 → 68/40)도 `@media (max-width: 1023px)`
 *   블록이고, A1 의 `aspect-ratio: 68/68` 상한을 **그 블록 안에** 넣었다.
 * 즉 탭이 필요한 밴드 = 단일 컬럼 밴드 = 68 상한이 걸리는 밴드로 셋이 같은 경계다.
 * 여기서 다른 숫자를 쓰면 "탭은 켜졌는데 경기장은 68 이 아닌" 중간 상태가 생긴다.
 *
 * ⚠️ 감독시간(`HalftimePanel`)은 이 훅을 쓰지 않는다 — 그 화면은 1023 이하에서도 2컬럼을 켜고
 * 있고(#354), 애초에 `layout` 기본값 `"stack"` 이라 A1 이 건드리지 않는다.
 */
export const DECK_TABS_MAX_WIDTH = 1023;

const QUERY = `(max-width: ${DECK_TABS_MAX_WIDTH}px)`;

function matches(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

/** 지금 폭에서 덱셋팅이 설 레이아웃. 창 크기를 바꾸면 따라 바뀐다. */
export function useDeckLayout(): "stack" | "tabs" {
  const [narrow, setNarrow] = useState(matches);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setNarrow(mq.matches);
    // 초기값은 useState 가 잡지만, 마운트와 구독 사이에 폭이 바뀔 수 있다(회전·창 조절).
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return narrow ? "tabs" : "stack";
}
