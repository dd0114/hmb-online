import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { GUARD_SEEDS } from "./harness";
import { oneOnOneShot, xgAtPoint } from "../decision";
import { createPitch } from "../pitch";
import { toFixed } from "../fixedmath";
import type { SimPlayer, SimState } from "../simstate";

/**
 * 1대1(one_on_one) 찬스 계약 (#316).
 *
 * 결함: 판정이 **weighted 코어에만** 있었다(`decision.ts`). 0.24.0 에서 기본 코어가 `chain` 으로
 * 바뀌자 `chain.ts` 의 shoot 반환에 `detail` 이 없어(=`undefined`) 두 가지가 동시에 죽었다 —
 *  ① `shot` 이벤트의 `detail="one_on_one"` 이 한 건도 안 나온다(하이라이트·스탯 사망)
 *  ② 부스트 안 된 xg 가 flight 에 실려 **골 롤까지** 그대로 간다(찬스 가치 사망).
 *
 * 계약은 둘 다 건다: 다시드 경기에서 이벤트가 실제로 나오고, 판정 자체가 기하에 맞는다.
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();
const pitch = createPitch(cfg);

function oneOnOneCount(seed: string): number {
  const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
  return log.events.filter((e) => e.type === "shot" && e.detail === "one_on_one").length;
}

/** 최소 상태 — `oneOnOneShot` 은 `state.players` 와 소유자 좌표만 본다. */
function fakeState(players: SimPlayer[]): SimState {
  return { players } as unknown as SimState;
}

function fakePlayer(side: SimPlayer["side"], id: string, xM: number, yM: number, isGK = false): SimPlayer {
  return {
    id,
    side,
    isGK,
    posFx: { x: toFixed(xM, cfg.fixedScale), y: toFixed(yM, cfg.fixedScale) },
  } as unknown as SimPlayer;
}

describe("#316 1대1 찬스 — chain 코어에서도 판정된다", () => {
  /**
   * ⚠️ 표본을 60시드(`GUARD_SEEDS`)로 잡는 이유: chain 코어에서 이 상황 자체가 **드물다**.
   * 판정 기하(골에서 `shootRange` 19m 안 + 비-GK 상대가 `oneOnOneClearM` 10m 밖)는 두 코어가
   * 같지만, weighted 는 그 위에 `oneOnOneShootBias` 1.8 을 곱해 슛을 **강제**했고 chain 은
   * 그 강제를 이식하지 않았다(EV 공간에 대응물이 없다 — `config.ts` 주석). 그래서 20시드에서는
   * 1건까지 내려가 "경로가 살아 있다"는 계약이 시드 재선정 한 번에 깨질 수 있다.
   * 정밀 판정은 아래 결정론적 기하 테스트가 맡고, 이 테스트는 **경로 생존**만 본다.
   */
  it("다시드 경기에서 one_on_one 슛 이벤트가 발행된다", () => {
    const per = GUARD_SEEDS.map((s) => ({ seed: s, n: oneOnOneCount(s) }));
    const total = per.reduce((a, b) => a + b.n, 0);
    const seedsWith = per.filter((p) => p.n > 0).length;
    // eslint-disable-next-line no-console
    console.log(
      `[#316] one_on_one shots: total=${total} seeds=${seedsWith}/${per.length} ` +
        `perMatch=${(total / per.length).toFixed(3)} | ${per.filter((p) => p.n > 0).map((p) => `${p.seed}:${p.n}`).join(" ")}`,
    );
    // 수정 전: 20시드 전부 0(chain 코어가 detail 을 안 실었다).
    expect(total).toBeGreaterThan(0);
    expect(seedsWith).toBeGreaterThan(0);
  });

  it("판정 기하: 비-GK 상대가 clear 반경 밖이면 부스트 + detail, 안이면 원본 그대로", () => {
    const mult = cfg.contest.oneOnOneXgMult;
    const clearM = cfg.contest.oneOnOneClearM;
    // 홈 슈터는 어웨이 골(x=length)을 본다 — 사거리 안(골에서 10m)에 세운다.
    const shooter = fakePlayer("home", "H9", cfg.pitch.width - 10, cfg.pitch.height / 2);
    const gk = fakePlayer("away", "A0", cfg.pitch.width - 2, cfg.pitch.height / 2, true);
    const { xg: raw, distM } = xgAtPoint(
      "home", shooter.posFx.x, shooter.posFx.y, 50, 0, cfg, pitch,
    );

    // (a) 비-GK 상대 없음(GK 만) → 1대1.
    const open = oneOnOneShot(fakeState([shooter, gk]), shooter, raw, distM, cfg);
    expect(open.detail).toBe("one_on_one");
    expect(open.xg).toBeCloseTo(Math.min(0.95, raw * mult), 10);

    // (b) 비-GK 수비수가 clear 반경 **안** → 1대1 아님, xg 는 원본.
    const near = fakePlayer("away", "A5", cfg.pitch.width - 10 + clearM * 0.5, cfg.pitch.height / 2);
    const marked = oneOnOneShot(fakeState([shooter, gk, near]), shooter, raw, distM, cfg);
    expect(marked.detail).toBeUndefined();
    expect(marked.xg).toBe(raw);

    // (c) 반경 **밖** 수비수는 1대1을 막지 않는다.
    const far = fakePlayer("away", "A5", cfg.pitch.width - 10 + clearM * 2, cfg.pitch.height / 2);
    const still = oneOnOneShot(fakeState([shooter, gk, far]), shooter, raw, distM, cfg);
    expect(still.detail).toBe("one_on_one");

    // (d) 사거리 밖이면 판정 자체를 안 한다(하프라인 근처).
    const deep = fakePlayer("home", "H9", cfg.pitch.width / 2, cfg.pitch.height / 2);
    const dRaw = xgAtPoint("home", deep.posFx.x, deep.posFx.y, 50, 0, cfg, pitch);
    const outOfRange = oneOnOneShot(fakeState([deep, gk]), deep, dRaw.xg, dRaw.distM, cfg);
    expect(outOfRange.detail).toBeUndefined();
    expect(outOfRange.xg).toBe(dRaw.xg);
  });
});
