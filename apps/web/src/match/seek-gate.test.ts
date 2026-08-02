/**
 * 과거 전용 시크바의 판정 규칙 (#406 W3 / 요구 5-3) — 순수 계약.
 *
 * ⚠️ 정책은 **가짜 clamp 로 세우지 않는다.** `liveGate`(live-clock) → `clampSeek`(shared) 라는
 * 실제 사슬을 그대로 태운다 — 여기서 clamp 를 목으로 바꾸면 "내가 적은 규칙"을 검사하게 되고,
 * 배선이 끊어져도(= 상한이 사라져도) 계약이 초록으로 남는다(apps/web CLAUDE.md §계약이 거짓말하는 방식 2).
 */
import { describe, expect, it } from "vitest";
import type { MatchClock } from "@hmb/shared";
import { liveGate } from "./live-clock";
import {
  LIVE_EDGE_TOLERANCE_IDX,
  atLiveEdge,
  gatedTick,
  indexOfTick,
  isFutureIndex,
  policyOf,
  tickOfSnapIndex,
  trackGeometry,
  withinTrack,
} from "./seek-gate";

const HALF_REAL_MS = 420_000;
const NOW = Date.parse("2026-08-02T12:00:00Z");

/** 후반 로그 = 틱 2700 부터. **인덱스와 절대 틱을 섞으면 여기서 죽는다**(#238/#170 의 그 함정). */
const H2_TICKS = Array.from({ length: 100 }, (_, i) => 2700 + i);

function clock(elapsedFrac: number, seekForwardBlocked = true): MatchClock {
  const start = NOW - HALF_REAL_MS * elapsedFrac;
  return {
    phase: "SECOND_HALF",
    kickoffAt: new Date(start).toISOString(),
    phaseStartAt: new Date(start).toISOString(),
    phaseEndsAt: new Date(start + HALF_REAL_MS).toISOString(),
    serverNow: new Date(NOW).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 180_000,
    seekForwardBlocked,
    seekGraceMs: 1500,
  };
}

/** 절반 지난 라이브 후반 = 상한 인덱스 50, grace 2(1500ms / 1000ms per tick 올림). */
const live50 = () => policyOf(liveGate(clock(0.5), 2, H2_TICKS.length, NOW, 0));
/** 종료·지나간 하프 = 시계 없음. */
const offGate = () => policyOf(liveGate(null, 2, H2_TICKS.length, NOW, 0));

describe("SeekPolicy — 상한은 liveGate/clampSeek 그대로다", () => {
  it("라이브면 상한 인덱스를 말하고, 그 뒤로는 grace 만큼만 허용한다", () => {
    const p = live50();
    expect(p.isLive).toBe(true);
    expect(p.liveIndex).toBe(50);
    expect(p.clampIndex(10), "뒤로는 자유").toBe(10);
    expect(p.clampIndex(50)).toBe(50);
    expect(p.clampIndex(99), "미래는 상한 + grace 로 잘린다").toBe(52);
  });

  it("라이브가 아니면 상한이 없다 — 종료 후 전 구간 이동(요구 5-3 후반부)", () => {
    const p = offGate();
    expect(p.isLive).toBe(false);
    expect(p.liveIndex).toBeNull();
    expect(p.clampIndex(99)).toBe(99);
  });

  it("서버 config 가 앞서보기를 허용하면(seekForwardBlocked=false) 잠그지 않는다", () => {
    // 웹에 정책을 복제하지 않는다는 증거 — 값은 서버가 준 clock 에서만 온다.
    const p = policyOf(liveGate(clock(0.5, false), 2, H2_TICKS.length, NOW, 0));
    expect(p.clampIndex(99)).toBe(99);
  });
});

describe("미래 판정 — 아직 안 온 장면", () => {
  it("상한을 넘는 인덱스만 미래다", () => {
    const p = live50();
    expect(isFutureIndex(50, p)).toBe(false);
    expect(isFutureIndex(51, p)).toBe(true);
  });

  it("상한이 없으면 미래도 없다", () => {
    expect(isFutureIndex(99, offGate())).toBe(false);
  });
});

describe("추종 판정 — 언제 '과거 보는 중'인가", () => {
  it("헤드에 붙어 있으면(허용 오차 안) 계속 따라간다", () => {
    const p = live50();
    expect(atLiveEdge(50, p)).toBe(true);
    expect(atLiveEdge(50 - LIVE_EDGE_TOLERANCE_IDX, p)).toBe(true);
  });

  it("오차 밖으로 뒤로 가면 과거 모드다", () => {
    expect(atLiveEdge(50 - LIVE_EDGE_TOLERANCE_IDX - 1, live50())).toBe(false);
  });

  it("상한이 없는 화면에는 '뒤처짐'이 없다 — 배지를 띄우지 않는다", () => {
    expect(atLiveEdge(0, offGate())).toBe(true);
  });
});

describe("틱 ↔ 인덱스 — 후반 로그(2700~)에서 축이 갈리지 않는다", () => {
  it("절대 틱을 인덱스로 옮겨서 판정한다", () => {
    expect(indexOfTick(H2_TICKS, 2750)).toBe(50);
    expect(tickOfSnapIndex(H2_TICKS, 50)).toBe(2750);
  });

  it("스냅샷을 못 읽는 로그면 인덱스 = 틱 폴백(코어 idxOfTick 폴백과 같은 규칙)", () => {
    expect(indexOfTick([], 754)).toBe(754);
    expect(tickOfSnapIndex([], 754)).toBe(754);
  });

  it("잘리지 않은 요청은 **틱 그대로** 돌려준다 — 인덱스 왕복은 초 정밀도를 뭉갠다(#180)", () => {
    expect(gatedTick(2710, H2_TICKS, live50())).toBe(2710);
  });

  it("미래 요청은 상한 틱으로 잘린다 — 인덱스 52 = 틱 2752", () => {
    expect(gatedTick(2799, H2_TICKS, live50())).toBe(2752);
  });

  it("⚠️ 인덱스를 틱처럼 넘기면 상한이 무의미해진다 — 그 혼동을 계약으로 잡아 둔다", () => {
    // 인덱스 99 를 '틱'으로 넘기면 로그 맨 앞(2700 이전)이라 상한 비교가 늘 참이 된다.
    // 올바른 축(절대 틱 2799)에서만 상한이 실제로 작동한다.
    expect(gatedTick(99, H2_TICKS, live50())).toBe(99);
    expect(gatedTick(2799, H2_TICKS, live50())).toBeLessThan(2799);
  });
});

describe("트랙 기하 — 3구간 + 슬라이더 상한", () => {
  it("슬라이더 최대치는 snapCount-1 이 아니라 **라이브 헤드**다(바 오른쪽 끝 = 스포일러 금지)", () => {
    const g = trackGeometry(20, 50, 100);
    expect(g.maxIndex).toBe(50);
    expect(g.maxIndex).not.toBe(99);
  });

  it("상한이 없으면 트랙 전체가 슬라이더다(종료 화면)", () => {
    const g = trackGeometry(20, null, 100);
    expect(g.maxIndex).toBe(99);
    expect(g.livePct).toBe(100);
    expect(g.locked, "잠긴 구간이 없다").toBe(false);
  });

  it("과거 / 안 본 구간 / 미래가 이어 붙는다", () => {
    const g = trackGeometry(20, 50, 101); // end = 100 → pct = 인덱스와 같은 수
    expect(g.headPct).toBeCloseTo(20, 6);
    expect(g.livePct).toBeCloseTo(50, 6);
    expect(g.reachPct).toBeCloseTo(50, 6);
    expect(g.locked).toBe(true);
  });

  it("헤드가 라이브를 살짝 앞서면 미래 구간은 **헤드부터** 시작한다", () => {
    // 자유 재생의 앞섬(#216 PACE_DRIFT_FRAC 안쪽)은 회수하지 않는다. 그때 미래를 live 에서
    // 시작시키면 헤드가 잠긴 구간 위에 얹혀 화면이 자기모순을 말한다.
    const g = trackGeometry(60, 50, 101);
    expect(g.reachPct).toBeCloseTo(60, 6);
    expect(g.reachPct).toBeGreaterThanOrEqual(g.headPct);
  });

  it("범위 밖 인덱스는 트랙 안으로 접는다", () => {
    expect(withinTrack(-5, 100)).toBe(0);
    expect(withinTrack(1e9, 100)).toBe(99);
    expect(withinTrack(Number.NaN, 100)).toBe(0);
  });
});
