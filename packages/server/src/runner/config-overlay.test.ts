import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "@hmb/engine";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  applyOverrides,
  knobPaths,
  OverrideError,
  effectiveConfigHash,
  INERT_KNOBS,
  MAX_HALF_TICKS,
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
    expect(paths.has("contest.xgBase")).toBe(true);
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
    const x = applyOverrides(defaultEngineConfig, { "contest.shootRange": 22, "contest.xgBase": 0.3 });
    const y = applyOverrides(defaultEngineConfig, { "contest.xgBase": 0.3, "contest.shootRange": 22 });
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


/**
 * #338 무효 노브 — **이 기능이 막겠다고 선언한 실패 모드**의 계약(독립검증 B1).
 *
 * 무효 노브를 통과시키면 운영자는 200 · diff · 새 지문 · 원장 리비전까지 "적용됐다"는 신호를
 * 넷이나 받고 경기는 한 비트도 안 바뀐다. 그게 정확히 #338 이다.
 */
describe("#338 무효 노브는 오버레이할 수 없다", () => {
  it("INERT 노브는 거부되고, 사유가 '왜 무효인지'를 말한다", () => {
    for (const path of INERT_KNOBS) {
      let err: OverrideError | undefined;
      try {
        applyOverrides(defaultEngineConfig, { [path]: 0.123 });
      } catch (e) {
        err = e as OverrideError;
      }
      expect(err, `${path} 가 통과했다 — 죽은 노브가 '적용됨'으로 보인다`).toBeInstanceOf(OverrideError);
      expect(err!.issues.join(" ")).toContain("실행 경로가 없는 노브");
    }
  });

  it("설계 문서 §9 런북 예제가 쓰던 `decisionWeights.shoot` 은 **무효**다(문서가 틀렸던 지점)", () => {
    expect(INERT_KNOBS).toContain("decisionWeights.shoot");
  });

  it("무효 노브는 `knobPaths` 에는 있다 — 거부는 목록이 아니라 판정으로 한다", () => {
    // 목록에서 통째로 지우면 "왜 없지?"가 되어 결국 소스를 뒤진다. 있되 못 만지는 게 맞다.
    const paths = knobPaths(defaultEngineConfig);
    for (const path of INERT_KNOBS) {
      expect(paths.has(path), `${path} 가 config 에서 사라졌다면 목록을 갱신해야 한다`).toBe(true);
    }
  });

  it("**엔진 레지스트리와 드리프트하지 않는다** — 엔진 파일을 직접 읽어 집합 대조", () => {
    // 이 복사본은 엔진(QA #25 도메인)을 수정하지 않기 위한 것이다. 엔진이 노브를 살리거나
    // 죽이면 여기서 이름을 짚어 깨져야 한다 — 안 그러면 이 목록이 조용히 낡는다.
    const registry = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "engine",
           "src", "realism", "dead-knobs.test.ts"),
      "utf8",
    );
    const block = registry.slice(registry.indexOf("const INERT: Knob[] = ["), registry.indexOf("const LIVE"));
    const engineInert = [...block.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1] as string);

    expect(engineInert.length, "엔진 INERT 레지스트리를 못 읽었다 — 파싱이 낡았다").toBeGreaterThan(0);
    expect([...INERT_KNOBS].sort()).toEqual([...engineInert].sort());
  });
});

describe("런타임 비용 상한 (독립검증 M2)", () => {
  it("한 하프가 상한 틱을 넘기는 matchMinutes 는 거부된다", () => {
    const overMinutes = Math.ceil((MAX_HALF_TICKS * 2 * 1000) / 60_000) + 10;
    let err: OverrideError | undefined;
    try {
      applyOverrides(defaultEngineConfig, { matchMinutes: overMinutes });
    } catch (e) {
      err = e as OverrideError;
    }
    expect(err, "러너를 분 단위로 재우는 값이 통과했다").toBeInstanceOf(OverrideError);
    expect(err!.issues.join(" ")).toContain("단일 프로세스");
  });

  it("상식적인 실험 범위(기본의 몇 배)는 계속 허용된다 — 상한이 기능을 죽이면 안 된다", () => {
    expect(() => applyOverrides(defaultEngineConfig, { matchMinutes: 180 })).not.toThrow();
  });
});

describe("에러 메시지가 거짓말하지 않는다 (독립검증 M3)", () => {
  it("존재하지만 오버레이 불가한 리프(`chain.mode`)에 '경로가 없다'고 하지 않는다", () => {
    let err: OverrideError | undefined;
    try {
      applyOverrides(defaultEngineConfig, { "chain.mode": 1 });
    } catch (e) {
      err = e as OverrideError;
    }
    expect(err!.issues.join(" ")).toContain("존재하지만 오버레이 대상이 아닙니다");
    expect(err!.issues.join(" ")).not.toContain("없는 경로");
  });

  it("정말 없는 경로에는 '오타입니다'라고 한다", () => {
    let err: OverrideError | undefined;
    try {
      applyOverrides(defaultEngineConfig, { "contest.nopeNope": 1 });
    } catch (e) {
      err = e as OverrideError;
    }
    expect(err!.issues.join(" ")).toContain("오타입니다");
  });
});
