import { useSyncExternalStore } from "react";
import { charAssetsSnapshot, subscribeCharAssets, type CharAssets } from "./char-assets-store";

/**
 * 캐릭터 에셋 번들 훅 (#145). 모듈 싱글턴 스토어를 구독한다 —
 * **QueryClientProvider 같은 컨텍스트 요구가 없다**(아바타가 앱 전역에서 쓰이므로 소비처에
 * 아무 조건도 얹지 않는 게 중요하다. 자세한 근거는 char-assets-store.ts 주석).
 *
 * 실패하지 않는 계약: 로딩 중·실패 시 빈 번들을 주고, 소비 컴포넌트는 CSS 플레이스홀더로
 * 떨어진다(깨짐 0). 서버 렌더 스냅샷도 같은 빈 번들이라 하이드레이션 불일치가 없다.
 */
export function useCharAssets(): CharAssets {
  return useSyncExternalStore(subscribeCharAssets, charAssetsSnapshot, charAssetsSnapshot);
}
