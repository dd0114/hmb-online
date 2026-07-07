import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 결정론 위생: 엔진 소스(src)에 비결정 API 문자열이 0건이어야 한다.
 * Math.random / Date.now / new Date 금지.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BANNED = ["Math.random", "Date.now", "new Date"];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__snapshots__" || entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe("determinism hygiene (AC4)", () => {
  const files = collectSourceFiles(SRC_DIR);

  it("scans a non-empty set of engine source files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const banned of BANNED) {
    it(`has zero occurrences of "${banned}"`, () => {
      const hits: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, "utf8");
        if (text.includes(banned)) hits.push(f);
      }
      expect(hits, `"${banned}" found in: ${hits.join(", ")}`).toEqual([]);
    });
  }
});
