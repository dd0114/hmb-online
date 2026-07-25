/**
 * 성장/강화 React Query 훅 (에픽 #179 G4). apiFetch 사용, 성공 시 관련 쿼리(카드·players·me/wallet)
 * invalidate. 서버 계약 = G2 노출 API(issue §6):
 *   GET  /api/growth/card/{playerId}      → CardEffective
 *   POST /api/growth/enhance {playerId}   → EnhanceResult (상한 시 4xx ENHANCE_MAX)
 *   POST /api/growth/limitbreak {playerId}→ EnhanceResult {promoted}
 *   GET  /api/growth/report/{matchId}     → MatchGrowthReport
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type { CardEffective, EnhanceResult, MatchGrowthReport } from "./growth";

/** 성장 카드 상세 쿼리 키(강화/돌파 후 이 키를 무효화해 상세를 갱신). */
export const growthCardKey = (playerId: string) => ["growthCard", playerId] as const;

/** GET /api/growth/card/{playerId} — 카드 상세(시안3). owned 카드에서만 호출. */
export function useCardEffective(playerId: string | undefined) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["growthCard", playerId],
    queryFn: () => apiFetch<CardEffective>(`/api/growth/card/${playerId}`),
    enabled: Boolean(token) && Boolean(playerId),
  });
}

/** 강화/돌파 공통 무효화 — 상세 카드 + 카탈로그(그리드 요약) + 지갑(포인트 차감). */
function invalidateGrowth(
  queryClient: ReturnType<typeof useQueryClient>,
  playerId: string,
): void {
  queryClient.invalidateQueries({ queryKey: growthCardKey(playerId) });
  queryClient.invalidateQueries({ queryKey: ["players"] });
  queryClient.invalidateQueries({ queryKey: ["me"] });
}

/** POST /api/growth/enhance — 천장↑(과금). 상한 도달 시 ApiError(status 4xx, code ENHANCE_MAX). */
export function useEnhance() {
  const queryClient = useQueryClient();
  return useMutation<EnhanceResult, ApiError, string>({
    mutationFn: (playerId: string) =>
      apiFetch<EnhanceResult>("/api/growth/enhance", { method: "POST", body: { playerId } }),
    onSuccess: (res) => invalidateGrowth(queryClient, res.playerId),
  });
}

/** POST /api/growth/limitbreak — 등급 개방(중복 소모). promoted=true 면 프레임색 전환. */
export function useLimitBreak() {
  const queryClient = useQueryClient();
  return useMutation<EnhanceResult, ApiError, string>({
    mutationFn: (playerId: string) =>
      apiFetch<EnhanceResult>("/api/growth/limitbreak", { method: "POST", body: { playerId } }),
    onSuccess: (res) => invalidateGrowth(queryClient, res.playerId),
  });
}

/**
 * GET /api/growth/report/{matchId} — 성장 리포트(S1). 404(리포트 없음)는 null 로 흡수해
 * ResultPage 가 섹션을 숨긴다. 결과는 불변(멱등 정산) — 영구 캐시.
 */
export function useMatchGrowthReport(matchId: string | undefined, enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["growthReport", matchId],
    queryFn: async (): Promise<MatchGrowthReport | null> => {
      try {
        return await apiFetch<MatchGrowthReport>(`/api/growth/report/${matchId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: Boolean(token) && Boolean(matchId) && enabled,
    staleTime: Infinity,
  });
}
