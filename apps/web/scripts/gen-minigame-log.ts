/**
 * #493 W1 — 첫 경험 미니게임용 1분 컷 매치로그 생성. **`src/minigame/minigame-log.json` 은 커밋된다.**
 *
 * 규율은 `gen-p421-fixture.ts` 그대로다:
 *  - gitignore 생성물(`dev-viewer/match-log.json`)을 읽지 않는다 — **실엔진에서 직접** 굽는다
 *    (`buildShowcaseLog()` = 쇼케이스 데모와 같은 경로·같은 시드). 커밋된 자산이라 엔진이
 *    움직여도 웹 빌드·첫 경험은 안 흔들리고, 재생성은 의도적 행위로만 한다.
 *  - **스냅샷을 솎지 않는다**(stride 금지 — 뷰어는 스냅샷 단위 재생이라 솎으면 재생 속도가
 *    배수로 뛰어 "1분 관전"이 성립하지 않는다).
 *
 * ── 컷 ───────────────────────────────────────────────────────────────────────────────
 * `CUT_TICK` 이하의 스냅샷·이벤트만 남기고, `finalScore` 는 **컷 창 안의 골 이벤트를 재집계**해
 * 바꾼다(원본 90분 스코어를 그대로 들고 오면 1분만 보여준 결과 화면이 거짓말을 한다).
 * 345 선정 근거(W0 실측, `epics/493-tutorial/research.md` 축4): 재생 57.8s · 골 2개(5'·8',
 * away@89 · home@131 — 다음 골이 tick 347 이라 345 가 "골 2개 + 1분" 경계) · gzip 63.5KB.
 *
 * ── 재생성 (의도적 행위여야 한다) ─────────────────────────────────────────────────────
 *   HMB_GEN_MINIGAME=1 npx vitest run apps/web/scripts/gen-minigame-log.test.ts
 * 엔진이 움직여 SHOWCASE_SEED 의 전개가 바뀌면 컷 창의 골 수·재생 길이가 달라질 수 있다 —
 * 생성 테스트가 쓰기 **전에** 전제(창 안 골 ≥2)를 단언하니, 깨지면 CUT_TICK 을 다시 골라라
 * (계약 = `src/minigame/minigame-log.test.ts` 의 창 280~420).
 */
import { writeFileSync } from "node:fs";
import type { MatchLog } from "@hmb/shared";
import { buildShowcaseLog } from "../../../packages/engine/dev-viewer/generate-demo";

/** 위 "컷" 참조. 바꾸면 계약 테스트의 창(280~420)과 골 ≥2 전제를 다시 확인해라. */
export const CUT_TICK = 345;

export function buildMinigameLog(): MatchLog {
  const full = buildShowcaseLog();
  const tickSnapshots = full.tickSnapshots.filter((s) => s.tick <= CUT_TICK);
  const events = full.events.filter((e) => e.tick <= CUT_TICK);
  const goals = events.filter((e) => e.type === "goal");
  return {
    configVersion: full.configVersion,
    seed: full.seed,
    tickSnapshots,
    events,
    finalScore: {
      home: goals.filter((g) => g.team === "home").length,
      away: goals.filter((g) => g.team === "away").length,
    },
  };
}

export function writeMinigameLog(log: MatchLog): string {
  const out = new URL("../src/minigame/minigame-log.json", import.meta.url).pathname;
  writeFileSync(out, JSON.stringify(log));
  return out;
}
