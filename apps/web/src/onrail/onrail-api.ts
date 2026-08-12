/**
 * #493 W7-v3 — 온레일이 서버와 닿는 **유일한 자리**(얇은 클라이언트 계층).
 *
 * 서버 계약은 W6-v3(`5a2130cb`)이 확정한 그대로다. 새 경로는 하나도 없고 전부 기존 엔드포인트의
 * additive 필드다 — 그래서 여기서 하는 일은 "플래그를 붙이고, 실패를 읽고, 캐시를 무효화한다"뿐이다.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client";
import type { MatchDetail } from "../api/hooks";
import { usePendingChoices } from "../api/growth-hooks";

/** 튜토리얼 매치를 만들 수 없는 상태 — **둘 다 실패가 아니라 "일반 경기로 가라"** 는 뜻이다. */
const TUTORIAL_FALLBACK_CODES = new Set(["TUTORIAL_UNAVAILABLE", "TUTORIAL_ALREADY_PLAYED"]);

export function isTutorialFallback(err: unknown): boolean {
  return err instanceof ApiError && TUTORIAL_FALLBACK_CODES.has(err.code);
}

/**
 * 튜토리얼 고정 매치 시작 — `POST /api/matches {tutorial:true}`.
 *
 * ⚠️ **거절 두 종류를 실패로 다루지 않는다.** 배포에 구운 자산이 없거나(400
 * `TUTORIAL_UNAVAILABLE`) 이미 한 번 끝냈으면(409 `TUTORIAL_ALREADY_PLAYED`) 서버는 거절하는데,
 * 그때 온레일이 에러 토스트로 멈추면 유저는 **덱까지 다 짜 놓고 막다른 길**에 선다. 그래서 같은
 * 호출을 플래그 없이 한 번 더 보내 **일반 연습경기로 착지**한다 — 화면 투어는 그대로 돌아가고
 * 잃는 것은 "전 유저 동일 결과"뿐이다(그건 이 두 상황에서 애초에 성립하지 않는다).
 *
 * ⚠️ 덱 없음(400 `DECK_REQUIRED`)·진행 중(409 `MATCH_IN_PROGRESS`)은 **폴백 대상이 아니다** —
 * 호출부(`usePracticeStart` 규율)가 각각 안내 화면과 이어하기로 흡수한다.
 */
export function useStartTutorialMatch() {
  const queryClient = useQueryClient();
  return useMutation<MatchDetail, ApiError, void>({
    mutationFn: async () => {
      try {
        return await apiFetch<MatchDetail>("/api/matches", {
          method: "POST",
          body: { tutorial: true },
        });
      } catch (err) {
        if (!isTutorialFallback(err)) throw err;
        return await apiFetch<MatchDetail>("/api/matches", { method: "POST", body: {} });
      }
    },
    onSuccess: () => {
      // 매치가 생기면 잠금 게이트(#217)가 이 값을 본다 — 안 비우면 다음 화면이 옛 상태로 판단한다.
      queryClient.invalidateQueries({ queryKey: ["activeMatch"] });
    },
  });
}

/**
 * **스타터 고정 튜토리얼 카드**를 런타임에 찾아낸다 (S5 대상).
 *
 * ⚠️ **서버가 이 값을 안 알려 준다.** 카드 id 는 `hmb.tutorial.starter.card-id`(현재 `P122`)라는
 * **서버 설정**일 뿐 `/api/config` 에도 `/api/me` 에도 실려 오지 않고, 선수 DTO 에 표식도 없다.
 * 그래서 web 은 **가입 시 같이 심어 준 XP 프리필의 그림자**로 읽는다: 스타터 지급이 그 카드에
 * 정확히 하나의 3지선다를 대기시켜 두므로, 대기 중 선택권의 주인이 곧 그 카드다.
 *
 * ⚠️ **추론이지 계약이 아니다.** 유저가 다른 카드로 경기를 치러 선택권이 하나 더 생기면 순서가
 * 흔들릴 수 있고, 선택권을 이미 써 버렸으면 아예 못 찾는다. 그래서 못 찾은 경우가 정상 경로에
 * 포함돼 있고(각본의 `fallbackTestId`), 이 자리는 **서버가 카드 id 를 공개해 주면 한 줄로
 * 대체된다** — W8-v3 로 올릴 요청이다(`/api/config` 에 `tutorial.starterCardId`).
 */
export function useTutorialCard(enabled: boolean): string | null {
  const choices = usePendingChoices(undefined, enabled);
  if (!enabled) return null;
  const list = choices.data;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0]?.playerId ?? null;
}
