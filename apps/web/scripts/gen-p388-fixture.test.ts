import { it, expect } from "vitest";
import { buildP388Half1, writeP388Fixture } from "./gen-p388-fixture";

/**
 * 생성 겸 **매핑 검증** — 구운 minute 이 정말 틱의 2배 축인지 확인하고 쓴다.
 *
 * ⚠️ **쓰기는 명시적 행위다**(`HMB_WRITE_FIXTURE=1`). 이 테스트는 `runMatch` 를 돌려 픽스처를
 * 만드는데 그 산출물의 `configVersion` 은 **그때의 엔진**을 따른다. 그래서 게이트를 한 번 돌 때마다
 * `apps/web/e2e/fixtures/p388-half1.json` 이 조용히 갈아치워지고, 엔진이 범프된 날에는 **아무도
 * 선언하지 않은 변경**이 트리에 앉는다 — 실제로 engine@0.34.0 → 0.40.0 전량 재생성(스냅샷
 * 194→183 · 이벤트 153→145)이 #406 어느 웨이브의 선언 목록에도 없이 나타났고, 독립검증이
 * "스코프 밖 변경"으로 잡았다(W4/W5 m-9).
 *
 * 처방은 `apps/web/CLAUDE.md` 의 e2e 증거 규칙(#314)과 같은 이유·같은 형태다: 다른 세션의 트리가
 * 매번 dirty 해지고 `git add -A` 가 그걸 조용히 담는다. **검증은 항상 돌고, 쓰기만 스위치 뒤에 둔다.**
 *
 *   HMB_WRITE_FIXTURE=1 npx vitest run scripts/gen-p388-fixture.test.ts
 */
it("#388 픽스처 생성 (하프 1350틱 레짐 실로그)", () => {
  const log = buildP388Half1() as { tickSnapshots: { tick: number; minute: number }[]; events: unknown[] };
  const last = log.tickSnapshots[log.tickSnapshots.length - 1]!;
  expect(last.minute).toBe(Math.floor(last.tick / 30)); // 표기 스케일 2 (45분 → 90')
  expect(last.minute).toBeGreaterThan(Math.floor(last.tick / 60)); // 구 규칙과 실제로 다르다
  expect(log.events.length).toBeGreaterThan(10);
  if (process.env.HMB_WRITE_FIXTURE === "1") {
    writeP388Fixture(new URL("../e2e/fixtures/p388-half1.json", import.meta.url).pathname);
  }
}, 600000);
