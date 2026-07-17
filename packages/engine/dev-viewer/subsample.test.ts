import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { subsampleSnapshots } from "./subsample.mjs";

// #50: standalone 서브샘플은 용량 축소로 틱을 2개당 1개만 남기되, **이벤트 참조 틱은 항상 보존**해야
// 한다. 안 그러면 홀수틱 causeTick(예: 코너@765)의 스냅샷이 빠져 idxOfTick 반올림 → 선행 정지 jump
// 초과 착지 → 세트피스 자막/freeze 스킵(코너킥 자막 누락). 이 계약이 그 회귀를 박제한다.
const here = dirname(fileURLToPath(import.meta.url));
const matchLogPath = join(here, "match-log.json");

describe("subsampleSnapshots (#50 홀수틱 이벤트 드롭 방지)", () => {
  it("합성 입력: 홀수 이벤트틱 + 데드볼 접근틱(causeTick-1/-2)을 보존한다", () => {
    // tick 0..9 스냅샷, 데드볼 재배치(코너)는 홀수틱 7 에 발생.
    const snaps = Array.from({ length: 10 }, (_, t) => ({
      tick: t, minute: 0, ball: { x: t, y: t }, ballOwner: null,
      players: [{ playerId: "H0", team: "home", pos: { x: t, y: t } }],
    }));
    const events = [{ tick: 7, type: "kickoff", detail: "corner" }];
    const out = subsampleSnapshots(snaps, events, 2);
    const ticks = new Set(out.map((s) => s.tick));
    expect(ticks.has(7), "홀수 이벤트틱 7 보존(순수 STEP=2 면 누락)").toBe(true);
    // #51: 데드볼 접근틱 causeTick-1(6), causeTick-2(5) 보존 → 다운샘플에서도 연속 판별 정확.
    expect(ticks.has(6)).toBe(true);
    expect(ticks.has(5)).toBe(true);
    // 데드볼 근처 아닌 비이벤트 홀수틱은 드롭.
    expect(ticks.has(1)).toBe(false);
    expect(ticks.has(3)).toBe(false);
    expect([...ticks]).toEqual([...ticks].sort((a, b) => a - b)); // tick 오름차순
  });

  it("실 match-log: 모든 이벤트 틱이 서브샘플 결과에 존재한다(코너@홀수틱 포함)", () => {
    if (!existsSync(matchLogPath)) return; // 생성물 없으면 skip(globalSetup/generate-demo 가 만듦)
    const log = JSON.parse(readFileSync(matchLogPath, "utf8"));
    const out = subsampleSnapshots(log.tickSnapshots, log.events, 2);
    const ticks = new Set(out.map((s) => s.tick));
    const missing = log.events.map((e: { tick: number }) => e.tick).filter((t: number) => !ticks.has(t));
    expect(missing, `서브샘플에서 빠진 이벤트 틱: ${missing.join(",")}`).toEqual([]);
    // 크기 회귀 가드: 순수 STEP=2(≈절반) 대비 과증가 없어야.
    expect(out.length).toBeLessThanOrEqual(Math.ceil(log.tickSnapshots.length / 2) + log.events.length);
  });
});
