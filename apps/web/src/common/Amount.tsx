import type * as React from "react";
import type { Currency } from "../api/config";
import { useAppConfigValue } from "./AppConfigContext";
import { findCurrency, formatAmount, shortageMessage } from "./currency";

/**
 * 재화 표기 컴포넌트/훅 (#232) — 화면이 재화를 그리는 **유일한** 경로.
 *
 * 컴포넌트를 따로 두는 이유는 스타일이 아니라 **강제력**이다. 심볼을 문자열로 조립할 수 있게 두면
 * 다음 화면에서 누군가 다시 `{n} P` 를 적는다(그게 30군데가 된 경위다). e2e 계약이 화면 텍스트에서
 * 하드코딩 심볼을 0개로 강제하고, 이 컴포넌트가 그 계약을 지키는 쉬운 길을 제공한다.
 */

/** 표기 메타 접근 훅. config 를 못 받아도 항상 무언가를 돌려준다(코드 폴백). */
export function useCurrency(code: string): Currency {
  return findCurrency(useAppConfigValue()?.currencies, code);
}

/** 클라가 만들어야 하는 "{이름}가 부족합니다" 문구. 서버 4xx message 가 있으면 그쪽이 우선이다. */
export function useShortageMessage(code: string): string {
  return shortageMessage(useCurrency(code));
}

type AmountProps = Omit<React.ComponentPropsWithoutRef<"span">, "children"> & {
  /** 재화 코드 — 서버가 준 값을 그대로 넘긴다. 클라가 추측해서 채우면 안 된다. */
  code: string;
  value: number;
  /** 아이콘을 앞에 붙일지(지갑 배지처럼 넓은 자리만). 기본 false = 심볼만. */
  icon?: boolean;
};

/**
 * `62,000 G` 를 그린다. `icon` 이면 `● 62,000 G`.
 *
 * 접근성: 아이콘은 장식이라 `aria-hidden` 이고, 소리로는 심볼이 읽힌다.
 */
export function Amount({ code, value, icon = false, className, ...rest }: AmountProps) {
  const currency = useCurrency(code);
  return (
    <span className={className} data-currency={currency.code} data-amount={value} {...rest}>
      {icon && currency.icon && (
        <span aria-hidden="true" data-currency-icon="">
          {currency.icon}{" "}
        </span>
      )}
      {formatAmount(currency, value)}
    </span>
  );
}
