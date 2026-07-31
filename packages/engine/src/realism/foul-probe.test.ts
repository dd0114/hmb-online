import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { GUARD_SEEDS } from "./harness";
import { collectFoul, renderFoul } from "./foul";
import { legacy0270 } from "./rollback";

/**
 * #358 — **파울 붕괴 층별 분해 진단**(env 가드). `npm test` 에서는 skip.
 * 실행: `HMB_FOUL=1 npx vitest run packages/engine/src/realism/foul-probe.test.ts`
 *
 * 리포트 전용(동작 변경 0). 판정 계약은 `shot-frequency.test.ts`(밴드)와
 * `foul-opportunity.test.ts`(관계식)가 한다.
 *
 * ## 왜 2×2 인가
 * 파울 이력은 12.63(0.23.0) → 6.43(0.24.0 **사슬 채택**) → 5.88 → 1.95(**hold 압박** #353) → 2.15.
 * **절반이 사슬 채택에서, 나머지가 hold 압박에서** 났다 = 층이 둘이다. 두 축을 factorial 로 갈라야
 * 각 층의 몫이 나온다:
 *   축1 = 코어(`chain.mode`: chain ↔ weighted)
 *   축2 = 압박·가치 노브(현행 ↔ `legacy0270()` = #353/#357 이전)
 * `legacy0270` 은 `hold-pressure.test.ts` 의 롤백 config 를 **재사용**한다(재발명 금지 — 그 파일이
 * 0.27.0 해시 비트동일을 계약으로 박아 둔 바로 그 config 다).
 *
 * ⚠️ **못 되돌리는 것**: 0.26.0 의 공 물리(속도 벡터·lofted 착지)와 0.25.0 세트피스는 **코드**라
 * config 로 롤백되지 않는다. 그래서 `weighted + legacy0270` 은 "0.23.0" 이 아니라
 * **"현재 코드에서 사슬·압박 축만 끈 것"** 이다. 층의 크기는 이 대조에서 읽되, 절대값을
 * 0.23.0 실측(12.63)과 직접 등치하지 않는다.
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_FOUL;
const SEEDS = GUARD_SEEDS;

function withMode(cfg: EngineConfig, mode: "chain" | "weighted"): EngineConfig {
  return { ...cfg, chain: { ...cfg.chain, mode } };
}

describe("#358 파울 붕괴 분해", () => {
  it.skipIf(!GEN)("2×2: 코어(chain/weighted) × 압박노브(현행/legacy0270) — 60시드", () => {
    const cells: Array<[string, EngineConfig]> = [
      ["A 현재 (chain + 현행노브 = 0.28.0)", defaultEngineConfig],
      ["B chain + legacy0270 노브 (≈0.27.0)", legacy0270()],
      ["C weighted + 현행노브", withMode(defaultEngineConfig, "weighted")],
      ["D weighted + legacy0270 노브 (사슬·압박 둘 다 off)", withMode(legacy0270(), "weighted")],
    ];
    const out: string[] = [];
    for (const [label, cfg] of cells) {
      const r = collectFoul(cfg, SEEDS);
      out.push(renderFoul(label, r));
      expect(r.matches).toBe(SEEDS.length);
    }
    // eslint-disable-next-line no-console
    console.log("\n" + out.join("\n\n") + "\n");
  }, 3_600_000);
});
