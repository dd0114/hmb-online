import { describe, expect, it } from "vitest";
import type { TeamPresetSlot, TeamSnapshot } from "../api/v2";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "../deck/tactics-logic";
import {
  briefingBaseline,
  briefingPresetChoices,
  hasAnyPreset,
  isMatchEditDirty,
  presetEditorFor,
  selectionOutcome,
} from "./briefing-preset-logic";

function snap(formation: string, starters: string[], teamPrompt = ""): TeamSnapshot {
  return {
    formation,
    starters: starters.map((playerId, i) => ({ playerId, slotIndex: i, promptText: null })),
    bench: [],
    teamTactics: { ...DEFAULT_TEAM_TACTICS },
    teamPrompt,
  };
}

const SLOTS: TeamPresetSlot[] = [
  { slot: 2, name: "백업 전술", snapshot: snap("4-3-3", ["B1", "B2"], "측면 활용") },
  { slot: 1, name: "메인 전술", snapshot: snap("4-4-2", ["A1", "A2"]) },
  { slot: 3, name: null, snapshot: null },
];

describe("briefingPresetChoices (요구 2 — 게임 시작 시 1/2/3 선택)", () => {
  it("슬롯 번호 오름차순 + 채워진 슬롯만 filled, 빈 슬롯은 '비어 있음'", () => {
    const choices = briefingPresetChoices(SLOTS);
    expect(choices.map((c) => c.slot)).toEqual([1, 2, 3]);
    expect(choices.map((c) => c.filled)).toEqual([true, true, false]);
    expect(choices[0]!.name).toBe("메인 전술");
    expect(choices[1]!.name).toBe("백업 전술");
    expect(choices[2]!.name).toBe("비어 있음");
  });

  it("이름 없는 채워진 슬롯은 '프리셋 N' 로 폴백", () => {
    const choices = briefingPresetChoices([{ slot: 1, name: null, snapshot: snap("4-4-2", ["A1"]) }]);
    expect(choices[0]!.name).toBe("프리셋 1");
  });

  it("undefined/빈 목록은 빈 배열", () => {
    expect(briefingPresetChoices(undefined)).toEqual([]);
    expect(briefingPresetChoices([])).toEqual([]);
  });
});

describe("hasAnyPreset (칩 행 노출 게이트)", () => {
  it("서버가 항상 주는 3슬롯이 전부 비었으면 숨김(신규 유저)", () => {
    const empty: TeamPresetSlot[] = [
      { slot: 1, name: null, snapshot: null },
      { slot: 2, name: null, snapshot: null },
      { slot: 3, name: null, snapshot: null },
    ];
    expect(hasAnyPreset(briefingPresetChoices(empty))).toBe(false);
  });

  it("하나라도 채워져 있으면 노출", () => {
    expect(hasAnyPreset(briefingPresetChoices(SLOTS))).toBe(true);
  });

  it("응답 없음/빈 목록도 숨김", () => {
    expect(hasAnyPreset(briefingPresetChoices(undefined))).toBe(false);
    expect(hasAnyPreset(briefingPresetChoices([]))).toBe(false);
  });
});

describe("presetEditorFor", () => {
  it("채워진 슬롯 → 그 스냅샷의 editor 상태", () => {
    const ed = presetEditorFor(SLOTS, 2);
    expect(ed).not.toBeNull();
    expect(ed!.draft.formation).toBe("4-3-3");
    expect(ed!.draft.slots.map((s) => s.playerId)).toEqual(["B1", "B2"]);
    expect(ed!.teamPrompt).toBe("측면 활용");
  });

  it("빈 슬롯/없는 슬롯 → null (선택 불가)", () => {
    expect(presetEditorFor(SLOTS, 3)).toBeNull();
    expect(presetEditorFor(SLOTS, 9)).toBeNull();
    expect(presetEditorFor(SLOTS, null)).toBeNull();
  });
});

describe("isMatchEditDirty / briefingBaseline", () => {
  const editor: EditorState = presetEditorFor(SLOTS, 1)!;

  it("로드 직후는 dirty 아님", () => {
    expect(isMatchEditDirty(editor, briefingBaseline(editor))).toBe(false);
  });

  it("매치용 수정(팀 프롬프트/라인업) 후 dirty", () => {
    const base = briefingBaseline(editor);
    expect(isMatchEditDirty({ ...editor, teamPrompt: "오늘은 수비적으로" }, base)).toBe(true);
    expect(
      isMatchEditDirty(
        { ...editor, draft: { ...editor.draft, formation: "4-3-3" } },
        base,
      ),
    ).toBe(true);
  });
});

describe("selectionOutcome (덮어쓰기 확인 UX)", () => {
  const base = { slots: SLOTS };

  it("빈 슬롯 선택 → ignore", () => {
    expect(selectionOutcome({ ...base, slot: 3, selectedSlot: null, dirty: false })).toBe("ignore");
  });

  it("clean 상태에서 채워진 슬롯 → 즉시 load", () => {
    expect(selectionOutcome({ ...base, slot: 1, selectedSlot: null, dirty: false })).toBe("load");
  });

  it("dirty 상태에서 다른 슬롯 → confirm(수정사항 사라짐 확인)", () => {
    expect(selectionOutcome({ ...base, slot: 2, selectedSlot: 1, dirty: true })).toBe("confirm");
  });

  it("dirty 상태에서 같은 슬롯 재선택(되돌리기) → confirm", () => {
    expect(selectionOutcome({ ...base, slot: 1, selectedSlot: 1, dirty: true })).toBe("confirm");
  });

  it("clean 상태에서 이미 선택된 슬롯 재선택 → ignore(무의미한 재로드 방지)", () => {
    expect(selectionOutcome({ ...base, slot: 1, selectedSlot: 1, dirty: false })).toBe("ignore");
  });
});
