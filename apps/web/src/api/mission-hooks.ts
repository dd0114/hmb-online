/**
 * 원정 데일리 미션 훅 (#408). TanStack Query 만 사용(전역 스토어 없음 — 프로젝트 규칙).
 *
 * 계약 SoT = `docs/plan-v5/away-daily-mission.md` §8 + 구현
 * (`server-java/.../mission/MissionController.java` · `MissionService.{DailyView,ClaimResult,MissionView}`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";

export const MISSIONS_QUERY_KEY = ["missions", "daily"] as const;

export const MISSIONS_DAILY_PATH = "/api/missions/daily";
export const missionClaimPath = (id: string) => `/api/missions/${encodeURIComponent(id)}/claim`;
export const missionRerollPath = (id: string) => `/api/missions/${encodeURIComponent(id)}/reroll`;

/** `POST /api/missions/{id}/claim` 응답 — 재화와 금액은 항상 같이 온다(#232). */
export interface MissionClaimResult {
  claimed: { currency: string; amount: number };
  wallet: { points: number; gems: number };
}

/**
 * `GET /api/missions/daily` — **인증 필요**(우편함과 같은 축: 정의상 내 것).
 *
 * 반환 타입이 `unknown` 인 것은 우편함 훅과 같은 이유다 — 호출부가 반드시 `pickDailyMissions` /
 * `claimableSummary` 를 통과하게 해서, 구 서버·프록시의 200 `{}` 하나가 원정 화면이나 홈을
 * 흰 화면으로 만들지 못하게 한다.
 *
 * ⚠️ `retry: false` — 구 서버엔 이 라우트가 **없다**(404). 재시도해도 404 이고, 그 부재는
 * 정상 상태다(소비 화면이 섹션을 통째로 안 그린다).
 */
export function useDailyMissions(enabled = true) {
  const { token } = useToken();
  return useQuery<unknown>({
    queryKey: MISSIONS_QUERY_KEY,
    queryFn: () => apiFetch<unknown>(MISSIONS_DAILY_PATH),
    enabled: Boolean(token) && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * `POST /api/missions/{id}/claim`.
 *
 * ⚠️ **지갑이 움직이므로 `["me"]` 를 반드시 무효화한다**(가챠·우편함 선례). 안 하면 헤더 잔액과
 * 실제가 어긋난 화면이 남고, 유저는 다이아가 들어왔는지 확인할 방법이 없다.
 * 실패(409)에도 미션 목록은 무효화한다 — 409 는 "화면이 낡았다"는 신호다(다른 탭에서 이미 받음 등).
 */
export function useClaimMission() {
  const queryClient = useQueryClient();
  return useMutation<MissionClaimResult, Error, string>({
    mutationFn: (id: string) => apiFetch<MissionClaimResult>(missionClaimPath(id), { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY });
    },
  });
}

/**
 * `POST /api/missions/{id}/reroll` — 미션 교체(진행도 0 으로 초기화).
 *
 * 지갑은 움직이지 않는다(무료). 성공·실패 **모두** 목록을 무효화한다 — 실패가 화면에서
 * 사라지면 유저가 같은 버튼을 계속 누른다.
 */
export function useRerollMission() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id: string) => apiFetch<unknown>(missionRerollPath(id), { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY });
    },
  });
}

/**
 * 미션 실패 문구. **서버 코드마다 다른 말을 해야** 유저가 다음 행동을 고른다(복수 큐 선례) —
 * 하나로 합치면 "왜 안 되지"에서 멈춘다.
 *
 * ⚠️ `MISSION_NOT_COMPLETED` 의 진행도는 **서버 detail 을 인용**한다. 화면이 들고 있는 값은
 * 이미 낡아서 그 409 가 난 것이므로, 클라의 `progress/target` 을 다시 붙이면 거짓말이 된다.
 */
export function missionError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "MISSION_ALREADY_CLAIMED":
        return "이미 받은 보상입니다";
      case "MISSION_NOT_COMPLETED": {
        const d = err.detail ?? {};
        const p = d.progress;
        const t = d.target;
        return typeof p === "number" && typeof t === "number"
          ? `아직 달성하지 못했습니다 (${p} / ${t})`
          : "아직 달성하지 못했습니다";
      }
      case "MISSION_REROLL_USED":
        return "이 미션은 이미 다시 뽑았습니다";
      case "MISSION_ALREADY_COMPLETED":
        return "달성한 미션은 다시 뽑을 수 없습니다";
      case "MISSION_REROLL_UNAVAILABLE":
        return "지금은 바꿀 미션이 없습니다";
      case "MISSION_EXPIRED":
        return "지난 날짜의 미션입니다 — 받기만 할 수 있습니다";
      case "NOT_FOUND":
        return "미션을 찾을 수 없습니다";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "처리하지 못했습니다";
}
