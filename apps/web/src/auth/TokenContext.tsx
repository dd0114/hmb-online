import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { clearToken, getToken, setToken as persistToken } from "../api/client";

interface TokenContextValue {
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
}

const TokenContext = createContext<TokenContextValue | null>(null);

export function TokenProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());

  const login = useCallback((next: string) => {
    persistToken(next);
    setTokenState(next);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  const value = useMemo<TokenContextValue>(() => ({ token, login, logout }), [token, login, logout]);

  return <TokenContext.Provider value={value}>{children}</TokenContext.Provider>;
}

export function useToken(): TokenContextValue {
  const ctx = useContext(TokenContext);
  if (!ctx) {
    throw new Error("useToken must be used within a TokenProvider");
  }
  return ctx;
}
