import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { demoSeed, demoHome, demoAway, demoSelect } from "../fixtures";
import {
  applyConfigOverrides,
  ConfigOverrideError,
  listConfigLeaves,
  TUNING_KNOBS,
} from "./config-override";

/**
 * config 주입 계약(#377 M0-1 AC1). 하네스가 "리빌드 0" 으로 계수를 바꿀 때
 * ①정말 바뀌고 ②base 를 오염시키지 않고 ③오타가 조용히 넘어가지 않는지.
 */

describe("applyConfigOverrides", () => {
  it("점 경로로 값을 바꾼다", () => {
    const out = applyConfigOverrides(defaultEngineConfig, { "chain.goalValue": 12.5 });
    expect(out.chain.goalValue).toBe(12.5);
  });

  it("중첩 부분객체로도 바꾼다", () => {
    const out = applyConfigOverrides(defaultEngineConfig, { chain: { goalValue: 12.5 } });
    expect(out.chain.goalValue).toBe(12.5);
  });

  it("base 를 오염시키지 않는다(깊은 복사)", () => {
    const before = defaultEngineConfig.chain.goalValue;
    const out = applyConfigOverrides(defaultEngineConfig, { "chain.goalValue": before + 3 });
    expect(defaultEngineConfig.chain.goalValue).toBe(before);
    expect(out.chain.goalValue).toBe(before + 3);
    // 손대지 않은 가지도 base 와 같은 객체를 공유하지 않는다.
    expect(out.contest).not.toBe(defaultEngineConfig.contest);
  });

  it("빈 오버라이드는 기본 config 와 동작이 같다(하네스 기준선 경로)", () => {
    const cloned = applyConfigOverrides(defaultEngineConfig, {});
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
    const b = runMatch(demoSeed, demoHome, demoAway, demoSelect, cloned);
    expect(b.tickSnapshots.at(-1)?.hash).toBe(a.tickSnapshots.at(-1)?.hash);
  });

  it("오버라이드가 실제로 경기를 바꾼다(변이체 킬)", () => {
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
    const bumped = applyConfigOverrides(defaultEngineConfig, {
      "chain.goalValue": defaultEngineConfig.chain.goalValue * 2,
    });
    const b = runMatch(demoSeed, demoHome, demoAway, demoSelect, bumped);
    expect(b.tickSnapshots.at(-1)?.hash).not.toBe(a.tickSnapshots.at(-1)?.hash);
  });

  it("같은 오버라이드는 항상 같은 경기다(결정론 유지)", () => {
    const ov = { "chain.goalValue": 11, "rules.foul.base": 0.02 };
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect, applyConfigOverrides(defaultEngineConfig, ov));
    const b = runMatch(demoSeed, demoHome, demoAway, demoSelect, applyConfigOverrides(defaultEngineConfig, ov));
    expect(b.tickSnapshots.at(-1)?.hash).toBe(a.tickSnapshots.at(-1)?.hash);
  });

  // ── 오타를 조용히 삼키지 않는다 ────────────────────────────────
  it("없는 경로는 던진다", () => {
    expect(() => applyConfigOverrides(defaultEngineConfig, { "chain.goalvalue": 9 })).toThrow(ConfigOverrideError);
    expect(() => applyConfigOverrides(defaultEngineConfig, { "nope.deep.path": 1 })).toThrow(ConfigOverrideError);
    expect(() => applyConfigOverrides(defaultEngineConfig, { chain: { nope: 1 } })).toThrow(ConfigOverrideError);
  });

  it("리프 타입이 바뀌면 던진다", () => {
    expect(() => applyConfigOverrides(defaultEngineConfig, { "chain.goalValue": "9" })).toThrow(ConfigOverrideError);
  });

  it("객체 경로를 스칼라로 덮어쓰려 하면 던진다", () => {
    expect(() => applyConfigOverrides(defaultEngineConfig, { chain: 1 })).toThrow(ConfigOverrideError);
  });
});

describe("listConfigLeaves", () => {
  const leaves = listConfigLeaves(defaultEngineConfig);

  it("스칼라 리프를 점 경로로 편다", () => {
    const paths = new Set(leaves.map((l) => l.path));
    expect(paths.has("chain.goalValue")).toBe(true);
    expect(paths.has("version")).toBe(true);
    expect(leaves.length).toBeGreaterThan(100);
  });

  it("모든 리프가 실제로 쓰기 가능하다(경로 유효성 왕복 검증)", () => {
    for (const leaf of leaves) {
      expect(() => applyConfigOverrides(defaultEngineConfig, { [leaf.path]: leaf.value })).not.toThrow();
    }
  });

  it("배열 안으로는 내려가지 않는다(포메이션 좌표는 계수가 아니다)", () => {
    expect(leaves.some((l) => l.path.startsWith("formations."))).toBe(false);
  });
});

describe("TUNING_KNOBS", () => {
  it("모든 노브 경로가 현재 config 에 존재한다", () => {
    const paths = new Set(listConfigLeaves(defaultEngineConfig).map((l) => l.path));
    const missing = TUNING_KNOBS.filter((k) => !paths.has(k.path)).map((k) => k.path);
    expect(missing, `TUNING_KNOBS 에 죽은 경로: ${missing.join(", ")}`).toEqual([]);
  });
});
