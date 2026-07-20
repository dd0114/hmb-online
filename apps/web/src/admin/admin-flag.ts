/**
 * admin 여부를 네비까지 전달하는 최소 컨텍스트.
 *
 * ⚠️ 이 파일은 **react 만 import 한다**(쿼리 훅 금지). AppNav 는 여러 페이지 유닛 테스트에서
 * QueryClientProvider 없이 렌더되므로, 네비가 직접 useQuery 를 부르면 그 테스트들이 깨진다.
 * 실제 조회는 `AdminFlagProvider`(App.tsx 트리 안, 쿼리 컨텍스트 보장)가 하고 여기로 주입한다.
 * 프로바이더가 없으면 기본값 false = admin 진입점 미노출(안전한 기본).
 */
import { createContext, useContext } from "react";

export const AdminFlagContext = createContext<boolean>(false);

/** 네비/화면에서 admin 진입점 노출 여부. 프로바이더 없으면 false. */
export function useAdminFlag(): boolean {
  return useContext(AdminFlagContext);
}
