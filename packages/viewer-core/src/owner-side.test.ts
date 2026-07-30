import { describe, it, expect } from "vitest";
import { ownerSideOf } from "./owner-side.mjs";
import { computeCumulativePossession, possessionPct } from "./stats.impl.mjs";

/**
 * #324 후속 — 공 소유팀을 `playerId` 첫 글자로 **추측**하던 것.
 *
 * 라이브에서 실제로 무엇이 깨졌나: 실경기 id 는 `P077` 이라 `id[0]==="H"` 가 절대 참이 아니고,
 * 그래서 모든 소유 틱이 away 로 집계됐다 — 게임화면(`StatsPanel`)의 점유율 바가 **home 0%** 였다.
 * 이 계약은 그 추측이 되살아나면 죽는다.
 */
describe("#324 ownerSideOf — 소유팀은 스냅샷에서 찾는다(첫 글자 추측 금지)", () => {
  const snap = (ballOwner: string | null, extra: Record<string, unknown> = {}) => ({
    tick: 0,
    ball: { x: 50, y: 34 },
    ballOwner,
    players: [
      { playerId: "P175", team: "home", pos: { x: 50, y: 34 } },
      { playerId: "P108", team: "home", pos: { x: 80, y: 34 } },
      { playerId: "P116", team: "away", pos: { x: 99, y: 34 } },
    ],
    ...extra,
  });

  it("실경기 id(P…) 도 자기 팀으로 판정된다 — 종전엔 전부 away 였다", () => {
    expect(ownerSideOf(snap("P175"))).toBe("home");
    expect(ownerSideOf(snap("P116"))).toBe("away");
  });

  it("엔진 픽스처 id(H/A) 도 그대로 동작한다(무회귀)", () => {
    const fixture = {
      ball: { x: 50, y: 34 },
      ballOwner: "H9",
      players: [
        { playerId: "H9", team: "home", pos: { x: 50, y: 34 } },
        { playerId: "A3", team: "away", pos: { x: 70, y: 34 } },
      ],
    };
    expect(ownerSideOf(fixture)).toBe("home");
    expect(ownerSideOf({ ...fixture, ballOwner: "A3" })).toBe("away");
  });

  it("소유자가 없거나 스냅샷에 없으면 null — 모르는 것을 away 라고 답하지 않는다", () => {
    expect(ownerSideOf(snap(null))).toBeNull();
    expect(ownerSideOf(snap("P999"))).toBeNull();
  });

  it("같은 id 가 양 팀에 있으면 공에 더 가까운 쪽이 소유자다", () => {
    const dup = {
      ball: { x: 20, y: 34 },
      ballOwner: "P078",
      players: [
        { playerId: "P078", team: "home", pos: { x: 21, y: 34 } }, // 공에서 1m
        { playerId: "P078", team: "away", pos: { x: 80, y: 34 } }, // 60m
      ],
    };
    expect(ownerSideOf(dup)).toBe("home");
    // 공이 반대편이면 판정도 뒤집힌다(위치가 근거지 순서가 아니다).
    expect(ownerSideOf({ ...dup, ball: { x: 81, y: 34 } })).toBe("away");
  });
});

describe("#324 SURGE 전진 판정 — 홈팀 돌파가 후진으로 계산되던 것", () => {
  /**
   * ⚠️ 기존 SURGE 테스트는 소유자 id 가 `H9` 라 **추측이 우연히 맞는다**(첫 글자가 H).
   * 결함이 드러나는 조건은 **실경기 id 를 쓴 홈팀**이다 — `P175`[0] 은 "H" 가 아니라 away 로 읽히고,
   * 그러면 전진(+x)이 후진으로 계산돼 홈팀에겐 SURGE 가 영영 안 뜬다.
   */
  const homeRun = () => {
    const s: Record<string, unknown>[] = [];
    for (let t = 0; t < 8; t++) {
      s.push({
        tick: t,
        ballOwner: "P175",
        ball: { x: 40 + t * 3, y: 34 },
        players: [{ playerId: "P175", team: "home", pos: { x: 40 + t * 3, y: 34 } }],
      });
    }
    s.push({ tick: 8, ballOwner: "P108", ball: { x: 64, y: 34 },
             players: [{ playerId: "P108", team: "home", pos: { x: 64, y: 34 } }] });
    return s;
  };

  it("실경기 id 의 홈팀 전진 돌파에 SURGE 가 뜬다", async () => {
    const { buildAnnotations } = await import("./playback.mjs");
    const a = buildAnnotations([], homeRun());
    expect(a.find((x: { text: string }) => x.text === "SURGE!")).toBeTruthy();
  });

  it("어웨이 전진(−x)도 그대로 뜬다(무회귀)", async () => {
    const { buildAnnotations } = await import("./playback.mjs");
    const s: Record<string, unknown>[] = [];
    for (let t = 0; t < 8; t++) {
      s.push({
        tick: t,
        ballOwner: "P116",
        ball: { x: 64 - t * 3, y: 34 },
        players: [{ playerId: "P116", team: "away", pos: { x: 64 - t * 3, y: 34 } }],
      });
    }
    s.push({ tick: 8, ballOwner: "P119", ball: { x: 40, y: 34 },
             players: [{ playerId: "P119", team: "away", pos: { x: 40, y: 34 } }] });
    expect(buildAnnotations([], s).find((x: { text: string }) => x.text === "SURGE!")).toBeTruthy();
  });
});

describe("#324 누적 점유 — 라이브 결함의 직접 재현 방지", () => {
  /** home 이 3틱, away 가 1틱 소유. 실경기 id 만 쓴다(결함이 나던 조건). */
  const snaps = [
    { ball: { x: 50, y: 34 }, ballOwner: "P175", players: [{ playerId: "P175", team: "home", pos: { x: 50, y: 34 } }] },
    { ball: { x: 55, y: 34 }, ballOwner: "P175", players: [{ playerId: "P175", team: "home", pos: { x: 55, y: 34 } }] },
    { ball: { x: 60, y: 34 }, ballOwner: "P108", players: [{ playerId: "P108", team: "home", pos: { x: 60, y: 34 } }] },
    { ball: { x: 90, y: 34 }, ballOwner: "P116", players: [{ playerId: "P116", team: "away", pos: { x: 90, y: 34 } }] },
  ];

  it("점유가 팀별로 집계된다 — 고치기 전에는 home 0 : away 4 였다", () => {
    const c = computeCumulativePossession(snaps);
    expect(c.cumHome[3]).toBe(3);
    expect(c.cumAway[3]).toBe(1);
    expect(possessionPct(c.cumHome, c.cumAway, 3)).toBe(75);
  });

  it("home 점유율이 0% 로 붕괴하지 않는다(화면에 뜨던 값)", () => {
    const c = computeCumulativePossession(snaps);
    expect(possessionPct(c.cumHome, c.cumAway, 3)).toBeGreaterThan(0);
  });
});
