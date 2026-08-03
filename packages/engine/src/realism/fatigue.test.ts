import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { preShipping } from "./rollback";
import { collectFatigue, formatFatigue } from "./fatigue";

/**
 * #346 — **피로 곡선이 단조 포화가 아니다.**
 *
 * 구 모델: `fatigue += fatiguePerTick × exertion` 단조 증가 · 회복 항 0 · 하프타임 리셋 없음.
 * `1/0.0009 = 1112틱` 이면 1.0 → **경기의 79.4% 가 전 아웃필더 fatigue = 1.0(전원 동일)**.
 * 그 구간에서는 선수 간 차이도, 시간 경과에 따른 변화도 없다. 그런데 fatigue 는
 * 이동속도(×0.55) · xG(×0.70) · 드리블(×0.60) · 공중경합(×0.75) · 사슬 EV 에 **곱해지는 승수**라,
 * 경기의 79% 가 "전원 최대 피로"라는 **상수** 위에서 돌고 있었다.
 * 그래서 하프타임 교체(≤3)도 컨디션(Phase 2)도 `stamina`(#337)도 닿을 자리가 없었다.
 *
 * ## 왜 밴드가 아니라 성질로 거나
 * "평균 피로 0.4" 같은 절대값은 계수 튜닝(트랙 T)이 움직일 값이다. 이 계약이 지켜야 하는 것은
 * 계수가 아니라 **모델의 성질**이다 — 회복이 존재하고, 선수마다 다르고, 하프타임에 내려간다.
 * 그래서 임계는 전부 "0 이냐 아니냐" 쪽에 붙였고 계수 변화에 견딘다.
 */

const seeds = REALISM_SEEDS.slice(0, 8);

/**
 * #346 이전 모델(롤백 스위치) — 변이체 킬 대조군.
 *
 * ⚠️ **#407(0.44.0) 기준점 이동** — 이 대조군의 임계(포화 40%)는 **0.44.0 이전 출하값에서 실측**한
 * 것이다(당시 45.1%). 박스 유입 팔은 config-only 지만 오프더볼 목표를 바꿔 **주행·피로 분포를
 * 건드리므로**, 되돌리지 않으면 이 대조군이 "구 모델이 포화하는가"가 아니라 "그 뒤로 튜닝이
 * 있었는가"를 재게 된다(실측: 미적용 시 39.96% 로 임계를 **0.04 차이로** 밑돈다).
 * 처방·사유는 `realism/rollback.ts` 상단과 동일하다.
 */
const legacyCfg = (): EngineConfig => {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  c.fatigue.recoveryEnabled = false;
  preShipping(c);
  return c;
};

const now = collectFatigue(defaultEngineConfig, seeds);

describe("#346 피로 경제 — 회복이 있다", () => {
  it("전원 포화(모든 아웃필더 = 1.0)인 틱이 사실상 없다", () => {
    // eslint-disable-next-line no-console
    console.log("\n" + formatFatigue("#346 피로 (기본 config, 8시드)", now) + "\n");
    expect(now.allSaturatedPct).toBeLessThan(1);
  });

  it("피로가 실제로 **내려가는** 틱이 있다 (회복 항 존재)", () => {
    expect(now.recoveredTickPct).toBeGreaterThan(20);
  });

  it("선수마다 피로가 다르다 — 경기 종료 시점 산포가 0 이 아니다", () => {
    expect(now.endSpread).toBeGreaterThan(0.05);
    expect(now.meanSpread).toBeGreaterThan(0.03);
  });

  it("하프타임에 피로가 내려간다 (교체·컨디션이 닿을 자리)", () => {
    expect(now.halfTimeDrop).not.toBeNull();
    expect(now.halfTimeDrop!).toBeLessThan(0);
  });

  it("그래도 피로는 쌓인다 — 개인 최고 피로가 0 이 아니다(회복이 부하를 지우지 않는다)", () => {
    expect(now.meanPeak).toBeGreaterThan(0.1);
  });
});

describe("#346 변이체 킬 — recoveryEnabled 를 끄면 구 모델(단조 포화)로 돌아간다", () => {
  const legacy = collectFatigue(legacyCfg(), seeds);

  it("구 모델은 경기의 40% 넘게 전원 포화이고, 내려가는 틱이 0 이다", () => {
    // eslint-disable-next-line no-console
    console.log("\n" + formatFatigue("#346 대조군 (recoveryEnabled=false)", legacy) + "\n");
    // ⚠️ #346 본문의 "79.4%" 는 **90분 레짐**(5400틱) 수치다. 45분(2700틱)에서는 포화 시점
    // 1112틱이 경기의 41% 라 남는 포화 구간이 59% 이고, "**모든** 아웃필더가 정확히 1.0"까지
    // 요구하면 실측 45.1% 다. 임계는 그 실측 아래로 잡는다(레짐이 바뀌어도 성질은 남는다).
    expect(legacy.allSaturatedPct).toBeGreaterThan(40);
    expect(legacy.recoveredTickPct).toBe(0);
    // 포화 구간에서는 전원이 정확히 같은 값이라 종료 시점 산포가 0 이다 — "전원 동일"의 직접 증거.
    expect(legacy.endSpread).toBe(0);
  }, 600_000);
});
