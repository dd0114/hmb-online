import { describe, expect, it } from "vitest";
import {
  FX_CONFIG,
  batchFxPlan,
  fxRevealed,
  fxAccentOf,
  fxDuration,
  fxMarks,
  fxPhaseAt,
  fxTierOf,
  hasFx,
  highestTier,
  isDisguised,
  surgeOf,
  type FxConfig,
} from "./gacha-fx";
import { GRADE_COLORS, GRADE_GLOW_COLORS, GRADE_ORDER, type Grade } from "./grades";

/**
 * 뽑기 이펙트의 **눈으로 판정할 수 없는 부분**만 여기서 잡는다 — 발동 등급·순서·타이밍.
 * 보이는 그림(빛·파티클)은 hero 컨펌(#250 W1 프리뷰) + 실화면 캡처가 판정한다.
 */

describe("발동 판정 (에픽 이상 = 임계 config)", () => {
  it("기본안: 다이아 이상만 발동하고 레전드만 확장 피날레", () => {
    expect(fxTierOf("BRONZE")).toBe("none");
    expect(fxTierOf("SILVER")).toBe("none");
    expect(fxTierOf("GOLD")).toBe("none");
    expect(fxTierOf("DIA")).toBe("epic");
    expect(fxTierOf("LEGEND")).toBe("legend");
  });

  it("임계는 config 한 곳 — 골드로 내리면 골드부터 발동한다(코드 수정 0)", () => {
    const cfg: FxConfig = { ...FX_CONFIG, threshold: "GOLD" };
    expect(fxTierOf("GOLD", cfg)).toBe("epic");
    expect(fxTierOf("SILVER", cfg)).toBe("none");
    // 피날레 임계는 따로다 — 발동 임계를 내려도 확장은 레전드에 남는다.
    expect(fxTierOf("DIA", cfg)).toBe("epic");
    expect(fxTierOf("LEGEND", cfg)).toBe("legend");
  });

  it("임계는 등급 서열을 따른다 — 이름 하드코딩이 아니다", () => {
    // GRADE_ORDER 상 임계보다 낮은 등급은 전부 none, 높으면 전부 발동.
    const cut = GRADE_ORDER.indexOf(FX_CONFIG.threshold);
    GRADE_ORDER.forEach((g, i) => {
      expect(hasFx(g)).toBe(i >= cut);
    });
  });

  it("모르는 등급은 조용히 빠진다 (스키마가 늘어나도 이상한 데 연출이 붙지 않는다)", () => {
    expect(fxTierOf("MYTHIC" as Grade)).toBe("none");
  });
});

describe("단계 시계", () => {
  const t = FX_CONFIG.timings;

  it("charge 끝나기 전에는 앞면을 보이지 않는다 (= anticipation 의 정의)", () => {
    // 이 계약이 깨지면 결과가 먼저 보이고 빛이 뒤따라와 '기대감'이 성립하지 않는다.
    expect(fxPhaseAt(t.charge - 1, "epic", t)).toBe("charge");
    expect(fxPhaseAt(t.charge, "epic", t)).toBe("burst");
    // 단언 대상은 **제품이 실제로 쓰는 게이트**다(`RevealFxCard` → `fxRevealed`).
    expect(fxRevealed("charge")).toBe(false);
    expect(fxRevealed("burst")).toBe(true);
  });

  it("epic 은 잔광에서 끝나고 legend 만 피날레가 붙는다", () => {
    const afterAura = t.charge + t.burst + t.aura;
    expect(fxPhaseAt(afterAura - 1, "epic", t)).toBe("aura");
    expect(fxPhaseAt(afterAura, "epic", t)).toBe("done");
    // legend 는 같은 시점에 B(surge) 만큼 뒤처져 있다 — 아직 잔광 안이다.
    expect(fxPhaseAt(afterAura + t.surge, "legend", t)).toBe("finale");
  });

  it("none 은 어떤 시점에도 재생 상태가 아니다 (대조군이 느려지지 않는다)", () => {
    expect(fxDuration("none", t)).toBe(0);
    expect(fxPhaseAt(0, "none", t)).toBe("done");
  });

  it("reduced-motion 타이밍도 단계 순서는 같다 — 짧아질 뿐 빠지지 않는다", () => {
    const r = FX_CONFIG.reducedTimings;
    expect(r.charge).toBeGreaterThan(0); // 0 이면 고레어 신호 자체가 사라진다
    expect(fxDuration("legend", r)).toBeLessThan(fxDuration("legend", t));
    expect(fxPhaseAt(r.charge - 1, "epic", r)).toBe("charge");
    expect(fxPhaseAt(r.charge, "epic", r)).toBe("burst");
  });
});

describe("광원색 — 등급 라벨색이 아니라 프레임 아트를 따른다 (#250 hero 확정)", () => {
  it("레전드 광원은 금색이다 — 프레임이 금색이라 보라 라벨색을 쓰면 카드 안팎이 싸운다", () => {
    // 발행물 `frame-LEGEND.png` 테두리 실측 지배색 = #ffbb22 계열.
    expect(GRADE_GLOW_COLORS.LEGEND.toLowerCase()).toBe("#ffbb22");
    expect(GRADE_GLOW_COLORS.LEGEND).not.toBe(GRADE_COLORS.LEGEND);
  });

  it("나머지 등급은 라벨색을 그대로 쓴다 — 갈라진 건 레전드 하나뿐이다", () => {
    for (const g of GRADE_ORDER.filter((x) => x !== "LEGEND")) {
      expect(GRADE_GLOW_COLORS[g], `${g} 가 이유 없이 갈라졌다`).toBe(GRADE_COLORS[g]);
    }
  });

  it("FX 광원도 같은 출처를 쓴다 — 금 후광 + 보라 광선 같은 새 불일치를 막는다", () => {
    // 위장 중엔 아래 등급(다이아) 광원, 격상 후엔 레전드 광원.
    expect(fxAccentOf("LEGEND", "charge", GRADE_GLOW_COLORS)).toBe(GRADE_GLOW_COLORS.DIA);
    expect(fxAccentOf("LEGEND", "surge", GRADE_GLOW_COLORS)).toBe(GRADE_GLOW_COLORS.LEGEND);
  });
});

describe("단계 경계 — 통지는 경계마다 정확히 한 번", () => {
  /*
   * 독립검증 BL-1 이 여기서 났다. `surgeOf("epic")=0` 이라 소박하게 적으면 경계가 겹치고,
   * 겹친 만큼 단계 통지가 중복돼 소비자의 완료 집계가 부풀었다 → 확인 버튼이 피날레보다 먼저 떠서
   * **레전드 클라이맥스가 통째로 잘렸다**. 소비자 쪽에도 방어(집합 집계)를 뒀지만, 그 방어가
   * 이 층의 결함을 가려 버리면 누군가 "단순화"할 때 조용히 되돌아간다 — **이 층이 단독으로 옳아야** 한다.
   */
  const t = FX_CONFIG.timings;

  it("어떤 티어에서도 경계가 중복되지 않는다", () => {
    for (const tier of ["none", "epic", "legend"] as const) {
      for (const timings of [FX_CONFIG.timings, FX_CONFIG.reducedTimings]) {
        const marks = fxMarks(tier, timings);
        expect(new Set(marks).size, `${tier} 경계 중복: ${marks}`).toBe(marks.length);
      }
    }
  });

  it("경계는 오름차순이고 마지막이 총 길이다", () => {
    for (const tier of ["epic", "legend"] as const) {
      const marks = fxMarks(tier, t);
      expect([...marks].sort((a, b) => a - b)).toEqual(marks);
      expect(marks[marks.length - 1]).toBe(fxDuration(tier, t));
    }
  });

  it("레전드에만 B 경계가 있다 — 개수가 아니라 **어떤 지점이 있는가**로 본다", () => {
    // 개수로 세면 틀린다: epic 은 중복이 **둘** 사라진다(B 없음 + 피날레 없음). 지점으로 단언한다.
    expect(fxMarks("legend", t)).toContain(t.charge + t.surge);
    expect(fxMarks("epic", t)).not.toContain(t.charge + t.surge);
    // epic 의 charge 다음 경계는 곧 개봉(burst 종료)이다.
    expect(fxPhaseAt(t.charge, "epic", t)).toBe("burst");
  });
});

describe("LEGEND 위장 격상 — A → B → 개봉 (hero 요구)", () => {
  const t = FX_CONFIG.timings;
  const C = { BRONZE: "#b", SILVER: "#s", GOLD: "#g", DIA: "#dia", LEGEND: "#leg" } as Record<Grade, string>;

  it("**레전드만 B(surge) 구간을 갖는다** — 다이아는 A 다음이 곧 개봉", () => {
    expect(surgeOf("legend", t)).toBe(t.surge);
    expect(surgeOf("epic", t)).toBe(0);
    expect(surgeOf("none", t)).toBe(0);
  });

  it("A 는 다이아와 **같은 길이**로 끝까지 돈다 — 그 뒤에 B 가 붙는다", () => {
    // 같은 시점에 다이아는 이미 개봉인데 레전드는 아직 B 다 = 반전이 성립하는 구조.
    expect(fxPhaseAt(t.charge - 1, "epic", t)).toBe("charge");
    expect(fxPhaseAt(t.charge - 1, "legend", t)).toBe("charge");
    expect(fxPhaseAt(t.charge, "epic", t)).toBe("burst");
    expect(fxPhaseAt(t.charge, "legend", t)).toBe("surge");
    expect(fxPhaseAt(t.charge + t.surge - 1, "legend", t)).toBe("surge");
    expect(fxPhaseAt(t.charge + t.surge, "legend", t)).toBe("burst");
  });

  it("**개봉은 B 가 끝난 뒤다** — B 중에 열리면 카드 프레임이 곧 정답이라 위장이 무의미해진다", () => {
    // 시각(ms)이 아니라 **제품 게이트**로 단언한다. 예전엔 `flipAt()` 으로 검사했는데 제품이 그 함수를
    // 쓰지 않아, 통과해도 실제 동작을 아무것도 강제하지 못했다(독립검증 MJ-2).
    expect(fxRevealed("surge")).toBe(false);
    expect(fxPhaseAt(t.charge, "legend", t)).toBe("surge");
    expect(fxPhaseAt(t.charge + t.surge, "legend", t)).toBe("burst");
    expect(fxRevealed(fxPhaseAt(t.charge + t.surge - 1, "legend", t))).toBe(false);
    expect(fxRevealed(fxPhaseAt(t.charge + t.surge, "legend", t))).toBe(true);
  });

  it("레전드 총 길이 = 다이아 + B + 피날레 (기대감이 실제로 더 길다)", () => {
    expect(fxDuration("legend", t) - fxDuration("epic", t)).toBe(t.surge + t.finale);
  });

  it("A 구간의 레전드는 **아래 등급 색**, B 부터 자기 색", () => {
    expect(fxAccentOf("LEGEND", "charge", C)).toBe("#dia");
    expect(fxAccentOf("LEGEND", "surge", C)).toBe("#leg");
    expect(fxAccentOf("LEGEND", "burst", C)).toBe("#leg");
    expect(fxAccentOf("LEGEND", "finale", C)).toBe("#leg");
  });

  it("A 중에는 **레전드 전용 층도 숨는다** — 색만 바꾸면 위장이 아니다", () => {
    expect(isDisguised("LEGEND", "charge")).toBe(true);
    expect(isDisguised("LEGEND", "surge")).toBe(false);
    expect(isDisguised("LEGEND", "burst")).toBe(false);
  });

  it("다이아·비고레어는 위장이 없다 (처음부터 자기 색)", () => {
    expect(fxAccentOf("DIA", "charge", C)).toBe("#dia");
    expect(isDisguised("DIA", "charge")).toBe(false);
  });

  it("격상 후 색은 config — 금색으로 바꿔도 A 구간은 그대로 다이아", () => {
    const gold: FxConfig = {
      ...FX_CONFIG,
      legendDisguise: { ...FX_CONFIG.legendDisguise, finalColor: "#ffcf4a" },
    };
    expect(fxAccentOf("LEGEND", "charge", C, gold)).toBe("#dia");
    expect(fxAccentOf("LEGEND", "surge", C, gold)).toBe("#ffcf4a");
  });

  it("위장을 끄면 처음부터 자기 색 — 단 **B 구간은 남는다**(구조와 색은 별개다)", () => {
    const off: FxConfig = {
      ...FX_CONFIG,
      legendDisguise: { ...FX_CONFIG.legendDisguise, enabled: false },
    };
    expect(fxAccentOf("LEGEND", "charge", C, off)).toBe("#leg");
    expect(isDisguised("LEGEND", "charge", off)).toBe(false);
    expect(surgeOf("legend", t)).toBe(t.surge);
  });

  it("모션 최소화에서도 A → B 구조는 유지된다 (짧아질 뿐 빠지지 않는다)", () => {
    const r = FX_CONFIG.reducedTimings;
    expect(r.surge).toBeGreaterThan(0);
    expect(fxPhaseAt(r.charge, "legend", r)).toBe("surge");
    expect(fxRevealed(fxPhaseAt(r.charge + r.surge - 1, "legend", r))).toBe(false);
  });
});

describe("일괄 공개 계획", () => {
  const pull: Grade[] = ["BRONZE", "LEGEND", "SILVER", "DIA", "GOLD", "DIA"];

  it("고레어만 고른다 — 나머지는 계획에 없다(지연 0 즉시 공개)", () => {
    const plan = batchFxPlan(pull);
    expect(plan.map((s) => s.index)).toEqual([3, 5, 1]);
  });

  it("클라이맥스가 마지막에 온다 — 낮은 티어 먼저, 같은 티어 안에서는 뽑힌 순서", () => {
    const plan = batchFxPlan(pull);
    expect(plan.map((s) => s.tier)).toEqual(["epic", "epic", "legend"]);
    // LEGEND 가 1번 슬롯(인덱스 1)이지만 마지막에 터진다.
    expect(plan[plan.length - 1]?.index).toBe(1);
  });

  it("스태거 간격은 config — 순서대로 누적된다", () => {
    const plan = batchFxPlan(pull, { ...FX_CONFIG, batchStaggerMs: 100 });
    expect(plan.map((s) => s.delayMs)).toEqual([0, 100, 200]);
  });

  it("고레어가 없으면 계획이 비어 일괄 공개가 지금과 똑같이 즉시 끝난다", () => {
    expect(batchFxPlan(["BRONZE", "SILVER", "GOLD"])).toEqual([]);
    expect(highestTier(["BRONZE", "SILVER", "GOLD"])).toBe("none");
  });

  it("highestTier 가 피날레 유무를 정한다", () => {
    expect(highestTier(["DIA", "GOLD"])).toBe("epic");
    expect(highestTier(["DIA", "LEGEND"])).toBe("legend");
  });
});
