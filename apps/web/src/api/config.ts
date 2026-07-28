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
  /** 가입 지급액. 클라 상수(3,000)가 이미 틀려 있었고 유상재화 지급은 표기조차 없었다(#232). */
  grants: { initialPoints: number; initialGems: number } | null;
}

export const CONFIG_QUERY_KEY = ["config"] as const;

/**
 * 부트스트랩 config. 표기는 자주 바뀌지 않으므로 오래 캐시하되, 세션 동안 한 번은 다시 확인한다
 * (admin 이 무배포로 갈아끼운 표기가 새로고침 없이도 결국 반영되게).
 *
 * ⚠️ **한 번 실패하면 세션 내내 폴백**이라는 함정이 있다. 앱 부팅 시 한 번 부르는 쿼리인데
 * 전역 기본값이 `retry:false` · `refetchOnWindowFocus:false` 라, 부팅 순간의 401·네트워크 블립
 * 하나로 그 세션 전체가 코드 폴백("62,000 POINT")으로 굴러갔다(독립검증 BL-1 — 인증 게이트가
 * 원인이었고 서버에서 `/api/config` 를 공개로 돌려 근본을 막았다). 원인을 없앴어도 **되살아날 수
 * 있는 실패 모드**라 여기서 자가복구 경로를 열어 둔다: 재시도 + 포커스/재접속 시 갱신.
 * 공개·경량 응답이라 비용은 무시할 만하다.
 */
export function useAppConfig() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => apiFetch<AppConfig>("/api/config"),
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
    retry: 3,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
