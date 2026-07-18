/**
 * Phase-2 React Query hooks (team snapshots + match Phase2 fields). Kept separate from the
 * V1 `hooks.ts` barrel to mirror the 2-spec type split (schema.d.ts + schema-v2.d.ts).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type { Deck } from "./hooks";
import type {
  FaProposeRequest,
  RelationsResponse,
  TeamPresetSlot,
  TeamSnapshotSaveRequest,
  TradeResolveResponse,
  TradeSlotsResponse,
  TradeSpeedupResponse,
} from "./v2";

/** GET /api/presets/team — always 3 slots (empty slots have name/snapshot=null). AC-B1. */
export function useTeamPresets() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["team-presets"],
    queryFn: () => apiFetch<TeamPresetSlot[]>("/api/presets/team"),
    enabled: Boolean(token),
  });
}

/** PUT /api/presets/team/{slot} — save/rename/duplicate a snapshot (full replace). */
export function useSaveTeamPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slot, body }: { slot: number; body: TeamSnapshotSaveRequest }) =>
      apiFetch<TeamPresetSlot>(`/api/presets/team/${slot}`, { method: "PUT", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-presets"] });
    },
  });
}

/**
 * POST /api/presets/team/{slot}/apply — load a snapshot into the active deck. Invalidates the
 * deck cache so the shared editor re-reads it. Returns the applied Deck (V1 schema).
 */
export function useApplyTeamPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slot: number) =>
      apiFetch<Deck>(`/api/presets/team/${slot}/apply`, { method: "POST" }),
    onSuccess: (deck) => {
      queryClient.setQueryData(["deck"], deck);
    },
  });
}

/**
 * GET /api/relations — 팀 사기(morale/streak) + 선수별 신뢰도(trust)·성격(personality). AC-C4.
 * 관계는 경기 결과/기용으로 변동하므로 me/players 갱신과 함께 무효화된다(호출부에서 처리).
 */
export function useRelations() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["relations"],
    queryFn: () => apiFetch<RelationsResponse>("/api/relations"),
    enabled: Boolean(token),
  });
}

// ─────────────────────────── 트레이드 (W3, AC-D) ───────────────────────────

/**
 * Caches a trade resolve/speedup touches: slots (["trade"]) + wallet (["me"]) + owned/codex
 * pool (["players"] — shared by /deck·/codex). Exported so the invalidation contract is unit-
 * testable without a live network (task: 훅 invalidate).
 */
export const TRADE_INVALIDATE_KEYS = [["trade"], ["me"], ["players"]] as const;

export function invalidateAfterTrade(queryClient: Pick<QueryClient, "invalidateQueries">): void {
  for (const queryKey of TRADE_INVALIDATE_KEYS) {
    queryClient.invalidateQueries({ queryKey: queryKey as unknown as string[] });
  }
}

/** GET /api/trade — 3 slots (WAITING/OPEN-FA/OPEN-TRADE) + wallet. AC-D. */
export function useTradeSlots() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["trade"],
    queryFn: () => apiFetch<TradeSlotsResponse>("/api/trade"),
    enabled: Boolean(token),
  });
}

/** POST /api/trade/{slot}/speedup — shorten WAITING for points (402/400 handled by caller). */
export function useSpeedupTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slot: number) =>
      apiFetch<TradeSpeedupResponse>(`/api/trade/${slot}/speedup`, { method: "POST" }),
    onSuccess: () => invalidateAfterTrade(queryClient),
  });
}

/** POST /api/trade/{slot}/propose — FA offer (내 선수 + 포인트) → SUCCESS/FAIL (server roll). */
export function useProposeFa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slot, body }: { slot: number; body: FaProposeRequest }) =>
      apiFetch<TradeResolveResponse>(`/api/trade/${slot}/propose`, { method: "POST", body }),
    onSuccess: () => invalidateAfterTrade(queryClient),
  });
}

/** POST /api/trade/{slot}/accept — TRADE accept (내 선수 ↔ 대가) → SUCCESS/FAIL. */
export function useAcceptTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slot: number) =>
      apiFetch<TradeResolveResponse>(`/api/trade/${slot}/accept`, { method: "POST" }),
    onSuccess: () => invalidateAfterTrade(queryClient),
  });
}

/** POST /api/trade/{slot}/decline — TRADE decline → slot re-WAITING. */
export function useDeclineTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slot: number) =>
      apiFetch<TradeResolveResponse>(`/api/trade/${slot}/decline`, { method: "POST" }),
    onSuccess: () => invalidateAfterTrade(queryClient),
  });
}

/**
 * Build a save request that duplicates one slot's snapshot into another. Pure helper so the
 * duplicate flow is testable without the network (AC-B1 복제).
 */
export function duplicateRequest(source: TeamPresetSlot, copyName?: string): TeamSnapshotSaveRequest | null {
  if (!source.snapshot) return null;
  const snap = source.snapshot;
  return {
    name: copyName ?? `${source.name ?? "프리셋"} 복사`,
    formation: snap.formation,
    starters: snap.starters,
    bench: snap.bench,
    teamTactics: snap.teamTactics,
    teamPrompt: snap.teamPrompt ?? null,
  };
}
