import { QueryClient } from "@tanstack/react-query";

/**
 * 앱 전역 쿼리 클라이언트 (단일 인스턴스).
 *
 * App.tsx 안에서 만들지 않고 모듈로 뺀 이유 = **로그아웃 시 캐시를 비우기 위해서**다.
 * `TokenContext.logout()` 이 이 인스턴스를 직접 import 해 `clear()` 한다 — 훅(useQueryClient)을
 * 쓰면 TokenProvider 가 QueryClientProvider 안에 있어야 해서, 프로바이더 없이 렌더하는
 * 기존 유닛 테스트들이 깨진다.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
