import type { ReactNode } from "react";
import { useActiveMatch } from "../api/hooks";
import { NavLockContext } from "./nav-lock";

/**
 * `GET /api/me/active-match` 의 `locked` 를 트리에 내려준다(App.tsx 라우터 안쪽 1회 마운트).
 *
 * 조회 전/실패 시 **false** — 모르는 동안 잠그면 정상 유저가 앱을 못 쓴다. 잠금은 어차피
 * 서버가 409 로 최종 강제하므로 이 층은 **안내**지 보안 경계가 아니다(MatchLockGate 와 같은 원칙).
 *
 * ⚠️ 판정은 서버가 한다 — 상태 집합(`BRIEFING`/`FIRST_HALF`/…)을 클라가 다시 정의하지 않는다.
 */
export function NavLockProvider({ children }: { children: ReactNode }) {
  const { data: active } = useActiveMatch();
  return <NavLockContext.Provider value={Boolean(active?.locked)}>{children}</NavLockContext.Provider>;
}
