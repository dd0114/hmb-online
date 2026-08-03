/**
 * #421 하이라이트 시퀀서 E2E 픽스처 생성 — **`e2e/fixtures/p421-highlight.json` 은 커밋된다.**
 *
 * ── 왜 커밋하나 (W8, 독립검증 blocker) ────────────────────────────────────────────────
 * `p421-highlight-reel.spec.ts` 는 원래 `packages/engine/dev-viewer/match-log.json` 을 읽었다.
 * 그건 **gitignore 생성물**이고 `npm test` 의 `generate-demo.test.ts` 가 **그때의 엔진으로** 다시
 * 굽는다. 그래서 두 가지가 동시에 일어났다:
 *  ① 엔진이 움직이면(main 리베이스) 장면 틱이 통째로 바뀌어 spec 이 **결정론적으로 빨개진다**
 *     (실제로 `S2 = 1238` 의 `goal` 이 소멸했다).
 *  ② 반대로 디스크에 **낡은 로그**가 남아 있으면 그대로 초록이다 — `apps/web/playwright.config.ts`
 *     에는 `globalSetup` 이 없어 신선도를 보장할 주체가 없고, 결과가 "직전에 `npm test` 를
 *     돌렸는가"에 의존한다.
 * ⇒ 크로스 패키지 의존을 끊는다. 픽스처를 리포에 커밋하면 엔진이 움직여도 이 spec 은 안 깨지고,
 *   표본이 전제를 만족하는지는 spec 이 **스스로** 단언할 수 있다(그 파일의 "픽스처 신선도" 계약).
 *   선례 = `p322-half1/2.json`(라이브 실경기 로그).
 *
 * ── 무엇을 담나 ──────────────────────────────────────────────────────────────────────
 * 지어내지 않는다. **실엔진 산출물 그대로**다(가공 0 — 솎기·자르기도 하지 않는다):
 *   `runMatch(seed, makeTacticalInput("H"|"A", seed), demoSelect, showcaseConfig)`
 * = `dev-viewer/generate-demo.ts` 의 `buildShowcaseLog()` 와 **같은 경로**이고 시드만 다르다.
 * 쇼케이스 config 를 쓰는 이유는 §2-6 그대로 — 리얼 config 는 24분에 장면(골/선방)이 드물어
 * 이 spec 이 필요로 하는 "멀리 떨어진 두 장면"이 잘 안 나온다.
 *
 * ⚠️ **스냅샷을 솎지 마라(stride 금지).** 이 spec 의 판정 전체가 *"자연 재생(크루즈 4x ≈
 * 8틱/초)으로는 15초 안에 못 오는 거리"* = **시퀀서가 점프했다** 위에 서 있다. 뷰어는 스냅샷
 * 단위로 재생하므로 stride 10 으로 솎으면 자연 재생이 **80틱/초**가 되어 그 전제가 통째로
 * 무너진다(= 시퀀서를 지워도 통과하는 계약이 된다). 그래서 파일이 2MB 다.
 *
 * ── 시드 선정 ────────────────────────────────────────────────────────────────────────
 * spec 이 요구하는 표본은 **두 부류를 하나씩** 이다 — S1 = 같은 틱의 `shot:saved + save`,
 * S2 = `goal`. 그리고 서로 멀어야 한다. 선정 조건(= spec 의 "픽스처 신선도" 계약이 그대로 재는 것):
 *   · `S1 > 720`      자연 재생 90초 이상 = 15초 창 안에 도달하면 점프뿐이다
 *   · `S1 ≲ 864`      후반 60% 경과 시 라이브 상한(인덱스 864) **안**이어야 계약 d2 가 성립한다
 *   · `S2 − S1 > 320` 사이를 자연 재생으로 40초 이상 = 20초 창 안 도달은 점프뿐이다
 *   · `S2 > 1161`     계약 d2 의 `liveBound(0.6, 22s) = 1153` **밖** = "아직 안 열린 장면"
 *   · `S2 + 100 < 1440`
 * `SHOWCASE_SEED`(27706472) 부터 60개를 훑어 위를 만족하는 시드 21개 중, 각 임계에서 여유가
 * 가장 균형 잡힌 **27706506** 을 골랐다 → **S1 = 784 · S2 = 1245**(그 시드의 장면 목록에서
 * 모양이 정확히 `[save, shot:saved]` / `[goal]` 인 틱). 후보 예: 27706489(742/1283) ·
 * 27706493(796/1309) · 27706503(748/1231) · 27706511(735/1207).
 *
 * ── 재생성 (의도적 행위여야 한다) ─────────────────────────────────────────────────────
 *   HMB_GEN_P421=1 npx vitest run apps/web/scripts/gen-p421-fixture.test.ts
 * 플래그 없이는 **쓰지 않는다** — `npm test` 가 조용히 덮어쓰면 이 웨이브가 끊어낸 커플링이
 * 그대로 되살아난다(`HMB_WRITE_EVIDENCE` 와 같은 규율, apps/web CLAUDE.md).
 * ⚠️ 재생성하면 엔진 버전에 따라 **S1·S2 가 바뀐다** → spec 의 두 상수와 모양 단언이 빨개진다.
 * 그건 고장이 아니라 **표본을 다시 고르라는 신호**다. 위 선정 조건으로 다시 스캔해라.
 */
import { writeFileSync } from "node:fs";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../../packages/engine/src/match";
import { demoSelect, makeTacticalInput } from "../../../packages/engine/src/fixtures";
import { showcaseConfig } from "../../../packages/engine/dev-viewer/generate-demo";

/** 위 "시드 선정" 참조. 바꾸면 spec 의 `S1`/`S2` 를 다시 골라야 한다. */
export const P421_SEED = "27706506";

export function buildP421Fixture(): MatchLog {
  return runMatch(
    P421_SEED,
    makeTacticalInput("H", P421_SEED),
    makeTacticalInput("A", P421_SEED),
    demoSelect,
    showcaseConfig,
  );
}

export function writeP421Fixture(path: string): void {
  writeFileSync(path, JSON.stringify(buildP421Fixture()));
}
