import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMatch } from "../../src/match";
import { defaultEngineConfig } from "../../src/config";
import { demoSelect, makeTacticalInput } from "../../src/fixtures";
import { buildTestViewer } from "./build-test-viewer.mjs";

/**
 * #279 W2 — **같은 시드로 두 코어를 나란히** 재생할 뷰어 2개를 만든다(env 가드).
 * 실행: HMB_CHAIN_VIEW=1 npx vitest run packages/engine/dev-viewer/e2e/gen-chain-viewer.test.ts
 *   → viewer-weighted.html(현행) · viewer-chain.html(사슬 탐색 코어)
 * 나머지 config·시드가 동일하므로 화면 차이는 **전적으로 볼 소유자 결정**에서 온다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SEED = "1000000031"; // fixture-real 과 같은 시드(희귀 이벤트 포함)
const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_CHAIN_VIEW;

describe("#279 W2 chain A/B viewers", () => {
  it.skipIf(!GEN)("builds weighted vs chain viewers on the same seed", () => {
    const home = makeTacticalInput("H", SEED);
    const away = makeTacticalInput("A", SEED);

    const w = runMatch(SEED, home, away, demoSelect, defaultEngineConfig);
    const c = runMatch(SEED, home, away, demoSelect, {
      ...defaultEngineConfig,
      chain: { ...defaultEngineConfig.chain, mode: "chain" },
    });

    const wPath = join(here, "log-weighted.json");
    const cPath = join(here, "log-chain.json");
    writeFileSync(wPath, JSON.stringify(w));
    writeFileSync(cPath, JSON.stringify(c));
    const vw = buildTestViewer(wPath, "viewer-weighted.html");
    const vc = buildTestViewer(cPath, "viewer-chain.html");
    // eslint-disable-next-line no-console
    console.log(
      `\n[#279 A/B viewers] seed ${SEED}\n  weighted ${vw.outPath}  score ${w.finalScore.home}-${w.finalScore.away} events ${vw.events}\n  chain    ${vc.outPath}  score ${c.finalScore.home}-${c.finalScore.away} events ${vc.events}\n`,
    );
    expect(vw.snapshots).toBe(vc.snapshots);
  }, 600_000);
});
