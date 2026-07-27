import { describe, it, expect } from "vitest";
import {
  buildTeamInputPatchPrompt,
  buildTeamInputPrompt,
  MANDATORY_CHECKS,
  validateTeamInputPatchOutput,
} from "./coach.js";
import { stubExecutor } from "../executor/executors/stub.js";
import { makeTeamInputContext, makeTeamInputPatchContext, makeOpponentRoster } from "../executor/test-fixtures.js";

/**
 * 델타 패치 프롬프트 (#193 W2b-B3).
 * 실측 근거: 지연의 지배 변수 = 사고 토큰 → 풀 컨텍스트 나열 대신 **변경분만** 제시하는 단순 델타 프롬프트(8~16s).
 * 품질 회복은 "필수확인 서픽스"(마킹→markTarget 필수 / GK 역할 존중)로. 자기모순은 코드 게이트(gates.ts)로.
 */

const delta = {
  team: { old: "전방압박 강하게 유지하고 측면 전환 빠르게", new: "수비적으로 전환한다. 라인을 내리고 콤팩트하게" },
  players: { H9: { old: "적극 침투", new: "상대 CB 뒤 공간만 노려라. 수비 가담 최소화" } },
};

describe("델타 모드 — buildTeamInputPatchPrompt(ctx.promptDelta)", () => {
  const p = buildTeamInputPatchPrompt(makeTeamInputPatchContext({ promptDelta: delta }));

  it("변경된 지시를 old → new 로 제시한다", () => {
    expect(p).toContain("다음 지시가 변경되었다");
    expect(p).toContain("전방압박 강하게 유지하고 측면 전환 빠르게"); // old
    expect(p).toContain("수비적으로 전환한다. 라인을 내리고 콤팩트하게"); // new
    expect(p).toContain("H9");
    expect(p).toContain("상대 CB 뒤 공간만 노려라. 수비 가담 최소화");
  });

  it("이전 팀 지시가 비어 있으면(신규 부여) 빈 줄 대신 [신규 팀 지시] 로 제시한다 (#193 검증 m-3)", () => {
    const fresh = buildTeamInputPatchPrompt(
      makeTeamInputPatchContext({ promptDelta: { team: { old: "", new: "라인 내리고 역습" } } }),
    );
    expect(fresh).toContain("[신규 팀 지시] 라인 내리고 역습");
    expect(fresh).not.toContain("[이전 팀 지시]"); // 빈 old 를 빈 줄로 흘리지 않는다
    // old 가 있으면 기존 표기 그대로.
    expect(p).toContain("[이전 팀 지시]");
    expect(p).toContain("[이후 팀 지시]");
  });

  it("변경이 유발하는 변화만 + 파급은 포함 지시", () => {
    expect(p).toContain("변경이 유발하는 변화만");
    expect(p).toContain("파급");
    expect(p).toContain("TacticalPatch JSON");
  });

  /**
   * 맞대결 1차(#193 W3) 패인 = **파급 반쪽 구현** — "팀 압박 상향"에 team 스칼라 3개만 손대고 라인·개인
   * 압박은 그대로였다(풀생성 4.38 vs 델타 3.13). 체크리스트 전면 확장은 지연 고분산(6~160s+타임아웃)으로
   * 이미 기각됐으므로 **한 줄**만 더 준다: 팀 지시 변화는 선수 behavior 로도 내려간다.
   */
  it("팀 지시 변화가 선수 behavior 로 파급된다는 힌트가 한 줄 붙는다 (#193 라운드2)", () => {
    expect(p).toContain(
      "팀 지시의 강도·방향 변화(압박·라인·템포 등)는 team 스칼라뿐 아니라 관련 선수들의 behavior 에도 파급된다",
    );
    expect(p).toContain("변경이 요구하는 만큼 포함하라(무관한 선수는 여전히 제외)");
    // 델타 모드 전용 — 비델타(풀 컨텍스트) 패치 프롬프트는 무변경(후방 호환).
    expect(buildTeamInputPatchPrompt(makeTeamInputPatchContext())).not.toContain(
      "team 스칼라뿐 아니라",
    );
  });

  it("풀 컨텍스트 나열을 하지 않는다 — 카탈로그·능력치 라인 없음(사고 토큰 억제)", () => {
    expect(p).not.toContain("지원 지시 카탈로그");
    expect(p).not.toMatch(/tech \d+\/mental \d+\/phys \d+/);
    // 현재 지시 전문 나열(비델타 모드 섹션)은 델타 모드에서 쓰지 않는다.
    expect(p).not.toContain("감독의 이번 지시(팀 전체)");
    // 델타 프롬프트는 비델타(풀 컨텍스트) 프롬프트보다 짧다.
    expect(p.length).toBeLessThan(buildTeamInputPatchPrompt(makeTeamInputPatchContext()).length);
  });

  it("용어집을 싣고 supportDepth 를 '공격 시 전진 가담 깊이(수비 가담 아님)'로 명확화한다", () => {
    expect(p).toContain("필드 글로서리");
    expect(p).toContain("supportDepth");
    expect(p).toContain("공격 시 전진 가담 깊이");
    expect(p).toContain("수비 가담 아님");
  });

  it("로스터 요약 + 베이스 팀 스칼라 요약을 싣는다(키 해석·유지축 근거)", () => {
    expect(p).toContain("H0 Home GK"); // 로스터 id·이름
    expect(p).toContain("현재 팀 전술 베이스(A");
    expect(p).toContain("pressIntensity 0.55");
  });

  it("필수확인 서픽스(마킹→markTarget 필수 / GK 역할 존중)가 붙는다", () => {
    expect(p).toContain(MANDATORY_CHECKS);
    expect(p).toContain("markTarget");
    expect(p).toContain("골키퍼");
  });

  it("선수 지시 신규/삭제도 표기된다(old 없음=신규, new 없음=삭제)", () => {
    const q = buildTeamInputPatchPrompt(
      makeTeamInputPatchContext({
        promptDelta: { players: { H2: { new: "A9 전담 마크" }, H3: { old: "오버랩 자제" } } },
      }),
    );
    expect(q).toMatch(/H2[^\n]*신규/);
    expect(q).toContain("A9 전담 마크");
    expect(q).toMatch(/H3[^\n]*삭제/);
    expect(q).toContain("오버랩 자제");
  });

  it("변경되지 않은 항목은 나열하지 않는다(팀 지시만 바뀌면 선수 섹션 없음)", () => {
    const q = buildTeamInputPatchPrompt(
      makeTeamInputPatchContext({
        playerPrompts: { H5: "이건 안 바뀐 기존 지시" },
        promptDelta: { team: { old: "a", new: "b" } },
      }),
    );
    expect(q).not.toContain("이건 안 바뀐 기존 지시");
    expect(q).not.toContain("선수 개인 지시 변경");
  });

  it("마킹 델타가 있으면 상대 로스터를 싣는다(markTargets 대상 해석 근거)", () => {
    const q = buildTeamInputPatchPrompt(
      makeTeamInputPatchContext({
        opponentRoster: makeOpponentRoster(),
        promptDelta: { players: { H2: { new: "A9 막아" } } },
      }),
    );
    expect(q).toContain("상대 로스터(마킹 대상 해석용");
    expect(q).toContain("A9 Away ST");
  });

  it("feedback(재시도 사유)이 델타 프롬프트에도 실린다", () => {
    const q = buildTeamInputPatchPrompt(makeTeamInputPatchContext({ promptDelta: delta }), "마킹 지시가 있으나 markTarget 미설정");
    expect(q).toContain("이전 산출 거부됨");
    expect(q).toContain("markTarget 미설정");
  });

  it("델타 프롬프트 전문 스냅샷(문구·순서 회귀 가드)", () => {
    expect(
      buildTeamInputPatchPrompt(
        makeTeamInputPatchContext({
          opponentRoster: makeOpponentRoster(),
          promptDelta: {
            team: delta.team,
            players: { H9: delta.players.H9, H2: { new: "A9 막아" }, H3: { old: "오버랩 자제" } },
          },
        }),
      ),
    ).toMatchSnapshot();
  });
});

describe("후방 호환 — promptDelta 부재 시 기존 프롬프트 경로", () => {
  it("promptDelta 없으면 풀 컨텍스트 패치 프롬프트 그대로(카탈로그·현재 지시 포함)", () => {
    const p = buildTeamInputPatchPrompt(makeTeamInputPatchContext({ teamPrompt: "전원 강하게 압박" }));
    expect(p).toContain("지원 지시 카탈로그");
    expect(p).toContain("감독의 이번 지시(팀 전체)");
    expect(p).not.toContain("다음 지시가 변경되었다");
  });
});

describe("풀 생성 프롬프트 — 필수확인 서픽스(실측 A1 승자)", () => {
  it("buildTeamInputPrompt 말미에 동일 서픽스가 붙는다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).toContain(MANDATORY_CHECKS);
    expect(p).toContain("markTarget");
    expect(p).toContain("골키퍼");
  });

  it("서픽스는 최종 출력 지시(JSON 한 번 제출) 앞에 온다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p.indexOf(MANDATORY_CHECKS)).toBeLessThan(p.indexOf("TacticalInput JSON 을 정확히 한 번"));
  });
});

describe("stub executor — 델타 컨텍스트 처리(오프라인 E2E)", () => {
  async function run(ctx: Parameters<typeof buildTeamInputPatchPrompt>[0]) {
    const raw = await stubExecutor().execute({ id: "j", kind: "team-input-patch", context: ctx });
    return validateTeamInputPatchOutput(raw, ctx);
  }

  it("델타의 new 지시(수비 전환)를 기준으로 패치한다 — 옛 teamPrompt 가 아니라", async () => {
    const ctx = makeTeamInputPatchContext({
      teamPrompt: "하이라인·와이드 공격", // 옛 지시(델타 있으면 무시)
      promptDelta: { team: { old: "하이라인·와이드 공격", new: "수비적으로 로우블록·콤팩트" } },
    });
    const out = await run(ctx);
    expect(out.team.defensiveLineHeight).toBe(0.2); // 수비 브랜치
    expect(out.team.offsideTrap).toBe(false); // 낮은 라인 + 트랩 = 게이트 위반이므로 스텁도 모순 회피
  });

  it("델타의 개인 마킹 지시 → 최종 markTarget 착지", async () => {
    const ctx = makeTeamInputPatchContext({
      opponentRoster: makeOpponentRoster(),
      promptDelta: { players: { H2: { new: "A9 막아" } } },
    });
    const out = await run(ctx);
    expect(out.players.find((p) => p.playerId === "H2")!.markTarget).toBe("A9");
  });

  it("삭제된 지시(new 없음)는 반영하지 않는다", async () => {
    // Java 계약: playerPrompts = **현재(편집 후)** 지시 집합 → 삭제된 지시는 여기 없다. 델타는 무엇이 없어졌는지만 알린다.
    const ctx = makeTeamInputPatchContext({
      opponentRoster: makeOpponentRoster(),
      playerPrompts: {},
      promptDelta: { players: { H2: { old: "A9 막아" } } }, // 삭제
    });
    const out = await run(ctx);
    expect(out.players.every((p) => p.markTarget === undefined)).toBe(true);
  });
});
