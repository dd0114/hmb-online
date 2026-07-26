import { describe, it, expect } from "vitest";
import type { TacticalInput } from "@hmb/shared";
import { assertTacticalSanity, SANITY_GATE_CONFIG } from "./gates.js";
import { validateTeamInputOutput, validateTeamInputPatchOutput } from "./coach.js";
import {
  makeTeamInputContext,
  makeTeamInputPatchContext,
  makeBaseTacticalInput,
  makeOpponentRoster,
} from "../executor/test-fixtures.js";

/**
 * 검증 게이트 확장 (#193 W2b-B3) — **물리 파손과 자기모순만** 막는다.
 * 값의 '방향'은 강제하지 않는다(감독 지시 해석의 자유도 불변).
 * G1 트랩 모순 · G2 마킹 지시인데 markTarget 0건 · G3 배치 파손(동일 좌표 3명+).
 * throw 메시지가 그대로 executeWithGate 의 1회 재시도 feedback 으로 탄다.
 */

const ok = (): TacticalInput => makeBaseTacticalInput("42");
const withTeam = (over: Partial<TacticalInput["team"]>): TacticalInput => {
  const t = ok();
  return { ...t, team: { ...t.team, ...over } };
};

describe("게이트 G1 — 오프사이드 트랩 자기모순", () => {
  it("트랩 ON + 낮은 수비라인 → throw(모순 사유가 메시지에)", () => {
    const bad = withTeam({ offsideTrap: true, defensiveLineHeight: 0.2 });
    expect(() => assertTacticalSanity(bad, { teamPrompt: "", playerPrompts: {} })).toThrow(/오프사이드/);
    expect(() => assertTacticalSanity(bad, { teamPrompt: "", playerPrompts: {} })).toThrow(/자기모순/);
  });

  it("트랩 ON + 높은 라인 → 통과(정상 조합)", () => {
    const good = withTeam({ offsideTrap: true, defensiveLineHeight: 0.8 });
    expect(() => assertTacticalSanity(good, { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });

  it("트랩 OFF 면 라인이 아무리 낮아도 통과(방향 강제 없음)", () => {
    const good = withTeam({ offsideTrap: false, defensiveLineHeight: 0.0 });
    expect(() => assertTacticalSanity(good, { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });

  it("경계값: 임계 미만만 위반(임계 자체는 통과)", () => {
    const th = SANITY_GATE_CONFIG.trapMinLineHeight;
    expect(() =>
      assertTacticalSanity(withTeam({ offsideTrap: true, defensiveLineHeight: th }), {
        teamPrompt: "",
        playerPrompts: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertTacticalSanity(withTeam({ offsideTrap: true, defensiveLineHeight: th - 0.01 }), {
        teamPrompt: "",
        playerPrompts: {},
      }),
    ).toThrow();
  });
});

describe("게이트 G2 — 마킹 지시가 있는데 markTarget 0건", () => {
  const opponentRoster = makeOpponentRoster();

  it("팀 지시에 마킹 → markTarget 0건이면 throw", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "A9 막아라", playerPrompts: {}, opponentRoster }),
    ).toThrow(/markTarget/);
  });

  it("개인 지시에 마킹 → markTarget 0건이면 throw", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "", playerPrompts: { H2: "상대 에이스 전담 마크" }, opponentRoster }),
    ).toThrow(/마킹 지시/);
  });

  it("promptDelta.new 의 마킹 지시도 컨텍스트로 본다(델타 모드)", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "",
        playerPrompts: {},
        opponentRoster,
        promptDelta: { players: { H2: { new: "A9 마크해" } } },
      }),
    ).toThrow(/markTarget/);
  });

  it("promptDelta.old(삭제된 옛 지시)만 마킹이면 강제하지 않는다", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "",
        playerPrompts: {},
        opponentRoster,
        promptDelta: { players: { H2: { old: "A9 마크해" } } },
      }),
    ).not.toThrow();
  });

  it("마킹 지시 + markTarget 1건 이상 → 통과", () => {
    const t = ok();
    const withMark: TacticalInput = {
      ...t,
      players: t.players.map((p, i) => (i === 2 ? { ...p, markTarget: "A9" } : p)),
    };
    expect(() =>
      assertTacticalSanity(withMark, { teamPrompt: "A9 막아라", playerPrompts: {}, opponentRoster }),
    ).not.toThrow();
  });

  it("마킹 지시가 없으면 markTarget 0건이어도 통과", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "라인 올리고 빠른 템포", playerPrompts: {}, opponentRoster }),
    ).not.toThrow();
  });

  it("opponentRoster 가 없으면 강제하지 않는다(고를 대상이 없음 — 유령 id 지어내기 금지 원칙)", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "A9 막아라", playerPrompts: {} }),
    ).not.toThrow();
  });
});

describe("게이트 G3 — 배치 파손(동일 좌표 밀집)", () => {
  it("동일 basePosition 3명 이상 → throw", () => {
    const t = ok();
    const bad: TacticalInput = {
      ...t,
      players: t.players.map((p, i) => (i < 3 ? { ...p, basePosition: { x: 0.5, y: 0.5 } } : p)),
    };
    expect(() => assertTacticalSanity(bad, { teamPrompt: "", playerPrompts: {} })).toThrow(/배치|겹/);
  });

  it("동일 좌표 2명은 통과(수비 짝 등 정상 — 방향 강제 없음)", () => {
    const t = ok();
    const twins: TacticalInput = {
      ...t,
      players: t.players.map((p, i) => (i < 2 ? { ...p, basePosition: { x: 0.5, y: 0.5 } } : p)),
    };
    expect(() => assertTacticalSanity(twins, { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });

  it("기본 포메이션 배치는 통과", () => {
    expect(() => assertTacticalSanity(ok(), { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });

  it("basePosition 0..1 범위 밖은 clamp 계약(게이트 이전) — 게이트는 밀집만 본다", () => {
    const t = ok();
    const out: TacticalInput = {
      ...t,
      players: t.players.map((p, i) => (i === 0 ? { ...p, basePosition: { x: 5, y: -3 } } : p)),
    };
    expect(() => assertTacticalSanity(out, { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });
});

describe("게이트 배선 — 두 kind 공통(team-input · team-input-patch)", () => {
  it("team-input: 게이트 위반 산출은 validateTeamInputOutput 에서 throw", () => {
    const ctx = makeTeamInputContext();
    const bad = { ...makeBaseTacticalInput(ctx.seed), team: { ...ok().team, offsideTrap: true, defensiveLineHeight: 0.1 } };
    expect(() => validateTeamInputOutput(bad, ctx)).toThrow(/오프사이드/);
  });

  it("team-input-patch: 머지 결과가 위반하면 throw(패치 경로도 동일 게이트)", () => {
    const ctx = makeTeamInputPatchContext();
    const patch = { team: { offsideTrap: true, defensiveLineHeight: 0.1 } };
    expect(() => validateTeamInputPatchOutput(patch, ctx)).toThrow(/오프사이드/);
  });

  it("team-input-patch: 유령 markTarget 제거 후에도 마킹 지시가 남으면 G2 가 잡는다", () => {
    const ctx = makeTeamInputPatchContext({
      opponentRoster: makeOpponentRoster(),
      playerPrompts: { H2: "A9 막아" },
    });
    // 모델이 유령 id 만 냈다 → 제거되면 markTarget 0건 = 마킹 지시 미이행.
    expect(() => validateTeamInputPatchOutput({ markTargets: { H2: "GHOST99" } }, ctx)).toThrow(/markTarget/);
  });

  it("정상 산출은 두 경로 모두 통과(회귀 없음)", () => {
    const ctx = makeTeamInputContext();
    expect(() => validateTeamInputOutput(makeBaseTacticalInput(ctx.seed), ctx)).not.toThrow();
    const pctx = makeTeamInputPatchContext();
    expect(() => validateTeamInputPatchOutput({}, pctx)).not.toThrow();
  });
});
