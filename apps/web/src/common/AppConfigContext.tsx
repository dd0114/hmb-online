import { createContext, useContext, type ReactNode } from "react";
import { useAppConfig, type AppConfig } from "../api/config";

/**
 * 부트스트랩 config 를 컨텍스트로 흘린다 (#232).
 *
 * <b>왜 훅에서 직접 useQuery 를 부르지 않나.</b> 재화 표기는 지갑·상점·트레이드·리그·로그·결과·
 * 도감·admin 까지 **거의 모든 화면**에 붙는다. 그 컴포넌트들이 각자 쿼리를 부르면 렌더 트리 어디에나
 * QueryClientProvider 가 있어야 하고, 실제로 단위 테스트들이 그것 없이 컴포넌트를 렌더한다.
 * 표기 하나 때문에 테스트 하네스를 전부 바꾸는 것은 꼬리가 개를 흔드는 짓이다.
 *
 * 컨텍스트로 두면 <b>없어도 동작한다</b>(값 = undefined → 코드 폴백). 그게 §"폴백" 요구와도 같은
 * 모양이다 — config 를 못 받은 상태와 provider 밖 상태가 같은 경로를 탄다.
 *
 * 조회 자체는 {@link AppConfigProvider} 한 곳에서만 일어난다(중복 요청 없음).
 */
const AppConfigContext = createContext<AppConfig | undefined>(undefined);

/** 앱 루트용 — 실제로 `GET /api/config` 를 한 번 조회해 트리에 내린다. */
export function AppConfigProvider({ children }: { children: ReactNode }) {
  const { data } = useAppConfig();
  return <AppConfigContext.Provider value={data}>{children}</AppConfigContext.Provider>;
}

/** 테스트/스토리에서 표기를 고정하고 싶을 때 — 실제 조회 없이 값만 주입한다. */
export function AppConfigValueProvider({
  value,
  children,
}: {
  value: AppConfig | undefined;
  children: ReactNode;
}) {
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

/** 현재 config. provider 밖이거나 아직 못 받았으면 undefined — 호출부가 폴백을 책임진다. */
export function useAppConfigValue(): AppConfig | undefined {
  return useContext(AppConfigContext);
}
