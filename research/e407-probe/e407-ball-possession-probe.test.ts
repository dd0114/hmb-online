import { describe, it } from "vitest";
import type { MatchLog, TickSnapshot } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

/**
 * E407 ④ 공 소유 어색함 — **측정 전용 프로브**(분석 웨이브, 판정 없음).
 * 계약이 아니라 계측이다: expect 없이 콘솔에 분포만 찍는다.
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

const REPOSITION = new Set(["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff"]);
function repositionTicks(log: MatchLog): Set<number> {
  const s = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (REPOSITION.has(kind) || REPOSITION.has(e.type)) s.add(e.tick);
  }
  return s;
}

function ownerOf(s: TickSnapshot): { x: number; y: number; team: string } | null {
  const id = s.ballOwner;
  if (!id) return null;
  let best: TickSnapshot["players"][number] | null = null;
  let bd = Infinity;
  for (const p of s.players) {
    if (p.playerId !== id) continue;
    const d = Math.hypot(p.pos.x - s.ball.x, p.pos.y - s.ball.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? { x: best.pos.x, y: best.pos.y, team: best.team } : null;
}

function q(a: number[], p: number): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "-");
const pct = (n: number, d: number): string => (d ? ((100 * n) / d).toFixed(1) : "-") + "%";

/** 뷰어 렌더 선수 원의 **월드 반경**(m) — canvas 1050x680, MARGIN 30, PITCH 105x68. */
const BASE_SCALE = Math.min((1050 - 60) / 105, (680 - 60) / 68); // px/m at zoom 1
const TOKEN_R_WIDE_M = 8 / BASE_SCALE; // zoom 1, R=8px
const TOKEN_R_FOLLOW_M = 11 / (BASE_SCALE * 2.6); // FOLLOW_ZOOM 2.6, R=11px

describe("E407 ④ 공 소유 기하 프로브 (계측 전용)", () => {
  it("소유 틱 공-소유자 거리 · 소유 이전 점프 · 꺾임각 (분류별)", () => {
    const gapHold: number[] = [];
    const gapDead: number[] = [];
    let holdTicks = 0;
    let deadTicks = 0;
    const glueJumpHeld: number[] = [];
    const turnHeld: number[] = [];
    const standoffKink: number[] = [];
    let kinkTakes = 0;
    let kinkOutsideWide = 0;
    let kinkOutsideFollow = 0;
    const kinkTop: { seed: string; tick: number; standoff: number; deg: number; glue: number }[] = [];

    for (const seed of REALISM_SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
      const S = log.tickSnapshots;
      const cut = repositionTicks(log);
      for (let i = 1; i < S.length; i++) {
        const prev = S[i - 1]!, s = S[i]!, next = S[i + 1];
        if (cut.has(s.tick)) continue;
        const o = ownerOf(s);
        if (!o) continue;
        const d = Math.hypot(o.x - s.ball.x, o.y - s.ball.y);
        const isTake = s.ballOwner !== prev.ballOwner;
        if (!isTake) {
          // 소유 유지 틱. 공이 5m 넘게 떨어져 있으면 인플레이 글루가 아니다(= 세트피스 워크인).
          if (d > cfg.contest.controlRange) { deadTicks++; gapDead.push(d); }
          else { holdTicks++; gapHold.push(d); }
          continue;
        }
        if (!next || cut.has(next.tick) || !prev || cut.has(prev.tick)) continue;
        if (next.ballOwner !== s.ballOwner) continue; // 원터치로 바로 찼다 — 글루 관측 불가
        glueJumpHeld.push(Math.hypot(next.ball.x - s.ball.x, next.ball.y - s.ball.y));
        const v1x = s.ball.x - prev.ball.x, v1y = s.ball.y - prev.ball.y;
        const v2x = next.ball.x - s.ball.x, v2y = next.ball.y - s.ball.y;
        const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
        if (m1 < 1 || m2 < 1) continue;
        const raw = Math.abs((Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x)) * (180 / Math.PI));
        const deg = raw > 180 ? 360 - raw : raw;
        turnHeld.push(deg);
        if (deg >= 20) {
          kinkTakes++;
          standoffKink.push(d);
          if (d > TOKEN_R_WIDE_M) kinkOutsideWide++;
          if (d > TOKEN_R_FOLLOW_M) kinkOutsideFollow++;
          kinkTop.push({
            seed,
            tick: s.tick,
            standoff: d,
            deg,
            glue: Math.hypot(next.ball.x - s.ball.x, next.ball.y - s.ball.y),
          });
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      [
        `=== E407 ④ 분류별 ===`,
        `[H] 소유 유지(인플레이 글루) n=${holdTicks} p50=${f2(q(gapHold, 0.5))} p90=${f2(q(gapHold, 0.9))} max=${f2(Math.max(...gapHold))}`,
        `[D] 소유 유지인데 >controlRange (세트피스 워크인) n=${deadTicks} p50=${f2(q(gapDead, 0.5))} p90=${f2(q(gapDead, 0.9))} max=${f2(Math.max(...gapDead))}`,
        `[G] 받고 계속 가진 take → 다음 틱 글루 점프 n=${glueJumpHeld.length} p50=${f2(q(glueJumpHeld, 0.5))} p90=${f2(q(glueJumpHeld, 0.9))} max=${f2(Math.max(...glueJumpHeld))}`,
        `[T] 그 take 의 방향 전환각 n=${turnHeld.length} p50=${f2(q(turnHeld, 0.5))} p90=${f2(q(turnHeld, 0.9))} max=${f2(Math.max(...turnHeld))}`,
        `[K] 그중 꺾임(>=20°) ${kinkTakes} — 꺾임 지점↔소유자 거리 p50=${f2(q(standoffKink, 0.5))} p90=${f2(q(standoffKink, 0.9))} max=${f2(Math.max(...standoffKink))}`,
        `    토큰 밖에서 꺾임: wide ${kinkOutsideWide} (${pct(kinkOutsideWide, kinkTakes)}) / follow ${kinkOutsideFollow} (${pct(kinkOutsideFollow, kinkTakes)})`,
        `[K-top] standoff × deg 상위 (캡처 후보)`,
        ...kinkTop
          .sort((a, b) => b.standoff * b.deg - a.standoff * a.deg)
          .slice(0, 12)
          .map((k) => `    seed ${k.seed} t=${k.tick} standoff=${f2(k.standoff)}m turn=${k.deg.toFixed(0)}° glue=${f2(k.glue)}m`),
      ].join("\n"),
    );
  }, 300000);

  it("소유 틱 공-소유자 거리 · 소유 이전 점프 · 꺾임각", () => {
    const gapAll: number[] = [];
    const gapTake: number[] = [];
    const jumpAfterTake: number[] = [];
    const turnAtTake: number[] = [];
    let ownedTicks = 0;
    let outsideWide = 0;
    let outsideFollow = 0;
    let takes = 0;
    let takesTurn60 = 0;
    let takesTurn90 = 0;
    let dupIdOwner = 0;
    // 전체 꺾임(>=20°, 양쪽 >=1m) 중 소유이전 틱에 걸친 비율
    let kinks = 0;
    let kinksAtTransfer = 0;
    const worst: { seed: string; tick: number; jump: number; deg: number; gap: number }[] = [];

    for (const seed of REALISM_SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
      const S = log.tickSnapshots;
      const cut = repositionTicks(log);
      // 소유 이전(take) 틱 집합
      const takeTick = new Set<number>();
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1]!, b = S[i]!;
        if (b.ballOwner && b.ballOwner !== a.ballOwner) takeTick.add(b.tick);
      }
      for (let i = 0; i < S.length; i++) {
        const s = S[i]!;
        if (cut.has(s.tick)) continue;
        const o = ownerOf(s);
        if (!o) continue;
        if (s.players.filter((p) => p.playerId === s.ballOwner).length > 1) dupIdOwner++;
        const d = Math.hypot(o.x - s.ball.x, o.y - s.ball.y);
        ownedTicks++;
        gapAll.push(d);
        if (d > TOKEN_R_WIDE_M) outsideWide++;
        if (d > TOKEN_R_FOLLOW_M) outsideFollow++;
        if (!takeTick.has(s.tick)) continue;
        takes++;
        gapTake.push(d);
        const prev = S[i - 1], next = S[i + 1];
        if (!prev || !next || cut.has(prev.tick) || cut.has(next.tick)) continue;
        const jump = Math.hypot(next.ball.x - s.ball.x, next.ball.y - s.ball.y);
        jumpAfterTake.push(jump);
        const v1x = s.ball.x - prev.ball.x, v1y = s.ball.y - prev.ball.y;
        const v2x = next.ball.x - s.ball.x, v2y = next.ball.y - s.ball.y;
        const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
        if (m1 >= 1 && m2 >= 1) {
          const raw = Math.abs((Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x)) * (180 / Math.PI));
          const deg = raw > 180 ? 360 - raw : raw;
          turnAtTake.push(deg);
          if (deg >= 60) takesTurn60++;
          if (deg >= 90) takesTurn90++;
          worst.push({ seed, tick: s.tick, jump, deg, gap: d });
        }
      }
      // 전체 꺾임 대비 소유이전 기여
      for (let i = 1; i + 1 < S.length; i++) {
        const a = S[i - 1]!, b = S[i]!, c = S[i + 1]!;
        if (cut.has(a.tick) || cut.has(b.tick) || cut.has(c.tick)) continue;
        const v1x = b.ball.x - a.ball.x, v1y = b.ball.y - a.ball.y;
        const v2x = c.ball.x - b.ball.x, v2y = c.ball.y - b.ball.y;
        const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
        if (m1 < 1 || m2 < 1) continue;
        const raw = Math.abs((Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x)) * (180 / Math.PI));
        const deg = raw > 180 ? 360 - raw : raw;
        if (deg < 20) continue;
        kinks++;
        if (takeTick.has(b.tick) || takeTick.has(c.tick)) kinksAtTransfer++;
      }
    }

    worst.sort((a, b) => b.jump - a.jump);
    const lines = [
      `=== E407 ④ ball possession probe — ${REALISM_SEEDS.length} seeds, ${cfg.version} ===`,
      `controlRange=${cfg.contest.controlRange}m aerial.rangeM=${cfg.contest.aerial.rangeM}m maxPerTick=${cfg.speed.maxPerTick}m`,
      `viewer token world-radius: wide(zoom1) ${f2(TOKEN_R_WIDE_M)}m / follow(zoom2.6) ${f2(TOKEN_R_FOLLOW_M)}m`,
      ``,
      `[1] 소유 틱 dist(ball, owner)  n=${ownedTicks}`,
      `    p50=${f2(q(gapAll, 0.5))} p90=${f2(q(gapAll, 0.9))} p99=${f2(q(gapAll, 0.99))} max=${f2(Math.max(...gapAll))}`,
      `    > 토큰반경(wide ${f2(TOKEN_R_WIDE_M)}m): ${outsideWide} (${pct(outsideWide, ownedTicks)})`,
      `    > 토큰반경(follow ${f2(TOKEN_R_FOLLOW_M)}m): ${outsideFollow} (${pct(outsideFollow, ownedTicks)})`,
      `    중복 id 소유 틱: ${dupIdOwner}`,
      ``,
      `[2] 소유 이전(take) 틱의 dist(ball, newOwner)  n=${takes}`,
      `    p50=${f2(q(gapTake, 0.5))} p90=${f2(q(gapTake, 0.9))} max=${f2(Math.max(...gapTake))}`,
      ``,
      `[3] take 다음 틱 공 이동(글루 점프)  n=${jumpAfterTake.length}`,
      `    p50=${f2(q(jumpAfterTake, 0.5))} p90=${f2(q(jumpAfterTake, 0.9))} p99=${f2(q(jumpAfterTake, 0.99))} max=${f2(Math.max(...jumpAfterTake))}`,
      ``,
      `[4] take 시 공 방향 전환각(양쪽 >=1m)  n=${turnAtTake.length}`,
      `    p50=${f2(q(turnAtTake, 0.5))} p90=${f2(q(turnAtTake, 0.9))} max=${f2(Math.max(...turnAtTake))}`,
      `    >=60°: ${takesTurn60} (${pct(takesTurn60, turnAtTake.length)})  >=90°: ${takesTurn90} (${pct(takesTurn90, turnAtTake.length)})`,
      ``,
      `[5] 전체 꺾임(>=20°, 양쪽>=1m) ${kinks} 중 소유이전 동반 ${kinksAtTransfer} (${pct(kinksAtTransfer, kinks)})`,
      ``,
      `[6] 최악 표본 top12 (jump 기준)`,
      ...worst.slice(0, 12).map(
        (w) => `    seed ${w.seed} t=${w.tick} jump=${f2(w.jump)}m turn=${w.deg.toFixed(0)}° takeGap=${f2(w.gap)}m`,
      ),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, 300000);
});
