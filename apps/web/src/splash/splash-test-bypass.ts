/**
 * #479 — 유닛 테스트에서 **첫 진입 스플래시를 건너뛴다**.
 *
 * ⚠️ 왜 헬퍼로 빼는가: 이 우회를 각 테스트 파일이 손으로 조립하다가 사고가 났다.
 * `LoginPage.test.ts` 에는 넣고 **`local-auth.test.ts` 를 빠뜨려** 그 파일 17건이 전부
 * 깨진 채 커밋됐고(독립 QA blocker), 나는 내가 만진 파일만 골라 돌려서 그것을 못 봤다.
 * 규칙이 두 곳에 손으로 적히면 한쪽이 낡는다 — `splash-gate.ts` 머리말과 같은 축이다.
 *
 * ⚠️ 그리고 헬퍼만으로는 **다음에 생길 세 번째 파일**을 못 막는다(그 파일도 그냥 안 부르면
 * 된다). 그래서 `splash-test-bypass.test.ts` 가 소스를 훑어 *`LoginPage` 를 렌더하는 모든
 * 테스트 파일이 이 헬퍼를 부르는지* 정적으로 검사한다 — 이 파일 혼자가 아니라 그 둘이 계약이다.
 *
 * e2e 쪽 대응물은 `e2e/splash-mock.ts` 의 `skipSplash(page)` 다(`addInitScript` 라
 * `goto` **앞**에 와야 한다 — 거긴 그 순서가 계약).
 */
import { SPLASH_SEEN_KEY } from "./splash-gate";

/**
 * "이번 세션에 이미 봤다" 상태로 만든다 = `shouldShowSplash` 가 false.
 *
 * 저장 키를 직접 쓰지 않고 `splash-gate` 의 상수를 재사용한다 — 키가 바뀌면 우회가
 * 조용히 무력해지는 대신 **컴파일이 따라온다**.
 */
export function bypassSplash(): void {
  window.sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
}
