import { Amount, useCurrency } from "../../common/Amount";
import type { RewardCurrencyEntry } from "../types";
import styles from "./CurrencySection.module.css";

/**
 * 보상 봉투의 **재화 섹션** (#405 §2.9, 목업 화면 ①).
 *
 * ⚠️ 서버는 `{code, amount}` 만 준다 — 이름·심볼·아이콘은 **하나도 오지 않는다**(#232). 화면이
 * `"P"`·`"포인트"` 를 적는 순간 서버 주도가 깨지므로 줄 제목도 `useCurrency(code).name` 에서
 * 온다. config 를 못 받으면 `<Amount>` 가 코드를 그대로 노출한다 — 못생겨도 거짓말은 아니다.
 */
function CurrencyRow({ entry }: { entry: RewardCurrencyEntry }) {
  const currency = useCurrency(entry.code);
  return (
    <li className={styles.row} data-testid={`reward-currency-${entry.code}`}>
      {currency.icon && (
        <span className={styles.icon} aria-hidden="true">
          {currency.icon}
        </span>
      )}
      <span className={styles.label}>{currency.name}</span>
      <span className={styles.amount}>
        +<Amount code={entry.code} value={entry.amount} />
      </span>
    </li>
  );
}

export function CurrencySection({ entries }: { entries: RewardCurrencyEntry[] }) {
  return (
    <section className={styles.card} data-testid="reward-section-CURRENCY">
      <ul className={styles.list}>
        {entries.map((e) => (
          <CurrencyRow key={e.code} entry={e} />
        ))}
      </ul>
    </section>
  );
}
