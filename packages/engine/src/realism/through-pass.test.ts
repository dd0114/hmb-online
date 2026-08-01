import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch, runFirstHalf } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { checkOffside, offsideLineProg } from "../contest";
import { attackProgressX, createPitch } from "../pitch";
import { createRng } from "../rng";
import type { SimState } from "../simstate";
import { REALISM_SEEDS } from "./harness";
import { measureThrough } from "./through";

/**
 * #377 M3-C — **공간 타깃 패스 후보(스루패스 본체)**.
 *
 * W0 §2-C: `passOptions` 가 동료 **개체**만 후보로 내던 것에 더해, 사슬 생성기가 **좌표 후보**를
 * 만든다. 후보 지점 = 전진 중인 동료의 **앞 공간**(상대 최종 수비 라인 뒤). EV 식은 그대로
 * `p × V(도달) + (1−p) × V(턴오버)` 이고, 새로 생긴 것은 `p` 안의 **경주**뿐이다.
 *
 * ## 이 파일이 집행하는 기준 (§2.5 · 트랙 D 회고)
 * **"값을 바꾸면 경기가 달라진다"는 통과 기준이 아니다.** 광고한 동작이 **출하값에서** 나야 한다.
 * 그래서 변이체 킬(아래 ①) 위에 ②~⑤ 를 얹는다 — 대조군은 **출하 config 한 경기 안에서**
 * 생성기 라벨로 가른다(M3-A 독립검증 m1: 반사실 팔로 재지 마라).
 */

const seeds = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();
const here = dirname(fileURLToPath(import.meta.url));

function withThrough(patch: Partial<EngineConfig["chain"]["throughPass"]>): EngineConfig {
  const c = defaultEngineConfig;
  return { ...c, chain: { ...c.chain, throughPass: { ...c.chain.throughPass, ...patch } } };
}

function hashes(config: EngineConfig, n = 4): string[] {
  return seeds.slice(0, n).map((s) => {
    const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config);
    return log.tickSnapshots[log.tickSnapshots.length - 1]!.hash;
  });
}

describe("#377 M3-C 스루패스 — 공간 타깃 패스 후보", () => {
  it("① 변이체 킬 — throughPass 를 끄면 경기가 달라진다 (no-op 이면 여기서 걸린다)", () => {
    expect(hashes(defaultEngineConfig)).not.toEqual(hashes(withThrough({ enabled: false })));
  }, 300_000);

  it("② **출하값에서** 공간 후보가 실제로 뽑힌다 — 리드 10~25m · 조준점은 라인 뒤", () => {
    const r = measureThrough(defaultEngineConfig, seeds);
    // ⓐ 뽑힌다. 이 단언이 이 웨이브의 핵심이다 — "생성은 되는데 EV 가 한 번도 안 고른다"가
    //    트랙 D 가 세 번 밟은 실패 모드이고, 실제로 설계 대안 하나(리시버 현재 좌표로 재귀)는
    //    생성 331 에 채택 **0** 이었다(chain.ts 의 아블레이션 주석).
    expect(r.pickedThrough, `through 채택 ${r.pickedThrough} / 생성 ${r.generatedThrough}`).toBeGreaterThan(4);
    expect(r.through.n, "through 팔 표본").toBe(r.pickedThrough);
    // ⓑ 리드가 **AC 의 10~25m 밴드 전체**에 든다(W0 기준선 p50 3.48m 은 발밑 패스다).
    expect(r.through.band10to25Pct, `through 리드 밴드 ${r.through.band10to25Pct.toFixed(1)}%`).toBe(100);
    // ⓒ 조준점은 **언제나 상대 오프사이드 라인 뒤**다 = "앞 공간"의 정의.
    //    관측자는 `through.ts:offsideLineProg`(= `checkOffside` 와 같은 자)로 판정한다.
    expect(r.through.behindLinePct).toBe(100);
    // ⓓ **관계식 + 절대**(M3-A 의 집행 방식): 발밑 팔과 같은 경기·같은 config 안에서 대조한다.
    //    관계식만 두면 대조군이 조용해질 때 통과하고(#377 M2 의 mark-jitter 함정),
    //    절대만 두면 밴드 정의를 그대로 되읽는 tautology 가 된다.
    expect(r.footed.n, "발밑 팔 표본").toBeGreaterThan(1000);
    expect(
      r.through.leadP50,
      `through p50 ${r.through.leadP50.toFixed(2)}m vs 발밑 p50 ${r.footed.leadP50.toFixed(2)}m`,
    ).toBeGreaterThan(r.footed.leadP50 * 3);
    expect(r.through.leadP50).toBeGreaterThanOrEqual(10);
    // ⓔ **경주가 실제로 값을 만든다** — 전부 1.0 이면 그 항은 장식이다.
    expect(r.through.n).toBeGreaterThan(0);
    expect(
      r.scenes.some((s) => s.raceFrac !== null && s.raceFrac < 1),
      "경주 계수가 전부 1.0 이다 — raceBase/raceGainPerTick 이 무효",
    ).toBe(true);
  }, 600_000);

  // ⚠️ 제목이 "전부 발화한다"였는데 그건 사실이 아니다(#377 M3-C 독립검증 m2): 여덟 게이트 중
  //    `unreachable`·`shortLead` 는 8시드에서 **0** 이다. 아래 단언이 이미 그 둘을 `.toBe(0)` 으로
  //    정직하게 박고 있었으므로 계약은 그대로 두고 **요약 문장만** 사실에 맞춘다.
  it("③ 생성 게이트 — 여섯은 실제로 자르고, 둘(unreachable·shortLead)은 **0 이 정상**이다", () => {
    const r = measureThrough(defaultEngineConfig, seeds);
    const g = r.gates;
    expect(g.mates, "심사 표본").toBeGreaterThan(10_000);
    // 각 게이트가 실제로 후보를 자른 적이 있어야 한다. 0 인 게이트는 "죽은 조건"이고,
    // 죽은 조건은 다음 사람이 그것을 살아 있는 제약으로 오해하게 만든다.
    expect(g.offside, "온사이드 게이트").toBeGreaterThan(0);
    expect(g.notRunning, "전진 중 게이트(minRunGainM)").toBeGreaterThan(0);
    expect(g.notBehind, "라인 뒤 게이트(behindLineM)").toBeGreaterThan(0);
    expect(g.noForward, "전진 이득 게이트").toBeGreaterThan(0);
    expect(g.runnerLate, "러너 도달 게이트").toBeGreaterThan(0);
    expect(g.lostRace, "경주 게이트(minMarginTicks)").toBeGreaterThan(0);
    expect(g.generated, "최종 생성").toBeGreaterThan(0);
    // ⚠️ `unreachable`(그 세기로 조준점까지 못 감) 와 `shortLead` 는 **0 이 정상**이다:
    //    리드를 "러너가 닿을 수 있는 거리"로 잡으면서 둘 다 구조적으로 드물어졌다.
    //    0 을 단언해 두면 그 성질이 바뀌는 순간 알려 준다(#338 조건부 LIVE 와 같은 규율).
    expect(g.unreachable).toBe(0);
    expect(g.shortLead).toBe(0);
  }, 600_000);

  it("④ **방향** — 보수성 노브(minMarginTicks)를 올리면 후보가 줄고 내리면 는다(단조)", () => {
    // hero 게임설계 항목(W0 §5-3)의 레버가 실제로 레버인지. 절대 수치가 아니라 **순서**를 건다 —
    // 밸런스 재보정(트랙 T)이 계수를 움직여도 이 부등식은 유지돼야 한다.
    const gen = (m: number): number => measureThrough(withThrough({ minMarginTicks: m }), seeds.slice(0, 4)).generatedThrough;
    const strict = gen(2);
    const ship = gen(defaultEngineConfig.chain.throughPass.minMarginTicks);
    const loose = gen(-1);
    expect([strict, ship, loose].join(" < ")).toBeTruthy();
    expect(strict).toBeLessThan(ship);
    expect(ship).toBeLessThan(loose);
  }, 900_000);

  it("⑤ 발밑 패스는 무영향 — 경주 계수는 **공간 타깃에만** 걸린다", () => {
    // `computePassProb` 에 들어간 `raceFrac` 항이 기존 패스에 새는지를 **동작으로** 검정한다:
    // 스루패스를 끈 세계에서 `raceBase` 를 극단으로 흔들어도 경기는 bit-identical 이어야 한다.
    // (샌다면 벤치 78–85% 패스 성공률 캘리브레이션(E1)이 조용히 이동한다.)
    const a = hashes(withThrough({ enabled: false, raceBase: 0.05, raceGainPerTick: 0 }));
    const b = hashes(withThrough({ enabled: false }));
    expect(a).toEqual(b);
  }, 300_000);

  it("⑥ 결정론 — 후보 생성이 Rng 를 소비하지 않는다(순수 기하)", () => {
    // #369 가 경고한 함정: RNG 소비량이 **후보 수에 비례**하면 재개 계약이 후보 공간의 함수가 된다.
    // 공간 후보는 매 틱 개수가 달라지므로 여기가 특히 위험하다 → 소스 수준으로 박제한다.
    const src = readFileSync(join(here, "..", "through.ts"), "utf8");
    // ⚠️ 산문에 "Rng" 가 나오므로 **단어 검색이 아니라 소비/의존을 검사**한다(초판이 자기 주석에
    //    걸려 실패했다 — 그런 계약은 다음 사람이 주석을 지워서 통과시킨다).
    expect(src, "through.ts 가 Rng 를 소비하기 시작했다 — 재개 계약이 취약해진다").not.toMatch(/rng\s*\.\s*next\s*\(/);
    expect(src, "through.ts 가 rng 모듈에 의존하기 시작했다").not.toMatch(/from\s+"\.\/rng"/);
    expect(src).not.toContain("Math.random");
  });

  it("⑦ 오프사이드 라인 정의가 심판과 **한 자**다 — 소스 문자열이 아니라 동작으로", () => {
    // 라인을 다르게 잡으면 "라인 뒤로 찔렀는데 깃발이 오른다"가 두 정의의 오차만큼 상시 발생한다.
    //
    // ⚠️ 초판은 이걸 **소스 문자열 비교**로 걸었다(`toContain("progs.sort((a, b) => b - a)")`).
    // 그건 포맷만 바뀌어도 의미 없이 깨지고, 반대로 손복사본이 두 벌 있어도 통과한다
    // (#377 M3-C 독립검증 m5). 지금은 두 겹이다:
    //   ① **구조** — `checkOffside` 가 `contest.ts:offsideLineProg` 를 실제로 부른다(사본 없음).
    //   ② **동작**(이 계약) — 리시버를 라인 앞뒤로 쓸면 깃발이 `offsideLineProg + toleranceM`
    //      에서 **정확히** 바뀐다. 심판이 다른 자(예: 뒤에서 3번째)를 쓰면 여기서 걸린다.
    const cfg: EngineConfig = {
      ...defaultEngineConfig,
      // 호출 게이트(callProb)는 빈도 보정이라 판정을 흐린다 → 1 로 고정해 기하만 본다.
      rules: {
        ...defaultEngineConfig.rules,
        offside: { ...defaultEngineConfig.rules.offside, callProb: 1, trapCallMult: 1 },
      },
    };
    const pitch = createPitch(cfg);
    const seed = seeds[0]!;
    const half = runFirstHalf(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    const state = structuredClone(half.state) as SimState;
    state.teams.home.offsideTrap = false;
    state.teams.away.offsideTrap = false;

    const side = "home" as const;
    const tolNorm = cfg.rules.offside.toleranceM / cfg.pitch.width;
    const outfield = state.players.filter((p) => p.side === side && !p.isGK);
    const owner = outfield[0]!;
    const receiver = outfield[1]!;
    // 소유자는 자기 진영 깊숙이 — "공격 진영(recProg ≥ 0.5)" · "전진 패스" 게이트를 항상 통과시킨다.
    owner.posFx = { x: Math.round(pitch.wFx * 0.05), y: Math.round(pitch.hFx / 2) };

    function sweep(label: string): number {
      const line = offsideLineProg(state, side, pitch);
      expect(line, `${label}: 라인이 잡혀야 한다`).not.toBeNull();
      const seen = new Set<boolean>();
      for (const dM of [-4, -2, -0.5, 0.5, 2, 4]) {
        const prog = line! + tolNorm + dM / cfg.pitch.width;
        receiver.posFx = { x: Math.round(pitch.wFx * prog), y: Math.round(pitch.hFx / 2) };
        const recProg = attackProgressX(pitch, side, receiver.posFx.x);
        const ownerProg = attackProgressX(pitch, side, owner.posFx.x);
        // 심판이 `offsideLineProg` 와 같은 자를 쓴다면 판정은 이 식과 **정확히** 일치한다.
        const expected = recProg >= 0.5 && recProg > ownerProg && recProg > line! + tolNorm;
        const got = checkOffside(state, createRng(`offside-${label}-${dM}`), cfg, pitch, owner, receiver);
        expect(got, `${label}: 라인+tol 에서 ${dM}m — 기대 ${expected}`).toBe(expected);
        seen.add(expected);
      }
      // 공회전 방지: 이 쓸기가 실제로 경계를 **넘어야** 의미가 있다(전부 false 면 tautology).
      expect(seen.has(true) && seen.has(false), `${label}: 경계를 넘지 못했다`).toBe(true);
      return line!;
    }

    const before = sweep("기본 라인");
    // 라인을 실제로 **옮겨** 다시 잰다 — 심판이 상수를 쓰거나 다른 순위를 보고 있으면 갈린다.
    const defs = state.players
      .filter((p) => p.side !== side)
      .sort((a, b) => attackProgressX(pitch, side, b.posFx.x) - attackProgressX(pitch, side, a.posFx.x));
    defs[1]!.posFx = { x: Math.round(pitch.wFx * 0.55), y: defs[1]!.posFx.y };
    const after = sweep("2nd-last 를 옮긴 뒤");
    expect(after, "라인이 실제로 움직여야 두 번째 쓸기가 의미를 갖는다").not.toBe(before);
  });
});
