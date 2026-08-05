import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 스태틱 산출물을 서브패스(`https://host/하위경로/`)로 서빙하는 곳을 위한 탈출구(#444).
  // 라이브 배포(CF Pages·데모)는 루트라 기본값 "/" — 즉 이 변수를 안 주면 지금까지와 완전히 같다.
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    // 스태틱 모드 게이트(#444). **리터럴로 꽂아야** 목 백엔드 `import()` 가 죽은 가지가 되어
    // rollup 이 청크를 지운다 — `import.meta.env` 를 읽는 형태로는 접히지 않는다(실측).
    // dev 서버에서는 `?static=1` 스위치를 살려야 하므로 항상 열어 둔다.
    __HMB_STATIC_BUILD__: JSON.stringify(
      process.env.NODE_ENV !== "production" || process.env.VITE_STATIC_MODE === "1",
    ),
  },
  resolve: {
    alias: {
      // 관전 렌더/투영 코어(P4-D3 SoT, #169). 워크스페이스 소스를 그대로 번들한다 —
      // 별도 빌드 산출물이 없어 alias 로 붙인다(tsconfig paths 와 짝).
      // ⚠️ 서브경로가 **먼저** 와야 한다 — alias 는 접두 일치라 `@hmb/viewer-core` 가 먼저 걸리면
      // `@hmb/viewer-core/playback` 이 `.../src/index.ts/playback` 으로 접힌다(#444 에서 실제로 났다).
      "@hmb/viewer-core/playback": fileURLToPath(
        new URL("../../packages/viewer-core/src/playback.mjs", import.meta.url),
      ),
      "@hmb/viewer-core": fileURLToPath(new URL("../../packages/viewer-core/src/index.ts", import.meta.url)),
      // 서버 권위 시계 매핑(P4-E2 #170) — 시각→틱 계산의 SoT 를 서버/QA뷰어와 공유한다.
      "@hmb/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      // 스태틱 모드(#444) — 백엔드 없는 빌드가 브라우저에서 직접 소비하는 두 워크스페이스.
      // 라이브 빌드에서는 이 경로를 아무도 import 하지 않아 번들에 들어가지 않는다(동적 import 가드).
      "@hmb/engine-runtime": fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url)),
      // AI 미로그인 폴백의 SoT. 결정론 전술 인풋 생성기를 **재구현하지 않고 그대로 소비**한다.
      "@hmb/server-stub": fileURLToPath(
        new URL("../../packages/server/src/executor/executors/stub.ts", import.meta.url),
      ),
    },
  },
  server: {
    // 프록시 대상은 기본 8080(데모). 대체 서버(예: W0 스모크 8084)는 VITE_API_TARGET 로 덮어쓴다.
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:8080",
        changeOrigin: true,
      },
      // QA 콘솔 레지스트리 API(#191). 같은 오리진으로 보이게 프록시해서 CORS 를 없앤다 —
      // `tools/qa-console.mjs start` 가 VITE_QA_API_TARGET 을 넣어 준다.
      "/qa-api": {
        target: process.env.VITE_QA_API_TARGET || "http://127.0.0.1:8301",
        changeOrigin: true,
      },
    },
  },
  // Playwright E2E(e2e/**)는 vitest 대상이 아니다 — bare `npx vitest run` 이
  // Playwright 전용 스펙을 주워 실패하지 않도록 제외한다(러너는 npx playwright test).
  test: {
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
