/**
 * 튜토리얼 컨텍스트 (다시보기 진입점용 최소 표면).
 *
 * ⚠️ 이 파일은 **react 만 import 한다**(쿼리 훅 금지) — admin-flag.ts 와 같은 이유.
 * 로비 등 여러 페이지 유닛 테스트가 QueryClientProvider 없이 렌더되므로, 화면이 직접
 * useQuery 를 부르는 컨텍스트에 의존하면 그 테스트들이 깨진다. 실제 상태는
 * `TutorialProvider`(App 트리 안)가 갖고 여기로 주입한다. 프로바이더가 없으면 no-op.
 */
import { createContext, useContext } from "react";

export interface TutorialControls {
  /** 튜토리얼 오버레이가 떠 있는가. */
  active: boolean;
  /** 처음부터 다시 보기(완료 표시도 해제). */
  restart: () => void;
}

const NOOP: TutorialControls = { active: false, restart: () => {} };

export const TutorialContext = createContext<TutorialControls>(NOOP);

export function useTutorial(): TutorialControls {
  return useContext(TutorialContext);
}
