import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "@hmb/engine";
import {
  applyOverrides,
  knobPaths,
  OverrideError,
  effectiveConfigHash,
} from "./config-overlay.js";

/**
 * #383 W1 — 계수 오버레이의 **경로/타입/거부** 계약 (T-R3 + knobs 목록).
 *
 * 이 파일이 지키는 한 문장: **오타는 조용히 죽지 않는다.** 중첩 deep-merge 였다면
 * `contest.shootXgThreshhold` 같은 오타가 200 으로 삼켜지고 아무 일도 안 일어난다 —
 * 이 리포가 세 번 빠진 함정(#321·#337·#338)의 정확한 형태다.
 */

describe("knobPaths — 오버레이 가능한 리프 전수", () => {
  it("수치 리프를 점경로로 뽑는다(중첩 포함)", () => {
    const paths = knobPaths(defaultEngineConfig);
    expect(paths.has("contest.shootRange")).toBe(true);
    expect(paths.has("decisionWeights.shoot")).toBe(true);
    expect(paths.get("contest.shootRange")).toEqual({
      value: defaultEngineConfig.contest.shootRange,
      type: "number",
    });
  });

  it("boolean 리프도 포함한다", () => {
    const paths = knobPaths(defaultEngineConfig);
    expect(paths.get("vision.enabled")).toEqual({ value: defaultEngineConfig.vision.enabled, type: "boolean" });
  });

  it("구조 경로는 **목록에 아예 없다**(거부 이전에 존재하지 않는다)", () => {
    const paths = knobPaths(defaultEngineConfig);
    for (const denied of ["version", "msPerTick", "fixedScale", "coordMode", "gridSize"]) {
      expect(paths.has(denied)).toBe(false);
    }
    for (const p of paths.keys()) {
      expect(p.startsWith("pitch.")).toBe(false);
      expect(p.startsWith("formations.")).toBe(false);
    }
  });

  it("문자열·배열 리프는 오버레이 대상이 아니다", () => {
    const paths = knobPaths(defaultEngineConfig);
    for (const { type } of paths.values()) {
      expect(["number", "boolean"]).toContain(type);
    }
  });

  it("비어 있지 않다 — 실제로 만질 계수가 있다는 사실 자체를 박는다", () => {
    expect(knobPaths(defaultEngineConfig).size).toBeGreaterThan(100);
  });
});

describe("applyOverrides — 거부 (T-R3)", () => {
  const bad = (overrides: Record<string, number | boolean>): OverrideError => {
    try {
      applyOverrides(defaultEngineConfig, overrides);
    } catch (e) {
      return e as OverrideError;
    }
    throw new Error("expected OverrideError, got success");
  };

  it("미지 경로 = 거부 (오타가 조용히 죽지 않는다)", () => {
    const e = bad({ "contest.shootXgThreshhold": 0.07 });
    expect(e).toBeInstanceOf(OverrideError);
    expect(e.issues.join(" ")).toContain("contest.shootXgThreshhold");
  });

  it("타입 불일치 = 거부 (number 자리에 boolean)", () => {
    expect(bad({ "contest.shootRange": true }).issues.join(" ")).toMatch(/shootRange/);
  });

  it("구조 경로 = 거부", () => {
    for (const path of ["version", "fixedScale", "msPerTick", "coordMode", "pitch.width", "formations.4-3-3"]) {
      expect(bad({ [path]: 1 }).issues.join(" ")).toContain(path);
    }
  });

  it("비유한수 = 거부 (NaN·Infinity 는 고정소수 변환을 통째로 오염시킨다)", () => {
    expect(bad({ "contest.shootRange": Number.NaN }).issues.length).toBeGreaterThan(0);
    expect(bad({ "contest.shootRange": Number.POSITIVE_INFINITY }).issues.length).toBeGreaterThan(0);
  });

  it("여러 문제를 **한 번에** 돌려준다(왕복 줄이기 — 운영자가 curl 로 쓴다)", () => {
    const e = bad({ "nope.one": 1, "also.missing": 2 });
    expect(e.issues.length).toBe(2);
  });

  it("중간 객체 경로(리프 아님) = 거부", () => {
    expect(bad({ contest: 1 }).issues.join(" ")).toContain("contest");
  });
});

describe("applyOverrides — 적용", () => {
  it("빈/미지정 오버레이는 **base 를 그대로**(동일 객체) 돌려준다 = 오늘과 bit-identical", () => {
    expect(applyOverrides(defaultEngineConfig, undefined).config).toBe(defaultEngineConfig);
    expect(applyOverrides(defaultEngineConfig, {}).config).toBe(defaultEngineConfig);
    expect(applyOverrides(defaultEngineConfig, {}).changed).toEqual([]);
  });

  it("지정한 경로만 바뀌고 나머지는 보존된다 (객체 통째 교체 사고 방지)", () => {
    const { config, changed } = applyOverrides(defaultEngineConfig, { "contest.shootRange": 22 });
    expect(config.contest.shootRange).toBe(22);
    expect(config.contest.xgBase).toBe(defaultEngineConfig.contest.xgBase);
    expect(config.version).toBe(defaultEngineConfig.version);
    expect(changed).toEqual([
      { path: "contest.shootRange", from: defaultEngineConfig.contest.shootRange, to: 22 },
    ]);
  });

  it("base 를 변형하지 않는다(순수) — 러너는 요청마다 같은 상수를 재사용한다", () => {
    const before = defaultEngineConfig.contest.shootRange;
    applyOverrides(defaultEngineConfig, { "contest.shootRange": 22 });
    expect(defaultEngineConfig.contest.shootRange).toBe(before);
  });

  it("같은 값으로 덮어써도 changed 는 비어 있다(= 무의미한 리비전 식별)", () => {
    const { changed } = applyOverrides(defaultEngineConfig, {
      "contest.shootRange": defaultEngineConfig.contest.shootRange,
    });
    expect(changed).toEqual([]);
  });
});

describe("effectiveConfigHash — 유효 config 지문", () => {
  it("같은 유효 config → 같은 해시, 다르면 다른 해시", () => {
    const a = applyOverrides(defaultEngineConfig, { "contest.shootRange": 22 });
    const b = applyOverrides(defaultEngineConfig, { "contest.shootRange": 22 });
    const c = applyOverrides(defaultEngineConfig, { "contest.shootRange": 23 });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("키 순서에 의존하지 않는다(정본 직렬화)", () => {
    const x = applyOverrides(defaultEngineConfig, { "contest.shootRange": 22, "decisionWeights.shoot": 0.3 });
    const y = applyOverrides(defaultEngineConfig, { "decisionWeights.shoot": 0.3, "contest.shootRange": 22 });
    expect(x.hash).toBe(y.hash);
  });

  it("오버레이가 아니라 **유효 config 전체**의 해시다 — 기본값이 바뀌면 값도 바뀐다", () => {
    const shifted = { ...defaultEngineConfig, contest: { ...defaultEngineConfig.contest, xgBase: 0.99 } };
    expect(effectiveConfigHash(shifted)).not.toBe(effectiveConfigHash(defaultEngineConfig));
  });

  it("무오버레이 해시 = 기본 config 해시", () => {
    expect(applyOverrides(defaultEngineConfig, undefined).hash).toBe(effectiveConfigHash(defaultEngineConfig));
  });
});
