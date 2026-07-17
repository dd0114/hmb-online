import { useEffect } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TokenProvider, useToken } from "./auth/TokenContext";
import { LoginPage } from "./auth/LoginPage";
import { LobbyPage } from "./lobby/LobbyPage";
import { DeckPage } from "./deck/DeckPage";
import { ShopPage } from "./shop/ShopPage";
import { CodexPage } from "./codex/CodexPage";
import { MatchPage } from "./match/MatchPage";
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
    <>
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
          path="/match/:id"
          element={
            <RequireAuth>
              <MatchPage />
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to={token ? "/lobby" : "/login"} replace />} />
        <Route path="*" element={<Navigate to={token ? "/lobby" : "/login"} replace />} />
      </Routes>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TokenProvider>
          <AppRoutes />
        </TokenProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
