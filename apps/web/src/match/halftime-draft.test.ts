import { describe, expect, it } from "vitest";
import {
  applyDraftPrompts,
  clearedAfterSave,
  draftTextOf,
  emptyHalftimeDraft,
  hasText,
  halftimeDraftKey,
  parseHalftimeDraft,
  pendingSaves,
  serializeHalftimeDraft,
  withDraftText,
  withSent,
  writtenPlayerCount,
  writtenSummary,
} from "./halftime-draft";
import type { DeckDraft } from "../deck/deck-logic";

const withText = (target: string | null, text: string) =>
  withDraftText(emptyHalftimeDraft(), target, text);

describe("초안 저장/복원", () => {
  it("빈 초안에서 시작한다", () => {
    const d = emptyHalftimeDraft();
    expect(draftTextOf(d, null)).toBe("");
    expect(draftTextOf(d, "P001")).toBe("");
    expect(pendingSaves(d)).toEqual([]);
  });

  it("왕복(serialize→parse)이 값을 보존한다", () => {
    let d = withText(null, "라인 내려");
    d = withDraftText(d, "P001", "과감하게 슛");
    d = withSent(d, null, "라인 내려");
    expect(parseHalftimeDraft(serializeHalftimeDraft(d))).toEqual(d);
  });

  it("손상/구버전/부분 저장값은 빈 초안으로 흡수한다", () => {
    const empty = emptyHalftimeDraft();
    expect(parseHalftimeDraft(null)).toEqual(empty);
    expect(parseHalftimeDraft("")).toEqual(empty);
    expect(parseHalftimeDraft("{oops")).toEqual(empty);
    expect(parseHalftimeDraft("[1,2]")).toEqual(empty);
    expect(parseHalftimeDraft('"team"')).toEqual(empty);
    // 타입이 틀린 값은 무시하고 나머지는 살린다 — 한 칸이 깨졌다고 전부 버리지 않는다.
    const partial = parseHalftimeDraft('{"cur":{"team":"ok","players":{"P001":7,"P002":"go"}}}');
    expect(partial.cur.team).toBe("ok");
    expect(partial.cur.players).toEqual({ P002: "go" });
    expect(partial.sent).toEqual({ team: "", players: {} });
  });

  it("매치별로 키가 갈린다 — 다른 경기의 초안이 새어 들어오면 안 된다", () => {
    expect(halftimeDraftKey("m1")).not.toBe(halftimeDraftKey("m2"));
  });
});

describe("보낼 것 고르기 (pendingSaves)", () => {
  it("적은 것만 후보다 — 팀이 먼저, 선수는 안정적인 순서", () => {
    let d = withText(null, "라인 내려");
    d = withDraftText(d, "P009", "b");
    d = withDraftText(d, "P002", "a");
    expect(pendingSaves(d)).toEqual([
      { target: null, text: "라인 내려" },
      { target: "P002", text: "a" },
      { target: "P009", text: "b" },
    ]);
  });

  it("이미 보낸 값과 같으면 다시 보내지 않는다 — [후반 시작] 앞에 POST 12번이 붙지 않게", () => {
    let d = withText(null, "라인 내려");
    d = withSent(d, null, "라인 내려");
    expect(pendingSaves(d)).toEqual([]);

    // 공백만 다른 건 같은 문장이다.
    d = withDraftText(d, null, "  라인 내려  ");
    expect(pendingSaves(d)).toEqual([]);

    d = withDraftText(d, null, "라인 올려");
    expect(pendingSaves(d)).toEqual([{ target: null, text: "라인 올려" }]);
  });

  it("빈 문장은 보내지 않는다 — 서버가 400 으로 막는다(text.isBlank)", () => {
    let d = withText(null, "   ");
    expect(pendingSaves(d), "공백만 있는 문장은 후보 아님").toEqual([]);

    // 저장했다가 지운 경우도 마찬가지 — 삭제를 표현할 방법이 없다.
    d = withText(null, "라인 내려");
    d = withSent(d, null, "라인 내려");
    d = withDraftText(d, null, "");
    expect(pendingSaves(d)).toEqual([]);
  });
});

describe("지운 것 알리기 (clearedAfterSave)", () => {
  it("저장했다가 비운 대상을 짚어준다 — 조용히 넘기면 '지웠는데 후반에 그대로'가 된다", () => {
    let d = withText(null, "라인 내려");
    d = withDraftText(d, "P003", "수비 집중");
    d = withSent(d, null, "라인 내려");
    d = withSent(d, "P003", "수비 집중");
    expect(clearedAfterSave(d), "아직 안 지웠으면 없음").toEqual([]);

    d = withDraftText(d, "P003", "");
    expect(clearedAfterSave(d)).toEqual(["P003"]);

    d = withDraftText(d, null, "  ");
    expect(clearedAfterSave(d)).toEqual([null, "P003"]);
  });

  it("저장한 적 없이 비어 있는 건 알릴 게 아니다", () => {
    expect(clearedAfterSave(emptyHalftimeDraft())).toEqual([]);
    expect(clearedAfterSave(withText("P001", ""))).toEqual([]);
  });
});

describe("적어둔 표시", () => {
  it("공백만 적힌 건 적은 게 아니다", () => {
    expect(hasText(withText("P001", "go"), "P001")).toBe(true);
    expect(hasText(withText("P001", "   "), "P001")).toBe(false);
    expect(hasText(emptyHalftimeDraft(), "P001")).toBe(false);
  });

  it("선수 수만 센다(팀은 별도 표기)", () => {
    let d = withText(null, "팀 문장");
    d = withDraftText(d, "P001", "a");
    d = withDraftText(d, "P002", "  ");
    d = withDraftText(d, "P003", "c");
    expect(writtenPlayerCount(d)).toBe(2);
  });

  it("한 줄 요약 — 저장 버튼이 없는 화면의 **유일한 진행 표시**라 빈 상태에도 말한다", () => {
    expect(writtenSummary(emptyHalftimeDraft())).toBe("적으면 자동으로 저장됩니다");
    expect(writtenSummary(withText(null, "팀 문장"))).toBe("적어둠 — 팀");
    expect(writtenSummary(withText("P001", "a"))).toBe("적어둠 — 선수 1명");

    let both = withText(null, "팀 문장");
    both = withDraftText(both, "P001", "a");
    both = withDraftText(both, "P002", "b");
    expect(writtenSummary(both)).toBe("적어둠 — 팀 + 선수 2명");
  });
});

describe("감독시간 프리필 (applyDraftPrompts)", () => {
  const base: DeckDraft = {
    formation: "4-4-2",
    slots: [
      { playerId: "P001", role: "starter", slotIndex: 0, promptText: null },
      { playerId: "P002", role: "starter", slotIndex: 1, promptText: null },
      { playerId: "P099", role: "bench", slotIndex: 0, promptText: null },
    ],
  };

  it("적어둔 선수 칸만 채운다", () => {
    let d = withText("P002", "과감하게 슛");
    d = withDraftText(d, "P099", "몸 풀어둬라");
    const out = applyDraftPrompts(base, d);
    expect(out.slots.map((s) => s.promptText)).toEqual([null, "과감하게 슛", "몸 풀어둬라"]);
    expect(out.formation, "포메이션은 건드리지 않는다").toBe("4-4-2");
  });

  it("공백만 적힌 칸은 비워 둔다", () => {
    expect(applyDraftPrompts(base, withText("P001", "   ")).slots[0]!.promptText).toBeNull();
  });

  it("로스터에 없는 초안은 조용히 무시한다 — 교체로 빠진 선수가 남아 있어도 화면이 안 깨진다", () => {
    const out = applyDraftPrompts(base, withText("P777", "없는 선수"));
    expect(out.slots.map((s) => s.promptText)).toEqual([null, null, null]);
  });

  it("**자리가 아니라 사람에게** 붙는다 — #276 자리 바꾸기 이후에도 문장이 따라가야 한다", () => {
    const d = withText("P002", "과감하게 슛");
    // P001 ↔ P002 가 자리를 바꾼 보드(슬롯 인덱스가 뒤집혔다).
    const swapped: DeckDraft = {
      ...base,
      slots: [
        { playerId: "P002", role: "starter", slotIndex: 0, promptText: null },
        { playerId: "P001", role: "starter", slotIndex: 1, promptText: null },
        base.slots[2]!,
      ],
    };
    const out = applyDraftPrompts(swapped, d);
    expect(out.slots.find((s) => s.playerId === "P002")!.promptText).toBe("과감하게 슛");
    expect(out.slots.find((s) => s.playerId === "P001")!.promptText).toBeNull();
  });

  it("원본을 변형하지 않는다", () => {
    applyDraftPrompts(base, withText("P001", "x"));
    expect(base.slots[0]!.promptText).toBeNull();
  });
});
