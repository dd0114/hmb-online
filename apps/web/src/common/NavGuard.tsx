import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

/**
 * Lightweight navigation guard (요구 5 — 미저장 이탈 확인).
 *
 * WHY not `useBlocker`: react-router's `useBlocker` only works under a *data router*
 * (`createBrowserRouter` + `RouterProvider`). This app uses `<BrowserRouter>` + `<Routes>`, so
 * `useBlocker` is unavailable without a full router migration (which would risk the existing E2E
 * suite). The LLD/issue explicitly allows an equivalent means — this is it.
 *
 * Mechanism: navigation SOURCES (AppNav tabs/sidebar, in-page back buttons) route their intent
 * through `useNavGuardRun`, which hands the "commit navigation" thunk to whatever guard the current
 * page registered. A dirty page (DeckPage) registers a guard that defers the thunk and shows its own
 * confirm dialog; pages without a guard commit immediately. There is at most one guard at a time
 * (the mounted page), so this is navigation plumbing — not an app-data global store (전역 스토어 금지).
 *
 * NOTE: this guards in-app navigation. Hardware/browser back (popstate) and refresh/close are best-
 * effort via `beforeunload` at the page level; blocking popstate needs the data router and is a
 * documented follow-up.
 */
export type NavGuard = (commit: () => void) => void;

interface NavGuardApi {
  register: (guard: NavGuard | null) => void;
  run: (commit: () => void) => void;
}

const Ctx = createContext<NavGuardApi | null>(null);

export function NavGuardProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<NavGuard | null>(null);
  // Stable identity so consumers' effects don't re-run every render.
  const apiRef = useRef<NavGuardApi>({
    register: (g) => {
      guardRef.current = g;
    },
    run: (commit) => {
      const g = guardRef.current;
      if (g) g(commit);
      else commit();
    },
  });
  return <Ctx.Provider value={apiRef.current}>{children}</Ctx.Provider>;
}

/**
 * For navigation sources. Returns a function that runs `commit` through the active guard (or
 * immediately when no guard / no provider). Usage: `run(() => navigate("/home"))`.
 */
export function useNavGuardRun(): (commit: () => void) => void {
  const ctx = useContext(Ctx);
  return ctx ? ctx.run : (commit) => commit();
}

/** A page registers its guard while it wants to intercept navigation; pass `null` to clear. */
export function useRegisterNavGuard(guard: NavGuard | null): void {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    ctx.register(guard);
    return () => ctx.register(null);
  }, [ctx, guard]);
}
