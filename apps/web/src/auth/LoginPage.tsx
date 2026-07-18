import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { components } from "../api/schema";
import { useToken } from "./TokenContext";
import { isValidNickname } from "./validation";
import {
  OAUTH_PROVIDERS,
  buildLoginBody,
  consentTitle,
  providerMeta,
} from "./login-flow";
import type { AuthProviderId } from "./login-flow";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import styles from "./LoginPage.module.css";

type LoginResponse = components["schemas"]["LoginResponse"];

/** 로그인 화면 단계: provider 선택 → (OAuth 는 동의 모달) → 닉네임 입력. */
type Stage = "choose" | "nickname";

export function LoginPage() {
  const [stage, setStage] = useState<Stage>("choose");
  const [provider, setProviderChoice] = useState<AuthProviderId | null>(null);
  const [consentProvider, setConsentProvider] = useState<AuthProviderId | null>(null);
  const [nickname, setNickname] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [starterPackOpen, setStarterPackOpen] = useState(false);
  const { login } = useToken();
  const navigate = useNavigate();

  // 게스트: 기존 플로우 그대로(동의 모달 없이 바로 닉네임 입력).
  function chooseGuest() {
    setProviderChoice("guest");
    setStage("nickname");
  }

  // 구글/애플: mock 동의 모달을 먼저 띄운다(실 OAuth 동의화면 모사 아님).
  function chooseOAuth(id: AuthProviderId) {
    setConsentProvider(id);
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
    if (!provider) return;

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
      login(res.token, provider);
      if (res.isNew) {
        setStarterPackOpen(true);
      } else {
        navigate("/lobby", { replace: true });
      }
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : "로그인에 실패했습니다");
    } finally {
      setPending(false);
    }
  }

  function handleStarterPackConfirm() {
    setStarterPackOpen(false);
    navigate("/lobby", { replace: true });
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

      {starterPackOpen && (
        <Modal
          onClose={handleStarterPackConfirm}
          labelledBy="starter-pack-title"
          overlayClassName={styles.modalOverlay}
          className={styles.modal}
        >
          <h2 id="starter-pack-title">스타터 팩 지급</h2>
          <p>신규 감독님을 환영합니다! 선수 14명과 3,000P가 지급되었습니다.</p>
          <button type="button" className={styles.submit} onClick={handleStarterPackConfirm}>
            확인
          </button>
        </Modal>
      )}
    </div>
  );
}
