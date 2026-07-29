/**
 * 경기 진행 중 내비 잠금 상태를 네비까지 전달하는 최소 컨텍스트 (#286 W2).
 *
 * ⚠️ 이 파일은 **react 만 import 한다**(쿼리 훅 금지) — `admin-flag.ts` 와 같은 이유다.
 * AppNav 는 여러 페이지 유닛 테스트에서 QueryClientProvider 없이 렌더되므로, 네비가 직접
 * useQuery 를 부르면 그 테스트들이 깨진다. 실제 조회는 `NavLockProvider`(App.tsx 트리 안)가
 * 하고 여기로 주입한다. 프로바이더가 없으면 **잠기지 않음** = 안전한 기본(막지 않는다).
 *
 * ── #217 강제 이동과 **다른 층**이다 ────────────────────────────────────────
 * `MatchLockGate` 는 `locked && !abandonable` 일 때 다른 라우트를 **매치로 되돌린다**.
 * 여기 잠금은 `locked` 하나로 **탭을 누를 수 없게** 만든다. hero 지적(2R):
 * 되돌리는 방식은 화면이 멀쩡히 보이고 눌린 뒤에야 튕기므로, 그 사이에 강화·덱 편집이
 * 들어갈 창이 있었다. 두 층은 목적이 달라 조건도 다르다 — 한쪽으로 "단순화"하지 말 것.
 */
import { createContext, useContext } from "react";

export const NavLockContext = createContext<boolean>(false);

/** 지금 경기 중이라 메타 화면을 잠가야 하는가. 프로바이더 없으면 false. */
export function useNavLocked(): boolean {
  return useContext(NavLockContext);
}
