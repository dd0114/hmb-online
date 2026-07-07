import { describe, it, expect } from "vitest";
import {
  TacticalInput,
  SelectData,
  MatchLog,
  clampTacticalInput,
  clamp,
  clamp01,
  type TacticalInput as TacticalInputT,
} from "../src/index.js";

const sampleInput: TacticalInputT = {
  seed: "12345678901234567890",
  team: {
    formation: "4-3-3",
    defensiveLineHeight: 0.6,
    compactness: 0.5,
    tempo: 0.7,
    width: 0.6,
    pressingScheme: { intensity: 0.8, triggerLine: 0.7 },
    offsideTrap: true,
  },
  players: [
    {
      playerId: "p1",
      role: "fullback",
      duty: "support",
      basePosition: { x: 0.2, y: 0.9 },
      behavior: {
        positioningFreedom: 0.4,
        forwardRunFreq: 0.3,
        widthTendency: 0.7,
        supportDepth: 0.4,
        pressAggression: 0.5,
        passRisk: 0.3,
        passDirectness: 0.5,
        dribbleTendency: 0.4,
        shootTendency: 0.1,
      },
      markTarget: "opp11",
      mentalModifier: 0.2,
    },
  ],
  meta: { promptHash: "abc" },
};

describe("clamp utils", () => {
  it("clamps into range and maps NaN to min", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-2, 0, 1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });
});

describe("TacticalInput schema", () => {
  it("round-trips through JSON without loss (AC2)", () => {
    const json = JSON.stringify(sampleInput);
    const parsed = TacticalInput.parse(JSON.parse(json));
    expect(parsed).toEqual(sampleInput);
  });

  it("preserves uint64 seed precision as string", () => {
    const parsed = TacticalInput.parse(JSON.parse(JSON.stringify(sampleInput)));
    expect(parsed.seed).toBe("12345678901234567890");
  });

  it("rejects malformed input", () => {
    expect(() => TacticalInput.parse({ seed: 123 })).toThrow();
  });
});

describe("clampTacticalInput (AC3)", () => {
  it("clamps out-of-range values into valid bounds", () => {
    const dirty: TacticalInputT = {
      ...sampleInput,
      team: { ...sampleInput.team, defensiveLineHeight: 5, tempo: -3 },
      players: [
        {
          ...sampleInput.players[0]!,
          basePosition: { x: 9, y: -1 },
          mentalModifier: 4,
          behavior: { ...sampleInput.players[0]!.behavior, forwardRunFreq: 2, widthTendency: -0.5 },
        },
      ],
    };
    const clean = clampTacticalInput(dirty);
    expect(clean.team.defensiveLineHeight).toBe(1);
    expect(clean.team.tempo).toBe(0);
    expect(clean.players[0]!.basePosition.x).toBe(1);
    expect(clean.players[0]!.basePosition.y).toBe(0);
    expect(clean.players[0]!.mentalModifier).toBe(1);
    expect(clean.players[0]!.behavior.forwardRunFreq).toBe(1);
    expect(clean.players[0]!.behavior.widthTendency).toBe(0);
  });

  it("is idempotent on already-valid input", () => {
    expect(clampTacticalInput(sampleInput)).toEqual(sampleInput);
  });
});

describe("SelectData & MatchLog schemas", () => {
  it("parses a minimal SelectData", () => {
    const sd = {
      home: { name: "H", players: [] },
      away: { name: "A", players: [] },
    };
    expect(() => SelectData.parse(sd)).not.toThrow();
  });

  it("parses a minimal MatchLog", () => {
    const log = {
      configVersion: "engine@0.1.0",
      seed: "1",
      tickSnapshots: [],
      events: [],
      finalScore: { home: 0, away: 0 },
    };
    expect(() => MatchLog.parse(log)).not.toThrow();
  });
});
