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
  ChoiceResult,
  DiceRollResult,
  GemTopupResult,
  MatchGrowthReport,
  PendingChoice,
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

/** 대기 중 선택권 쿼리 키. 전체(홈 뱃지)와 카드별(강화탭)이 **다른 키**다. */
export const growthChoicesKey = (playerId?: string) =>
  ["growthChoices", playerId ?? null] as const;

/**
 * GET /api/growth/choices[?playerId=] — **아직 안 고른** 선택권 목록 (#405 §2.5).
 *
 * ⚠️ 보상 봉투 안의 `pendingChoices` 는 **정산 시점 스냅샷**이라 유저가 고른 뒤에도 그대로다
 * (서버가 봉투를 되쓰지 않는다 — 봉투는 "그때 무슨 일이 있었나"의 기록이다). 그래서 "지금
 * 무엇이 남았나"는 **이 쿼리**가 답한다. 둘을 섞으면 이미 고른 선택이 뱃지에 영원히 남는다.
 */
export function usePendingChoices(playerId?: string, enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: growthChoicesKey(playerId),
    queryFn: async (): Promise<PendingChoice[]> => {
      const q = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
      const res = await apiFetch<{ choices?: unknown }>(`/api/growth/choices${q}`);
      // 구 서버·목이 `{}` 를 줄 수 있다. 배열이 아니면 빈 목록 — 화면 전체를 죽이지 않는다.
      return Array.isArray(res?.choices) ? (res.choices as PendingChoice[]) : [];
    },
    enabled: Boolean(token) && enabled,
    retry: false,
  });
}

/**
 * POST /api/growth/choices/{choiceId} — 3지선다 적용.
 *
 * **응답에 갱신된 카드가 실려 온다** → 그대로 캐시에 넣는다(재조회 금지, `ChoiceResult` 주석).
 * 대기 목록은 전체·카드별 두 키가 있으므로 접두사로 한꺼번에 무효화한다.
 *
 * 에러 3종은 화면이 갈라 처리한다(문구를 하나로 합치면 유저가 다음 행동을 못 고른다):
 *  · 400 `VALIDATION_ERROR`(후보 밖) · 404(남의/없는 선택권) · 409 `CHOICE_ALREADY_MADE`
 *  · **409 `MATCH_IN_PROGRESS`** — 토스트가 아니라 `detail.matchId` 로 **이어하기 안내**(#217).
 */
export function useApplyChoice() {
  const queryClient = useQueryClient();
  return useMutation<ChoiceResult, ApiError, { choiceId: string; stat: string }>({
    mutationFn: ({ choiceId, stat }) =>
      apiFetch<ChoiceResult>(`/api/growth/choices/${choiceId}`, { method: "POST", body: { stat } }),
    onSuccess: (res) => {
      if (res?.card) queryClient.setQueryData(growthCardKey(res.playerId), res.card);
      queryClient.invalidateQueries({ queryKey: ["growthChoices"] });
      queryClient.invalidateQueries({ queryKey: ["players"] });
    },
    // 실패해도 목록을 새로 받는다 — 409(이미 선택)는 "내 목록이 낡았다"는 뜻이라 갱신이 곧 해소다.
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["growthChoices"] });
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
