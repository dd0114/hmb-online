import { describe, expect, it } from "vitest";
import {
  __internal,
  setRoleSafely,
  toggleChipSafely,
  composeLayers,
  composePrompt,
  DIRECTIVE_CHIPS,
  emptyDirectiveState,
  parseDirectiveText,
  ROLE_OPTIONS,
  synthesizeDirectiveText,
  toggleChip,
  type DirectiveEdit,
  type DirectiveEditResult,
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

/**
 * ── #106 R3a m1: **유저 문장이 소리 없이 사라지지 않는다** ────────────────────────────────
 *
 * 저장 포맷이 단일 문자열(서버 계약)이라 "칩에서 합성된 문장"과 "유저가 우연히 똑같이 쓴 문장"은
 * 글자 단위로 구별 불가능하다 — 파서를 아무리 고쳐도 이 모호성은 없앨 수 없다. 그래서 계약을
 * "완벽히 구별한다"가 아니라 **"사라지는 문장은 반드시 되돌릴 수 있게 보고한다"** 로 세운다:
 *   · 추론(파싱)으로 켜진 항목을 끄면 `droppedInferred` 로 그 문장을 돌려준다(= UI 복구 제안).
 *   · 사용자가 이번 세션에 직접 켠 항목을 끄는 건 손실이 아니므로 null(잡음 없음).
 *   · `restoreSentence` 로 되돌리면 원래 프롬프트가 **글자 단위로** 복원된다(단일 문장 케이스).
 * `composeLayers` 단일 출처(미리보기 = 전송값)는 그대로다 — 복구는 자유 문장 쪽만 바꾼다.
 */
const PRESS = DIRECTIVE_CHIPS.find((c) => c.id === "press")!;
const ATTACK = ROLE_OPTIONS.find((r) => r.id === "attack")!;

/** "문장" 단위로 쪼갠다 — 줄바꿈과 ". " 기준(합성문은 한 줄에 여러 문장). */
function sentences(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => line.split(". "))
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

/** 편집 전후로 사라진 문장이 있으면 반드시 `droppedInferred` 로 보고됐어야 한다. */
function assertNoSilentLoss(state: DirectiveState, free: string, edit: DirectiveEdit) {
  const before = sentences(composePrompt(state, free));
  const after = new Set(sentences(composePrompt(edit.state, free)));
  const reported = edit.droppedInferred ? sentences(edit.droppedInferred) : [];
  for (const s of before) {
    expect(after.has(s) || reported.includes(s), `문장이 보고 없이 사라졌다: "${s}"`).toBe(true);
  }
}

describe("m1 — 재진입 후 칩을 꺼도 유저 문장이 소리 없이 사라지지 않는다", () => {
  it("재현 시나리오: 한마디에 카탈로그와 똑같이 쓴 문장 → 저장 → 재진입 → 칩 끄기", () => {
    const typed = `${PRESS.phrase}.`;
    const saved = composePrompt(emptyDirectiveState(), typed);
    expect(saved).toBe(typed);

    // 재진입: 문자열만으로는 구별할 수 없어 압박 칩으로 인식된다(불가피) — 대신 **추론**으로 표시된다.
    const parsed = parseDirectiveText(saved);
    expect(parsed.state.chipIds).toEqual(["press"]);
    expect(parsed.state.inferred).toContain("chip:press");
    expect(parsed.freeText).toBe("");

    // 칩을 끄면 프롬프트에서는 빠지지만 **문장을 돌려준다**(=복구 제안).
    const edit = __internal.applyChipToggle(parsed.state, "press");
    expect(edit.droppedInferred).toBe(PRESS.phrase);
    assertNoSilentLoss(parsed.state, parsed.freeText, edit);
    expect(composePrompt(edit.state, parsed.freeText)).toBe("");

    // 되돌리면 원본 프롬프트가 글자 단위로 복원된다.
    const restoredFree = __internal.restoreSentence(parsed.freeText, edit.droppedInferred!);
    expect(composePrompt(edit.state, restoredFree)).toBe(saved);
  });

  it("이번 세션에 직접 켠 칩을 끄는 건 손실이 아니다(복구 제안 잡음 없음)", () => {
    const on = __internal.applyChipToggle(emptyDirectiveState(), "press");
    expect(on.droppedInferred).toBeNull();
    const off = __internal.applyChipToggle(on.state, "press");
    expect(off.droppedInferred).toBeNull();
    // 이 문장은 유저가 쓴 게 아니라 칩이 만든 것이므로 사라져도 손실이 아니다(복구 제안 없음).
    expect(composePrompt(off.state, "")).toBe("");
  });

  it("직접 켰다가 저장·재진입하면 다시 추론이 되고, 끌 때 문장을 돌려준다", () => {
    const on = __internal.applyChipToggle(emptyDirectiveState(), "press").state;
    const saved = composePrompt(on, "오늘 잘하자");
    const parsed = parseDirectiveText(saved);
    const off = __internal.applyChipToggle(parsed.state, "press");
    expect(off.droppedInferred).toBe(PRESS.phrase);
    // 되돌리면 문장 집합이 보존된다(레이어 경계만 이동).
    const restored = __internal.restoreSentence(parsed.freeText, off.droppedInferred!);
    expect(sentences(composePrompt(off.state, restored)).sort()).toEqual(sentences(saved).sort());
  });

  it("역할 교체도 같은 보호를 받는다(이전 역할 문장이 조용히 사라지지 않는다)", () => {
    const saved = composePrompt({ role: "attack", chipIds: [], inferred: [] }, "");
    const parsed = parseDirectiveText(saved);
    expect(parsed.state.role).toBe("attack");
    const edit = __internal.applyRole(parsed.state, "defend");
    expect(edit.droppedInferred).toBe(ATTACK.phrase);
    assertNoSilentLoss(parsed.state, parsed.freeText, edit);
    // 직접 고른 뒤 다시 바꾸는 건 손실이 아니다
    expect(__internal.applyRole(edit.state, "support").droppedInferred).toBeNull();
  });

  it("여러 줄 자유 문장이 섞여 있어도 문장 집합이 보존된다", () => {
    const saved = `${PRESS.phrase}.\n오늘 잘하자\n둘째 줄`;
    const parsed = parseDirectiveText(saved);
    expect(parsed.freeText).toBe("오늘 잘하자\n둘째 줄");
    const edit = __internal.applyChipToggle(parsed.state, "press");
    assertNoSilentLoss(parsed.state, parsed.freeText, edit);
    const restored = __internal.restoreSentence(parsed.freeText, edit.droppedInferred!);
    expect(composePrompt(edit.state, restored)).toBe(saved);
  });

  it("왕복(저장→재진입→토글) 을 여러 라운드 돌려도 문장이 보고 없이 사라지지 않는다", () => {
    const CASES: Array<[DirectiveState, string]> = [
      [emptyDirectiveState(), ""],
      [emptyDirectiveState(), "   "],
      [emptyDirectiveState(), `${PRESS.phrase}.`], // 우연 일치(재현 케이스)
      [emptyDirectiveState(), `${ATTACK.phrase}. ${PRESS.phrase}.`], // 두 문장 우연 일치
      [emptyDirectiveState(), "마침표 없는 자유 문장"],
      [{ role: "attack", chipIds: ["overlap", "runbehind"], inferred: [] }, "안쪽으로 파고들어라"],
      [{ role: "defend", chipIds: ["marking"], inferred: [] }, `${PRESS.phrase}.\n둘째 줄`],
    ];
    for (const [state0, free0] of CASES) {
      let text = composePrompt(state0, free0);
      const original = sentences(text);
      for (let round = 0; round < 3; round += 1) {
        const parsed = parseDirectiveText(text);
        // 미리보기 = 전송값 불변식은 라운드마다 유지된다
        const c = composeLayers(parsed.state, parsed.freeText);
        expect([c.directiveText, c.ownText].filter(Boolean).join("\n")).toBe(c.text);
        expect(c.text).toBe(text.trim());

        // 켜져 있는 칩을 하나 끈다 → 손실은 반드시 보고되고, 되돌리면 문장 집합이 유지된다
        const chipId = parsed.state.chipIds[0];
        if (chipId) {
          const edit = __internal.applyChipToggle(parsed.state, chipId);
          assertNoSilentLoss(parsed.state, parsed.freeText, edit);
          const free = edit.droppedInferred
            ? __internal.restoreSentence(parsed.freeText, edit.droppedInferred)
            : parsed.freeText;
          text = composePrompt(edit.state, free);
        } else {
          const edit = __internal.applyRole(parsed.state, parsed.state.role === "attack" ? "defend" : "attack");
          assertNoSilentLoss(parsed.state, parsed.freeText, edit);
          text = composePrompt(edit.state, edit.droppedInferred
            ? __internal.restoreSentence(parsed.freeText, edit.droppedInferred)
            : parsed.freeText);
        }
      }
      // 라운드를 다 돌아도 원래 문장은 전부 남아 있다
      const left = new Set(sentences(text));
      for (const s of original) expect(left.has(s), `라운드 후 유실: "${s}"`).toBe(true);
    }
  });
});

/**
 * ── R3a 재검증 blocker-1: **파싱 단계 손실 0** ────────────────────────────────────────────
 * 문구를 하나씩 되짚기만 하면 중복 문구·역할 2개·비카탈로그 순서가 로드 시점에 **조용히 흡수**돼
 * 토글도 하기 전에 문장이 없어졌다(복구 경로조차 안 탄다). 되짚은 상태를 다시 합성해 원문 첫 줄과
 * 글자 단위로 같을 때만 지시로 인정한다 → 어떤 저장 문자열이든 파싱은 무손실이다.
 */
describe("blocker-1 — parseDirectiveText 는 재구성 가능한 첫 줄만 지시로 인정한다", () => {
  const DEFEND = ROLE_OPTIONS.find((r) => r.id === "defend")!;
  const MARK = DIRECTIVE_CHIPS.find((c) => c.id === "marking")!;

  /** 어떤 입력이든 파싱은 문자열을 잃지 않는다(합성 + 자유 문장 = 원문). */
  function assertParseLossless(text: string) {
    const p = parseDirectiveText(text);
    expect(composePrompt(p.state, p.freeText), `파싱 왕복 손실: ${JSON.stringify(text)}`).toBe(text.trim());
  }

  it("같은 문구가 두 번 나오면 지시로 인정하지 않는다(예전엔 1개로 흡수 = 1문장 소실)", () => {
    const text = `${PRESS.phrase}. ${PRESS.phrase}.`;
    const p = parseDirectiveText(text);
    expect(p.state).toEqual(emptyDirectiveState());
    expect(p.freeText).toBe(text);
    assertParseLossless(text);
  });

  it("역할 문구가 둘이면 지시로 인정하지 않는다(예전엔 뒤가 앞을 덮어써 1문장 소실)", () => {
    const text = `${ATTACK.phrase}. ${DEFEND.phrase}.`;
    const p = parseDirectiveText(text);
    expect(p.state).toEqual(emptyDirectiveState());
    expect(p.freeText).toBe(text);
    assertParseLossless(text);
  });

  it("카탈로그 순서가 아니면 지시로 인정하지 않는다(복원 시 재정렬 = 문장 순서 변조 방지)", () => {
    const text = `${PRESS.phrase}. ${MARK.phrase}.`; // 합성 순서는 마킹 → 압박
    const p = parseDirectiveText(text);
    expect(p.state).toEqual(emptyDirectiveState());
    expect(p.freeText).toBe(text);
    assertParseLossless(text);
  });

  it("역할이 칩 뒤에 오면 인정하지 않는다(합성은 역할 먼저)", () => {
    assertParseLossless(`${PRESS.phrase}. ${ATTACK.phrase}.`);
    expect(parseDirectiveText(`${PRESS.phrase}. ${ATTACK.phrase}.`).state).toEqual(emptyDirectiveState());
  });

  it("정상 합성문은 그대로 인정된다(R2 '합성문 중복 누적' 회귀 방지 유지)", () => {
    const state: DirectiveState = { role: "attack", chipIds: ["marking", "press"], inferred: [] };
    const saved = composePrompt(state, "내 문장");
    const p = parseDirectiveText(saved);
    expect(p.state.role).toBe("attack");
    expect(p.state.chipIds.sort()).toEqual(["marking", "press"]);
    expect(p.freeText).toBe("내 문장");
    // 복원 상태로 칩을 하나 더 켜도 합성문이 중복 누적되지 않는다
    const more = toggleChipSafely(p.state, p.freeText, "tempo");
    expect(composePrompt(more.state, more.freeText).split("압박").length - 1).toBe(1);
  });

  it("어떤 저장 문자열도 파싱 왕복이 무손실이다(케이스 스윕)", () => {
    const CASES = [
      "",
      "   ",
      "자유 문장",
      `${PRESS.phrase}.`,
      `${PRESS.phrase}. ${PRESS.phrase}.`,
      `${ATTACK.phrase}. ${DEFEND.phrase}.`,
      `${ATTACK.phrase}. ${PRESS.phrase}.\n내 문장`,
      `${PRESS.phrase}. ${MARK.phrase}.\n내 문장\n둘째 줄`,
      "마침표 없는 줄\n둘째 줄",
      `${ATTACK.phrase}. 내 맘대로 문장.`,
    ];
    for (const c of CASES) assertParseLossless(c);
  });
});

/**
 * ── R3a 재검증 blocker-2: **연속 편집·이탈에도 손실 0** ───────────────────────────────────
 * 예전 설계(사후 배너 복구)는 배너가 덮이거나(연속 해제) 소비 전에 이탈하면(레일 닫기) 문장이
 * 영구 소실됐다. 이제 추론 항목 해제는 **즉시 자유 문장으로 이동**이라 배너와 무관하게 안전하다.
 *
 * 불변식: 저장값의 문장 집합 ⊆ (합성문 ∪ 감독의 한마디) — 어디에도 없는 문장이 생기면 FAIL.
 */
describe("blocker-2 — 연속 편집·이탈 후에도 원본 문장이 남는다", () => {
  const DEFEND = ROLE_OPTIONS.find((r) => r.id === "defend")!;
  const MARK = DIRECTIVE_CHIPS.find((c) => c.id === "marking")!;

  function assertKeepsAll(original: string, state: DirectiveState, free: string, label: string) {
    const now = new Set(sentences(composePrompt(state, free)));
    for (const s of sentences(original)) {
      expect(now.has(s), `${label}: 문장 소실 "${s}"`).toBe(true);
    }
  }

  it("칩 2개를 연달아 꺼도 두 문장이 모두 남는다(예전엔 2차 안내가 1차를 덮어 소실)", () => {
    const saved = composePrompt({ role: "balanced", chipIds: ["marking", "press"], inferred: [] }, "");
    const p = parseDirectiveText(saved);
    let r = toggleChipSafely(p.state, p.freeText, "marking");
    expect(r.moved).toBe(MARK.phrase);
    r = toggleChipSafely(r.state, r.freeText, "press");
    expect(r.moved).toBe(PRESS.phrase);
    assertKeepsAll(saved, r.state, r.freeText, "칩 연속 해제");
    expect(composePrompt(r.state, r.freeText)).toContain(MARK.phrase);
  });

  it("역할 교체 → 칩 해제 → 역할 재교체 연속 편집에도 전부 남는다", () => {
    const saved = composePrompt({ role: "attack", chipIds: ["press"], inferred: [] }, "내 문장");
    const p = parseDirectiveText(saved);
    let r = setRoleSafely(p.state, p.freeText, "defend");
    r = toggleChipSafely(r.state, r.freeText, "press");
    r = setRoleSafely(r.state, r.freeText, "support");
    assertKeepsAll(saved, r.state, r.freeText, "역할·칩 혼합 연속 편집");
    // 직접 고른 역할(defend)은 사용자가 이번 세션에 고른 것이라 사라져도 손실이 아니다
    expect(composePrompt(r.state, r.freeText)).not.toContain(DEFEND.phrase);
  });

  it("안내를 소비하지 않고 이탈(재파싱)해도 손실이 없다 — 저장→재진입 3라운드", () => {
    let text = composePrompt({ role: "attack", chipIds: ["marking", "press"], inferred: [] }, "내 문장");
    const original = text;
    for (let round = 0; round < 3; round += 1) {
      const p = parseDirectiveText(text); // = 레일 닫고 다시 열기(또는 새로고침)
      const first = p.state.chipIds[0];
      const r = first
        ? toggleChipSafely(p.state, p.freeText, first)
        : setRoleSafely(p.state, p.freeText, p.state.role === "attack" ? "balanced" : "attack");
      text = composePrompt(r.state, r.freeText); // 안내를 무시하고 그대로 저장
      assertKeepsAll(original, r.state, r.freeText, `라운드 ${round}`);
    }
  });

  it("불변식: 임의 편집 시퀀스에서 저장값 문장 ⊆ (합성문 ∪ 한마디), 없던 문장도 안 생긴다", () => {
    const CASES: string[] = [
      composePrompt({ role: "attack", chipIds: ["overlap", "runbehind"], inferred: [] }, "안쪽으로"),
      `${PRESS.phrase}.`,
      `${PRESS.phrase}. ${PRESS.phrase}.`,
      `${ATTACK.phrase}. ${DEFEND.phrase}.\n내 문장`,
      `${MARK.phrase}. ${PRESS.phrase}.\n첫 줄\n둘째 줄`,
    ];
    const EDITS = ["marking", "press", "overlap", "runbehind", "longball", "tempo"];
    for (const saved of CASES) {
      const p = parseDirectiveText(saved);
      let r: DirectiveEditResult = { state: p.state, freeText: p.freeText, moved: null };
      const allowed = new Set(sentences(saved));
      for (const chipId of EDITS) {
        r = toggleChipSafely(r.state, r.freeText, chipId);
        assertKeepsAll(saved, r.state, r.freeText, `연속 ${chipId}`);
        // 미리보기 = 전송값(R2 핵심)도 매 편집마다 유지된다
        const c = composeLayers(r.state, r.freeText);
        expect([c.directiveText, c.ownText].filter(Boolean).join("\n")).toBe(c.text);
        // 켠 칩이 만든 문장 외에 **출처 불명 문장**이 생기지 않는다
        for (const s of sentences(c.text)) {
          const known =
            allowed.has(s) ||
            DIRECTIVE_CHIPS.some((ch) => sentences(ch.phrase).includes(s)) ||
            ROLE_OPTIONS.some((ro) => ro.phrase && sentences(ro.phrase).includes(s));
          expect(known, `출처 불명 문장 생성: "${s}"`).toBe(true);
        }
      }
    }
  });
});

/**
 * F1(#106 R3b) — **다문장 이동 시 순서가 뒤집히지 않는다**.
 *
 * `restoreSentence` 는 원래 무조건 맨 앞에 prepend 했다. 그래서 추론 항목을 **연속으로** 끄면
 * (마킹 끄고 → 압박 끄기) 나중 것이 앞에 붙어 원래 합성문과 순서가 뒤집혔다. 내용은 보존되므로
 * 손실은 아니지만, 뒤집힌 문자열은 재저장 시 파싱 왕복 검증을 통과하지 못해(카탈로그 순서가 아님)
 * 지시 레이어로 되돌아오지 못하고 통째로 자유 문장이 된다.
 */
describe("F1 — 연속 이동 후에도 카탈로그 순서가 보존된다", () => {
  it("두 칩을 잇달아 끄면 옮겨진 두 문장이 카탈로그 순서로 남는다", () => {
    const saved = composePrompt(
      { role: "balanced", chipIds: ["marking", "press"], inferred: [] },
      "",
    );
    // 저장 문자열은 카탈로그 순서(마킹 → 압박)
    expect(saved.indexOf("마크")).toBeLessThan(saved.indexOf("압박"));

    // 재진입 후 마킹 → 압박 순으로 끈다(각각 자유 문장으로 이동).
    let p = parseDirectiveText(saved);
    let r = toggleChipSafely(p.state, p.freeText, "marking");
    let text = composePrompt(r.state, r.freeText);
    p = parseDirectiveText(text);
    r = toggleChipSafely(p.state, p.freeText, "press");
    text = composePrompt(r.state, r.freeText);

    // 두 문장이 모두 남아 있고, 순서가 원본과 같다(뒤집힘 없음).
    expect(text).toContain("마크");
    expect(text).toContain("압박");
    expect(text.indexOf("마크"), "연속 이동 후 순서가 뒤집혔다").toBeLessThan(text.indexOf("압박"));
  });

  it("한 문장만 옮길 때는 기존 동작(맨 앞) 그대로 — 글자 단위 복원 계약 유지", () => {
    const free = "오늘 잘하자";
    const out = __internal.restoreSentence(free, PRESS.phrase);
    expect(out).toBe(`${PRESS.phrase}.\n${free}`);
  });

  it("유저가 쓴 줄은 재정렬 대상이 아니다(선두 카탈로그 블록만 정렬)", () => {
    const free = `${DIRECTIVE_CHIPS.find((c) => c.id === "tempo")!.phrase}.\n내 문장`;
    const out = __internal.restoreSentence(free, PRESS.phrase);
    // 압박(카탈로그 5번)은 템포(6번)보다 앞 → 선두 블록 안에서 앞자리, "내 문장"은 그대로 뒤에.
    expect(out.split("\n")[2]).toBe("내 문장");
    expect(out.indexOf("압박")).toBeLessThan(out.indexOf("템포"));
  });
});
