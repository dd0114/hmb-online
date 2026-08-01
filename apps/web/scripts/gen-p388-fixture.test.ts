import { it, expect } from "vitest";
import { buildP388Half1, writeP388Fixture } from "./gen-p388-fixture";

/** 생성 겸 **매핑 검증** — 구운 minute 이 정말 틱의 2배 축인지 확인하고 쓴다. */
it("#388 픽스처 생성 (하프 1350틱 레짐 실로그)", () => {
  const log = buildP388Half1() as { tickSnapshots: { tick: number; minute: number }[]; events: unknown[] };
  const last = log.tickSnapshots[log.tickSnapshots.length - 1]!;
  expect(last.minute).toBe(Math.floor(last.tick / 30)); // 표기 스케일 2 (45분 → 90')
  expect(last.minute).toBeGreaterThan(Math.floor(last.tick / 60)); // 구 규칙과 실제로 다르다
  expect(log.events.length).toBeGreaterThan(10);
  writeP388Fixture(new URL("../e2e/fixtures/p388-half1.json", import.meta.url).pathname);
}, 600000);
