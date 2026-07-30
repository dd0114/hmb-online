import { describe, it, expect } from "vitest";
import { FORMATION_BASE_POSITIONS } from "@hmb/shared";
import { defaultEngineConfig } from "@hmb/engine";

/**
 * 드리프트 락 (#324) — shared 의 4-3-3 슬롯 좌표는 <b>엔진 config.formations["4-3-3"] 과 같은 값</b>이어야 한다.
 *
 * <p>이 표는 새로 만든 규약이 아니라 <b>이미 엔진에 있던 규약</b>을 AI 프롬프트가 읽을 수 있는 자리로
 * 올린 것이다(#324 의 결함 = 그 규약이 프롬프트에만 안 전달된 것). 두 벌이 된 이상 조용히 갈라질 수
 * 있으므로 여기서 묶는다 — `packages/server` 는 engine 과 shared 를 <b>둘 다 정당하게</b> import 하는
 * 유일한 자리다(의존 방향: web → server → engine, 모두 → shared).
 *
 * <p>엔진 좌표가 바뀌면 이 테스트가 깨진다. 그때 할 일은 shared 표를 엔진에 맞추는 것이다
 * (반대가 아니다 — 배치 기하의 SoT 는 엔진이다).
 */
describe("#324 슬롯 좌표 드리프트 락", () => {
  it("shared 4-3-3 ≡ 엔진 config.formations['4-3-3']", () => {
    const engine = defaultEngineConfig.formations["4-3-3"];
    expect(engine, "엔진이 4-3-3 을 싣고 있어야").toBeDefined();
    expect(FORMATION_BASE_POSITIONS["4-3-3"]).toEqual(engine);
  });

  it("엔진이 싣는 모든 포메이션을 shared 가 같은 값으로 덮는다", () => {
    for (const [name, slots] of Object.entries(defaultEngineConfig.formations)) {
      expect(FORMATION_BASE_POSITIONS[name], `shared 에 ${name} 누락`).toEqual(slots);
    }
  });
});
