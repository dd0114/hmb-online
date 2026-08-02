import { describe, expect, it } from "vitest";
import type { PlayerStatLine } from "./player-stats";
import {
  categoriesFor,
  disciplineLabel,
  heatDensities,
  kpiFor,
  pctLabel,
  savePct,
} from "./player-detail-view";

/**
 * 선수 상세 [이 경기] 탭 계약 (#403 W3, 목업 ③).
 *
 * ⚠️ 값 리터럴이 아니라 **관계식·상태 구분**을 건다. 특히 "모르는 것"(null)과 "0"이 화면에서
 * 갈리는지 — 그게 이 에픽이 반복해서 지키는 성질이다(패스% · 선방률 · 성장분).
 */

function line(over: Partial<PlayerStatLine> = {}): PlayerStatLine {
  return {
    key: "home:P1", team: "home", playerId: "P1",
    goals: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, xg: 0,
    tackles: 0, interceptions: 0, clearances: 0,
    fouls: 0, yellowCards: 0, redCards: 0, secondYellow: false, sentOff: false,
    offsides: 0, saves: 0, goalsConceded: 0,
    passesAttempted: 0, passesCompleted: 0, longPasses: 0, longPassesCompleted: 0,
    keyPasses: 0, assists: 0, touches: 0, carries: 0, carryDistanceM: 0, carryProgressM: 0,
    dispossessed: 0, distanceM: 0, ticksPlayed: 0, minutesPlayed: 0, heat: [], rating: 6,
    ...over,
  };
}

const catKeys = (l: PlayerStatLine, gk: boolean) => categoriesFor(l, gk, null).map((c) => c.key);
const itemKeys = (l: PlayerStatLine, gk: boolean) =>
  categoriesFor(l, gk, null).flatMap((c) => c.items.map((i) => i.key));

describe("GK 는 카테고리 하나가 다르다 (목업 ③ 각주)", () => {
  it("필드 플레이어는 공격, GK 는 선방 — 같은 자리를 다른 축이 쓴다", () => {
    expect(catKeys(line(), false)[0]).toBe("attack");
    expect(catKeys(line(), true)[0]).toBe("keeper");
    // 나머지 카테고리는 **같다** — 갈리는 것은 첫 칸 하나뿐이다.
    expect(catKeys(line(), false).slice(1)).toEqual(catKeys(line(), true).slice(1));
  });

  it("KPI 축도 갈린다 — GK 에게 xG 를 묻지 않는다", () => {
    expect(kpiFor(line(), false).map((k) => k.key)).toContain("xg");
    expect(kpiFor(line(), true).map((k) => k.key)).not.toContain("xg");
    expect(kpiFor(line(), true).map((k) => k.key)).toContain("savePct");
  });
});

describe("선방률 — 유효슛이 없으면 모르는 것이지 0% 가 아니다", () => {
  it("상대한 유효슛 0 이면 null, 화면은 `—`", () => {
    expect(savePct(line())).toBeNull();
    expect(pctLabel(null)).toBe("—");
    const item = categoriesFor(line(), true, null)[0]!.items.find((i) => i.key === "savePct")!;
    expect(item.value).toBe("—");
    expect(item.dim).toBe(true);
  });

  it("선방이 많을수록 높다 · 실점이 많을수록 낮다(단조) — 0..100 을 벗어나지 않는다", () => {
    const a = savePct(line({ saves: 1, goalsConceded: 3 }))!;
    const b = savePct(line({ saves: 3, goalsConceded: 1 }))!;
    expect(b).toBeGreaterThan(a);
    for (const v of [a, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(savePct(line({ saves: 4, goalsConceded: 0 }))).toBe(100);
  });
});

describe("규율 — 경고 누적 퇴장은 카드 2장이 아니다", () => {
  /** 엔진이 같은 틱에 `yellow` 와 `red` 를 둘 다 쏜다(W0 §2 함정 ②). 순진하게 세면 2장이 된다. */
  it("2번째 옐로는 레드에 흡수되고, 그 사실을 말한다", () => {
    const d = disciplineLabel({ yellowCards: 2, redCards: 1, secondYellow: true, sentOff: true });
    expect(d.value.startsWith("1 /")).toBe(true);
    expect(d.value).toContain("경고 누적");
    expect(d.dim).toBe(false);
  });

  it("직접 퇴장은 경고 없이 레드만", () => {
    const d = disciplineLabel({ yellowCards: 0, redCards: 1, secondYellow: false, sentOff: true });
    expect(d.value).toBe("— / 1");
  });

  it("퇴장 플래그만 있고 redCards 가 0 이어도 레드로 센다(둘이 어긋나도 화면은 사실을 말한다)", () => {
    const d = disciplineLabel({ yellowCards: 0, redCards: 0, secondYellow: false, sentOff: true });
    expect(d.value).toBe("— / 1");
  });

  it("아무 것도 없으면 `— / —` 이고 흐리다 — 0 으로 도배하지 않는다", () => {
    expect(disciplineLabel({ yellowCards: 0, redCards: 0, secondYellow: false, sentOff: false }))
      .toEqual({ value: "— / —", dim: true });
  });
});

describe("패스 — 귀속이 불완전하면 숨기지 않고 말한다", () => {
  it("커버리지 문구가 오면 패스 카테고리에 경고가 붙는다", () => {
    const cats = categoriesFor(line({ passesAttempted: 10, passesCompleted: 7 }), false, "패스 귀속 82%");
    const pass = cats.find((c) => c.key === "pass")!;
    expect(pass.note).toContain("기록 불완전");
    expect(pass.note).toContain("82%");
  });

  it("완전하면 경고가 없다 — 상시 경고는 신호가 아니라 소음이다", () => {
    const pass = categoriesFor(line({ passesAttempted: 10, passesCompleted: 7 }), false, null)
      .find((c) => c.key === "pass")!;
    expect(pass.note).toBeUndefined();
  });

  it("시도 0 이면 성공률은 `—` 이고 진행바를 안 그린다(0% 는 거짓말이다)", () => {
    const pass = categoriesFor(line(), false, null).find((c) => c.key === "pass")!;
    expect(pass.items.find((i) => i.key === "passPct")!.value).toBe("—");
    expect(pass.bar).toBeUndefined();
  });

  it("진행바는 성공률을 따라간다(0..1)", () => {
    const pass = categoriesFor(line({ passesAttempted: 4, passesCompleted: 3 }), false, null)
      .find((c) => c.key === "pass")!;
    expect(pass.bar).toBeCloseTo(0.75, 5);
  });
});

describe("히트맵 — 균일한 회색은 거짓 신호다", () => {
  it("전부 0 이면 빈 배열(격자를 안 그린다)", () => {
    expect(heatDensities([0, 0, 0])).toEqual([]);
    expect(heatDensities([])).toEqual([]);
    expect(heatDensities(undefined)).toEqual([]);
  });

  it("최대 빈이 1 이고 나머지는 그 비율이다", () => {
    const d = heatDensities([1, 2, 4, 0]);
    expect(Math.max(...d)).toBe(1);
    expect(d[0]).toBeCloseTo(0.25, 5);
    expect(d[3]).toBe(0);
  });

  it("손상된 값(NaN·문자)이 섞여도 유한값만 남는다", () => {
    const d = heatDensities([NaN, 5, "x" as unknown as number]);
    expect(d.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.max(...d)).toBe(1);
  });
});

/**
 * 🚨 **T3 지표를 만들지 않는다** (W0 §2 · 이 에픽 규칙 = 엔진 수정 금지).
 * 엔진이 기록하지 않는 것을 화면에 세우면 그 자리는 반드시 추측으로 채워진다.
 * 요청은 QA #25 로 나가 있고, 반영되면 **화면은 그대로 두고 값만 채운다**.
 */
describe("경계 — 못 내는 지표를 지어내지 않는다", () => {
  const FORBIDDEN = ["크로스", "블록", "드리블 성공", "피파울", "경합 시도"];
  it.each([false, true])("GK=%s — 금지 라벨이 하나도 없다", (gk) => {
    const labels = categoriesFor(line(), gk, null).flatMap((c) => c.items.map((i) => i.label));
    for (const bad of FORBIDDEN) {
      expect(labels.some((l) => l.includes(bad)), `${bad} 가 화면에 있다`).toBe(false);
    }
  });

  it("모든 항목이 집계(PlayerStatLine)에서 나온다 — 화면 전용 파생 필드가 없다", () => {
    // 값이 전부 0/— 인 라인으로 그려도 예외 없이 문자열이 나온다(계산이 undefined 를 안 만든다).
    for (const gk of [false, true]) {
      for (const cat of categoriesFor(line(), gk, null)) {
        for (const it of cat.items) {
          expect(typeof it.value, `${cat.key}.${it.key}`).toBe("string");
          expect(it.value.length).toBeGreaterThan(0);
        }
      }
    }
    expect(itemKeys(line(), false).length).toBeGreaterThan(10);
  });
});
