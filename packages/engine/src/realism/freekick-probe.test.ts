import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * #279 — hero 실관전 제보 3건 진단(env 가드). npm test 에서는 skip.
 * 실행: HMB_FKPROBE=1 npx vitest run packages/engine/src/realism/freekick-probe.test.ts
 *
 * hero(사슬 코어 관전):
 *  ① "공의 움직임이 부자연스러워서 좀 이상할 때가 있어"
 *  ② "공이 이동하고 있을 때는 선수가 판단을 안 하나?"
 *  ③ "좌측 파울하고 프리킥 상황에서 프리킥 벽도 없고 주변 선수들 백업도 없어.
 *     프리킥 시작하고 상대선수 두 명이 붙는데, 붙는 동안 다른 선수들 움직임도 멈춰 있어."
 *
 * 좌표 추론으로 답하지 않는다(§2-2) — 로그에서 **틱별 변위**를 직접 세어 답한다.
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_FKPROBE;
const SEED = "1000000031"; // A/B 비교본과 같은 시드 = hero 가 본 그 경기
const chainCfg = (): EngineConfig => ({
  ...defaultEngineConfig,
  chain: { ...defaultEngineConfig.chain, mode: "chain" },
});

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

describe("#279 hero 제보 진단", () => {
  it.skipIf(!GEN)("① 공 비행 중 판단 ② 데드볼 정지 ③ 프리킥 벽/백업", () => {
    const useWeighted = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_FK_WEIGHTED;
    const cfg = useWeighted ? defaultEngineConfig : chainCfg();
    const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), makeSelectData(), cfg);
    const snaps = log.tickSnapshots;
    const byTick = new Map(snaps.map((s) => [s.tick, s]));

    // --- 데드볼 창(재시작 전후) 표시 ---
    const restart = new Set<number>();
    const fkTicks: number[] = [];
    for (const e of log.events) {
      if (["kickoff", "free_kick", "penalty", "goal", "foul", "offside", "half_whistle"].includes(e.type)) {
        for (let t = e.tick - 2; t <= e.tick + 16; t++) restart.add(t);
      }
      if (e.type === "free_kick") fkTicks.push(e.tick);
    }

    // --- ①② 틱별 선수 변위를, 공 상태별로 분해 ---
    // 공 상태: owned(주인 있음) / flight(주인 없음 = 비행 또는 루즈) / dead(데드볼 창)
    const bucket = { owned: [] as number[], flight: [] as number[], dead: [] as number[] };
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1]!;
      const cur = snaps[i]!;
      const prevById = new Map(prev.players.map((p) => [`${p.team}:${p.playerId}`, p]));
      let moved = 0;
      let n = 0;
      for (const p of cur.players) {
        const q = prevById.get(`${p.team}:${p.playerId}`);
        if (!q) continue;
        const d = dist(p.pos.x, p.pos.y, q.pos.x, q.pos.y);
        if (d > 12) continue; // 포메이션 리셋 등 순간이동 제외
        moved += d;
        n++;
      }
      if (n === 0) continue;
      const avg = moved / n;
      const key = restart.has(cur.tick) ? "dead" : cur.ballOwner == null ? "flight" : "owned";
      bucket[key].push(avg);
    }
    const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const still = (a: number[], thr = 0.3): number =>
      a.length ? (a.filter((v) => v < thr).length / a.length) * 100 : 0;

    const lines: string[] = [];
    lines.push("=== ①② 공 상태별 선수 평균 변위(m/tick) ===");
    for (const k of ["owned", "flight", "dead"] as const) {
      lines.push(
        `  ${k.padEnd(7)} 틱 ${String(bucket[k].length).padStart(4)} · 평균 ${mean(bucket[k]).toFixed(3)} m/tick · "거의 정지"(<0.3m) ${still(bucket[k]).toFixed(1)}%`,
      );
    }

    // --- ③ 프리킥 장면 해부 ---
    lines.push("");
    lines.push(`=== ③ 프리킥 ${fkTicks.length}건 — 벽/백업/정지 ===`);
    const W = cfg.pitch.width;
    const wallCounts: number[] = [];
    const backupCounts: number[] = [];
    for (const t of fkTicks.slice(0, 6)) {
      const sn = byTick.get(t);
      if (!sn) continue;
      const takerId = sn.ballOwner;
      const takerSide = takerId?.startsWith("H") ? "home" : "away";
      const bx = sn.ball.x;
      const by = sn.ball.y;
      // 벽 = 스팟과 상대 골 사이 9.15m 부근에 선 수비수 수
      const defGoalX = takerSide === "home" ? W : 0; // 공격 방향 골
      const wall = sn.players.filter((p) => {
        if (p.team === takerSide) return false;
        const d = dist(p.pos.x, p.pos.y, bx, by);
        if (d > 13 || d < 7) return false;
        // 스팟→골 방향으로 서 있나(대략 같은 쪽)
        return (defGoalX - bx) * (p.pos.x - bx) > 0;
      }).length;
      // 백업 = 스팟 15m 안 같은 팀(테이커 제외)
      const backup = sn.players.filter(
        (p) => p.team === takerSide && p.playerId !== takerId && dist(p.pos.x, p.pos.y, bx, by) <= 15,
      ).length;
      // 상대 근접(2명이 붙는다는 제보)
      const oppNear = sn.players.filter(
        (p) => p.team !== takerSide && dist(p.pos.x, p.pos.y, bx, by) <= 10,
      ).length;
      wallCounts.push(wall);
      backupCounts.push(backup);
      // 이 프리킥 이후 12틱 동안 전원 평균 변위
      const win: number[] = [];
      for (let k = t + 1; k <= t + 12; k++) {
        const a = byTick.get(k - 1);
        const b = byTick.get(k);
        if (!a || !b) continue;
        const m = new Map(a.players.map((p) => [`${p.team}:${p.playerId}`, p]));
        let s = 0;
        let n = 0;
        for (const p of b.players) {
          const q = m.get(`${p.team}:${p.playerId}`);
          if (!q) continue;
          const d = dist(p.pos.x, p.pos.y, q.pos.x, q.pos.y);
          if (d > 12) continue;
          s += d;
          n++;
        }
        if (n) win.push(s / n);
      }
      lines.push(
        `  t=${String(t).padStart(4)} 스팟(${bx.toFixed(0)},${by.toFixed(0)}) taker=${takerId ?? "-"} | 벽 ${wall}명 · 백업(15m) ${backup}명 · 상대근접(10m) ${oppNear}명 | 이후 12틱 평균변위 ${mean(win).toFixed(2)} m/tick`,
      );
    }
    lines.push(`  → 벽 평균 ${mean(wallCounts).toFixed(2)}명 · 백업 평균 ${mean(backupCounts).toFixed(2)}명`);

    // --- ① 공 궤적의 부자연스러움: 틱간 방향 급변 ---
    lines.push("");
    lines.push("=== ① 공 궤적 — 빈 공간에서의 방향 급변 ===");
    let sharp = 0;
    let stops = 0;
    for (let i = 2; i < snaps.length; i++) {
      const a = snaps[i - 2]!.ball;
      const b = snaps[i - 1]!.ball;
      const c = snaps[i]!.ball;
      const d1 = dist(a.x, a.y, b.x, b.y);
      const d2 = dist(b.x, b.y, c.x, c.y);
      if (d1 < 1 || d2 < 1) {
        if (d1 > 3 && d2 < 0.2) stops++; // 날아가다 급정지
        continue;
      }
      const cos = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (d1 * d2);
      if (cos < 0.5 && restart.has(snaps[i]!.tick) === false) sharp++; // 60도 이상 꺾임
    }
    lines.push(`  방향 60°+ 급변(인플레이) ${sharp}회 · 비행 중 급정지 ${stops}회 / 5400틱`);

    // eslint-disable-next-line no-console
    console.log("\n" + lines.join("\n") + "\n");
    expect(snaps.length).toBe(5400);
  }, 600_000);
});
