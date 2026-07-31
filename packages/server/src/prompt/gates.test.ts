import { describe, it, expect } from "vitest";
import { FORMATION_BASE_POSITIONS, type TacticalInput } from "@hmb/shared";
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
 * G1 트랩 모순 · G2 마킹 지시인데 markTarget 0건 · G3 배치 파손(동일/근접 좌표 2명+ — #324 로 강화).
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

  it("개인 지시에 마킹(대상 지목) → markTarget 0건이면 throw", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "", playerPrompts: { H2: "A9 전담 마크" }, opponentRoster }),
    ).toThrow(/마킹 지시/);
  });

  // ── 오탐 제거(#193 검증 B-1): 지목이 없으면 게이트는 발동하지 않는다 ──
  //    "누구를 마크할지"는 모델 재량이다(자유도 원칙). 게이트가 막는 것은 **지목된 지시의 미이행**뿐.

  it("이름·ID 미지목 마킹은 발동하지 않는다 — '상대 에이스를 전담 마크'(모델 재량)", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "상대 에이스를 전담 마크해라", playerPrompts: {}, opponentRoster }),
    ).not.toThrow();
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "",
        playerPrompts: { H2: "제일 잘하는 공격수 마크" },
        opponentRoster,
      }),
    ).not.toThrow();
  });

  it("비마킹 '막아'(골·공간 차단)는 발동하지 않는다", () => {
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "", playerPrompts: { H0: "골을 막아라" }, opponentRoster }),
    ).not.toThrow();
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: "뒷공간을 막아라", playerPrompts: {}, opponentRoster }),
    ).not.toThrow();
  });

  it("지목은 같은 문장 안에서만 — 다른 문장의 이름이 마킹 지시를 만들지 않는다", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "뒷공간을 막아라. A9 는 빠르니 라인을 내려라",
        playerPrompts: {},
        opponentRoster,
      }),
    ).not.toThrow();
  });

  it("이름(문자열)으로 지목해도 발동한다 — playerId 뿐 아니라 name 매치", () => {
    const name = opponentRoster[9]!.name;
    expect(() =>
      assertTacticalSanity(ok(), { teamPrompt: `${name} 전담 마크`, playerPrompts: {}, opponentRoster }),
    ).toThrow(/markTarget/);
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

/**
 * 델타 모드 검사 범위 (#193 검증 M-1) — 게이트가 보는 지시 = **이번에 바뀐 것(new)** 뿐.
 *
 * 모델에게는 변경분만 제시하면서(delta 프롬프트) 게이트는 전체 지시로 채점하면 비대칭이다:
 * 전반부터 이어져 온 마킹 지시가 캐리오버로 남아 있으면, 이번 변경이 마킹과 무관해도 모델이
 * markTarget 을 다시 내지 않았다는 이유로 계속 실패한다(캐리오버는 베이스 A/h1 인풋의 책임).
 */
describe("게이트 검사 범위 — 델타 모드", () => {
  const opponentRoster = makeOpponentRoster();

  it("델타가 있으면 캐리오버 지시(playerPrompts)의 마킹은 범위 밖", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "템포를 올려라",
        playerPrompts: { H2: "A9 전담 마크해라" }, // 전반부터 유효했던 지시(베이스가 이미 반영)
        opponentRoster,
        promptDelta: { team: { old: "무난하게", new: "템포를 올려라" } }, // 이번 변경엔 마킹 없음
      }),
    ).not.toThrow();
  });

  it("델타에 신규 마킹이라도 지목이 없으면 발동하지 않는다", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "",
        playerPrompts: {},
        opponentRoster,
        promptDelta: { players: { H2: { new: "상대 에이스 막아" } } },
      }),
    ).not.toThrow();
  });

  it("델타에 신규 마킹 + 지목이면 여전히 발동한다(게이트가 죽지 않았다)", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "",
        playerPrompts: {},
        opponentRoster,
        promptDelta: { players: { H2: { new: "A9 막아" } } },
      }),
    ).toThrow(/markTarget/);
  });

  it("델타가 없으면(구계약) 전체 지시를 본다 — 후방 호환", () => {
    expect(() =>
      assertTacticalSanity(ok(), {
        teamPrompt: "A9 막아라",
        playerPrompts: {},
        opponentRoster,
      }),
    ).toThrow(/markTarget/);
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

  /*
   * #324 — 여기 있던 계약은 정반대였다("동일 좌표 2명은 통과 — 수비 짝 등 정상").
   * 라이브가 그 가정을 깼다: 블루 월(BOT_DEF)의 센터백 둘이 **완전히 같은 좌표**(0.17, 0.5)를 받아
   * 전반의 24.9%(672/2700틱)를 1m 안에 붙어 있었고(대조군 5경기 0.4~1.1%), 실화면에서 백5가
   * 점 4개로 보였다. 그 산출은 봇 A-base 캐시에 박제돼 이후 모든 블루 월 전에서 재사용됐다.
   * "수비 짝"은 가까이 서는 것이지 **같은 점에 서는 것**이 아니다 → 2명도 파손으로 본다.
   */
  it("동일 좌표 2명도 throw — 수비 짝은 '가까이'지 '같은 점'이 아니다 (#324 라이브 결함)", () => {
    const t = ok();
    const twins: TacticalInput = {
      ...t,
      players: t.players.map((p, i) => (i < 2 ? { ...p, basePosition: { x: 0.5, y: 0.5 } } : p)),
    };
    expect(() => assertTacticalSanity(twins, { teamPrompt: "", playerPrompts: {} })).toThrow(/배치|겹/);
  });

  it("라이브 실제 결함값(0.17,0.5 두 명)을 재현하면 잡힌다", () => {
    const t = ok();
    const live: TacticalInput = {
      ...t,
      players: t.players.map((p, i) => (i === 2 || i === 3 ? { ...p, basePosition: { x: 0.17, y: 0.5 } } : p)),
    };
    expect(() => assertTacticalSanity(live, { teamPrompt: "", playerPrompts: {} })).toThrow(/배치|겹/);
  });

  /*
   * 근접 중복 — 정확히 같은 좌표만 막으면 소수점 한 자리만 어긋난 사실상 같은 점이 통과한다.
   * 임계 보정(라이브 202개 인풋 전수): 결함 9건은 전부 거리 **정확히 0**, 정상 인풋의 최소 거리는
   * **0.04**. 그 사이가 비어 있어 (0, 0.04) 안의 어떤 임계도 오탐 0 이다 — 가운데인 0.02 를 골랐다.
   */
  it("사실상 겹치는 좌표(임계 미만)도 throw", () => {
    const t = ok();
    const near: TacticalInput = {
      ...t,
      players: t.players.map((p, i) =>
        i === 0 ? { ...p, basePosition: { x: 0.5, y: 0.5 } }
        : i === 1 ? { ...p, basePosition: { x: 0.505, y: 0.5 } }
        : p,
      ),
    };
    expect(() => assertTacticalSanity(near, { teamPrompt: "", playerPrompts: {} })).toThrow(/배치|겹/);
  });

  it("라이브 정상 인풋의 최소 간격(0.04)은 통과 — 오탐 0", () => {
    const t = ok();
    const tight: TacticalInput = {
      ...t,
      players: t.players.map((p, i) =>
        i === 0 ? { ...p, basePosition: { x: 0.5, y: 0.5 } }
        : i === 1 ? { ...p, basePosition: { x: 0.5, y: 0.54 } }
        : p,
      ),
    };
    expect(() => assertTacticalSanity(tight, { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });

  it("모든 라이브 포메이션의 기준 배치는 통과(계약이 우리 표 자체를 막지 않는다)", () => {
    const t = ok();
    for (const [name, slots] of Object.entries(FORMATION_BASE_POSITIONS)) {
      const canonical: TacticalInput = {
        ...t,
        players: t.players.map((p, i) => ({ ...p, basePosition: { ...slots[i]! } })),
      };
      expect(
        () => assertTacticalSanity(canonical, { teamPrompt: "", playerPrompts: {} }),
        `${name} 기준 배치`,
      ).not.toThrow();
    }
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

/**
 * G4 포메이션 미이행 (#367 / #295) — "4-4-2 를 골랐는데 4-3-3 배치가 나왔다"를 막는다.
 *
 * <p>엔진은 `team.formation` <b>문자열을 읽지 않는다</b>(#359 진단) — 포메이션의 실효는 basePosition
 * 11개뿐이다. 그래서 이름만 맞고 좌표가 다른 산출은 유저에게 <b>포메이션 선택 자체가 무효</b>다.
 *
 * <p>단 이 게이트는 <b>좌표 충실도를 강제하지 않는다</b>(머리말의 자유도 원칙). 판정은 절대 거리가
 * 아니라 "선언한 포메이션이 후보 중 최적인가" — 전술 조정(전원 전진·폭 확대)은 모든 후보의 거리를
 * 같이 밀어 순위를 바꾸지 않으므로 통과한다. 아래 '자유도' 케이스들이 그 계약이다.
 */
describe("게이트 G4 — 포메이션 미이행(선언 vs 실제 배치)", () => {
  const roster = makeTeamInputContext().roster.map((r) => ({ playerId: r.playerId, slotIndex: r.slotIndex }));
  /** 슬롯 좌표표 그대로 배치한 산출(= 지시 없음일 때의 기대 산출). */
  const placedAs = (formation: string, mutate?: (p: { x: number; y: number }, i: number) => void): TacticalInput => {
    const t = ok();
    const slots = FORMATION_BASE_POSITIONS[formation]!;
    return {
      ...t,
      players: t.players.map((p, i) => {
        const pos = { ...slots[i]! };
        mutate?.(pos, i);
        return { ...p, basePosition: pos };
      }),
    };
  };
  const gate = (input: TacticalInput, formation: string): void =>
    assertTacticalSanity(input, { teamPrompt: "", playerPrompts: {}, formation, roster });

  it("표의 4종 전부 — 자기 포메이션대로 배치하면 통과", () => {
    for (const name of Object.keys(FORMATION_BASE_POSITIONS)) {
      expect(() => gate(placedAs(name), name), `${name} 기준 배치`).not.toThrow();
    }
  });

  it("#295 실체: 4-4-2 를 요청했는데 4-3-3 좌표로 배치 → throw(어느 포메이션으로 갔는지 메시지에)", () => {
    expect(() => gate(placedAs("4-3-3"), "4-4-2")).toThrow(/포메이션 미이행/);
    expect(() => gate(placedAs("4-3-3"), "4-4-2")).toThrow(/4-3-3/);
  });

  it("역방향도 잡는다 — 4-3-3 요청에 4-4-2/5-3-2 배치", () => {
    expect(() => gate(placedAs("4-4-2"), "4-3-3")).toThrow(/포메이션 미이행/);
    expect(() => gate(placedAs("5-3-2"), "4-3-3")).toThrow(/포메이션 미이행/);
  });

  // ── 자유도 보존(오탐 0): 지시에 따른 전술 조정은 형태를 바꾸지 않는다 ──
  it("자유도: 전원 전진(하이라인·공격 지시)은 통과", () => {
    expect(() => gate(placedAs("4-4-2", (p) => { p.x = Math.min(1, p.x + 0.1); }), "4-4-2")).not.toThrow();
  });

  it("자유도: 폭 확대(측면 벌리기)는 통과", () => {
    expect(() =>
      gate(placedAs("4-4-2", (p) => { p.y = Math.min(1, Math.max(0, 0.5 + (p.y - 0.5) * 1.35)); }), "4-4-2"),
    ).not.toThrow();
  });

  it("자유도: 선수 한 명을 크게 옮겨도(개인 지시) 형태가 유지되면 통과", () => {
    expect(() => gate(placedAs("4-4-2", (p, i) => { if (i === 9) p.x = Math.min(1, p.x + 0.2); }), "4-4-2")).not.toThrow();
  });

  /*
   * 슬롯 매핑은 **배열 순서가 아니라 playerId** 로 한다. 라이브 유저 인풋의 19.4% 가 로스터와 다른
   * 순서로 선수를 낸다(실측 98건) — 배열 인덱스로 재면 그 정상 산출이 통째로 어긋남으로 읽힌다.
   */
  it("모델이 선수를 다른 순서로 내도 통과 — 슬롯은 playerId 로 잡는다", () => {
    const t = placedAs("4-4-2");
    const shuffled: TacticalInput = { ...t, players: [...t.players].reverse() };
    expect(() => gate(shuffled, "4-4-2")).not.toThrow();
  });

  it("순서를 섞은 채 좌표까지 다른 포메이션이면 여전히 잡힌다(게이트가 죽지 않았다)", () => {
    const t = placedAs("4-3-3");
    const shuffled: TacticalInput = { ...t, players: [...t.players].reverse() };
    expect(() => gate(shuffled, "4-4-2")).toThrow(/포메이션 미이행/);
  });

  it("라이브 형태의 playerId(P077 …)에서도 동일하게 동작 — 픽스처 접두사에 의존하지 않는다", () => {
    const t = placedAs("4-3-3");
    const liveIds = t.players.map((_, i) => `P${String(77 + i).padStart(3, "0")}`);
    const live: TacticalInput = { ...t, players: t.players.map((p, i) => ({ ...p, playerId: liveIds[i]! })) };
    const liveRoster = liveIds.map((playerId, slotIndex) => ({ playerId, slotIndex }));
    const gateLive = (formation: string): void =>
      assertTacticalSanity(live, { teamPrompt: "", playerPrompts: {}, formation, roster: liveRoster });
    expect(() => gateLive("4-3-3")).not.toThrow();
    expect(() => gateLive("4-4-2")).toThrow(/포메이션 미이행/);
  });

  // ── 판정 근거가 없으면 건너뛴다(구계약 호환) ──
  it("formation·roster 를 안 주면 G4 는 건너뛴다", () => {
    expect(() => assertTacticalSanity(placedAs("4-3-3"), { teamPrompt: "", playerPrompts: {} })).not.toThrow();
  });

  it("표에 없는 포메이션이면 건너뛴다(근거 없는 판정 금지)", () => {
    expect(() => gate(placedAs("4-3-3"), "3-5-2")).not.toThrow();
  });

  it("경계: 여유(formationFitMargin) 안의 열세는 통과, 넘으면 거부", () => {
    const m = SANITY_GATE_CONFIG.formationFitMargin;
    // 4-3-3 과 4-4-2 를 t:(1-t) 로 섞어 두 표 사이의 임의 지점을 만든다 — t 가 커질수록 4-4-2 열세.
    const blend = (t: number): TacticalInput => {
      const a = FORMATION_BASE_POSITIONS["4-4-2"]!, b = FORMATION_BASE_POSITIONS["4-3-3"]!;
      const base = ok();
      return {
        ...base,
        players: base.players.map((p, i) => ({
          ...p,
          basePosition: { x: a[i]!.x + (b[i]!.x - a[i]!.x) * t, y: a[i]!.y + (b[i]!.y - a[i]!.y) * t },
        })),
      };
    };
    // 선형 보간이라 4-4-2 와의 거리 = t·D, 4-3-3 과의 거리 = (1-t)·D (D = 두 표의 평균 거리 0.125).
    // 열세 = (2t-1)·D 가 m 을 넘는 t 를 고른다.
    const D = 0.125;
    const tPass = 0.5 + m / (2 * D) - 0.02; // 열세가 m 보다 작다
    const tFail = 0.5 + m / (2 * D) + 0.05; // 열세가 m 을 넘는다
    expect(() => gate(blend(tPass), "4-4-2"), `t=${tPass}`).not.toThrow();
    expect(() => gate(blend(tFail), "4-4-2"), `t=${tFail}`).toThrow(/포메이션 미이행/);
  });
});

describe("포메이션 이름은 덱 소유 — 모델이 바꿔 내면 요청값으로 정정", () => {
  it("산출 team.formation 이 요청과 달라도 결과는 요청 포메이션으로 돌아온다", () => {
    const ctx = makeTeamInputContext({ formation: "4-3-3" });
    const raw = { ...makeBaseTacticalInput(ctx.seed), team: { ...ok().team, formation: "5-3-2" } };
    expect(validateTeamInputOutput(raw, ctx).team.formation).toBe("4-3-3");
  });

  it("패치 경로도 동일(베이스가 옛 이름을 물고 있어도)", () => {
    const base = { ...makeBaseTacticalInput("42"), team: { ...ok().team, formation: "5-3-2" } };
    const ctx = makeTeamInputPatchContext({ formation: "4-3-3", base });
    expect(validateTeamInputPatchOutput({}, ctx).team.formation).toBe("4-3-3");
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
