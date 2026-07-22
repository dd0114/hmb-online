import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveEventStats, type LogEvent, type TeamLiveStats } from "@hmb/viewer-core";
import { share, statRows } from "./stats-rows";

/**
 * 게임화면 통계 패널이 **QA 뷰어 HUD 와 같은 수치**를 보여주는지 대조한다.
 *
 * 왜 이 테스트가 있나: 처음 구현에서 `shots + onTarget + offTarget` 으로 시도 수를 더해 화면이
 * 정확히 2배를 표시했고(독립검증 blocker-1), 그때 이 대조 테스트가 없어서 게이트를 통과했다.
 * 두 벌 계산이 갈라지는 걸 막는 게 이 파일의 유일한 목적이다.
 */

const EMPTY: TeamLiveStats = {
  shots: 0, onTarget: 0, goals: 0, offTarget: 0, saves: 0, xg: 0,
  passCompleted: 0, passAttempts: 0, passPct: 0,
  corners: 0, fouls: 0, offsides: 0, yellow: 0, red: 0,
};

const team = (over: Partial<TeamLiveStats>): TeamLiveStats => ({ ...EMPTY, ...over });

describe("statRows — 값 정의는 viewer-core 그대로", () => {
  it("슛 행은 시도 총합과 유효슛을 **그대로** 쓴다(부분집합을 더하지 않는다)", () => {
    const home = team({ shots: 9, onTarget: 8, offTarget: 1, goals: 5 });
    const away = team({ shots: 14, onTarget: 10, offTarget: 4, goals: 5 });
    const row = statRows(home, away).find((r) => r.key === "shots")!;

    expect(row.home).toBe("9 (8)");
    expect(row.away).toBe("14 (10)");
    // 막대 가중치도 시도 총합 — 여기서 더하면 비율까지 함께 틀어진다.
    expect(row.hv).toBe(9);
    expect(row.av).toBe(14);
  });

  it("나머지 행도 원시값을 변형하지 않는다", () => {
    const home = team({ xg: 1.234, passPct: 81, corners: 4, fouls: 6, yellow: 1, red: 0 });
    const away = team({ xg: 0.5, passPct: 76, corners: 2, fouls: 9, yellow: 2, red: 1 });
    const rows = statRows(home, away);
    const by = (k: string) => rows.find((r) => r.key === k)!;

    expect(by("xg").home).toBe("1.23");
    expect(by("pass").away).toBe("76%");
    expect(by("corners").hv).toBe(4);
    expect(by("fouls").av).toBe(9);
    expect(by("cards").away).toBe("2 / 1");
    expect(by("cards").av).toBe(3);
  });

  it("share: 합이 0이면 중립 50%, 아니면 홈 비율", () => {
    expect(share(0, 0)).toBe(50);
    expect(share(3, 1)).toBe(75);
    expect(share(0, 4)).toBe(0);
  });
});

describe("실제 match-log 대조 (QA 뷰어 HUD 와 동일 수치)", () => {
  const logPath = new URL("../../../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname;

  it.skipIf(!existsSync(logPath))("데모 로그의 슛 수가 liveEventStats 와 정확히 일치한다", () => {
    const log = JSON.parse(readFileSync(logPath, "utf8")) as { events: LogEvent[] };
    const stats = liveEventStats(log.events, Number.MAX_SAFE_INTEGER);
    const row = statRows(stats.home, stats.away).find((r) => r.key === "shots")!;

    // QA 뷰어 HUD 가 그리는 값(index.html renderHud: ["Shots", h.shots], ["On target", h.onTarget]).
    expect(row.home).toBe(`${stats.home.shots} (${stats.home.onTarget})`);
    expect(row.away).toBe(`${stats.away.shots} (${stats.away.onTarget})`);

    // 엔진 계약 확인: onTarget/offTarget 은 shots 의 분할이다 — 이게 깨지면 위 표기 자체를 다시 봐야 한다.
    expect(stats.home.onTarget + stats.home.offTarget).toBe(stats.home.shots);
    expect(stats.away.onTarget + stats.away.offTarget).toBe(stats.away.shots);
  });
});
