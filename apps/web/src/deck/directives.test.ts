import { describe, expect, it } from "vitest";
import {
  composeLayers,
  composePrompt,
  DIRECTIVE_CHIPS,
  emptyDirectiveState,
  parseDirectiveText,
  ROLE_OPTIONS,
  synthesizeDirectiveText,
  toggleChip,
  type DirectiveState,
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

/**
 * A안의 핵심 계약 (#106 R2): `AI에 전달될 지시문` 미리보기의 두 줄을 이어붙이면 **서버로 가는
 * 문자열과 글자 단위로 같아야** 한다. 어긋나면 화면이 거짓말을 한다.
 */
describe("composeLayers — 미리보기 = 전송값", () => {
  const CASES: Array<[DirectiveState, string]> = [
    [emptyDirectiveState(), ""],
    [emptyDirectiveState(), "너만 믿는다"],
    [{ role: "attack", chipIds: [] }, ""],
    [{ role: "attack", chipIds: ["overlap", "runbehind"] }, "안쪽으로 파고들어라"],
    [{ role: "defend", chipIds: ["marking"] }, "  앞뒤 공백  "],
    [{ role: "support", chipIds: ["press", "tempo"] }, "첫 줄\n둘째 줄"],
  ];

  it.each(CASES)("두 줄을 합치면 전송 문자열과 동일하다 (%o / %j)", (state, free) => {
    const c = composeLayers(state, free);
    expect([c.directiveText, c.ownText].filter(Boolean).join("\n")).toBe(c.text);
    expect(c.text).toBe(composePrompt(state, free));
  });

  it("두 레이어가 실제로 구분돼 나온다(합성문에 자유 문장이 섞이지 않는다)", () => {
    const c = composeLayers({ role: "attack", chipIds: ["press"] }, "손흥민 조심해");
    expect(c.directiveText).not.toContain("손흥민");
    expect(c.ownText).toBe("손흥민 조심해");
    expect(c.text.startsWith(c.directiveText)).toBe(true);
    expect(c.text.endsWith(c.ownText)).toBe(true);
  });
});

describe("parseDirectiveText — 영속 프롬프트 → 두 레이어 복원", () => {
  it("compose → parse 왕복이 동일하다(합성문 중복 누적 방지)", () => {
    const state: DirectiveState = { role: "attack", chipIds: ["overlap", "runbehind"] };
    const free = "오넬이 벌려주면 안쪽으로 파고들어라";
    const parsed = parseDirectiveText(composePrompt(state, free));
    expect(parsed.state.role).toBe("attack");
    expect(parsed.state.chipIds.sort()).toEqual(["overlap", "runbehind"]);
    expect(parsed.freeText).toBe(free);
    // 복원한 상태로 다시 합성하면 원본과 글자 단위로 같다
    expect(composePrompt(parsed.state, parsed.freeText)).toBe(composePrompt(state, free));
  });

  it("지시 없이 자유 문장만 있던 프롬프트는 통째로 자유 문장이다", () => {
    const p = parseDirectiveText("안쪽으로 파고들어라");
    expect(p.state).toEqual(emptyDirectiveState());
    expect(p.freeText).toBe("안쪽으로 파고들어라");
  });

  it("카탈로그에 없는 문장이 섞인 첫 줄은 지시로 인정하지 않는다(보수적)", () => {
    const text = "공격 가담을 늘려 전진한다. 내 맘대로 문장이다.";
    const p = parseDirectiveText(text);
    expect(p.state).toEqual(emptyDirectiveState());
    expect(p.freeText).toBe(text);
  });

  it("빈 값/누락은 빈 상태", () => {
    expect(parseDirectiveText(null)).toEqual({ state: emptyDirectiveState(), freeText: "" });
    expect(parseDirectiveText("   ")).toEqual({ state: emptyDirectiveState(), freeText: "" });
  });

  it("지시만 있던 프롬프트는 자유 문장이 비어 복원된다", () => {
    const only = composePrompt({ role: "balanced", chipIds: ["marking"] }, "");
    const p = parseDirectiveText(only);
    expect(p.state.chipIds).toEqual(["marking"]);
    expect(p.freeText).toBe("");
  });

  it("자유 문장이 여러 줄이어도 보존된다", () => {
    const free = "첫 줄\n둘째 줄";
    const p = parseDirectiveText(composePrompt({ role: "defend", chipIds: [] }, free));
    expect(p.freeText).toBe(free);
    expect(p.state.role).toBe("defend");
  });
});
