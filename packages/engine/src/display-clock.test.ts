import { describe, expect, it } from "vitest";
import { runMatch, runFirstHalf, resumeSecondHalf } from "./match";
import { defaultEngineConfig } from "./config";
import { makeSelectData, makeTacticalInput } from "./fixtures";

/**
 * **표기 시계는 경기 길이와 분리된다** (#365).
 *
 * hero 스펙: *"시간 표기는 축구 시간처럼 0~90으로 가지만 절대 시간은 3분으로 끝나게."*
 * 즉 경기를 45분으로 줄여도(하프 1350틱) 화면 시계는 계속 0~90' 이어야 한다.
 *
 * 이 축을 **엔진에 두는 이유**: `minute` 은 `TickSnapshot`·`MatchEvent` 에 구워져 로그에 실리고,
 * 소비자가 넷이다(뷰어 시계 · viewer-core `log-lines` · web `LogPanel` · 타임라인 핀). 전부 그
 * 구워진 값을 읽으므로 여기 한 곳이면 전 화면이 따라온다. 표시 계층에서 곱하면 같은 규칙이 넷으로
 * 복제되고 새 소비자가 생길 때마다 조용히 빠진다. (리포 전체에서 분을 파생하는 곳은 `match.ts` 하나다.)
 *
 * 계약은 세 가지다:
 *  ① 표기가 `displayMinutes` 를 끝까지 채운다(하프 = 절반, 종료 = 전체).
 *  ② `full_whistle` 도 같은 규칙을 탄다 — 이 이벤트만 `config.matchMinutes` 를 직접 쓰고 있었다.
 *     (그대로 두면 다른 이벤트는 0~90 인데 **종료 휘슬만 45'** 로 뜬다.)
 *  ③ `displayMinutes === matchMinutes` 면 스케일 1 = 기존 동작과 **완전히 동일**(no-op 롤백 경로).
 */

const SEED = "display-clock";
const select = makeSelectData();
const inputs = () => [makeTacticalInput("H", SEED), makeTacticalInput("A", SEED)] as const;

/** 45분 경기 + 90분 표기(스케일 2) — #365 의 목표 지점. */
const scaled = { ...defaultEngineConfig, matchMinutes: 45, displayMinutes: 90 };
/** 같은 경기 길이, 표기 스케일 없음(대조군). */
const unscaled = { ...defaultEngineConfig, matchMinutes: 45, displayMinutes: 45 };

describe("#365 표기 시계 — 경기 길이와 분리", () => {
  it("45분 경기의 표기가 0~90' 를 채운다 (하프 45' · 종료 90')", () => {
    const [home, away] = inputs();
    const log = runMatch(SEED, home, away, select, scaled);

    const half = log.events.find((e) => e.type === "half_whistle");
    const full = log.events.find((e) => e.type === "full_whistle");
    expect(half?.minute).toBe(45);
    expect(full?.minute).toBe(90);

    // 스냅샷 시계도 같은 규칙 — 표기 1분 = 30틱(스케일 2, msPerTick 1000).
    const at = (t: number) => log.tickSnapshots.find((s) => s.tick === t)?.minute;
    expect(at(0)).toBe(0);
    expect(at(29)).toBe(0);
    expect(at(30)).toBe(1);
    expect(at(1350)).toBe(45);
    expect(log.tickSnapshots[log.tickSnapshots.length - 1]!.minute).toBe(89);
  });

  it("표기 스케일이 없으면 같은 경기가 0~45' 로 표시된다 (스케일이 실제로 일하는지)", () => {
    const [home, away] = inputs();
    const log = runMatch(SEED, home, away, select, unscaled);
    expect(log.events.find((e) => e.type === "half_whistle")?.minute).toBe(22);
    expect(log.events.find((e) => e.type === "full_whistle")?.minute).toBe(45);
  });

  it("표기는 시뮬레이션을 바꾸지 않는다 — 스케일 유무로 해시가 동일하다", () => {
    const [home, away] = inputs();
    const a = runMatch(SEED, home, away, select, scaled);
    const b = runMatch(SEED, home, away, select, unscaled);
    const last = (l: typeof a) => l.tickSnapshots[l.tickSnapshots.length - 1]!.hash;
    expect(last(a)).toBe(last(b));
    expect(a.tickSnapshots.length).toBe(b.tickSnapshots.length);
  });

  it("`displayMinutes` 미지정이면 기존 동작(스케일 1) — 롤백 경로", () => {
    const [home, away] = inputs();
    const legacy = { ...defaultEngineConfig, matchMinutes: 45 } as typeof defaultEngineConfig;
    delete (legacy as { displayMinutes?: number }).displayMinutes;
    const log = runMatch(SEED, home, away, select, legacy);
    expect(log.events.find((e) => e.type === "full_whistle")?.minute).toBe(45);
  });

  it("재개(하프 분할)도 통짜와 같은 표기를 낸다", () => {
    const [home, away] = inputs();
    const carry = runFirstHalf(SEED, home, away, select, scaled);
    expect(carry.events.find((e) => e.type === "half_whistle")?.minute).toBe(45);
    const full = resumeSecondHalf(carry, home, away);
    expect(full.events.find((e) => e.type === "full_whistle")?.minute).toBe(90);
  });
});
