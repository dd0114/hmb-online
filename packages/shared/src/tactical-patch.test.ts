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

  /*
   * 크로스언어 앵커 (#324) — Java `BaseContextKeyReproTest.GOLDEN` 과 **같은 입력·같은 리터럴**.
   *
   * 지금까지 골든은 Java 테스트에만 하드코딩돼 있어서, Java 를 골든에 맞춰 두면 **TS 쪽이 혼자
   * 움직여도 아무 테스트가 안 깨졌다**(= 캐시 키 무언 불일치 → 전 매치 캐시 미스). 규약 버전을
   * 올리는 변경(#324 는 프롬프트 계약이 바뀌어 기존 A 를 버려야 한다)이 정확히 그 한쪽만 건드리기
   * 쉬운 변경이라, 양쪽을 같은 문자열에 묶는다. 한쪽만 바꾸면 그쪽 테스트가 죽는다.
   */
  it("Java BaseContextKeyReproTest 와 바이트 동일(크로스언어 앵커)", () => {
    const GOLDEN =
      '{"formation":"4-3-3","manualTactics":{"line":0.7,"press":0.5,"tempo":0.9,"width":0.4},' +
      '"playerPrompts":{"p1":"","p2":"왼쪽 측면 공략"},' +
      '"roster":[{"attributes":{"pace":90,"shooting":60},"playerId":"p1","slotIndex":0},' +
      '{"attributes":{"defending":55,"pace":65},"playerId":"p2","slotIndex":1},' +
      '{"attributes":{"pace":70,"shooting":80,"zeta":10},"playerId":"p3","slotIndex":2}],' +
      '"teamPrompt":"공격적으로 압박","v":2}';
    // 일부러 slotIndex 역순 + 객체키 역순으로 넣어 정규화까지 같이 확인(Java 테스트와 동일 의도).
    const material = baseContextKeyMaterial({
      formation: "4-3-3",
      roster: [
        { playerId: "p3", slotIndex: 2, attributes: { zeta: 10, shooting: 80, pace: 70 } },
        { playerId: "p1", slotIndex: 0, attributes: { shooting: 60, pace: 90 } },
        { playerId: "p2", slotIndex: 1, attributes: { pace: 65, defending: 55 } },
      ],
      teamPrompt: "공격적으로 압박",
      playerPrompts: { p2: "왼쪽 측면 공략", p1: "" },
      manualTactics: { width: 0.4, line: 0.7, tempo: 0.9, press: 0.5 },
    });
    expect(material).toBe(GOLDEN);
  });

  /*
   * #324 캐시 무효화 — 프롬프트 계약이 바뀌었으므로(슬롯 기준 좌표 전달 + 겹침 금지) 그 이전에
   * 만들어진 A 산출은 더 이상 유효하지 않다. 라이브 78개 base 중 9개가 실제로 겹친 배치를 담고 있고,
   * 봇 base 는 키가 전부 고정값이라 **버전을 올리지 않으면 영원히 그 배치가 재사용된다**
   * (블루 월 상대 3매치가 실제로 그랬다).
   */
  it("규약 버전이 2 이상 — 겹침 배치를 담은 구 A 캐시를 재사용하지 않는다", () => {
    const v = JSON.parse(baseContextKeyMaterial(deck)).v;
    expect(v).toBeGreaterThanOrEqual(2);
  });
});
