import { describe, it, expect } from "vitest";
import { buildTeamInputPrompt } from "./coach.js";
import { makeTeamInputContext } from "../executor/test-fixtures.js";
import { FORMATION_BASE_POSITIONS } from "@hmb/shared";

/**
 * #324 — 슬롯 기준 좌표를 프롬프트가 실제로 전달하는가.
 *
 * <p><b>고치기 전 라이브 실측</b>: 프롬프트가 `- slot3 P077 Raphaël Varane (DF)` 처럼 슬롯 <b>번호만</b>
 * 줬다. 그 번호가 피치 어디인지 정의가 없으니 모델이 좌표 11개를 매번 새로 지어냈고 —
 * <ul>
 *   <li>어웨이 센터백 둘이 <b>완전히 같은 좌표</b>(0.17, 0.5)를 받아 전반의 24.9% 를 1m 안에 붙어 있었다
 *       (대조군 5경기 0.4~1.1%).</li>
 *   <li>유저 인풋 51개 중 보드 좌→우 순서와 y 순서가 맞는 건 4건뿐이었고, FW 행은 ASC 13 / DESC 13 —
 *       같은 덱이라도 <b>생성마다 좌우가 뒤집혔다</b>.</li>
 * </ul>
 *
 * <p>hero 결정(2026-07-31): <b>보드 배치가 기본, 감독 지시가 있으면 그 위에서 오버라이드</b>.
 * 그래서 계약은 "좌표를 준다" + "지시가 없으면 유지하라고 말한다" 두 가지다.
 */
describe("#324 buildTeamInputPrompt — 슬롯 기준 좌표 전달", () => {
  it("로스터 각 줄에 그 슬롯의 기준 좌표가 실린다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    const slots = FORMATION_BASE_POSITIONS["4-3-3"]!;
    // 픽스처 로스터 = H0..H10, slotIndex 0..10.
    for (const [i, s] of slots.entries()) {
      expect(p, `slot${i} 기준 좌표가 프롬프트에 없다`).toContain(`x=${s.x} y=${s.y}`);
    }
  });

  it("좌표는 해당 slot 줄에 붙는다(다른 슬롯 줄에 엉뚱하게 붙지 않는다)", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    const slots = FORMATION_BASE_POSITIONS["4-3-3"]!;
    for (const [i, s] of slots.entries()) {
      const line = p.split("\n").find((l) => l.startsWith(`- slot${i} `));
      expect(line, `slot${i} 로스터 줄`).toBeTruthy();
      expect(line, `slot${i} 줄에 자기 좌표`).toContain(`x=${s.x} y=${s.y}`);
    }
  });

  it("좌표 규약(x=진행방향, y=좌우, 팀 자기 기준)을 프롬프트가 설명한다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).toContain("x=0 자기 골문");
    expect(p).toMatch(/y=0.*왼쪽/);
  });

  it("hero 결정 — 지시가 없으면 기준 좌표를 유지, 지시가 있으면 조정하라고 명시한다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).toMatch(/지시가 없으면.*그대로/);
    expect(p).toMatch(/지시가 있으면|지시에 맞게/);
  });

  it("두 선수에게 같은 좌표를 주지 말라고 못박는다(라이브 결함의 직접 재발 방지)", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).toMatch(/같은 좌표|겹치/);
  });

  it("포메이션이 바뀌면 그 포메이션의 좌표가 실린다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext({ formation: "5-3-2" }));
    const slots = FORMATION_BASE_POSITIONS["5-3-2"]!;
    expect(p).toContain(`x=${slots[3]!.x} y=${slots[3]!.y}`); // 5-3-2 의 CB(0.14,0.5)
    expect(p).not.toContain(`x=${FORMATION_BASE_POSITIONS["4-3-3"]![9]!.x} y=${FORMATION_BASE_POSITIONS["4-3-3"]![9]!.y}`);
  });

  it("모르는 포메이션이어도 좌표를 싣는다(빈손으로 보내지 않는다)", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext({ formation: "3-5-2" }));
    const fallback = FORMATION_BASE_POSITIONS["4-4-2"]!;
    expect(p).toContain(`x=${fallback[0]!.x} y=${fallback[0]!.y}`);
  });
});
