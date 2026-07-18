import { describe, it, expect } from "vitest";
import {
  TacticalPatch,
  applyPatch,
  roleToPositionGroup,
  baseContextKeyMaterial,
  TacticalInput,
  type TacticalInput as TacticalInputT,
} from "./index.js";

/**
 * TacticalPatch 스키마 + applyPatch 순수 머지 계약 (A+B 린패치, #82 / W3).
 * 결정론(같은 입력→같은 출력) · 적용 순서(team→byPosition→byPlayer→markTargets) · 클램프 · seed 주입 · strict.
 */

/** 최소 유효 A(베이스) — 3명(GK/DF/FW)으로 그룹 파생·머지를 검증(11명 규칙은 서버 게이트 소관). */
function makeBase(seed = "100"): TacticalInputT {
  const behavior = {
    positioningFreedom: 0.3,
    forwardRunFreq: 0.3,
    widthTendency: 0.3,
    supportDepth: 0.3,
    pressAggression: 0.3,
    passRisk: 0.3,
    passDirectness: 0.3,
    dribbleTendency: 0.3,
    shootTendency: 0.3,
  };
  return {
    seed,
    team: {
      formation: "4-3-3",
      defensiveLineHeight: 0.5,
      compactness: 0.5,
      tempo: 0.5,
      width: 0.5,
      pressingScheme: { intensity: 0.5, triggerLine: 0.5 },
      offsideTrap: false,
    },
    players: [
      { playerId: "H0", role: "GK", duty: "defend", basePosition: { x: 0.05, y: 0.5 }, behavior: { ...behavior }, mentalModifier: 0 },
      { playerId: "H2", role: "LCB", duty: "defend", basePosition: { x: 0.2, y: 0.4 }, behavior: { ...behavior }, mentalModifier: 0 },
      { playerId: "H9", role: "ST", duty: "attack", basePosition: { x: 0.8, y: 0.5 }, behavior: { ...behavior }, mentalModifier: 0 },
    ],
  };
}

describe("roleToPositionGroup — 엔진 role → 그룹", () => {
  it("GK/DF/MF/FW 매핑(엔진 4-3-3 role 전부)", () => {
    expect(roleToPositionGroup("GK")).toBe("GK");
    for (const r of ["LB", "LCB", "RCB", "RB"]) expect(roleToPositionGroup(r)).toBe("DF");
    for (const r of ["LCM", "CM", "RCM"]) expect(roleToPositionGroup(r)).toBe("MF");
    for (const r of ["LW", "ST", "RW"]) expect(roleToPositionGroup(r)).toBe("FW");
    expect(roleToPositionGroup("RWB")).toBe("DF");
    expect(roleToPositionGroup("CAM")).toBe("MF");
  });
});

describe("TacticalPatch 스키마 — strict/부분", () => {
  it("빈 패치도 유효(전부 optional)", () => {
    expect(TacticalPatch.parse({})).toEqual({});
  });
  it("미지정 필드는 거부(strict — 모델이 지어내지 못하게)", () => {
    expect(() => TacticalPatch.parse({ team: { bogusField: 1 } })).toThrow();
    expect(() => TacticalPatch.parse({ nope: 1 })).toThrow();
  });

  it("leaf strict — behavior/basePosition 오타 필드는 조용히 소실되지 않고 거부된다", () => {
    // 모델이 shootTendency 대신 "shooting" 을 내면 strip 되어 지시가 소실되면 안 됨 → parse 거부(재시도 경로).
    expect(() => TacticalPatch.parse({ byPlayer: { H9: { behavior: { shooting: 0.9 } } } })).toThrow();
    expect(() => TacticalPatch.parse({ byPosition: { DF: { behavior: { pressAgression: 0.9 } } } })).toThrow(); // 오타
    expect(() => TacticalPatch.parse({ byPlayer: { H2: { basePosition: { z: 0.5 } } } })).toThrow(); // 헛 좌표축
    // 정식 필드는 통과(회귀 가드)
    expect(() => TacticalPatch.parse({ byPlayer: { H9: { behavior: { shootTendency: 0.9 } } } })).not.toThrow();
  });
  it("벌크 연산 3계층 + markTargets 형태를 받는다", () => {
    const p = TacticalPatch.parse({
      team: { pressIntensity: 0.9, tempo: 0.8 },
      byPosition: { DF: { behavior: { pressAggression: 0.9 }, mentalModifier: 0.2 } },
      byPlayer: { H9: { behavior: { shootTendency: 0.85 }, mentalModifier: 0.5 } },
      markTargets: { H2: "A9" },
    });
    expect(p.byPosition?.DF?.behavior?.pressAggression).toBe(0.9);
  });
});

describe("applyPatch — 정적 머지(순수·결정론)", () => {
  it("team flat 패치 → team + pressingScheme 로 복원", () => {
    const out = applyPatch(makeBase(), {
      team: { defensiveLineHeight: 0.9, pressIntensity: 0.95, pressTriggerLine: 0.8, offsideTrap: true },
    });
    expect(out.team.defensiveLineHeight).toBe(0.9);
    expect(out.team.pressingScheme.intensity).toBe(0.95);
    expect(out.team.pressingScheme.triggerLine).toBe(0.8);
    expect(out.team.offsideTrap).toBe(true);
    expect(out.team.tempo).toBe(0.5); // 미지정 축은 베이스 유지
  });

  it("byPosition = 그룹 전원 벌크(전원 압박 류)", () => {
    const out = applyPatch(makeBase(), { byPosition: { DF: { behavior: { pressAggression: 0.9 }, mentalModifier: 0.3 } } });
    const cb = out.players.find((p) => p.playerId === "H2")!;
    const st = out.players.find((p) => p.playerId === "H9")!;
    expect(cb.behavior.pressAggression).toBe(0.9); // DF 그룹 적용
    expect(cb.mentalModifier).toBe(0.3);
    expect(st.behavior.pressAggression).toBe(0.3); // FW 그룹은 불변
  });

  it("적용 순서 team→byPosition→byPlayer→markTargets: byPlayer 가 byPosition 을 덮는다", () => {
    const out = applyPatch(makeBase(), {
      byPosition: { DF: { behavior: { pressAggression: 0.6 }, mentalModifier: 0.1 } },
      byPlayer: { H2: { behavior: { pressAggression: 0.95 }, basePosition: { x: 0.35 }, duty: "support", mentalModifier: 0.4 } },
    });
    const cb = out.players.find((p) => p.playerId === "H2")!;
    expect(cb.behavior.pressAggression).toBe(0.95); // byPlayer 우선
    expect(cb.mentalModifier).toBe(0.4);
    expect(cb.basePosition.x).toBe(0.35);
    expect(cb.basePosition.y).toBe(0.4); // 부분 좌표 — y 는 베이스 유지
    expect(cb.duty).toBe("support");
  });

  it("markTargets → 수비수 markTarget 설정", () => {
    const out = applyPatch(makeBase(), { markTargets: { H2: "A9" } });
    expect(out.players.find((p) => p.playerId === "H2")!.markTarget).toBe("A9");
    expect(out.players.find((p) => p.playerId === "H9")!.markTarget).toBeUndefined();
  });

  it("범위 밖 값은 클램프(머지 산출물에 적용)", () => {
    const out = applyPatch(makeBase(), {
      team: { tempo: 5 },
      byPlayer: { H9: { behavior: { shootTendency: 9 }, mentalModifier: -9 } },
    });
    expect(out.team.tempo).toBe(1);
    expect(out.players.find((p) => p.playerId === "H9")!.behavior.shootTendency).toBe(1);
    expect(out.players.find((p) => p.playerId === "H9")!.mentalModifier).toBe(-1);
  });

  it("seed 주입 — 머지 시 halfSeed 로 덮음(base.seed 무시)", () => {
    const out = applyPatch(makeBase("111"), {}, { seed: "999" });
    expect(out.seed).toBe("999");
    expect(applyPatch(makeBase("111"), {}).seed).toBe("111"); // 미지정 시 base.seed 유지
  });

  it("결정론: 같은 (base, patch, seed) → deep-equal 출력, 입력 불변(base 미변형)", () => {
    const base = makeBase();
    const patch = TacticalPatch.parse({ team: { width: 0.9 }, byPlayer: { H9: { mentalModifier: 0.5 } } });
    const a = applyPatch(base, patch, { seed: "7" });
    const b = applyPatch(base, patch, { seed: "7" });
    expect(a).toEqual(b);
    expect(base.team.width).toBe(0.5); // 원본 불변(깊은 복제)
    expect(base.players[2]!.mentalModifier).toBe(0);
  });

  it("빈 패치 → base 와 동등(seed 제외)한 유효 TacticalInput", () => {
    const out = applyPatch(makeBase("42"), {});
    expect(() => TacticalInput.parse(out)).not.toThrow();
    expect(out.players).toHaveLength(3);
  });
});

describe("baseContextKeyMaterial — A 캐시 키 규약(crossmatch)", () => {
  const deck = {
    formation: "4-3-3",
    roster: [
      { playerId: "H1", slotIndex: 1, attributes: { pace: 70 } },
      { playerId: "H0", slotIndex: 0, attributes: { pace: 50 } },
    ],
    teamPrompt: "덱 기본 지시",
    playerPrompts: { H0: "안정" },
  };

  it("결정론 + roster 순서/객체키 순서 무관(정규화)", () => {
    const a = baseContextKeyMaterial(deck);
    const shuffled = { ...deck, roster: [...deck.roster].reverse() };
    expect(baseContextKeyMaterial(shuffled)).toBe(a); // slotIndex 정렬 정규화
  });

  it("matchId/seed/side 는 재료에 없음(크로스매치 재사용) — 덱만 바뀌면 키 변화", () => {
    const a = baseContextKeyMaterial(deck);
    // 덱 프롬프트 변경 → 다른 키
    expect(baseContextKeyMaterial({ ...deck, teamPrompt: "다른 지시" })).not.toBe(a);
    // manualTactics 추가 → 다른 키
    expect(baseContextKeyMaterial({ ...deck, manualTactics: { line: 0.7, press: 0.6, tempo: 0.5, width: 0.5 } })).not.toBe(a);
  });
});
