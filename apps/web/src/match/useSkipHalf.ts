import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { MatchDetail } from "../api/hooks";
import { isAlreadyAdvanced, type SkipPhase } from "./skip-mode";

/**
 * `POST /api/matches/:id/skip` — 경기 스킵(#421 W1 서버 계약).
 *
 * 서버는 새 전이를 만들지 않는다: 재생 창(`phase_ends_at`)을 지금으로 **당기고** 그 자리에서 기존
 * 만료 전이를 밟는다. 그래서 응답은 **전이 후** MatchDetail 이다 — 전반 스킵이면 `HALFTIME`
 * (오토 #249 면 같은 체인으로 `SECOND_HALF` 까지), 후반 스킵이면 `FINISHED` + 정산 완료.
 *
 * ⚠️ **낙관적 갱신을 하지 않는다**(`useSetAuto` 와 같은 이유). 이 요청은 서버 흐름을 바꾸는
 * 스위치라, 실패했는데 화면만 먼저 넘어가면 유저는 감독시간이 온 줄 알고 자리를 뜬다.
 * 응답이 SoT 고, 응답을 받은 뒤에만 화면이 움직인다.
 *
 * ⚠️ **`phase` 는 CAS 키다** — 지금 도는 단계와 다르면 409. 그건 실패가 아니라 "이미 넘어갔다"는
 * 사실의 통지라(`skip-mode.isAlreadyAdvanced`) 에러 토스트 대신 **매치를 다시 묻는다**.
 */
export function useSkipHalf(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phase: SkipPhase) =>
      apiFetch<MatchDetail>(`/api/matches/${id}/skip`, { method: "POST", body: { phase } }),
    onSuccess: (match) => {
      queryClient.setQueryData(["match", id], match);
    },
    onError: (err) => {
      // 409 = 스위퍼·오토·다른 탭이 같은 경계를 먼저 밟았다. 화면이 낡았을 뿐이니 따라간다.
      if (isAlreadyAdvanced(err)) queryClient.invalidateQueries({ queryKey: ["match", id] });
    },
    onSettled: () => {
      // 후반 스킵은 그 자리에서 경기를 끝낸다 = **잠금이 풀린다**(#217). 캐시가 유령 잠금을
      // 들고 있으면 로비로 못 나간다 — 성공·실패 모두 다시 묻는다.
      queryClient.invalidateQueries({ queryKey: ["activeMatch"] });
    },
  });
}
