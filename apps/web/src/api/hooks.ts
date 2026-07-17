import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";
import { useToken } from "../auth/TokenContext";

export type MeResponse = components["schemas"]["MeResponse"];
export type ModeInfo = components["schemas"]["ModeInfo"];
export type CatalogPlayer = components["schemas"]["CatalogPlayer"];
export type Deck = components["schemas"]["Deck"];
export type DeckUpdateRequest = components["schemas"]["DeckUpdateRequest"];
export type PromptPreset = components["schemas"]["PromptPreset"];
export type PromptPresetCreateRequest = components["schemas"]["PromptPresetCreateRequest"];
export type GachaRequest = components["schemas"]["GachaRequest"];
export type GachaResponse = components["schemas"]["GachaResponse"];

/** GET /api/me — nickname/points/records header data (LLD-web §2 /lobby). */
export function useMe() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/api/me"),
    enabled: Boolean(token),
  });
}

/** GET /api/modes — mode select modal (싱글 available, 멀티 준비중 — D10). */
export function useModes(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["modes"],
    queryFn: () => apiFetch<ModeInfo[]>("/api/modes"),
    enabled: Boolean(token) && enabled,
  });
}

/** GET /api/players — full catalog (110) + owned flags. Shared by /deck and /codex. */
export function usePlayers() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["players"],
    queryFn: () => apiFetch<CatalogPlayer[]>("/api/players"),
    enabled: Boolean(token),
  });
}

/** GET /api/deck — active deck; 404 (no deck yet) resolves to null (empty deck state). */
export function useDeck() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["deck"],
    queryFn: async (): Promise<Deck | null> => {
      try {
        return await apiFetch<Deck>("/api/deck");
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: Boolean(token),
  });
}

/** PUT /api/deck — full replace (AC-S2). Caller handles 400 DECK_INVALID inline display. */
export function useUpdateDeck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DeckUpdateRequest) => apiFetch<Deck>("/api/deck", { method: "PUT", body }),
    onSuccess: (deck) => {
      queryClient.setQueryData(["deck"], deck);
    },
  });
}

/** GET /api/presets */
export function usePresets() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["presets"],
    queryFn: () => apiFetch<PromptPreset[]>("/api/presets"),
    enabled: Boolean(token),
  });
}

/** POST /api/presets */
export function useCreatePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PromptPresetCreateRequest) =>
      apiFetch<PromptPreset>("/api/presets", { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["presets"] });
    },
  });
}

/** DELETE /api/presets/:id — deck prompts already copied stay intact (AC-S4). */
export function useDeletePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/presets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["presets"] });
    },
  });
}

/** POST /api/shop/gacha — wallet + owned pool change together (AC-W3, AC-S8). */
export function useGacha() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GachaRequest) =>
      apiFetch<GachaResponse>("/api/shop/gacha", { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["players"] });
    },
  });
}
