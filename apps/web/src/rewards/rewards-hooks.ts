/**
 * 보상 봉투 훅 (#405 §2.9).
 *
 * 조회 엔드포인트는 **없다** — 봉투는 그것을 만든 화면(`GET /api/matches/{id}/result`)에
 * additive 블록으로 실려 온다(#368 선례). 별도 GET 을 두면 결과 화면에서 왕복이 두 번이 된다.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client";
import type { RewardBundle } from "./types";

/**
 * POST /api/rewards/{bundleId}/ack — 확인 처리(**멱등**, 이미 확인이면 그대로 200).
 *
 * ⚠️ 성공 시 `["matchResult", …]` 를 무효화한다 — 그 응답 안의 `rewardBundle.acknowledgedAt` 이
 * 곧 "다시 띄울까"의 판정이라(`shouldShowRewardSheet`), 갱신하지 않으면 화면을 다시 열 때
 * 확인한 봉투가 또 올라온다.
 *
 * ⚠️ **실패해도 화면은 진행시킨다**(호출부 책임). 확인은 서버 상태를 정리하는 행위지 유저가
 * 결과를 보기 위한 관문이 아니다 — 네트워크가 한 번 흔들렸다고 결과 화면에 못 가면 안 된다.
 */
export function useAckReward() {
  const queryClient = useQueryClient();
  return useMutation<RewardBundle, ApiError, string>({
    mutationFn: (bundleId: string) =>
      apiFetch<RewardBundle>(`/api/rewards/${bundleId}/ack`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["matchResult"] });
    },
  });
}
