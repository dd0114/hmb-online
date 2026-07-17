import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";
import { useToken } from "../auth/TokenContext";
import { shouldPoll } from "../match/match-logic";

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

// ── match flow (LLD-web §2 /match/:id) ─────────────────────────────────

export type MatchDetail = components["schemas"]["MatchDetail"];
export type MatchResult = components["schemas"]["MatchResult"];
export type MatchLog = components["schemas"]["MatchLog"];
export type MatchPromptRequest = components["schemas"]["MatchPromptRequest"];
export type HalftimeRequest = components["schemas"]["HalftimeRequest"];
export type CreateMatchRequest = components["schemas"]["CreateMatchRequest"];

/**
 * GET /api/matches/:id — 3s polling ONLY while the server is generating (GEN1/GEN2);
 * interactive/terminal states stop the interval (LLD-web §2, AC-W4).
 */
export function useMatch(id: string | undefined) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["match", id],
    queryFn: () => apiFetch<MatchDetail>(`/api/matches/${id}`),
    enabled: Boolean(token) && Boolean(id),
    refetchInterval: (query) => (shouldPoll(query.state.data?.state) ? 3000 : false),
  });
}

/** POST /api/matches — 봇 매칭 + 덱 스냅샷, state=BRIEFING (400 DECK_INVALID if deck invalid). */
export function useCreateMatch() {
  return useMutation({
    mutationFn: (body: CreateMatchRequest = {}) =>
      apiFetch<MatchDetail>("/api/matches", { method: "POST", body }),
  });
}

/** POST /api/matches/:id/prompts — UPSERT per (phase, scope, playerId). */
export function useSubmitMatchPrompt(id: string) {
  return useMutation({
    mutationFn: (body: MatchPromptRequest) =>
      apiFetch<MatchDetail>(`/api/matches/${id}/prompts`, { method: "POST", body }),
  });
}

function useMatchAction(id: string, action: "kickoff" | "resume" | "retry") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<MatchDetail>(`/api/matches/${id}/${action}`, { method: "POST" }),
    onSuccess: (match) => {
      queryClient.setQueryData(["match", id], match);
    },
  });
}

/** POST /api/matches/:id/kickoff — BRIEFING → GEN1. */
export function useKickoff(id: string) {
  return useMatchAction(id, "kickoff");
}

/** POST /api/matches/:id/resume — H1_BREAK → GEN2. */
export function useResume(id: string) {
  return useMatchAction(id, "resume");
}

/** POST /api/matches/:id/retry — FAILED → 직전 GEN* 복귀 (AC-M7). */
export function useRetry(id: string) {
  return useMatchAction(id, "retry");
}

/** POST /api/matches/:id/halftime — 교체 저장 (≤3, 벤치→선발, AC-M4). 전이 없음. */
export function useHalftime(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: HalftimeRequest) =>
      apiFetch<MatchDetail>(`/api/matches/${id}/halftime`, { method: "POST", body }),
    onSuccess: (match) => {
      queryClient.setQueryData(["match", id], match);
    },
  });
}

/** GET /api/matches/:id/halves/:n/log — 수 MB 가능, 캐시 영구(staleTime ∞, LLD-web §3). */
export function useHalfLog(id: string | undefined, half: 1 | 2, enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["matchLog", id, half],
    queryFn: () => apiFetch<MatchLog>(`/api/matches/${id}/halves/${half}/log`),
    enabled: Boolean(token) && Boolean(id) && enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** GET /api/matches/:id/result — FINISHED에서만 의미 (보상 멱등, AC-M6). */
export function useMatchResult(id: string | undefined, enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["matchResult", id],
    queryFn: () => apiFetch<MatchResult>(`/api/matches/${id}/result`),
    enabled: Boolean(token) && Boolean(id) && enabled,
    staleTime: Infinity,
  });
}
