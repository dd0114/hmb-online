/**
 * #388 E2E 픽스처 생성 — **지금 레짐(하프 1350틱 · 표기 0~90')의 실로그**를 만든다.
 *
 * 왜 지어내지 않고 엔진을 돌리나: 이 결함의 축이 **엔진이 구워 내리는 `minute`** 이라,
 * 매핑을 손으로 적으면 계약이 "내가 적은 규칙"을 검사하게 된다(실제와 갈라져도 초록).
 * 그래서 `defaultEngineConfig`(라이브와 같은 45분/표기 90분)로 실제 경기를 돌리고 앞부분만 자른다.
 * 자르는 것은 `minute` 을 바꾸지 않는다 — 2× 어긋남이 그대로 재현된다.
 *
 * 실행: npx vitest run scripts/gen-p388-fixture.test.ts   (Node 20 에서 TS 실행 경로)
 */
import { writeFileSync } from "node:fs";
import { runMatch } from "../../../packages/engine/src/match";
import { defaultEngineConfig } from "../../../packages/engine/src/config";
import { demoSeed, demoHome, demoAway, demoSelect } from "../../../packages/engine/src/fixtures";

/** 픽스처가 담을 마지막 틱 — 20 표기분(= 구 규칙이면 10') 까지면 어긋남을 보이기 충분하다. */
const LAST_TICK = 600;
/** 스냅샷 솎기 간격 — 뷰어가 재생할 정도만 남기고 파일을 작게(실서버는 틱당 1개). */
const STRIDE = 10;

export function buildP388Half1(): unknown {
  const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
  const events = log.events.filter((e) => e.tick <= LAST_TICK);
  const keep = new Set<number>(events.map((e) => e.tick));
  const snaps = log.tickSnapshots.filter(
    (s) => s.tick <= LAST_TICK && (s.tick % STRIDE === 0 || keep.has(s.tick)),
  );
  return {
    configVersion: log.configVersion,
    seed: log.seed,
    tickSnapshots: snaps,
    events,
    finalScore: { home: 0, away: 0 },
  };
}

export function writeP388Fixture(path: string): void {
  writeFileSync(path, JSON.stringify(buildP388Half1()));
}
