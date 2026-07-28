import { describe, expect, it } from "vitest";
import type { Currency } from "../api/config";
import {
  balanceFor,
  CURRENCY_GEM,
  CURRENCY_POINT,
  findCurrency,
  formatAmount,
  shortageMessage,
  withEulReul,
  withEunNeun,
  withIga,
} from "./currency";

/**
 * 재화 표기 포매터 계약 (#232).
 *
 * <b>왜 있나.</b> `findCurrency` 가 "코드가 맞으면 그대로 반환"이던 시절, 서버가 일부 필드만 준 응답에서
 * `undefined` 가 화면에 그대로 보간됐다(`62,000undefinedΩ`, 390px 뷰포트가 498px 로 벌어짐).
 * 그 픽스에 회귀 가드가 없어서 되돌려도 전 게이트가 green 이었다(독립검증 2R minor-1) — 여기서 막는다.
 *
 * 값(심볼이 G 인가)은 단언하지 않는다. 그건 데이터고, 여기서 박으면 표기를 바꿀 때마다 깨진다.
 * 지키는 것은 **성질**이다: 응답이 어떻게 부실하든 화면에 `undefined` 가 나가지 않는다.
 */

const FULL: Currency = {
  code: CURRENCY_POINT,
  symbol: "Ω",
  name: "오메가",
  icon: "◆",
  position: "suffix",
  separator: " ",
};

/** 서버 응답은 클라가 강제할 수 없다 — 타입을 벗겨 "부실한 응답"을 흉내낸다. */
const partial = (over: Record<string, unknown>): Currency[] =>
  [{ code: CURRENCY_POINT, ...over }] as unknown as Currency[];

describe("findCurrency — 부실한 응답에서도 성분을 보장한다", () => {
  it("전 필드가 오면 그대로 쓴다", () => {
    expect(findCurrency([FULL], CURRENCY_POINT)).toEqual(FULL);
  });

  it("코드가 없으면 코드 자체를 노출하는 폴백 — 못생겨도 거짓말은 아니다", () => {
    const c = findCurrency([FULL], CURRENCY_GEM);
    expect(c.symbol).toBe(CURRENCY_GEM);
    expect(c.name).toBe(CURRENCY_GEM);
  });

  it("currencies 자체가 없어도 폴백한다", () => {
    expect(findCurrency(undefined, CURRENCY_POINT).symbol).toBe(CURRENCY_POINT);
  });

  it.each([
    ["symbol", { name: "오메가", icon: "◆", position: "suffix", separator: " " }],
    ["name", { symbol: "Ω", icon: "◆", position: "suffix", separator: " " }],
    ["icon", { symbol: "Ω", name: "오메가", position: "suffix", separator: " " }],
    ["position", { symbol: "Ω", name: "오메가", icon: "◆", separator: " " }],
    ["separator", { symbol: "Ω", name: "오메가", icon: "◆", position: "suffix" }],
    ["전부(코드만)", {}],
  ])("%s 가 빠져도 렌더 결과에 undefined 가 없다", (_label, over) => {
    const c = findCurrency(partial(over), CURRENCY_POINT);
    const rendered = formatAmount(c, 62_000, { icon: true });
    expect(rendered).not.toContain("undefined");
    expect(c.position).toMatch(/^(prefix|suffix)$/);
    expect(typeof c.separator).toBe("string");
  });

  it("null 값이 와도 undefined 가 새지 않는다", () => {
    const c = findCurrency(
      partial({ symbol: null, name: null, icon: null, position: null, separator: null }),
      CURRENCY_POINT,
    );
    expect(formatAmount(c, 100, { icon: true })).not.toContain("undefined");
  });

  it("빈 문자열 symbol·name 은 결측 취급(코드 폴백) — 화면에 빈 단위가 나가면 안 된다", () => {
    const c = findCurrency(partial({ symbol: "  ", name: "" }), CURRENCY_POINT);
    expect(c.symbol).toBe(CURRENCY_POINT);
    expect(c.name).toBe(CURRENCY_POINT);
  });

  it("빈 문자열 separator·icon 은 **의미 있는 값**이라 존중한다(붙여쓰기 / 아이콘 끄기)", () => {
    const c = findCurrency(
      partial({ symbol: "Ω", name: "오메가", icon: "", position: "prefix", separator: "" }),
      CURRENCY_POINT,
    );
    expect(formatAmount(c, 62_000, { icon: true })).toBe("Ω62,000");
  });
});

describe("formatAmount — 순서·구분자를 메타에서 읽는다", () => {
  it("suffix", () => {
    expect(formatAmount(FULL, 62_000)).toBe("62,000 Ω");
  });

  it("prefix", () => {
    expect(formatAmount({ ...FULL, position: "prefix" }, 62_000)).toBe("Ω 62,000");
  });

  it("icon 은 요청한 자리에서만 붙고, 비어 있으면 안 붙는다", () => {
    expect(formatAmount(FULL, 100, { icon: true })).toBe("◆ 100 Ω");
    expect(formatAmount({ ...FULL, icon: "" }, 100, { icon: true })).toBe("100 Ω");
  });
});

describe("balanceFor — 모르면 null(잠그지 않는다)", () => {
  it("아는 재화는 그 잔액", () => {
    expect(balanceFor(CURRENCY_POINT, { points: 10, gems: 3 })).toBe(10);
    expect(balanceFor(CURRENCY_GEM, { points: 10, gems: 3 })).toBe(3);
  });

  /**
   * 서버는 미지 코드를 지원한다(로더가 명시적으로). 조용히 무료재화 잔액으로 재면
   * "500 Z 인데 골드가 모자라서 잠김"이 되고, 그게 이 이슈가 고친 #213 과 같은 형태다.
   */
  it("모르는 재화는 null", () => {
    expect(balanceFor("TICKET", { points: 10, gems: 3 })).toBeNull();
  });

  /** openapi 가 gems 를 required 로 두지 않았다(구서버 호환) — 미수신은 0 이 아니라 **모름**이다. */
  it("잔액 필드가 없으면 null — 0 으로 떨어뜨리면 거짓 잠금이 된다", () => {
    expect(balanceFor(CURRENCY_GEM, { points: 10 })).toBeNull();
    expect(balanceFor(CURRENCY_GEM, { points: 10, gems: null })).toBeNull();
    expect(balanceFor(CURRENCY_GEM, { points: 10, gems: 0 })).toBe(0);
  });
});

describe("조사 — 이름이 데이터가 됐으니 조사도 따라간다", () => {
  it.each([
    ["골드", "골드가", "골드를", "골드는"],
    ["다이아", "다이아가", "다이아를", "다이아는"],
    ["젬", "젬이", "젬을", "젬은"],
  ])("%s", (word, iga, eul, eun) => {
    expect(withIga(word)).toBe(iga);
    expect(withEulReul(word)).toBe(eul);
    expect(withEunNeun(word)).toBe(eun);
  });

  it("한글이 아니면 받침 있는 쪽 — 어색해도 틀린 말은 아니다", () => {
    expect(withIga("GEM")).toBe("GEM이");
    expect(withIga("62,000 Z")).toBe("62,000 Z이");
  });

  it("빈 문자열에서도 깨지지 않는다", () => {
    expect(withIga("")).toBe("이");
  });

  it("shortageMessage 는 이름 + 조사", () => {
    expect(shortageMessage(FULL)).toBe("오메가가 부족합니다");
  });
});
