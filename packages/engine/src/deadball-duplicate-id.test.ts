import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { makeSelectData, makeTacticalInput } from "./fixtures";
import type { MatchLog, SelectData, TacticalInput } from "@hmb/shared";

/**
 * #231 — **같은 `playerId` 가 양 팀에 동시에 출전하면 데드볼 재시작이 영구 정지한다.**
 *
 * 라이브(오픈베타) 제보의 실체: 유저 덱과 봇 로스터가 **같은 선수 카탈로그**(P001~P180)를 공유하므로
 * 같은 선수가 양 팀에 서는 일이 실제로 일어난다(정상적인 게임 상황). 그런데 엔진은 선수를
 * `state.byId: Map<playerId, SimPlayer>` 로 찾는다 → 두 인스턴스 중 **하나만 살아남는다**.
 *
 * 그 결과 스로인 taker 의 소유자 조회(`byId.get(ball.owner)`)가 **반대 팀 인스턴스**를 돌려주고,
 * `takerWalkingIn = dist(그 인스턴스, 스팟) > controlRange` 가 **영구 참**이 되어
 * `decideBallOwner` 가 한 번도 호출되지 않는다 = **공을 차는 코드에 도달할 수 없다.**
 * 라이브 실측: 후반 67' 스로인 이후 **1384틱(23게임분)** 동안 공 정지 · 이벤트 0건(하프가 죽었다).
 * 전수 51하프 교차표 = 중복 O 40%(8/20) 사망 vs 중복 X 3.2%(1/31).
 *
 * ## 계약을 "절대 임계"가 아니라 **대조군 관계식**으로 거는 이유
 * "정지 N틱 이하"라는 숫자를 이 파일이 정하면 그건 내가 만든 임계다(#178 mark-jitter 와 같은 함정).
 * 대신 **같은 시드·같은 로스터에서 id 중복만 제거한 대조군**을 함께 돌려, 중복본의 최장 정지가
 * 대조군을 유의미하게 넘지 않음을 요구한다. 픽스를 되돌리면 중복본만 하프 끝까지 얼어붙어 깨진다.
 */

const config = defaultEngineConfig;

/** 한 로그에서 공이 (0.01m 미만으로) 움직이지 않은 최장 연속 틱 수. */
export function longestBallFreeze(log: MatchLog): number {
  const s = log.tickSnapshots;
  let best = 0;
  let run = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const moved = Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y) >= 0.01;
    if (moved) {
      run = 0;
      continue;
    }
    run++;
    if (run > best) best = run;
  }
  return best;
}

/**
 * away 로스터의 아웃필더 한 명의 id 를 home 선수 id 로 바꾼 번들(= 양 팀 공통 선수 1명).
 * 라이브에서 관측된 형태 그대로다(매치 A: home·away 모두 P080 보유).
 */
function duplicateBundle(seed: string): {
  select: SelectData;
  home: TacticalInput;
  away: TacticalInput;
  sharedId: string;
} {
  const select = makeSelectData();
  const home = makeTacticalInput("H", seed);
  const away = makeTacticalInput("A", seed);
  // 인덱스 1 = 아웃필더(GK 는 0 — 겹치면 keeper 조회까지 얽혀 원인이 흐려진다).
  // 실측: 이 한 명만 겹쳐도 10/10 시드에서 하프가 죽는다(정지 905~2275틱, 대조군 24~38틱).
  const idx = 1;
  const sharedId = select.home.players[idx]!.playerId;
  select.away.players[idx] = { ...select.away.players[idx]!, playerId: sharedId };
  away.players[idx] = { ...away.players[idx]!, playerId: sharedId };
  return { select, home, away, sharedId };
}

/** 중복 없는 대조군(같은 시드·같은 전술). */
function cleanBundle(seed: string) {
  return {
    select: makeSelectData(),
    home: makeTacticalInput("H", seed),
    away: makeTacticalInput("A", seed),
  };
}

const SEEDS = ["4815162342", "231", "77", "1010", "20260728", "99991"];

describe("#231 양 팀 공통 playerId — 데드볼 재시작이 얼어붙지 않는다", () => {
  it("중복본의 최장 공 정지가 중복 없는 대조군을 넘지 않는다", () => {
    const clean: number[] = [];
    const dup: number[] = [];
    for (const seed of SEEDS) {
      const c = cleanBundle(seed);
      clean.push(longestBallFreeze(runMatch(seed, c.home, c.away, c.select, config)));
      const d = duplicateBundle(seed);
      dup.push(longestBallFreeze(runMatch(seed, d.home, d.away, d.select, config)));
    }
    const worstClean = Math.max(...clean);
    const worstDup = Math.max(...dup);
    // 관계식: 중복이 있다고 해서 정지가 대조군 최악보다 길어지면 안 된다(여유 1.5배).
    // 버그 상태에서는 중복본이 하프 끝까지(수백~천 틱) 얼어 이 관계가 크게 깨진다.
    expect(
      worstDup,
      `중복본 최장정지 ${worstDup}틱 vs 대조군 ${worstClean}틱 (시드별 중복=${dup.join(",")} / 대조=${clean.join(",")})`,
    ).toBeLessThanOrEqual(Math.ceil(worstClean * 1.5));
  });

  it("중복 선수가 있어도 하프가 죽지 않는다 — 재시작 이후에도 이벤트가 계속 난다", () => {
    const half = Math.round((config.matchMinutes * 60 * 1000) / config.msPerTick / 2);
    for (const seed of SEEDS) {
      const d = duplicateBundle(seed);
      const log = runMatch(seed, d.home, d.away, d.select, config);
      // 각 하프의 마지막 1/4 구간에 (휘슬 제외) 플레이 이벤트가 하나도 없으면 그 하프는 죽은 것이다.
      for (const [from, to] of [
        [Math.floor(half * 0.75), half],
        [Math.floor(half * 1.75), half * 2],
      ] as const) {
        const live = log.events.filter(
          (e) => e.tick >= from && e.tick < to && e.type !== "half_whistle" && e.type !== "full_whistle",
        );
        expect(live.length, `seed=${seed} 구간 ${from}~${to} 에 플레이 이벤트 0건 = 하프 사망`).toBeGreaterThan(0);
      }
    }
  });
});
