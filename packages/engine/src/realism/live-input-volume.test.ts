import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { pointConfig, aggregateRealism, REALISM_SEEDS } from "./harness";
import { runMatch } from "../match";
import { shotGateXg } from "../decision";
import { loadLiveInputs, runLive, type LiveSample } from "./live-inputs";

/**
 * #370 — **밴드 판정에 라이브 실입력을 상시 포함한다.**
 *
 * 이 파일이 존재하는 이유: 0.28.0 배포에서 실유저 경기 슛이 79% 붕괴(56→12)했는데
 * **엔진의 모든 밴드가 픽스처 입력 전용**이라 어떤 게이트도 그것을 못 잡았다. 60시드는
 * **시드 분산**만 넓히고 **입력 분포는 하나로 고정**이기 때문이다.
 *
 * 계약은 **절대 임계보다 관계식**으로 건다(CLAUDE.md §2). 절대 슛 수는 밸런스 노브가
 * 움직이면 같이 움직이지만, "게이트가 덱을 가로질러 같은 뜻인가"는 노브와 무관한 **구조 성질**이다.
 */

/**
 * ⚠️ **env 게이트(`HMB_LIVE_BAND=1`) — 아직 밴드 게이트에 배선하지 않았다.** (hero 지시, 0.29.5 핫픽스)
 * 0.29.5 는 라이브 배포를 푸는 핫픽스라 게이트를 무겁게 하지 않는다(이 파일 하나가 npm test 에
 * **+96초**). 재발방지 체계(실입력 상시 판정)는 **별도 웨이브**에서 배선한다 — 자산은 여기 그대로
 * 있고, 이 상수만 지우면 켜진다.
 *   HMB_LIVE_BAND=1 npx vitest run packages/engine/src/realism/live-input-volume.test.ts
 */
const BAND = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_LIVE_BAND;
const itLive = BAND ? it : it.skip;
const itLiveFails = BAND ? it.fails : it.skip;

const LIVE = loadLiveInputs();

/** 볼륨 무제어 대조군 = 게이트를 사실상 끈 config(절대 하한만, 상대 게이트 off). */
const GATE_OFF = pointConfig(defaultEngineConfig, {
  "contest.shootXgThreshold": 0.01,
  "contest.shootPosQualityMin": 0,
});

describe("live-input fixtures (#370)", () => {
  itLive("표본이 다양성 기준을 만족한다(한 유저·한 상대·한 포메이션으로 쏠리지 않는다)", () => {
    expect(LIVE.length).toBeGreaterThanOrEqual(12);
    // 문제 경기(라이브 0-0 붕괴)가 **반드시** 들어 있어야 한다 — 이 표본의 존재 이유다.
    const problem = LIVE.filter((s) => s.matchId === "01KYVBW70WZHVAKXGRYE037ZX5");
    expect(problem.map((s) => s.id).sort()).toEqual(["L01", "L02"]);
    expect(new Set(LIVE.map((s) => s.opponentKind)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(LIVE.map((s) => s.formations)).size).toBeGreaterThanOrEqual(5);
    // 익명화 확인: 사람이 붙인 이름이 남아 있으면 안 된다(팀명=side, 선수명=playerId).
    for (const s of LIVE) {
      for (const side of ["home", "away"] as const) {
        expect(s.select[side].name).toBe(side.toUpperCase());
        for (const p of s.select[side].players) expect(p.name).toBe(p.playerId);
      }
      expect(Object.keys(s.home.meta ?? {})).toHaveLength(0);
      expect(Object.keys(s.away.meta ?? {})).toHaveLength(0);
    }
  });

  itLive("익명화는 동작을 바꾸지 않는다(엔진은 이름을 안 읽는다)", () => {
    // 커밋된 표본은 이름을 지운 것이다. 그 조작이 무해했다는 것을 **지금 코드로** 증명한다 —
    // 이름을 아무 문자열로 바꿔도 최종 해시가 같아야 한다(엔진이 읽는 것은 playerId·attributes 뿐).
    const s = LIVE[0]!;
    const renamed: LiveSample = {
      ...s,
      select: {
        home: { name: "어떤 팀", players: s.select.home.players.map((p) => ({ ...p, name: "홍길동" })) },
        away: { name: "another", players: s.select.away.players.map((p) => ({ ...p, name: "x" })) },
      },
    };
    const a = runMatch(s.seed, s.home, s.away, s.select, defaultEngineConfig);
    const b = runMatch(renamed.seed, renamed.home, renamed.away, renamed.select, defaultEngineConfig);
    expect(b.tickSnapshots[b.tickSnapshots.length - 1]!.hash).toBe(
      a.tickSnapshots[a.tickSnapshots.length - 1]!.hash,
    );
  });

  itLive("슛 게이트는 슈터 능력치 스케일에 불변이다 — 같은 위치품질에서 잘린다(#370 근본 성질)", () => {
    // 사고의 기전: 게이트가 비교하는 xg 에는 `attrFactor(shooting)` 이 곱해져 있는데
    // 그 값이 **덱마다 다르다**(라이브 14표본 슈터 평균 shooting 49.8~95.9 = attrFactor 0.998~1.367).
    // 그래서 절대 임계 하나가 덱마다 **다른 위치품질**에서 잘렸다.
    //
    // 관계식: 두 슈터의 실효 임계 비 == 두 슈터의 xg 스케일 비. 즉 위치품질로 환산하면 동일.
    // ⚠️ 변이체 킬: `contest.shootPosQualityMin = 0`(구 절대 게이트)이면 비가 1 이 되어 깨진다.
    const c = defaultEngineConfig;
    const attrF = (v: number) => 0.6 + 0.8 * (v / 100);
    for (const fatigue of [0, 0.5, 1]) {
      const lo = shotGateXg(50, fatigue, c);
      const hi = shotGateXg(95, fatigue, c);
      // 절대 안전 하한에 걸리지 않는 영역에서만 비를 본다(하한은 의도적으로 절대값이다).
      if (lo <= c.contest.shootXgThreshold || hi <= c.contest.shootXgThreshold) continue;
      expect(hi / lo).toBeCloseTo(attrF(95) / attrF(50), 6);
    }
    // 롤백 스위치가 실제로 구 동작(순수 절대 임계)인지도 같이 박제한다.
    const off = pointConfig(c, { "contest.shootPosQualityMin": 0 });
    expect(shotGateXg(50, 0, off)).toBe(off.contest.shootXgThreshold);
    expect(shotGateXg(95, 1, off)).toBe(off.contest.shootXgThreshold);
  });

  itLive("게이트가 픽스처↔실입력 볼륨 격차를 **증폭하지 않는다**", () => {
    // 관계식(절대 임계 아님): 게이트를 켜고 끈 두 상태에서 `픽스처 슛 / 실입력 슛` 비를 잰다.
    // 게이트가 덱 중립이면 이 비는 **변하지 않아야** 한다 — 게이트는 두 레짐에서 같은 비율을 깎는다.
    // 실측(0.29.5): off 32.05/24.18 = 1.33 → on 13.18/9.82 = 1.34 (증폭 1.01배).
    // 구 절대 게이트(0.197)는 13.08/8.18 = **1.60**(증폭 1.20배) — 이 계약이 그것을 잡는다.
    const offFix = aggregateRealism(GATE_OFF, REALISM_SEEDS).mean.shots;
    const offLive = runLive(GATE_OFF, LIVE).meanShots;
    const onFix = aggregateRealism(defaultEngineConfig, REALISM_SEEDS).mean.shots;
    const onLive = runLive(defaultEngineConfig, LIVE).meanShots;
    const rOff = offFix / offLive;
    const rOn = onFix / onLive;
    // eslint-disable-next-line no-console
    console.log(`[#370] amplification: off=${rOff.toFixed(3)} on=${rOn.toFixed(3)} ratio=${(rOn / rOff).toFixed(3)}`);
    expect(rOn / rOff).toBeLessThan(1.1);
  }, 300_000);

  /**
   * ⚠️ **의도적 RED 박제 (it.fails)** — 이 계약은 **아직 통과하지 못한다.** 통과하는 순간
   * 이 테스트가 빨개져서 알려준다(그때 `it.fails` → `it` 로 바꾸고 박제를 해제한다).
   *
   * ## 무엇을 요구하나
   * 볼륨 게이트를 켰을 때, **어떤 실입력 표본도** 볼륨 무제어 대조군 대비 잔존율이
   * 픽스처 잔존율의 절반 밑으로 떨어지지 않을 것. (표본별 잔존율 = 그 경기 총 슛 / 게이트 off 총 슛)
   *
   * ## 왜 지금 실패하나 (#370 잔여 — 근본 수정이 막혀 있다)
   * 능력치 스케일 의존은 `shootPosQualityMin` 이 제거했지만, **위치품질 분포 자체가 덱·매치업마다
   * 다르다**(문제 경기 L01 은 팀 width 0.76 로 넓게 서서 중앙계수 0.848 vs 픽스처 0.930).
   * 그리고 **임계 게이트는 질량의 60% 를 자르는 지점에서 필연적으로 가파르다** — 분포가 조금만
   * 움직여도 잔존율이 급변한다. 실측: 픽스처 41% 잔존 vs L01 **6.9%** 잔존.
   *
   * 근본 해결은 임계가 아니라 **비율 제어**다(그 팀 슛기회 분포의 분위수 = 상위 X% 만 쏜다).
   * 그러면 잔존율이 **구성상** 덱 불변이 된다. 구현하려면 팀별 히스토그램을 `SimState` 에 실어야
   * 하는데, 그 스키마(`packages/server/src/runner/simulate.ts` `SimStateSchema`)는 **다른 모듈의
   * owned-glob** 이라 이 웨이브에서 손댈 수 없다 → 별도 이슈로 올린다.
   */
  itLiveFails("어떤 실입력 표본도 픽스처 대비 절반 미만으로 붕괴하지 않는다 (#370 근본 수정 대기)", () => {
    const off = runLive(GATE_OFF, LIVE);
    const on = runLive(defaultEngineConfig, LIVE);
    const fixRetain =
      aggregateRealism(defaultEngineConfig, REALISM_SEEDS).mean.shots /
      aggregateRealism(GATE_OFF, REALISM_SEEDS).mean.shots;
    const perSample = on.perSample.map((s, i) => {
      const o = off.perSample[i]!;
      const denom = o.shots[0] + o.shots[1];
      return { id: s.id, retain: denom > 0 ? (s.shots[0] + s.shots[1]) / denom : 1 };
    });
    const worst = perSample.reduce((a, b) => (a.retain <= b.retain ? a : b));
    // eslint-disable-next-line no-console
    console.log(
      `[#370] fixture retain=${(fixRetain * 100).toFixed(1)}% worst live=${worst.id} ${(worst.retain * 100).toFixed(1)}% | ` +
        perSample.map((p) => `${p.id}:${(p.retain * 100).toFixed(0)}%`).join(" "),
    );
    expect(worst.retain).toBeGreaterThan(fixRetain * 0.5);
  }, 300_000);
});
