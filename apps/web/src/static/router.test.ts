// @vitest-environment jsdom
/**
 * 스태틱 모드 목 백엔드 계약 (#444).
 *
 * <b>무엇을 지키나</b>: "서버 없이 경기 1판을 끝까지 갈 수 있다"는 이 브랜치의 **완료 기준**이다.
 * 그 문장을 브라우저 없이 한 파일로 박제한다 — 화면이 바뀌어도 이 경로가 살아 있으면 데모는 산다.
 *
 * ⚠️ 실제 엔진을 돌린다(하프당 ~0.3초). 목 시뮬로 대체하면 "엔진이 브라우저에서 돈다"는 이 웨이브의
 * 유일한 기술적 주장이 검증되지 않는다.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleStaticRequest } from "./router";
import { resetState } from "./state";
import { ApiError } from "../api/client";

const get = <T>(path: string) => handleStaticRequest<T>(path, "GET", undefined);
const post = <T>(path: string, body?: unknown) => handleStaticRequest<T>(path, "POST", body);

interface MatchDetailish {
  id: string;
  state: string;
  scoreHome: number | null;
  scoreAway: number | null;
  clock: { phase: string; phaseEndsAt: string; halfRealMs: number } | null;
  opponent: { name: string; deck: unknown[] };
}

async function login(nickname = "테스터"): Promise<void> {
  await post("/api/auth/login", { nickname, provider: "guest" });
}

/** 상태가 바뀔 때까지 목 백엔드를 폴링한다(실서버 폴링과 같은 모양). */
async function pollUntil(id: string, want: (m: MatchDetailish) => boolean, limitMs = 15_000): Promise<MatchDetailish> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const m = await get<MatchDetailish>(`/api/matches/${id}`);
    if (want(m)) return m;
    if (Date.now() > deadline) throw new Error(`타임아웃: state=${m.state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("스태틱 목 백엔드", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetState();
  });

  it("로그인하면 스타터 팩과 덱이 생긴다 — 첫 화면부터 플레이 가능한 상태다", async () => {
    await login();
    const me = await get<{ user: { nickname: string }; wallet: { points: number } }>("/api/me");
    expect(me.user.nickname).toBe("테스터");
    expect(me.wallet.points).toBeGreaterThan(0);

    const deck = await get<{ formation: string; slots: { role: string }[] }>("/api/deck");
    expect(deck.slots.filter((s) => s.role === "starter")).toHaveLength(11);

    const players = await get<unknown[]>("/api/players");
    expect(players.length).toBeGreaterThan(100);
  });

  it("경기 한 판을 끝까지 간다 — 브리핑 → 전반 → 감독시간 → 후반 → 결과", async () => {
    await login();
    const created = await post<MatchDetailish>("/api/matches", {});
    expect(created.state).toBe("BRIEFING");
    // 상대 분석은 브리핑 화면의 내용이다 — 비면 화면이 빈다.
    expect(created.opponent.deck).toHaveLength(11);

    await post(`/api/matches/${created.id}/prompts`, {
      phase: "pre",
      scope: "team",
      text: "하이라인 압박, 측면 오버랩",
    });
    await post(`/api/matches/${created.id}/kickoff`);

    const live = await pollUntil(created.id, (m) => m.state === "FIRST_HALF");
    // 재생 창이 실제로 열려야 뷰어가 틱을 계산한다(#170 시계 계약).
    expect(live.clock?.phase).toBe("FIRST_HALF");
    expect(live.clock?.halfRealMs).toBeGreaterThan(0);

    const h1 = await get<{ tickSnapshots: unknown[]; events: unknown[] }>(
      `/api/matches/${created.id}/halves/1/log`,
    );
    expect(h1.tickSnapshots.length).toBeGreaterThan(1000); // 45분 하프 = 1350틱대
    expect(h1.events.length).toBeGreaterThan(10);

    // 스킵 = 재생 창을 지금으로 당긴다(실서버와 같은 계약).
    await post(`/api/matches/${created.id}/skip`, { phase: "FIRST_HALF" });
    const half = await pollUntil(created.id, (m) => m.state === "HALFTIME");
    expect(half.clock?.phase).toBe("HALFTIME");

    await post(`/api/matches/${created.id}/halftime`, { substitutions: [] });
    await post(`/api/matches/${created.id}/resume`);
    await pollUntil(created.id, (m) => m.state === "SECOND_HALF");

    const h2 = await get<{ tickSnapshots: unknown[] }>(`/api/matches/${created.id}/halves/2/log`);
    expect(h2.tickSnapshots.length).toBeGreaterThan(1000);

    await post(`/api/matches/${created.id}/skip`, { phase: "SECOND_HALF" });
    const done = await pollUntil(created.id, (m) => m.state === "FINISHED");
    expect(done.scoreHome).not.toBeNull();
    expect(done.scoreAway).not.toBeNull();

    const result = await get<{ result: string; pointsAwarded: number }>(
      `/api/matches/${created.id}/result`,
    );
    expect(["WIN", "DRAW", "LOSS"]).toContain(result.result);
    expect(result.pointsAwarded).toBeGreaterThan(0);
  }, 40_000);

  it("후반 스코어는 FINISHED 전까지 안 나온다 — 재생 중 스포일러 금지(실서버와 같은 규칙)", async () => {
    await login();
    const m = await post<MatchDetailish>("/api/matches", {});
    await post(`/api/matches/${m.id}/kickoff`);
    const live = await pollUntil(m.id, (x) => x.state === "FIRST_HALF");
    expect(live.scoreHome).toBeNull();
    expect(live.scoreAway).toBeNull();
  }, 30_000);

  it("진행 중 매치가 있으면 새 매치는 409 다 — 잠금(#217)이 데모에서도 성립한다", async () => {
    await login();
    await post("/api/matches", {});
    await expect(post("/api/matches", {})).rejects.toMatchObject({ code: "MATCH_IN_PROGRESS" });
  });

  it("이 데모가 다루지 않는 경로는 404 이지 네트워크 실패가 아니다", async () => {
    await login();
    await expect(get("/api/nope/nope")).rejects.toBeInstanceOf(ApiError);
    // 반면 비워 둔 메타는 **빈 응답**이다 — 화면 하나가 흰 화면이 되는 것보다 낫다.
    await expect(get("/api/notices/active")).resolves.toEqual([]);
  });

  it("미오픈 유닛(#443)은 뽑기 풀에 들어가지 않는다 — 정적 호스팅엔 서버 게이트가 없다", async () => {
    await login();
    const { SEED_PLAYERS, OPEN_PLAYERS } = await import("./data");
    const hidden = SEED_PLAYERS.filter((p) => p.active === false);
    expect(hidden.length).toBeGreaterThan(0); // 표본이 없으면 이 계약은 공허하다
    for (const p of hidden) expect(OPEN_PLAYERS.some((o) => o.id === p.id)).toBe(false);
  });
});
