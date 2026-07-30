import { describe, it, expect } from "vitest";
import { FORMATION_ROWS } from "@hmb/shared";
import { SANITY_GATE_CONFIG } from "../packages/server/src/prompt/gates.js";
// @ts-expect-error — 빌드 없이 node 로 도는 plain ESM 도구.
import { ROWS, MIN_SEPARATION } from "./live-input-audit.mjs";

/**
 * #324 — 배포 후 재측정 도구가 **shared 와 같은 자**를 쓰는지.
 *
 * 도구(`live-input-audit.mjs`)는 빌드 없이 `node` 로 돌아야 해서 TS 를 import 할 수 없고, 그래서
 * `FORMATION_ROWS` 와 게이트 임계를 **복제**한다. 복제 자체는 불가피하지만, 락이 없으면 shared 를
 * 바꿨을 때 도구만 조용히 낡아 **틀린 자로 "고쳐졌다"고 재게 된다** — 독립검증이 이 패턴
 * (문서·상수가 실물과 어긋나는 것)을 두 번 지적했다.
 */
describe("#324 재측정 도구 드리프트 락", () => {
  it("도구의 행 구성 == shared FORMATION_ROWS", () => {
    expect(Object.keys(ROWS).sort()).toEqual(Object.keys(FORMATION_ROWS).sort());
    for (const [f, rows] of Object.entries(ROWS as Record<string, number[][]>)) {
      expect(rows.map((r) => [...r]), `${f} 행 구성`).toEqual(FORMATION_ROWS[f]!.map((r) => [...r]));
    }
  });

  it("도구의 겹침 임계 == 게이트 임계 (같은 결함을 같은 자로 잰다)", () => {
    expect(MIN_SEPARATION).toBe(SANITY_GATE_CONFIG.minSpotSeparation);
  });
});
