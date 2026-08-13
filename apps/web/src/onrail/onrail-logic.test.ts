import { describe, expect, it } from "vitest";
import {
  freezesMatch,
  isLockedScreen,
  nextStepId,
  onScreen,
  resolveStepId,
  resolveTarget,
  screenLockedFor,
  shieldFor,
  stepAfterSkip,
  stepById,
  stepPosition,
  targetRefusesInput,
  tutorialCardIdFrom,
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

/**
 * #493 W9 — **수행 가능 전제**. W8-v3 독립 검증 blocker 3건(B2·B6·B3)이 여기 걸린다.
 *
 * 이 절이 지키는 성질은 하나다: **어떤 조합에서도 완주에 닿는다**. 개별 사유의 화면 재현은
 * e2e(`p493-onrail-skip.spec.ts`)가 목으로 본다 — 여기서는 그 판정이 순수하게 옳은지만 본다.
 */
describe("전제가 깨진 스텝은 건너뛴다 (#493 W9)", () => {
  const fakeEl = (attrs: Record<string, string>): Element =>
    ({
      matches: (sel: string) =>
        sel
          .split(",")
          .some((one) => {
            const m = /\[([^\]=]+)(?:=['"]?([^\]'"]*)['"]?)?\]/.exec(one.trim());
            if (!m) return false;
            const [, name, value] = m;
            const actual = attrs[name!];
            if (actual === undefined) return false;
            return value === undefined || actual === value;
          }),
    }) as unknown as Element;

  it("비활성 버튼은 '입력을 거절한다' — 그게 기다림과 건너뜀을 가르는 축이다", () => {
    expect(targetRefusesInput(fakeEl({ disabled: "" }))).toBe(true);
    expect(targetRefusesInput(fakeEl({ "aria-disabled": "true" }))).toBe(true);
  });

  it("멀쩡한 대상·없는 대상은 거절이 아니다 — 없는 것은 나타날 수 있으므로 기다려야 한다", () => {
    expect(targetRefusesInput(fakeEl({}))).toBe(false);
    // ⚠️ `aria-disabled="false"` 를 참으로 읽으면 **정상 버튼 앞에서 스텝이 날아간다**.
    expect(targetRefusesInput(fakeEl({ "aria-disabled": "false" }))).toBe(false);
    expect(targetRefusesInput(null)).toBe(false);
  });

  it("잠긴 화면 판정은 #217 규칙을 **소비**한다 — 회수 가능한 사고 매치는 잠금이 아니다", () => {
    const growth = step({ screen: "/players" });
    const active = (locked: boolean, abandonable: boolean) => ({
      match: { id: "m1", state: "FIRST_HALF" },
      locked,
      abandonable,
    });
    expect(screenLockedFor(growth, active(true, false))).toBe(true);
    // `shouldForceResume` 이 그렇게 정한다: 포기할 수 있으면 유저는 그 화면에 갈 수 있다.
    expect(screenLockedFor(growth, active(true, true))).toBe(false);
    expect(screenLockedFor(growth, active(false, false))).toBe(false);
    expect(screenLockedFor(growth, undefined)).toBe(false);
  });

  it("경기 화면과 완주 카드는 잠기지 않는다 — 잠기면 잠금 그 자체에서 빠져나갈 수 없다", () => {
    expect(isLockedScreen("/players")).toBe(true);
    expect(isLockedScreen("/recruit")).toBe(true);
    expect(isLockedScreen("/match")).toBe(false);
    expect(isLockedScreen(ANY_SCREEN)).toBe(false);
    expect(screenLockedFor(step({ screen: ANY_SCREEN }), { match: { id: "m", state: "X" }, locked: true, abandonable: false })).toBe(false);
  });

  it("비활성은 **그 스텝만** 넘긴다 — 나머지 S2 는 그 유저도 할 수 있다", () => {
    expect(stepAfterSkip("deck-auto", "target-disabled")).toBe("deck-player");
    expect(stepAfterSkip("trade-rush", "target-disabled")).toBe("trade-accept");
  });

  it("잠긴 화면은 **연속한 잠긴 스텝 전체**를 넘긴다 — 같은 잠금이 그것들을 다 막고 있다", () => {
    // S5(5) + S6(3) 이 전부 잠긴 라우트라 한 번에 완주로 간다. 스텝마다 유예를 다시 기다리면
    // 유저는 안내 없는 화면에서 8번의 침묵을 겪는다.
    expect(stepAfterSkip("growth-open", "screen-locked")).toBe("finish");
    expect(stepAfterSkip("trade-start", "screen-locked")).toBe("finish");
  });

  it("⚠️ 어떤 스텝·어떤 사유에서 건너뛰어도 **완주에 닿는다** — 이것이 W9 의 AC 다", () => {
    for (const s of ONRAIL_SCRIPT) {
      for (const reason of ["target-missing", "target-disabled", "screen-locked"] as const) {
        // 앞으로만 가므로 유한하다. 끝까지 밀어 보고 마지막이 완주인지 확인한다.
        let cur: string | null = s.id;
        let hops = 0;
        let last: string = s.id;
        while (cur && hops < ONRAIL_SCRIPT.length + 1) {
          last = cur;
          cur = stepAfterSkip(cur, reason);
          hops += 1;
        }
        expect(hops, `${s.id}/${reason} 가 각본 길이를 넘겨 돈다 = 루프`).toBeLessThanOrEqual(
          ONRAIL_SCRIPT.length,
        );
        expect(last, `${s.id}/${reason} 의 마지막 착지가 완주가 아니다`).toBe(
          ONRAIL_SCRIPT[ONRAIL_SCRIPT.length - 1]!.id,
        );
      }
    }
  });

  it("완주 스텝에는 건너뛸 다음이 없다(= 여기서 끝난다)", () => {
    expect(stepAfterSkip(ONRAIL_SCRIPT[ONRAIL_SCRIPT.length - 1]!.id, "target-missing")).toBeNull();
  });

  it("모르는 스텝은 아무 데로도 보내지 않는다 — 각본이 개편되면 `resolveStepId` 가 처음으로 되돌린다", () => {
    expect(stepAfterSkip("이런-스텝-없음", "target-missing")).toBeNull();
  });
});

describe("S5 대상 카드 — 서버가 말해 준 값이 먼저다 (#493 W9)", () => {
  it("`/api/config` 가 알려 주면 그 값을 쓴다(추론 결과와 달라도)", () => {
    expect(tutorialCardIdFrom("P122", [{ playerId: "P999" }])).toBe("P122");
  });

  it("⚠️ 필드를 모르는 서버에서는 종전 추론으로 내려간다 — 배포 순서상 그 창이 항상 있다", () => {
    expect(tutorialCardIdFrom(undefined, [{ playerId: "P999" }])).toBe("P999");
    expect(tutorialCardIdFrom(null, [{ playerId: "P999" }])).toBe("P999");
    // 빈 문자열은 "알려 줬다"가 아니다 — 그걸 겨누면 영영 없는 셀렉터가 된다.
    expect(tutorialCardIdFrom("", [{ playerId: "P999" }])).toBe("P999");
  });

  it("둘 다 없으면 null — 각본의 `fallbackTestId`(그리드)로 착지한다", () => {
    expect(tutorialCardIdFrom(null, [])).toBeNull();
    expect(tutorialCardIdFrom(null, undefined)).toBeNull();
    // 응답 형태를 믿지 않는다(#245·#251) — 배열이 아니면 없는 것으로 읽는다.
    expect(tutorialCardIdFrom(null, {} as never)).toBeNull();
  });
});
