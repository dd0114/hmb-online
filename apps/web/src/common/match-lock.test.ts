/**
 * #217 매치 잠금·재입장의 순수 규칙 계약.
 *
 * 여기서 지키는 건 "잠근다"가 아니라 **잠금이 스스로를 가두지 않는다**이다: 회수 가능한(=사고)
 * 매치에서는 강제 이동이 풀려야 탈출구인 로비/포기 버튼에 도달한다. 이 한 줄이 무너지면
 * AC3(영구 잠금 금지)이 리다이렉트 루프로 되살아난다.
 */
import { describe, expect, it } from "vitest";
import {
  LOCKED_ROUTES,
  matchInProgressIdOf,
  resumeLabelFor,
  resumePathFor,
  shouldForceResume,
  shouldOfferResume,
  type ActiveMatchInfo,
} from "./match-lock";

const NONE: ActiveMatchInfo = { match: null, locked: false, abandonable: false };
const briefing: ActiveMatchInfo = { match: { id: "M1", state: "BRIEFING" }, locked: false, abandonable: true };
const live: ActiveMatchInfo = { match: { id: "M1", state: "FIRST_HALF" }, locked: true, abandonable: false };
const stuck: ActiveMatchInfo = { match: { id: "M1", state: "FIRST_HALF" }, locked: true, abandonable: true };
const failed: ActiveMatchInfo = { match: { id: "M1", state: "FAILED" }, locked: true, abandonable: true };

describe("shouldForceResume", () => {
  it("진행 중 매치가 없으면 아무 데도 끌고 가지 않는다", () => {
    expect(shouldForceResume(NONE)).toBe(false);
    expect(shouldForceResume(undefined)).toBe(false);
    expect(shouldForceResume(null)).toBe(false);
  });

  it("킥오프한 경기는 화면을 떠나도 그 경기로 되돌린다 (AC1)", () => {
    expect(shouldForceResume(live)).toBe(true);
  });

  it("브리핑은 끌고 가지 않는다 — 아직 킥오프 전이라 로비에서 고를 수 있어야 한다", () => {
    expect(shouldForceResume(briefing)).toBe(false);
  });

  it("회수 가능한(사고) 매치는 강제 이동을 푼다 — 안 그러면 포기 버튼에 도달할 수 없다 (AC3)", () => {
    expect(shouldForceResume(stuck)).toBe(false);
    expect(shouldForceResume(failed)).toBe(false);
  });
});

describe("shouldOfferResume", () => {
  it("강제 이동하지 않는 미완 매치는 로비에서 '이어하기'로 보여준다", () => {
    expect(shouldOfferResume(briefing)).toBe(true);
    expect(shouldOfferResume(failed)).toBe(true);
    expect(shouldOfferResume(stuck)).toBe(true);
  });

  it("강제 이동 대상이거나 매치가 없으면 카드는 없다", () => {
    expect(shouldOfferResume(live)).toBe(false);
    expect(shouldOfferResume(NONE)).toBe(false);
  });
});

describe("resumePathFor", () => {
  it("매치 상세 경로를 준다", () => {
    expect(resumePathFor(live)).toBe("/match/M1");
    expect(resumePathFor(NONE)).toBeNull();
  });
});

describe("matchInProgressIdOf", () => {
  it("409 에서 이어갈 매치 id 를 뽑는다 — 빈 손 에러는 막다른 길이다", () => {
    expect(matchInProgressIdOf({ code: "MATCH_IN_PROGRESS", detail: { matchId: "M9" } })).toBe("M9");
  });

  it("다른 에러·형상 불일치는 null (안내만 띄우고 이동하지 않는다)", () => {
    expect(matchInProgressIdOf({ code: "DECK_INVALID", detail: { matchId: "M9" } })).toBeNull();
    expect(matchInProgressIdOf({ code: "MATCH_IN_PROGRESS", detail: {} })).toBeNull();
    expect(matchInProgressIdOf({ code: "MATCH_IN_PROGRESS" })).toBeNull();
    expect(matchInProgressIdOf(new Error("boom"))).toBeNull();
    expect(matchInProgressIdOf(null)).toBeNull();
  });
});

describe("LOCKED_ROUTES", () => {
  it("매치 화면과 로그인은 잠금 대상이 아니다 (자기 자신을 막으면 루프다)", () => {
    expect(LOCKED_ROUTES).not.toContain("/login");
    expect(LOCKED_ROUTES.some((r) => r.startsWith("/match"))).toBe(false);
  });

  it("메타 화면은 전부 덮는다 (#286 6탭 + 하위 페이지)", () => {
    for (const route of ["/home", "/game", "/deck", "/players", "/recruit", "/me", "/league", "/away"]) {
      expect(LOCKED_ROUTES).toContain(route);
    }
  });

  it("홈도 잠금 대상이다 — 다만 게이트가 abandonable 을 보므로 탈출구는 남는다 (#286)", () => {
    // 홈을 빼면 재생 중(#217 AC1)에 홈에 눌러앉을 수 있다. 반대로 넣어도 회수 가능한 사고
    // 매치는 `locked && !abandonable` 이 거짓이라 홈이 열린다 — 포기 버튼이 거기 있다.
    expect(LOCKED_ROUTES).toContain("/home");
    expect(shouldForceResume({ match: { id: "M", state: "FAILED" }, locked: true, abandonable: true })).toBe(false);
  });
});

describe("resumeLabelFor", () => {
  it("상태별 한 줄을 주고, 모르는 상태에서도 카드가 비지 않는다", () => {
    expect(resumeLabelFor("FAILED")).toContain("포기");
    expect(resumeLabelFor("HALFTIME")).toContain("감독시간");
    expect(resumeLabelFor("H1_BREAK")).toContain("감독시간"); // 레거시 행도 같은 대우
    expect(resumeLabelFor("SOMETHING_NEW")).toBeTruthy();
    expect(resumeLabelFor(undefined)).toBeTruthy();
  });

  /**
   * #382 MIN-3 (hero 확정) — 대기 화면에서 걷어낸 *"작전을 생성하는 중"* 어휘가 **같은 대기 상태를
   * 설명하는 이 카드**에 남아 있었다. 톤을 통일하되, 이 줄은 카드의 **유일한 상태 정보**라
   * (제목은 `경기 진행 중` 고정) 정경으로 덮어 버리면 *"멈춘 매치를 포기할까"* 판단 근거가 사라진다.
   * 그래서 계약이 **양쪽**을 건다: 시스템 어휘 0 **그리고** 단계 정보 유지.
   */
  it("GEN 대기 줄에서 시스템 어휘가 사라졌다 (대기 화면과 톤 통일)", () => {
    for (const state of ["GEN1", "GEN2"]) {
      const label = resumeLabelFor(state);
      for (const word of ["작전", "생성", "AI", "반영", "지시"]) {
        expect(label, `시스템 어휘가 남아 있다: "${label}" ← "${word}"`).not.toContain(word);
      }
    }
  });

  it("그래도 어느 단계에서 멈췄는지는 말한다 (포기 판단의 근거 — 카드의 유일한 상태 정보)", () => {
    expect(resumeLabelFor("GEN1")).toContain("전반");
    expect(resumeLabelFor("GEN2")).toContain("후반");
    // 전/후반이 같은 문장으로 뭉개지면 "어디서 멈췄나"를 알 수 없다.
    expect(resumeLabelFor("GEN1")).not.toBe(resumeLabelFor("GEN2"));
  });

  /**
   * ⚠️ **실패 고지는 정경 규칙 밖이다.** FAILED 는 기다림이 아니라 사고이고, 이 줄은 원인과
   * 다음 행동(재시도/포기)을 말해야 한다 — 정경 문장으로 덮으면 유저가 "그냥 기다리면 되는 줄"
   * 알고 갇힌다(#217 AC3 이 막으려던 바로 그 상태). 톤 통일이 여기까지 번지지 않게 못 박는다.
   */
  it("FAILED 는 정경으로 덮지 않는다 — 사고임을 말하고 행동을 준다", () => {
    const label = resumeLabelFor("FAILED");
    expect(label).toContain("실패");
    expect(label).toContain("포기");
  });
});
