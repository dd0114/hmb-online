import { describe, it, expect } from "vitest";
import {
  MatchClock,
  clampSeek,
  clockOffsetMs,
  compressionOf,
  liveClockForHalf,
  liveTick,
  phaseRemainingMs,
} from "./match-clock.js";

/**
 * 서버 권위 시계 계약 테스트 (P4-E2 #170, LLD-e2-flow-clock §4·§10 T-S-1~3).
 * 여기 함수들은 **재생 게이트**일 뿐이다 — 시뮬 입력에 관여하지 않는다(엔진 결정론 불변, 루트 §2-5).
 */

const T0 = Date.parse("2026-07-25T12:00:00.000Z");
const HALF_REAL_MS = 240_000;
const TICKS = 2700; // 리얼 config: 45분 하프 = 2700틱(msPerTick=1000)

function clock(overrides: Partial<MatchClock> = {}): MatchClock {
  return MatchClock.parse({
    phase: "FIRST_HALF",
    kickoffAt: new Date(T0).toISOString(),
    phaseStartAt: new Date(T0).toISOString(),
    phaseEndsAt: new Date(T0 + HALF_REAL_MS).toISOString(),
    serverNow: new Date(T0).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 60_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
    ...overrides,
  });
}

describe("liveTick — 경과 실시간 → 라이브 상한 틱 (T-S-1)", () => {
  it("킥오프 직후는 0틱", () => {
    expect(liveTick(clock(), T0, TICKS)).toBe(0);
  });

  it("절반 경과면 로그의 절반 지점", () => {
    expect(liveTick(clock(), T0 + HALF_REAL_MS / 2, TICKS)).toBe(TICKS / 2);
  });

  it("창이 끝나면 로그 전체", () => {
    expect(liveTick(clock(), T0 + HALF_REAL_MS, TICKS)).toBe(TICKS);
  });

  it("창을 넘겨도 로그 길이를 넘지 않는다(상한 클램프)", () => {
    expect(liveTick(clock(), T0 + HALF_REAL_MS * 10, TICKS)).toBe(TICKS);
  });

  it("클럭 스큐로 now 가 시작 전이어도 음수 틱이 나오지 않는다(하한 클램프)", () => {
    expect(liveTick(clock(), T0 - 30_000, TICKS)).toBe(0);
  });

  it("clock=null 이면 상한 없음(전체 자유 재생) — T-S-3", () => {
    expect(liveTick(null, T0, TICKS)).toBe(TICKS);
  });

  it("HALFTIME 은 지나간 하프라 상한이 없다(전반 리뷰 자유)", () => {
    expect(liveTick(clock({ phase: "HALFTIME" }), T0, TICKS)).toBe(TICKS);
  });

  it("phaseStartAt/EndsAt 이 없거나(레거시 매치) 창 길이가 0이면 상한 없음", () => {
    expect(liveTick(clock({ phaseStartAt: null, phaseEndsAt: null }), T0, TICKS)).toBe(TICKS);
    const zeroWindow = clock({ phaseEndsAt: new Date(T0).toISOString() });
    expect(liveTick(zeroWindow, T0, TICKS)).toBe(TICKS);
  });

  it("틱 수가 0인 로그면 0", () => {
    expect(liveTick(clock(), T0 + HALF_REAL_MS / 2, 0)).toBe(0);
  });
});

describe("liveClockForHalf — 지금 라이브인 하프에만 시계가 걸린다", () => {
  it("FIRST_HALF 시계는 half 1 에만", () => {
    const c = clock();
    expect(liveClockForHalf(c, 1)).toBe(c);
    expect(liveClockForHalf(c, 2)).toBeNull();
  });

  it("SECOND_HALF 시계는 half 2 에만 — 전반은 이미 지나가 자유", () => {
    const c = clock({ phase: "SECOND_HALF" });
    expect(liveClockForHalf(c, 1)).toBeNull();
    expect(liveClockForHalf(c, 2)).toBe(c);
  });

  it("HALFTIME 은 어느 하프도 게이트하지 않는다", () => {
    const c = clock({ phase: "HALFTIME" });
    expect(liveClockForHalf(c, 1)).toBeNull();
    expect(liveClockForHalf(c, 2)).toBeNull();
  });

  it("clock=null 은 그대로 null", () => {
    expect(liveClockForHalf(null, 1)).toBeNull();
  });
});

describe("clampSeek — 앞서가기 금지·되감기 자유 (T-S-2)", () => {
  const live = 1000;
  const MS_PER_TICK = 1000;

  it("뒤로 감기는 제한 없음", () => {
    expect(clampSeek(10, live, clock(), MS_PER_TICK)).toBe(10);
  });

  it("라이브 상한 + grace 까지만 앞으로", () => {
    // graceMs 1500 / 1000ms per tick = 2틱
    expect(clampSeek(9999, live, clock(), MS_PER_TICK)).toBe(live + 2);
  });

  it("상한 이내 목표는 그대로 통과", () => {
    expect(clampSeek(live, live, clock(), MS_PER_TICK)).toBe(live);
  });

  it("forwardBlocked=false 면 원값 통과(정책 config)", () => {
    expect(clampSeek(9999, live, clock({ seekForwardBlocked: false }), MS_PER_TICK)).toBe(9999);
  });

  it("clock=null 이면 원값 통과 — T-S-3", () => {
    expect(clampSeek(9999, live, null, MS_PER_TICK)).toBe(9999);
  });

  it("음수 목표는 0으로", () => {
    expect(clampSeek(-5, live, clock(), MS_PER_TICK)).toBe(0);
    expect(clampSeek(-5, live, null, MS_PER_TICK)).toBe(0);
  });

  it("msPerTick 이 0/음수여도 죽지 않는다(grace 0 취급)", () => {
    expect(clampSeek(9999, live, clock(), 0)).toBe(live);
  });
});

describe("clockOffsetMs — 클라 시계 스큐 보정", () => {
  it("서버가 앞서면 양수, 뒤지면 음수", () => {
    const c = clock({ serverNow: new Date(T0 + 5_000).toISOString() });
    expect(clockOffsetMs(c, T0)).toBe(5_000);
    expect(clockOffsetMs(c, T0 + 10_000)).toBe(-5_000);
  });

  it("보정을 적용하면 스큐가 있어도 같은 라이브 틱이 나온다", () => {
    // 클라 시계가 60초 빠른 상황: serverNow 는 T0+120s 인데 클라는 T0+180s 라고 믿는다.
    const clientNow = T0 + 180_000;
    const c = clock({ serverNow: new Date(T0 + 120_000).toISOString() });
    const corrected = clientNow + clockOffsetMs(c, clientNow);
    expect(liveTick(c, corrected, TICKS)).toBe(liveTick(c, T0 + 120_000, TICKS));
  });

  it("serverNow 가 깨졌으면 보정 0(화면이 죽지 않게)", () => {
    const c = { ...clock(), serverNow: "not-a-date" } as MatchClock;
    expect(clockOffsetMs(c, T0)).toBe(0);
  });
});

describe("phaseRemainingMs — 감독시간 카운트다운", () => {
  it("남은 시간을 ms 로, 0 아래로는 안 내려간다", () => {
    const c = clock({
      phase: "HALFTIME",
      phaseStartAt: new Date(T0).toISOString(),
      phaseEndsAt: new Date(T0 + 60_000).toISOString(),
    });
    expect(phaseRemainingMs(c, T0)).toBe(60_000);
    expect(phaseRemainingMs(c, T0 + 45_000)).toBe(15_000);
    expect(phaseRemainingMs(c, T0 + 90_000)).toBe(0);
  });

  it("창이 없으면(레거시·clock null) null — 카운트다운 비활성", () => {
    expect(phaseRemainingMs(null, T0)).toBeNull();
    expect(phaseRemainingMs(clock({ phaseEndsAt: null }), T0)).toBeNull();
  });
});

describe("compressionOf — 압축비는 파생값(config 노브는 half-real-ms)", () => {
  it("리얼 config 2700틱 / 240초 = 11.25배", () => {
    expect(compressionOf(clock(), TICKS, 1000)).toBeCloseTo(11.25, 5);
  });

  it("clock 이 없거나 창이 0이면 null(등속 재생)", () => {
    expect(compressionOf(null, TICKS, 1000)).toBeNull();
    expect(compressionOf(clock({ halfRealMs: 0 }), TICKS, 1000)).toBeNull();
  });
});

describe("MatchClock 스키마", () => {
  it("kickoffAt/phase* 는 null 허용(레거시·감독시간 진입 전)", () => {
    expect(() =>
      MatchClock.parse({
        phase: "HALFTIME",
        kickoffAt: null,
        phaseStartAt: null,
        phaseEndsAt: null,
        serverNow: new Date(T0).toISOString(),
        halfRealMs: 240_000,
        halftimeMs: 60_000,
        seekForwardBlocked: true,
        seekGraceMs: 1500,
      }),
    ).not.toThrow();
  });

  it("모르는 phase 는 거부(계약 밖 값이 조용히 통과하지 않게)", () => {
    expect(() => MatchClock.parse({ ...clock(), phase: "EXTRA_TIME" })).toThrow();
  });
});
