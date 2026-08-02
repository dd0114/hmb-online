/**
 * 분포 하네스의 **캐시 지문** 계약 (#403 W1d, 통합 검증 minor-5).
 *
 * ⚠️ 지문이 덮지 못하는 축이 하나 있으면 하네스는 **낡은 표본을 조용히 재사용**하고, hero 는
 * 틀린 근거로 계수를 조정한다. 이 에픽에서 죽은 하네스로 네 번 사고가 났고, 마지막 구멍이
 * **"엔진 코드를 고쳤는데 `config.version` 을 안 올린 경우"** 였다(튜닝 웨이브의 정상 상태다).
 *
 * 그래서 여기서 재는 것은 값이 아니라 **무엇을 세는가**다 — 계수와 무관하므로 hero 의 조정에
 * 반응하지 않는다.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ENGINE_SRC_DIR, engineSourceFiles, fingerprintOf, hashSources } from "./rating-distribution";

const tmps: string[] = [];
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "hmb-fp-"));
  tmps.push(dir);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "config.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "sub", "deck.json"), '{"x":1}\n');
  writeFileSync(join(dir, "sub", "thing.test.ts"), "it('x', () => {});\n");
  return dir;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("엔진 소스 지문", () => {
  it("실제 엔진 소스를 센다 — 시뮬 경로의 파일들이 목록에 있다", () => {
    const files = engineSourceFiles(ENGINE_SRC_DIR).map((f) => f.slice(ENGINE_SRC_DIR.length));
    for (const must of ["/match.ts", "/config.ts", "/fixtures.ts"]) {
      expect(files, `${must} 이 지문 대상에 없다`).toContain(must);
    }
    // 실덱 입력(JSON)도 표본을 만드는 재료다.
    expect(files.some((f) => f.startsWith("/realism/real-decks/") && f.endsWith(".json"))).toBe(true);
    // 테스트 파일은 표본에 영향이 없다 — 넣으면 스윕마다 헛되이 재시뮬한다.
    expect(files.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  it("같은 트리는 같은 지문(결정론) · 내용이 바뀌면 다른 지문", () => {
    const a = tree();
    expect(hashSources(a)).toBe(hashSources(a));
    const before = hashSources(a);
    writeFileSync(join(a, "config.ts"), "export const a = 2;\n"); // 버전은 그대로, 코드만 바뀐 상황
    expect(hashSources(a), "엔진 코드를 고쳤는데 지문이 그대로면 낡은 캐시를 쓴다").not.toBe(before);
  });

  it("파일이 사라지거나 이름만 바뀌어도 다른 지문(경로까지 해시한다)", () => {
    const a = tree();
    const before = hashSources(a);
    renameSync(join(a, "sub", "deck.json"), join(a, "sub", "deck-2.json"));
    expect(hashSources(a), "이름만 바뀐 것을 못 잡으면 실덱 교체가 지문을 안 움직인다").not.toBe(before);

    const b = tree();
    const b0 = hashSources(b);
    rmSync(join(b, "sub", "deck.json"));
    expect(hashSources(b)).not.toBe(b0);
  });

  /**
   * ⚠️ **해시를 만드는 것과 그걸 지문에 섞는 것은 다른 축이다** — 섞는 줄을 지워도 위 계약은
   * 전부 green 이다. 그래서 지문 쪽에서 한 번 더 건다(주입 인자 = 이 계약 전용 이음매).
   */
  it("캐시 지문이 엔진 소스 해시를 실제로 물고 있다", () => {
    expect(fingerprintOf("fixture", ["1"], "engine-A")).not.toBe(fingerprintOf("fixture", ["1"], "engine-B"));
    // 기본 인자가 **진짜 엔진 트리**의 해시다(딴 값을 물고 있으면 여기서 갈린다).
    expect(fingerprintOf("fixture", ["1"])).toBe(fingerprintOf("fixture", ["1"], hashSources(ENGINE_SRC_DIR)));
    // 모드·시드도 여전히 지문의 일부다(구 축을 지우지 않았다).
    expect(fingerprintOf("fixture", ["1"])).not.toBe(fingerprintOf("real-decks", ["1"]));
    expect(fingerprintOf("fixture", ["1"])).not.toBe(fingerprintOf("fixture", ["2"]));
  });

  it("테스트 파일만 바뀌면 지문은 그대로다(불필요한 재시뮬을 만들지 않는다)", () => {
    const a = tree();
    const before = hashSources(a);
    writeFileSync(join(a, "sub", "thing.test.ts"), "it('y', () => {});\n");
    expect(hashSources(a)).toBe(before);
  });
});
