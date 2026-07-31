import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

import { TIER, TIER_ENV, atLeastTier, parseTier, T0_EXCLUDED, PARTIAL_GATED, t0ExcludedFiles } from "./tier";

/**
 * 티어 커버리지 손실 가드 — **항상 돈다**(어느 티어에서도 스킵되지 않는다).
 *
 * 이 구조의 유일한 실패 모드는 **T0 제외 목록이 조용히 자라는 것**이다. 무거워서 뺐다가 잊으면
 * 그 검증은 사실상 사라지고, `npm run test:t0` 만 도는 사람에게는 green 으로 보인다.
 * `gate.ts`(#371)가 사다리에 세운 것과 같은 규율을 티어에도 건다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

describe("티어 레지스트리 (#376 / #377 M0-3)", () => {
  it("등록이 비어 있지 않다", () => {
    expect(T0_EXCLUDED.length).toBeGreaterThan(0);
    expect(PARTIAL_GATED.length).toBeGreaterThan(0);
  });

  it("등록된 경로가 전부 실재한다", () => {
    for (const e of [...T0_EXCLUDED, ...PARTIAL_GATED]) {
      expect(existsSync(join(REPO, e.file)), `없는 파일이 등록됨: ${e.file}`).toBe(true);
    }
  });

  it("근거 없이 목록에 오르지 못한다(what·issue·seconds 필수)", () => {
    for (const e of [...T0_EXCLUDED, ...PARTIAL_GATED]) {
      expect(e.what.length, `${e.file}: what 없음`).toBeGreaterThan(10);
      expect(e.issue.length, `${e.file}: issue 없음`).toBeGreaterThan(1);
      expect(e.seconds, `${e.file}: seconds 없음`).toBeGreaterThan(0);
    }
  });

  it("중복 등록이 없다", () => {
    const files = [...T0_EXCLUDED, ...PARTIAL_GATED].map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
  });

  /** T0 제외가 무한정 자라지 않게 — 예산의 근거가 되는 총량을 눈에 보이게 못 박는다. */
  it(`T0 제외가 무한정 자라지 않는다 (현재 ${T0_EXCLUDED.length}건 · 등록 ${T0_EXCLUDED.reduce((s, e) => s + e.seconds, 0)}s)`, () => {
    expect(T0_EXCLUDED.length, "제외 목록이 12개를 넘으면 '싸게 만들기'가 아니라 '검증 빼기'다").toBeLessThanOrEqual(12);
  });

  it("부분 게이트 파일은 실제로 atLeastTier 를 쓴다", () => {
    for (const e of PARTIAL_GATED) {
      const text = readFileSync(join(REPO, e.file), "utf8");
      expect(text, `${e.file}: atLeastTier 미사용 — 등록만 되고 게이트가 없다`).toMatch(/atLeastTier\s*\(/);
      expect(text).toMatch(/from\s+["'][^"']*tier["']/);
    }
  });

  /**
   * 고아 검출 — 티어 토큰을 쓰는데 등록되지 않은 파일이 있으면 목록이 진실이 아니다.
   *
   * ⚠️ **vitest 가 수집하는 범위 전체를 재귀로** 훑는다. 처음엔 `packages/engine/src` 두 디렉토리의
   * 직속 파일만 봤는데, 독립검증이 `dev-viewer/` 에 미등록 게이트를 심자 가드가 **green 인 채로**
   * 통과했다. 스캔 범위가 테스트 이름의 주장보다 좁으면 그게 곧 거짓 green 이다.
   */
  it("atLeastTier 를 쓰는 테스트 파일이 전부 등록돼 있다 (수집 범위 전체 재귀)", () => {
    const registered = new Set(PARTIAL_GATED.map((e) => e.file));
    // vitest.config include 와 같은 뿌리들.
    const roots = ["packages", "apps", "data", "tools"].map((d) => join(REPO, d));
    const found: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "dist" || e.name === "__snapshots__") continue;
          walk(join(dir, e.name));
          continue;
        }
        if (!e.name.endsWith(".test.ts")) continue;
        if (e.name === "tier.test.ts") continue; // 가드 자신 — 티어를 검사하려면 당연히 참조한다.
        const abs = join(dir, e.name);
        if (!/atLeastTier\s*\(/.test(readFileSync(abs, "utf8"))) continue;
        const rel = relative(REPO, abs);
        if (!registered.has(rel)) found.push(rel);
      }
    };
    for (const r of roots) walk(r);
    expect(found, `PARTIAL_GATED 에 없는 게이트 사용: ${found.join(", ")}`).toEqual([]);
  });

  it("vitest.config.ts 가 정확히 이 목록만 T0 에서 제외한다", () => {
    const cfg = readFileSync(join(REPO, "vitest.config.ts"), "utf8");
    // 하드코딩된 사본이 아니라 레지스트리를 소비해야 한다(두 곳이 갈라지면 가드가 무의미해진다).
    expect(cfg).toMatch(/t0ExcludedFiles\s*\(\s*\)/);
    expect(cfg).toMatch(/TIER\s*===\s*0/);
  });

  it("티어 해석이 옳다(기본 T1, 범위 밖은 T1)", () => {
    expect(parseTier(undefined)).toBe(1);
    expect(parseTier("")).toBe(1);
    expect(parseTier("0")).toBe(0);
    expect(parseTier("2")).toBe(2);
    expect(parseTier("9")).toBe(1);
    expect(parseTier("abc")).toBe(1);
    expect(TIER).toBeGreaterThanOrEqual(0);
    expect(TIER).toBeLessThanOrEqual(2);
    expect(atLeastTier(TIER)).toBe(true);
    expect(atLeastTier(TIER + 1)).toBe(false);
  });

  /**
   * env 이름 오타 검출 — 해석이 옳아도 **아무도 그 이름으로 넘기지 않으면** 티어는 영원히
   * 기본값이다. `gate.test.ts` 가 `HMB_LADDER` 에 세운 것과 같은 가드.
   */
  it("npm 스크립트가 실제로 그 env 이름을 넘긴다", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:t0"], "test:t0 없음").toContain(`${TIER_ENV}=0`);
    expect(pkg.scripts["test:t1"]).toContain(`${TIER_ENV}=1`);
    expect(pkg.scripts["test:t2"]).toContain(`${TIER_ENV}=2`);
    // T2 는 사다리도 함께 켠다(별개 축을 릴리스에서 합쳐 돈다).
    expect(pkg.scripts["test:t2"]).toContain("HMB_LADDER=1");
    // `npm test` 는 T1 이어야 한다 — 기본이 조용히 줄어들면 그게 새 거짓 green 구멍이다.
    expect(pkg.scripts["test"]).toContain("test:t1");
    /**
     * ⚠️ 사다리도 **티어를 고정해야 한다.** 안 하면 주위 환경의 `HMB_TIER=0` 이 그대로 먹혀
     * `shot-frequency.test.ts`(=사다리 본체, #338 의 죽은 노브를 잡은 그 스위트)가 exclude 된다.
     * 실측: `HMB_TIER=0 npm run test:ladder` = 25파일/95테스트 vs 고정 시 32파일/147테스트.
     * "사다리를 돌렸다"고 믿는 채로 사다리가 빠지는 것이 정확히 이 게이트가 막아야 할 사고다.
     */
    expect(pkg.scripts["test:ladder"], "사다리가 티어를 고정하지 않는다").toMatch(/HMB_TIER=[12]/);
    expect(pkg.scripts["test:ladder"]).toContain("HMB_LADDER=1");
  });

  /** 무거운 실행이 게이트를 통과하도록 배선돼 있는가(#376 동시성 상한). */
  it("무거운 스크립트가 run-gate 를 거친다", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const s of ["test:t0", "test:t1", "test:t2", "test:ladder", "e2e"]) {
      expect(pkg.scripts[s], `${s} 가 run-gate 를 안 거친다`).toContain("run-gate.mjs");
    }
    expect(pkg.scripts["e2e"], "playwright 는 배타여야 한다").toContain("--exclusive");
  });

  it("t0ExcludedFiles() 가 등록 목록과 일치한다", () => {
    expect(t0ExcludedFiles()).toEqual(T0_EXCLUDED.map((e) => e.file));
  });
});
