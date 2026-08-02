import { describe, expect, it } from "vitest";
import {
  claimableSummary,
  missionClaimLabel,
  missionClaimable,
  missionDayLabel,
  missionStateLabel,
  missionTierLabel,
  normalizeMatchMissions,
  pickDailyMissions,
  progressRatio,
  rerollBlockReason,
  resetNoticeText,
  type DailyMission,
} from "./mission-logic";

/**
 * 원정 데일리 미션 — **유닛 계약** (#408).
 *
 * 여기서 죽여야 하는 변이는 하나로 요약된다: **클라가 서버 값을 재계산하는 것**.
 * 티어→금액 · 달성 여부 · 리롤 가능 여부는 전부 서버 config 라, 클라가 규칙을 복제하면
 * 노브를 돌린 순간 화면이 서버가 하지 않는 일을 단언한다(#262·#368 이 같은 실수를 했다).
 *
 * ⚠️ **규칙 하나당 표본 하나**(#286 W5 BL-1) — 축이 다른 규칙을 한 픽스처에 겹치면 앞 분기가
 * 뒤를 덮어 계약이 공허하게 통과한다.
 */

const base: DailyMission = {
  id: "M1",
  missionId: "away_streak_2",
  title: "원정 2연승",
  tier: "NORMAL",
  currency: "GEM",
  amount: 200,
  progress: 1,
  target: 2,
  state: "IN_PROGRESS",
  rerollable: true,
};
const m = (over: Partial<DailyMission>): DailyMission => ({ ...base, ...over });

const payload = (missions: unknown[], over: Record<string, unknown> = {}) => ({
  day: "2026-08-02",
  resetAtKst: "2026-08-03T00:00:00+09:00",
  missions,
  pendingClaims: [],
  claimableCount: 0,
  claimableAmount: 0,
  ...over,
});

/** 지난 날짜 달성·미수령 한 건. `progress`/`target`/`rerollable` 이 **없다**(끝난 미션이라). */
const pending = (over: Record<string, unknown> = {}) => ({
  id: "P1",
  day: "2026-08-01",
  missionId: "away_win_2",
  title: "원정에서 2승",
  tier: "NORMAL",
  currency: "GEM",
  amount: 200,
  ...over,
});

describe("pickDailyMissions — 응답 형태를 믿지 않는다", () => {
  it("정상 응답에서 미션을 그대로 꺼낸다 — 금액·목표는 서버 값 그대로", () => {
    // ⚠️ 픽스처 금액을 발행값(보통=200)과 **일부러 다르게** 둔다. 같게 두면 클라가 티어→금액을
    // 재계산해도 관측값이 같아서 그 변이체가 살아남는다(server 웨이브에서 실제로 그랬다).
    const view = pickDailyMissions(payload([{ ...base, tier: "EASY", amount: 777, target: 5 }]));
    expect(view?.missions).toHaveLength(1);
    expect(view?.missions[0]?.amount).toBe(777);
    expect(view?.missions[0]?.target).toBe(5);
    expect(view?.resetAtKst).toBe("2026-08-03T00:00:00+09:00");
  });

  it("구 서버(미션 블록 부재)는 **null** — 호출부가 섹션을 통째로 안 그린다", () => {
    expect(pickDailyMissions(undefined)).toBeNull();
    expect(pickDailyMissions({})).toBeNull();
    // 프록시·목의 200 `{}` 와 같은 부류들. 하나라도 던지면 원정 화면이 흰 화면이 된다.
    expect(pickDailyMissions([])).toBeNull();
    expect(pickDailyMissions("nope")).toBeNull();
    expect(pickDailyMissions({ missions: "nope" })).toBeNull();
  });

  it("`missions: []` 이고 받을 것도 없으면 null — 빈 껍데기를 띄우지 않는다", () => {
    expect(pickDailyMissions(payload([]))).toBeNull();
  });

  it("⚠️ **오늘 미션이 없어도 받을 보상이 남았으면 그린다** — 롤백 스위치가 지갑을 뺏으면 안 된다", () => {
    // 설계 §9: 끄기(`daily.count: 0`)는 새 미션을 안 만들 뿐 **이미 달성한 미수령분은 그대로
    // 받을 수 있다**. 여기서 null 을 돌려주면 그 보상이 화면에서 도달 불가능해진다 = W3 이 잡은
    // 그 버그가 롤백 경로에서 되살아난다.
    const view = pickDailyMissions(payload([], { pendingClaims: [pending()], claimableCount: 1 }));
    expect(view?.missions).toEqual([]);
    expect(view?.pendingClaims).toHaveLength(1);
  });

  it("깨진 항목은 떨어뜨리고 나머지는 산다 — 배열 하나가 화면을 죽이지 않는다", () => {
    const view = pickDailyMissions(payload([null, { title: "id 없는 미션" }, base, 42]));
    expect(view?.missions.map((x) => x.id)).toEqual(["M1"]);
  });

  it("숫자가 아닌 필드는 0 으로 떨어진다(문자열 금액·NaN 목표)", () => {
    const view = pickDailyMissions(
      payload([{ ...base, amount: "200", progress: null, target: undefined }]),
    );
    expect(view?.missions[0]).toMatchObject({ amount: 0, progress: 0, target: 0 });
  });

  it("`rerollable` 은 **엄격히 true 일 때만** 참 — truthy 문자열로 문이 열리지 않는다", () => {
    const view = pickDailyMissions(payload([{ ...base, rerollable: "yes" }]));
    expect(view?.missions[0]?.rerollable).toBe(false);
  });
});

describe("pendingClaims — 지난 날짜 달성·미수령 (#408 갭1)", () => {
  it("서버가 준 항목을 그대로 꺼낸다 — 순서도 서버 것(오래된 것부터)", () => {
    const view = pickDailyMissions(
      payload([base], {
        pendingClaims: [pending({ id: "P1", day: "2026-07-31" }), pending({ id: "P2", day: "2026-08-01", amount: 999 })],
      }),
    );
    expect(view?.pendingClaims.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(view?.pendingClaims[1]?.amount).toBe(999);
  });

  it("배열이 아니거나 없으면 빈 배열 — 구 서버가 이 키를 안 준다", () => {
    expect(pickDailyMissions(payload([base]))?.pendingClaims).toEqual([]);
    expect(pickDailyMissions(payload([base], { pendingClaims: "nope" }))?.pendingClaims).toEqual([]);
    // 키 자체가 없는 구 서버(6b38674 이전)
    const legacy = { day: "d", resetAtKst: "", missions: [base], claimableCount: 0, claimableAmount: 0 };
    expect(pickDailyMissions(legacy)?.pendingClaims).toEqual([]);
  });

  it("깨진 항목은 떨어뜨린다(id 없으면 받을 키가 없다)", () => {
    const view = pickDailyMissions(payload([base], { pendingClaims: [null, { title: "id 없음" }, pending(), 7] }));
    expect(view?.pendingClaims.map((p) => p.id)).toEqual(["P1"]);
  });

  it("숫자가 아닌 금액은 0 으로 떨어진다", () => {
    const view = pickDailyMissions(payload([base], { pendingClaims: [pending({ amount: "많이" })] }));
    expect(view?.pendingClaims[0]?.amount).toBe(0);
  });
});

describe("missionDayLabel — 지난 보상이 **언제 것인지** 말한다", () => {
  it("yyyy-MM-dd 를 그대로 읽는다(타임존 환산 없음)", () => {
    expect(missionDayLabel("2026-08-01")).toBe("8월 1일");
    expect(missionDayLabel("2026-12-25")).toBe("12월 25일");
  });

  it("못 읽으면 null — 문구를 지어내지 않는다", () => {
    expect(missionDayLabel("")).toBeNull();
    expect(missionDayLabel("어제")).toBeNull();
  });
});

describe("missionClaimable — 달성 판정은 서버 것이다", () => {
  it("`state === COMPLETED` 면 받을 수 있다", () => {
    expect(missionClaimable(m({ state: "COMPLETED" }))).toBe(true);
  });

  it("⚠️ **진행도가 목표에 닿아도** 서버가 IN_PROGRESS 면 받을 수 없다", () => {
    // 이 표본이 `progress >= target` 재계산 변이체를 죽인다. 달성은 경기 정산이 판정하고
    // (`completed_at`), 진행도가 먼저 닿아 보이는 창이 실재한다.
    expect(missionClaimable(m({ progress: 2, target: 2, state: "IN_PROGRESS" }))).toBe(false);
  });

  it("⚠️ **진행도가 목표에 못 미쳐도** 서버가 COMPLETED 면 받을 수 있다", () => {
    // 반대 방향 표본. 한쪽만 두면 "state 를 보되 progress 도 같이 본다"는 변이체가 산다.
    expect(missionClaimable(m({ progress: 0, target: 3, state: "COMPLETED" }))).toBe(true);
  });

  it("이미 받았으면 못 받고, 버튼이 그렇게 말한다", () => {
    const claimed = m({ state: "CLAIMED" });
    expect(missionClaimable(claimed)).toBe(false);
    expect(missionClaimLabel(claimed)).toBe("수령 완료");
    expect(missionClaimLabel(m({ state: "COMPLETED" }))).toBe("받기");
  });

  it("모르는 상태는 받을 수 없다 — 추측해서 문을 열지 않는다", () => {
    expect(missionClaimable(m({ state: "WHATEVER" }))).toBe(false);
  });
});

describe("rerollBlockReason — 리롤 가능 여부는 서버 판단", () => {
  it("`rerollable` 이면 잠기지 않는다 — **상태가 COMPLETED 여도** 서버를 따른다", () => {
    // 서버 규칙은 "달성한 미션은 리롤 불가"지만, 그 판정은 서버가 한다. 클라가 상태로 다시
    // 잠그면 규칙이 바뀔 때(예: 달성분 리롤 허용) 화면만 조용히 낡는다.
    expect(rerollBlockReason(m({ rerollable: true, state: "COMPLETED" }))).toBeNull();
  });

  it("⚠️ `rerollable:false` 면 **상태가 IN_PROGRESS 여도** 잠긴다 — 1회 소진", () => {
    expect(rerollBlockReason(m({ rerollable: false, state: "IN_PROGRESS" }))).toBe(
      "다시 뽑기를 이미 썼습니다",
    );
  });

  it("잠긴 이유는 상태에 따라 다른 말을 한다 — 유저가 다음 행동을 고른다", () => {
    expect(rerollBlockReason(m({ rerollable: false, state: "COMPLETED" }))).toBe(
      "달성한 미션은 다시 뽑을 수 없습니다",
    );
  });
});

describe("라벨 — 모르는 값은 칠하지 않는다", () => {
  it("티어 3종", () => {
    expect(missionTierLabel("EASY")).toBe("쉬움");
    expect(missionTierLabel("NORMAL")).toBe("보통");
    expect(missionTierLabel("HARD")).toBe("어려움");
  });

  it("모르는 티어·상태는 null(배지를 그리지 않는다)", () => {
    expect(missionTierLabel("LEGENDARY")).toBeNull();
    expect(missionTierLabel("")).toBeNull();
    expect(missionStateLabel("PENDING")).toBeNull();
  });
});

describe("progressRatio — 표시 전용 클램프", () => {
  it("0~1 로 자른다", () => {
    expect(progressRatio({ progress: 1, target: 2 })).toBe(0.5);
    expect(progressRatio({ progress: 9, target: 2 })).toBe(1);
    expect(progressRatio({ progress: -3, target: 2 })).toBe(0);
  });

  it("목표가 0 이어도 나눗셈이 터지지 않는다", () => {
    expect(progressRatio({ progress: 1, target: 0 })).toBe(0);
  });
});

describe("resetNoticeText — 서버 벽시계를 그대로 읽는다", () => {
  it("KST 오프셋이 붙은 값의 시:분을 **환산하지 않고** 쓴다", () => {
    // ⚠️ `new Date(...)` 로 파싱하면 브라우저 타임존으로 환산돼 KST 밖에서 00:00 이 아닌 값이 뜬다.
    expect(resetNoticeText("2026-08-03T00:00:00+09:00")).toBe("8월 3일 00:00 초기화");
  });

  it("못 읽으면 null — 문구를 지어내지 않는다", () => {
    expect(resetNoticeText("")).toBeNull();
    expect(resetNoticeText("내일")).toBeNull();
  });
});

describe("claimableSummary — 홈 한 줄", () => {
  it("서버가 준 건수·금액을 그대로 쓴다(지난 날짜 미수령분 포함)", () => {
    // ⚠️ `missions` 배열을 세어 만들면 안 된다 — 어제 못 받은 것이 화면에서 사라진다.
    const raw = payload([base], { claimableCount: 3, claimableAmount: 600 });
    expect(claimableSummary(raw)).toEqual({ count: 3, amount: 600 });
  });

  it("미션 배열이 비어도 미수령분은 살아 있다 — 두 축은 별개다", () => {
    expect(claimableSummary(payload([], { claimableCount: 1, claimableAmount: 100 })).count).toBe(1);
  });

  it("구 서버·손상 응답이면 0(홈 한 줄이 안 뜬다)", () => {
    expect(claimableSummary(undefined)).toEqual({ count: 0, amount: 0 });
    expect(claimableSummary({})).toEqual({ count: 0, amount: 0 });
    expect(claimableSummary([])).toEqual({ count: 0, amount: 0 });
    expect(claimableSummary({ claimableCount: "3" })).toEqual({ count: 0, amount: 0 });
  });
});

describe("normalizeMatchMissions — 결과 화면", () => {
  it("`completedNow` 는 서버가 준 사실이다 — progress/target 으로 파생하지 않는다", () => {
    // 이 표본이 "progress>=target 이면 이번에 달성"이라는 변이체를 죽인다. 이전 경기에서 이미
    // 달성돼 있던 미션도 배열에 실려 온다(진행만 오른 것과 구분해야 한다).
    const rows = normalizeMatchMissions([
      { ...base, progress: 2, target: 2, completedNow: false },
      { ...base, id: "M2", progress: 1, target: 3, completedNow: true },
    ]);
    expect(rows.map((r) => r.completedNow)).toEqual([false, true]);
  });

  it("배열이 아니면 빈 배열 — 결과 화면이 죽지 않는다", () => {
    expect(normalizeMatchMissions(undefined)).toEqual([]);
    expect(normalizeMatchMissions({})).toEqual([]);
    expect(normalizeMatchMissions("x")).toEqual([]);
  });

  it("`state` 를 보존한다 — 결과 화면의 [받기] 문이 이 값 하나다 (#408 갭2)", () => {
    const rows = normalizeMatchMissions([{ ...base, state: "CLAIMED" }]);
    expect(rows[0]?.state).toBe("CLAIMED");
  });

  it("`state` 가 없는 구 서버 응답은 빈 문자열 — 문이 **닫힌 쪽**으로 떨어진다", () => {
    // 없는 값을 COMPLETED 로 추측하면 이미 받은 보상에 [받기]가 다시 뜬다. fail-closed.
    const { state: _drop, ...noState } = { ...base, state: "COMPLETED" };
    const rows = normalizeMatchMissions([noState]);
    expect(rows[0]?.state).toBe("");
    expect(missionClaimable(rows[0]!)).toBe(false);
  });

  it("⚠️ **양방향** — 진행도가 닿아도 CLAIMED 면 못 받고, 못 닿아도 COMPLETED 면 받는다", () => {
    // 한쪽만 두면 "state 도 보되 progress 도 본다"는 변이가 산다(지난 웨이브와 같은 함정).
    // 특히 `2/2 + CLAIMED` 가 **수령 후에도 버튼이 남는** 결함을 죽이는 표본이다.
    const rows = normalizeMatchMissions([
      { ...base, id: "C", progress: 2, target: 2, state: "CLAIMED" },
      { ...base, id: "D", progress: 0, target: 3, state: "COMPLETED" },
    ]);
    expect(missionClaimable(rows[0]!)).toBe(false);
    expect(missionClaimable(rows[1]!)).toBe(true);
  });

  it("깨진 항목은 떨어뜨린다", () => {
    expect(normalizeMatchMissions([null, {}, base])).toHaveLength(1);
  });
});
