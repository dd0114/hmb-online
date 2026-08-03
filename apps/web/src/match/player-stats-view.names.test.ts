/**
 * 선수 기록 **표시 계층**의 이름 사다리·두 축 계약 (#406 요구 6, W8).
 *
 * <p>W8 이 이 파일을 초크포인트로 옮겼다. 옮기기 전 상태가 정확히 이랬다 —
 * <pre>
 *   byId.set(c.id, { name: typeof c.name === "string" && c.name ? c.name : c.id, … })  // 사다리 1·3단 재선언
 *   out.set(key, { name: meta?.name ?? id, … })                                        // 3단 = playerId
 *   rowsFor: name: meta?.name ?? line.playerId                                          // 3단 = playerId
 * </pre>
 * 즉 <b>`P077` 을 화면에 내보내는 경로가 이 한 파일에 셋</b> 있었고, 짧은 축도 카탈로그 우선순위도
 * 없었다. 여기서 나온 이름은 선수 탭 표 · 하프 리포트 카드 · 선수 상세 모달 헤더로 흘러간다.
 *
 * <h3>왜 별도 파일인가 — 스캐너가 이 축을 못 본다</h3>
 * `common/player-names.test.ts` 의 AST 스캐너는 <b>"직독이 없다"</b>만 본다. 이 파일이 초크포인트를
 * 부르지 않고 `catalog.name` 을 다시 읽어도, 그 표현이 스캐너가 아는 형태가 아니면 초록이고
 * <b>축을 바꾸는 변이는 어떤 형태로도 안 잡힌다</b>(W1c MAJOR-1 이 그 부류였다).
 *
 * <h3>표본은 <b>#411 스위치 후</b> 모양이다 — 그게 계약의 절반이다</h3>
 * 오늘 라이브 카탈로그엔 `shortName` 이 없어서 <b>두 축의 값이 같다</b>. 그 표본으로 재면
 * `short` ↔ `full` 을 맞바꾸는 변이가 <b>전부 생존</b>한다(형제 계약 3개가 같은 이유로
 * 스위치 후 픽스처를 싣는다 — apps/web CLAUDE.md).
 */
import { describe, expect, it } from "vitest";
import { buildRosterMeta, rowsFor, type RosterMeta } from "./player-stats-view";
import { computePlayerStats, playerKey, type StatMatchLog } from "./player-stats";
import { UNKNOWN_PLAYER_NAME } from "../common/player-names";

/**
 * `shortName` 이 **풀네임과 다른** 카탈로그(= #411 스위치 후). `P999` 는 **일부러 빼 둔다** —
 * 카탈로그가 모르는 선수(발행 사고·은퇴)가 사다리 3단으로 떨어지는지 보려면 표본에 있어야 한다.
 */
const CATALOG = [
  { id: "P001", name: "레프 야신", shortName: "야신", position: "GK" },
  { id: "P077", name: "크바라츠헬리아", shortName: "흐비차", position: "FW" },
];

/** 로그엔 셋이 뛴다 — 카탈로그가 아는 둘 + 모르는 `P999`. */
function makeLog(): StatMatchLog {
  const players = [
    { playerId: "P001", team: "home", pos: { x: 5, y: 34 } },
    { playerId: "P077", team: "home", pos: { x: 70, y: 34 } },
    { playerId: "P999", team: "home", pos: { x: 40, y: 34 } },
  ];
  return {
    tickSnapshots: [
      { tick: 0, minute: 0, ball: { x: 52, y: 34 }, ballOwner: "P077", players },
      { tick: 1, minute: 0, ball: { x: 53, y: 34 }, ballOwner: "P077", players },
    ],
    events: [],
  };
}

const roster = () => buildRosterMeta(makeLog(), CATALOG);
const at = (m: ReadonlyMap<string, RosterMeta>, id: string) => m.get(playerKey("home", id))!;

describe("buildRosterMeta — 두 축이 실제로 갈린다 (#411 스위치 후)", () => {
  it("`short` 는 shortName, `full` 은 풀네임", () => {
    const m = roster();
    expect(at(m, "P077").short).toBe("흐비차");
    expect(at(m, "P077").full).toBe("크바라츠헬리아");
    expect(at(m, "P001").short).toBe("야신");
    expect(at(m, "P001").full).toBe("레프 야신");
  });

  /** 신선도 가드 — 두 축의 값이 같은 표본이면 아래 축 계약들이 통째로 공허하다. */
  it("표본에서 두 축이 다른 값이다", () => {
    const m = roster();
    expect(at(m, "P077").short).not.toBe(at(m, "P077").full);
  });

  /**
   * ★ **사다리 3단** — 카탈로그가 모르는 선수는 `미상 선수` 다. <b>`P999` 가 아니다.</b>
   * 구 코드(`meta?.name ?? id`)를 되돌리면 이 단언이 죽는다.
   */
  it("카탈로그가 모르는 선수는 `미상 선수` — **playerId 가 새지 않는다**", () => {
    const m = roster();
    expect(at(m, "P999").short).toBe(UNKNOWN_PLAYER_NAME);
    expect(at(m, "P999").full).toBe(UNKNOWN_PLAYER_NAME);
    expect(at(m, "P999").short).not.toBe("P999");
    expect(at(m, "P999").short).not.toMatch(/^[A-Za-z]{1,2}\d+$/);
    // 부가 정보(등번호)는 살아 있다 — 이름을 못 찾은 것이 행 전체를 죽이지 않는다.
    expect(at(m, "P999").num).toBe("3");
  });

  /** 포지션은 이 파일의 몫이라 초크포인트 이설로 죽지 않았다(같이 옮기다 흘리기 쉬운 자리). */
  it("포지션은 그대로 카탈로그에서 온다", () => {
    const m = roster();
    expect(at(m, "P001").position).toBe("GK");
    expect(at(m, "P077").position).toBe("FW");
    expect(at(m, "P999").position).toBeNull();
  });
});

describe("rowsFor — 표 한 행은 **밀집 축**이다", () => {
  const result = computePlayerStats(makeLog(), {});

  it("행 이름 = `short`(**`full` 이 아니다**)", () => {
    const rows = rowsFor(result, "home", roster());
    const byId = new Map(rows.map((x) => [x.playerId, x.name]));
    expect(byId.get("P077")).toBe("흐비차");
    // ★ 변이: `meta?.full` 로 바꾸면 여기서 죽는다.
    expect(byId.get("P077")).not.toBe("크바라츠헬리아");
    expect(byId.get("P001")).toBe("야신");
  });

  /**
   * ★ 로스터에 없는 키(성긴 로그로 등번호를 못 만든 경우)도 `미상 선수` 다.
   * 구 코드는 `?? line.playerId` 였다 — 표에 `P077` 이 그대로 떴을 자리다.
   */
  it("로스터가 비어도 이름 자리에 playerId 를 쓰지 않는다", () => {
    const rows = rowsFor(result, "home", new Map());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.name).toBe(UNKNOWN_PLAYER_NAME);
      expect(r.name).not.toBe(r.playerId);
      expect(r.name).not.toMatch(/^[A-Za-z]{1,2}\d+$/);
    }
  });
});
