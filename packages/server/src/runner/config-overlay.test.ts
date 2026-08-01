import { describe, it, expect } from "vitest";
import type { EngineConfig } from "@hmb/engine";
import { defaultEngineConfig, demoSeed, demoHome, demoAway, demoSelect } from "@hmb/engine";
import { simulate } from "./simulate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  applyOverrides,
  assertAuthorable,
  inertIssues,
  knobPaths,
  OverrideError,
  effectiveConfigHash,
  INERT_KNOBS,
  MAX_HALF_TICKS,
} from "./config-overlay.js";

/** 이 config 로 전반을 돌린 결과의 지문 — "값을 바꿔도 경기가 같은가"의 관측 지점. */
function hashOfHalf(config: EngineConfig): string {
  return simulate(
    { seed: demoSeed, selectData: demoSelect, homeInput: demoHome, awayInput: demoAway, half: 1 },
    config,
  ).lastHash;
}

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

describe("assertAuthorable — 거부 (T-R3, **작성 게이트**)", () => {
  const bad = (overrides: Record<string, number | boolean>): OverrideError => {
    try {
      assertAuthorable(defaultEngineConfig, overrides);
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

/**
 * **B3 — 같은 입력이 재생에서는 매치를 죽이지 않는다.**
 *
 * 위 describe 전부가 <b>작성</b>에서 400 인 값들이다. 그 값이 이미 매치에 박혀 있는 상황
 * (= 작성 당시엔 유효했는데 그 뒤 엔진이 노브를 지웠다)에서 같은 판정을 하면, 엔진 배포 한 번이
 * ①그 오버레이가 박힌 진행 중 매치 전부와 ②원장의 현재 리비전이 그 키를 든 한 <b>이후 생성되는
 * 모든 매치</b>를 h1 에서 죽인다. 노브 삭제는 사고가 아니라 엔진 열차의 정상 활동이다.
 */
describe("#383 B3 — 재생은 적용 못 하는 경로를 **버리고 보고**한다(죽지 않는다)", () => {
  it("엔진이 지운 노브가 박혀 있어도 재생은 성공하고, 버린 사실이 남는다", () => {
    // `ball.settleSpeed` = 엔진 0.26.0 이 실제로 **제거**한 노브(루트 CLAUDE.md 0.26.0 항).
    const { config, dropped, changed } = applyOverrides(defaultEngineConfig, { "ball.settleSpeed": 4 });
    expect(dropped.map((d) => d.path)).toEqual(["ball.settleSpeed"]);
    expect(dropped[0]!.reason).toContain("삭제·개명");
    expect(changed).toEqual([]);
    expect(config).toBe(defaultEngineConfig); // 나머지는 오늘의 기본값 그대로
  });

  it("살아 있는 노브는 버리지 않고 적용한다 — 한 경로가 죽어도 나머지는 산다", () => {
    const { config, changed, dropped } = applyOverrides(defaultEngineConfig, {
      "ball.settleSpeed": 4,
      "contest.shootRange": 22,
    });
    expect(dropped.map((d) => d.path)).toEqual(["ball.settleSpeed"]);
    expect(changed.map((c) => c.path)).toEqual(["contest.shootRange"]);
    expect(config.contest.shootRange).toBe(22);
  });

  it("타입이 바뀐 노브도 같은 처분이다(엔진이 number→boolean 으로 바꾼 경우)", () => {
    const { dropped } = applyOverrides(defaultEngineConfig, { "vision.enabled": 3 });
    expect(dropped.map((d) => d.path)).toEqual(["vision.enabled"]);
  });

  it("정상 경로에서는 `dropped` 가 비어 있다 — 이 필드가 소음이 되면 안 된다", () => {
    expect(applyOverrides(defaultEngineConfig, undefined).dropped).toEqual([]);
    expect(applyOverrides(defaultEngineConfig, { "contest.shootRange": 22 }).dropped).toEqual([]);
  });

  it("**작성은 여전히 거부한다** — 버리기가 작성 게이트를 무르게 하지 않는다", () => {
    expect(() => assertAuthorable(defaultEngineConfig, { "ball.settleSpeed": 4 })).toThrow(OverrideError);
    expect(() => assertAuthorable(defaultEngineConfig, { "vision.enabled": 3 })).toThrow(OverrideError);
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
 *
 * ⚠️ 이 판정은 **작성 게이트 전용**이다(독립검증 B2). 아래 "재생" describe 가 짝이다 — 둘을
 * 같이 읽어야 이 설계가 보인다.
 */
describe("#338 무효 노브는 **새로 작성**할 수 없다", () => {
  it("INERT 노브는 거부되고, 사유가 '왜 무효인지'를 말한다", () => {
    for (const path of INERT_KNOBS) {
      const issues = inertIssues({ [path]: 0.123 });
      expect(issues.length, `${path} 가 통과했다 — 죽은 노브가 '적용됨'으로 보인다`).toBe(1);
      expect(issues.join(" ")).toContain("실행 경로가 없는 노브");
    }
  });

  it("무효가 아닌 노브는 걸리지 않는다 — 게이트가 전부를 막으면 기능이 죽는다", () => {
    expect(inertIssues({ "contest.shootRange": 22 })).toEqual([]);
    expect(inertIssues(undefined)).toEqual([]);
    expect(inertIssues({})).toEqual([]);
  });
});

/**
 * **B2 — 이미 박힌 오버레이의 재생은 무효 여부와 무관하게 성공한다.**
 *
 * 이 계약이 없어서 1차 수습이 무효 판정을 재생 경로(`applyOverrides`)에 넣었다. 그러면 엔진이
 * 노브를 LIVE→INERT 로 옮기는 순간(0.24.0 이 17개를 한 번에 옮긴 **전례**) ①그 오버레이가 박힌
 * 진행 중 매치 전부와 ②원장의 현재 리비전이 그 키를 담고 있는 한 이후 모든 신규 매치가 h1 에서
 * 죽는다 — #241 의 정확한 형태다. 그리고 막아서 얻는 것이 **0** 이다: 값이 무효라 경기는 어차피
 * 동일하고, 신규 작성은 위 describe 의 게이트가 이미 막는다.
 *
 * INERT_KNOBS 를 재생 입력으로 쓰는 것이 곧 "LIVE→INERT 이동" 시나리오다 — 그 노브들은 구
 * 엔진에서 LIVE 였고, 그때 박제된 오버레이가 지금 재생되는 상황이 바로 이것이다.
 */
describe("#383 B2 — 박제된 오버레이의 재생은 작성 게이트에 걸리지 않는다", () => {
  it("`applyOverrides` 는 INERT 노브를 **받아들인다**(재생 경로에 작성 게이트를 두지 않는다)", () => {
    for (const path of INERT_KNOBS) {
      expect(
        () => applyOverrides(defaultEngineConfig, { [path]: 0.123 }),
        `${path} 를 담은 오버레이가 재생에서 거부됐다 — 엔진 업그레이드 한 번이 진행 중 매치를 ` +
          `전부 FAILED 로 민다(#241 재발)`,
      ).not.toThrow();
    }
  });

  it("무효 노브만 담긴 오버레이는 **경기를 바꾸지 않는다** — 막을 이유가 없다는 근거", () => {
    // "무효라서 안전하다"를 주장만 하지 않고 여기서 확인한다. 값이 실제로 경기를 바꾼다면
    // 그건 레지스트리가 틀린 것이고, 그때는 위 계약이 아니라 레지스트리를 고쳐야 한다.
    const { config } = applyOverrides(defaultEngineConfig, { "decisionWeights.shoot": 0.123 });
    expect(config.decisionWeights.shoot).toBe(0.123); // 병합은 된다(값이 들어간다)
    expect(hashOfHalf(config)).toBe(hashOfHalf(defaultEngineConfig)); // 경기는 같다
  });

  it("재생 경로에도 남아야 하는 게이트는 **런타임 비용**뿐이다", () => {
    // assertAffordable 은 자리가 맞다: "지금 이 값을 쓰는 게 좋은가"가 아니라 "이 요청이 러너를
    // 재우는가"라서 시간이 지나도 답이 안 바뀐다. 위 INERT 와 정확히 반대 성질이다.
    const overMinutes = Math.ceil((MAX_HALF_TICKS * 2 * 1000) / 60_000) + 10;
    expect(() => applyOverrides(defaultEngineConfig, { matchMinutes: overMinutes })).toThrow(OverrideError);
  });
});

describe("#338 무효 노브 목록 자체의 위생", () => {

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
      assertAuthorable(defaultEngineConfig, { "chain.mode": 1 });
    } catch (e) {
      err = e as OverrideError;
    }
    expect(err!.issues.join(" ")).toContain("존재하지만 오버레이 대상이 아닙니다");
    expect(err!.issues.join(" ")).not.toContain("없는 경로");
  });

  it("정말 없는 경로에는 '오타입니다'라고 한다", () => {
    let err: OverrideError | undefined;
    try {
      assertAuthorable(defaultEngineConfig, { "contest.nopeNope": 1 });
    } catch (e) {
      err = e as OverrideError;
    }
    expect(err!.issues.join(" ")).toContain("오타");
  });

  it("프로토타입 체인의 이름은 '실재한다'가 아니다 (독립검증 m6)", () => {
    // `in` 으로 판정하면 `contest.constructor` 가 실재로 잡혀 "존재하지만 오버레이 대상이
    // 아닙니다"라는 **틀린 안내**가 나간다 — 운영자는 있지도 않은 노브를 찾아 소스를 뒤진다.
    for (const path of ["contest.constructor", "contest.toString", "chain.hasOwnProperty"]) {
      let err: OverrideError | undefined;
      try {
        assertAuthorable(defaultEngineConfig, { [path]: 1 });
      } catch (e) {
        err = e as OverrideError;
      }
      expect(err!.issues.join(" "), `${path} 가 실재로 판정됐다`).toContain("오타");
    }
  });
});
