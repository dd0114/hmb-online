/**
 * 우편함 훅 (#323). TanStack Query 만 사용(전역 스토어 없음 — 프로젝트 규칙).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import {
  MAILS_PATH,
  mailClaimPath,
  mailReadPath,
  type MailClaimResult,
} from "./mails";

export const MAILS_QUERY_KEY = ["mails"] as const;

/**
 * `GET /api/mails` — **인증 필요**(공지와 다른 축이다: 우편함은 정의상 내 것).
 *
 * 반환 타입이 `unknown` 인 것은 공지 훅과 같은 이유다 — 호출부가 반드시 `normalizeMails` 를
 * 통과하게 해서, 구 서버·프록시의 200 `{}` 하나가 홈 헤더를 통째로 흰 화면으로 만들지 못하게 한다
 * (#245 가 로비에서 실제로 그렇게 당했고, 홈은 이제 앱 진입점이다).
 */
export function useMails() {
  const { token } = useToken();
  return useQuery<unknown>({
    queryKey: MAILS_QUERY_KEY,
    queryFn: () => apiFetch<unknown>(MAILS_PATH),
    enabled: Boolean(token),
    // 실패는 "우편함 진입점 없음"이면 충분하다 — 재시도로 홈 진입을 붙잡지 않는다.
    retry: false,
    staleTime: 30_000,
  });
}

/** `POST /api/mails/{id}/read` — 상세를 펼칠 때. 멱등이라 실패해도 화면을 막지 않는다. */
export function useReadMail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<unknown>(mailReadPath(id), { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MAILS_QUERY_KEY });
      // 뱃지는 /api/me 에도 실린다(홈 헤더) — 읽음이 반영되게 같이 무효화한다.
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/**
 * `POST /api/mails/{id}/claim`.
 *
 * ⚠️ 성공 시 **지갑 표시가 붙은 것들을 전부 무효화**한다 — 수령은 G·Z·보유 선수를 동시에
 * 움직이므로 하나만 새로고침하면 헤더 잔액과 실제가 어긋난 화면이 남는다.
 */
export function useClaimMail() {
  const queryClient = useQueryClient();
  return useMutation<MailClaimResult, Error, string>({
    mutationFn: (id: string) => apiFetch<MailClaimResult>(mailClaimPath(id), { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MAILS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["players"] });
    },
  });
}
