import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { jerseyNumbers } from "../src/match/viewer-skins";
import { ARENA_HIGH, ARENA_LOW, HIGH_IDS, LOW_IDS, MATCH_ID, XI, auth, hasArtMapping, mockApi } from "./p285-fixture";

/**
 * #285 실화면 계약 — hero 확정 2026-07-29.
 *
 *  ① **브리핑 상단 줄 제거**: 타이머·"만료돼도 진행 가능"·중복 상대명·봇 안내문이 사라진다.
 *     필수 정보인 **[상대 정보] 진입점만** 남아 팀시트 전력 줄(이미 상대 이름·전력이 있는 곳)에
 *     녹아든다. 시트 내용은 그대로다.
 *  ② **골드 이하 얼굴 0**: 덱 보드·벤치·보유 선수 시트·선수별 지시 목록·경기장 토큰 — 어디서도
 *     캐릭터 아트를 그리지 않는다. 다이아 이상은 유지.
 *
 * ⚠️ 판정은 **실제로 그려진 것**으로 한다. `data-avatar-kind` 는 CharAvatar 가 자기 렌더 경로를
 * 스스로 말하는 값이라 DOM 유무 검사보다 강하고, 경기장은 캔버스라 **픽셀**을 읽는다.
 * ⚠️ 라우트 매칭은 오리진 앵커(url.pathname) — 상대 글롭은 vite 소스 요청까지 삼켜 흰 화면이 된다.
 */
const repoRoot = new URL("../../../", import.meta.url).pathname;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 1000 };
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 화면에 그려진 아바타를 전부 걷어 온다 — id 별 렌더 경로. */
async function avatars(page: Page) {
  return page.$$eval("[data-testid^='char-avatar-']", (els) =>
    els.map((el) => ({
      id: (el.getAttribute("data-testid") ?? "").replace("char-avatar-", ""),
      kind: (el as HTMLElement).dataset.avatarKind ?? "",
      policy: (el as HTMLElement).dataset.artPolicy ?? "",
      bg: getComputedStyle(el).backgroundImage,
    })),
  );
}

/** 정책 위반 = 임계 아래 등급인데 아트를 그린 아바타. */
function violations(list: Array<{ id: string; kind: string; bg: string }>) {
  return list
    .filter((a) => LOW_IDS.includes(a.id))
    .filter((a) => a.kind === "unit" || a.kind === "character" || a.kind === "placeholder" || a.bg !== "none")
    .map((a) => `${a.id}(${a.kind}/${a.bg})`);
}

test.describe("② 아이콘 노출 정책 — 골드 이하는 어디서도 얼굴이 없다", () => {
  test("표본 점검: 골드 이하 표본이 **실제로 매핑돼 있다**(계약이 공허하지 않다)", () => {
    expect(LOW_IDS.length).toBeGreaterThan(3);
    const mapped = LOW_IDS.filter(hasArtMapping);
    expect(mapped.length, "매핑이 붙은 골드 이하 표본 — 0 이면 '아트가 없어서 안 뜬 것'이라 계약이 무의미")
      .toBe(LOW_IDS.length);
    expect(HIGH_IDS.filter(hasArtMapping).length).toBeGreaterThan(1);
  });

  for (const [label, vp] of [["390", PHONE], ["desktop", DESKTOP]] as const) {
    test(`덱 화면(${label}): 보드·벤치 어디에도 골드 이하 얼굴 0, 다이아 이상은 유지`, async ({ page }) => {
      await mockApi(page);
      await auth(page);
      await page.setViewportSize(vp);
      await page.goto("/deck");
      await expect(page.getByTestId("deck-editor")).toBeVisible();
      // 대조군이 얼굴을 얻을 때까지 기다린다 — 로딩 중 스냅샷은 "정책이 먹었다"를 거짓 증명한다.
      await page.waitForFunction(
        (ids) => ids.some((id) => {
          const el = document.querySelector(`[data-testid="char-avatar-${id}"]`) as HTMLElement | null;
          return el?.dataset.avatarKind === "unit" || el?.dataset.avatarKind === "character";
        }),
        HIGH_IDS, { timeout: 15_000 },
      );

      const list = await avatars(page);
      expect(violations(list), "보드/벤치에 남은 골드 이하 얼굴").toEqual([]);
      // 숨김은 **정책 때문**이라고 화면이 말한다(아트 누락과 구분 — 원인이 뒤바뀌면 회귀를 못 잡는다).
      const low = list.filter((a) => LOW_IDS.includes(a.id));
      expect(low.length, "골드 이하가 화면에 실제로 있다").toBeGreaterThan(2);
      expect(low.filter((a) => a.policy !== "hidden"), "정책 표시 없는 골드 이하").toEqual([]);
    });
  }

  test("보유 선수 시트: 골드 이하 얼굴 0 — 등급색 이니셜로 읽힌다", async ({ page }) => {
    await mockApi(page);
    await auth(page);
    await page.setViewportSize(DESKTOP);
    await page.goto("/deck");
    await expect(page.getByTestId("deck-editor")).toBeVisible();
    await page.getByTestId("pool-sheet-open").click();
    await expect(page.getByTestId("player-pool")).toBeVisible();
    await page.waitForTimeout(500);

    const list = await avatars(page);
    expect(violations(list), "시트에 남은 골드 이하 얼굴").toEqual([]);
    // 시트는 전 카탈로그를 그린다 → 골드 이하 표본이 대량으로 들어온다(공허참 방지).
    const hidden = list.filter((a) => a.policy === "hidden");
    expect(hidden.length, "시트에서 정책으로 숨긴 아바타 수").toBeGreaterThan(20);
  });

  test("브리핑 선수별 지시 목록: 골드 이하 얼굴 0", async ({ page }) => {
    await mockApi(page);
    await auth(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("briefing-panel")).toBeVisible();
    await page.waitForFunction(
      (ids) => ids.some((id) => {
        const el = document.querySelector(`[data-testid="char-avatar-${id}"]`) as HTMLElement | null;
        return el?.dataset.avatarKind === "unit" || el?.dataset.avatarKind === "character";
      }),
      HIGH_IDS, { timeout: 15_000 },
    );
    expect(violations(await avatars(page))).toEqual([]);
  });

  test("경기장 토큰: 골드 이하는 팀색 원 + 등번호, 다이아 이상은 얼굴", async ({ page }) => {
    const log = JSON.parse(readFileSync(`${repoRoot}packages/engine/dev-viewer/match-log.json`, "utf8"));
    const snaps = log.tickSnapshots as Array<{ players?: Array<{ playerId: string }>; ballOwner?: string }>;
    const order: string[] = [];
    for (const s of snaps) for (const p of s.players ?? []) if (!order.includes(p.playerId)) order.push(p.playerId);
    // 22칸 = 서로 다른 22개 id(중복 금지 — 픽스처 주석 참조). 골드 이하 14 + 다이아 이상 8.
    const pool = [...ARENA_LOW, ...ARENA_HIGH];
    expect(new Set(pool).size, "경기장 표본 id 는 전부 달라야 한다").toBe(pool.length);
    expect(order.length, "로그에 22명이 등장한다").toBeLessThanOrEqual(pool.length);
    const remap = new Map(order.map((old, i) => [old, pool[i]!]));
    for (const s of snaps) {
      for (const p of s.players ?? []) p.playerId = remap.get(p.playerId)!;
      if (s.ballOwner && remap.has(s.ballOwner)) s.ballOwner = remap.get(s.ballOwner)!;
    }

    await auth(page);
    await mockApi(page);
    await page.route((url) => /\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname), (route) => route.fulfill(json(log)));
    const now = Date.now();
    await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
      route.fulfill(json({
        id: MATCH_ID, state: "HALFTIME", scoreH1Home: 1, scoreH1Away: 0, scoreHome: 1, scoreAway: 0,
        createdAt: "2026-07-29T00:00:00Z", opponent: { name: "ㅅㄷㄴ" },
        clock: {
          phase: "HALFTIME",
          kickoffAt: new Date(now - 600_000).toISOString(),
          phaseStartAt: new Date(now - 13_000).toISOString(),
          phaseEndsAt: new Date(now + 47_000).toISOString(),
          serverNow: new Date(now).toISOString(),
          halfRealMs: 180_000, halftimeMs: 60_000, seekForwardBlocked: true, seekGraceMs: 1_500,
        },
      })));

    await page.setViewportSize(DESKTOP);
    await page.goto(`/match/${MATCH_ID}`);
    await page.getByRole("tab", { name: "경기장면" }).click();
    await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.ready?.() === true, null, { timeout: 20_000 });
    await page.evaluate(() => {
      const v = (window as never as ViewerWin).__viewer!;
      v.autoPace(false);
      v.setViewMode("fix");
      v.seek(900);
    });
    await page.waitForTimeout(400);

    /*
     * 얼굴 유무 판정은 **임계 없이** 한다: 같은 프레임을 두 번 그려 비교한다.
     *   A = 앱이 실제로 넘긴 스킨
     *   B = **등번호만** 실은 스킨(얼굴이 하나도 없는 상태를 강제로 만든 것)
     * 토큰 패치 지문이 A==B 면 그 자리엔 얼굴이 없다. 색 개수·픽셀 수 같은 임계를 쓰면
     * 피치 줄무늬·궤적선이 패치에 섞여 잡음이 지배한다(실제로 첫 시도가 그래서 전원 실패했다).
     *
     * ⚠️ 등번호는 두 상태 모두 실어야 한다 — 안 그러면 번호가 바뀌어 전 토큰의 지문이 달라진다.
     */
    const probeFn = () =>
      page.evaluate(() => {
        const v = (window as never as ViewerWin).__viewer!;
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d")!;
        // 패치는 **토큰 안**으로 좁게 잡는다. 넓게 잡으면 붙어 선 옆 토큰의 얼굴이 패치에 섞여
        // "이 토큰에 얼굴이 있다"로 오판한다(실측: HALF=14 에서 9건 오탐).
        const HALF = 7;
        return v.curPlayers().map((p) => {
          const x0 = Math.max(0, Math.round(p.px) - HALF), y0 = Math.max(0, Math.round(p.py) - HALF);
          const w = Math.min(HALF * 2, canvas.width - x0), h = Math.min(HALF * 2, canvas.height - y0);
          const d = ctx.getImageData(x0, y0, w, h).data;
          let sum = 0, team = 0;
          const fp: number[] = [];
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            if ((b > r + 35 && b > g + 15) || (r > b + 35 && r > g + 35)) team++;
            sum += r * 3 + g * 5 + b * 7;
            if ((i / 4) % 17 === 0) fp.push(r, g, b);
          }
          return { id: p.id, team, fingerprint: `${sum}:${fp.join(",")}` };
        });
      });

    const withApp = await probeFn();
    expect(withApp.length, "22명이 그려진다").toBeGreaterThanOrEqual(22);

    await page.evaluate((nums) => {
      const v = (window as never as ViewerWin).__viewer!;
      v.setSkin({ atlases: [], byPlayer: {}, nums });
      v.seek(900);
    }, jerseyNumbers(log));
    await page.waitForTimeout(300);
    const numbersOnly = await probeFn();

    const bare = new Map(numbersOnly.map((t) => [t.id, t.fingerprint]));
    const faced = withApp.filter((t) => bare.get(t.id) !== t.fingerprint).map((t) => t.id);
    // **대조군이 먼저다** — 다이아 이상이 실제로 달라져야 이 판정법이 얼굴을 감지한다는 증거가 된다.
    const facedHigh = faced.filter((id) => ARENA_HIGH.includes(id));
    expect(facedHigh.length, "다이아 이상이 얼굴을 얻는다(판정법이 유효하다는 증거)").toBeGreaterThan(0);

    const facedLow = faced.filter((id) => ARENA_LOW.includes(id));
    expect(facedLow, "경기장에 얼굴이 남은 골드 이하 토큰").toEqual([]);

    // **토큰이 사라지면 안 된다** — 얼굴을 빼는 것이지 선수를 지우는 게 아니다(#218 AC2 계승).
    const low = withApp.filter((t) => ARENA_LOW.includes(t.id));
    expect(low.length, "골드 이하 표본이 화면에 있다").toBeGreaterThan(9);
    expect(low.filter((t) => t.team < 20).map((t) => t.id), "안 보이는 골드 이하 토큰").toEqual([]);
  });
});

test.describe("① 브리핑 상단 줄 — 필수 정보만 남기고 걷어낸다", () => {
  async function openBriefing(page: Page, vp: { width: number; height: number }) {
    await mockApi(page);
    await auth(page);
    await page.setViewportSize(vp);
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("briefing-panel")).toBeVisible();
  }

  test("타이머·만료 안내·중복 상대명·봇 안내문이 본문에서 사라진다", async ({ page }) => {
    await openBriefing(page, DESKTOP);
    const panel = page.getByTestId("briefing-panel");
    await expect(page.getByTestId("briefing-timer")).toHaveCount(0);
    await expect(panel).not.toContainText("만료돼도 진행 가능");
    // 봇 안내문 = 시트 안에만 남는다(정보를 지우는 게 아니라 옮기는 것).
    await expect(panel.getByText(MATCH_ANALYSIS, { exact: false })).toHaveCount(0);
  });

  test("[상대 정보] 진입점은 전력 줄에 살아 있고, 시트 내용은 그대로다", async ({ page }) => {
    await openBriefing(page, DESKTOP);
    const trigger = page.getByTestId("opp-sheet-open");
    await expect(trigger).toBeVisible();

    // **전력 줄 안에** 있다 = 상대 이름·전력이 이미 있는 곳에 녹였다(따로 뜨는 줄이 아니다).
    const inPowerRow = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="opp-sheet-open"]');
      const row = document.querySelector('[data-testid="sheet-power"]');
      return !!btn && !!row && row.contains(btn);
    });
    expect(inPowerRow, "[상대 정보]가 전력 줄 안에 있다").toBe(true);

    await trigger.click();
    await expect(page.getByTestId("opp-sheet")).toBeVisible();
    await expect(page.getByTestId("opponent-analysis")).toContainText(MATCH_ANALYSIS);
    await expect(page.getByTestId("mark-opp-0")).toBeVisible();
  });

  test("상단 줄이 빠진 만큼 아래가 위로 올라온다(세로 예산 회수)", async ({ page }) => {
    await openBriefing(page, PHONE);
    await expect(page.getByTestId("team-sheet-bar")).toBeVisible();
    /*
     * **절대 좌표가 아니라 패널 안 상대 위치**를 잰다 — 앱바·헤더 높이가 바뀌면 절대값 임계는
     * 이 계약과 무관하게 깨진다(그러면 다음 사람이 임계를 올려 계약을 무력화한다).
     * 재는 것: 브리핑 패널이 시작한 곳부터 팀시트 바까지의 간격 = 상단 chrome 두께.
     */
    const gap = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="briefing-panel"]');
      const bar = document.querySelector('[data-testid="team-sheet-bar"]');
      if (!panel || !bar) return -1;
      return Math.round(bar.getBoundingClientRect().top - panel.getBoundingClientRect().top);
    });
    expect(gap, "패널·팀시트 바 둘 다 있어야 측정이 성립한다").not.toBe(-1);
    // 개편 전 실측(390×844, before 캡처 시점) = 44px 짜리 메타 줄 + 간격. 그 줄이 사라지면
    // 팀시트 바가 패널 최상단(스티키 오프셋 위)으로 올라온다. 하한을 두지 않는 이유는
    // 바가 sticky 라 음수가 정상이기 때문 — 재는 것은 **줄었나**이지 절대 위치가 아니다.
    expect(gap, `상단 chrome 두께(before ${BEFORE_META_GAP}px)`).toBeLessThan(BEFORE_META_GAP);
  });
});

/** 개편 전 실측값 — 아래 "measure" 스펙이 같은 절차로 뽑는다(눈대중 아님). */
const BEFORE_META_GAP = 44;
const MATCH_ANALYSIS = "ㅅㄷㄴ 감독의 실제 팀입니다";

interface ViewerWin {
  __viewer?: {
    ready(): boolean;
    autoPace(on: boolean): void;
    setViewMode(m: string): void;
    setSkin(p: unknown): void;
    seek(t: number): void;
    curPlayers(): Array<{ id: string; px: number; py: number }>;
  };
}

// 미사용 경고 방지 — XI 는 픽스처가 11명을 보장한다는 사실을 이 스펙이 함께 진다.
test("픽스처 정합: 선발 11명", () => expect(XI).toHaveLength(11));
