import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";

/**
 * `GET /api/config` — 서버 주도 재화 표기 + 상점 가격 (#232).
 *
 * <b>클라는 재화의 심볼·이름·아이콘·가격·결제재화를 하나도 몰라야 한다.</b> 여기서 받은 값만 렌더한다.
 * 하드코딩이 남으면 서버 경제가 바뀔 때 화면이 조용히 거짓말을 한다 — 실제로 #212 가 뽑기를 젬 결제로
 * 바꿨을 때 web 은 "300 P" 를 계속 그렸고, 다이스는 서버 5,000 을 "500 P" 로 그렸다(#213).
 *
 * SoT = server-java `ConfigController`. 값의 출처는 economy 스냅샷이라 표기 변경은 admin override +
 * reload 로 끝난다(web 재배포 없음).
 */
export interface Currency {
  /** 내부 코드 — 값·원장·API 가 쓰는 그 코드. 화면에는 절대 이걸 그대로 쓰지 않는다(폴백 제외). */
  code: string;
  /** 금액 옆 짧은 표기(예: G, Z). */
  symbol: string;
  /** 풀네임(문장형 안내문·툴팁). ⚠️ 카드 등급 이름과 겹칠 수 있어 화면 기본은 symbol 이다. */
  name: string;
  /** 금액 앞 아이콘. 빈 문자열이면 안 그린다. */
  icon: string;
  position: "prefix" | "suffix";
  separator: string;
}

/** 금액 + 그 금액의 재화. 이 둘은 항상 붙어 다닌다(떼어 놓은 것이 #213 버그의 형태였다). */
export interface Price {
  currency: string;
  cost: number;
}

export interface AppConfig {
  currencies: Currency[];
  shop: {
    gacha: { single: Price; ten: Price; tenCount: number } | null;
    dice: { normal: Price; cash: Price } | null;
    gemTopup: { enabled: boolean; packs: { id: string; gems: number; mockPrice: string }[] } | null;
  } | null;
}

export const CONFIG_QUERY_KEY = ["config"] as const;

/**
 * 부트스트랩 config. 표기는 자주 바뀌지 않으므로 오래 캐시하되, 세션 동안 한 번은 다시 확인한다
 * (admin 이 무배포로 갈아끼운 표기가 새로고침 없이도 결국 반영되게).
 */
export function useAppConfig() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => apiFetch<AppConfig>("/api/config"),
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
    // 표기를 못 받아도 화면은 떠야 한다(폴백은 currency.ts 가 책임진다) — 재시도는 짧게.
    retry: 1,
  });
}
