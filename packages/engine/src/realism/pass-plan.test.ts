import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setDecisionObserver } from "../action";
import { measurePlanLead, allReadConfig } from "./pass-plan";
import type { SimState } from "../simstate";
import type { MatchLog, TacticalInput } from "@hmb/shared";

/**
 * #369 — **받는 쪽이 패서의 의도를 미리 읽는다.**
 *
 * hero: *"패스를 받는 쪽이 패스하는 사람의 생각을 예측해도 될 것 같아, 둘이 링크되듯이.
 * 선수들은 동료들과 훈련을 했기 때문에 미리 한 단계 앞서 움직인다."*
 *
 * ## 무엇이 없었나 (측정이 아니라 **구조 사실**)
 * `intents` 는 **찬 그 틱에만** 게시됐고(#314), 틱 순서상 오프더볼 결정(③)이 볼 소유자 결정(④)보다
 * **앞**이라 리시버는 언제나 *반응*만 했다. 그래서 패스가 리시버 **발밑**으로만 갔다
 * (리드 거리 p50 3.48m — 스루패스는 10~25m).
 *
 * ## 왜 "발사 전 접근률" 같은 프록시를 안 쓰나
 * W0 에서 그걸 쟀다가 **80.8%** 가 나왔다 — 결손이 없어서가 아니라 도달점이 리시버 발밑이라
 * **평소대로 걷기만 해도 그 거리가 줄기 때문**이다(자기 위치로 정의된 목표에 자기가 가까워지는
 * 것을 세고 있었다). 그래서 여기서는 **예고 게시 시점**을 기준으로만 잰다.
 */

const seeds = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();

const off = (): EngineConfig => ({
  ...defaultEngineConfig,
  movement: {
    ...defaultEngineConfig.movement,
    passPlan: { ...defaultEngineConfig.movement.passPlan, enabled: false },
  },
});

function run(config: EngineConfig, patch?: (t: TacticalInput) => TacticalInput, seed = seeds[0]!): MatchLog {
  const h = patch ? patch(makeTacticalInput("H", seed)) : makeTacticalInput("H", seed);
  const a = patch ? patch(makeTacticalInput("A", seed)) : makeTacticalInput("A", seed);
  return runMatch(seed, h, a, select, config);
}

/** 최종 해시들 — 동작이 실제로 달라졌는지 보는 가장 강한 판정. */
function hashes(config: EngineConfig, patch?: (t: TacticalInput) => TacticalInput): string[] {
  return seeds.map((s) => {
    const log = run(config, patch, s);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

describe("#369 예고 패스 — 리시버가 찰 것 같다를 읽는다", () => {
  it("변이체 킬 — passPlan 을 끄면 경기가 달라진다 (no-op 이면 여기서 걸린다)", () => {
    // ⚠️ 이 계약이 없었으면 **첫 구현의 no-op 을 못 잡았다**: 읽기 결과를 오프더볼 중간에
    // `targetFx` 로 썼는데 그 분기는 맨 끝에서 로컬 tx/ty 를 대입해 **덮어썼다**.
    // tsc 는 통과하고 코드도 "있어" 보인다 — 해시만이 그걸 부정한다.
    expect(hashes(defaultEngineConfig)).not.toEqual(hashes(off()));
  }, 300_000);

  it("**예고가 실제 패스보다 먼저 게시된다** — 선행률이 0 이 아니다", () => {
    // ⚠️ 관찰량을 두 번 갈아탔다(둘 다 로그 기반이라 틀렸다):
    //  ① "패스 틱과 직전 틱의 소유자가 같은가" → 패스 틱엔 소유자가 **null**(공이 떠난다) → 항상 0
    //  ② "패서가 직전 2틱을 들고 있었나" → `pass` 이벤트는 **도착 틱**에 **리시버** id 로
    //     발행된다(`contest.ts:resolveArrival`). 패서를 보고 있다고 생각한 것이 리시버였다.
    // → 로그로 되추론하지 말고 **엔진이 쓴 상태를 그 자리에서** 읽는다(§2-2).
    let plans = 0;
    let launches = 0;
    let launchesWithPlan = 0;
    setDecisionObserver((raw, owner, kind) => {
      const st = raw as SimState;
      const planned = st.intents.filter(
        (i) => i.kind === "pass_plan" && i.side === owner.side && i.expiresTick >= st.tick,
      );
      plans += planned.length > 0 ? 1 : 0;
      if (kind === "pass") {
        launches += 1;
        // 이 틱에 살아 있는 예고가 하나라도 있으면 = 찰 것이 미리 게시돼 있었다.
        if (planned.length > 0) launchesWithPlan += 1;
      }
    });
    try {
      for (const seed of seeds.slice(0, 4)) run(defaultEngineConfig, undefined, seed);
    } finally {
      setDecisionObserver(null);
    }
    expect(launches, "패스 발사 표본").toBeGreaterThan(100);
    expect(plans, "예고가 살아 있던 결정 틱").toBeGreaterThan(50);
    expect(
      launchesWithPlan / launches,
      `예고 선행 패스 ${launchesWithPlan}/${launches}`,
    ).toBeGreaterThan(0.1);
  }, 300_000);

  it("**출하값에서 읽은 리시버가 공보다 먼저 움직인다** — 광고한 동작이 실제로 난다", () => {
    // ⚠️ 이 계약이 이 웨이브에서 가장 중요한 것이다. 변이체 킬(위)은 "경기가 달라진다"만 말하고
    // **"광고한 동작이 나는가"는 말하지 않는다**. 실제로 초판 `pull` 0.45 는 변이체 킬이 green
    // 이면서 읽은 리시버가 도착 예정 지점에서 평균 **2.27m 멀어지고** 있었다 = 기능이 사실상
    // 발화하지 않는 상태. §2.5 새 노브 레지스트리가 세운 기준("값을 바꾸면 경기가 달라진다"가
    // 아니라 "광고한 동작이 출하값에서 난다")을 이 파일에서 집행한다.
    //
    // 안 읽은 리시버(출하 `readBase` 0.35 → 3분의 2)는 자기 역할 자리로 가는 것이 정상이라
    // 평균에 섞이면 기제가 안 보인다 → **전원 읽기 팔**에서 잰다. 출하 빈도는 `readBase` 가 정한다.
    const r = measurePlanLead(allReadConfig(defaultEngineConfig), seeds.slice(0, 2));
    expect(r.launched, "표본(수명 안에 발사된 예고)").toBeGreaterThan(80);
    expect(r.gainAvgM, `발사 전 좁힌 거리 ${r.gainAvgM.toFixed(2)}m`).toBeGreaterThan(0);
    expect(r.gainPosPct, `좁힌 장면 ${r.gainPosPct.toFixed(1)}%`).toBeGreaterThan(30);
  }, 300_000);

  it("능력치가 높은 팀이 더 자주 읽는다 — '훈련된 동료'가 계량된다", () => {
    // 읽기 확률 = readBase + readAttrSwing × ((mental+positioning)/2 − 50)/50.
    // 능력을 바꾸면 **읽는 사람이 달라지므로** 경기가 달라져야 한다. 전원 동일이면
    // 훈련 개념이 없는 것이다(#369 AC).
    const hi = { ...defaultEngineConfig, movement: { ...defaultEngineConfig.movement,
      passPlan: { ...defaultEngineConfig.movement.passPlan, readBase: 1 } } };
    const lo = { ...defaultEngineConfig, movement: { ...defaultEngineConfig.movement,
      passPlan: { ...defaultEngineConfig.movement.passPlan, readBase: 0 } } };
    expect(hashes(hi)).not.toEqual(hashes(lo));
  }, 300_000);

  it("아군만 읽는다 — 상대 예고는 절대 안 읽는다(텔레파시 금지)", () => {
    // 코드 계약: `readPassPlan` 이 `it.side !== player.side` 를 걸러낸다. 그 게이트를 지우면
    // 상대가 읽어 경기가 달라져야 하므로, 여기서는 **소스 수준**으로 박제한다
    // (동작 실험으로는 "상대가 읽는 세계"를 만들 수 없다 — 그런 config 를 안 두는 것이 계약이다).
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "decision.ts"), "utf8");
    expect(src, "readPassPlan 의 아군 필터가 사라졌다").toContain("it.side !== player.side");
  });

  it("결정론 — 읽기가 RNG 스트림을 소비하지 않는다(시드 노이즈)", () => {
    // `varietyNoise` 는 상태의 순수 함수라 스트림을 안 건드린다. 그 성질은 resume 동일성이
    // 지키지만(별도 계약), 여기서는 **소스 수준**으로 "Rng 를 안 쓴다"를 박제한다 —
    // #369 가 "후보 수 비례 RNG 소비 → 재개 계약 취약"을 명시적으로 경고했다.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "decision.ts"), "utf8");
    const fn = src.slice(src.indexOf("function readPassPlan"), src.indexOf("/**\n * `duty` 배수"));
    expect(fn).toContain("varietyNoise");
    expect(fn, "readPassPlan 이 Rng 를 쓰기 시작했다 — 재개 계약이 취약해진다").not.toContain("rng");
  });
});
