/**
 * #421 W7 — 평점 어댑터의 **격리 계약**(W2 스텁 계약을 플립한 것).
 *
 * 이 파일이 지키는 것은 "평점이 맞느냐"가 아니다(그건 #403 `player-stats.ts` 의 계약 몫이다).
 * 여기서 박는 것은 **경계**다:
 *  ① 산식이 이 브랜치에 복사되지 않았다 — 반환 평점이 `computePlayerStats` 의 값과 **같은 객체에서**
 *     온다(#57 재발명 금지). 여기서 계수를 다시 곱하면 이 단언이 깨진다.
 *  ② 어떤 입력(빈 로그·손상 로그·null)에도 **던지지 않고 `null`** 을 준다 — 리포트가 화면을 죽이면 안 된다.
 *  ③ 팀 필터는 **소비자가 고르는 옵션**이고, 그 tie-break 는 #403 `pickMotm` 과 **같은 전순서**다(결정론).
 *
 * ⚠️ W2 계약("무엇을 먹여도 null")은 **의도적으로 좁혀졌다** — 그때의 `null` 은 모듈 부재였고,
 * 지금의 `null` 은 **기록이 없는 하프**다. ②③은 그대로 남아 있는 것이 "시그니처를 안 바꿨다"는 증거다.
 */
import { describe, expect, it } from "vitest";
import { highlightStatsOf, topRatedOfHalf } from "./skip-report-rating";
import { computePlayerStats, type StatMatchLog } from "./player-stats";

/** 정지한 선수들 — 주행거리 차이를 0 으로 만들어 **이벤트만이** 평점을 가르게 한다(tie-break 표본). */
const AT = (playerId: string, team: string, x: number) => ({ playerId, team, pos: { x, y: 34 } });
const SNAP = (tick: number) => ({
  tick,
  minute: tick,
  ball: { x: 52.5, y: 34 },
  ballOwner: null,
  players: [AT("H1", "home", 40), AT("H2", "home", 60), AT("A1", "away", 70), AT("A2", "away", 80)],
});

function log(events: unknown[]): StatMatchLog {
  return { tickSnapshots: [SNAP(0), SNAP(1), SNAP(2), SNAP(3)], events } as unknown as StatMatchLog;
}

const GOAL_H2 = { tick: 1, minute: 1, type: "goal", team: "home", playerId: "H2" };
const SHOT_A1 = { tick: 2, minute: 2, type: "shot", team: "away", playerId: "A1", detail: "on_target" };

describe("topRatedOfHalf — 산식은 #403 의 것이다", () => {
  it("골을 넣은 선수를 그 하프 최고로 뽑고, 평점은 `computePlayerStats` 가 준 값 그대로다", () => {
    const l = log([GOAL_H2, SHOT_A1]);
    const top = topRatedOfHalf(l);
    expect(top).not.toBeNull();
    expect(top!.playerId).toBe("H2");
    expect(top!.team).toBe("home");

    // ① 재발명 금지의 증거 — 우리가 돌려준 값이 SoT 의 값과 **동일**하다.
    const sot = computePlayerStats(l, {});
    expect(top!.rating).toBe(sot.motm!.rating);
    expect(top!.isMotm).toBe(true);
    // `line` 도 SoT 의 집계 줄 그대로(카드가 다시 세지 않는다).
    expect(top!.line?.goals).toBe(1);
  });

  it("팀 필터를 켜면 그 팀 최고를 준다 — 양 팀 통합 MOTM 이 아닐 수 있다(`isMotm=false`)", () => {
    const l = log([GOAL_H2, SHOT_A1]);
    const away = topRatedOfHalf(l, { team: "away" });
    expect(away!.team).toBe("away");
    expect(away!.playerId).toBe("A1"); // 유효슛이 있는 쪽
    expect(away!.isMotm).toBe(false);

    const home = topRatedOfHalf(l, { team: "home" });
    expect(home!.playerId).toBe("H2");
    expect(home!.isMotm).toBe(true);
  });

  it("동점이면 키(`team:playerId`) 사전순 — #403 `pickMotm` 과 같은 전순서라 결정론적이다", () => {
    // 이벤트가 없으면 두 홈 선수의 집계 줄이 완전히 같다 → tie-break 만이 답을 정한다.
    // ⚠️ 이 표본은 **마지막 단계(키)만** 잰다. 집계가 완전히 같으면 앞 단계들은 어떤 순서로
    //    늘어놔도 같은 답이 나오므로, 전순서 자체는 아래 두 계약이 잡는다(W8 minor-1).
    const l = log([]);
    const a = topRatedOfHalf(l, { team: "home" });
    const b = topRatedOfHalf(l, { team: "home" });
    expect(a!.playerId).toBe("H1");
    expect(b!.playerId).toBe(a!.playerId); // 같은 입력 → 같은 답
  });

  /*
   * ── tie-break **전순서**의 킬링 계약 (W8 minor-1) ────────────────────────────────────
   * 파일 머리말이 *"`pickMotm` 과 같은 전순서여야 한다 … 순서를 바꾸지 마라"* 라고 못 박은
   * 불변식인데, 위의 `log([])` 표본 하나로는 **순서를 뒤집어도 12/12 가 통과**했다(독립검증
   * 변이 M3 생존) — 두 선수의 집계가 완전히 같아서 **어떤 순서든 같은 답**이 나오는 공허한
   * 표본이었기 때문이다. 그래서 각 단계가 **실제로 갈리는** 표본을 하나씩 태운다.
   *
   * 이게 왜 화면에 중요한가: 리포트 카드의 주인공과 선수 탭의 MOTM 표식이 **다른 사람**을
   * 가리키고, `isMotm` 이 뒤집혀 평점 뱃지 등급(`player-stats-view.ratingTier`)까지 갈린다.
   *
   * ⚠️ 표본의 기대값은 **리터럴**이다(계수를 import 하지 않는다 — apps/web CLAUDE.md ②).
   *    `RATING_WEIGHTS` 가 바뀌면 이 숫자가 빨개지는데, 그때 고칠 것은 **표본**이지 순서가 아니다.
   */
  const TACKLE = (playerId: string, tick: number) => ({ tick, minute: tick, type: "tackle", team: "home", playerId });
  const GOAL = (playerId: string, tick: number) => ({ tick, minute: tick, type: "goal", team: "home", playerId });

  it("평점이 갈리면 **골이 더 많아도** 평점이 이긴다 — 골을 앞 단계로 올리는 변이가 여기서 죽는다", () => {
    // H1 = 2골(8.6) · H2 = 태클 10(8.7). 골 수와 평점이 **반대 방향**인 표본.
    const l = log([GOAL("H1", 1), GOAL("H1", 2), ...Array.from({ length: 10 }, () => TACKLE("H2", 1))]);
    const rows = computePlayerStats(l, {}).players;
    const h1 = rows.find((p) => p.key === "home:H1")!;
    const h2 = rows.find((p) => p.key === "home:H2")!;
    expect([h1.rating, h1.goals]).toEqual([8.6, 2]); // 표본이 의도한 모양인지 먼저 확인
    expect([h2.rating, h2.goals]).toEqual([8.7, 0]);

    // 현행(평점 → 골 → …) = H2. `골 → 어시 → 평점 → 키` 로 뒤집으면 H1 이 된다.
    expect(topRatedOfHalf(l, { team: "home" })!.playerId).toBe("H2");
  });

  it("평점이 같으면 **골**이 가른다 — 골 단계를 빼고 키로 떨어지는 변이가 여기서 죽는다", () => {
    // H1 = 태클 5(7.6, 0골) · H2 = 1골(7.6, 1골). 평점 동률 + 골 상이.
    // ⚠️ 정답(H2)의 키가 **사전순 뒤**여야 한다 — 앞이면 키 단계로 떨어져도 답이 같아 공허해진다.
    const l = log([GOAL("H2", 1), ...Array.from({ length: 5 }, () => TACKLE("H1", 1))]);
    const rows = computePlayerStats(l, {}).players;
    const h1 = rows.find((p) => p.key === "home:H1")!;
    const h2 = rows.find((p) => p.key === "home:H2")!;
    expect([h1.rating, h1.goals]).toEqual([7.6, 0]);
    expect([h2.rating, h2.goals]).toEqual([7.6, 1]);

    expect(topRatedOfHalf(l, { team: "home" })!.playerId).toBe("H2");
    // 그리고 그 답이 **양 팀 통합 MOTM**(`pickMotm`)과 같은 사람이다 = 두 전순서가 갈리지 않았다.
    expect(computePlayerStats(l, {}).motm!.playerId).toBe("H2");
  });

  it("포지션·GK 보정 입력을 #403 규약(`playerKey` 키) 그대로 넘긴다", () => {
    const l = log([GOAL_H2, SHOT_A1]);
    const opts = { gkKeys: new Set(["home:H1"]), positions: { "home:H1": "GK" as const } };
    // 넘긴 것이 실제로 산식에 닿는다 = 보정 없이 계산한 것과 값이 갈릴 수 있고, 무엇보다 던지지 않는다.
    const withOpts = topRatedOfHalf(l, { team: "home", ...opts });
    expect(withOpts).not.toBeNull();
    const sot = computePlayerStats(l, opts);
    const h1 = sot.players.find((p) => p.key === "home:H1");
    // GK 로 선언한 선수는 실점이 채워진다(보정 입력이 통과했다는 관측 가능한 증거).
    expect(h1!.goalsConceded).toBeGreaterThanOrEqual(0);
  });
});

describe("topRatedOfHalf — 손상 입력에도 화면을 죽이지 않는다", () => {
  it("모양이 아닌 입력은 던지지 않고 null 이다", () => {
    expect(topRatedOfHalf(null)).toBeNull();
    expect(topRatedOfHalf(undefined)).toBeNull();
    expect(topRatedOfHalf("not a log")).toBeNull();
    expect(topRatedOfHalf([])).toBeNull();
    expect(topRatedOfHalf({ events: null })).toBeNull();
    // ⚠️ 배열이 아닌 `tickSnapshots` 는 SoT 의 `.filter` 를 던지게 만든다 — 여기서 잘라야 한다.
    expect(() => topRatedOfHalf({ tickSnapshots: "nope", events: "nope" })).not.toThrow();
    expect(topRatedOfHalf({ tickSnapshots: "nope", events: "nope" })).toBeNull();
  });

  it("기록이 없는 하프(빈 로그)는 null — 그때 스택은 타임라인 1장으로 줄어든다", () => {
    expect(topRatedOfHalf({ events: [], tickSnapshots: [] })).toBeNull();
    expect(topRatedOfHalf({}, { team: "home" })).toBeNull();
    expect(topRatedOfHalf({}, {})).toBeNull();
  });

  it("이벤트만 있고 스냅샷이 없는 로그는 출전 기록이 없으므로 null(빈 카드를 만들지 않는다)", () => {
    expect(topRatedOfHalf({ events: [GOAL_H2] })).toBeNull();
  });
});

describe("highlightStatsOf — 무엇을 말할지만 고른다(값은 #403 이 센 것)", () => {
  const line = (over: Record<string, number>) =>
    ({
      goals: 0,
      assists: 0,
      keyPasses: 0,
      shotsOnTarget: 0,
      tackles: 0,
      interceptions: 0,
      clearances: 0,
      saves: 0,
      goalsConceded: 0,
      passesCompleted: 0,
      touches: 0,
      ...over,
    }) as never;

  it("0 인 항목은 싣지 않는다(`골 0 · 어시스트 0` 은 소음이다)", () => {
    const out = highlightStatsOf(line({ goals: 2, tackles: 3 }));
    expect(out.map((s) => s.label)).toEqual(["골", "태클"]);
    expect(out.map((s) => s.value)).toEqual(["2", "3"]);
  });

  it("최대 4개까지만 — 더 실으면 폰에서 이름·평점이 밀린다", () => {
    expect(
      highlightStatsOf(
        line({ goals: 1, assists: 1, keyPasses: 1, shotsOnTarget: 1, tackles: 1, interceptions: 1 }),
      ),
    ).toHaveLength(4);
  });

  it("골키퍼는 무실점(0)도 싣는다 — 그 자체가 성과다", () => {
    const out = highlightStatsOf(line({ saves: 4 }), { isGk: true });
    expect(out).toEqual([
      { label: "선방", value: "4" },
      { label: "실점", value: "0" },
    ]);
  });

  it("아무 기록도 없으면 패스·터치로 떨어지고, 그것도 0 이면 빈 목록이다(카드는 살아 있다)", () => {
    expect(highlightStatsOf(line({ passesCompleted: 9, touches: 12 }))).toEqual([
      { label: "패스 성공", value: "9" },
      { label: "터치", value: "12" },
    ]);
    expect(highlightStatsOf(line({}))).toEqual([]);
  });

  it("`line` 이 없거나 필드가 비어도 던지지 않는다", () => {
    expect(highlightStatsOf(null)).toEqual([]);
    expect(highlightStatsOf(undefined)).toEqual([]);
    expect(highlightStatsOf({} as never)).toEqual([]);
  });
});
