/**
 * 우편 운영 훅 (#323 W4) — admin 전용. 유저 훅(`mail-hooks.ts`)과 파일을 나눈 이유는
 * `notice-hooks` 와 같다: 운영 표면과 유저 표면이 한 파일에 섞이면 어느 쪽이 게이트 뒤인지가
 * 코드에서 안 보인다.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { MailSendRequestBody } from "../admin/mail-admin-logic";

export const ADMIN_MAILS_PATH = "/api/admin/mails";
export const ADMIN_MAILS_HISTORY_PATH = "/api/admin/mails/history";

/** 발송 이력 + 수령 통계. 반환이 `unknown` 인 이유 = 호출부가 정규화를 통과하게 강제(흰 화면 방지). */
export function useAdminMails() {
  return useQuery<unknown>({
    queryKey: ["admin", "mails"],
    queryFn: () => apiFetch<unknown>(ADMIN_MAILS_PATH),
    retry: false,
    staleTime: 10_000,
  });
}

/** 운영 액션 이력(성공·실패 모두). */
export function useAdminMailHistory() {
  return useQuery<unknown>({
    queryKey: ["admin", "mails", "history"],
    queryFn: () => apiFetch<unknown>(ADMIN_MAILS_HISTORY_PATH),
    retry: false,
    staleTime: 10_000,
  });
}

export function useMailOps() {
  const queryClient = useQueryClient();
  // ⚠️ **성공·실패를 가리지 않고**(onSettled) 무효화한다 — 409/400 은 "화면이 낡았다"는 신호이기도
  // 하다(같은 키가 이미 쓰였다 = 목록에 그 캠페인이 있다). 실패했을 때 목록을 안 고치면 운영자가
  // 낡은 화면을 보고 같은 실수를 반복한다.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  /**
   * 발송. **멱등키를 클라가 만든다** — 서버가 채번하면 그 요청은 재전송 보호를 받지 못한다.
   * 폼 제출마다 새 키를 만들고, 같은 제출의 재시도(네트워크 실패 후 [다시])는 **같은 키**를 쓴다.
   */
  const send = useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: MailSendRequestBody; idempotencyKey: string }) =>
      apiFetch<unknown>(ADMIN_MAILS_PATH, {
        method: "POST",
        body,
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    onSettled: invalidate,
  });

  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<unknown>(`${ADMIN_MAILS_PATH}/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        body: { reason },
      }),
    onSettled: invalidate,
  });

  return { send, revoke };
}
