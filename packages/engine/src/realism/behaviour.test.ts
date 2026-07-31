import { describe, it, expect } from "vitest";
import { runMatch } from "../match";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { aggregateBehaviour, measureBehaviour, type BehaviourMetrics } from "./behaviour";

/**
 * 행동·의도 계층 계약 (#314) — hero 실관전 제보 3건.
 *
 *  ⓐ "공도 안 걷어내. 수비수가 걷어내야 할 때 가만히 있고 공격수가 올 때까지 기다려준다."
 *  ⓑ "차면 찰 때부터 뛰어들어가거나, 뛰어들어가는 선수를 보고 막는 그런 플레이가 보여야 하는데"
 *  ⓒ "공은 레드가 가지고 있는데 레드만 움직이고 블루팀은 가만히 있어"
 *
 * ## 계약 설계
 * 로드맵 §4 의 판정 기준을 따른다 — **출현(presence)이 게이트**이고 총량은 게이트가 아니다.
 * 그래서 여기서 거는 것은 "그 플레이가 나오는가"와 "구조 축이 살아 있는가"이고, 골·슛 총량은
 * 폭주 상한(경기당 ≤8골)만 본다.
 *
 * 각 축은 **롤백 스위치를 끈 같은 시드**를 대조군으로 쓴다(mark-jitter.test.ts 와 같은 규율) —
 * 절대 임계만 걸면 "얼마가 정상인가"를 이 파일이 임의로 정하게 된다.
 */

// #365(경기 90 → 45분): 시드당 관측이 **절반**이 되면서 이 파일의 두 관계 계약(전방 러너 수·
// 러너 마크 거리)이 노이즈에 묻혀 부호가 뒤집혔다(실측 4.06 vs 4.04 · 7.67 vs 7.70 — 폭이 0.5%다).
// **임계·관계식은 한 자리도 안 건드리고 시드를 2배로** 올려 검정력을 되돌린다. 경기가 반이라
// 시뮬 비용(총 경기-분)은 8시드×90분과 같다.
const SEEDS = REALISM_SEEDS.slice(0, 16);
const select = makeSelectData();

function run(cfg: EngineConfig): BehaviourMetrics {
  return aggregateBehaviour(
    SEEDS.map((seed) =>
      measureBehaviour(
        runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg),
        cfg.pitch.width,
      ),
    ),
  );
}

const cfg = defaultEngineConfig;
const cur = run(cfg);

/** 걷어내기만 끈 대조군(ⓐ 롤백). */
const noClear = run({ ...cfg, clearance: { ...cfg.clearance, enabled: false } });
/** 런 오더·따라들어가기·러너읽기를 전부 끈 대조군(ⓑ 롤백). */
const noRun = run({
  ...cfg,
  movement: {
    ...cfg.movement,
    runOrder: { ...cfg.movement.runOrder, enabled: false, passerFollowM: 0 },
  },
  vision: { ...cfg.vision, runReadFrac: 0 },
});

describe("#314 ⓐ 걷어내기", () => {
  it(`걷어내기가 팀당 5–12.5회/경기 나온다 (현재 ${cur.clearances.toFixed(2)})`, () => {
    // #365(경기 90 → 45분): 구 밴드 10–25 는 90분 경기에서 뜬 값이다. 경기 길이에 비례하는
    // 카운트 지표라 **같은 밴드를 길이로 환산**한다(밴드를 새로 만들지 않는다 = 기준 출처 유지).
    const scale = cfg.matchMinutes / 90;
    expect(cur.clearances).toBeGreaterThanOrEqual(10 * scale);
    expect(cur.clearances).toBeLessThanOrEqual(25 * scale);
  });

  it("롤백 스위치(clearance.enabled=false)면 0 이다 — 이 행동이 실제로 새 축임을 증명", () => {
    expect(noClear.clearances).toBe(0);
    expect(cfg.clearance.enabled).toBe(true);
  });

  it(`스로인이 폭주하지 않는다 — 걷어내기 off 대비 1.15배 이하 (현재 ${cur.throwIns.toFixed(2)} vs ${noClear.throwIns.toFixed(2)})`, () => {
    expect(cur.throwIns).toBeLessThanOrEqual(noClear.throwIns * 1.15);
  });

  it(`파울이 폭주하지 않는다 — 걷어내기 off 대비 1.3배 이하 (현재 ${cur.fouls.toFixed(2)} vs ${noClear.fouls.toFixed(2)})`, () => {
    expect(cur.fouls).toBeLessThanOrEqual(noClear.fouls * 1.3);
  });

  it("걷어내기는 **패스가 아니다** — 계획 결과(passOutcome)를 달지 않아 성공률 캘리브레이션을 오염시키지 않는다", () => {
    // 계약을 구조로 건다: 걷어내기 이벤트가 있는 틱에 pass/interception 이 같이 찍히지 않는다
    // (도착은 다음 틱 이후의 기하 판정이다).
    const log = runMatch(SEEDS[0]!, makeTacticalInput("H", SEEDS[0]!), makeTacticalInput("A", SEEDS[0]!), select, cfg);
    const clearTicks = new Set(log.events.filter((e) => e.type === "clearance").map((e) => e.tick));
    expect(clearTicks.size).toBeGreaterThan(0);
    const sameTick = log.events.filter(
      (e) => clearTicks.has(e.tick) && (e.type === "pass" || e.type === "interception"),
    );
    expect(sameTick).toEqual([]);
  });
});

describe("#314 ⓑ 침투와 그걸 보고 막기", () => {
  it(`패서가 차자마자 따라 들어간다 — 전진 패스 발사 틱의 ≥30% (롤백은 ${noRun.passerForwardPct.toFixed(1)}%, 현재 ${cur.passerForwardPct.toFixed(1)}%)`, () => {
    expect(noRun.passerForwardPct).toBeLessThan(1); // 구동작 = match.ts 가 패서를 그 틱에 정지시킨다
    expect(cur.passerForwardPct).toBeGreaterThanOrEqual(30);
  });

  it(`패스 순간 전방으로 뛰는 동료가 늘어난다 (롤백 ${noRun.fwdRunnersAtPass.toFixed(2)} → 현재 ${cur.fwdRunnersAtPass.toFixed(2)})`, () => {
    expect(cur.fwdRunnersAtPass).toBeGreaterThan(noRun.fwdRunnersAtPass);
  });

  it(`수비가 러너에게 더 가까이 붙는다 (롤백 ${noRun.runnerMarkDistM.toFixed(2)}m → 현재 ${cur.runnerMarkDistM.toFixed(2)}m)`, () => {
    expect(cur.runnerMarkDistM).toBeLessThan(noRun.runnerMarkDistM);
  });

  it("의도 게시판·런 오더가 실제로 채워진다 — S1 이 만든 자리가 죽어 있지 않다", () => {
    // 런이 실제로 걸리면 그 상태는 해시에 들어간다. 같은 시드에서 런을 끄면 해시가 갈린다.
    const seed = SEEDS[0]!;
    const a = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    const b = runMatch(
      seed,
      makeTacticalInput("H", seed),
      makeTacticalInput("A", seed),
      select,
      {
        ...cfg,
        movement: { ...cfg.movement, runOrder: { ...cfg.movement.runOrder, enabled: false } },
      },
    );
    const ha = a.tickSnapshots[a.tickSnapshots.length - 1]!.hash;
    const hb = b.tickSnapshots[b.tickSnapshots.length - 1]!.hash;
    expect(ha).not.toBe(hb);
  });
});

describe("#314 ⓒ 비소유팀 정지", () => {
  it(`비소유팀 "거의 정지"(<0.3 m/tick) 비율이 12.5% 이하 (수정 전 15.1%, 현재 ${cur.nonPossStillPct.toFixed(2)}%)`, () => {
    expect(cur.nonPossStillPct).toBeLessThanOrEqual(12.5);
  });

  it(`소유/비소유 이동량 비대칭이 1.25배 이하 (현재 ${(cur.possStepM / cur.nonPossStepM).toFixed(3)}배)`, () => {
    expect(cur.possStepM / cur.nonPossStepM).toBeLessThanOrEqual(1.25);
  });

  it(`데드볼 taker/상대 이동량 비대칭이 0.15 이하 (현재 ${cur.deadAsymmetry.toFixed(3)}) — #307 성질 유지`, () => {
    expect(cur.deadAsymmetry).toBeLessThanOrEqual(0.15);
  });
});

describe("#314 폭주 상한 (로드맵 §4 B: 총량은 게이트가 아니고 상한만 본다)", () => {
  it("경기당 골이 8 이하", () => {
    const goals =
      SEEDS.map((seed) => {
        const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
        return log.finalScore.home + log.finalScore.away;
      }).reduce((a, b) => a + b, 0) / SEEDS.length;
    expect(goals).toBeLessThanOrEqual(8);
  });
});
