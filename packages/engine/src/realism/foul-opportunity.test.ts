import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { GUARD_SEEDS } from "./harness";
import { collectFoul, type FoulBreakdown } from "./foul";
import { legacy0270 } from "./rollback";

/**
 * #358 — **파울 기회(분모) 계약**.
 *
 * ## 이 파일이 존재하는 이유
 * 파울은 12.63(0.23.0) → 6.43 → 5.88 → 1.95 → 2.15 로 **네 웨이브에 걸쳐 6분의 1** 이 됐는데
 * `npm test` 는 한 번도 빨개지지 않았다. `grep`: 파울에 대한 단언은 `behaviour.test.ts` 의
 * **비율 하나**(걷어내기 on/off 대조)뿐이었고 **절대 게이트가 없었다**. #327 이 스로인에서
 * 똑같은 구멍을 만나 절대 밴드를 세운 것과 같은 자리다.
 *
 * ## 무엇을 박는가
 * 절대 밴드 하나 + **관계식 셋**. 관계식은 전부 대조군을 실제로 돌려 비교한다(내 튜닝 결과를
 * 임계로 삼지 않는다):
 *  ① 파울/팀 절대 밴드 — 없어서 놓쳤다.
 *  ② **파울은 "초"가 아니라 "교전"에 붙는다** — 체류 시간이 3배 다른 두 config 를 돌려,
 *    파울 비가 태클-시도(=체류 틱) 비보다 **1 에 가깝다**.
 *  ③ **휘슬은 달리는 선수 위에서도 울린다** — 드리블 틱의 시도당 파울률 > hold 틱의 시도당 파울률.
 *  ④ PK 상한 — 파울 총량을 올릴 때 박스 배수를 안 내리면 골이 폭증한다(실측 8.77골/경기).
 *
 * ②③은 `rules.foul.runningMult` 를 1 로 되돌리면 **깨진다**(변이체 킬 — 아래 각 it 주석에 실측).
 */

const SEEDS = GUARD_SEEDS;

function withFoul(base: EngineConfig, over: Partial<EngineConfig["rules"]["foul"]>): EngineConfig {
  return { ...base, rules: { ...base.rules, foul: { ...base.rules.foul, ...over } } };
}

const cur: FoulBreakdown = collectFoul(defaultEngineConfig, SEEDS);
/** 체류 시간이 크게 다른 대조군(#353/#357 이전) — 같은 파울 노브를 얹어 **모델만** 비교한다. */
const slowCfg = withFoul(legacy0270(), {
  base: defaultEngineConfig.rules.foul.base,
  boxFoulMult: defaultEngineConfig.rules.foul.boxFoulMult,
  runningMult: defaultEngineConfig.rules.foul.runningMult,
});
const slow: FoulBreakdown = collectFoul(slowCfg, SEEDS);

/** |log(x)| — 1 로부터의 거리(비율의 방향 무관 비교). */
function logDist(x: number): number {
  return Math.abs(Math.log(x));
}

describe("#358 파울 기회 계약", () => {
  it("① 파울/팀 이 밴드 안이다 (벤치 11–12)", () => {
    const perTeam = cur.ev.foul / cur.matches / 2;
    // eslint-disable-next-line no-console
    console.log(
      `  [#358] 파울 ${perTeam.toFixed(2)}/팀경기 · 태클시도 ${(cur.attempts / cur.matches).toFixed(0)}/경기 · ` +
        `시도당 ${((cur.fouls / cur.attempts) * 100).toFixed(2)}% · PK ${(cur.ev.penalty / cur.matches).toFixed(2)}/경기 · ` +
        `옐로 ${(cur.ev.yellow / cur.matches / 2).toFixed(2)}/팀`,
    );
    // 게이트 폭은 #327 스로인 선례를 따른다(벤치 17–19 → 게이트 15–21, 밴드 밖 ±2).
    // 60시드에서 팀-경기 표본은 120 이고 SE(파울) ≈ 0.3 이라 ±1.5 는 ~5σ = 시드 노이즈가 아니라
    // **회귀**만 잡는다. 밴드 자체(11–12)는 넓히지 않았다.
    expect(perTeam, `파울 ${perTeam.toFixed(2)}/팀경기`).toBeGreaterThanOrEqual(9.5);
    expect(perTeam, `파울 ${perTeam.toFixed(2)}/팀경기`).toBeLessThanOrEqual(13.5);
  }, 1_800_000);

  it("② 파울 수가 '체류 시간'보다 '교전'을 따라간다 (대조군 대비 관계식)", () => {
    const attemptRatio = cur.attempts / slow.attempts;
    const foulRatio = cur.fouls / slow.fouls;
    // eslint-disable-next-line no-console
    console.log(
      `  [#358] 대조군(체류↑) 시도 ${(slow.attempts / slow.matches).toFixed(0)}/경기 · 파울 ${(slow.ev.foul / slow.matches / 2).toFixed(2)}/팀 → ` +
        `시도비 ${attemptRatio.toFixed(3)} vs 파울비 ${foulRatio.toFixed(3)}`,
    );
    // 대조군은 소유자가 압박을 견디고 서 있어(hold 88%) 태클 시도가 4배 넘게 쌓인다.
    // 구 모델(틱당 균일 확률)에서는 파울비 == 시도비 였다 — 즉 파울이 **템포의 함수**였다.
    // `runningMult` 는 hold↔dribble 축을 따라 반대로 움직이므로 파울비가 1 쪽으로 당겨진다.
    // ⚠️ 변이체 킬(실측): `runningMult: 10` → 시도비 0.326 · 파울비 **0.530**(거리 0.635 < 0.729)
    //    `runningMult: 1`  → 시도비 0.326 · 파울비 **0.434**(거리 0.835 > 0.729 = 실패).
    //    분리 폭이 넓지 않은 이유는 대조군에도 같은 배수를 얹기 때문이다(모델만 비교하려면 그래야
    //    한다) — 대조군은 드리블 틱이 11.9% 뿐이라 배수가 거의 안 걸린다. 그게 이 계약의 원리다.
    expect(logDist(foulRatio), `파울비 ${foulRatio.toFixed(3)} / 시도비 ${attemptRatio.toFixed(3)}`)
      .toBeLessThan(logDist(attemptRatio) * 0.65);
  }, 1_800_000);

  it("③ 달리는 캐리어를 끊는 태클이 서 있는 선수 옆보다 파울이 잦다", () => {
    const dribRate = cur.foulsByKind.dribble / Math.max(1, cur.attemptsByKind.dribble);
    const holdRate = cur.foulsByKind.hold / Math.max(1, cur.attemptsByKind.hold);
    const share = cur.foulsByKind.dribble / Math.max(1, cur.foulsByKind.dribble + cur.foulsByKind.hold);
    // eslint-disable-next-line no-console
    console.log(
      `  [#358] 시도당 파울 — dribble ${(dribRate * 100).toFixed(2)}% vs hold ${(holdRate * 100).toFixed(2)}% · ` +
        `파울 중 달리는 중 ${(share * 100).toFixed(0)}%`,
    );
    // 절대 임계가 아니라 **두 국면의 대소**다. 실축의 파울은 대부분 전진을 끊는 것이고,
    // 이 계약이 없으면 `base` 만 올려 "가만히 선 선수 위에서 울리는 휘슬"로 숫자를 맞출 수 있다
    // (그 상태 실측: 파울의 90%가 hold).
    // ⚠️ 변이체 킬(실측): `runningMult: 10` → dribble 35.27% vs hold 8.25%(파울의 39%가 달리는 중).
    //    `runningMult: 1`  → dribble **5.25% vs hold 9.56%** = **역전**(달리는 중 9%). 역전하는 이유는
    //    드리블이 골 쪽으로 가서 박스 비중이 높고 `boxFoulMult`(0.06)가 그쪽을 더 깎기 때문이다 —
    //    즉 배수가 없으면 파울은 구조적으로 **정지한 선수 쪽으로 쏠린다**.
    expect(dribRate, `dribble ${dribRate} vs hold ${holdRate}`).toBeGreaterThan(holdRate * 2);
    expect(share, `파울 중 달리는 중 비율 ${share}`).toBeGreaterThan(0.2);
  }, 1_800_000);

  it("④ PK 가 파울 총량을 따라 폭증하지 않는다", () => {
    const pk = cur.ev.penalty / cur.matches;
    // `boxFoulMult` 를 1.0 으로 둔 채 파울을 6배로 올리면 PK 5.40/경기 · 골 8.77/경기 였다
    // (`foul-sweep` 2차 격자). 이 상한은 그 실패를 막는 구조 게이트다 — 0.28.0 기준선이 1.03 이므로
    // "지금보다 나빠지지 않는다"에 여유 0.6 을 얹었다.
    expect(pk, `PK ${pk.toFixed(2)}/경기`).toBeLessThanOrEqual(1.6);
  }, 1_800_000);
});
