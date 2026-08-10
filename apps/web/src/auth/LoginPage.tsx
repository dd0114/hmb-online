import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { components } from "../api/schema";
import { useToken } from "./TokenContext";
import { isValidNickname } from "./validation";
import { LOBBY_PATH, RETURN_TO_PARAM, resolveReturnTo } from "./return-to";
import {
  OAUTH_PROVIDERS,
  buildLoginBody,
  consentTitle,
  providerMeta,
} from "./login-flow";
import type { AuthProviderId } from "./login-flow";
import { LOCAL_PROVIDER, STARTER_GRANT_PATH } from "../api/p3";
import type { StarterGrantResponse } from "../api/p3";
import { LocalAuthPanel } from "./LocalAuthPanel";
import { StarterReveal } from "./StarterReveal";
import { markTutorialPending } from "../common/tutorial-storage";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { SplashScreen } from "../splash/SplashScreen";
import { markSplashSeen, readSplashSeen, shouldShowSplash } from "../splash/splash-gate";
import styles from "./LoginPage.module.css";

type LoginResponse = components["schemas"]["LoginResponse"];

/**
 * 로그인 화면 단계: provider 선택 → (OAuth 는 동의 모달) → 닉네임 입력.
 * "local" 은 Phase3 추가 분기 — 닉네임 단계 대신 id/비번 패널로 간다(PRD-v4 §A).
 */
type Stage = "choose" | "nickname" | "local";

export function LoginPage() {
  const [stage, setStage] = useState<Stage>("choose");
  const [provider, setProviderChoice] = useState<AuthProviderId | null>(null);
  const [consentProvider, setConsentProvider] = useState<AuthProviderId | null>(null);
  const [nickname, setNickname] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [starterPackOpen, setStarterPackOpen] = useState(false);
  /** 가입 지급된 최상위 유닛(#209). undefined = 아직 로딩, null = 없음(연출 생략). */
  const [starterGrant, setStarterGrant] = useState<StarterGrantResponse | null | undefined>(undefined);
  const { login } = useToken();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  /**
   * 로그인 성공 후 착지점 (#298). 기본은 로비지만, 공유 딥링크로 들어왔다면 **그 링크**다 —
   * `RequireAuth` 가 `?returnTo=` 로 들려 보낸다.
   *
   * ⚠️ 이 값은 링크 하나로 통제되는 외부 입력이다. 여기서 `navigate(raw)` 를 부르면 오픈
   * 리다이렉트가 된다 — 반드시 `resolveReturnTo`(화이트리스트)를 통과시킨다. 착지 지점이
   * **두 곳**(일반 로그인 / 스타터팩 확인)이라 상수 하나로 묶어 둔다: 한쪽만 고치면 신규
   * 유저의 딥링크만 조용히 로비로 새 나간다.
   */
  const returnTo = resolveReturnTo(searchParams.get(RETURN_TO_PARAM));
  /**
   * 첫 진입 스플래시(#479). 비로그인 첫 화면은 항상 이 라우트이므로(App.tsx 의 `/`·`*` 가
   * 여기로 보낸다) 게이트도 여기 한 곳이면 된다.
   *
   * ⚠️ 초기값을 **한 번만** 계산한다(lazy initializer) — 매 렌더에서 `readSplashSeen()` 을
   * 다시 읽으면 `markSplashSeen()` 직후 리렌더에서 조건이 뒤집혀 스플래시가 두 번 사라지거나
   * (더 나쁘게) 로그인 중 리렌더에 다시 뜬다. 판정 규칙 자체는 `splash-gate.ts` 가 소유한다.
   */
  const [splashOpen, setSplashOpen] = useState(() =>
    shouldShowSplash({ seen: readSplashSeen(), returnTo: searchParams.get(RETURN_TO_PARAM) }),
  );

  // 게스트: 기존 플로우 그대로(동의 모달 없이 바로 닉네임 입력).
  function chooseGuest() {
    setProviderChoice("guest");
    setStage("nickname");
  }

  // 구글/애플: mock 동의 모달을 먼저 띄운다(실 OAuth 동의화면 모사 아님).
  function chooseOAuth(id: AuthProviderId) {
    setConsentProvider(id);
  }

  // 자체 계정(id/비번, PRD-v4 §A): 동의 모달 없이 전용 폼으로. 기존 경로는 건드리지 않는다.
  function chooseLocal() {
    setProviderChoice(LOCAL_PROVIDER);
    setStage("local");
  }

  /** 토큰 확보 후 공통 후처리 — 기존(닉네임) 경로와 local 경로가 같은 동선을 탄다. */
  function completeLogin(token: string, isNew: boolean, usedProvider: AuthProviderId) {
    login(token, usedProvider);
    if (isNew) {
      // 신규 가입 신호 → 로비 진입 시 온보딩 튜토리얼 자동 시작(PRD-v4 §B, AC-B1).
      // 완료/건너뛰기 저장은 TutorialProvider 가 한다(여기서는 신호만).
      markTutorialPending();
      setStarterPackOpen(true);
      // 최상위 지급 카드를 읽어 온다(#209 AC3). 실패해도 연출만 빠지고 가입 동선은 그대로 —
      // 지급 자체는 서버 트랜잭션에서 이미 끝났다.
      apiFetch<StarterGrantResponse>(STARTER_GRANT_PATH)
        .then(setStarterGrant)
        .catch(() => setStarterGrant(null));
    } else {
      navigate(returnTo, { replace: true });
    }
  }

  function confirmConsent() {
    if (!consentProvider) return;
    setProviderChoice(consentProvider);
    setConsentProvider(null);
    setStage("nickname");
  }

  function cancelConsent() {
    setConsentProvider(null);
  }

  function backToChoose() {
    setStage("choose");
    setProviderChoice(null);
    setClientError(null);
    setServerError(null);
    setNickname("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    // local 은 이 폼을 쓰지 않는다(LocalAuthPanel 이 자체 제출) — 방어적 가드 겸 타입 좁히기.
    if (!provider || provider === LOCAL_PROVIDER) return;

    if (!isValidNickname(nickname)) {
      setClientError("닉네임은 2~16자의 문자/숫자/_/- 만 사용할 수 있습니다");
      return;
    }
    setClientError(null);
    setPending(true);
    try {
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: buildLoginBody(provider, nickname),
      });
      completeLogin(res.token, res.isNew, provider);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : "로그인에 실패했습니다");
    } finally {
      setPending(false);
    }
  }

  function handleStarterPackConfirm() {
    setStarterPackOpen(false);
    // #493 W1: 신규 가입의 기본 착지는 1분 미니게임(/welcome)이다 — 첫 골을 1분 안에 보여준다
    // (hero C 하이브리드, 미니게임 CTA/건너뛰기가 홈으로 보내면 거기서 온보딩이 시작된다).
    // 단, 신규 유저도 공유 링크로 왔다면 그 목적지가 방문 목적이다(#298/hero 확정) —
    // returnTo 가 기본(홈)일 때만 미니게임을 끼운다. #248 의 "미룸"은 **저절로 뜨는 팝업**에만 걸린다.
    navigate(returnTo === LOBBY_PATH ? "/welcome" : returnTo, { replace: true });
  }

  /**
   * ⚠️ 스플래시는 로그인 폼을 **가리는 오버레이가 아니라 대체 화면**이다(#479). 겹쳐 두면
   * 폼이 뒤에 살아 있어 스크린리더·탭 순서가 두 화면을 동시에 읽고, 아래 버튼들이 오버레이
   * 뒤에서 눌리는 자리가 생긴다. `[게임 시작]` 이 이 상태를 끝내면 **현행 폼이 그대로** 나온다
   * (아래 JSX 는 손대지 않았다 = 로그인 후 동선 무변경).
   */
  if (splashOpen) {
    return (
      <SplashScreen
        onStart={() => {
          markSplashSeen();
          setSplashOpen(false);
        }}
      />
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>HMB 온라인</h1>

      {stage === "choose" && (
        <div className={styles.providerList} data-testid="provider-choose">
          {OAUTH_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.providerButton}
              data-testid={`provider-${p.id}`}
              onClick={() => chooseOAuth(p.id)}
            >
              {p.label}
            </button>
          ))}
          {/* Phase3 추가(PRD-v4 §A): 자체 계정 진입점. 기존 버튼들은 그대로. */}
          <button
            type="button"
            className={styles.providerButton}
            data-testid="provider-local"
            onClick={chooseLocal}
          >
            아이디로 로그인
          </button>
          <button
            type="button"
            className={`${styles.providerButton} ${styles.guestButton}`}
            data-testid="provider-guest"
            onClick={chooseGuest}
          >
            게스트로 시작
          </button>
          <p className={styles.disclaimer}>
            목업 로그인입니다 — 실제 구글/애플 계정과 무관합니다.
          </p>
        </div>
      )}

      {stage === "nickname" && provider && (
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.chosenProvider}>
            <span className={styles.providerBadge}>{providerMeta(provider).badge}</span>
            <span>계정 닉네임을 입력하세요</span>
          </div>
          <label className={styles.label} htmlFor="nickname">
            닉네임
          </label>
          <input
            id="nickname"
            className={styles.input}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="2~16자"
            autoComplete="username"
            disabled={pending}
            autoFocus
          />
          {clientError && <p className={styles.fieldError}>{clientError}</p>}
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? "로그인 중…" : "계속"}
          </button>
          <button type="button" className={styles.textButton} onClick={backToChoose} disabled={pending}>
            다른 방법으로 로그인
          </button>
        </form>
      )}

      {stage === "local" && (
        <LocalAuthPanel
          onAuthenticated={(token, isNew) => completeLogin(token, isNew, LOCAL_PROVIDER)}
          onBack={backToChoose}
        />
      )}

      <ErrorToast message={serverError} onDismiss={() => setServerError(null)} />

      {consentProvider && (
        <Modal
          onClose={cancelConsent}
          labelledBy="consent-title"
          overlayClassName={styles.modalOverlay}
          className={styles.modal}
          testId="consent-modal"
        >
          <h2 id="consent-title">{consentTitle(providerMeta(consentProvider))}</h2>
          <p>
            HMB 온라인이 {providerMeta(consentProvider).consentName} 계정 정보(닉네임)에 접근하려
            합니다. 이 화면은 목업이며 실제 계정 인증은 이루어지지 않습니다.
          </p>
          <button
            type="button"
            className={styles.submit}
            data-testid="consent-continue"
            onClick={confirmConsent}
          >
            계속
          </button>
          <button type="button" className={styles.textButton} onClick={cancelConsent}>
            취소
          </button>
        </Modal>
      )}

      {/* #209: 지급의 하이라이트가 최상위 유닛 1장이 되면서 텍스트 모달 → 카드 리빌로 바뀌었다.
          지급 내역은 서버가 박제한 값을 읽는다(계산 아님) — 못 읽으면 카드 없이 문구만 뜬다. */}
      {starterPackOpen && (
        <StarterReveal grant={starterGrant} onClose={handleStarterPackConfirm} />
      )}
    </div>
  );
}
