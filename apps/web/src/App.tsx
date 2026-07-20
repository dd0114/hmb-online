import { useEffect } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TokenProvider, useToken } from "./auth/TokenContext";
import { NavGuardProvider } from "./common/NavGuard";
import { LoginPage } from "./auth/LoginPage";
import { LobbyPage } from "./lobby/LobbyPage";
import { DeckPage } from "./deck/DeckPage";
import { ShopPage } from "./shop/ShopPage";
import { CodexPage } from "./codex/CodexPage";
import { TradePage } from "./trade/TradePage";
import { LogsPage } from "./logs/LogsPage";
import { LeaguePage } from "./league/LeaguePage";
import { MatchPage } from "./match/MatchPage";
import { AdminPage } from "./admin/AdminPage";
import { AdminFlagProvider } from "./admin/AdminFlagProvider";
import { RequireAdmin } from "./admin/RequireAdmin";
import { setUnauthorizedHandler } from "./api/client";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function RequireAuth({ children }: { children: ReactElement }) {
  const { token } = useToken();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

/** Wires apiFetch's 401 handler to a router navigate instead of the default hard redirect. */
function UnauthorizedBridge() {
  const { logout } = useToken();
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
      navigate("/login", { replace: true });
    });
  }, [logout, navigate]);

  return null;
}

function AppRoutes() {
  const { token } = useToken();
  return (
    <NavGuardProvider>
      <UnauthorizedBridge />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/lobby"
          element={
            <RequireAuth>
              <LobbyPage />
            </RequireAuth>
          }
        />
        <Route
          path="/deck"
          element={
            <RequireAuth>
              <DeckPage />
            </RequireAuth>
          }
        />
        <Route
          path="/shop"
          element={
            <RequireAuth>
              <ShopPage />
            </RequireAuth>
          }
        />
        <Route
          path="/codex"
          element={
            <RequireAuth>
              <CodexPage />
            </RequireAuth>
          }
        />
        <Route
          path="/trade"
          element={
            <RequireAuth>
              <TradePage />
            </RequireAuth>
          }
        />
        <Route
          path="/logs"
          element={
            <RequireAuth>
              <LogsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/league"
          element={
            <RequireAuth>
              <LeaguePage />
            </RequireAuth>
          }
        />
        <Route
          path="/match/:id"
          element={
            <RequireAuth>
              <MatchPage />
            </RequireAuth>
          }
        />
        {/* 운영자 전용 (PRD-v4 §C). RequireAuth(미로그인→/login) 다음 RequireAdmin(비admin→/lobby). */}
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to={token ? "/lobby" : "/login"} replace />} />
        <Route path="*" element={<Navigate to={token ? "/lobby" : "/login"} replace />} />
      </Routes>
    </NavGuardProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TokenProvider>
          {/* admin 플래그(/api/me additive)를 네비까지 내려준다 — AppNav 가 쿼리 컨텍스트에
              직접 의존하지 않도록(src/admin/admin-flag.ts 주석 참조). */}
          <AdminFlagProvider>
            <AppRoutes />
          </AdminFlagProvider>
        </TokenProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
