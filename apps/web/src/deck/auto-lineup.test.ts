import { describe, expect, it } from "vitest";
import {
  autoBuildLineup,
  canAutoBuild,
  fitScore,
  minCostAssignment,
  POSITION_DEFAULT_PROMPTS,
  positionWeight,
  type AutoPlayer,
} from "./auto-lineup";
import { BENCH_MAX, FORMATION_LAYOUTS, STARTER_COUNT, type Position } from "./deck-logic";

type PlayerAttributes = AutoPlayer["attributes"];

/** All 9 attributes = `overall` so playerOverall(mean) === overall exactly. */
function attrs(overall: number): PlayerAttributes {
  return {
    technical: overall,
    mental: overall,
    physical: overall,
    passing: overall,
    shooting: overall,
    tackling: overall,
    pace: overall,
    stamina: overall,
    positioning: overall,
  };
}

function mk(id: string, position: Position, overall: number): AutoPlayer {
  return { id, position, attributes: attrs(overall) };
}

/** slotIndex → slot position label for a formation (from FORMATION_LAYOUTS). */
function slotPositions(formation: string): Map<number, Position> {
  const map = new Map<number, Position>();
  for (const row of FORMATION_LAYOUTS[formation]!) {
    for (const idx of row.slotIndexes) map.set(idx, row.label);
  }
  return map;
}

/** A balanced pool: 2 GK, 6 DF, 6 MF, 4 FW (18 owned) with distinct overalls. */
function balancedPool(): AutoPlayer[] {
  const out: AutoPlayer[] = [];
  const spec: Array<[Position, number]> = [
    ["GK", 2],
    ["DF", 6],
    ["MF", 6],
    ["FW", 4],
  ];
  let n = 0;
  for (const [pos, count] of spec) {
    for (let i = 0; i < count; i++) {
      out.push(mk(`${pos}${i + 1}`, pos, 80 - n));
      n++;
    }
  }
  return out;
}

describe("positionWeight / fitScore", () => {
  it("exact position = 1.0, GK cross = heavy penalty, outfield mismatch steps down", () => {
    expect(positionWeight("MF", "MF")).toBe(1.0);
    expect(positionWeight("GK", "DF")).toBe(0.2);
    expect(positionWeight("DF", "GK")).toBe(0.2);
    expect(positionWeight("DF", "MF")).toBeCloseTo(0.85, 10);
    expect(positionWeight("DF", "FW")).toBeCloseTo(0.7, 10);
  });

  it("fit = overall × weight", () => {
    expect(fitScore(mk("x", "MF", 80), "MF")).toBeCloseTo(80, 10);
    expect(fitScore(mk("x", "DF", 80), "FW")).toBeCloseTo(56, 10); // 80*0.70
  });
});

describe("minCostAssignment (Hungarian) is globally optimal, not greedy", () => {
  /** Brute-force min cost over all injective row→col mappings (rows ≤ cols). */
  function bruteMin(cost: number[][]): number {
    const n = cost.length;
    const m = cost[0]!.length;
    let best = Infinity;
    const used = new Array<boolean>(m).fill(false);
    const rec = (r: number, acc: number) => {
      // no acc-based pruning: costs may be negative, so a larger partial sum can still lead lower.
      if (r === n) {
        if (acc < best) best = acc;
        return;
      }
      for (let c = 0; c < m; c++) {
        if (used[c]) continue;
        used[c] = true;
        rec(r + 1, acc + cost[r]![c]!);
        used[c] = false;
      }
    };
    rec(0, 0);
    return best;
  }

  it("classic greedy trap [[5,4],[4,1]] → picks anti-diagonal (total 8, not greedy 6)", () => {
    // greedy grabs max cell (0,0)=5 then (1,1)=1 → 6. optimal (0,1)+(1,0) = 8.
    // as MIN-cost we negate: [[-5,-4],[-4,-1]] optimum = -8.
    const cost = [
      [-5, -4],
      [-4, -1],
    ];
    const a = minCostAssignment(cost);
    const total = a.reduce((s, c, r) => s + cost[r]![c]!, 0);
    expect(total).toBe(-8);
    expect(a).toEqual([1, 0]);
  });

  it("matches brute-force optimum across deterministic rectangular matrices", () => {
    // deterministic pseudo values (no RNG) — several shapes.
    const shapes: Array<[number, number]> = [
      [2, 2],
      [3, 4],
      [4, 4],
      [4, 6],
      [5, 7],
    ];
    for (const [n, m] of shapes) {
      const cost: number[][] = [];
      for (let r = 0; r < n; r++) {
        const row: number[] = [];
        for (let c = 0; c < m; c++) {
          // varied, includes cross preferences that defeat greedy
          row.push(((r * 7 + c * 13 + ((r * c) % 5) * 11) % 37) - 18);
        }
        cost.push(row);
      }
      const a = minCostAssignment(cost);
      const total = a.reduce((s, c, r) => s + cost[r]![c]!, 0);
      // valid: distinct columns, one per row
      expect(new Set(a).size).toBe(n);
      expect(total).toBe(bruteMin(cost));
    }
  });
});

describe("autoBuildLineup", () => {
  it("is deterministic — same input (any order) → identical output", () => {
    const pool = balancedPool();
    const a = autoBuildLineup(pool);
    const b = autoBuildLineup([...pool].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("fills exactly 11 starters and a bench up to BENCH_MAX", () => {
    const pool = balancedPool(); // 18 owned
    const { draft } = autoBuildLineup(pool);
    const starters = draft.slots.filter((s) => s.role === "starter");
    const bench = draft.slots.filter((s) => s.role === "bench");
    expect(starters).toHaveLength(STARTER_COUNT);
    expect(bench.length).toBe(Math.min(BENCH_MAX, 18 - STARTER_COUNT));
    // no duplicate players across the board
    const ids = draft.slots.map((s) => s.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts a real GK into the GK slot (slotIndex 0)", () => {
    // 1 mediocre GK + 11 strong outfielders → GK still owns the goal (cross penalty 0.20).
    const pool: AutoPlayer[] = [
      mk("GKx", "GK", 45),
      ...Array.from({ length: 4 }, (_, i) => mk(`D${i}`, "DF", 90)),
      ...Array.from({ length: 4 }, (_, i) => mk(`M${i}`, "MF", 90)),
      ...Array.from({ length: 3 }, (_, i) => mk(`F${i}`, "FW", 90)),
    ];
    const { draft } = autoBuildLineup(pool);
    const gkSlot = draft.slots.find((s) => s.role === "starter" && s.slotIndex === 0);
    expect(gkSlot?.playerId).toBe("GKx");
  });

  it("prefers exact-position players for each slot when a full natural squad is owned", () => {
    // exactly a 4-4-2 natural squad (1 GK, 4 DF, 4 MF, 2 FW) — optimum = everyone at exact position.
    const pool: AutoPlayer[] = [
      mk("g", "GK", 70),
      ...Array.from({ length: 4 }, (_, i) => mk(`d${i}`, "DF", 70)),
      ...Array.from({ length: 4 }, (_, i) => mk(`m${i}`, "MF", 70)),
      ...Array.from({ length: 2 }, (_, i) => mk(`f${i}`, "FW", 70)),
    ];
    const { draft } = autoBuildLineup(pool, ["4-4-2"]);
    const posOf = new Map(pool.map((p) => [p.id, p.position]));
    const slotPos = slotPositions("4-4-2");
    for (const s of draft.slots.filter((x) => x.role === "starter")) {
      expect(posOf.get(s.playerId)).toBe(slotPos.get(s.slotIndex));
    }
  });

  it("injects the position default prompt for each starter's slot position", () => {
    const { draft } = autoBuildLineup(balancedPool());
    const slotPos = slotPositions(draft.formation);
    for (const s of draft.slots.filter((x) => x.role === "starter")) {
      const label = slotPos.get(s.slotIndex)!;
      expect(s.promptText).toBe(POSITION_DEFAULT_PROMPTS[label]);
    }
  });

  it("selects the formation with the higher total fit (FW-heavy → 4-3-3)", () => {
    // 3 elite FWs: 4-3-3 seats all three at exact FW; 4-4-2 forces one off-position.
    const pool: AutoPlayer[] = [
      mk("g", "GK", 60),
      ...Array.from({ length: 4 }, (_, i) => mk(`d${i}`, "DF", 55)),
      ...Array.from({ length: 3 }, (_, i) => mk(`m${i}`, "MF", 55)),
      ...Array.from({ length: 3 }, (_, i) => mk(`f${i}`, "FW", 95)),
    ];
    expect(autoBuildLineup(pool, ["4-4-2", "4-3-3"]).draft.formation).toBe("4-3-3");
  });

  it("selects the formation with the higher total fit (MF-heavy → 4-4-2)", () => {
    // 4 elite MFs: 4-4-2 seats all four at exact MF; 4-3-3 forces one off-position.
    const pool: AutoPlayer[] = [
      mk("g", "GK", 60),
      ...Array.from({ length: 4 }, (_, i) => mk(`d${i}`, "DF", 55)),
      ...Array.from({ length: 4 }, (_, i) => mk(`m${i}`, "MF", 95)),
      ...Array.from({ length: 2 }, (_, i) => mk(`f${i}`, "FW", 55)),
    ];
    expect(autoBuildLineup(pool, ["4-4-2", "4-3-3"]).draft.formation).toBe("4-4-2");
  });

  it("maximizes total starter fit vs a plausible alternative arrangement", () => {
    // scarcity: only 2 FW owned for a 3-FW formation's needs; strong DFs must fill.
    const pool: AutoPlayer[] = [
      mk("g", "GK", 70),
      mk("d1", "DF", 88),
      mk("d2", "DF", 86),
      mk("d3", "DF", 84),
      mk("d4", "DF", 82),
      mk("d5", "DF", 80), // spare DF to push into midfield/attack
      mk("m1", "MF", 78),
      mk("m2", "MF", 76),
      mk("m3", "MF", 74),
      mk("f1", "FW", 90),
      mk("f2", "FW", 89),
    ];
    const { draft } = autoBuildLineup(pool, ["4-3-3"]);
    const slotPos = slotPositions("4-3-3");
    const total = draft.slots
      .filter((s) => s.role === "starter")
      .reduce((sum, s) => {
        const player = pool.find((p) => p.id === s.playerId)!;
        return sum + fitScore(player, slotPos.get(s.slotIndex)!);
      }, 0);

    // brute-force the true optimum for these 11 players over 11 slots is 11! — instead assert the
    // achieved total is ≥ a hand-built plausible arrangement (GK→g, DF slots→best 4 DF, MF→3 MF,
    // FW→2 FW + the spare DF at FW). Any suboptimal solver would fall below this baseline.
    const slots = [...slotPos.entries()].sort((a, b) => a[0] - b[0]);
    const baselineIds = ["g", "d1", "d2", "d3", "d4", "m1", "m2", "m3", "f1", "f2", "d5"];
    // map baseline players to slots in ascending slotIndex order (GK,DF×4,MF×3,FW×3 layout)
    const baseline = slots.reduce((sum, [, pos], i) => {
      const player = pool.find((p) => p.id === baselineIds[i])!;
      return sum + fitScore(player, pos);
    }, 0);
    expect(total).toBeGreaterThanOrEqual(baseline - 1e-9);
  });

  it("tie-break: equal-fit candidates resolve by playerId ascending", () => {
    // two identical MF (same overall) but only... give a 4-4-2 natural squad plus one EXTRA equal MF.
    // 4 MF slots, 5 equal MFs → the lex-largest id must be the one benched.
    const pool: AutoPlayer[] = [
      mk("g", "GK", 70),
      ...Array.from({ length: 4 }, (_, i) => mk(`d${i}`, "DF", 70)),
      ...Array.from({ length: 5 }, (_, i) => mk(`mZ${i}`, "MF", 70)), // mZ0..mZ4 all equal
      ...Array.from({ length: 2 }, (_, i) => mk(`f${i}`, "FW", 70)),
    ];
    const { draft } = autoBuildLineup(pool, ["4-4-2"]);
    const starterMf = draft.slots
      .filter((s) => s.role === "starter")
      .map((s) => s.playerId)
      .filter((id) => id.startsWith("mZ"))
      .sort();
    // lex-smallest 4 start; mZ4 is benched.
    expect(starterMf).toEqual(["mZ0", "mZ1", "mZ2", "mZ3"]);
  });

  it("handles owned < 11 without throwing (partial fill) and canAutoBuild guards it", () => {
    const small: AutoPlayer[] = [
      mk("g", "GK", 70),
      mk("d1", "DF", 70),
      mk("m1", "MF", 70),
      mk("f1", "FW", 70),
    ];
    expect(canAutoBuild(small)).toBe(false);
    expect(canAutoBuild(balancedPool())).toBe(true);
    const { draft } = autoBuildLineup(small);
    const starters = draft.slots.filter((s) => s.role === "starter");
    expect(starters.length).toBe(4); // only what's owned
    expect(draft.slots.filter((s) => s.role === "bench")).toHaveLength(0);
  });
});
