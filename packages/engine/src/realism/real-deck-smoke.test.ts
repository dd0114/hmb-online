import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeSelectData, makeTacticalInput } from "../fixtures";
import { computeMatchStats, ownerSideOfSnapshot } from "../../dev-viewer/match-stats";
import type { SelectData } from "@hmb/shared";
import { loadAllRealDeckCases, loadRealDeckCase, COLLAPSE_CASE_ID, listRealDeckCases, realDeckFilesOnDisk } from "./real-decks";
import { TIER, atLeastTier } from "./tier";

/**
 * 실덱 스모크 — #374 / #377 M0-2·M0-3
 *
 * ## 무엇을 지키나
 * 밴드가 **픽스처 입력 하나**로만 판정되던 구멍. 60시드는 시드 분산만 넓히고 입력 분포는 고정이라
 * "덱마다 달라지는 결함"을 원리적으로 못 잡는다 — 그 구멍으로 #370 이 나갔다.
 *
 * ## 판정 규율 (#374)
 * **평균이 아니라 최악 케이스.** 실측이 그 이유를 그대로 보여준다(현 main, 5시드):
 *   실덱 평균 슛/팀 = 벤치마크와 큰 차이 없음 … 그런데 **팀-하프의 27% 가 슛 0회**다.
 * 평균만 보면 "정상"이라 읽힌다. 그게 라이브 24하프 평균으로 "붕괴 없음"이라 오판한 그 실수다.
 *
 * ## 시드는 왜 여러 개인가
 * 엔진은 카오스적이라 입력 1개 × 시드 1개는 노이즈다. 그래서 **덱마다 여러 시드를 돌려 팀별
 * 평균**을 내고, **덱 사이에서는 평균 내지 않는다**(그쪽이 붕괴를 가리는 축이다).
 */

/** 덱당 시드 수 — T1 예산(≤5분) 안에서 노이즈를 누르는 값. 10덱 × 5시드 × ~0.4s ≈ 20s. */
const SEEDS_PER_DECK = atLeastTier(2) ? 8 : 5;
/** 벤치마크 기준선 시드 수(대조군). */
const BENCH_SEEDS = 5;

function gkIdsOf(select: SelectData): Set<string> {
  const out = new Set<string>();
  for (const side of ["home", "away"] as const) {
    for (const p of select[side].players) if (p.position === "GK") out.add(p.playerId);
  }
  return out;
}

interface HalfMeasure {
  shots: { home: number; away: number };
  goals: { home: number; away: number };
  passAttempts: { home: number; away: number };
  possessionTicks: { home: number; away: number };
  events: number;
}

function measure(seed: string, home: unknown, away: unknown, select: SelectData, config: EngineConfig): HalfMeasure {
  const log = runMatch(seed, home as never, away as never, select as never, config);
  const st = computeMatchStats(log, gkIdsOf(select), {
    pitchWidthM: config.pitch.width,
    finalThirdLine: config.setPiece.finalThirdLine,
  });
  let ph = 0;
  let pa = 0;
  for (const sn of log.tickSnapshots) {
    const s = ownerSideOfSnapshot(sn);
    if (s === "home") ph++;
    else if (s === "away") pa++;
  }
  return {
    shots: { home: st.home.shots, away: st.away.shots },
    goals: { home: st.home.goals, away: st.away.goals },
    passAttempts: { home: st.home.passAttempts, away: st.away.passAttempts },
    possessionTicks: { home: ph, away: pa },
    events: log.events.length,
  };
}

/** 그 덱의 시드별 측정 + 덱 단위 요약(약한 쪽 팀의 시드평균 = 이 덱의 "바닥"). */
function scanDeck(caseId: string, config: EngineConfig): {
  id: string;
  halves: HalfMeasure[];
  weakTeamMeanShots: number;
  zeroShotTeamHalves: number;
} {
  const c = loadRealDeckCase(caseId);
  const halves: HalfMeasure[] = [];
  for (let i = 0; i < SEEDS_PER_DECK; i++) {
    // 1번은 **그 하프의 실제 시드** — 라이브에서 벌어진 그 경기가 기준선이다.
    const seed = i === 0 ? c.seed : `${c.seed}#${i}`;
    halves.push(measure(seed, c.homeInput, c.awayInput, c.selectData, config));
  }
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
  const weakTeamMeanShots = Math.min(
    mean(halves.map((h) => h.shots.home)),
    mean(halves.map((h) => h.shots.away)),
  );
  const zeroShotTeamHalves = halves.reduce(
    (n, h) => n + (h.shots.home === 0 ? 1 : 0) + (h.shots.away === 0 ? 1 : 0),
    0,
  );
  return { id: caseId, halves, weakTeamMeanShots, zeroShotTeamHalves };
}

function benchMeanShotsPerTeam(config: EngineConfig): number {
  let sum = 0;
  for (let i = 0; i < BENCH_SEEDS; i++) {
    const seed = String(i + 1);
    const m = measure(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), makeSelectData(), config);
    sum += m.shots.home + m.shots.away;
  }
  return sum / (BENCH_SEEDS * 2);
}

// ── 픽스처 자체의 정합성 (즉시, 시뮬 0회) ──────────────────────────────────
describe("실덱 픽스처 정합성 (#374)", () => {
  const cases = listRealDeckCases();

  it("8~12 조합이 있다", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(cases.length).toBeLessThanOrEqual(12);
  });

  it("#370 붕괴 케이스가 포함돼 있다 (AC 필수)", () => {
    expect(cases.some((c) => c.id === COLLAPSE_CASE_ID)).toBe(true);
    const c = loadRealDeckCase(COLLAPSE_CASE_ID);
    expect(c.live.matchId).toBe("01KYVBW70WZHVAKXGRYE037ZX5");
    expect(c.live.engineVersion).toBe("engine@0.28.0");
  });

  it("인덱스와 디스크 파일이 일치한다(낡은 인덱스 = 거짓 green 구멍)", () => {
    expect(realDeckFilesOnDisk()).toEqual(cases.map((c) => `${c.id}.json`).sort());
  });

  it("입력이 다양하다 — 포메이션·압박·모드가 한 점에 몰려 있지 않다", () => {
    const all = loadAllRealDeckCases();
    const formations = new Set(all.flatMap((c) => [c.homeInput.team.formation, c.awayInput.team.formation]));
    const modes = new Set(all.map((c) => c.live.mode));
    const press = all.map((c) => c.homeInput.team.pressingScheme.intensity);
    expect(formations.size).toBeGreaterThanOrEqual(3);
    expect(modes.size).toBeGreaterThanOrEqual(2);
    expect(Math.max(...press) - Math.min(...press)).toBeGreaterThanOrEqual(0.3);
  });

  it("익명화 — 유저가 지은 덱 이름이 남아 있지 않다", () => {
    // 게임 콘텐츠 팀명은 남기고 유저 덱만 `USER-DECK-*` 로 치환한다. 여기서 보는 것은
    // "치환이 실제로 일어났나" — 하나도 없으면 익명화 단계가 통째로 빠진 것이다.
    const names = loadAllRealDeckCases().flatMap((c) => [c.selectData.home.name, c.selectData.away.name]);
    expect(names.some((n) => n.startsWith("USER-DECK-"))).toBe(true);
  });

  it("선수 입력이 엔진이 읽는 형태 그대로다(로스터 11명·능력치 9축)", () => {
    for (const c of loadAllRealDeckCases()) {
      for (const side of ["home", "away"] as const) {
        expect(c.selectData[side].players.length).toBe(11);
        for (const p of c.selectData[side].players) {
          expect(Object.keys(p.attributes).length).toBe(9);
        }
      }
      expect(c.homeInput.players.length).toBeGreaterThan(0);
      expect(c.awayInput.players.length).toBeGreaterThan(0);
    }
  });
});

// ── T0: 붕괴 케이스 1경기 (#376 교훈 3) ───────────────────────────────────
/**
 * #376 교훈 3("가장 싼 핵심 검증을 맨 앞에")을 따라 실덱 1경기를 T0 에 둔다.
 *
 * ⚠️ **하프 사망 어서션만으로는 #370 의 슛 붕괴를 못 잡는다.** 붕괴값
 * (`contest.shootXgThreshold: 0.197`)에서도 아래 세 어서션은 **전부 통과했다** — 실측
 * `{events: 681, possessionTicks: {home 844, away 673}, passAttempts: {home 377, away 258}}`
 * 인데 **슛은 1:3**(= 홈이 사실상 슛을 못 만든다)이었다. 그래서 슛 하한 래칫을 **같이** 둔다(아래).
 *
 * 이 래칫은 원래 T1 의 `it.fails` 박제였다. 열차가 `shootXgThreshold` 를 0.07 로 확정하며
 * (engine@0.34.0) 박제가 뒤집혀 **정식 게이트로 승격**했다 — E2E-TDD 박제의 목적 그대로다
 * (CLAUDE.md §2-3). 이제 이 블록의 사정거리는 데드락·사망 하프(#231/#239)**에 더해
 * #370 부류의 슛 붕괴**까지고, 그게 매 커밋(T0)에 걸린다.
 */
describe("T0 · 붕괴 케이스 1경기 — 하프가 죽지 않았는가", () => {
  const c = loadRealDeckCase(COLLAPSE_CASE_ID);
  const m = measure(c.seed, c.homeInput, c.awayInput, c.selectData, defaultEngineConfig);

  it("이벤트가 발생한다(하프가 죽지 않았다)", () => {
    expect(m.events).toBeGreaterThan(50);
  });

  it("양 팀이 공을 소유한다 — 한쪽이 0틱이면 팀 판정이나 소유 이전이 깨진 것", () => {
    expect(m.possessionTicks.home).toBeGreaterThan(0);
    expect(m.possessionTicks.away).toBeGreaterThan(0);
  });

  it("양 팀이 패스를 시도한다", () => {
    expect(m.passAttempts.home).toBeGreaterThan(20);
    expect(m.passAttempts.away).toBeGreaterThan(20);
  });

  /**
   * 슛 하한 래칫 — #370 부류가 매 커밋에 걸리게 하는 것이 이 어서션이다.
   *
   * **절대 하한을 의도적으로 낮게(3) 잡았다.** 이 엔진(engine@0.34.0)에서 같은 시드·같은 덱을
   * `contest.shootXgThreshold` 만 바꿔 재측정한 값이다:
   *
   *     0.07  (현 기본)  → home 7 : away 8    ← 5시드 약팀 6~8
   *     0.197 (붕괴값)   → home 1 : away 3
   *
   * 즉 3 은 정상 대비 절반 이하라 계수 튜닝의 통상 진폭에 걸리지 않는다.
   * ⚠️ **붕괴 검출은 사실상 home 쪽에 걸려 있다** — 붕괴값에서 away 는 정확히 3 이라 경계에서
   * 통과한다. 한쪽만 깨져도 발화하므로 게이트는 성립하지만, "양쪽이 크게 벌어진다"고 읽으면 안 된다.
   * (초기 주석은 `1:0` 이라 적었다 — 그건 engine@0.30.0 측정치였고 독립검증이 "현 엔진에서 재현
   * 안 된다"고 잡아 정정했다. 근거 수치는 **엔진 버전과 함께** 적는다.)
   *
   * **밴드가 아니라 하한**인 이유는 T0 이 매 커밋 게이트라서다: 상한까지 걸면 튜닝 웨이브마다
   * red 가 되어 신호가 죽는다. 볼륨 밴드는 T1(`shot-frequency.test.ts`)이 본다.
   *
   * 대조군(벤치마크 평균) 대비 관계식이 더 좋겠지만 그건 경기 5판을 더 돌려야 해서
   * T0 ≤1분 예산과 충돌한다 — 관계식 판정은 T1 전량 스캔이 갖고 있다.
   */
  it("양 팀이 슛을 만든다 — #370 부류의 슛 붕괴 하한(정상 7:8, 붕괴값 1:3)", () => {
    expect(m.shots.home, "홈 슛").toBeGreaterThanOrEqual(3);
    expect(m.shots.away, "원정 슛").toBeGreaterThanOrEqual(3);
  });
});

// ── T1: 실덱 전량 스캔 ────────────────────────────────────────────────────
describe.skipIf(!atLeastTier(1))(`T1 · 실덱 전량 스모크 (${SEEDS_PER_DECK}시드 × ${listRealDeckCases().length}덱)`, () => {
  const bench = benchMeanShotsPerTeam(defaultEngineConfig);
  const decks = listRealDeckCases().map((c) => scanDeck(c.id, defaultEngineConfig));
  /** "붕괴" 판정선 — 그 덱의 약한 쪽이 벤치마크 팀평균의 15% 도 못 쏜다. */
  const collapseLine = bench * 0.15;
  const collapsed = decks.filter((d) => d.weakTeamMeanShots < collapseLine);
  const zeroPct =
    (decks.reduce((n, d) => n + d.zeroShotTeamHalves, 0) / (decks.length * SEEDS_PER_DECK * 2)) * 100;

  const table = decks.map((d) => `${d.id}=${d.weakTeamMeanShots.toFixed(1)}`).join(" ");

  it("모든 실덱이 경기로 성립한다(이벤트·양팀 패스·양팀 소유)", () => {
    for (const d of decks) {
      for (const [i, h] of d.halves.entries()) {
        const where = `${d.id} 시드#${i}`;
        expect(h.events, `${where}: 이벤트 0`).toBeGreaterThan(50);
        expect(Math.min(h.passAttempts.home, h.passAttempts.away), `${where}: 한쪽 패스 없음`).toBeGreaterThan(20);
        expect(Math.min(h.possessionTicks.home, h.possessionTicks.away), `${where}: 한쪽 소유 0틱`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * **박제 해제(#370) — 정식 게이트다.**
   *
   * 이 두 어서션은 `contest.shootXgThreshold: 0.197`(붕괴값) 시절 `it.fails` 로 박제돼 있었다
   * — 실측 붕괴 덱 **9/10** · 0슛 팀-하프 **27%**. 열차가 0.07 로 확정하며(engine@0.34.0,
   * `44dd3e3` → main `f7d26be`) 실측이 붕괴 덱 **1/10** · 0슛 **5.0%** 가 되어 박제가 뒤집혔고,
   * 계획대로 `it` 로 승격한다(CLAUDE.md §2-3 E2E-TDD).
   *
   * ⚠️ **헤드룸이 넉넉하지 않다** — 붕괴 덱은 임계 `≤1` 에 정확히 붙어 있다(1/10). 이건 느슨하게
   * 두려고 고른 값이 아니라 **허용 1건이 `deck-02` 한 건이라서**다(5-3-2 저압박·로우블록 vs 강덱,
   * 라이브 0-7 · 0.07 에서도 홈 슛 0). 그건 계수가 아니라 구조 문제로 보여 **M4 후보**로 분리했다.
   * ≤0 으로 조이면 어떤 계수에서도 red 라 신호가 죽고, ≥2 로 풀면 두 번째 덱이 죽어도 조용하다.
   * 실효 여유는 0슛 비율 쪽(5.0% vs 8%)에 있다.
   */
  it(
    `[#370 게이트] 붕괴 덱 ≤1 (현재 ${collapsed.length}/${decks.length}, 판정선 ${collapseLine.toFixed(2)}슛 · 덱별 약팀평균: ${table})`,
    () => {
      expect(collapsed.length, `붕괴한 덱: ${collapsed.map((d) => d.id).join(", ")}`).toBeLessThanOrEqual(1);
    },
  );

  it(`[#370 게이트] 슛 0회 팀-하프 ≤8% (현재 ${zeroPct.toFixed(1)}%)`, () => {
    expect(zeroPct).toBeLessThanOrEqual(8);
  });

  it("벤치마크 대조군이 실제로 측정됐다(0 이면 대조 자체가 무의미)", () => {
    expect(bench).toBeGreaterThan(1);
  });
});

void TIER;
