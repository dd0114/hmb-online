import { describe, expect, it } from "vitest";
import {
  freezesMatch,
  nextStepId,
  onScreen,
  resolveStepId,
  resolveTarget,
  shieldFor,
  stepById,
  stepPosition,
} from "./onrail-logic";
import { ANY_SCREEN, ONRAIL_FIRST_STEP, ONRAIL_SCRIPT } from "./onrail-script";
import type { OnRailStep } from "./onrail-script";

/**
 * #493 W7-v3 — 온레일 판정 계약.
 *
 * 여기서 지키는 것은 **각본이 실행 가능한 모양인가**와 **온레일이 유저를 가두지 않는가** 둘이다.
 * 오버레이 그림은 e2e(`p493-onrail.spec.ts`)가 실화면에서 본다.
 */

const step = (over: Partial<OnRailStep> = {}): OnRailStep => ({
  id: "x",
  screen: "/deck",
  title: "t",
  body: "b",
  advance: { kind: "next" },
  ...over,
});

describe("각본 자체의 성립 조건", () => {
  it("스텝 id 가 유일하다 — 중복이면 `nextStepId` 가 앞의 것으로 되감아 무한 루프가 된다", () => {
    const ids = ONRAIL_SCRIPT.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("행동형 스텝은 대상을 반드시 겨눈다 — 대상 없는 전면 안내로는 '직접 해보세요'를 할 수 없다", () => {
    for (const s of ONRAIL_SCRIPT) {
      if (s.advance.kind !== "action") continue;
      expect(s.targetTestId, `${s.id} 는 행동형인데 대상이 없다`).toBeTruthy();
    }
  });

  it("마지막 스텝은 cta 다 — 각본의 끝이 [다음]이면 유저가 완주 처리를 못 받고 멈춘다", () => {
    const last = ONRAIL_SCRIPT[ONRAIL_SCRIPT.length - 1]!;
    expect(last.advance.kind).toBe("cta");
  });

  it("치환 토큰을 쓰는 스텝에는 폴백이 있다 — 서버가 그 값을 안 줄 때 착지할 곳이 필요하다", () => {
    for (const s of ONRAIL_SCRIPT) {
      if (!s.targetTestId?.includes("{")) continue;
      expect(s.fallbackTestId, `${s.id} 는 치환 토큰을 쓰는데 폴백이 없다`).toBeTruthy();
    }
  });

  it("경기 화면 투어는 전부 skipIfMissing 이다 — 여기서 막히면 유저가 경기를 못 본다", () => {
    const tour = ONRAIL_SCRIPT.filter((s) => s.freezeMatch);
    expect(tour.length).toBeGreaterThan(0);
    for (const s of tour) expect(s.skipIfMissing, `${s.id}`).toBe(true);
  });

  it("승급이 강화보다 앞에 온다 — 서버가 2★ 미만의 강화를 POTENTIAL_LOCKED 로 거절한다", () => {
    const ids = ONRAIL_SCRIPT.map((s) => s.id);
    expect(ids.indexOf("growth-promote")).toBeGreaterThan(-1);
    expect(ids.indexOf("growth-enhance")).toBeGreaterThan(ids.indexOf("growth-promote"));
  });
});

describe("스텝 이동", () => {
  it("마지막 스텝의 다음은 null(= 완주)", () => {
    const last = ONRAIL_SCRIPT[ONRAIL_SCRIPT.length - 1]!;
    expect(nextStepId(last.id)).toBeNull();
  });

  it("모르는 id 의 다음은 첫 스텝 — 각본 개편으로 저장값이 낡아도 진행이 멈추지 않는다", () => {
    expect(nextStepId("사라진-스텝")).toBe(ONRAIL_FIRST_STEP);
    expect(resolveStepId("사라진-스텝")).toBe(ONRAIL_FIRST_STEP);
    expect(stepById("사라진-스텝")).toBeNull();
  });

  it("진행 표시는 1-based", () => {
    expect(stepPosition(ONRAIL_FIRST_STEP)).toEqual({ index: 1, total: ONRAIL_SCRIPT.length });
  });
});

describe("화면 판정", () => {
  it("매치는 접두 일치 — 매치 id 가 붙는다", () => {
    expect(onScreen(step({ screen: "/match" }), "/match/m1")).toBe(true);
    expect(onScreen(step({ screen: "/match" }), "/matches")).toBe(false);
  });

  it("쿼리는 보지 않는다 — /recruit?tab=trade 는 같은 화면이다", () => {
    // pathname 만 넘어오므로 쿼리는 애초에 판정에 닿지 않는다.
    expect(onScreen(step({ screen: "/recruit" }), "/recruit")).toBe(true);
  });

  it("ANY_SCREEN 은 어디서나 참", () => {
    expect(onScreen(step({ screen: ANY_SCREEN }), "/anywhere")).toBe(true);
  });

  it("얼리는 것은 그 화면에 있을 때뿐 — 덱 화면에서 경기를 얼릴 이유가 없다", () => {
    const tour = step({ screen: "/match", freezeMatch: true });
    expect(freezesMatch(tour, "/match/m1")).toBe(true);
    expect(freezesMatch(tour, "/deck")).toBe(false);
    expect(freezesMatch(step({ screen: "/match" }), "/match/m1")).toBe(false);
  });
});

describe("대상 치환", () => {
  it("런타임 값이 있으면 채운다", () => {
    const s = step({ targetTestId: "token-{deckPlayerId}", fallbackTestId: "tactics-board" });
    expect(resolveTarget(s, { deckPlayerId: "P007" })).toBe("token-P007");
  });

  it("⚠️ 값이 없으면 폴백 — 토큰이 남은 셀렉터를 그대로 돌려주면 영영 안 맞아 조용히 멈춘다", () => {
    const s = step({ targetTestId: "token-{deckPlayerId}", fallbackTestId: "tactics-board" });
    expect(resolveTarget(s, {})).toBe("tactics-board");
    expect(resolveTarget(s, { deckPlayerId: null })).toBe("tactics-board");
  });

  it("대상이 없는 스텝은 null(전면 안내)", () => {
    expect(resolveTarget(step({ targetTestId: undefined }), {})).toBeNull();
  });
});

describe("남의 다이얼로그 앞에서의 처신", () => {
  const el = (contains: boolean) => ({ contains: () => contains }) as unknown as Element;
  const target = {} as Element;

  it("다이얼로그가 없으면 막는다", () => {
    expect(shieldFor(target, [])).toBe("block");
  });

  it("대상을 품은 모달이면 안내만 얹는다 — 성장 상세(모달) 안에서 온레일이 사라지면 안 된다", () => {
    expect(shieldFor(target, [el(true)])).toBe("guide-only");
  });

  it("⚠️ 대상 밖 확인창이면 비켜난다 — 안 그러면 말풍선이 그 버튼을 덮는다", () => {
    expect(shieldFor(target, [el(false)])).toBe("hidden");
    // 성장 상세(품음) + 잠재 재설정 확인창(안 품음)이 겹친 상태 = 확인창이 주인공이다.
    expect(shieldFor(target, [el(true), el(false)])).toBe("hidden");
  });

  it("대상이 없는 전면 안내는 어떤 다이얼로그에도 양보한다", () => {
    expect(shieldFor(null, [el(true)])).toBe("hidden");
  });
});
