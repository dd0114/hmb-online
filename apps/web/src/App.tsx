import { useEffect } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { TokenProvider, useToken } from "./auth/TokenContext";
import { NavGuardProvider } from "./common/NavGuard";
import { NavLockProvider } from "./common/NavLockProvider";
import { AppConfigProvider } from "./common/AppConfigContext";
import { MaintenanceGate } from "./common/MaintenanceGate";
import { MatchLockGate } from "./common/MatchLockGate";
import { LoginPage } from "./auth/LoginPage";
import { loginPathWithReturn } from "./auth/return-to";
import { ShareNoticePage } from "./share/ShareNoticePage";
import { HomePage } from "./home/HomePage";
import { GamePage } from "./game/GamePage";
import { AwayPage } from "./away/AwayPage";
import { DeckPage } from "./deck/DeckPage";
import { CodexPage } from "./codex/CodexPage";
import { RecruitPage } from "./recruit/RecruitPage";
import { MePage } from "./me/MePage";
import { LeaguePage } from "./league/LeaguePage";
import { MatchPage } from "./match/MatchPage";
import type { MatchEndContinuation } from "./match/flow/match-flow";
import { MatchRewardFlow } from "./rewards/MatchRewardFlow";
import { AdminPage } from "./admin/AdminPage";
import { AdminFlagProvider } from "./admin/AdminFlagProvider";
import { StagePreview } from "./design/StagePreview";
import { CardArtPreview } from "./design/CardArtPreview";
import { GachaFxPreview } from "./design/GachaFxPreview";
import { QaConsolePage } from "./qa/QaConsolePage";
import { RequireAdmin } from "./admin/RequireAdmin";
import { TutorialProvider } from "./common/TutorialProvider";
import { setUnauthorizedHandler } from "./api/client";
import { queryClient } from "./api/query-client";

/**
 * 경기 종료 브릿지(#424 B4) 뒤에 **오버레이 안에서** 오는 화면 — #456 S4 · B3 의 순차 보상.
 *
 * ⚠️ **이 상수가 `matchEndContinuation` 의 유일한 프로덕션 호출부다.** 확장점 자체는 #424 가
 * 만들어 뒀지만 호출부가 0 이라, 브릿지 CTA 를 누르면 오버레이가 그냥 닫혔다(그 라벨도
 * `보상과 결과 보기` 였다). 여기 한 줄이 그 라벨과 그 뒤 화면을 동시에 정한다.
 *
 * ⚠️ **모듈 최상위 상수다** — 라우트 element 안에서 화살표 함수로 만들면 `App` 이 리렌더될 때마다
 * 새 함수가 되어 `MatchFlowOverlay` 가 매번 다른 `continuation` 을 들고 렌더된다.
 */
const MATCH_END_CONTINUATION: MatchEndContinuation = (handoff, onDone) => (
  <MatchRewardFlow handoff={handoff} onDone={onDone} />
);

/**
 * 미로그인이면 로그인으로 — **어디로 가려 했는지를 들려 보낸다**(#298).
 *
 * 예전엔 `/login` 으로만 보내서 목적지가 통째로 사라졌고, 공유 링크로 들어온 사람은 로그인 뒤
 * **로비에 착지**했다(그가 보러 온 공지는 어디에도 없다). 붙이는 규칙과 푸는 규칙은
 * `auth/return-to.ts` 한 곳에 있다 — 여기서 문자열을 조립하지 마라(오픈 리다이렉트 자리다).
 */
function RequireAuth({ children }: { children: ReactElement }) {
  const { token } = useToken();
  const location = useLocation();
  if (!token) {
    return <Navigate to={loginPathWithReturn(location.pathname + location.search)} replace />;
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

        {/* 홈도 MatchLockGate 를 쓴다 — 게이트가 `locked && !abandonable` 일 때만 되돌리므로
            재생 중에는 경기로 가고(#217 AC1), 회수 가능한 사고 매치에서는 홈이 열려 [경기 포기]에
            닿는다(#217 AC3). 홈 안에서 **타일을 못 누르게** 하는 건 또 다른 층이다(common/nav-lock.ts). */}
        <Route
          path="/home"
          element={
            <RequireAuth>
              <MatchLockGate>
                <HomePage />
              </MatchLockGate>
            </RequireAuth>
          }
        />

        {/* 아래 메타 라우트 8개(홈 포함)는 RequireAuth 안쪽에서 MatchLockGate 로 한 겹 더 감싼다(#217 AC1/AC2):
            진행 중 매치가 있으면 어디로 들어와도 /match/:id 로 돌아간다. 목록은 common/match-lock.ts
            의 LOCKED_ROUTES 와 같아야 하며(계약 = match-lock.test.ts + e2e/p4-match-lock.spec.ts 의
            전수 루프), /home·/match·/login·dev 하니스는 제외다. */}
        <Route
          path="/game"
          element={
            <RequireAuth>
              <MatchLockGate>
                <GamePage />
              </MatchLockGate>
            </RequireAuth>
          }
        />
        <Route
          path="/away"
          element={
            <RequireAuth>
              <MatchLockGate>
                <AwayPage />
              </MatchLockGate>
            </RequireAuth>
          }
        />
        <Route
          path="/deck"
          element={
            <RequireAuth>
              <MatchLockGate>
                <DeckPage />
              </MatchLockGate>
            </RequireAuth>
          }
        />
        <Route
          path="/players"
          element={
            <RequireAuth>
              <MatchLockGate>
                <CodexPage />
              </MatchLockGate>
            </RequireAuth>
          }
        />
        <Route
          path="/recruit"
          element={
            <RequireAuth>
              <MatchLockGate>
                <RecruitPage />
              </MatchLockGate>
            </RequireAuth>
          }
        />
        <Route
          path="/me"
          element={
            <RequireAuth>
              <MatchLockGate>
                <MePage />
              </MatchLockGate>
            </RequireAuth>
          }
        />
        <Route
          path="/league"
          element={
            <RequireAuth>
              <MatchLockGate>
                <LeaguePage />
              </MatchLockGate>
            </RequireAuth>
          }
        />

        {/* 구 URL — 새 IA 로 넘긴다(#286). 북마크·기존 링크·튜토리얼 딥링크가 죽지 않게 남긴다.
            ⚠️ /trade 는 **쿼리로 탭을 지정**한다. 안 그러면 트레이드 북마크가 뽑기 화면으로 떨어진다. */}
        <Route path="/lobby" element={<Navigate to="/home" replace />} />
        <Route path="/codex" element={<Navigate to="/players" replace />} />
        <Route path="/growth" element={<Navigate to="/players" replace />} />
        <Route path="/shop" element={<Navigate to="/recruit" replace />} />
        <Route path="/trade" element={<Navigate to="/recruit?tab=trade" replace />} />
        <Route path="/logs" element={<Navigate to="/me" replace />} />

        <Route
          path="/match/:id"
          element={
            <RequireAuth>
              <MatchPage matchEndContinuation={MATCH_END_CONTINUATION} />
            </RequireAuth>
          }
        />
        {/* 공지 공유 딥링크 (#298). 경로가 `/notice/` 가 아니라 **`/share/notice/`** 인 것은 취향이
            아니다 — `/notice/hero-*.webp` 가 실제 정적 에셋이라 접두사를 공유하면 OG Function(#299)이
            그 이미지를 삼킨다(에픽 #293 F4/R3). 여기서 갈라 두면 그 충돌이 구조적으로 사라진다.
            ⚠️ **MatchLockGate 로 감싸지 않는다.** 진행 중 매치가 있다고 공유 링크를 매치로
            흡수하면 링크를 눌러 온 사람은 목적지를 영영 못 본다(LOCKED_ROUTES 에 없는 이유). */}
        <Route
          path="/share/notice/:id"
          element={
            <RequireAuth>
              <ShareNoticePage />
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
        {/* 뽑기 이펙트 시안(#250) 리뷰 하니스 — 등급별 재생 버튼으로 hero 가 직접 보고 고른다.
            연출은 지표로 고를 수 없어 이 화면이 곧 컨펌 게이트다. 로그인·백엔드 불필요. */}
        {import.meta.env.DEV && <Route path="/design/gacha-fx" element={<GachaFxPreview />} />}
        {/* QA 콘솔(#191) — 워커 세션들이 등록한 탭을 hero 가 한 화면에서 보고 피드백하는 로컬 도구.
            로그인 없이 열리며 **dev 빌드에만 존재**한다(프로덕션 번들엔 경로 없음). 기동은
            `node tools/qa-console.mjs start`. 제품 화면이 아니다. */}
        {import.meta.env.DEV && <Route path="/qa/console" element={<QaConsolePage />} />}

        <Route path="/" element={<Navigate to={token ? "/home" : "/login"} replace />} />
        <Route path="*" element={<Navigate to={token ? "/home" : "/login"} replace />} />
      </Routes>
    </NavGuardProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* 재화 표기 등 서버 부트스트랩 config — 여기 한 곳에서만 조회해 트리에 내린다(#232).
          ⚠️ **점검 게이트(#477)보다 바깥이어야 한다** — 이 조회(`GET /api/config`)가 앱이 부팅할
          때 항상 나가는 유일한 요청이고, 백엔드가 죽었다는 사실을 처음 알려 주는 신호다. 게이트
          안으로 들어가면 점검 상태에서 언마운트돼 "무엇으로 감지했나"가 사라진다. */}
      <AppConfigProvider>
      {/* 백엔드에 못 닿으면 라우터 대신 점검 안내를 띄운다(#477). 라우트가 아니라 트리 대체인
          이유는 MaintenanceGate 주석 참조 — 라우트로 두면 "이 화면에서만 안 뜨는" 구멍이 난다. */}
      <MaintenanceGate>
      <BrowserRouter>
        <TokenProvider>
          {/* admin 플래그(/api/me additive)를 네비까지 내려준다 — AppNav 가 쿼리 컨텍스트에
              직접 의존하지 않도록(src/admin/admin-flag.ts 주석 참조). */}
          <AdminFlagProvider>
            {/* 경기 중 탭 잠금(#286 W2) — 네비가 쿼리 컨텍스트에 직접 의존하지 않도록
                여기서 조회해 컨텍스트로 내린다(admin-flag 와 같은 패턴). */}
            {/* 신규 유저 온보딩 코치마크(PRD-v4 §B). 라우트 바깥 1겹 —
                오버레이가 화면 전환과 무관하게 유지되고, 다시보기 진입점이
                useTutorial() 로 어디서든 붙는다(src/common/tutorial-context.ts). */}
            <NavLockProvider>
              <TutorialProvider>
                <AppRoutes />
              </TutorialProvider>
            </NavLockProvider>
          </AdminFlagProvider>
        </TokenProvider>
      </BrowserRouter>
      </MaintenanceGate>
      </AppConfigProvider>
    </QueryClientProvider>
  );
}

export default App;
