// @vitest-environment node
/**
 * 보상 봉투의 **순수 판정** 계약 (#405 §2.9).
 *
 * 여기서 지키려는 결함은 셋이다:
 *  ① W2b 이전 매치(`rewardBundle: null`)에서 오버레이가 뜨는 회귀 — 그 매치는 곧장 결과 화면이다.
 *  ② 이미 확인한 봉투가 다시 뜨는 것 — 매 진입마다 [확인]을 또 눌러야 한다.
 *  ③ 고른 선택이 뱃지에 영원히 남는 것 — 봉투의 `pendingChoices` 는 **정산 시점 스냅샷**이다.
 */
import { describe, expect, it } from "vitest";
import type { PendingChoice } from "../api/growth";
import {
  bundleChoicesOf,
  currencyEntriesOf,
  growthEntriesOf,
  openChoicesOf,
  rewardBundleOf,
  shouldShowRewardSheet,
  type RewardBundle,
} from "./types";

const choice = (id: string, playerId = "P001"): PendingChoice => ({
  choiceId: id,
  playerId,
  level: 1,
  candidates: [{ stat: "passing", gain: 3.1 }],
});

const bundle = (over: Partial<RewardBundle> = {}): RewardBundle => ({
  bundleId: "B1",
  source: "MATCH",
  sourceRef: "m1",
  acknowledgedAt: null,
  sections: [
    { kind: "CURRENCY", entries: [{ code: "POINT", amount: 500 }] },
    {
      kind: "GROWTH",
      entries: [
        { playerId: "P001", name: "강태산", xpGained: 156, levelBefore: 1, levelAfter: 2, pendingChoices: [choice("c1")] },
        { playerId: "P002", name: "박정우", xpGained: 0, levelBefore: 3, levelAfter: 3, pendingChoices: [] },
      ],
    },
  ],
  ...over,
});

describe("보상 시트를 띄울까 (#405 §2.9)", () => {
  it("확인 전 봉투면 결과 화면보다 먼저 뜬다", () => {
    expect(shouldShowRewardSheet(bundle())).toBe(true);
  });

  it("**W2b 이전 매치(봉투 없음)는 안 뜬다** — 곧장 결과 화면(회귀 금지)", () => {
    expect(shouldShowRewardSheet(null)).toBe(false);
    expect(shouldShowRewardSheet(undefined)).toBe(false);
  });

  it("이미 확인한 봉투는 다시 안 뜬다", () => {
    expect(shouldShowRewardSheet(bundle({ acknowledgedAt: "2026-08-02T10:00:00Z" }))).toBe(false);
  });
});

describe("result 응답에서 봉투 꺼내기", () => {
  it("additive 블록을 그대로 읽는다", () => {
    expect(rewardBundleOf({ matchId: "m1", rewardBundle: bundle() })?.bundleId).toBe("B1");
  });

  it("null·비객체·id 없는 값은 전부 null — 화면이 빈 오버레이를 그리지 않는다", () => {
    expect(rewardBundleOf({ matchId: "m1", rewardBundle: null })).toBeNull();
    expect(rewardBundleOf({ matchId: "m1" })).toBeNull();
    expect(rewardBundleOf({ rewardBundle: "nope" })).toBeNull();
    expect(rewardBundleOf({ rewardBundle: { bundleId: "" } })).toBeNull();
    expect(rewardBundleOf(undefined)).toBeNull();
  });
});

describe("섹션 파싱은 서버 모양을 믿지 않는다", () => {
  it("정상 봉투에서 재화·성장 엔트리를 꺼낸다", () => {
    expect(currencyEntriesOf(bundle())).toEqual([{ code: "POINT", amount: 500 }]);
    expect(growthEntriesOf(bundle()).map((e) => e.playerId)).toEqual(["P001", "P002"]);
  });

  it("entries 가 배열이 아니어도(구 서버·목 `{}`) 던지지 않고 빈 목록", () => {
    const broken = bundle({ sections: [{ kind: "CURRENCY", entries: {} as never }] });
    expect(currencyEntriesOf(broken)).toEqual([]);
    expect(growthEntriesOf(broken)).toEqual([]);
    expect(bundleChoicesOf(broken)).toEqual([]);
  });

  it("모양이 깨진 엔트리는 걸러낸다 — 그 한 줄이 화면 전체를 죽이면 안 된다", () => {
    const broken = bundle({
      sections: [
        { kind: "CURRENCY", entries: [{ code: "POINT", amount: 500 }, { amount: 1 }, { code: "GEM", amount: "x" }] },
        { kind: "GROWTH", entries: [{ name: "이름만" }, { playerId: "P003", name: "정상", xpGained: 1 }] },
      ],
    });
    expect(currencyEntriesOf(broken)).toEqual([{ code: "POINT", amount: 500 }]);
    expect(growthEntriesOf(broken).map((e) => e.playerId)).toEqual(["P003"]);
  });
});

describe("대기 수는 봉투가 아니라 지금 남은 선택권이 정한다", () => {
  it("고른 선택은 봉투에 남아 있어도 대기에서 빠진다", () => {
    const snapshot = [choice("c1"), choice("c2", "P002")];
    expect(openChoicesOf(snapshot, [choice("c2", "P002")]).map((c) => c.choiceId)).toEqual(["c2"]);
  });

  it("아직 조회가 안 왔으면(undefined) 봉투 스냅샷을 그대로 쓴다 — 뱃지가 깜빡이지 않게", () => {
    const snapshot = [choice("c1")];
    expect(openChoicesOf(snapshot, undefined)).toEqual(snapshot);
  });

  it("전부 골랐으면 빈 배열(빈 조회 결과와 미도착을 구분한다)", () => {
    expect(openChoicesOf([choice("c1")], [])).toEqual([]);
  });
});
