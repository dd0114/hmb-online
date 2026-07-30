import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

/**
 * #279 W3 — **골키퍼가 공을 갖고 전진하는가** 실측(env 가드). npm test 에서는 skip.
 * 실행: HMB_GKCARRY=1 npx vitest run packages/engine/src/realism/gk-carry.test.ts
 *
 * 왜 재나: 공격 감사에서 `match.ts` 의 볼 소유자 결정에 **`isGK` 가드가 없다**는 것이 확인됐다.
 * GK 가 공을 잡으면 필드플레이어와 똑같은 `decideBallOwner` 를 타고, 드리블을 뽑으면 목표가
 * `attackGoal`(= **상대 골**)이다. `decideOffBall` 의 GK 골문 고정은 **소유자가 아닐 때만** 적용된다
 * (match.ts 가 소유자를 skip). #230(데드볼 중 GK 이탈)과 같은 계열의 노출면이라 실측으로 확인한다.
 *
 * 임계는 config 가 아니라 **IFAB 박스 깊이(16.5m)** 로 잡는다 — 자기 박스를 벗어나 공을 몰고
 * 나가는 것이 "이탈"의 자연스러운 정의다(#230 계약과 동일 기준).
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_GKCARRY;
const GK_IDS = new Set(["H0", "A0"]);

describe("#279 W3 GK ball-carry exposure", () => {
  it.skipIf(!GEN)("measures how far goalkeepers advance while owning the ball", () => {
    const select = makeSelectData();
    const W = defaultEngineConfig.pitch.width;
    const boxDepth = defaultEngineConfig.rules.penalty.boxDepthM;
    let ownTicks = 0;
    let outOfBoxTicks = 0;
    let maxAdvance = 0;
    const advances: number[] = [];

    for (const seed of REALISM_SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig);
      for (const sn of log.tickSnapshots) {
        const o = sn.ballOwner;
        if (!o || !GK_IDS.has(o)) continue;
        const side = o === "H0" ? "home" : "away";
        const p = sn.players.find((q) => q.playerId === o && q.team === side);
        if (!p) continue;
        // 자기 골라인에서의 거리(m).
        const fromOwnGoal = side === "home" ? p.pos.x : W - p.pos.x;
        ownTicks++;
        advances.push(fromOwnGoal);
        if (fromOwnGoal > boxDepth) outOfBoxTicks++;
        if (fromOwnGoal > maxAdvance) maxAdvance = fromOwnGoal;
      }
    }
    advances.sort((a, b) => a - b);
    const q = (f: number): number => (advances.length ? advances[Math.round((advances.length - 1) * f)]! : 0);
    // eslint-disable-next-line no-console
    console.log(
      `\n=== #279 GK CARRY (${REALISM_SEEDS.length} seeds) ===\n` +
        `GK 소유 틱 총합: ${ownTicks} (경기당 ${(ownTicks / REALISM_SEEDS.length).toFixed(1)})\n` +
        `자기 골라인에서 거리 p50 ${q(0.5).toFixed(1)}m · p90 ${q(0.9).toFixed(1)}m · p99 ${q(0.99).toFixed(1)}m · max ${maxAdvance.toFixed(1)}m\n` +
        `박스(${boxDepth}m) 밖에서 공 소유한 틱: ${outOfBoxTicks} (${((outOfBoxTicks / Math.max(1, ownTicks)) * 100).toFixed(2)}%)\n`,
    );
    expect(ownTicks).toBeGreaterThan(0);
  }, 900_000);
});
