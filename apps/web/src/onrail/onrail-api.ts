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
import { useAppConfigValue } from "../common/AppConfigContext";
import { tutorialCardIdFrom } from "./onrail-logic";

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
 * **스타터 고정 튜토리얼 카드** (S5 대상) — **서버가 알려 준다**(#493 W9).
 *
 * W7-v3 는 이 값을 추론했다: `hmb.tutorial.starter.card-id`(현재 `P122`)가 서버 설정일 뿐
 * `/api/config` 에도 `/api/me` 에도 안 실려서, "가입 지급이 그 카드에 대기시켜 둔 3지선다"의
 * 주인을 그 카드로 읽었다. 그 자리에 *"서버가 공개해 주면 한 줄로 대체된다"* 고 적어 뒀고,
 * W9 서버 소웨이브가 `/api/config.tutorial.starterCardId` 를 additive 로 열면서 그렇게 됐다.
 *
 * ⚠️ **추론 가지는 남는다.** 필드를 모르는 서버에 web 이 먼저 나가는 창이 항상 있다(#286 W5 와
 * 같은 규율) — 그때 값은 `undefined` 이고, 폴백이 없으면 S5 안내가 통째로 그리드로 내려앉는다.
 * 판정은 `tutorialCardIdFrom`(순수) 이 소유한다.
 *
 * ⚠️ **필드가 있으면 3지선다 조회를 걸지 않는다** — 그 왕복은 오직 추론을 위한 것이었다.
 */
export function useTutorialCard(enabled: boolean): string | null {
  const config = useAppConfigValue();
  const declared = config?.tutorial?.starterCardId ?? null;
  const choices = usePendingChoices(undefined, enabled && !declared);
  if (!enabled) return null;
  return tutorialCardIdFrom(declared, choices.data);
}
