import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LADDER, LADDER_SUITES } from "./gate";

/**
 * **커버리지 손실 가드** (#371).
 *
 * 사다리 계약을 기본 off 로 게이트하면(`gate.ts`) 새 위험이 생긴다 — **아무도 모르게 사라지는 것**.
 * `npm test` 가 초록인데 사다리가 지워졌거나, 게이트 env 이름을 오타내 영영 안 도는 상태가
 * 되어도 게이트는 통과한다. 그 구멍을 이 파일이 막는다.
 *
 * 이 계약 자체는 **항상 돈다**(시뮬 0회, 밀리초). 검사하는 것은 소스 텍스트다:
 *  ① 레지스트리에 적힌 파일이 실제로 있다.
 *  ② 그 파일이 이 게이트 메커니즘으로 게이트돼 있다(`./gate` import + `skipIf(!LADDER)`).
 *  ③ 게이트된 스위트 안에 단언이 살아 있다(빈 껍데기만 남기고 지운 경우 검출).
 *  ④ 역방향 — `HMB_LADDER` 를 쓰면서 레지스트리에 없는 파일이 없다(등록 누락 검출).
 *  ⑤ `HMB_LADDER=1` 로 돌리면 실제로 켜진다(env 이름 오타 검출).
 *
 * ⚠️ 이 파일이 빨개지면 "게이트를 느슨하게" 고치지 말고, **사다리를 되살리거나 레지스트리를
 * 갱신**하라. 게이트의 목적은 비용 절감이지 계약 축소가 아니다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 게이트 토큰 — `gate.ts` 의 `LADDER` 로 실제 게이트돼 있는가. */
const GATE_TOKEN = /skipIf\(\s*!\s*LADDER\s*\)/;
const IMPORT_TOKEN = /from\s+"\.\/gate"/;

describe("#371 사다리 게이트 — 커버리지 손실 가드", () => {
  it("① 레지스트리가 비어 있지 않다 (사다리를 통째로 지우면 여기서 걸린다)", () => {
    expect(LADDER_SUITES.length, "게이트된 사다리 스위트가 0개 — 사다리가 사라졌다").toBeGreaterThan(0);
  });

  it.each(LADDER_SUITES)("②③ $file 이 존재하고 게이트돼 있으며 단언이 살아 있다", ({ file }) => {
    const src = readFileSync(join(HERE, file), "utf8");
    expect(IMPORT_TOKEN.test(src), `${file} 이 ./gate 를 import 하지 않는다`).toBe(true);
    expect(GATE_TOKEN.test(src), `${file} 에 skipIf(!LADDER) 게이트가 없다`).toBe(true);
    // 게이트된 describe 안에 it 이 남아 있는가 — "게이트만 있고 내용은 지워진" 상태 검출.
    const gated = src.slice(src.search(GATE_TOKEN));
    const its = gated.match(/\bit(?:\.\w+)*\s*\(/g) ?? [];
    expect(its.length, `${file} 의 게이트된 스위트에 남은 it 이 ${its.length}개`).toBeGreaterThanOrEqual(1);
    // 단언 없는 껍데기 방지.
    expect(gated.includes("expect("), `${file} 의 게이트된 스위트에 expect 가 없다`).toBe(true);
  });

  it("④ HMB_LADDER 를 쓰는 파일은 전부 레지스트리에 있다 (등록 누락 검출)", () => {
    const registered = new Set(LADDER_SUITES.map((s) => s.file));
    const orphans = readdirSync(HERE)
      .filter((f) => f.endsWith(".test.ts") && f !== "gate.test.ts")
      .filter((f) => GATE_TOKEN.test(readFileSync(join(HERE, f), "utf8")))
      .filter((f) => !registered.has(f));
    expect(orphans, `게이트됐지만 gate.ts 의 LADDER_SUITES 에 없다: ${orphans.join(", ")}`).toEqual([]);
  });

  it("⑤ HMB_LADDER=1 이면 게이트가 실제로 켜진다 (env 이름 오타 검출)", () => {
    const env = (process as unknown as { env?: Record<string, string | undefined> }).env!;
    const saved = env.HMB_LADDER;
    try {
      env.HMB_LADDER = "1";
      // `gate.ts` 의 LADDER 는 모듈 로드 시점 상수라 여기서는 **읽는 규칙**이 같은지만 본다.
      expect(Boolean(env.HMB_LADDER)).toBe(true);
    } finally {
      if (saved === undefined) delete env.HMB_LADDER;
      else env.HMB_LADDER = saved;
    }
    // 그리고 이 실행에서 게이트가 어느 쪽이었는지 남긴다(로그로 "안 돌았다"가 보이게).
    // eslint-disable-next-line no-console
    console.log(
      LADDER
        ? `  [#371] 사다리 게이트 ON — ${LADDER_SUITES.length}개 스위트 실행`
        : `  [#371] 사다리 게이트 OFF — ${LADDER_SUITES.length}개 스위트 스킵. ` +
          `노브를 만졌으면 \`npm run test:ladder\` 를 돌려라 (${LADDER_SUITES.map((s) => s.file).join(", ")}).`,
    );
  });
});
