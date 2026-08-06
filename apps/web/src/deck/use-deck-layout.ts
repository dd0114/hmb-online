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
 * ## 임계 = 899px — **세로 예산**이 정한다 (가로 밴드가 아니다)
 *
 * ⚠️ 처음엔 1023 이었고 근거를 *"탭 밴드 = 단일컬럼 밴드 = 68 상한 밴드, 셋이 같은 경계"* 라고
 * 적었다. **그 근거는 반증됐다** — 셋 다 가로 축만 보고 있었고, 탭이 성립하려면 68 정사각형이
 * 먹고 **남는 세로**가 있어야 한다는 조건이 빠져 있었다. 실제로 폭 900~1023 에서 이렇게 깨졌다:
 *
 * - `index.css` 의 `.app-container` 가 **폭 900 부터 max-width 480 → 720** 으로 넓어진다.
 * - 그러면 보드 폭이 688 이 되고, `aspect-ratio: 68/68` 이라 **세로도 688** 을 먹는다.
 * - 짧은 창 양보(68/44·68/40)는 `max-height: 819` 아래에서만 걸리므로 900×900 같은 창엔 안 걸린다.
 * - `.app-container--fill` 이 `overflow: hidden` 이라 **문서 스크롤도 0** 이다.
 * ⇒ 탭 패널 높이 실측 **900×900 0px · 1023×900 0px · 1023×768 18px · 960×800 50px**
 *   = 프롬프트·탭이 스크롤로도 도달 불가(독립검증 BL-2).
 *
 * 그래서 임계를 **컨테이너 폭이 커지는 그 경계**(900)에 붙인다 — 899 이하는 컨테이너가 480 으로
 * 묶여 보드가 448 이고 남는 세로가 탭 몫으로 충분하다. 폭 900 이상은 stack(=A1 이전 동작)이라
 * 문서가 스크롤되어 프롬프트에 닿는다. **확정 계약은 폰 덱셋팅 개편이고 그 밴드는 폰이 아니다.**
 *
 * ⚠️ **정직하게: 이 값 하나가 BL-2 를 고친 것이 아니다.** 같은 웨이브가 `TacticsBoard.module.css`
 *    의 tabs 피치에 **세로 예산 상한**(`max-height: calc(100vh - 428px)`)을 넣었고, 임계를 1023 으로
 *    되돌리는 변이(M-B)를 먹여도 폭 계약 ⑧ 이 **통과한다**(상한이 900~1023 의 보드도 같이 눌러
 *    패널이 0 이 안 된다). 즉 결함을 막는 것은 그 상한이고, **899 는 스코프 결정**이다 —
 *    확정 계약(#455 comment 5196070445)이 **폰** 덱셋팅 개편이라 폰이 아닌 밴드를 A1 이전 동작
 *    (stack)으로 둔다. 계약은 이 숫자를 박지 않는다(임계 import = 임계 변이 통과, §"거짓말" ②) —
 *    양 끝만 박는다: 390 은 tabs · 1280 은 stack(데스크탑 2컬럼이 죽었던 그 회귀).
 * ⚠️ 이 값을 올릴 거면 `.app-container` 의 900 스텝과 그 세로 상한을 같이 봐라.
 *    계약 = `p455-a1-layout-band.spec.ts` ⑧⑨.
 *
 * ⚠️ 감독시간(`HalftimePanel`)은 이 훅을 쓰지 않는다 — 그 화면은 1023 이하에서도 2컬럼을 켜고
 * 있고(#354), 애초에 `layout` 기본값 `"stack"` 이라 A1 이 건드리지 않는다.
 */
export const DECK_TABS_MAX_WIDTH = 899;

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
