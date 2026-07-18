import { describe, expect, it } from "vitest";
import {
  composePrompt,
  DIRECTIVE_CHIPS,
  emptyDirectiveState,
  ROLE_OPTIONS,
  synthesizeDirectiveText,
  toggleChip,
} from "./directives";

describe("directive catalog", () => {
  it("ships the 6 catalog chips (마킹·오버랩·침투·롱볼·압박·템포)", () => {
    expect(DIRECTIVE_CHIPS.map((c) => c.id)).toEqual([
      "marking",
      "overlap",
      "runbehind",
      "longball",
      "press",
      "tempo",
    ]);
  });
});

describe("toggleChip", () => {
  it("adds then removes a chip", () => {
    let s = emptyDirectiveState();
    s = toggleChip(s, "press");
    expect(s.chipIds).toContain("press");
    s = toggleChip(s, "press");
    expect(s.chipIds).not.toContain("press");
  });
});

describe("synthesizeDirectiveText", () => {
  it("returns empty for the default balanced role with no chips", () => {
    expect(synthesizeDirectiveText(emptyDirectiveState())).toBe("");
  });

  it("emits chips in catalog order, not selection order", () => {
    let s = emptyDirectiveState();
    s = toggleChip(s, "tempo"); // last in catalog, selected first
    s = toggleChip(s, "marking"); // first in catalog, selected second
    const text = synthesizeDirectiveText(s);
    expect(text.indexOf("마크")).toBeLessThan(text.indexOf("템포"));
  });

  it("prepends the role phrase before chips", () => {
    const attack = ROLE_OPTIONS.find((r) => r.id === "attack")!;
    let s = { role: "attack", chipIds: ["press"] };
    const text = synthesizeDirectiveText(s);
    expect(text.startsWith(attack.phrase)).toBe(true);
    expect(text).toContain("압박");
  });

  it("ends each fragment with a period", () => {
    const text = synthesizeDirectiveText({ role: "balanced", chipIds: ["marking"] });
    expect(text.trim().endsWith(".")).toBe(true);
  });
});

describe("composePrompt", () => {
  it("joins directive text and free prompt with a newline", () => {
    const out = composePrompt({ role: "balanced", chipIds: ["press"] }, "손흥민 조심해");
    expect(out).toContain("압박");
    expect(out).toContain("손흥민 조심해");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("returns only free text when no directives are set", () => {
    expect(composePrompt(emptyDirectiveState(), "자유 지시")).toBe("자유 지시");
  });

  it("returns only directive text when free prompt is blank", () => {
    const out = composePrompt({ role: "balanced", chipIds: ["longball"] }, "   ");
    expect(out).not.toContain("\n");
    expect(out).toContain("롱볼");
  });
});
