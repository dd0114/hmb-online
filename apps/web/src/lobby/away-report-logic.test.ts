import { describe, expect, it } from "vitest";
import {
  headline,
  isForfeit,
  ratingDeltaText,
  recordText,
  resultBadge,
  shouldShowAwayPopup,
  type AwayReport,
  type AwayReportsResponse,
  type AwaySummary,
} from "./away-report-logic";

function report(over: Partial<AwayReport> = {}): AwayReport {
  return {
    id: "R1",
    matchId: "M1",
    attackerName: "FC 한밤중",
    goalsFor: 1,
    goalsAgainst: 3,
    result: "LOSS",
    ratingDelta: -10,
    createdAt: "2026-07-28T03:12:00Z",
    seen: false,
    ...over,
  };
}

function summary(over: Partial<AwaySummary> = {}): AwaySummary {
  return {
    matches: 3,
    opponents: 3,
    wins: 1,
    draws: 0,
    losses: 2,
    goalsFor: 4,
    goalsAgainst: 7,
    ratingDelta: -10,
    ...over,
  };
}

function response(over: Partial<AwayReportsResponse> = {}): AwayReportsResponse {
  return { reports: [report()], summary: summary(), rating: -10, unseen: 1, ...over };
}

describe("away report popup", () => {
  it("0건이면 팝업을 띄우지 않는다 — 빈 모달은 방해일 뿐이다", () => {
    expect(shouldShowAwayPopup(undefined)).toBe(false);
    expect(shouldShowAwayPopup(response({ reports: [], summary: summary({ matches: 0 }) }))).toBe(
      false,
    );
  });

  it("미확인이 있으면 띄운다", () => {
    expect(shouldShowAwayPopup(response())).toBe(true);
  });

  it("응답이 이상해도 로비를 죽이지 않는다 — 구 서버의 200 {} 는 '없음'으로 읽는다", () => {
    // 이 가드가 없으면 data.reports.length 가 던져 **로비 전체가 흰 화면**이 된다.
    expect(shouldShowAwayPopup({} as AwayReportsResponse)).toBe(false);
    expect(shouldShowAwayPopup({ reports: [report()] } as AwayReportsResponse)).toBe(false);
  });
});

describe("headline (요구 1+3)", () => {
  it("다건은 '몇 팀과 몇 승 몇 패'로 묶는다", () => {
    expect(headline(summary(), [report(), report(), report()])).toBe(
      "3팀이 우리 홈구장을 찾아왔습니다 — 1승 2패",
    );
  });

  it("단건은 상대 이름과 결과를 말한다(팀 수를 세지 않는다)", () => {
    const one = summary({ matches: 1, opponents: 1, wins: 1, losses: 0, ratingDelta: 10 });
    expect(headline(one, [report({ result: "WIN", ratingDelta: 10 })])).toBe(
      "FC 한밤중이(가) 원정을 왔고, 막아냈습니다",
    );
  });

  it("0건이면 빈 문자열(호출자가 팝업 자체를 안 띄운다)", () => {
    expect(headline(summary({ matches: 0 }), [])).toBe("");
  });
});

describe("recordText", () => {
  it("0인 항목은 빼서 짧게 말한다", () => {
    expect(recordText(summary({ wins: 2, draws: 0, losses: 0 }))).toBe("2승");
    expect(recordText(summary({ wins: 1, draws: 1, losses: 1 }))).toBe("1승 1무 1패");
  });
});

describe("ratingDeltaText", () => {
  it("증감 부호를 붙이고, 변동 없음을 ±0 으로 드러낸다", () => {
    expect(ratingDeltaText(10)).toBe("+10");
    expect(ratingDeltaText(-10)).toBe("-10");
    // 무승부만 있었던 부재중에 "0" 만 뜨면 '집계 실패'처럼 읽힌다.
    expect(ratingDeltaText(0)).toBe("±0");
  });
});

describe("isForfeit — 상대가 브리핑에서 무른 경기(#245 D1)", () => {
  it("0:0 인데 무승부가 아니면 몰수다", () => {
    expect(isForfeit({ goalsFor: 0, goalsAgainst: 0, result: "WIN" })).toBe(true);
    expect(isForfeit({ goalsFor: 0, goalsAgainst: 0, result: "LOSS" })).toBe(true);
  });

  it("실제로 뛴 0:0 은 언제나 DRAW 라 몰수와 섞이지 않는다", () => {
    expect(isForfeit({ goalsFor: 0, goalsAgainst: 0, result: "DRAW" })).toBe(false);
  });

  it("득점이 있으면 몰수가 아니다", () => {
    expect(isForfeit({ goalsFor: 2, goalsAgainst: 0, result: "WIN" })).toBe(false);
  });
});

describe("resultBadge", () => {
  it("승/무/패", () => {
    expect(resultBadge("WIN")).toBe("승");
    expect(resultBadge("DRAW")).toBe("무");
    expect(resultBadge("LOSS")).toBe("패");
  });
});
