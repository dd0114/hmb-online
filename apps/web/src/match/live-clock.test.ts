import { describe, expect, it } from "vitest";
import type { MatchClock } from "@hmb/shared";
import {
  captureOffsetMs,
  countdownLabel,
  liveGate,
  logAvailableFor,
  MS_PER_TICK,
  pollIntervalFor,
} from "./live-clock";

/**
 * P4-E2 W3 (#170) — web 이 서버 시계를 소비하는 규칙. 시각→틱 매핑 자체는 @hmb/shared
 * (match-clock)가 SoT 이고, 여기서는 **화면이 그걸 어떻게 쓰는가**를 박제한다.
 */

const T0 = Date.parse("2026-07-25T12:00:00.000Z");
const HALF_REAL_MS = 240_000;
const TICKS = 2700;

function clock(over: Partial<MatchClock> = {}): MatchClock {
  return {
    phase: "FIRST_HALF",
    kickoffAt: new Date(T0).toISOString(),
    phaseStartAt: new Date(T0).toISOString(),
    phaseEndsAt: new Date(T0 + HALF_REAL_MS).toISOString(),
    serverNow: new Date(T0).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 60_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
    ...over,
  } as MatchClock;
}

describe("pollIntervalFor — 라이브 단계는 자주, 생성 단계는 덜, 나머지는 안 한다", () => {
  it("라이브(전반/감독시간/후반)는 1초", () => {
    for (const s of ["FIRST_HALF", "HALFTIME", "SECOND_HALF"]) {
      expect(pollIntervalFor(s)).toBe(1000);
    }
  });

  // #193 — 새 플로우 실측(킥오프→관전 6~14s, 하프타임→후반 0.3s)에서 3초 격자는 대기의 최대
  // ~25% 를 폴링 대기로 더한다. 생성 단계도 라이브와 같은 1초로 내린다.
  it("생성(GEN1/GEN2)은 1초 — 대기가 6~14초라 3초 격자는 과대(#193)", () => {
    expect(pollIntervalFor("GEN1")).toBe(1000);
    expect(pollIntervalFor("GEN2")).toBe(1000);
  });

  it("생성 폴링 격자는 실측 최단 대기(6초)의 1/4 이하 — 상태 전환이 격자에 묻히지 않는다", () => {
    const gen = pollIntervalFor("GEN1");
    expect(typeof gen).toBe("number");
    expect(gen as number).toBeLessThanOrEqual(6000 / 4);
  });

  it("브리핑·종료·실패·미지 상태는 폴링하지 않는다", () => {
    for (const s of ["BRIEFING", "FINISHED", "FAILED", "H1_BREAK", undefined]) {
      expect(pollIntervalFor(s)).toBe(false);
    }
  });
});

describe("logAvailableFor — 서버가 409 를 줄 조합은 아예 요청하지 않는다", () => {
  it("전반 로그는 전반이 열린 뒤부터 계속", () => {
    for (const s of ["FIRST_HALF", "HALFTIME", "H1_BREAK", "GEN2", "SECOND_HALF", "FINISHED"]) {
      expect(logAvailableFor(s, 1)).toBe(true);
    }
    for (const s of ["BRIEFING", "GEN1", "FAILED"]) {
      expect(logAvailableFor(s, 1)).toBe(false);
    }
  });

  it("후반 로그는 후반이 열린 뒤부터 — 감독시간에 미리 못 본다(스포일러 금지)", () => {
    expect(logAvailableFor("SECOND_HALF", 2)).toBe(true);
    expect(logAvailableFor("FINISHED", 2)).toBe(true);
    for (const s of ["FIRST_HALF", "HALFTIME", "GEN2"]) {
      expect(logAvailableFor(s, 2)).toBe(false);
    }
  });
});

describe("countdownLabel", () => {
  it("분:초 표기, 0 아래로 안 내려간다", () => {
    expect(countdownLabel(60_000)).toBe("1:00");
    expect(countdownLabel(59_000)).toBe("0:59");
    // 남은 시간을 깎아 말하지 않는다(올림) — 59.4초는 아직 1분 쪽이다.
    expect(countdownLabel(59_400)).toBe("1:00");
    expect(countdownLabel(1)).toBe("0:01");
    expect(countdownLabel(0)).toBe("0:00");
    expect(countdownLabel(-5_000)).toBe("0:00");
  });

  it("시계가 없으면 null(카운트다운 비활성)", () => {
    expect(countdownLabel(null)).toBeNull();
  });
});

describe("liveGate — 늦게 접속하면 경과 시점부터, 앞서가기는 막는다 (AC-W3-1)", () => {
  it("전반 라이브: 2분 경과면 그 지점이 상한이자 시작 위치", () => {
    const gate = liveGate(clock(), 1, TICKS, T0 + 120_000);
    expect(gate.isLive).toBe(true);
    expect(gate.liveTick).toBe(TICKS / 2);
    expect(gate.clamp(TICKS)).toBe(TICKS / 2 + 2); // grace 1500ms = 2틱
    expect(gate.clamp(10)).toBe(10); // 되감기는 자유
  });

  it("클라 시계가 3분 빨라도 같은 지점 — 오프셋은 응답 도착 시점에 한 번 잰다", () => {
    // 정확한 클라: 폴링 시각 = 서버 시각(T0), 그로부터 120초 뒤를 렌더.
    const accurate = liveGate(clock(), 1, TICKS, T0 + 120_000, captureOffsetMs(clock(), T0));
    // 3분 빠른 클라: 같은 응답을 자기 시계 T0+180s 에 받았고, 그로부터 120초 뒤를 렌더.
    const fast = liveGate(clock(), 1, TICKS, T0 + 300_000, captureOffsetMs(clock(), T0 + 180_000));
    expect(fast.liveTick).toBe(accurate.liveTick);
    expect(accurate.liveTick).toBe(TICKS / 2);
  });

  it("오프셋을 매 프레임 다시 재면 시계가 멈춘다 — 그래서 capture 는 폴링 때 한 번뿐", () => {
    const frozen = liveGate(clock(), 1, TICKS, T0 + 120_000, captureOffsetMs(clock(), T0 + 120_000));
    expect(frozen.liveTick).toBe(0); // serverNow(T0)에 고정된 잘못된 사용법의 결과
  });

  it("지나간 하프(전반을 후반 중에 보기)는 게이트하지 않는다", () => {
    const gate = liveGate(clock({ phase: "SECOND_HALF" }), 1, TICKS, T0);
    expect(gate.isLive).toBe(false);
    expect(gate.liveTick).toBe(TICKS);
    expect(gate.clamp(TICKS)).toBe(TICKS);
  });

  it("감독시간에는 전반 전체가 자유(리뷰)", () => {
    const gate = liveGate(clock({ phase: "HALFTIME" }), 1, TICKS, T0);
    expect(gate.isLive).toBe(false);
    expect(gate.clamp(TICKS)).toBe(TICKS);
  });

  it("clock 이 없으면(레거시·롤백·종료) 제한 없음", () => {
    const gate = liveGate(null, 1, TICKS, T0);
    expect(gate.isLive).toBe(false);
    expect(gate.liveTick).toBe(TICKS);
    expect(gate.clamp(9999)).toBe(9999);
  });

  it("clamp 는 정수 틱만 낸다 — 뷰어에 소수 틱을 넣지 않는다", () => {
    const gate = liveGate(clock(), 1, TICKS, T0 + 120_000);
    expect(Number.isInteger(gate.clamp(10.7))).toBe(true);
    expect(gate.clamp(10.7)).toBe(10);
  });

  it("재생 속도는 압축비 — 상한에 자연히 붙어 되돌림이 안 생기게", () => {
    const gate = liveGate(clock(), 1, TICKS, T0);
    expect(gate.speed).toBeCloseTo((TICKS * MS_PER_TICK) / HALF_REAL_MS, 5);
    expect(liveGate(null, 1, TICKS, T0).speed).toBeNull();
  });
});
