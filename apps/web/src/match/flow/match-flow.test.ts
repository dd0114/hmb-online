/**
 * #424 W1 — 경기 흐름 브릿지 **순수 계약**(설계 §12.1 P1·P3·P4·P6·P7).
 *
 * 각 계약 옆에 **그것이 죽이는 변이**를 적는다. 변이를 실제로 되돌려 red 가 나는지 확인했다
 * (보고의 변이체 킬 표) — 그러지 않으면 계약이 초록으로 거짓말한다.
 */
import { describe, expect, it } from "vitest";
import {
  beatForTransition,
  bridgeCardModel,
  bridgeForTransition,
  bridgeScore,
  enqueueBridge,
  flowNextHint,
  flowSteps,
  isOverlayKind,
  matchEndHandoff,
  mergeBridge,
  stepOfState,
  type QueuedBridge,
} from "./match-flow";
import type { MatchDetail } from "../../api/hooks";

const detail = (over: Partial<MatchDetail> = {}): MatchDetail =>
  ({ id: "m1", state: "FINISHED", createdAt: "2026-08-03T00:00:00Z", ...over }) as MatchDetail;

describe("P1 — 브릿지는 상태가 아니라 전이에 붙는다", () => {
  it("네 지점의 전이에만 브릿지를 준다", () => {
    expect(bridgeForTransition("BRIEFING", "GEN1")).toEqual({ kind: "match_start", form: "panel" });
    expect(bridgeForTransition("FIRST_HALF", "HALFTIME")).toEqual({ kind: "h1_end", form: "overlay" });
    expect(bridgeForTransition("HALFTIME", "GEN2")).toEqual({ kind: "h2_start", form: "panel" });
    expect(bridgeForTransition("SECOND_HALF", "FINISHED")).toEqual({ kind: "match_end", form: "overlay" });
  });

  it("브릿지 지점이 아닌 전이는 아무것도 열지 않는다", () => {
    expect(bridgeForTransition("GEN1", "FIRST_HALF")).toBeNull(); // 여긴 비트 자리다
    expect(bridgeForTransition("GEN2", "SECOND_HALF")).toBeNull();
    expect(bridgeForTransition("FIRST_HALF", "FAILED")).toBeNull();
    expect(bridgeForTransition("BRIEFING", "ABANDONED")).toBeNull();
  });

  it("같은 상태의 재관측(폴링)은 전이가 아니다", () => {
    expect(bridgeForTransition("FIRST_HALF", "FIRST_HALF")).toBeNull();
  });

  /** ⚠️ P2 의 순수 절반 — 첫 관측에서 아무것도 열리지 않는다(훅 쪽 계약이 나머지 절반). */
  it("P2 — prev 가 없으면(첫 관측) 어떤 전이도 성립하지 않는다", () => {
    expect(bridgeForTransition(null, "FINISHED")).toBeNull();
    expect(bridgeForTransition(undefined, "HALFTIME")).toBeNull();
    expect(beatForTransition(null, "FIRST_HALF")).toBeNull();
  });

  it("킥오프 비트는 두 전이뿐이다", () => {
    expect(beatForTransition("GEN1", "FIRST_HALF")).toBe("kickoff_h1");
    expect(beatForTransition("GEN2", "SECOND_HALF")).toBe("kickoff_h2");
    expect(beatForTransition("HALFTIME", "GEN2")).toBeNull();
  });
});

describe("P6 — 오토 모드는 감독시간을 건너뛴다(전이 타겟이 셋)", () => {
  it("FIRST_HALF 에서 GEN2·SECOND_HALF 로 직행해도 h1_end 를 연다", () => {
    // 변이: 전이표에서 GEN2/SECOND_HALF 타겟 제거 → 오토 유저가 전반 종료 브릿지를 영영 못 본다.
    expect(bridgeForTransition("FIRST_HALF", "GEN2")?.kind).toBe("h1_end");
    expect(bridgeForTransition("FIRST_HALF", "SECOND_HALF")?.kind).toBe("h1_end");
    expect(bridgeForTransition("FIRST_HALF", "H1_BREAK")?.kind).toBe("h1_end");
  });
});

describe("N3 — B4 는 건너뛴 전이에서도 발화한다(`FINISHED` 로 들어오는 문이 하나가 아니다)", () => {
  /*
   * 독립검증 N3. B2 는 오토 대응으로 `to` 를 넷까지 넓혔는데 B4 는 `from: "SECOND_HALF"` 단일이라,
   * 아래 두 실경로에서 **경기 종료 브릿지가 안 뜬다 = AC4 의 네 번째 지점이 소실**됐다.
   * 변이: `from` 을 `["SECOND_HALF"]` 로 되돌리면 이 describe 가 통째로 죽는다(실측 3/3).
   */
  it("ⓐ 시계 롤백 — enterSecondHalf 가 finishMatch(..., S_GEN2) 를 태운 `GEN2 → FINISHED`", () => {
    expect(bridgeForTransition("GEN2", "FINISHED")).toEqual({ kind: "match_end", form: "overlay" });
  });

  it("ⓑ 탭이 백그라운드였다 — 중간 상태를 못 보고 곧바로 FINISHED 가 관측된다", () => {
    expect(bridgeForTransition("FIRST_HALF", "FINISHED")?.kind).toBe("match_end");
    expect(bridgeForTransition("HALFTIME", "FINISHED")?.kind).toBe("match_end");
    expect(bridgeForTransition("H1_BREAK", "FINISHED")?.kind).toBe("match_end");
  });

  it("⚠️ 넓혀도 몰수는 제외다 — 브리핑에서 무른 경기에 `90분이 끝났습니다` 는 거짓말이다", () => {
    // 이 전이는 실재한다(상대 몰수, 0:0). 그래도 B4 를 열지 않는 것이 규칙이다.
    expect(bridgeForTransition("BRIEFING", "FINISHED")).toBeNull();
    expect(bridgeForTransition("GEN1", "FINISHED")).toBeNull();
  });

  it("넓혀도 **중복 발화가 없다** — 큐는 병합하고 소비 이력은 되살리지 않는다", () => {
    /*
     * `from` 이 넓어지면 같은 매치에서 B4 를 여는 전이 후보가 여럿이 된다. 그래도 종류당 한 번인
     * 것은 큐(`enqueueBridge` 병합)와 소비 이력(`seen`)이 보장한다 — 넓히기가 그 두 층 **위**에
     * 있기 때문이다. 이 계약이 없으면 다음 사람이 `from` 을 더 넓힐 때 그 보장을 다시 확인하지 않는다.
     */
    const kinds = (["SECOND_HALF", "GEN2", "HALFTIME", "H1_BREAK", "FIRST_HALF"] as const).map(
      (from) => bridgeForTransition(from, "FINISHED")!.kind,
    );
    // ① 큐: 어느 문으로 들어와도 같은 kind 라 병합된다(스택이 두 벌 생기지 않는다).
    const queued = kinds.reduce<QueuedBridge[]>(
      (q, kind) => enqueueBridge(q, [], { kind: kind as "match_end", report: null }),
      [],
    );
    expect(queued).toHaveLength(1);
    // ② 이력: 한 번 닫은 뒤에는 어느 문으로 다시 관측돼도 안 열린다.
    for (const kind of kinds) {
      expect(enqueueBridge([], ["match_end"], { kind: kind as "match_end", report: null })).toEqual([]);
    }
  });
});

describe("대기형은 오버레이 큐에 들어가지 않는다", () => {
  it("panel 형태(B1·B3)는 overlay kind 가 아니다", () => {
    // 변이: isOverlayKind 를 상수 true 로 → GenWaitPanel 의 경과 시계·[경기 포기]가 덮인다.
    expect(isOverlayKind("match_start")).toBe(false);
    expect(isOverlayKind("h2_start")).toBe(false);
    expect(isOverlayKind("h1_end")).toBe(true);
    expect(isOverlayKind("match_end")).toBe(true);
  });
});

describe("P3 — 같은 종류가 두 벌 쌓이지 않는다", () => {
  it("중복 open 은 큐 길이를 늘리지 않는다", () => {
    const q1 = enqueueBridge([], [], { kind: "h1_end", report: null });
    const q2 = enqueueBridge(q1, [], { kind: "h1_end", report: null });
    expect(q2).toHaveLength(1);
  });

  it("종류가 다르면 뒤에 쌓인다(B2 를 안 닫은 채 경기가 끝난 흐름)", () => {
    const q = enqueueBridge(enqueueBridge([], [], { kind: "h1_end", report: null }), [], {
      kind: "match_end",
      report: null,
    });
    expect(q.map((b) => b.kind)).toEqual(["h1_end", "match_end"]);
  });
});

describe("P4 — 스킵 신호가 늦게 와도 리포트가 붙는다(순서 무의존)", () => {
  it("전이 관측 → 스킵 응답 순서", () => {
    // 변이: mergeBridge 를 "이미 열려 있으면 무시"로 축소 → 이 경로에서 리포트가 통째로 사라진다.
    const q = enqueueBridge(enqueueBridge([], [], { kind: "h1_end", report: null }), [], {
      kind: "h1_end",
      report: 1,
    });
    expect(q).toEqual([{ kind: "h1_end", report: 1 }]);
  });

  it("스킵 응답 → 전이 관측 순서(리포트가 지워지지 않는다)", () => {
    const q = enqueueBridge(enqueueBridge([], [], { kind: "h1_end", report: 1 }), [], {
      kind: "h1_end",
      report: null,
    });
    expect(q).toEqual([{ kind: "h1_end", report: 1 }]);
  });

  it("mergeBridge 는 종류가 다르면 기존을 지키지 않고 덮지 않는다", () => {
    const a: QueuedBridge = { kind: "h1_end", report: 1 };
    const b: QueuedBridge = { kind: "match_end", report: 2 };
    expect(mergeBridge(a, b)).toEqual(a);
  });
});

describe("P5 — 닫은 브릿지는 다시 열리지 않는다", () => {
  it("소비 이력에 있는 종류는 큐에 들어가지 않는다", () => {
    // 변이: seen 검사 제거 → 폴링이 1초마다 같은 브릿지를 되살린다.
    expect(enqueueBridge([], ["h1_end"], { kind: "h1_end", report: 1 })).toEqual([]);
  });
});

describe("P7 — 카드 내용은 현재 상태 파생이다", () => {
  const base = { outcome: null, hasContinuation: false };

  it("감독시간(오토 OFF)은 남은 시간을 말한다", () => {
    const m = bridgeCardModel("h1_end", { ...base, state: "HALFTIME", auto: false, countdown: "2:47" });
    expect(m.body).toContain("감독시간입니다");
    expect(m.note).toBe("남은 감독시간 2:47");
    expect(m.cta).toBe("감독시간으로");
  });

  it("오토 ON 이면 감독시간을 약속하지 않는다(없는 여유를 믿게 하지 않는다)", () => {
    const m = bridgeCardModel("h1_end", { ...base, state: "HALFTIME", auto: true, countdown: "0:00" });
    expect(m.body).toContain("감독시간 없이");
    expect(m.note).toBeNull();
    expect(m.cta).toBe("후반 준비로");
  });

  it("감독시간이 만료돼 GEN2 가 되면 카드가 따라간다(거짓말하지 않는다)", () => {
    // 변이: 본문을 open 시점 문자열로 굳히기 → 만료 뒤에도 `이제 감독시간입니다`가 남는다.
    const m = bridgeCardModel("h1_end", { ...base, state: "GEN2", auto: false, countdown: "1:12" });
    expect(m.body).toContain("후반을 준비");
    expect(m.note).toBeNull();
    expect(m.cta).toBe("후반 준비로");
  });

  it("후반이 이미 시작됐으면 그렇게 말한다", () => {
    const m = bridgeCardModel("h1_end", { ...base, state: "SECOND_HALF", auto: false });
    expect(m.body).toContain("이미 시작");
    expect(m.cta).toBe("후반 보기");
  });

  it("경기까지 끝났으면 결과로 보낸다", () => {
    const m = bridgeCardModel("h1_end", { ...base, state: "FINISHED", auto: true });
    expect(m.cta).toBe("결과 보기");
  });

  it("모르는 상태에서는 사실만 말하고 갈 곳을 지어내지 않는다", () => {
    const m = bridgeCardModel("h1_end", { ...base, state: "ABANDONED", auto: false });
    expect(m.body).toBe("전반이 끝났습니다.");
    expect(m.cta).toBe("확인");
  });

  it("시계가 없으면 남은 시간을 말하지 않는다", () => {
    const m = bridgeCardModel("h1_end", { ...base, state: "HALFTIME", auto: false, countdown: null });
    expect(m.note).toBeNull();
  });

  it("경기 종료는 승패로 갈리고, CTA 는 continuation 유무로 갈린다(C2)", () => {
    expect(bridgeCardModel("match_end", { ...base, state: "FINISHED", auto: false, outcome: "WIN" }).body).toContain(
      "승리",
    );
    expect(bridgeCardModel("match_end", { ...base, state: "FINISHED", auto: false, outcome: "LOSS" }).body).toContain(
      "졌습니다",
    );
    expect(bridgeCardModel("match_end", { ...base, state: "FINISHED", auto: false, outcome: null }).body).toBe(
      "90분이 끝났습니다.",
    );
    expect(bridgeCardModel("match_end", { ...base, state: "FINISHED", auto: false }).cta).toBe("결과 보기");
    expect(
      bridgeCardModel("match_end", { ...base, state: "FINISHED", auto: false, hasContinuation: true }).cta,
    ).toBe("보상 받기");
  });
});

describe("스코어 줄 — 모르면 그리지 않는다", () => {
  it("확정값이 없으면 null(0 : 0 을 지어내지 않는다)", () => {
    expect(bridgeScore("h1_end", detail({ scoreH1Home: null, scoreH1Away: null }))).toBeNull();
    expect(bridgeScore("match_end", detail({ scoreHome: 2 }))).toBeNull();
    expect(bridgeScore("match_end", undefined)).toBeNull();
  });

  it("종류마다 다른 축을 본다(전반 종료 = 전반 스코어)", () => {
    const m = detail({ scoreH1Home: 1, scoreH1Away: 0, scoreHome: 3, scoreAway: 2 });
    expect(bridgeScore("h1_end", m)).toEqual({ home: 1, away: 0 });
    expect(bridgeScore("match_end", m)).toEqual({ home: 3, away: 2 });
  });
});

describe("스텝 모델", () => {
  it("현재 상태 앞은 done, 뒤는 upcoming", () => {
    const steps = flowSteps("FIRST_HALF", false);
    expect(steps.map((s) => s.status)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("오토여도 스텝 수는 그대로다 — 표기만 `건너뜀`(화면을 다시 배우게 하지 않는다)", () => {
    const auto = flowSteps("GEN1", true);
    expect(auto).toHaveLength(7);
    expect(auto.find((s) => s.id === "halftime")?.skipped).toBe(true);
    expect(flowSteps("GEN1", false).find((s) => s.id === "halftime")?.skipped).toBe(false);
  });

  it("모르는 상태는 아무 스텝도 강조하지 않는다", () => {
    expect(stepOfState("FAILED")).toBeNull();
    expect(flowSteps("FAILED", false).every((s) => s.status === "upcoming")).toBe(true);
  });

  it("다음 안내는 대기 상태에서만 뜬다", () => {
    expect(flowNextHint("GEN1")).toBe("다음 · 전반 킥오프");
    expect(flowNextHint("GEN2")).toBe("다음 · 후반 킥오프");
    expect(flowNextHint("FIRST_HALF")).toBeNull();
  });
});

describe("#405 진입 계약(§9)", () => {
  it("handoff 는 matchId·상태·스킵여부·스코어·결과뿐이다(보상 스키마를 모른다 — C1)", () => {
    const h = matchEndHandoff(detail({ scoreHome: 2, scoreAway: 1, result: "WIN" }), true);
    expect(h).toEqual({
      matchId: "m1",
      matchState: "FINISHED",
      viaSkip: true,
      score: { home: 2, away: 1 },
      outcome: "WIN",
    });
  });

  it("확정 스코어를 모르면 score 는 null 이다(소비자가 조회하면 된다)", () => {
    expect(matchEndHandoff(detail({}), false).score).toBeNull();
    expect(matchEndHandoff(detail({}), false).outcome).toBeNull();
  });
});
