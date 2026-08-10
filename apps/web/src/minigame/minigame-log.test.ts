import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MatchLog } from "@hmb/shared";

/**
 * #493 W1 — 첫 경험 미니게임의 정적 매치로그 자산 계약.
 *
 * `minigame-log.json` 은 **커밋된 자산**이다(선례 = `e2e/fixtures/p421-highlight.json`):
 * 신규 유저 첫 화면이 gitignore 생성물(`dev-viewer/match-log.json`)의 신선도에 의존하면
 * "직전에 npm test 를 돌렸는가"가 첫 경험을 좌우한다. 재생성은 의도적 행위로만 —
 *   HMB_GEN_MINIGAME=1 npx vitest run apps/web/scripts/gen-minigame-log.test.ts
 *
 * 이 계약이 지키는 것:
 *  - 뷰어 코어 검증(viewer.impl.mjs — tickSnapshots·events·finalScore) + shared zod 전체 통과
 *  - 스냅샷 무솎기(stride 금지 — p421 머리말: 솎으면 자연 재생 속도가 배수로 뛰어
 *    "1분 관전" 전제가 무너진다)
 *  - 1분 컷 창(재생 실측 57.8s @ tick 345 — W0 조사) 안에 골 ≥2 = 첫 경험의 스펙터클
 *  - finalScore 가 컷 시점 스코어와 정합(원본 4:4 를 그대로 들고 오면 결과 화면이 거짓말한다)
 *  - gzip ≤ 100KB (AC1 — 정적 번들로 서버 접촉 0 을 성립시키는 크기 상한)
 */
const ASSET = fileURLToPath(new URL("./minigame-log.json", import.meta.url));

describe("#493 미니게임 정적 로그 자산", () => {
  it("자산이 존재하고 shared MatchLog 스키마를 통과한다", () => {
    expect(existsSync(ASSET), `커밋된 자산이 없다: ${ASSET} — HMB_GEN_MINIGAME=1 로 생성해라`).toBe(true);
    const log = MatchLog.parse(JSON.parse(readFileSync(ASSET, "utf8")));
    expect(log.configVersion).toContain("showcase"); // 리얼 config 로그는 24분에 장면이 드물다(§2-6)
  });

  it("스냅샷은 tick 0 부터 연속(무솎기)이고 1분 컷 창 안이다", () => {
    const log = MatchLog.parse(JSON.parse(readFileSync(ASSET, "utf8")));
    const snaps = log.tickSnapshots;
    expect(snaps[0]!.tick).toBe(0);
    const last = snaps[snaps.length - 1]!.tick;
    expect(snaps.length, "stride 금지 — 솎으면 재생 속도 전제가 무너진다").toBe(last + 1);
    // 재생 실측 57.8s @ 345 (W0). 재생성으로 컷 틱이 옮겨져도 "약 1분"을 벗어나면 red.
    expect(last).toBeGreaterThanOrEqual(280);
    expect(last).toBeLessThanOrEqual(420);
  });

  it("컷 창 안에 골 ≥2 이고 finalScore 가 컷 시점 스코어와 정합한다", () => {
    const log = MatchLog.parse(JSON.parse(readFileSync(ASSET, "utf8")));
    const last = log.tickSnapshots[log.tickSnapshots.length - 1]!.tick;
    for (const e of log.events) {
      expect(e.tick, `이벤트가 스냅샷 창 밖이다: ${e.type}@${e.tick}`).toBeLessThanOrEqual(last);
      expect(e.tick).toBeGreaterThanOrEqual(0);
    }
    const goals = log.events.filter((e) => e.type === "goal");
    expect(goals.length, "1분 안에 골 2개 이상 = 첫 경험의 존재 이유").toBeGreaterThanOrEqual(2);
    const home = goals.filter((g) => g.team === "home").length;
    const away = goals.filter((g) => g.team === "away").length;
    expect(log.finalScore).toEqual({ home, away });
  });

  it("gzip ≤ 100KB (AC1 크기 상한)", () => {
    const raw = readFileSync(ASSET);
    const gz = gzipSync(raw).length;
    // eslint-disable-next-line no-console
    console.log(`[minigame-log] raw=${raw.length}B gzip=${gz}B`);
    expect(gz).toBeLessThanOrEqual(100 * 1024);
  });
});
