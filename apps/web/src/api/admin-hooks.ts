/**
 * admin API 훅 (PRD-v4 §C). 계약 SoT = `./p3.ts` (p3srv 가 openapi-v3 를 발행하면 생성 타입으로 교체).
 *
 * hooks.ts 스타일 준수: TanStack Query만 사용, 전역 스토어 없음, token 있을 때만 enabled.
 * 별도 파일로 둔 이유 = hooks.ts 는 다른 Phase3 세션도 만지는 공용 파일이라 admin 표면을 격리.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useMe } from "./hooks";
import {
  ADMIN_ECONOMY_HISTORY_PATH,
  ADMIN_ECONOMY_OVERRIDE_PATH,
  ADMIN_ECONOMY_PATH,
  ADMIN_ECONOMY_RELOAD_PATH,
  ADMIN_ECONOMY_STARTER_TOP_PATH,
  ADMIN_USERS_PATH,
} from "./p3";
import type {
  AdminEconomyView,
  AdminGrantRequest,
  AdminOpsAuditEntry,
  AdminStarterTopRequest,
  AdminGrantResponse,
  AdminUserDetail,
  AdminUserListResponse,
  MeResponseP3,
} from "./p3";
import { useToken } from "../auth/TokenContext";

/**
 * /api/me 의 Phase3 additive(`user.isAdmin`)를 읽는다. queryKey 는 ["me"] 그대로라
 * 로비/네비와 캐시를 공유한다(추가 요청 0). 필드 부재 = 비admin.
 */
export function useAdminMe() {
  const me = useMe();
  const data = me.data as MeResponseP3 | undefined;
  return { ...me, user: data?.user };
}

/** GET /api/admin/users?q= — 닉네임/아이디 검색(빈 q = 전체). */
export function useAdminUsers(q: string, enabled: boolean = true) {
  const { token } = useToken();
  const term = q.trim();
  return useQuery({
    queryKey: ["admin", "users", term],
    queryFn: () => {
      const path = term ? `${ADMIN_USERS_PATH}?q=${encodeURIComponent(term)}` : ADMIN_USERS_PATH;
      return apiFetch<AdminUserListResponse>(path);
    },
    enabled: Boolean(token) && enabled,
  });
}

/** GET /api/admin/users/{userId} — 보유/덱/전적/최근 원장. userId 없으면 비활성. */
export function useAdminUserDetail(userId: string | null, enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["admin", "user", userId],
    queryFn: () => apiFetch<AdminUserDetail>(`${ADMIN_USERS_PATH}/${encodeURIComponent(userId!)}`),
    enabled: Boolean(token) && Boolean(userId) && enabled,
  });
}

/**
 * POST /api/admin/users/{userId}/points — 지급/차감(delta 음수=차감).
 * 성공 시 admin 목록·상세를 invalidate 해 지갑/원장이 즉시 반영되고,
 * 대상이 자기 자신인 경우를 위해 ["me"] 도 함께 무효화한다.
 */
export function useGrantPoints() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: AdminGrantRequest }) =>
      apiFetch<AdminGrantResponse>(`${ADMIN_USERS_PATH}/${encodeURIComponent(userId)}/points`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

// ── economy 무배포 운영 (#209 B안) ────────────────────────────────────────
// 값 하나가 아니라 **값 + 출처(source)** 를 함께 다룬다 — 운영 화면이 "반영됐나"를 확신하려면
// override 가 실제로 적용됐는지가 값만큼 중요하다.

/** GET /api/admin/economy — 현재 유효한 economy 요약 + 출처. */
export function useAdminEconomy(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["admin", "economy"],
    queryFn: () => apiFetch<AdminEconomyView>(ADMIN_ECONOMY_PATH),
    enabled: Boolean(token) && enabled,
  });
}

/** GET /api/admin/economy/history — 운영 이력(성공·실패 모두). */
export function useAdminEconomyHistory(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["admin", "economy", "history"],
    queryFn: () => apiFetch<AdminOpsAuditEntry[]>(ADMIN_ECONOMY_HISTORY_PATH),
    enabled: Boolean(token) && enabled,
  });
}

/**
 * economy 운영 액션 3종. 셋 다 **성공·실패 가리지 않고**(onSettled) ["admin"] 을 무효화한다.
 *
 * 성공에만 무효화하면 **실패가 화면에서 사라진다** — 서버는 실패도 원장에 남기는데(그게 "왜
 * 반영이 안 됐나"의 답이다) 화면은 그걸 새로고침해야만 보게 된다. 실패야말로 바로 보여야 한다.
 */
export function useEconomyOps() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  const replaceStarterTop = useMutation({
    mutationFn: (body: AdminStarterTopRequest) =>
      apiFetch<AdminEconomyView>(ADMIN_ECONOMY_STARTER_TOP_PATH, { method: "PUT", body }),
    onSettled: invalidate,
  });

  const reload = useMutation({
    mutationFn: (reason: string) =>
      apiFetch<AdminEconomyView>(ADMIN_ECONOMY_RELOAD_PATH, { method: "POST", body: { reason } }),
    onSettled: invalidate,
  });

  const clearOverride = useMutation({
    mutationFn: (reason: string) =>
      apiFetch<AdminEconomyView>(
        `${ADMIN_ECONOMY_OVERRIDE_PATH}?reason=${encodeURIComponent(reason)}`,
        { method: "DELETE" },
      ),
    onSettled: invalidate,
  });

  return { replaceStarterTop, reload, clearOverride };
}
