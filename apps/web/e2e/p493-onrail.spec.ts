import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { skipSplash } from "./splash-mock";

/**
 * #493 W7-v3 — **온레일 튜토리얼** E2E (route-mock 전용, 백엔드 무접촉).
 *
 * SoT = `evidence/493/W7v3-scenario-storyboard.html`(hero 승인). hero 지시의 핵심은 자유도가
 * 아니라 **강제**다: *"거의 정해진 화면에서 유저가 선택할 여유가 없이 강제해야돼."*
 *
 * 그래서 이 스펙이 지키는 것은 "안내가 뜬다"가 아니라 **네 가지 성질**이다:
 *  ① **막는다** — 허용 대상 밖은 실제로 눌리지 않는다(코치마크와 갈리는 지점. `TutorialOverlay`
 *     의 딤은 `pointer-events:none` 이라 그걸 그대로 베꼈으면 이 계약이 죽는다).
 *  ② **행동을 요구한다** — 행동형 스텝에는 [다음]이 없고, 그 행동이 와야 넘어간다.
 *  ③ **기다리지 버리지 않는다** — 대상이 아직 없으면 hold(각본에 적힌 스텝만 넘어간다).
 *  ④ **가두지 않는다** — 어느 스텝에서나 탈출구가 있고, 나갔다 오면 그 스텝부터 이어진다.
 *
 * ⚠️ 라우트 매칭은 **오리진 앵커**(pathname 술어)로 한다. glob 으로 잡으면 vite 소스까지 먹어
 * 흰 화면이 된다(모듈 CLAUDE.md 규율).
 */

const USER_ID = "u493r";
const MATCH_ID = "m493r";

/**
 * 관전 무대가 실제로 서려면 **진짜 로그**가 있어야 한다(아래 라우트 주석).
 *
 * ⚠️ `packages/engine/dev-viewer/match-log.json`(다른 스펙들이 쓰는 것)은 **gitignore 생성물**이라
 * 이 리포를 갓 체크아웃한 트리에는 없다. 그러면 스펙이 화면 결함이 아니라 `ENOENT` 로 죽는다 —
 * apps/web 안에 이미 커밋돼 있는 픽스처를 쓴다(그쪽이 이 모듈의 소유이기도 하다).
 */
const HALF_LOG = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
) as unknown;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), active: true,
});
const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70), P("DF1", "수비하나", "DF", "GOLD", 76),
  P("DF2", "수비둘", "DF", "SILVER", 68), P("DF3", "수비셋", "DF", "SILVER", 64),
  P("DF4", "수비넷", "DF", "BRONZE", 55), P("MF1", "미드하나", "MF", "DIA", 84),
  P("MF2", "미드둘", "MF", "GOLD", 74), P("MF3", "미드셋", "MF", "SILVER", 66),
  P("MF4", "미드넷", "MF", "SILVER", 61), P("FW1", "공격하나", "FW", "LEGEND", 90),
  P("FW2", "공격둘", "FW", "GOLD", 72), P("FW3", "공격셋", "FW", "SILVER", 69),
];

/**
 * 선발 **10명** — 한 자리를 비워 둔다.
 *
 * ⚠️ 의도적이다: `auto-fill` 은 **빈 자리가 있을 때만** 뜨고(#455 A3 `hasEmptySlotGap`), S2 의
 * 첫 스텝이 바로 그 버튼이다. 11명으로 깔면 그 스텝은 hold 도 아니고 skip 으로 지나가 버려서
 * "AUTO 를 누르게 한다"는 시나리오가 **한 번도 검사되지 않는다**.
 */
const TEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1"];

interface Harness {
  /** 서버가 들고 있는 덱(PUT 이 갱신). */
  deck: { formation: string; slots: unknown[]; teamPrompt: string | null };
  /** `POST /api/matches` 요청 바디 기록 — `{tutorial:true}` 계약의 증거. */
  creates: unknown[];
  /** 매치 상태(스킵/진행). */
  matchState: string;
}

function matchDetail(h: Harness) {
  return {
    id: MATCH_ID,
    state: h.matchState,
    mode: "practice",
    // #493 W6-v3 additive — 온레일의 재생 정지·스킵 잠금이 이 불리언에 걸린다.
    tutorial: true,
    auto: false,
    opponent: { name: "봇 FC" },
    createdAt: "2026-08-13T00:00:00Z",
    scoreH1Home: null, scoreH1Away: null, scoreHome: null, scoreAway: null, result: null,
  };
}

async function mockApi(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = {
    deck: {
      formation: "4-4-2",
      slots: TEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
      teamPrompt: null,
    },
    creates: [],
    matchState: "FIRST_HALF",
    ...over,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    const p = url.pathname;

    if (p === "/api/me") {
      return route.fulfill(json({
        user: { id: USER_ID, nickname: "온레일", tutorialDone: true },
        wallet: { points: 5000, gems: 0 },
        records: { played: 0, wins: 0, draws: 0, losses: 0 },
        rating: 1000,
        // W6-v3: 0 인 종류도 키가 존재한다.
        coupons: { FREE_ENHANCE: 1, FREE_TRADE_RUSH: 1, FIRST_TRADE_EPIC: 1 },
      }));
    }
    if (p === "/api/players") return route.fulfill(json(PLAYERS));
    if (p === "/api/presets") return route.fulfill(json([]));
    if (p === "/api/presets/team") {
      return route.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null }))));
    }
    if (p === "/api/relations") return route.fulfill(json({ morale: 60, streak: 0, players: [] }));
    if (p === "/api/conditions/today") {
      return route.fulfill(json(Object.fromEntries(TEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15]))));
    }
    if (p === "/api/growth/choices") return route.fulfill(json({ choices: [] }));
    if (p === "/api/me/active-match") {
      return route.fulfill(json({ match: null, locked: false, abandonable: false }));
    }
    if (p === "/api/deck") {
      if (req.method() === "PUT") {
        const b = req.postDataJSON();
        h.deck = { formation: b.formation, slots: b.slots, teamPrompt: b.teamPrompt ?? null };
      }
      return route.fulfill(json(h.deck));
    }
    if (p === "/api/matches" && req.method() === "POST") {
      h.creates.push(req.postDataJSON() ?? {});
      return route.fulfill(json(matchDetail(h)));
    }
    if (p === `/api/matches/${MATCH_ID}`) return route.fulfill(json(matchDetail(h)));
    /*
     * ⚠️ **진짜 로그를 준다.** 캐치올 `{}` 을 먹이면 뷰어가 로드에서 던져 무대 전체가
     * `viewer-visual-error-half1` 로 대체되고, 그러면 투어가 겨누는 손잡이(무대·시크바·컨트롤·
     * [스킵])가 **하나도 렌더되지 않는다** — 계약이 "온레일이 안 뜬다"로 실패해 원인을 엉뚱한
     * 곳으로 가리킨다. `p421-skip-report` 가 같은 이유로 같은 픽스처를 쓴다.
     */
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(p)) return route.fulfill(json(HALF_LOG));
    return route.fulfill(json({}));
  });
  return h;
}

/** 온보딩을 막 끝낸 계정 = 토큰 + 가이드 pending 래치(제안 모달의 발화 조건). */
async function seedNewUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_user");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);
}

/** 홈 [게임 시작] → 제안 모달 [시작하기] → 온레일이 덱에서 시작한다. */
async function startOnRail(page: Page) {
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await page.getByTestId("practice-tutorial-accept").click();
  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByTestId("onrail-overlay")).toBeVisible();
}

// ── ① 진입 ────────────────────────────────────────────────────────────────

test("① [시작하기] = 덱 화면으로 데려가 온레일 첫 스텝이 뜬다", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-auto");
  await expect(page.getByTestId("onrail-highlight")).toBeVisible();
});

test("① [건너뛰기] = 온레일이 시작되지 않고 다시 묻지 않는다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-decline").click();

  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByTestId("onrail-overlay")).toHaveCount(0);
  expect(h.creates).toHaveLength(0);

  // 재노출 없음(스토리보드 조정 ⑥).
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
});

// ── ② 강제(막는다) ────────────────────────────────────────────────────────

test("② ⚠️ 허용 대상 밖은 **실제로 눌리지 않는다** — 딤이 입력을 막는다", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  // 딤이 입력을 막는 판으로 서 있다(코치마크의 `pointer-events:none` 딤과 갈리는 지점).
  const dims = page.getByTestId("onrail-dim");
  expect(await dims.count()).toBeGreaterThan(0);
  for (const d of await dims.all()) {
    await expect(d).toHaveAttribute("data-blocking", "true");
  }

  /*
   * 속성만 보면 CSS 를 지워도 통과한다("검사하는 척") — 그래서 **두 겹**으로 잰다.
   *
   * ⓐ 히트테스트: 구멍도 말풍선도 아닌 자리를 눌렀을 때 화면에 닿는 것은 딤이어야 한다.
   *
   * ⚠️ 고정 좌표(예: [저장] 버튼 위)를 쓰면 안 된다 — 온레일은 대상이 접혀 있으면 **화면을
   * 스크롤해 끌어오므로**(OnRailOverlay 의 `scrollIntoView`) 그 사이 다른 요소가 뷰포트 밖으로
   * 밀려나고, `elementFromPoint` 가 null 을 돌려주며 계약이 **제품 결함이 아닌 이유로** 깨진다
   * (실측으로 밟았다). 그래서 지금 화면 상태에서 **자유로운 지점을 찾아서** 잰다.
   */
  const hit = await page.evaluate(() => {
    const hole = document.querySelector('[data-testid="onrail-highlight"]')?.getBoundingClientRect();
    const bubble = document.querySelector('[data-testid="onrail-bubble"]')?.getBoundingClientRect();
    const inside = (r: DOMRect | undefined, x: number, y: number) =>
      !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const candidates = [
      [4, 4], [W - 4, 4], [4, H - 4], [W - 4, H - 4], [W / 2, 4], [W / 2, H - 4],
    ] as [number, number][];
    for (const [x, y] of candidates) {
      if (inside(hole, x, y) || inside(bubble, x, y)) continue;
      const el = document.elementFromPoint(x, y);
      return el?.getAttribute("data-testid") ?? el?.tagName ?? null;
    }
    return "NO_FREE_POINT";
  });
  expect(hit, "허용 대상 밖의 지점은 딤이 받아야 한다").toBe("onrail-dim");

  /*
   * ⓑ **행동**: 허용 대상이 아닌 버튼은 실제로 눌리지 않는다. Playwright 의 actionability 가
   *    "딤이 포인터 이벤트를 가로챈다"로 거절해야 한다 — 여기가 통과하면 딤은 그림일 뿐이다.
   */
  await expect(page.getByTestId("save-deck").click({ timeout: 2500 })).rejects.toThrow(
    /intercepts pointer events|Timeout/,
  );
});

test("② 허용 대상은 **구멍이라 그대로 눌린다** — 덮어 버리면 온레일이 자기 발을 밟는다", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  const auto = page.getByTestId("auto-fill");
  const box = await auto.boundingBox();
  expect(box).not.toBeNull();
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(hit).toBe("auto-fill");
});

// ── ③ 행동형 ──────────────────────────────────────────────────────────────

test("③ 행동형 스텝에는 [다음]이 없다 — 넘어가는 문은 그 행동뿐이다", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  await expect(page.getByTestId("onrail-await")).toBeVisible();
  await expect(page.getByTestId("onrail-next")).toHaveCount(0);
});

test("③ AUTO → 선수 → 한마디 → 저장 순서로만 넘어간다(S2 전 구간)", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  // ① AUTO
  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");

  // ② 지정 선수 — 덱 첫 슬롯(GK1)을 겨눈다.
  await expect(page.getByTestId("onrail-highlight")).toBeVisible();
  await page.getByTestId("token-GK1").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-prompt");

  // ③ 한마디 — 빈 문자열은 넘어가지 않는다(행동이 아니라 통과다).
  const input = page.getByTestId("rail-prompt-input");
  await input.fill("");
  await input.blur();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-prompt");
  await input.fill("오늘 너만 믿는다");
  await input.blur();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-save");

  // ④ 저장 — 성공해야 넘어간다.
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-done");
  /* 저장이 **실제로 서버에 닿았다** — AUTO 가 빈 자리를 채워 선발이 11 이 됐고(그래야 [저장]이
     열린다), 한마디가 그 슬롯에 실렸다. 개수를 통짜로 세지 않는 이유: `fillEmptySlots` 는 벤치도
     채우므로 총 길이는 보유 인원의 함수라 이 계약의 축이 아니다. */
  const starters = (h.deck.slots as { role: string; promptText?: string | null }[]).filter(
    (x) => x.role === "starter",
  );
  expect(starters).toHaveLength(11);
  expect(starters.some((x) => (x.promptText ?? "").includes("오늘 너만 믿는다"))).toBe(true);
});

// ── ④ 경기 시작(S2 → S3) ─────────────────────────────────────────────────

test("④ [경기 시작] = `{tutorial:true}` 로 만들고 그 매치로 간다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  await page.getByTestId("auto-fill").click();
  await page.getByTestId("token-GK1").click();
  const input = page.getByTestId("rail-prompt-input");
  await input.fill("오늘 너만 믿는다");
  await input.blur();
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-done");

  await page.getByTestId("onrail-next").click();
  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]).toMatchObject({ tutorial: true });
});

// ── ⑤ 재개·탈출 ──────────────────────────────────────────────────────────

test("⑤ 새로고침해도 **그 스텝부터** 이어진다(중도 이탈)", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");

  await page.reload();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");
});

test("⑤ [나중에] = 홈으로 나가되 진행도는 남고, 홈에서 이어하기가 뜬다", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);
  await startOnRail(page);

  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");

  // 라벨이 동작과 같은 말인지도 같이 본다 — 진행도를 남기는 문에 "그만두기"라고 쓰면 거짓말이다.
  await expect(page.getByTestId("onrail-exit")).toHaveText("나중에");
  await page.getByTestId("onrail-exit").click();
  await expect(page).toHaveURL(/\/home$/);

  // 갇힘 방지의 반대편 — 돌아갈 문이 있어야 나가는 것이 안전하다.
  const resume = page.getByTestId("onrail-bubble");
  await expect(resume).toHaveAttribute("data-step-id", "onrail-resume");
  // 이어하기 카드의 탈출은 **진짜 그만두기**다(그 카드가 벽이 되지 않게).
  await expect(resume.getByTestId("onrail-exit")).toHaveText("그만두기");
  await resume.getByTestId("onrail-next").click();
  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");
});

// ── ⑥ 경기 화면 투어(S3) ────────────────────────────────────────────────

test("⑥ 투어 중에는 [스킵]이 잠기고, 투어가 끝나면 풀린다", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);

  // 덱 구간을 건너뛰고 투어 첫 스텝에서 재개한다(각본은 스텝 단위로 저장된다).
  await page.addInitScript((uid) => {
    window.localStorage.setItem(
      `hmb.onrail.${uid}`,
      JSON.stringify({ status: "running", stepId: "match-scoreboard", matchId: "m493r" }),
    );
  }, USER_ID);

  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "match-scoreboard");
  await expect(page.getByTestId("match-skip")).toBeDisabled();
});

// ── ⑦ 폰 경로 ────────────────────────────────────────────────────────────

/**
 * ⚠️ **폰은 다른 길을 지난다 — 그리고 그게 실제 유저의 길이다.**
 *
 * 폰 덱셋팅에서는 토큰 탭이 곧 선택이 아니라 **선수 메뉴**(#455 A2)를 먼저 연다. 그 메뉴는 자기
 * 모달이라 온레일이 비켜나야 하고(`shieldFor` = hidden), 안 비켜나면 딤이 메뉴를 덮어 **거기서
 * 영영 못 나간다**. 데스크탑 계약만 두면 이 경로는 한 번도 검사되지 않는다.
 */
test.describe("⑦ 폰(390×844) — 선수 메뉴를 지나는 길", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("메뉴가 열리면 온레일이 비켜나고, [한마디 쓰기] 뒤에 다시 잡는다", async ({ page }) => {
    await mockApi(page);
    await seedNewUser(page);
    await startOnRail(page);

    await page.getByTestId("auto-fill").click();
    await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");

    await page.getByTestId("token-GK1").click();
    // 메뉴가 떴다 → 온레일은 그 위에 남아 있지 않다(남으면 메뉴를 덮는다).
    await expect(page.getByTestId("player-menu")).toBeVisible();
    await expect(page.getByTestId("onrail-overlay")).toHaveCount(0);

    await page.getByTestId("pmenu-say").click();
    await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-prompt");
    // 지시 칸은 접혀 있을 수 있다 — 온레일이 끌어와야 유저가 닿는다(다른 곳은 전부 막혀 있다).
    await expect(page.getByTestId("rail-prompt-input")).toBeInViewport();
  });
});
