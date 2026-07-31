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
 * #376 이 남긴 교훈을 그대로 코드로 옮긴 것:
 * > "이번 사고(#370)의 유일한 필수 AC 는 **붕괴 케이스 1경기 입력 1회**였다. 그건 480ms 다.
 * >  4.8분짜리 사다리보다 **먼저** 돌았어야 했다."
 * 그래서 이 블록만 T0(매 커밋)에 있고, 나머지 실덱 스캔은 T1 이다.
 */
describe("T0 · 붕괴 케이스 1경기 — 경기가 성립하는가", () => {
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
   * ⚠️ **현 main 에서 의도적으로 실패한다** — `contest.shootXgThreshold: 0.197`(#370 원인값)이
   * 아직 main 에 남아 있다. 실측: 붕괴 덱 9/10 · 0슛 팀-하프 27%.
   * 트랙 T 가 안전값을 확정하면(실측 0.07 에서 붕괴 1/10 · 0슛 3%) 이 `it.fails` 가 뒤집히며
   * **그때 `it` 로 바꿔 정식 게이트로 승격**한다. 그게 E2E-TDD 박제의 목적이다(CLAUDE.md §2-3).
   */
  it.fails(
    `[박제 #370] 붕괴 덱 ≤1 (현재 ${collapsed.length}/${decks.length}, 판정선 ${collapseLine.toFixed(2)}슛 · 덱별 약팀평균: ${table})`,
    () => {
      expect(collapsed.map((d) => d.id)).toHaveLength(Math.min(1, collapsed.length));
      expect(collapsed.length).toBeLessThanOrEqual(1);
    },
  );

  it.fails(`[박제 #370] 슛 0회 팀-하프 ≤8% (현재 ${zeroPct.toFixed(1)}%)`, () => {
    expect(zeroPct).toBeLessThanOrEqual(8);
  });

  /**
   * 위 두 개가 박제라 **아무 회귀도 못 잡는 상태**가 되지 않게, 지금 값보다 **더 나빠지는 것**은
   * 지금 막는다(래칫). 트랙 T 가 고치면 박제가 뒤집히고 이 래칫은 불필요해진다.
   */
  it(`래칫 — 붕괴가 지금(${collapsed.length}덱)보다 늘지 않는다`, () => {
    expect(collapsed.length, `붕괴 덱: ${collapsed.map((d) => d.id).join(", ")}`).toBeLessThanOrEqual(9);
    expect(zeroPct).toBeLessThanOrEqual(32);
  });

  it("벤치마크 대조군이 실제로 측정됐다(0 이면 대조 자체가 무의미)", () => {
    expect(bench).toBeGreaterThan(1);
  });
});

void TIER;
