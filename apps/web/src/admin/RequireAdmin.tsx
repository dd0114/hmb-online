import type { ReactElement } from "react";
import { Navigate } from "react-router-dom";
import { useAdminMe } from "../api/admin-hooks";
import { useToken } from "../auth/TokenContext";
import { adminGuardDecision } from "./admin-logic";

/**
 * /admin 라우트 가드 (AC-C2 클라이언트 측). 분기 계약은 `adminGuardDecision`(순수, 테스트 박제):
 * 미로그인 → /login, 판정 전 → 대기(admin 화면 노출 0), 비admin/조회실패 → /lobby, admin → 렌더.
 *
 * 이건 **UX 가드일 뿐 보안 경계가 아니다** — 서버가 admin API 를 별도 인증 게이트로 막고(AC-C2),
 * URL 직접 진입으로 여기를 통과해도 AdminPage 가 403 을 받아 안내 후 /lobby 로 보낸다.
 */
export function RequireAdmin({ children }: { children: ReactElement }) {
  const { token } = useToken();
  const me = useAdminMe();

  const decision = adminGuardDecision({
    hasToken: Boolean(token),
    meLoading: me.isLoading,
    meErrored: me.isError,
    user: me.user,
  });

  if (decision === "login") return <Navigate to="/login" replace />;
  if (decision === "lobby") return <Navigate to="/home" replace />;
  if (decision === "loading") {
    return (
      <p style={{ padding: 16, color: "var(--text-muted)" }} data-testid="admin-guard-pending">
        확인 중…
      </p>
    );
  }
  return children;
}
