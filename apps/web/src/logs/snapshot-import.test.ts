/**
 * W5 과거 세팅 로그 → 프리셋 순수 로직 (이슈 #98 요구 2).
 * 핵심 계약: 매치 스냅샷을 그대로(포메이션·선발/벤치·프롬프트·팀전술) 프리셋 저장 바디로 옮긴다 —
 * 손실 0. 저장 불가 조건(없음/선발<11)과 기본 슬롯/이름 규약도 함께 박는다.
 */
import { describe, expect, it } from "vitest";
import type { TeamPresetSlot, TeamSnapshot } from "../api/v2";
import {
  canImportSnapshot,
  defaultImportName,
  defaultImportSlot,
  matchSnapshotToSaveRequest,
  starterIdsInOrder,
} from "./snapshot-import";

function snapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    formation: "4-3-3",
    starters: Array.from({ length: 11 }, (_, i) => ({
      playerId: `S${i}`,
      slotIndex: i,
      promptText: i === 3 ? "측면으로 벌려라" : null,
    })),
    bench: [{ playerId: "B0", slotIndex: 0, promptText: "교체 투입 시 압박" }],
    teamTactics: { line: 0.8, press: 0.3, tempo: 0.7, width: 0.2 },
    teamPrompt: "역습 위주",
    ...overrides,
  };
}

const slots: TeamPresetSlot[] = [
  { slot: 1, name: "메인", snapshot: snapshot(), updatedAt: "2026-07-19T00:00:00Z" },
  { slot: 2, name: null, snapshot: null, updatedAt: null },
  { slot: 3, name: null, snapshot: null, updatedAt: null },
];

describe("matchSnapshotToSaveRequest", () => {
  it("스냅샷 내용을 손실 없이 프리셋 저장 바디로 옮긴다", () => {
    const body = matchSnapshotToSaveRequest(snapshot(), "vs 봇A 07.19");
    expect(body.name).toBe("vs 봇A 07.19");
    expect(body.formation).toBe("4-3-3");
    expect(body.starters).toHaveLength(11);
    expect(body.bench).toEqual([{ playerId: "B0", slotIndex: 0, promptText: "교체 투입 시 압박" }]);
    // 선수별 프롬프트 유지(프리셋 복원 시 프롬프트 유실 방지)
    expect(body.starters.find((s) => s.playerId === "S3")?.promptText).toBe("측면으로 벌려라");
    expect(body.teamTactics).toEqual({ line: 0.8, press: 0.3, tempo: 0.7, width: 0.2 });
    expect(body.teamPrompt).toBe("역습 위주");
  });

  it("팀전술/팀프롬프트가 없는 스냅샷은 기본 전술(0.5) + null 프롬프트로 채운다", () => {
    const bare = snapshot();
    delete (bare as { teamTactics?: unknown }).teamTactics;
    delete (bare as { teamPrompt?: unknown }).teamPrompt;
    const body = matchSnapshotToSaveRequest(bare, "이름");
    expect(body.teamTactics).toEqual({ line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 });
    expect(body.teamPrompt).toBeNull();
  });

  it("선발은 슬롯 인덱스 오름차순으로 정규화된다", () => {
    const shuffled = snapshot({
      starters: [
        { playerId: "S2", slotIndex: 2, promptText: null },
        { playerId: "S0", slotIndex: 0, promptText: null },
        ...Array.from({ length: 9 }, (_, i) => ({ playerId: `S${i + 3}`, slotIndex: i + 3, promptText: null })),
      ],
    });
    expect(matchSnapshotToSaveRequest(shuffled, "n").starters.map((s) => s.slotIndex)).toEqual([
      0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(starterIdsInOrder(shuffled)[0]).toBe("S0");
  });
});

describe("canImportSnapshot", () => {
  it("스냅샷이 없으면(구 매치·미완) 불가", () => {
    expect(canImportSnapshot(null)).toBe(false);
    expect(canImportSnapshot(undefined)).toBe(false);
  });

  it("선발이 11이 아니면 불가", () => {
    expect(canImportSnapshot(snapshot({ starters: snapshot().starters.slice(0, 10) }))).toBe(false);
  });

  it("선발 11 스냅샷은 가능", () => {
    expect(canImportSnapshot(snapshot())).toBe(true);
  });
});

describe("defaultImportSlot / defaultImportName", () => {
  it("빈 슬롯이 있으면 가장 낮은 빈 슬롯", () => {
    expect(defaultImportSlot(slots)).toBe(2);
  });

  it("전부 차 있으면 기본 선택 없음(null) — 1탭 덮어쓰기 방지", () => {
    const full = slots.map((s) => ({ ...s, snapshot: snapshot() }));
    expect(defaultImportSlot(full)).toBeNull();
  });

  it("이름은 'vs 상대 MM.DD' — 날짜는 ISO 문자열에서 잘라 쓴다(시계 비의존)", () => {
    expect(defaultImportName("봇A", "2026-07-19T10:00:00Z")).toBe("vs 봇A 07.19");
    expect(defaultImportName("봇A")).toBe("vs 봇A");
  });

  it("이름은 16자를 넘지 않는다(서버 슬롯 이름 관례)", () => {
    expect(defaultImportName("아주아주긴상대팀이름입니다", "2026-07-19T10:00:00Z").length).toBeLessThanOrEqual(16);
  });
});
