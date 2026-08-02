// @vitest-environment jsdom
/**
 * `ProposeBuilder` 칩의 **이름 사다리 + 축** 계약 (#406 W1c — 4차 독립검증 MAJOR-1).
 *
 * <p>W1b 가 이 칩을 초크포인트로 옮겼는데 <b>계약이 없었다</b> — `p.name` 직독으로 되돌리는 변이가
 * 전 스위트를 통과했다. 스캐너가 못 잡는 이유는 여기 특유다: 이름이 `owned.map((p) => …)` 의
 * <b>콜백 파라미터</b>에서 나온다. 스캐너는 "어느 컬렉션에서 온 원소인지"를 모르므로
 * (머리말 "순회 자체는 조회가 아니다") 걸릴 것이 없다.
 *
 * <h3>이 자리의 축은 short 다</h3>
 * 칩 = `[포지션][이름][등급]` 이 <b>한 줄에 같이 앉는 밀집 UI</b>(`player-names.ts` 머리말의
 * 판단 기준: "이름 옆에 다른 조각이 같이 앉는가"). 오늘은 서버가 `shortName` 을 안 줘서 두 축의
 * 값이 같지만(#411), 스위치가 켜지면 <b>여기만 풀네임으로 남는다</b> — 4차 검증이 지목한
 * 정확한 회귀 시나리오다. 차이가 0인 동안 박아 두는 것이 이 계약의 존재 이유다.
 *
 * <p>작성 규칙: root vitest include 가 `apps/**\/*.test.ts` 라 JSX 대신 createElement.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProposeBuilder } from "./ProposeBuilder";
import { UNKNOWN_PLAYER_NAME } from "../common/player-names";
import type { CatalogPlayer } from "../api/hooks";

afterEach(cleanup);

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

function owned(rows: Array<Record<string, unknown>>): CatalogPlayer[] {
  return rows.map(
    (r) =>
      ({
        position: "FW", grade: "DIA", owned: true, ownedCount: 1, attributes: attrs(80), ...r,
      }) as unknown as CatalogPlayer,
  );
}

function chipText(rows: Array<Record<string, unknown>>, id: string): string {
  render(
    h(ProposeBuilder, { owned: owned(rows), maxPoints: 1000, pending: false, onSubmit: () => {} }),
  );
  return screen.getByTestId(`propose-chip-${id}`).textContent ?? "";
}

describe("ProposeBuilder 칩 이름 (#406 요구 6·7)", () => {
  it("1단 — 손에 든 행의 이름을 쓴다", () => {
    expect(chipText([{ id: "P077", name: "크바라츠헬리아" }], "P077")).toContain("크바라츠헬리아");
  });

  /**
   * ★ 변이 킬 — `playerNameOf(p, "full")` 로 바꾸거나 `p.name` 직독으로 되돌리면 죽는다.
   * (`크바라츠헬리아` 는 `크바라츠` 를 **포함**하므로 부정 단언 쪽이 판정을 한다.)
   */
  it("축은 short — `shortName` 이 실려 오면 짧은 이름을 쓴다 (#411 스위치 후)", () => {
    const text = chipText(
      [{ id: "P077", name: "크바라츠헬리아", shortName: "크바라츠" }],
      "P077",
    );
    expect(text).toContain("크바라츠");
    expect(text, "밀집 UI 에 풀네임이 들어갔다").not.toContain("크바라츠헬리아");
  });

  it("`shortName` 이 없으면 풀네임 폴백 — 칩이 비지 않는다 (오늘 라이브 상태)", () => {
    expect(chipText([{ id: "P077", name: "크바라츠헬리아" }], "P077")).toContain("크바라츠헬리아");
  });

  /**
   * ★ 변이 킬 — 직독으로 되돌리면 칩에 이름 자리가 **통째로 빈다**(포지션·등급만 남아 어느
   * 선수인지 못 고른다). `?? p.id` 로 되돌리면 `P077` 이 뜬다 — 둘 다 여기서 죽는다.
   */
  it("3단 — 이름이 비면 `미상 선수`. **id 도 빈 칸도 아니다**", () => {
    for (const name of ["", "   "]) {
      cleanup();
      const text = chipText([{ id: "P077", name }], "P077");
      expect(text).toContain(UNKNOWN_PLAYER_NAME);
      expect(text).not.toContain("P077");
    }
  });

  it("여러 명이면 각자 자기 이름을 쓴다 — 한 명 표본이 가리는 실수를 막는다", () => {
    render(
      h(ProposeBuilder, {
        owned: owned([
          { id: "P001", name: "레프 야신", shortName: "야신", position: "GK" },
          { id: "P077", name: "크바라츠헬리아", shortName: "크바라츠" },
        ]),
        maxPoints: 0,
        pending: false,
        onSubmit: () => {},
      }),
    );
    expect(screen.getByTestId("propose-chip-P001").textContent).toContain("야신");
    expect(screen.getByTestId("propose-chip-P001").textContent).not.toContain("레프");
    expect(screen.getByTestId("propose-chip-P077").textContent).toContain("크바라츠");
  });
});
