/**
 * 자체 로그인(아이디/비번) 패널 — PRD-v4 §A (AC-A1, AC-A2), P3-D2.
 *
 * 기존 게스트/OAuth목 3버튼 플로우에 **추가**되는 경로다(무회귀 — 기존 코드 경로 불변).
 *
 * ⚠️ **식별자는 하나뿐이다(서버 계약)**: server-java 는 별도 로그인 id 컬럼을 두지 않고
 * 기존 `users.nickname`(UNIQUE)을 로그인 id 로 재사용한다(RegisterRequest = {nickname, password}).
 * 그래서 회원가입 폼에도 "아이디"·"닉네임" 이중 입력이 **없다** — 한 필드가 둘을 겸한다.
 *
 * ⚠️ **평문 비밀번호 목업**이다. 실 OAuth/해시 교체 지점:
 *   - 서버: users.password 평문 → 해시 컬럼(백로그). body shape 은 그대로.
 *   - 클라: 실 OAuth 전환 시 이 패널 대신 리다이렉트 플로우로 교체(login-flow.ts 상단 주석).
 *
 * AC-A2 (비밀번호 비노출) — 이 컴포넌트가 지키는 불변:
 *   1. 비밀번호는 **컴포넌트 로컬 state 에만** 존재한다. localStorage/sessionStorage/쿼리캐시에
 *      쓰지 않는다(persistToken 은 token 만 저장 — TokenContext).
 *   2. `console.*` 로 비밀번호(및 요청 body)를 출력하지 않는다.
 *   3. 제출 직후 성공/실패와 무관하게 폼 state 에서 비운다(clearPassword).
 *   4. 서버 에러 원문 대신 고정 문구를 쓴다(입력값 에코 방지) — login-flow.localAuthErrorToFields.
 *   5. input 은 type="password" + autoComplete 를 명시해 브라우저 오저장/오토필 오동작을 막는다.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { apiFetch } from "../api/client";
import type { AuthResponse } from "../api/p3";
import {
  AUTH_LOGIN_PATH,
  AUTH_REGISTER_PATH,
  buildLocalLoginBody,
  buildRegisterBody,
  localAuthErrorToFields,
} from "./login-flow";
import { hasFieldErrors, validateLocalCredentials } from "./validation";
import type { LocalAuthFieldErrors } from "./validation";
import styles from "./LoginPage.module.css";

/** 로그인 폼 / 회원가입 폼 전환. */
export type LocalAuthMode = "login" | "register";

interface Props {
  onAuthenticated: (token: string, isNew: boolean) => void;
  onBack: () => void;
  initialMode?: LocalAuthMode;
}

export function LocalAuthPanel({ onAuthenticated, onBack, initialMode = "login" }: Props) {
  const [mode, setMode] = useState<LocalAuthMode>(initialMode);
  /** 로그인 id 겸 표시 닉네임 — 서버가 하나만 두므로 클라도 필드 하나다. */
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<LocalAuthFieldErrors>({});
  const [pending, setPending] = useState(false);

  const isRegister = mode === "register";

  function switchMode(next: LocalAuthMode) {
    setMode(next);
    setErrors({});
    // AC-A2: 모드 전환 시에도 비밀번호는 남기지 않는다.
    setPassword("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateLocalCredentials({ nickname, password });
    if (hasFieldErrors(validation)) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const res = await apiFetch<AuthResponse>(
        isRegister ? AUTH_REGISTER_PATH : AUTH_LOGIN_PATH,
        {
          method: "POST",
          body: isRegister
            ? buildRegisterBody({ nickname, password })
            : buildLocalLoginBody({ nickname, password }),
        },
      );
      onAuthenticated(res.token, res.isNew);
    } catch (err) {
      setErrors(localAuthErrorToFields(err));
    } finally {
      setPending(false);
      // AC-A2: 요청이 끝나면(성공/실패 무관) 비밀번호를 상태에서 즉시 비운다.
      setPassword("");
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} data-testid="local-auth-form" data-mode={mode}>
      <div className={styles.chosenProvider}>
        <span className={styles.providerBadge}>아이디</span>
        <span>{isRegister ? "새 계정을 만듭니다" : "아이디와 비밀번호를 입력하세요"}</span>
      </div>

      {/* 서버가 nickname 하나를 로그인 id 로 쓰므로 필드도 하나다(가입/로그인 동일). */}
      <label className={styles.label} htmlFor="local-nickname">
        아이디 <span className={styles.labelHint}>(닉네임으로도 표시됩니다)</span>
      </label>
      <input
        id="local-nickname"
        className={styles.input}
        data-testid="local-nickname"
        value={nickname}
        onChange={(event) => setNickname(event.target.value)}
        placeholder="2~16자 문자/숫자/_/-"
        autoComplete="username"
        disabled={pending}
        autoFocus
      />
      {errors.nickname && (
        <p className={styles.fieldError} data-testid="local-error-nickname">
          {errors.nickname}
        </p>
      )}

      <label className={styles.label} htmlFor="local-password">
        비밀번호
      </label>
      <input
        id="local-password"
        type="password"
        className={styles.input}
        data-testid="local-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="4~64자"
        autoComplete={isRegister ? "new-password" : "current-password"}
        disabled={pending}
      />
      {errors.password && (
        <p className={styles.fieldError} data-testid="local-error-password">
          {errors.password}
        </p>
      )}

      {errors.form && (
        <p className={styles.fieldError} data-testid="local-error-form">
          {errors.form}
        </p>
      )}

      <button type="submit" className={styles.submit} data-testid="local-submit" disabled={pending}>
        {pending ? "처리 중…" : isRegister ? "회원가입" : "로그인"}
      </button>

      <button
        type="button"
        className={styles.textButton}
        data-testid="local-mode-toggle"
        onClick={() => switchMode(isRegister ? "login" : "register")}
        disabled={pending}
      >
        {isRegister ? "이미 계정이 있어요 — 로그인" : "계정이 없어요 — 회원가입"}
      </button>

      {/* AC-A2: 평문 목업임을 화면에 명시(테스터가 실계정 비번을 재사용하지 않도록). */}
      <p className={styles.disclaimer} data-testid="local-plaintext-notice">
        목업 계정입니다 — 비밀번호가 평문으로 저장되니 실제로 쓰는 비밀번호를 입력하지 마세요.
      </p>

      <button
        type="button"
        className={styles.textButton}
        onClick={onBack}
        disabled={pending}
        data-testid="local-back"
      >
        다른 방법으로 로그인
      </button>
    </form>
  );
}
