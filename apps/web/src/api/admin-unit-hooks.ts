/**
 * 어드민 유닛 카탈로그 API 훅 (에픽 #207 파트 A / 웨이브2-C).
 * 계약 SoT = `docs/plan-v2/api/openapi.yaml` admin units 섹션 → 생성 타입 `./schema`.
 *
 * `admin-hooks.ts`(유저 운영)와 파일을 분리한 이유는 같다 — 표면을 격리해 다른 세션의
 * 공용 파일 충돌을 만들지 않는다. 캐시 키 접두는 `["admin"]` 을 공유해 기존 invalidate 와 맞물린다.
 *
 * ⚠️ **모든 변경 요청은 `Idempotency-Key` 를 보낸다.** 운영 UI 는 더블클릭·새로고침 재전송이
 * 일상이고, 서버는 같은 키의 재전송을 `applied=false` 로 흡수한다(openapi
 * AdminUnitMutationResult). 키를 안 보내면 서버가 매번 새로 채번해 **재전송이 곧 중복 적용**이 된다.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiFetchOptions } from "./client";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import type {
  AdminUnitCreateRequest,
  AdminUnitDetail,
  AdminUnitMutationResult,
  AdminUnitPage,
  AdminUnitPatchRequest,
  UnitListParams,
} from "../admin/admin-units-logic";
import { UNIT_PAGE_SIZE, unitListQuery } from "../admin/admin-units-logic";

export const ADMIN_UNITS_PATH = "/api/admin/units";

/**
 * 멱등키 채번. `crypto.randomUUID` 가 없는 실행환경(구형 jsdom 등)에서도 절대 throw 하지 않는다 —
 * 키 채번 실패로 운영 변경이 막히면 안 된다.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * 변경 요청의 fetch 옵션. **헤더에 멱등키가 항상 실린다** — 이 함수 하나만 지키면
 * 모든 유닛 변경 동사가 재전송 보호를 받는다(호출부에서 빼먹을 자리를 없앤다).
 */
export function unitMutationInit(
  method: "POST" | "PATCH" | "DELETE",
  idemKey: string,
  body?: unknown,
): ApiFetchOptions {
  const init: ApiFetchOptions = { method, headers: { "Idempotency-Key": idemKey } };
  if (body !== undefined) init.body = body;
  return init;
}

/** GET /api/admin/units — 필터·페이징. */
export function useAdminUnits(params: UnitListParams, enabled: boolean = true) {
  const { token } = useToken();
  const query = unitListQuery({ limit: UNIT_PAGE_SIZE, ...params });
  return useQuery({
    queryKey: ["admin", "units", query],
    queryFn: () => apiFetch<AdminUnitPage>(`${ADMIN_UNITS_PATH}${query}`),
    enabled: Boolean(token) && enabled,
  });
}

/** GET /api/admin/units/{playerId} — 현재값 + 보유 규모 + 최근 감사 이력. */
export function useAdminUnitDetail(playerId: string | null, enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["admin", "unit", playerId],
    queryFn: () =>
      apiFetch<AdminUnitDetail>(`${ADMIN_UNITS_PATH}/${encodeURIComponent(playerId!)}`),
    enabled: Boolean(token) && Boolean(playerId) && enabled,
  });
}

function useUnitInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    // 카탈로그가 바뀌면 플레이어 화면(도감·가챠 풀)도 낡는다.
    void queryClient.invalidateQueries({ queryKey: ["players"] });
  };
}

export interface UnitPatchVars {
  playerId: string;
  body: AdminUnitPatchRequest;
  /**
   * 멱등키. **확인 후 재요청은 새 키를 쓴다** — `confirmImpact` 가 붙어 바디가 달라지므로
   * 같은 키로 다시 보내면 서버가 "같은 키 다른 내용"으로 보고 409 를 낸다(openapi POST/PATCH 주석).
   */
  idemKey?: string;
}

/** PATCH /api/admin/units/{playerId} — 부분 수정(등급 하향은 confirmImpact 필요). */
export function useUpdateUnit() {
  const invalidate = useUnitInvalidate();
  return useMutation({
    mutationFn: ({ playerId, body, idemKey }: UnitPatchVars) =>
      apiFetch<AdminUnitMutationResult>(
        `${ADMIN_UNITS_PATH}/${encodeURIComponent(playerId)}`,
        unitMutationInit("PATCH", idemKey ?? newIdempotencyKey(), body),
      ),
    onSuccess: invalidate,
  });
}

/** POST /api/admin/units — 신규 유닛(id 는 서버 채번). */
export function useCreateUnit() {
  const invalidate = useUnitInvalidate();
  return useMutation({
    mutationFn: ({ body, idemKey }: { body: AdminUnitCreateRequest; idemKey?: string }) =>
      apiFetch<AdminUnitMutationResult>(
        ADMIN_UNITS_PATH,
        unitMutationInit("POST", idemKey ?? newIdempotencyKey(), body),
      ),
    onSuccess: invalidate,
  });
}

export interface UnitActiveVars {
  playerId: string;
  active: boolean;
  reason: string;
  idemKey?: string;
}

/**
 * POST /api/admin/units/{playerId}/(de)activate — 목록에서 바로 토글.
 * 감사 action 이 분리돼 있어 경로도 분리한다(활성/비활성을 이력에서 눈으로 구분).
 */
export function useSetUnitActive() {
  const invalidate = useUnitInvalidate();
  return useMutation({
    mutationFn: ({ playerId, active, reason, idemKey }: UnitActiveVars) =>
      apiFetch<AdminUnitMutationResult>(
        `${ADMIN_UNITS_PATH}/${encodeURIComponent(playerId)}/${active ? "activate" : "deactivate"}`,
        unitMutationInit("POST", idemKey ?? newIdempotencyKey(), { reason }),
      ),
    onSuccess: invalidate,
  });
}
