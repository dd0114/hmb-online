// e2e 공용 헬퍼 — window.__viewer 훅 위의 결정론 단언 유틸.
// 픽셀/미학 판정은 여기서 하지 않는다(그건 V4 독립 QA 몫). 좌표·자막 텍스트 의미론만.
import { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// showcase 뷰어(주): goal/save/off_target/penalty/set-piece/whistle + 버그 2건.
export const VIEWER_URL = "file://" + join(here, "viewer-test.html");
// real config 뷰어(보조): 이 시드엔 없는 offside·card 커버.
export const VIEWER_REAL_URL = "file://" + join(here, "viewer-real.html");

// 피치/골 지오메트리 (default 벤치마크와 무관한 쇼케이스 데모도 동일 피치 사용).
// packages/engine/src/config.ts: pitch { width:105, height:68, goalWidth:7.32 }, goalNetDepthM:0.5.
export const PITCH_W = 105;
export const PITCH_H = 68;
export const HALF_POST = 7.32 / 2; // 3.66
export const CENTER_Y = PITCH_H / 2; // 34
export const POST_MIN = CENTER_Y - HALF_POST; // 30.34
export const POST_MAX = CENTER_Y + HALF_POST; // 37.66
export const GOAL_LINE_TOL = 1; // 골라인 ±1m 이내면 "골라인 위"
export const SHOT_BALL_SPEED = 14; // config.shotBallSpeed (m/tick)

export type Ball = { x: number; y: number };

/** 공이 "골문 안(골라인±1m & 포스트 사이)"인가 = 골처럼 보이는 위치. 선방 공이 여기 있으면 골 오인. */
export function inGoalMouth(b: Ball): boolean {
  const onLine = b.x <= GOAL_LINE_TOL || b.x >= PITCH_W - GOAL_LINE_TOL;
  const betweenPosts = b.y >= POST_MIN && b.y <= POST_MAX;
  return onLine && betweenPosts;
}

/** 공이 골라인 바깥(빗나감처럼 옆/뒤로 벗어남)인가. */
export function outsideGoalLine(b: Ball): boolean {
  return b.x < 0 || b.x > PITCH_W;
}

type ViewerEvent = { tick: number; minute: number; type: string; team?: string; detail?: string; xg?: number; playerId?: string };

export async function loadViewer(page: Page, url: string = VIEWER_URL): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__viewer && (window as any).__viewer.ready(), null, { timeout: 10000 });
}

/**
 * seekTick 로 이동 후 실제 재생(play)하며 정지 자막(flash=골 / situation=선방 등)이 뜰 때까지 대기,
 * 그 순간의 captions() 를 캡처한다. hold(freeze) 동안 자막이 유지돼 레이스가 없다.
 * 위치기반 배너와 달리 flash/situation 은 재생 중 causeTick 통과 때만 발화하므로 이 경로가 필요.
 */
export async function playUntilCaption(page: Page, seekTick: number, timeout = 8000): Promise<{ flash: string; situation: string; banner: string; score: string; minute: string }> {
  await page.evaluate((t) => { const v = (window as any).__viewer; v.seek(t); v.play(); }, seekTick);
  const handle = await page.waitForFunction(
    () => { const c = (window as any).__viewer.captions(); return c.flash || c.situation ? c : null; },
    null,
    { timeout }
  );
  const caps = (await handle.jsonValue()) as { flash: string; situation: string; banner: string; score: string; minute: string };
  await page.evaluate(() => (window as any).__viewer.pause());
  return caps;
}

/**
 * seekTick 부터 재생하며 situation 상황카드에 substr 가 포함될 때까지 대기 → 그 captions().
 * 세트피스(코너/스로인) 정지 자막처럼 특정 텍스트를 겨냥할 때(선행 이벤트 자막과 구분).
 */
export async function playUntilSituationContains(page: Page, seekTick: number, substr: string, timeout = 8000): Promise<{ flash: string; situation: string; banner: string; score: string; minute: string }> {
  await page.evaluate((t) => { const v = (window as any).__viewer; v.autoPace(false); v.seek(t); v.play(); }, seekTick);
  const handle = await page.waitForFunction(
    (s) => { const c = (window as any).__viewer.captions(); return c.situation && c.situation.includes(s) ? c : null; },
    substr,
    { timeout }
  );
  const caps = (await handle.jsonValue()) as { flash: string; situation: string; banner: string; score: string; minute: string };
  await page.evaluate(() => (window as any).__viewer.pause());
  return caps;
}

/** 이벤트 티커에 렌더된 카드(🟨/🟥) 항목 텍스트들. captions() 에 없는 토스트성 이벤트 검증용. */
export async function tickerCards(page: Page): Promise<string[]> {
  return page.$$eval(".ev-card", (els) => els.map((e) => (e.textContent || "").trim()));
}

export async function events(page: Page): Promise<ViewerEvent[]> {
  return page.evaluate(() => (window as any).__viewer.events());
}

/** 특정 type(옵션 detail)의 이벤트만. */
export async function eventsOfType(page: Page, type: string, detail?: string): Promise<ViewerEvent[]> {
  const all = await events(page);
  return all.filter((e) => e.type === type && (detail === undefined || e.detail === detail));
}

/** seek(tick) 후 원시 스냅샷 공(cur().ball). */
export async function ballAtTick(page: Page, tick: number): Promise<Ball> {
  return page.evaluate((t) => { (window as any).__viewer.seek(t); return (window as any).__viewer.cur().ball; }, tick);
}

export type ScreenGeom = {
  cw: number; ch: number;
  ball: { px: number; py: number; r: number };
  owner: { px: number; py: number; r: number } | null;
};

/** seek(tick) 후 마지막 draw()의 화면좌표 기하(캔버스px). taker/공 클리핑 계약검증용. */
export async function screenGeomAt(page: Page, tick: number): Promise<ScreenGeom> {
  return page.evaluate((t) => {
    const v = (window as any).__viewer;
    v.autoPace(false); // 전체뷰 고정(줌으로 가려지는 것 없이 실제 배치 검사).
    v.seek(t);
    return v.screenGeom();
  }, tick);
}

/**
 * 세트피스 재배치 직전 보간 프레임에서 taker(playerId)가 스팟으로 미끄러진 거리(m).
 * 데드볼 재배치는 공처럼 선수도 "컷" 해야 하므로(슬라이드=순간이동처럼 보임), 재배치 틱 직전
 * 보간(tickPos=idx-0.4)의 렌더 위치가 재배치 직전 원위치(snap[idx-1])와 거의 같아야 한다(≈0).
 */
export async function takerSlideBeforeRestart(page: Page, causeTick: number, playerId: string): Promise<number | null> {
  return page.evaluate(
    ({ causeTick, playerId }) => {
      const v = (window as any).__viewer;
      const idx = v.idxOfTick(causeTick);
      const at = (tp: number) => (v.renderPlayersAt(tp).find((p: any) => p.id === playerId) || null);
      const raw = at(idx - 1); // 재배치 직전 틱 원위치.
      const mid = at(idx - 0.4); // 재배치 직전 보간 프레임.
      if (!raw || !mid) return null;
      return Math.hypot(mid.x - raw.x, mid.y - raw.y);
    },
    { causeTick, playerId }
  );
}

/** 원 마커(center px,py, 반지름 r)가 캔버스[0..cw]×[0..ch] 안에 완전히 들어오는가. */
export function circleInside(cw: number, ch: number, c: { px: number; py: number; r: number }): boolean {
  return c.px - c.r >= 0 && c.px + c.r <= cw && c.py - c.r >= 0 && c.py + c.r <= ch;
}

/** captions() 스냅샷: 화면에 실제 표시중인 자막 텍스트(opacity>0 만). */
export async function seekCaptions(page: Page, tick: number): Promise<{ flash: string; situation: string; banner: string; score: string; minute: string }> {
  return page.evaluate((t) => { (window as any).__viewer.seek(t); return (window as any).__viewer.captions(); }, tick);
}

/**
 * 정지 시퀀스처럼 원인 상황카드를 강제 표시 후 captions().
 * 상황카드는 sitIn 애니메이션(0%→opacity0, 12%→1)이라 트리거 직후엔 opacity 0 → 보일 때까지 대기 후 캡처.
 */
export async function situationCaptions(page: Page, tick: number): Promise<{ flash: string; situation: string; banner: string; score: string; minute: string }> {
  await page.evaluate((t) => (window as any).__viewer.showSituationAt(t), tick);
  const handle = await page.waitForFunction(
    () => { const c = (window as any).__viewer.captions(); return c.situation ? c : null; },
    null,
    { timeout: 3000 }
  );
  return handle.jsonValue() as Promise<{ flash: string; situation: string; banner: string; score: string; minute: string }>;
}

/** 슛 발사틱→도착틱 구간을 분수 tickPos 로 촘촘히 샘플 → 렌더된(보간 후) 공 궤적. 순간이동 검출용. */
export async function sampleRenderedFlight(page: Page, fromTick: number, toTick: number, step = 0.1): Promise<Ball[]> {
  return page.evaluate(
    ({ fromTick, toTick, step }) => {
      const v = (window as any).__viewer;
      const a = v.idxOfTick(fromTick), b = v.idxOfTick(toTick);
      const out: { x: number; y: number }[] = [];
      for (let tp = a; tp <= b + 1e-9; tp = +(tp + step).toFixed(6)) {
        const r = v.renderAt(tp);
        out.push({ x: r.x, y: r.y });
      }
      return out;
    },
    { fromTick, toTick, step }
  );
}

/** 궤적에서 인접 샘플 최대 이동거리(m). 순간이동이면 크게 튄다. */
export function maxStep(path: Ball[]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x, dy = path[i].y - path[i - 1].y;
    m = Math.max(m, Math.hypot(dx, dy));
  }
  return m;
}

/** 골로 이어진 슛의 발사틱 찾기: 골 직전 window 틱 내 가장 가까운 shot 이벤트. */
export function launchTickOf(goalTick: number, all: ViewerEvent[], window = 4): number | null {
  const shots = all.filter((e) => e.type === "shot" && e.tick <= goalTick && e.tick >= goalTick - window);
  return shots.length ? shots[shots.length - 1].tick : null;
}
