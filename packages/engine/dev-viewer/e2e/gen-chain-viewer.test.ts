import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
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

    // ⚠️ engine@0.24.0 부터 **기본값이 chain** 이다(#279 채택). `defaultEngineConfig` 를 그대로 쓰면
    // 양쪽이 같은 코어가 되어 A/B 가 조용히 무의미해진다 — 대조군은 **명시적으로 weighted**.
    const w = runMatch(SEED, home, away, demoSelect, {
      ...defaultEngineConfig,
      chain: { ...defaultEngineConfig.chain, mode: "weighted" },
    });
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

    // 두 탭이 화면상 구별되지 않으면 hero 가 어느 쪽을 보고 있는지 알 수 없다(실제로 헷갈렸다).
    // 제목·헤더·탭 타이틀에 코어 이름을 박는다(뷰어 로직 무변경, 문자열 치환만).
    const label = (path: string, tag: string, title: string): void => {
      const src = readFileSync(path, "utf8");
      const out = src
        .replace("<title>HMB Engine Debug Viewer</title>", `<title>${title}</title>`)
        .replace("<h1>HMB TIER-B ENGINE · DEBUG VIEWER</h1>", `<h1>${tag}</h1>`);
      writeFileSync(path, out);
    };
    label(vw.outPath, "🅐 이전 코어 (weighted · 즉시점수 가중추첨) — 롤백 경로", "A · 이전 weighted");
    // ⚠️ 버전은 **하드코딩하지 않는다** — 0.24.0 이라고 박아 두었더니 0.29.5 까지 그 표기가 남아
    // hero 가 "버전 24 로 표기되는데 맞냐"고 물었다(라벨은 그때 그대로, 엔진은 다섯 번 범프됐다).
    label(
      vc.outPath,
      `🅑 적용된 코어 (chain · 행동사슬 EV) — ${defaultEngineConfig.version}`,
      `B · 적용 chain (${defaultEngineConfig.version})`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n[#279 A/B viewers] seed ${SEED}\n  weighted ${vw.outPath}  score ${w.finalScore.home}-${w.finalScore.away} events ${vw.events}\n  chain    ${vc.outPath}  score ${c.finalScore.home}-${c.finalScore.away} events ${vc.events}\n`,
    );
    expect(vw.snapshots).toBe(vc.snapshots);
  }, 600_000);
});
