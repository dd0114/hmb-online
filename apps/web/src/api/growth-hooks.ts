/**
 * 성장 시스템 v2 React Query 훅 (에픽 #179 GM3 — 메이플 피벗). apiFetch 사용, 성공 시 관련 쿼리
 * (카드·players·me/wallet) invalidate. 서버 계약:
 *   GET  /api/growth/card/{playerId}   → CardEffective
 *   POST /api/growth/star {playerId}   → StarUpResult (재료 부족 4xx INSUFFICIENT_MATERIALS)
 *   POST /api/growth/dice {playerId,kind} → DiceRollResult (잔액 부족 4xx INSUFFICIENT_POINTS/GEMS)
 *   GET  /api/growth/report/{matchId}  → MatchGrowthReport
 * 구 useEnhance/useLimitBreak(강화·한계돌파)는 폐기 — 이 훅은 존재하지 않는다.
 * 구 useDiceBalance/useBuyDice(다이스 재고·구매)도 **#247 로 폐기** — 재고 개념 자체가 없어졌다.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type {
  CardEffective,
  DiceRollResult,
  GemTopupResult,
  MatchGrowthReport,
  StarUpResult,
} from "./growth";

/** 성장 카드 상세 쿼리 키(승급/롤 후 이 키를 무효화해 상세를 갱신). */
export const growthCardKey = (playerId: string) => ["growthCard", playerId] as const;

/** GET /api/growth/card/{playerId} — 카드 상세. owned 카드에서만 호출. */
export function useCardEffective(playerId: string | undefined) {
  const { token } = useToken();
  return useQuery({
    queryKey: playerId ? growthCardKey(playerId) : ["growthCard", undefined],
    queryFn: () => apiFetch<CardEffective>(`/api/growth/card/${playerId}`),
    enabled: Boolean(token) && Boolean(playerId),
  });
}

function invalidateCard(queryClient: QueryClient, playerId: string): void {
  queryClient.invalidateQueries({ queryKey: growthCardKey(playerId) });
  queryClient.invalidateQueries({ queryKey: ["players"] });
}

/** POST /api/growth/star — 성★ 승급(중복 소모). 부족 시 ApiError(4xx, INSUFFICIENT_MATERIALS). */
export function useStarUp() {
  const queryClient = useQueryClient();
  return useMutation<StarUpResult, ApiError, string>({
    mutationFn: (playerId: string) =>
      apiFetch<StarUpResult>("/api/growth/star", { method: "POST", body: { playerId } }),
    onSuccess: (res) => invalidateCard(queryClient, res.playerId),
  });
}

/**
 * POST /api/growth/dice — 잠재 리롤. **구매 단계 없이 지갑에서 직접 결제**한다(#247).
 * 잔액 부족은 4xx `INSUFFICIENT_POINTS`/`INSUFFICIENT_GEMS`(구 `INSUFFICIENT_DICE` 는 재고와 함께 소멸).
 *
 * 성공 시 `["me"]` 를 무효화해 헤더 지갑이 따라온다 — 롤이 재화를 쓰는 행위가 됐으므로
 * 지갑 갱신을 빠뜨리면 화면이 방금 쓴 돈을 계속 보여준다.
 */
export function useDiceRoll() {
  const queryClient = useQueryClient();
  return useMutation<DiceRollResult, ApiError, { playerId: string; kind: "NORMAL" | "CASH" }>({
    mutationFn: (body) => apiFetch<DiceRollResult>("/api/growth/dice", { method: "POST", body }),
    onSuccess: (res) => {
      invalidateCard(queryClient, res.playerId);
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/**
 * POST /api/shop/gems/topup — 젬 충전(목업, V2.2 §스펙). 실결제 없음, 즉시 지급.
 * 성공 시 지갑(me) invalidate — points 와 동일하게 서버 응답이 최종 권위.
 */
export function useGemTopup() {
  const queryClient = useQueryClient();
  return useMutation<GemTopupResult, ApiError, { packId: string }>({
    mutationFn: (body) =>
      apiFetch<GemTopupResult>("/api/shop/gems/topup", { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
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
