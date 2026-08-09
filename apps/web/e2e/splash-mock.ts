import type { Page } from "@playwright/test";

/**
 * #479 — 첫 진입 스플래시를 **끄는** e2e 헬퍼.
 *
 * ## 왜 이 헬퍼가 있나
 *
 * #479 부터 비로그인 첫 화면은 스플래시이고 로그인 폼은 `[게임 시작]` **뒤에** 있다. 그래서
 * 로그인 폼을 실제로 클릭하는 스펙들(리포 전체에서 10건 — 나머지는 `hmb.auth.token` 을 심어
 * 로그인을 우회한다)이 그 한 겹을 넘어야 한다.
 *
 * ⚠️ **`[게임 시작]` 을 클릭하게 만드는 안은 기각했다.** 두 가지가 나빠진다:
 *  1. 스펙마다 webp 137건(4.19MB) preload 가 붙어 느려진다 — 로그인 플로우와 무관한 비용.
 *  2. **잘못된 결합** — 스플래시가 깨지면 로그인·튜토리얼·통화표기 스펙이 같이 빨개져서
 *     신호가 어디서 왔는지 못 읽는다.
 * 스플래시 자체 동선은 `p479-splash.spec.ts` 가 **실경로로** 검증한다.
 *
 * ⚠️ `addInitScript` 라서 **`page.goto` 전에** 불러야 한다(리포의 `hmb.auth.token` 심는 관용구와
 * 같다 — `p386-mocks.ts` 참조).
 */
export async function skipSplash(page: Page) {
  // 키는 `src/splash/splash-gate.ts` 의 SPLASH_SEEN_KEY 와 같아야 한다. e2e 는 src 를 import 하지
  // 않으므로(브라우저 컨텍스트 안에서 도는 코드다) 여기서만 문자열로 쓴다 — 두 곳이 갈라지면
  // 이 헬퍼가 조용히 무효가 되고 스펙들이 스플래시에 막힌다(그때 증상은 명확하다: 폼이 안 뜬다).
  await page.addInitScript(() => window.sessionStorage.setItem("hmb.splash.seen", "1"));
}
