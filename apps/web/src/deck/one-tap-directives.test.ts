import { describe, expect, it } from "vitest";
import {
  appendDirective,
  autoAssignDefender,
  findOneTapDirective,
  MARK_DIRECTIVE,
  ONE_TAP_DIRECTIVES,
  type DefenderCandidate,
} from "./one-tap-directives";

describe("marking one-tap directive", () => {
  it("synthesizes '[상대이름] 막아'", () => {
    expect(MARK_DIRECTIVE.synthesize("메시")).toBe("메시 막아");
    expect(MARK_DIRECTIVE.label("메시")).toBe("메시 마크");
  });

  it("is registered in the generalized catalog and findable by id", () => {
    expect(ONE_TAP_DIRECTIVES.map((d) => d.id)).toContain("mark");
    expect(findOneTapDirective("mark")).toBe(MARK_DIRECTIVE);
    expect(findOneTapDirective("nope")).toBeUndefined();
  });
});

describe("appendDirective", () => {
  it("appends onto an empty prompt", () => {
    expect(appendDirective("", "메시 막아")).toBe("메시 막아");
    expect(appendDirective(null, "메시 막아")).toBe("메시 막아");
  });

  it("preserves the existing free prompt on a new line", () => {
    expect(appendDirective("과감하게 슛 노려", "메시 막아")).toBe("과감하게 슛 노려\n메시 막아");
  });

  it("is idempotent — same line is not duplicated", () => {
    const once = appendDirective("메시 막아", "메시 막아");
    expect(once).toBe("메시 막아");
    const kept = appendDirective("슛 노려\n메시 막아", "메시 막아");
    expect(kept).toBe("슛 노려\n메시 막아");
  });
});

describe("autoAssignDefender", () => {
  const roster: DefenderCandidate[] = [
    { playerId: "gk", name: "키퍼", position: "GK" },
    { playerId: "mf", name: "미들", position: "MF" },
    { playerId: "df", name: "센터백", position: "DF" },
    { playerId: "fw", name: "스트라이커", position: "FW" },
  ];

  it("prefers a DF", () => {
    expect(autoAssignDefender(roster)!.playerId).toBe("df");
  });

  it("falls back to MF when no DF", () => {
    expect(autoAssignDefender(roster.filter((c) => c.position !== "DF"))!.playerId).toBe("mf");
  });

  it("never picks a GK, returns undefined if only GK", () => {
    expect(autoAssignDefender([{ playerId: "gk", name: "키퍼", position: "GK" }])).toBeUndefined();
  });
});
