import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { components } from "../api/schema";
import { useToken } from "./TokenContext";
import { isValidNickname } from "./validation";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import styles from "./LoginPage.module.css";

type LoginResponse = components["schemas"]["LoginResponse"];

export function LoginPage() {
  const [nickname, setNickname] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [starterPackOpen, setStarterPackOpen] = useState(false);
  const { login } = useToken();
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);

    if (!isValidNickname(nickname)) {
      setClientError("닉네임은 2~16자의 문자/숫자/_/- 만 사용할 수 있습니다");
      return;
    }
    setClientError(null);
    setPending(true);
    try {
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: { nickname },
      });
      login(res.token);
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
      <form className={styles.form} onSubmit={handleSubmit}>
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
        />
        {clientError && <p className={styles.fieldError}>{clientError}</p>}
        <button type="submit" className={styles.submit} disabled={pending}>
          {pending ? "로그인 중…" : "로그인"}
        </button>
      </form>
      <ErrorToast message={serverError} onDismiss={() => setServerError(null)} />

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
