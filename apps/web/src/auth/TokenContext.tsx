import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  clearProvider,
  clearToken,
  getProvider,
  getToken,
  setProvider as persistProvider,
  setToken as persistToken,
} from "../api/client";
import type { AuthProviderId } from "./login-flow";

interface TokenContextValue {
  token: string | null;
  /** 로그인에 쓴 provider(로비 뱃지용). 세션 없으면 null. */
  provider: AuthProviderId | null;
  login: (token: string, provider: AuthProviderId) => void;
  logout: () => void;
}

const TokenContext = createContext<TokenContextValue | null>(null);

export function TokenProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [provider, setProviderState] = useState<AuthProviderId | null>(
    () => (getProvider() as AuthProviderId | null) ?? null,
  );

  const login = useCallback((next: string, nextProvider: AuthProviderId) => {
    persistToken(next);
    persistProvider(nextProvider);
    setTokenState(next);
    setProviderState(nextProvider);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    clearProvider();
    setTokenState(null);
    setProviderState(null);
  }, []);

  const value = useMemo<TokenContextValue>(
    () => ({ token, provider, login, logout }),
    [token, provider, login, logout],
  );

  return <TokenContext.Provider value={value}>{children}</TokenContext.Provider>;
}

export function useToken(): TokenContextValue {
  const ctx = useContext(TokenContext);
  if (!ctx) {
    throw new Error("useToken must be used within a TokenProvider");
  }
  return ctx;
}
