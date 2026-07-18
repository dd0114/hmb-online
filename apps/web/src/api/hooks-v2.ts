/**
 * Phase-2 React Query hooks (team snapshots + match Phase2 fields). Kept separate from the
 * V1 `hooks.ts` barrel to mirror the 2-spec type split (schema.d.ts + schema-v2.d.ts).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type { Deck, MatchDetail } from "./hooks";
import type {
  FaProposeRequest,
  LeagueNextMatchResponse,
  LeagueResponse,
  MatchLogItem,
  RankingsResponse,
  RelationsResponse,
  TeamPresetSlot,
  TeamSnapshotSaveRequest,
  TradeLogItem,
  TradeResolveResponse,
  TradeSlotsResponse,
  TradeSpeedupResponse,
} from "./v2";
import type { MatchLogFilter } from "../logs/logs-logic";
import { matchLogQuery } from "../logs/logs-logic";

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

// ─────────────────────────── 로그·랭킹 (W4, AC-E) ───────────────────────────

/**
 * GET /api/logs/matches?mode&season — 경기 기록 리스트. 필터는 서버 쿼리(matchLogQuery)로 직렬화.
 * queryKey 에 필터를 담아 필터 변경 시 재조회한다.
 */
export function useMatchLogs(filter: MatchLogFilter) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["logs-matches", filter.mode, filter.season],
    queryFn: () => apiFetch<MatchLogItem[]>(`/api/logs/matches${matchLogQuery(filter)}`),
    enabled: Boolean(token),
  });
}

/** GET /api/logs/trades — 트레이드 이력(성공/실패/거절/만료 + 상세). AC-E3. */
export function useTradeLogs() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["logs-trades"],
    queryFn: () => apiFetch<TradeLogItem[]>("/api/logs/trades"),
    enabled: Boolean(token),
  });
}

/** GET /api/rankings — 리더보드 + 내 순위 + 개인 기록. AC-E2. */
export function useRankings() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["rankings"],
    queryFn: () => apiFetch<RankingsResponse>("/api/rankings"),
    enabled: Boolean(token),
  });
}

// ─────────────────────────── 리그 (W5, AC-F) ───────────────────────────

/** GET /api/league — 현재 시즌 상태·순위표·일정·다음 유저 경기. season=null 이면 시작 CTA. */
export function useLeague() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["league"],
    queryFn: () => apiFetch<LeagueResponse>("/api/league"),
    enabled: Boolean(token),
  });
}

/** POST /api/league/start — ACTIVE 시즌 없으면 생성(봇 9팀 + 18R 일정). FINISHED 뒤엔 다음 시즌. */
export function useStartLeague() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<LeagueResponse>("/api/league/start", { method: "POST" }),
    onSuccess: (res) => {
      queryClient.setQueryData(["league"], res);
    },
  });
}

/**
 * POST /api/league/next-match — 다음 SCHEDULED 유저 픽스처로 매치 생성(mode=league, 홈/어웨이 반영).
 * 반환 match 를 match 캐시에 시드해 /match/:id 진입 시 즉시 렌더되게 한다. league 캐시는 무효화
 * (직전 라운드 봇전 정산이 순위표에 반영되도록).
 */
export function useStartNextLeagueMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<LeagueNextMatchResponse>("/api/league/next-match", { method: "POST" }),
    onSuccess: (res) => {
      queryClient.setQueryData(["match", res.match.id], res.match as unknown as MatchDetail);
      queryClient.invalidateQueries({ queryKey: ["league"] });
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
