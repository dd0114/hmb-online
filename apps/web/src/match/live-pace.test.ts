import { describe, expect, it } from "vitest";
import {
  PACE_MAX,
  PACE_MIN,
  driftAllowanceTicks,
  indexOfPlayhead,
  paceRate,
  tickOfIndex,
} from "./live-pace";

/**
 * #216 AC2 — 라이브 재생을 서버 시계 창에 **밀지 않고 맞추는** 계약.
 *
 * 구(舊) 방식은 250ms 마다 `jumpToTick(liveTick)` 으로 플레이헤드를 끌어내렸다. 하이라이트 켬
 * 모드는 속도가 균일하지 않아(크루즈 4x / 키장면 1x) 창의 평균속도를 계속 앞질렀다 = 초당 4회
 * 되감김(고무줄). 여기서는 **배율**로 완만히 따라붙게 한다.
 */
describe("paceRate — 창 진행과 재생 진행의 차이를 배율로 흡수", () => {
  it("정확히 맞춰 가고 있으면 배율 1(=코어 자연 페이스)", () => {
    expect(paceRate(0.5, 0.5)).toBe(1);
    expect(paceRate(0, 0)).toBe(1);
  });

  it("재생이 뒤처지면 1보다 크고, 앞서면 1보다 작다 — 방향만 반대로 같은 크기", () => {
    const behind = paceRate(0.4, 0.5); // 창이 더 갔다 → 따라붙어야 한다
    const ahead = paceRate(0.6, 0.5); // 재생이 앞섰다 → 늦춘다
    expect(behind).toBeGreaterThan(1);
    expect(ahead).toBeLessThan(1);
    expect(behind - 1).toBeCloseTo(1 - ahead);
  });

  it("보정은 완만하다 — 흔한 오차(±5%)에서 배율이 ±15% 를 넘지 않는다", () => {
    expect(paceRate(0.45, 0.5)).toBeLessThan(1.15);
    expect(paceRate(0.55, 0.5)).toBeGreaterThan(0.85);
  });

  it("창의 끝과 재생의 끝이 같은 지점으로 수렴한다 — 오차가 남아도 후반부에 흡수된다", () => {
    // 자연 페이스가 창보다 10% 빠른 상황의 평형(앞섬)은 하프가 진행될수록 줄어든다.
    // 오차비례 컨트롤러였다면 같은 오차가 끝까지 남아 재생이 먼저 끝나 버린다.
    const aheadAt = (live: number) => {
      // 평형: r*(1-p)/(1-l) = 1  →  p = 1 - (1-l)/r
      const r = 1.1;
      const p = 1 - (1 - live) / r;
      expect(paceRate(p, live)).toBeCloseTo(1 / r, 5); // 실제로 평형이다(배율이 자연 페이스를 상쇄)
      return p - live;
    };
    expect(aheadAt(0.1)).toBeGreaterThan(aheadAt(0.5));
    expect(aheadAt(0.5)).toBeGreaterThan(aheadAt(0.9));
    expect(aheadAt(0.9)).toBeLessThan(0.01); // 끝에 가까울수록 사실상 같은 지점
  });

  it("창이 사실상 끝났을 때도 0 나눗셈으로 폭주하지 않는다", () => {
    expect(Number.isFinite(paceRate(0.999, 1))).toBe(true);
    expect(paceRate(0.999, 1)).toBeGreaterThanOrEqual(PACE_MIN);
    expect(paceRate(0.999, 1)).toBeLessThanOrEqual(PACE_MAX);
  });

  it("아무리 벌어져도 클램프 안에 있다(되감기·백그라운드 탭이 스프린트가 되지 않게)", () => {
    expect(paceRate(0, 1)).toBe(PACE_MAX);
    expect(paceRate(1, 0)).toBe(PACE_MIN);
    expect(PACE_MAX).toBeLessThanOrEqual(2);
    expect(PACE_MIN).toBeGreaterThan(0);
  });

  it("입력이 이상해도(NaN·창 없음) 1 로 떨어진다 = 코어 자연 페이스", () => {
    expect(paceRate(Number.NaN, 0.5)).toBe(1);
    expect(paceRate(0.5, Number.NaN)).toBe(1);
  });
});

describe("driftAllowanceTicks — 자유 재생의 앞섬은 회수하지 않는다(회수는 의도적 점프만)", () => {
  it("하프 길이에 비례하고, 연출 페이싱의 실측 드리프트보다 넉넉하다", () => {
    // 리얼 하프 2700틱 → 324틱. paceRate 평형의 최대 앞섬(1 − 1/1.10 ≈ 9%)보다 넉넉해야
    // 자유 재생이 회수당하지 않는다(그게 고무줄이었다).
    expect(driftAllowanceTicks(2700)).toBe(324);
    expect(driftAllowanceTicks(2700)).toBeGreaterThan(2700 * (1 - 1 / 1.1));
    // 그래도 하프의 일부일 뿐 — 끝으로 뛰는 점프는 확실히 걸린다.
    expect(driftAllowanceTicks(2700)).toBeLessThan(2700 * 0.2);
  });
  it("로그가 없으면 0", () => {
    expect(driftAllowanceTicks(0)).toBe(0);
    expect(driftAllowanceTicks(Number.NaN)).toBe(0);
  });
});

/**
 * 서버 시계는 **인덱스**(진행률 × 스냅샷 수)를 말하고 뷰어는 **절대 틱**으로 움직인다.
 * 후반 로그는 틱이 0 이 아니라 2700 부터 시작하므로 이 둘을 섞으면 후반이 통째로 깨진다
 * (구현 당시 seek-to-now 가 항상 로그 맨 앞으로 점프하고, 상한 비교가 늘 참이 되어 매 250ms
 *  되감겼다 = 후반 재생 정지). 그래서 변환을 계약으로 박제한다.
 */
describe("tickOfIndex / indexOfPlayhead — 인덱스와 절대 틱을 섞지 않는다", () => {
  const h2 = Array.from({ length: 2700 }, (_, i) => 2700 + i); // 후반 로그 틱

  it("후반: 인덱스 0 은 틱 2700, 절반은 4050", () => {
    expect(tickOfIndex(h2, 0)).toBe(2700);
    expect(tickOfIndex(h2, 1350)).toBe(4050);
  });

  it("범위 밖 인덱스는 양끝으로 클램프한다", () => {
    expect(tickOfIndex(h2, -5)).toBe(2700);
    expect(tickOfIndex(h2, 99_999)).toBe(2700 + 2699);
    expect(tickOfIndex([], 3)).toBe(0);
  });

  it("절대 틱 → 인덱스(역변환) — 후반 틱 4050 은 인덱스 1350", () => {
    expect(indexOfPlayhead(h2, 4050)).toBe(1350);
    expect(indexOfPlayhead(h2, 2700)).toBe(0);
    // 로그에 없는 틱은 그 이상의 첫 스냅샷(뷰어 idxOfTick 과 같은 규칙).
    expect(indexOfPlayhead(h2, 1)).toBe(0);
    expect(indexOfPlayhead(h2, 999_999)).toBe(2699);
  });

  it("전반(틱=인덱스)에서는 항등 — 기존 동작 무회귀", () => {
    const h1 = Array.from({ length: 100 }, (_, i) => i);
    expect(tickOfIndex(h1, 42)).toBe(42);
    expect(indexOfPlayhead(h1, 42)).toBe(42);
  });
});
