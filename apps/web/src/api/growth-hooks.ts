/**
 * 성장 시스템 v2 React Query 훅 (에픽 #179 GM3 — 메이플 피벗). apiFetch 사용, 성공 시 관련 쿼리
 * (카드·players·me/wallet·다이스 잔고) invalidate. 서버 계약 = §V2-4:
 *   GET  /api/growth/card/{playerId}   → CardEffective
 *   POST /api/growth/star {playerId}   → StarUpResult (재료 부족 4xx INSUFFICIENT_MATERIALS)
 *   POST /api/growth/dice {playerId,kind} → DiceRollResult (다이스 부족 4xx)
 *   POST /api/shop/dice {kind,count}   → DiceBuyResult
 *   GET  /api/growth/report/{matchId}  → MatchGrowthReport
 * 구 useEnhance/useLimitBreak(강화·한계돌파)는 폐기 — 이 훅은 존재하지 않는다.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type {
  CardEffective,
  DiceBuyResult,
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
 * 다이스 보유 개수 — 세션 로컬 파생치.
 * ⚠️ 계약 갭: §V2-4 API 표에 다이스 인벤토리 GET 이 없다(GET card·POST star·POST dice·
 * POST shop/dice·GET report 5개뿐). 그래서 신규 유저 기본값 0 에서 시작해 구매(useBuyDice)·
 * 롤(useDiceRoll) 응답으로만 이 쿼리 캐시를 갱신한다 — **새로고침하면 0 으로 리셋**(세션 내에서만
 * 정확). 크로스세션 정확도가 필요하면 GM2 에 MeResponse.wallet 확장 또는 전용 GET 이슈 레이즈.
 */
export interface DiceBalance {
  normal: number;
  cash: number;
}
const DEFAULT_DICE_BALANCE: DiceBalance = { normal: 0, cash: 0 };
export const diceBalanceKey = ["diceBalance"] as const;

/** GET /api/growth/dice — 서버 보유 잔액. 새로고침에도 유지(GM2 계약 확정, DiceBalance). */
export function useDiceBalance() {
  return useQuery({
    queryKey: diceBalanceKey,
    queryFn: () => apiFetch<DiceBalance>("/api/growth/dice"),
    placeholderData: DEFAULT_DICE_BALANCE,
  });
}

/** POST /api/growth/dice — 잠재 리롤(줄 갱신 + 노말 다이스만 티어업 가능). 부족 시 ApiError(4xx). */
export function useDiceRoll() {
  const queryClient = useQueryClient();
  return useMutation<DiceRollResult, ApiError, { playerId: string; kind: "NORMAL" | "CASH" }>({
    mutationFn: (body) => apiFetch<DiceRollResult>("/api/growth/dice", { method: "POST", body }),
    onSuccess: (res) => {
      invalidateCard(queryClient, res.playerId);
      queryClient.setQueryData<DiceBalance>(diceBalanceKey, (prev) => {
        const base = prev ?? DEFAULT_DICE_BALANCE;
        return res.kind === "NORMAL" ? { ...base, normal: res.diceLeft } : { ...base, cash: res.diceLeft };
      });
    },
  });
}

/** POST /api/shop/dice — 다이스 구매(포인트 소모). 지갑·다이스 잔고 함께 갱신. */
export function useBuyDice() {
  const queryClient = useQueryClient();
  return useMutation<DiceBuyResult, ApiError, { kind: "NORMAL" | "CASH"; count: number }>({
    mutationFn: (body) => apiFetch<DiceBuyResult>("/api/shop/dice", { method: "POST", body }),
    onSuccess: (res) => {
      queryClient.setQueryData<DiceBalance>(diceBalanceKey, res.dice);
      queryClient.invalidateQueries({ queryKey: ["me"] }); // wallet.points 반영
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
