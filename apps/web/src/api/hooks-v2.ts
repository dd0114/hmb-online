/**
 * Phase-2 React Query hooks (team snapshots + match Phase2 fields). Kept separate from the
 * V1 `hooks.ts` barrel to mirror the 2-spec type split (schema.d.ts + schema-v2.d.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type { Deck } from "./hooks";
import type {
  TeamPresetSlot,
  TeamSnapshotSaveRequest,
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
