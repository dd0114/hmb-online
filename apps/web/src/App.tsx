import { useEffect } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { TokenProvider, useToken } from "./auth/TokenContext";
import { NavGuardProvider } from "./common/NavGuard";
import { LoginPage } from "./auth/LoginPage";
import { LobbyPage } from "./lobby/LobbyPage";
import { DeckPage } from "./deck/DeckPage";
import { ShopPage } from "./shop/ShopPage";
import { CodexPage } from "./codex/CodexPage";
import { GrowthHubPage } from "./growth/GrowthHubPage";
import { TradePage } from "./trade/TradePage";
import { LogsPage } from "./logs/LogsPage";
import { LeaguePage } from "./league/LeaguePage";
import { MatchPage } from "./match/MatchPage";
import { AdminPage } from "./admin/AdminPage";
import { AdminFlagProvider } from "./admin/AdminFlagProvider";
import { StagePreview } from "./design/StagePreview";
import { CardArtPreview } from "./design/CardArtPreview";
import { QaConsolePage } from "./qa/QaConsolePage";
import { RequireAdmin } from "./admin/RequireAdmin";
import { TutorialProvider } from "./common/TutorialProvider";
import { setUnauthorizedHandler } from "./api/client";
import { queryClient } from "./api/query-client";

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
          path="/growth"
          element={
            <RequireAuth>
              <GrowthHubPage />
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
        {/* 디자인 확인 전용(#169 S1) — dev 빌드에서만 존재한다. 로그인 없이 관전 셸을 상태별로
            열어볼 수 있게 하는 리뷰 하니스이지, 제품 화면이 아니다(프로덕션 번들엔 경로 없음). */}
        {import.meta.env.DEV && <Route path="/design/stage" element={<StagePreview />} />}
        {/* 카드 풀아트 배치안(#187) 리뷰 하니스 — 로그인·백엔드 불필요(정적 에셋만). */}
        {import.meta.env.DEV && <Route path="/design/cards" element={<CardArtPreview />} />}
        {/* QA 콘솔(#191) — 워커 세션들이 등록한 탭을 hero 가 한 화면에서 보고 피드백하는 로컬 도구.
            로그인 없이 열리며 **dev 빌드에만 존재**한다(프로덕션 번들엔 경로 없음). 기동은
            `node tools/qa-console.mjs start`. 제품 화면이 아니다. */}
        {import.meta.env.DEV && <Route path="/qa/console" element={<QaConsolePage />} />}

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
            {/* 신규 유저 온보딩 코치마크(PRD-v4 §B). 라우트 바깥 1겹 —
                오버레이가 화면 전환과 무관하게 유지되고, 다시보기 진입점이
                useTutorial() 로 어디서든 붙는다(src/common/tutorial-context.ts). */}
            <TutorialProvider>
              <AppRoutes />
            </TutorialProvider>
          </AdminFlagProvider>
        </TokenProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
