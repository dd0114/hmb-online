/**
 * 이벤트 보드 API 훅 (#492). 계약 SoT = 이슈 #492 §Plan D3 동결본 + `eventboard/event-board-logic.ts`
 * 머리말(`docs/plan-v2/api/openapi.yaml` 은 양쪽 owned-glob 밖이라 편입은 매니저 경유).
 *
 * `admin-hooks.ts` 규율 준수: TanStack Query 만, 전역 스토어 없음, token 있을 때만 enabled.
 * queryKey 접두는 `["admin", …]` — admin 운영 액션의 invalidate 와 캐시 계열을 공유한다.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToken } from "../auth/TokenContext";
import { eventQuery } from "../eventboard/event-board-logic";
import type { EventFilter, EventPage, FunnelResponse } from "../eventboard/event-board-logic";

export const ADMIN_EVENTS_PATH = "/api/admin/events";
export const ADMIN_EVENTS_FUNNEL_PATH = "/api/admin/events/funnel";

/**
 * `GET /api/admin/events?event=&userId=&limit=&offset=` — 최신순 스트림.
 *
 * ⚠️ `placeholderData` 로 **이전 페이지를 붙들고 있는다**. 안 그러면 [다음]을 누를 때마다 표가
 * 통째로 사라졌다 다시 그려져서, 운영자가 스크롤 위치와 맥락을 매번 잃는다.
 */
export function useAdminEvents(filter: EventFilter) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["admin", "events", filter.event, filter.userId, filter.limit, filter.offset],
    queryFn: () => apiFetch<EventPage>(`${ADMIN_EVENTS_PATH}${eventQuery(filter)}`),
    enabled: Boolean(token),
    placeholderData: (prev) => prev,
  });
}

/**
 * `GET /api/admin/events/funnel` — 유저별 도달 지점(#492 D6). 이 화면의 1급 산출물.
 *
 * 정렬(`lastSeenAt DESC`)은 **서버가 한다** — 클라가 다시 정렬하지 않는다(logic 머리말 참조).
 */
export function useAdminEventFunnel() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["admin", "events", "funnel"],
    queryFn: () => apiFetch<FunnelResponse>(ADMIN_EVENTS_FUNNEL_PATH),
    enabled: Boolean(token),
  });
}
