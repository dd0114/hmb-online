/**
 * #493 W2 — 화면별 가이드 컨텍스트 (최소 표면).
 *
 * ⚠️ **react 만 import 한다**(쿼리 훅 금지) — tutorial-context.ts 와 같은 이유: 여러 페이지
 * 유닛 테스트가 QueryClientProvider 없이 렌더된다. 실제 상태는 `GuideProvider` 가 주입하고,
 * 프로바이더가 없으면 no-op(가이드 없음)이다.
 */
import { createContext, useContext } from "react";

export interface GuideControls {
  /** 화면 가이드 코치마크가 떠 있는가 — 팝업 홀드(#386)가 이 신호도 본다. */
  active: boolean;
  /**
   * '화면 안내 다시 보기'(/me) — 이 계정의 seen 을 비우고 pending 을 다시 세운다.
   * 각 화면에 다시 들어갈 때 그 화면 가이드가 한 번씩 다시 뜬다.
   */
  replay: () => void;
}

const NOOP: GuideControls = { active: false, replay: () => {} };

export const GuideContext = createContext<GuideControls>(NOOP);

export function useGuide(): GuideControls {
  return useContext(GuideContext);
}
