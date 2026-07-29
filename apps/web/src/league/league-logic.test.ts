import { describe, expect, it } from "vitest";
import type { LeagueFixture, LeagueStanding, LeagueTeam } from "../api/v2";
import type { LeagueSeasonReward } from "../api/p3";
import {
  fixtureScore,
  formatAwardedAt,
  groupByRound,
  isGranted,
  isSeasonFinished,
  pickSeasonReward,
  seasonRewardView,
  seasonSummary,
  sortByRank,
  standingsComparator,
  teamNameMap,
  userRank,
} from "./league-logic";

const st = (over: Partial<LeagueStanding>): LeagueStanding => ({
  teamId: "t1",
  name: "팀1",
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  goalDiff: 0,
  points: 0,
  rank: 1,
  isUser: false,
  ...over,
});

const fx = (over: Partial<LeagueFixture>): LeagueFixture => ({
  id: "f1",
  round: 1,
  homeTeam: "t1",
  awayTeam: "t2",
  isUser: false,
  state: "SCHEDULED",
  scoreHome: null,
  scoreAway: null,
  matchId: null,
  ...over,
});

describe("sortByRank — 서버 rank(authoritative) 오름차순 안정정렬", () => {
  it("셔플된 순위표를 rank 순으로 렌더 정렬", () => {
    const shuffled = [
      st({ teamId: "c", rank: 3 }),
      st({ teamId: "a", rank: 1 }),
      st({ teamId: "b", rank: 2 }),
    ];
    expect(sortByRank(shuffled).map((s) => s.teamId)).toEqual(["a", "b", "c"]);
  });
  it("입력 배열을 변형하지 않는다(복사본 반환)", () => {
    const input = [st({ teamId: "b", rank: 2 }), st({ teamId: "a", rank: 1 })];
    sortByRank(input);
    expect(input.map((s) => s.teamId)).toEqual(["b", "a"]);
  });
  it("동일 rank 는 teamId 안정 정렬", () => {
    const same = [st({ teamId: "z", rank: 1 }), st({ teamId: "a", rank: 1 })];
    expect(sortByRank(same).map((s) => s.teamId)).toEqual(["a", "z"]);
  });
});

describe("standingsComparator — 방어적 타이브레이크(승점→골득실→다득점)", () => {
  it("승점 우선(내림차순)", () => {
    const rows = [st({ teamId: "a", points: 3 }), st({ teamId: "b", points: 9 })];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["b", "a"]);
  });
  it("승점 동률이면 골득실", () => {
    const rows = [
      st({ teamId: "a", points: 6, goalDiff: 1 }),
      st({ teamId: "b", points: 6, goalDiff: 5 }),
    ];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["b", "a"]);
  });
  it("승점·골득실 동률이면 다득점", () => {
    const rows = [
      st({ teamId: "a", points: 6, goalDiff: 2, goalsFor: 4 }),
      st({ teamId: "b", points: 6, goalDiff: 2, goalsFor: 9 }),
    ];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["b", "a"]);
  });
  it("완전 동률은 teamId 안정 결정론", () => {
    const rows = [
      st({ teamId: "y", points: 6, goalDiff: 2, goalsFor: 4 }),
      st({ teamId: "x", points: 6, goalDiff: 2, goalsFor: 4 }),
    ];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["x", "y"]);
  });
});

describe("groupByRound — 일정 라운드 묶기", () => {
  it("라운드 오름차순으로 묶고 내부 순서 유지", () => {
    const fixtures = [
      fx({ id: "r2a", round: 2 }),
      fx({ id: "r1a", round: 1 }),
      fx({ id: "r1b", round: 1 }),
      fx({ id: "r2b", round: 2 }),
    ];
    const groups = groupByRound(fixtures);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[0]!.fixtures.map((f) => f.id)).toEqual(["r1a", "r1b"]);
    expect(groups[1]!.fixtures.map((f) => f.id)).toEqual(["r2a", "r2b"]);
  });
});

describe("fixtureScore — 픽스처 관점 스코어(오리엔트 안 함)", () => {
  it("PLAYED 는 홈-어웨이 원값 표시", () => {
    expect(fixtureScore(fx({ state: "PLAYED", scoreHome: 2, scoreAway: 1 }))).toBe("2 - 1");
  });
  it("SCHEDULED 는 null", () => {
    expect(fixtureScore(fx({ state: "SCHEDULED" }))).toBeNull();
  });
});

describe("teamNameMap / userRank / isSeasonFinished", () => {
  it("teamId→이름 매핑", () => {
    const teams: LeagueTeam[] = [
      { teamId: "t1", name: "내팀", isUser: true, persona: null, power: null },
      { teamId: "t2", name: "봇A", isUser: false, persona: "공격", power: 900 },
    ];
    const m = teamNameMap(teams);
    expect(m.get("t2")).toBe("봇A");
  });
  it("userRank = isUser 행의 rank", () => {
    expect(userRank([st({ teamId: "a", rank: 1 }), st({ teamId: "u", rank: 4, isUser: true })])).toBe(4);
    expect(userRank([st({ isUser: false })])).toBeNull();
  });
  it("isSeasonFinished", () => {
    expect(isSeasonFinished({ state: "FINISHED" } as never)).toBe(true);
    expect(isSeasonFinished({ state: "ACTIVE" } as never)).toBe(false);
    expect(isSeasonFinished(null)).toBe(false);
  });
});

/* ───────────── 시즌 종료 보상 (PRD-v4 §E / AC-E1) ───────────── */

describe("seasonSummary — standings 의 isUser 행에서 시즌 요약 계산", () => {
  const rows = [
    st({ teamId: "bot", rank: 1, played: 18, won: 14, points: 44 }),
    st({
      teamId: "me",
      rank: 3,
      isUser: true,
      played: 18,
      won: 10,
      drawn: 4,
      lost: 4,
      goalsFor: 31,
      goalsAgainst: 22,
      goalDiff: 9,
      points: 34,
    }),
  ];

  it("유저 행의 승/무/패·득실·승점을 요약", () => {
    const s = seasonSummary(rows)!;
    expect(s.rank).toBe(3);
    expect(s.played).toBe(18);
    expect(s.record).toBe("10승 4무 4패");
    expect(s.goalsLabel).toBe("31 - 22");
    expect(s.goalDiffLabel).toBe("+9");
    expect(s.points).toBe(34);
  });

  it("골득실 부호 표기(음수/0)", () => {
    expect(seasonSummary([st({ isUser: true, goalDiff: -4 })])!.goalDiffLabel).toBe("-4");
    expect(seasonSummary([st({ isUser: true, goalDiff: 0 })])!.goalDiffLabel).toBe("0");
  });

  it("유저 행이 없으면 null(요약 숨김)", () => {
    expect(seasonSummary([st({ isUser: false })])).toBeNull();
    expect(seasonSummary([])).toBeNull();
  });
});

describe("pickSeasonReward — Phase3 additive 소비 + 구서버 폴백", () => {
  const reward: LeagueSeasonReward = { rank: 3, points: 500, status: "GRANTED" };

  it("season 안의 seasonReward 를 읽는다", () => {
    expect(pickSeasonReward({ season: { seasonReward: reward } as never })).toEqual(reward);
  });
  it("응답 루트의 seasonReward 도 수용(계약 미확정 관용)", () => {
    expect(pickSeasonReward({ seasonReward: reward })).toEqual(reward);
  });
  it("season 위치가 루트보다 우선", () => {
    const rootOnly: LeagueSeasonReward = { rank: 9, points: 0, status: "FAILED" };
    expect(pickSeasonReward({ season: { seasonReward: reward } as never, seasonReward: rootOnly })).toEqual(
      reward,
    );
  });
  it("필드 부재(구 서버) → null → 기존 화면 폴백", () => {
    expect(pickSeasonReward({ season: {} as never })).toBeNull();
    expect(pickSeasonReward({})).toBeNull();
    expect(pickSeasonReward(null)).toBeNull();
    expect(pickSeasonReward(undefined)).toBeNull();
    expect(pickSeasonReward({ season: { seasonReward: null } as never })).toBeNull();
  });
  it("원시값(계약 밖 타입)도 감추지 않고 FAILED 로 승격 — 카드가 사라지면 안 된다", () => {
    for (const bad of ["boom", 42, true]) {
      const v = pickSeasonReward({ seasonReward: bad as never })!;
      expect(v, `seasonReward=${JSON.stringify(bad)} 는 폴백이 아니라 FAILED 노출`).not.toBeNull();
      expect(v.status).toBe("FAILED");
      expect(v.rank).toBe(0);
      expect(v.points).toBe(0);
      expect(v.message).toContain("확인할 수 없습니다");
    }
  });
  it("경계 유지: 부재/null/undefined 만 폴백(구 서버), 값이 있으면 언제나 노출", () => {
    expect(pickSeasonReward({ seasonReward: undefined })).toBeNull();
    expect(pickSeasonReward({ seasonReward: null })).toBeNull();
    expect(pickSeasonReward({ seasonReward: 0 as never })).not.toBeNull(); // falsy 지만 값은 존재
    expect(pickSeasonReward({ seasonReward: "" as never })).not.toBeNull();
  });
  it("계약 밖 status 는 감추지 않고 FAILED 로 승격(노출 유지)", () => {
    const weird = pickSeasonReward({ seasonReward: { rank: 3, points: 500, status: "WAT" } as never })!;
    expect(weird.status).toBe("FAILED");
    expect(weird.message).toContain("확인할 수 없습니다");
  });
  it("rank/points 가 숫자가 아니면 FAILED 로 승격", () => {
    const bad = pickSeasonReward({ seasonReward: { points: 500, status: "GRANTED" } as never })!;
    expect(bad.status).toBe("FAILED");
    expect(bad.rank).toBe(0);
  });
});

describe("formatAwardedAt — 지급 시각 표시(순수 문자열, Date 미사용)", () => {
  it("ISO → 'YYYY-MM-DD HH:mm'", () => {
    expect(formatAwardedAt("2026-07-20T09:00:00Z")).toBe("2026-07-20 09:00");
    expect(formatAwardedAt("2026-07-20 09:05:33")).toBe("2026-07-20 09:05");
  });
  it("파싱 불가는 원문 유지, 부재는 null", () => {
    expect(formatAwardedAt("방금")).toBe("방금");
    expect(formatAwardedAt(null)).toBeNull();
    expect(formatAwardedAt(undefined)).toBeNull();
  });
});

describe("seasonRewardView — status 3분기(조용한 숨김 금지)", () => {
  it("AWARDED = 보상액 표시 + 카운트업 연출 + 재조회 없음", () => {
    const v = seasonRewardView({ rank: 2, points: 1200, status: "GRANTED" });
    expect(v).toMatchObject({ showPoints: true, animate: true, canRetry: false, tone: "success" });
    expect(v.detail).toContain("1,200");
    expect(v.detail).toContain("2위");
  });

  it("재화 단위는 주입된 포매터가 정한다 — 순수 함수가 심볼을 알지 않는다 (#232)", () => {
    const v = seasonRewardView({ rank: 1, points: 100_000, status: "GRANTED" }, (n) => `${n} Ω`);
    expect(v.detail).toContain("100000 Ω");
    // 주입을 잊어도 "P" 같은 틀린 단위가 새 나가지 않는다(숫자만).
    expect(seasonRewardView({ rank: 1, points: 100_000, status: "GRANTED" }).detail).not.toContain("P");
  });
  it("PENDING = 처리 중 안내 + 재조회 가능 + 지급액 미확정", () => {
    const v = seasonRewardView({ rank: 5, points: 300, status: "PENDING" });
    expect(v).toMatchObject({ showPoints: false, animate: false, canRetry: true, tone: "pending" });
    expect(v.headline).toContain("처리 중");
  });
  it("FAILED = 서버 message 를 그대로 노출 + 재조회 가능", () => {
    const v = seasonRewardView({ rank: 7, points: 0, status: "FAILED", message: "지갑 반영 실패(원장 충돌)" });
    expect(v).toMatchObject({ showPoints: false, animate: false, canRetry: true, tone: "error" });
    expect(v.detail).toBe("지갑 반영 실패(원장 충돌)");
  });
  it("FAILED 인데 message 가 비면 기본 사유 문구(빈 화면 금지)", () => {
    expect(seasonRewardView({ rank: 7, points: 0, status: "FAILED", message: "  " }).detail.length).toBeGreaterThan(
      0,
    );
    expect(seasonRewardView({ rank: 7, points: 0, status: "FAILED" }).detail).toContain("실패");
  });
});

/**
 * #251 — 서버가 실제로 보내는 status 는 `GRANTED|PENDING|NONE`(openapi SoT)인데 클라가
 * `AWARDED|PENDING|FAILED` 만 알아서 **종료된 시즌 전부가 "지급되지 않았습니다"로 떴다**.
 * e2e 목이 `AWARDED` 를 쓰고 있어(서버가 보내지 않는 값) 목-실서버 드리프트로 가려져 있었다.
 * 그래서 여기서는 **서버 이름으로** 계약을 건다 — 구 별칭이 아니라 이게 정본이다.
 */
describe("seasonReward — 서버 status enum(GRANTED/NONE) 수용 (#251)", () => {
  it("GRANTED = 지급 완료(성공 표현) — FAILED 로 떨어지지 않는다", () => {
    const picked = pickSeasonReward({
      season: { seasonReward: { rank: 1, points: 100_000, gems: 9000, status: "GRANTED" } } as never,
    })!;
    expect(picked.status, "서버 enum 이 계약 밖으로 취급되면 안 된다").toBe("GRANTED");

    const v = seasonRewardView(picked);
    expect(v).toMatchObject({ showPoints: true, animate: true, canRetry: false, tone: "success" });
    expect(v.headline).toContain("지급 완료");
  });

  it("isGranted = GRANTED(서버) + AWARDED(구 별칭) 둘 다 성공", () => {
    expect(isGranted("GRANTED")).toBe(true);
    expect(isGranted("AWARDED")).toBe(true);
    expect(isGranted("NONE")).toBe(false);
    expect(isGranted("PENDING")).toBe(false);
    expect(isGranted("FAILED")).toBe(false);
  });

  it("NONE(종료됐으나 지급행 없음) = 미지급 표현 + 재조회 가능, 상태는 보존", () => {
    const v = seasonRewardView({ rank: 4, points: 0, status: "NONE" });
    expect(v.status).toBe("NONE");
    expect(v).toMatchObject({ showPoints: false, animate: false, canRetry: true, tone: "error" });
  });
});

/**
 * #251 — 시즌 젬이 "우승만"에서 "완주 전원"으로 바뀌어 종료 화면엔 항상 G·Z 가 같이 온다.
 * 문장에도 병기한다(옆줄 숫자만으로는 무엇 때문에 들어온 재화인지 알 수 없었다).
 */
describe("seasonRewardView — G·Z 병기 (#251)", () => {
  const granted = { rank: 1, points: 100_000, gems: 9000, status: "GRANTED" } as const;

  it("지급 완료 문장에 P 금액과 젬 금액이 함께 들어간다", () => {
    const v = seasonRewardView(granted, (n) => `${n.toLocaleString()} G`, (n) => `${n.toLocaleString()} Z`);
    expect(v.detail).toContain("100,000 G");
    expect(v.detail).toContain("9,000 Z");
  });

  it("두 재화 표기 모두 주입된 포매터가 정한다 — 순수 함수가 심볼을 알지 않는다 (#232)", () => {
    const v = seasonRewardView(granted, (n) => `${n} Ω`, (n) => `${n} Ξ`);
    expect(v.detail).toContain("100000 Ω");
    expect(v.detail).toContain("9000 Ξ");
    // 주입을 잊으면 숫자만 — 틀린 단위가 새 나가지 않는다.
    expect(seasonRewardView(granted).detail).not.toMatch(/[PGZΩΞ]/);
  });

  it("젬이 0/부재면 기존 G 단독 문장 그대로(구 시즌 회귀 0)", () => {
    const zero = seasonRewardView({ rank: 5, points: 4000, gems: 0, status: "GRANTED" }, (n) => `${n} G`, (n) => `${n} Z`);
    expect(zero.detail).toContain("4000 G");
    expect(zero.detail).not.toContain("Z");
    const absent = seasonRewardView({ rank: 5, points: 4000, status: "GRANTED" }, (n) => `${n} G`, (n) => `${n} Z`);
    expect(absent.detail).toBe(zero.detail);
  });
});

/* ───────────────── 디비전 승급/강등 (#262) ───────────────── */

import {
  divisionLabel,
  divisionOutcome,
  divisionRuleText,
  pickDivision,
  zoneOfRank,
} from "./league-logic";

const seasonWith = (extra: Record<string, unknown>) =>
  ({ id: "S", seasonNo: 1, state: "ACTIVE", teams: [], standings: [], fixtures: [], ...extra }) as never;

describe("pickDivision — 구 서버 폴백이 최우선", () => {
  it("division 필드가 없으면 null — 화면에서 기능 전체가 사라진다(깨짐 0)", () => {
    expect(pickDivision(seasonWith({}))).toBeNull();
    expect(pickDivision(null)).toBeNull();
    expect(pickDivision(undefined)).toBeNull();
  });

  it("division 만 있고 컷이 없으면 hasRules=false — 라벨은 띄우되 승급권 색칠은 안 한다", () => {
    const d = pickDivision(seasonWith({ division: 7 }));
    expect(d).toEqual({ level: 7, name: null, promoteRankMax: null, relegateRankMin: null, hasRules: false });
    expect(zoneOfRank(1, d)).toBe("none");
    expect(divisionRuleText(d)).toBeNull();
  });

  it("이름이 없거나 공백이면 지어내지 않는다 — level 표기로 폴백", () => {
    expect(divisionLabel(pickDivision(seasonWith({ division: 5 })))).toBe("D5");
    expect(divisionLabel(pickDivision(seasonWith({ division: 5, divisionName: "   " })))).toBe("D5");
    expect(divisionLabel(pickDivision(seasonWith({ division: 5, divisionName: "디비전 5" })))).toBe("디비전 5");
  });

  it("0·음수 컷은 부재로 취급 — '1~0위 승급' 같은 문장을 만들지 않는다", () => {
    const d = pickDivision(seasonWith({ division: 5, promoteRankMax: 0, relegateRankMin: -1 }));
    expect(d?.promoteRankMax).toBeNull();
    expect(d?.relegateRankMin).toBeNull();
    expect(d?.hasRules).toBe(false);
    expect(divisionRuleText(d)).toBeNull();
  });

  it("숫자가 아닌 값은 부재로 취급(서버 계약 밖 방어)", () => {
    expect(pickDivision(seasonWith({ division: "5" }))).toBeNull();
    const d = pickDivision(seasonWith({ division: 5, promoteRankMax: "2", relegateRankMin: null }));
    expect(d?.hasRules).toBe(false);
  });
});

describe("zoneOfRank — 컷은 서버 값만 쓴다(하드코딩 금지)", () => {
  const d = pickDivision(seasonWith({ division: 5, promoteRankMax: 2, relegateRankMin: 9 }));

  it("경계값: 2위=승급 / 3위=유지 / 8위=유지 / 9위=강등", () => {
    expect(zoneOfRank(1, d)).toBe("promote");
    expect(zoneOfRank(2, d)).toBe("promote");
    expect(zoneOfRank(3, d)).toBe("hold");
    expect(zoneOfRank(8, d)).toBe("hold");
    expect(zoneOfRank(9, d)).toBe("relegate");
    expect(zoneOfRank(10, d)).toBe("relegate");
  });

  it("서버가 컷을 바꾸면 화면도 따라간다 — 클라가 2/9 를 기억하고 있으면 안 된다", () => {
    const wide = pickDivision(seasonWith({ division: 5, promoteRankMax: 4, relegateRankMin: 7 }));
    expect(zoneOfRank(4, wide)).toBe("promote"); // 구 규칙이면 hold 였다
    expect(zoneOfRank(7, wide)).toBe("relegate"); // 구 규칙이면 hold 였다
    expect(zoneOfRank(5, wide)).toBe("hold");
  });

  it("승급만 있고 강등이 없는 사다리(최하위 디비전)도 성립", () => {
    const bottom = pickDivision(seasonWith({ division: 10, promoteRankMax: 2 }));
    expect(zoneOfRank(1, bottom)).toBe("promote");
    expect(zoneOfRank(10, bottom)).toBe("hold"); // 더 내려갈 곳이 없다
  });
});

describe("divisionRuleText — 문장에 숫자를 박지 않는다", () => {
  it("서버 컷을 그대로 읽어 만든다", () => {
    expect(divisionRuleText(pickDivision(seasonWith({ division: 5, promoteRankMax: 2, relegateRankMin: 9 }))))
      .toBe("1~2위 승급 · 9위부터 강등");
    expect(divisionRuleText(pickDivision(seasonWith({ division: 5, promoteRankMax: 4, relegateRankMin: 7 }))))
      .toBe("1~4위 승급 · 7위부터 강등");
  });

  it("승급 컷이 1이면 '1~1위'가 아니라 '1위'", () => {
    expect(divisionRuleText(pickDivision(seasonWith({ division: 2, promoteRankMax: 1, relegateRankMin: 9 }))))
      .toBe("1위 승급 · 9위부터 강등");
  });
});

describe("divisionOutcome — 시즌 종료 연출", () => {
  const d = pickDivision(seasonWith({ division: 5, divisionName: "디비전 5", promoteRankMax: 2, relegateRankMin: 9 }));

  it("승급 / 유지 / 강등 세 갈래가 전부 표현된다", () => {
    expect(divisionOutcome(1, d)).toMatchObject({ zone: "promote", tone: "success", headline: "승급!" });
    expect(divisionOutcome(5, d)).toMatchObject({ zone: "hold", tone: "neutral" });
    expect(divisionOutcome(10, d)).toMatchObject({ zone: "relegate", tone: "error", headline: "강등" });
  });

  it("최상위 우승은 '유지' 가 아니라 우승으로 그린다 — 게임 최상단 성취가 지워지면 안 된다", () => {
    // 판정 근거는 **서버가 준 것뿐**: 승급 컷이 null = 최상위. level 숫자를 보지 않는다.
    const top = pickDivision(
      seasonWith({ division: 1, divisionName: "챔피언 리그", promoteRankMax: null, relegateRankMin: 9 }),
    );
    const champ = divisionOutcome(1, top);
    expect(champ).toMatchObject({ zone: "hold", tone: "success" });
    expect(champ?.headline).toContain("우승");
    expect(champ?.detail).not.toContain("한 단계 위"); // 승급이 아니다 — 거짓말 금지(BL-1)

    // 최상위여도 1위가 아니면 평범한 유지.
    expect(divisionOutcome(5, top)).toMatchObject({ zone: "hold", tone: "neutral" });
    // 중간 디비전 1위는 승급이지 최상위 우승이 아니다.
    const mid = pickDivision(seasonWith({ division: 5, promoteRankMax: 2, relegateRankMin: 9 }));
    expect(divisionOutcome(1, mid)).toMatchObject({ zone: "promote" });
  });

  it("다음 디비전 번호를 클라가 계산하지 않는다 — 사다리 끝 클램프는 서버 규칙", () => {
    // 최상위(D1)에서 우승해도 "한 단계 위"라는 표현만 쓰고 'D0' 같은 걸 만들지 않는다.
    const top = pickDivision(seasonWith({ division: 1, divisionName: "디비전 1", promoteRankMax: 2, relegateRankMin: 9 }));
    const out = divisionOutcome(1, top);
    expect(out?.detail).not.toMatch(/D0|디비전 0/);
    expect(out?.detail).toContain("디비전 1에서");
  });

  it("순위나 규칙이 없으면 연출하지 않는다", () => {
    expect(divisionOutcome(null, d)).toBeNull();
    expect(divisionOutcome(1, null)).toBeNull();
    expect(divisionOutcome(1, pickDivision(seasonWith({ division: 5 })))).toBeNull();
  });
});


describe("보상 status — 서버 enum 을 그대로 받는다 (독립검증 MAJ-1)", () => {
  // 서버 openapi = PENDING | GRANTED | NONE. 예전엔 클라가 "AWARDED" 를 기대해
  // **실제로 보상을 받은 유저가 '지급되지 않았습니다' 를 봤다**. 목이 서버 형상을 안 지키면
  // 계약이 green 인 채로 라이브에서만 깨진다.
  it("GRANTED = 지급 완료(성공 톤)", () => {
    const v = seasonRewardView({ rank: 1, points: 100_000, status: "GRANTED" });
    expect(v.tone).toBe("success");
    expect(v.showPoints).toBe(true);
    expect(v.canRetry).toBe(false);
    expect(v.headline).toContain("지급 완료");
  });

  it("NONE = 보상 대상이 아님(실패 아님) — 에러 톤·재조회 버튼이 뜨면 안 된다", () => {
    const v = seasonRewardView({ rank: 7, points: 0, status: "NONE" });
    expect(v.tone).not.toBe("error");
    expect(v.canRetry).toBe(false);
    expect(v.headline).not.toContain("지급되지 않았");
  });

  it("서버가 보내는 세 값은 전부 '알 수 없는 응답' 으로 떨어지지 않는다", () => {
    for (const status of ["PENDING", "GRANTED", "NONE"] as const) {
      const picked = pickSeasonReward({ seasonReward: { rank: 1, points: 10, status } });
      expect(picked?.status, `${status} 는 알려진 값이어야 한다`).toBe(status);
    }
  });

  it("정말 모르는 값만 FAILED 로 승격한다(조용한 숨김 금지)", () => {
    const picked = pickSeasonReward({ seasonReward: { rank: 1, points: 10, status: "AWARDED" } as never });
    expect(picked?.status).toBe("FAILED");
  });
});
