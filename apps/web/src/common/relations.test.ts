import { describe, expect, it } from "vitest";
import {
  moraleTier,
  personalityMeta,
  relationOf,
  streakLabel,
  streakTone,
  trustTier,
} from "./relations";
import type { RelationsResponse } from "../api/v2";

describe("trustTier gauge", () => {
  it("buckets trust into 4 tiers with a 0..1 ratio", () => {
    expect(trustTier(90).key).toBe("high");
    expect(trustTier(60).key).toBe("mid");
    expect(trustTier(30).key).toBe("low");
    expect(trustTier(10).key).toBe("distrust");
    expect(trustTier(50).ratio).toBeCloseTo(0.5);
  });

  it("clamps out-of-range trust and rounds value", () => {
    expect(trustTier(140).value).toBe(100);
    expect(trustTier(-20).value).toBe(0);
    expect(trustTier(74.6).value).toBe(75);
  });

  it("uses tier boundaries at 75/50/25 inclusive", () => {
    expect(trustTier(75).key).toBe("high");
    expect(trustTier(50).key).toBe("mid");
    expect(trustTier(25).key).toBe("low");
    expect(trustTier(24).key).toBe("distrust");
  });
});

describe("moraleTier gauge", () => {
  it("buckets morale into 3 tiers", () => {
    expect(moraleTier(80).key).toBe("high");
    expect(moraleTier(50).key).toBe("mid");
    expect(moraleTier(10).key).toBe("low");
  });

  it("ratio tracks value/100", () => {
    expect(moraleTier(40).ratio).toBeCloseTo(0.4);
  });
});

describe("streakLabel / streakTone", () => {
  it("labels wins, losses and none", () => {
    expect(streakLabel(3)).toBe("3연승");
    expect(streakLabel(-2)).toBe("2연패");
    expect(streakLabel(0)).toBe("연승·연패 없음");
  });

  it("maps sign to tone", () => {
    expect(streakTone(5)).toBe("win");
    expect(streakTone(-1)).toBe("loss");
    expect(streakTone(0)).toBe("none");
  });
});

describe("personalityMeta", () => {
  it("maps each personality to an emoji + label", () => {
    expect(personalityMeta("FIERY")!.emoji).toBe("🔥");
    expect(personalityMeta("GLASS")!.label).toBe("유리멘탈");
    expect(personalityMeta(undefined)).toBeUndefined();
  });
});

describe("relationOf", () => {
  const rels: RelationsResponse = {
    morale: 70,
    streak: 2,
    players: [
      { playerId: "p1", trust: 80, personality: "CALM" },
      { playerId: "p2", trust: 40, personality: "GLASS" },
    ],
  };
  it("finds a player's relation by id", () => {
    expect(relationOf(rels, "p2")!.trust).toBe(40);
  });
  it("returns undefined for unknown id or missing relations", () => {
    expect(relationOf(rels, "zzz")).toBeUndefined();
    expect(relationOf(undefined, "p1")).toBeUndefined();
  });
});
