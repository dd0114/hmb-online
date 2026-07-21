import type { ReactNode } from "react";
import { useAdminMe } from "../api/admin-hooks";
import { AdminFlagContext } from "./admin-flag";
import { isAdminUser } from "./admin-logic";

/**
 * /api/me 의 `user.isAdmin` 을 읽어 트리에 내려준다(App.tsx 에서 라우터 안쪽에 1회 마운트).
 * 조회 전/실패 시 false — admin 진입점은 확정 전까지 노출하지 않는다.
 */
export function AdminFlagProvider({ children }: { children: ReactNode }) {
  const { user } = useAdminMe();
  return <AdminFlagContext.Provider value={isAdminUser(user)}>{children}</AdminFlagContext.Provider>;
}
