import { configDefaults, defineConfig } from "vitest/config";
import { TIER, t0ExcludedFiles } from "./packages/engine/src/realism/tier";

export default defineConfig({
  resolve: {
    alias: {
      "@hmb/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@hmb/engine": new URL("./packages/engine/src/index.ts", import.meta.url).pathname,
      // 관전 렌더/투영 코어(#169 P4-D3) — apps/web/vite.config.ts 의 alias 와 같은 대상.
      // 서브패스 별칭이 **먼저** 와야 한다 — "@hmb/viewer-core" 가 먼저면 접두 매칭이 서브패스까지
      // 삼켜 `@hmb/viewer-core/playback` 이 index.ts 로 붙는다(#365).
      "@hmb/viewer-core/playback": new URL("./packages/viewer-core/src/playback.mjs", import.meta.url).pathname,
      "@hmb/viewer-core": new URL("./packages/viewer-core/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    // tools/** = QA 콘솔 레지스트리·CLI 코어(#191). 여기에 없으면 그 계약이 게이트에서 빠진다.
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "data/**/*.test.ts", "tools/**/*.test.ts"],
    /**
     * T0(`HMB_TIER=0`, `npm run test:t0`)에서만 다시드 집계 스위트를 뺀다 — #376/#377 M0-3.
     * ⚠️ `describe.skipIf` 로는 못 막는 부류다: 그 파일들은 **모듈 최상위**에서 집계를 돌려
     * 스킵해도 collect 단계에서 이미 계산이 끝난다. 그래서 파일째 제외가 유일한 수단이다.
     * 기본(T1)과 T2 에서는 **아무것도 제외되지 않는다** — 목록·근거·정합성은 `tier.test.ts` 가 지킨다.
     */
    // ⚠️ `exclude` 는 vitest 기본값을 **덮어쓴다**(병합이 아니다). 손으로 두 줄만 적으면
    // `**/cypress/**`·`**/.{idea,git,cache,output,temp}/**` 보호가 조용히 사라진다 — 지금은 그
    // 경로에 `.test.ts` 가 0건이라 무해하지만, 무해함이 우연이면 계약이 아니다. 기본값을 편다.
    exclude: [
      ...configDefaults.exclude,
      ...(TIER === 0 ? t0ExcludedFiles() : []),
    ],
  },
});
