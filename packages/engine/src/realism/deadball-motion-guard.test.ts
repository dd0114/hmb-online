import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../match";
import { defaultEngineConfig } from "../config";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { measureDeadBallMotion } from "./deadball-motion";

/**
 * `realism/deadball-motion` 의 **순간 재배치 제외 가드** 계약 (#377 M3-B, 독립검증 m4).
 *
 * ## 왜 있나 — 그 가드는 지금 **어디서도 발화하지 않는다**
 * #379 M3-B 가 넣은 `repositionM` 배제(물리 상한 7 m/tick 을 넘는 변위는 *달린 것*이 아니라
 * **킥오프 포메이션 리셋**이므로 속도 표본에서 뺀다)는 실제 오탐을 고치고 들어왔다. 그런데 그
 * 소비자들의 입력에서는 **한 번도 안 탄다** — 60시드 GUARD 두 팔 · 4시드 restart-gate 두 팔 ·
 * 6시드 h3-ablate 전부 `repositions = 0` 이다. 즉 이 가드가 조용히 깨져도(또는 반대로 정상
 * 주행까지 삼키기 시작해도) 아무 계약도 빨간불을 켜지 않는다.
 *
 * ## 그래서 **양방향을 합성 로그로 직접 태운다**
 * M3-A 의 `tools/qa-match-guard.test.ts` 와 같은 처리다: 실 로그를 베이스로 **딱 한 선수의
 * 한 지점만** 조작해 두 세계를 만든다.
 *  - 변위가 임계 **위**면 → 제외된다(속도 표본에 안 들어간다).
 *  - 변위가 임계 **아래**면 → **잡힌다**. 가드가 전부를 봐주는 게 아니다.
 *
 * ## 왜 합성인가
 * "어떤 시드에 하프 끝 골→킥오프 겹침이 있다"에 기대면 시드 재선정 때마다 계약이 증발한다
 * (실제로 이 웨이브에서 e2e·PK 시드가 둘 다 움직였다). 두 세계를 **만들어서** 태운다.
 *
 * ## 단언은 **가드의 판정만** 겨냥한다
 * 합성 변위는 왕복(`jitterPer100`)·정지비율 같은 다른 지표도 건드린다 — 그쪽을 단언하면 가드가
 * 아니라 엉뚱한 것을 붙들게 된다(M3-A 가 실제로 한 번 그랬다). 그래서 보는 것은 셋뿐이다:
 * `repositions`(가드가 셌나) · `maxStepM`(그 프레임이 속도 표본에 들어갔나) · `samples`(표본 보존).
 */

const select = makeSelectData();
const seed = REALISM_SEEDS[0]!;
const BASE: MatchLog = runMatch(
  seed,
  makeTacticalInput("H", seed),
  makeTacticalInput("A", seed),
  select,
  defaultEngineConfig,
);

/** 기본 임계(m/tick) = `speed.maxPerTick` + 0.5. 하드코딩하지 않고 config 에서 온다. */
const REPOSITION_M = defaultEngineConfig.speed.maxPerTick + 0.5;
/** 임계 **위** 변위 — 실제 킥오프 리셋에서 관측된 크기대(9.15 m/tick). */
const OVER_M = REPOSITION_M + 1.65;
/** 임계 **아래** 변위 — 사람이 달릴 수 있는 크기. */
const UNDER_M = REPOSITION_M - 0.5;

/**
 * 한 선수를 `fromTick` 부터 `span` 틱 동안 x 로 `dx` 만큼 옮긴다.
 *
 * **연속으로** 옮기는 것이 핵심이다 — 한 틱만 옮기면 되돌아오는 프레임이 하나 더 생겨 변위
 * 불연속이 둘이 된다. 연속 오프셋이면 불연속은 `fromTick` 하나뿐이라 "그 한 프레임을 가드가
 * 어떻게 처리했나"만 남는다.
 */
function injectStep(dx: number, fromTick: number, span = 45): MatchLog {
  const log = structuredClone(BASE) as MatchLog;
  const first = log.tickSnapshots[0]!.players[5]!;
  for (const s of log.tickSnapshots) {
    if (s.tick < fromTick || s.tick > fromTick + span) continue;
    const p = s.players.find((q) => q.playerId === first.playerId && q.team === first.team);
    if (p) p.pos = { x: p.pos.x + dx, y: p.pos.y };
  }
  return log;
}

/**
 * 주입 지점을 **유틸 자신을 신탁으로 삼아** 찾는다 — 정지 창의 경계 조건을 이 파일이 다시
 * 구현하면 그 복제본이 스테일해져서 "창이 아닌 틱에 주입해 놓고 통과"가 성립한다.
 * 배제를 끈(`repositionM: Infinity`) 측정에서 그 변위가 실제로 잡히면 = 그 틱이 표본 안이다.
 */
function findInjectableTick(): number {
  for (const e of BASE.events) {
    if (e.type !== "free_kick" && e.type !== "penalty" && e.type !== "kickoff") continue;
    const t = e.tick + 1; // 창의 첫 틱은 직전 위치가 없어 변위가 안 잡힌다.
    const m = measureDeadBallMotion(injectStep(OVER_M, t), { repositionM: Infinity });
    if (m.maxStepM >= OVER_M) return t;
  }
  throw new Error("정지 창 안에 주입 가능한 틱이 없다 — 베이스 시드 재선정 필요");
}

describe("#377 M3-B — deadball-motion 순간 재배치 제외 가드", () => {
  const baseline = measureDeadBallMotion(BASE);
  const tick = findInjectableTick();

  it("사전조건 — 베이스 로그에 실제 표본이 있다 (빈 표본이 조용히 통과하지 않게)", () => {
    expect(baseline.windows, "정지 창 0").toBeGreaterThan(0);
    expect(baseline.samples, "속도 표본 0").toBeGreaterThan(0);
    expect(baseline.maxStepM, `베이스 maxStep ${baseline.maxStepM} 이 이미 임계 위다`).toBeLessThan(REPOSITION_M);
  });

  it(`임계 위(${OVER_M} m/tick)면 **제외된다** — 속도 표본에 안 들어간다`, () => {
    const m = measureDeadBallMotion(injectStep(OVER_M, tick));
    expect(m.repositions, "재배치로 세지 않았다").toBeGreaterThanOrEqual(1);
    expect(
      m.maxStepM,
      `주입 후 maxStep ${m.maxStepM} — 텔레포트가 속도 표본에 들어갔다(베이스 ${baseline.maxStepM})`,
    ).toBe(baseline.maxStepM);
    // 표본 보존: 뺀 개수가 정확히 센 개수와 같다(가드가 옆 프레임까지 삼키지 않는다).
    expect(m.samples).toBe(baseline.samples - m.repositions);
  });

  it(`임계 아래(${UNDER_M} m/tick)면 **잡힌다** — 가드가 전부를 봐주는 게 아니다`, () => {
    const m = measureDeadBallMotion(injectStep(UNDER_M, tick));
    expect(m.repositions, "달릴 수 있는 변위를 재배치로 배제했다").toBe(0);
    expect(
      m.maxStepM,
      `주입 후 maxStep ${m.maxStepM} — 임계 아래 변위가 표본에서 사라졌다`,
    ).toBeGreaterThanOrEqual(UNDER_M);
    expect(m.samples).toBe(baseline.samples);
  });

  it("임계는 config 에서 온다 — 올려 주면 같은 프레임이 다시 잡힌다", () => {
    // "임계 위/아래"가 상수가 아니라 `repositionM` 의 함수임을 박는다(변이체 킬).
    const m = measureDeadBallMotion(injectStep(OVER_M, tick), { repositionM: OVER_M + 1 });
    expect(m.repositions).toBe(0);
    expect(m.maxStepM).toBeGreaterThanOrEqual(OVER_M);
  });
});
