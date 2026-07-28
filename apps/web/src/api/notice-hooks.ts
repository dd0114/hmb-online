/**
 * 공지사항 훅 (#248). TanStack Query 만 사용(전역 스토어 없음 — 프로젝트 규칙).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import {
  ADMIN_NOTICES_HISTORY_PATH,
  ADMIN_NOTICES_PATH,
  NOTICES_ACTIVE_PATH,
  type AdminNoticeAuditEntry,
  type AdminNoticeListResponse,
  type NoticeActiveRequest,
  type NoticeCreateRequest,
  type NoticeUpdateRequest,
} from "./notices";

/**
 * `GET /api/notices/active` — **공개 엔드포인트**(hero Q5).
 *
 * ⚠️ `enabled` 를 토큰에 걸지 않는다. 점검 공지는 **로그인이 안 될 때 가장 필요하다** —
 * 인증 유무로 조회를 막으면 그 상황에서 정확히 침묵한다(#232 BL-1 과 같은 결).
 *
 * 반환 타입이 `unknown` 인 것도 의도다: 호출부는 반드시 `visibleNotices` 를 통과시켜야 하고,
 * 타입으로 `.notices.length` 를 허락하면 구 서버의 `{}` 하나가 로비를 흰 화면으로 만든다.
 */
export function useActiveNotices() {
  return useQuery<unknown>({
    queryKey: ["notices", "active"],
    queryFn: () => apiFetch<unknown>(NOTICES_ACTIVE_PATH),
    // 실패는 "팝업 없음"이면 충분하다 — 재시도로 로비 진입을 붙잡지 않는다.
    retry: false,
    staleTime: 60_000,
  });
}

/** GET /api/admin/notices — 중지·만료·삭제 포함 전체 + 서버 판정 상태. */
export function useAdminNotices(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery<AdminNoticeListResponse>({
    queryKey: ["admin", "notices"],
    queryFn: () => apiFetch<AdminNoticeListResponse>(ADMIN_NOTICES_PATH),
    enabled: Boolean(token) && enabled,
  });
}

/** GET /api/admin/notices/history — 공지 액션 감사 이력(성공·실패 모두). */
export function useAdminNoticeHistory(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery<AdminNoticeAuditEntry[]>({
    queryKey: ["admin", "notices", "history"],
    queryFn: () => apiFetch<AdminNoticeAuditEntry[]>(ADMIN_NOTICES_HISTORY_PATH),
    enabled: Boolean(token) && enabled,
  });
}

/**
 * 공지 운영 액션 4종. 넷 다 **성공·실패 가리지 않고**(`onSettled`) 캐시를 무효화한다.
 *
 * 성공에만 무효화하면 **실패가 화면에서 사라진다** — 서버는 실패도 원장에 남기는데(그게 "왜
 * 반영이 안 됐나"의 답이다) 화면은 새로고침해야만 보게 된다(#209 economy 와 같은 규율).
 * 유저 팝업 쿼리(`["notices"]`)도 같이 털어 admin 이 만든 공지를 그 탭에서 바로 확인할 수 있게 한다.
 */
export function useNoticeOps() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    void queryClient.invalidateQueries({ queryKey: ["notices"] });
  };

  const create = useMutation({
    mutationFn: (body: NoticeCreateRequest) =>
      apiFetch<unknown>(ADMIN_NOTICES_PATH, { method: "POST", body }),
    onSettled: invalidate,
  });

  // ⚠️ 바디 타입이 `NoticeUpdateRequest` 인 것이 계약이다 — 생성 바디를 넘기면 컴파일이 막는다.
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: NoticeUpdateRequest }) =>
      apiFetch<unknown>(`${ADMIN_NOTICES_PATH}/${encodeURIComponent(id)}`, {
        method: "PUT",
        body,
      }),
    onSettled: invalidate,
  });

  const setActive = useMutation({
    mutationFn: ({ id, body }: { id: string; body: NoticeActiveRequest }) =>
      apiFetch<unknown>(`${ADMIN_NOTICES_PATH}/${encodeURIComponent(id)}/active`, {
        method: "POST",
        body,
      }),
    onSettled: invalidate,
  });

  // soft delete. 사유는 쿼리 파라미터로 — DELETE 바디는 프록시·게이트웨이가 버리는 경우가 있어
  // 기존 economy override 삭제(`?reason=`)와 같은 방식을 따른다.
  const remove = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<unknown>(
        `${ADMIN_NOTICES_PATH}/${encodeURIComponent(id)}?reason=${encodeURIComponent(reason)}`,
        { method: "DELETE" },
      ),
    onSettled: invalidate,
  });

  return { create, update, setActive, remove };
}
