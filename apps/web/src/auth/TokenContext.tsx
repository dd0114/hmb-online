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
import { queryClient } from "../api/query-client";
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
    // 캐시를 비우지 않으면 **다음 계정이 이전 계정 데이터를 본다**. /api/me 왕복(모바일에서
    // 수백 ms)이 끝나기 전까지 useMe() 가 이전 유저를 돌려주기 때문이다. 실제로 그 stale 창에서
    // 튜토리얼이 이전 계정 id 로 완료 저장을 해버렸다(그 계정은 한 스텝도 못 봤는데).
    // 지갑/덱/전적 등 다른 화면도 같은 위험을 공유하므로 전체를 비운다.
    queryClient.clear();
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
