/**
 * #493 W7-v3 — 온레일 컨텍스트(최소 표면).
 *
 * ⚠️ **react 만 import 한다**(쿼리 훅 금지) — `guide-context.ts`·`tutorial-context.ts` 와 같은
 * 이유다: 여러 페이지 유닛 테스트가 QueryClientProvider 없이 렌더된다. 실제 상태는
 * `OnRailProvider` 가 주입하고, 프로바이더가 없으면 no-op(온레일 없음)이다.
 */
import { createContext, useContext } from "react";

export interface OnRailControls {
  /** 온레일이 지금 돌고 있는가(화면이 맞는지와 무관 — 진행 중이면 참). */
  running: boolean;
  /** 지금 스텝 id(없으면 null). 화면 코드가 이걸로 분기하지 마라 — 아래 두 신호만 쓴다. */
  stepId: string | null;
  /**
   * 경기 재생을 **정지**하고 [스킵]을 **잠근다**(S3 화면 투어 구간).
   * 소비 = `match/MatchPage` 한 곳. 투어가 끝나면 거짓이 되고 그 뒤는 일반 관전이다.
   */
  matchFrozen: boolean;
  /** 온레일을 시작한다(S1 모달 [시작하기]). */
  start: () => void;
  /** 사양한다(S1 모달 [건너뛰기] · 진행 중 [그만두기]) — 다시 묻지 않는다(조정 ⑥). */
  skip: () => void;
}

/**
 * ⚠️ **하프타임 교체 차단은 여기 없다.** 튜토리얼 매치의 후반은 사전에 구운 로그라 교체가
 * 반영되지 않는데(W6-v3), 그 사실의 권위는 온레일 진행 상태가 아니라 **`MatchDetail.tutorial`**
 * 이다 — 온레일을 그만둔 뒤에도 그 매치는 여전히 구운 매치이기 때문이다. 그래서 그 잠금은
 * `HalftimePanel` 이 매치를 보고 직접 정한다(컨텍스트를 거치면 주인이 둘이 된다).
 */
const NOOP: OnRailControls = {
  running: false,
  stepId: null,
  matchFrozen: false,
  start: () => {},
  skip: () => {},
};

export const OnRailContext = createContext<OnRailControls>(NOOP);

export function useOnRail(): OnRailControls {
  return useContext(OnRailContext);
}
