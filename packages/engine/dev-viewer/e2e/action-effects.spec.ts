import { test, expect } from "@playwright/test";
import { loadViewer, VIEWER_REAL_URL } from "./fixture";

/**
 * #406 W5 (요구 4-2 "행동 가시화 이펙트") 계약.
 *
 * 네 행동 — **공 잡음(수신)** `pass` · **패스 실패(가로챔)** `interception` ·
 * **걷어내기** `clearance` · **태클 성공** `tackle` — 이 그 이벤트 틱에 **팀색으로** 뜬다.
 *
 * ⚠️ **리얼 픽스처로 겨냥한다.** 쇼케이스 데모(`viewer-test.html`)엔 `clearance` 가 **0건**,
 * `tackle` 이 1건뿐이라 거기서 걸면 계약이 조용히 비어 버린다(실측: showcase clearance 0 /
 * fixture-real 12). 그래서 맨 앞에 **픽스처 전제**를 단언한다 — 표본이 사라지면 초록이 아니라
 * 빨강이 나야 한다.
 *
 * ⚠️ **팀 축은 이 파일이 지키지 못한다 — `duplicate-id-render.spec.ts` 가 SoT다.**
 * 초판은 *"홈·어웨이 양쪽 표본을 태우니 방어된다"* 고 적었지만 거짓이었다: `fixture-real` 의 id 가
 * `H0..A10` 이라 `playerId[0]==="H"` 추측이 **우연히 맞는다**. 독립검증이 `fxSideOf` 를 그 추측으로
 * 되돌리고 앵커 팀 필터를 지운 변이를 태웠는데 41/41 통과하며 **생존**했다. 라이브 하프의 38%는
 * 양 팀에 같은 id 가 뛴다(#324) — 그 표본(주입 로그 `P078`) 위에서만 이 변이가 죽는다.
 * 아래 색 단언은 "이펙트가 팀색 팔레트로 칠해진다"까지만 보증한다(= 무채색 회귀 방지).
 *
 * 이 파일이 지키는 축(모양·의미):
 *   ① 방향  — 걷어내기 쐐기가 **공이 실제로 간 쪽**을 가리킨다(반대로 뒤집는 변이가 죽는다).
 *   ② 링 부호 — 수신=수축(반경 감소) / 가로챔=확산(반경 증가). 둘이 한 프레임에서 갈린다.
 *   ③ 가시성 하한 — fx 레이어 on/off 를 **같은 상태로 두 번 그려** 토큰 원판 **바깥**에서 바뀐
 *      픽셀을 센다(`tools/perceptibility.mjs` 사고방식). 초판의 "X 슬래시가 팀색이라 같은 색
 *      토큰 안에 묻혀 안 보인다"(독립검증 MAJOR-2)를 **작성 시점에 잡았을 유일한 계약**이다.
 *   ④ 토스트 가독성 — 그려진 어떤 쌍도 `dy<14 && dx<70` 이 아니다(#69 의도의 코드화, BLOCKER-1).
 */

const HOME_RGB = "59,130,246";
const AWAY_RGB = "239,68,68";
const rgbOf = (team: string) => (team === "home" ? HOME_RGB : AWAY_RGB);
const SIDES = ["home", "away"] as const;

type Ev = { tick: number; type: string; team?: string; playerId?: string };
/** `r`·`tip`·`slashL` 은 **draw() 가 실제로 쓴 값**이다(#218 "그린 쪽이 알려준다"). */
type Fx = {
  type: string; rgb: string; x: number; y: number;
  r: number | null; tip: { x: number; y: number } | null; slashL: number | null;
};

/** 행동 이펙트를 만드는 모든 이벤트 타입 — 한 이펙트만 살아 있는 표본을 고를 때 쓴다. */
const ACTION_TYPES = ["pass", "interception", "clearance", "tackle"] as const;

test.beforeEach(async ({ page }) => { await loadViewer(page, VIEWER_REAL_URL); });

/**
 * (type, team) 표본을 **같은 타입 이웃이 없는 틱**으로 고른다. 겹치면 이펙트/토스트를 이름으로
 * 찾을 때 반대 팀 것을 집을 수 있어 색 단언이 우연에 걸린다.
 */
async function pickIsolated(page: any, type: string, team: string, gap: number): Promise<Ev> {
  const picked = await page.evaluate(
    ([t, side, win]: [string, string, number]) => {
      const evs = (window as any).__viewer.events().filter((e: any) => e.type === t);
      const ticks = evs.map((e: any) => e.tick);
      for (const e of evs) {
        if (e.team !== side) continue;
        const neighbours = ticks.filter((x: number) => x !== e.tick && Math.abs(x - e.tick) <= win);
        if (neighbours.length === 0) return e;
      }
      return null;
    },
    [type, team, gap] as [string, string, number],
  );
  expect(picked, `${type}/${team} 고립 표본(±${gap}틱)`).toBeTruthy();
  return picked as Ev;
}

/**
 * **다른 행동 이펙트가 하나도 겹치지 않는** 표본을 고른다(가시성 하한 계약용).
 * fx 레이어 on/off 픽셀 차이를 한 이펙트에 귀속시키려면 그 프레임에 fx 가 하나뿐이어야 한다.
 * (유효슛 링 `shotFx` 는 별도 배열이라 레이어 토글의 영향을 받지 않는다 = 두 프레임에서 상쇄된다.)
 */
async function pickSolo(page: any, type: string, gap: number): Promise<Ev> {
  const picked = await page.evaluate(
    ([t, all, win]: [string, string[], number]) => {
      const evs = (window as any).__viewer.events();
      const others = evs.filter((e: any) => all.includes(e.type)).map((e: any) => ({ t: e.tick, ty: e.type }));
      const surge: number[] = (window as any).__viewer.surgeTicks();
      for (const e of evs.filter((x: any) => x.type === t)) {
        const near = others.filter((o: any) => !(o.ty === t && o.t === e.tick) && Math.abs(o.t - e.tick) <= win);
        if (near.length) continue;
        if (surge.some((s) => Math.abs(s - e.tick) <= win)) continue;
        return e;
      }
      return null;
    },
    [type, [...ACTION_TYPES], gap] as [string, string[], number],
  );
  expect(picked, `${type} 단독 표본(±${gap}틱에 다른 행동 없음)`).toBeTruthy();
  return picked as Ev;
}

/**
 * `startTick-1` 부터 재생해 그 타입 이펙트가 뜨면 **`frames` 프레임 더 흘린 뒤** 그 이펙트를 준다.
 *
 * ⚠️ **감지·진행·읽기를 한 `page.evaluate` 안에서** 한다. 나누면 그 사이 CDP 왕복(머신 부하에 따라
 * 수십~수백 ms)에도 rAF 의 `stepFx` 가 계속 돌아 이펙트가 늙거나 사라진다 — 수명이 `clear` 기준
 * 22프레임(≈0.37초)뿐이라 부하가 높은 순간에 계약이 "이펙트가 이미 사라짐"으로 죽는다(실측:
 * 다른 세션이 t1 을 돌리는 동안 `clear`·`tackle` 이 그 이유로 red). 재는 대상과 무관한 red 는
 * 신호를 죽이므로 창 자체를 없앤다.
 *
 * `frames > 0` 인 이유: 이펙트는 자라거나 조여드는 연출이라 **스폰 프레임이 어느 것이든 가장
 * 작다**. 관객이 보는 것은 그 다음 프레임들이다.
 */
async function playUntilFx(page: any, startTick: number, type: string, frames = 0): Promise<Fx> {
  const val = await page.evaluate(
    async ([t, ty, nf]: [number, string, number]) => {
      const v = (window as any).__viewer;
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      v.autoPace(false); v.pause(); v.seek(t - 1); v.play();
      let born = false;
      for (let i = 0; i < 900 && !born; i++) {
        await raf();
        born = v.fx().some((f: any) => f.type === ty);
      }
      v.pause();
      if (!born) return null;
      for (let i = 0; i < nf; i++) await raf();
      return v.fx().find((f: any) => f.type === ty) ?? null;
    },
    [startTick, type, frames] as [number, string, number],
  );
  expect(val, `${type} 이펙트가 ${startTick} 부근에서 살아 있어야`).toBeTruthy();
  return val as Fx;
}

test("픽스처 전제 — 네 행동 이벤트가 홈·어웨이 양쪽으로 들어 있다", async ({ page }) => {
  const summary = await page.evaluate(() => {
    const evs = (window as any).__viewer.events();
    const out: Record<string, { n: number; sides: string[] }> = {};
    for (const t of ["pass", "interception", "clearance", "tackle"]) {
      const of = evs.filter((e: any) => e.type === t);
      out[t] = { n: of.length, sides: [...new Set(of.map((e: any) => e.team))].sort() as string[] };
    }
    return out;
  });
  for (const t of ["pass", "interception", "clearance", "tackle"]) {
    expect(summary[t].n, `${t} 표본 수`).toBeGreaterThan(0);
    expect(summary[t].sides, `${t} 홈·어웨이 표본`).toEqual(["away", "home"]);
  }
});

test("걷어내기 → 쐐기(clear) 이펙트가 그 틱에 스폰되고 색이 걷어낸 팀을 따른다", async ({ page }) => {
  for (const team of SIDES) {
    const e = await pickIsolated(page, "clearance", team, 2);
    const f = await playUntilFx(page, e.tick, "clear");
    expect(f.rgb, `${team} 걷어내기 이펙트 색`).toBe(rgbOf(team));
  }
});

test("태클 성공 → 팀색 tackle 이펙트 (무채색이 아니라 어느 팀인지 읽힌다)", async ({ page }) => {
  for (const team of SIDES) {
    const e = await pickIsolated(page, "tackle", team, 2);
    const f = await playUntilFx(page, e.tick, "tackle");
    expect(f.rgb, `${team} 태클 이펙트 색`).toBe(rgbOf(team));
  }
});

test("공 잡음(pass 도착) → 수신 이펙트가 리시버 팀색으로 스폰된다", async ({ page }) => {
  for (const team of SIDES) {
    const e = await pickIsolated(page, "pass", team, 2);
    const f = await playUntilFx(page, e.tick, "pass");
    expect(f.rgb, `${team} 수신 이펙트 색`).toBe(rgbOf(team));
  }
});

test("가로챔 → steal 이펙트가 가로챈 팀 색으로 스폰된다", async ({ page }) => {
  for (const team of SIDES) {
    const e = await pickIsolated(page, "interception", team, 2);
    const f = await playUntilFx(page, e.tick, "steal");
    expect(f.rgb, `${team} 가로챔 이펙트 색`).toBe(rgbOf(team));
  }
});

/**
 * 앵커 — 이펙트는 **공이 아니라 행동 주체 위**에 뜬다.
 *
 * 표본은 걷어내기다. 그 틱의 스냅샷에서 공은 이미 걷어차여 날아가고 있어 선수와 최대 **18m**
 * 떨어진다(실측) — 앵커를 공으로 되돌리면 이 단언이 그 거리만큼 벗어난다. 태클·수신은 주체가
 * 공을 들고 있어(실측 0m) 이 축을 검사할 수 없으므로 여기에 태우지 않는다.
 */
test("걷어내기 이펙트는 공이 아니라 **걷어낸 선수** 위에 뜬다", async ({ page }) => {
  const sample = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const evs = v.events().filter((e: any) => e.type === "clearance");
    const ticks = evs.map((e: any) => e.tick);
    let best: any = null;
    for (const e of evs) {
      if (ticks.some((x: number) => x !== e.tick && Math.abs(x - e.tick) <= 2)) continue;
      v.seek(e.tick);
      const cur = v.cur();
      const p = v.curPlayers().find((q: any) => q.id === e.playerId && q.team === e.team);
      if (!p) continue;
      const d = Math.hypot(p.x - cur.ball.x, p.y - cur.ball.y);
      if (!best || d > best.d) best = { tick: e.tick, team: e.team, d, px: p.x, py: p.y, bx: cur.ball.x, by: cur.ball.y };
    }
    return best;
  });
  expect(sample, "걷어내기 표본").toBeTruthy();
  expect(sample.d, "표본이 선수↔공을 충분히 갈라야 이 계약이 성립한다").toBeGreaterThan(8);

  const f = await playUntilFx(page, sample.tick, "clear");
  const dPlayer = Math.hypot(f.x - sample.px, f.y - sample.py);
  const dBall = Math.hypot(f.x - sample.bx, f.y - sample.by);
  expect(dPlayer, `이펙트가 걷어낸 선수(${sample.px.toFixed(1)},${sample.py.toFixed(1)}) 위에`).toBeLessThan(1);
  expect(dBall, "공 위가 아니어야").toBeGreaterThan(dPlayer + 5);
});

test("이펙트는 지속 후 사라진다 (영구 잔상이 되지 않는다)", async ({ page }) => {
  for (const [type, fxType] of [["clearance", "clear"], ["tackle", "tackle"]] as const) {
    const e = await pickIsolated(page, type, "home", 2);
    await playUntilFx(page, e.tick, fxType);
    // 정지 상태에서도 rAF 는 돌아 감쇠가 진행된다 → 새 스폰 없이 자연 소멸해야 한다.
    await page.waitForFunction(
      (ty: string) => (window as any).__viewer.fx().every((f: any) => f.type !== ty),
      fxType,
      { timeout: 8000 },
    );
  }
});

/**
 * 토스트(캔버스 자막)도 같은 축이다 — 종전엔 `TACKLE`/`INTERCEPT` 가 무채색(`#cbd5e1`)이라
 * "어느 팀 행동인지"를 말하지 못했고, 걷어내기는 **토스트 자체가 없었다**.
 *
 * seek 만으로 결정론적으로 검사한다(토스트는 이벤트 틱 기준 지속이라 재생이 필요 없다).
 */
test("행동 토스트가 팀색 + 행동 주체 앵커로 그려진다 (걷어내기·태클·가로챔)", async ({ page }) => {
  for (const [type, text] of [["clearance", "CLEARED!"], ["tackle", "TACKLE"], ["interception", "INTERCEPT"]] as const) {
    for (const team of SIDES) {
      // TOAST_TICKS=5 지속 → 이웃이 6틱 안에 없어야 이름으로 찾은 토스트가 이 이벤트의 것이다.
      const e = await pickIsolated(page, type, team, 6);
      const t = await page.evaluate(
        ([tick, txt]: [number, string]) => {
          const v = (window as any).__viewer;
          v.seek(tick);
          const hits = v.toasts().filter((x: any) => x.text === txt);
          return { n: hits.length, t: hits[0] ?? null };
        },
        [e.tick, text] as [number, string],
      );
      expect(t.n, `${type}/${team} 토스트 "${text}" 가 정확히 1개`).toBe(1);
      expect(t.t.col, `${type}/${team} 토스트 색`).toBe(`rgb(${rgbOf(team)})`);
      expect(t.t.anchor, `${type}/${team} 토스트 앵커 선수`).toBe(e.playerId);
      expect(t.t.anchorTeam, `${type}/${team} 토스트 앵커 팀`).toBe(team);
    }
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 모양 축 — 픽셀을 박제하지 않고 **모양을 의미로 환원**해서 잰다.
 * (초판은 이 축이 통째로 비어 있어 "쐐기를 정확히 반대로" · "슬래시가 안 보임" 두 결함이
 *  82건 어디에도 안 걸렸다.)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ① 방향 — 걷어내기 쐐기는 **공이 실제로 간 쪽**을 가리킨다.
 *
 * 단언은 `f.tip`(= draw() 가 쐐기 끝으로 쓴 좌표)과 스냅샷 공 변위의 **내적 > 0** 이다.
 * 쐐기 부호를 뒤집으면(= "자기 골대로 걷어냄") tip 이 같이 뒤집혀 내적이 음수가 된다.
 * ⚠️ `f.dx/f.dy`(스폰 입력)를 읽으면 안 된다 — 그리기만 뒤집는 변이가 통과한다.
 */
test("걷어내기 쐐기 방향이 실제 공 진행과 같은 반구를 가리킨다", async ({ page }) => {
  const e = await pickIsolated(page, "clearance", "home", 2);
  const ball = await page.evaluate((t: number) => {
    const v = (window as any).__viewer;
    v.seek(t); const a = v.cur().ball;
    v.seek(t + 1); const b = v.cur().ball;
    return { dx: b.x - a.x, dy: b.y - a.y };
  }, e.tick);
  const mag = Math.hypot(ball.dx, ball.dy);
  expect(mag, "표본의 공 변위가 있어야 방향 축이 성립한다").toBeGreaterThan(1);

  const f = await playUntilFx(page, e.tick, "clear", 3);
  expect(f.tip, "쐐기 끝(그린 값)이 노출돼야").toBeTruthy();
  const wx = f.tip!.x - f.x, wy = f.tip!.y - f.y;
  expect(Math.hypot(wx, wy), "쐐기가 길이를 가져야").toBeGreaterThan(0.5);
  const dot = (wx * ball.dx + wy * ball.dy) / (Math.hypot(wx, wy) * mag);
  expect(dot, `쐐기·공 변위 코사인 ${dot.toFixed(3)} — 같은 방향이어야`).toBeGreaterThan(0);
});

/**
 * ② 링 부호 — 수신은 **조이고**(반경 감소) 가로챔은 **퍼진다**(반경 증가).
 *
 * 목업 §5 가 "받았다/떠났다를 모양이 아니라 방향으로 가른다"고 정당화한 바로 그 성질이다.
 * 한 프레임만 보면 둘 다 원이라 이 축이 없으면 두 이펙트를 맞바꿔도 아무 계약이 안 깨진다.
 */
for (const [evType, fxType, dir] of [
  ["pass", "pass", "shrink"],
  ["interception", "steal", "grow"],
] as const) {
  test(`${fxType} 링이 ${dir === "shrink" ? "수축" : "확산"}한다 (그린 반경의 부호)`, async ({ page }) => {
    const e = await pickIsolated(page, evType, "home", 3);
    // 스폰 감지와 반경 표집을 **한 태스크로** 묶는다 — 나누면 왕복 사이에 이펙트가 늙는다
    // (`playUntilFx` 주석 참조). 표본이 3개 미만이면 아래 단언이 그 사실을 red 로 말한다.
    const rs = await page.evaluate(
      async ([t, ty]: [number, string]) => {
        const v = (window as any).__viewer;
        const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        v.autoPace(false); v.pause(); v.seek(t - 1); v.play();
        let born = false;
        for (let i = 0; i < 900 && !born; i++) { await raf(); born = v.fx().some((f: any) => f.type === ty); }
        v.pause();
        const out: number[] = [];
        if (!born) return out;
        for (let k = 0; k < 4; k++) {
          const f = v.fx().find((x: any) => x.type === ty);
          if (f && f.r != null) out.push(f.r);
          await raf();
        }
        return out;
      },
      [e.tick, fxType] as [number, string],
    );
    expect(rs.length, `${fxType} 반경 표본`).toBeGreaterThanOrEqual(3);
    const d = rs[rs.length - 1] - rs[0];
    if (dir === "shrink") expect(d, `수신 반경 ${rs[0].toFixed(1)}→${rs[rs.length - 1].toFixed(1)}`).toBeLessThan(-1);
    else expect(d, `가로챔 반경 ${rs[0].toFixed(1)}→${rs[rs.length - 1].toFixed(1)}`).toBeGreaterThan(1);
  });
}

/**
 * ③ 가시성 하한 — 이펙트가 **토큰 원판 바깥**에서 실제로 픽셀을 바꾼다.
 *
 * fx 레이어만 끄고 **같은 상태를 두 번** 그려(`setFxLayer`+`redraw`, 감쇠는 rAF 의 `stepFx` 소유)
 * 달라진 픽셀을 센다. 원판 안쪽을 빼는 것이 핵심이다 — 초판의 X 슬래시는 팀색 그대로 7~12px 라
 * 같은 팀색 토큰 안에서만 움직였고, 육안으로 어느 프레임에서도 식별되지 않았다(MAJOR-2).
 * "무언가 그렸다"가 아니라 **"토큰 밖에서 보인다"** 가 요구다.
 */
const VISIBLE_MIN_PX = 120; // 실측 최솟값의 절반 이하로 잡는다(아래 로그 참조).

type FxPixels = {
  err?: string;
  /** fx 레이어 on/off 로 바뀐 픽셀 — 토큰 원판 밖 / 안. */
  outside: number; inside: number;
  /** 그중 **밝은 무채색**만(팀색·잔디 어디에도 없는 값 = X 슬래시의 지문). */
  mono: number; monoInside: number;
  /** 그중 **선택 링 층(`R+9`) 밖**의 것 — ③-b 가 실제로 요구하는 것(아래 주석). */
  monoBeyondRing: number;
  rExcl: number; anchored: boolean; slashL: number | null;
  /** 이 측정이 어느 기하에서 났나 — 팔로우 줌이면 `11`, 와이드면 `8`. */
  tokenR: number;
  /** 관측 창에서 **가장 작았던** 슬래시 반팔(≈ 스폰값 `FX_STEAL_SLASH_MIN`). */
  slashMin: number | null;
  /** 앵커가 캔버스 안에 있나(팔로우 줌에서 화면 밖이면 측정이 공허하다). */
  onCanvas: boolean;
};

/**
 * fx 레이어 on/off 픽셀 차이를 **한 번의 `page.evaluate` 안에서** 잰다.
 *
 * ⚠️ 스폰 감지 → 프레임 진행 → 측정을 **나눠서 하면 안 된다.** 그 사이의 CDP 왕복(부하에 따라
 * 수십~수백 ms)에도 rAF 의 `stepFx` 는 계속 돌아 이펙트가 늙거나 사라진다 — 실제로 머신 부하가
 * 오르자 `clear`/`tackle` 가 "이펙트가 이미 사라짐"으로 red 가 됐다(계약이 무엇을 재는지와
 * 무관한 red = 신호 오염). 감지·진행·측정을 한 태스크에 묶으면 그 창이 원리적으로 사라진다.
 */
async function measureFxPixels(
  page: any,
  startTick: number,
  fxType: string,
  frames = 3,
  follow = false,
): Promise<FxPixels> {
  return page.evaluate(
    async ([t, ty, nf, useFollow]: [number, string, number, boolean]) => {
      const v = (window as any).__viewer;
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      v.autoPace(false); v.setViewMode("auto"); v.setFollow(!!useFollow);
      v.pause(); v.seek(t - 1); v.play();
      let born = false;
      let slashMin: number | null = null;
      const noteSlash = () => {
        const g = v.fx().find((f: any) => f.type === ty);
        if (g && g.slashL != null) slashMin = slashMin == null ? g.slashL : Math.min(slashMin, g.slashL);
      };
      for (let i = 0; i < 900 && !born; i++) {
        await raf();
        born = v.fx().some((f: any) => f.type === ty);
      }
      v.pause();
      if (!born) return { err: `${ty} 이펙트가 스폰되지 않음` };
      noteSlash();
      // 스폰 프레임이 아니라 **관객이 보는 프레임**에서 잰다(모든 이펙트는 첫 프레임이 가장 작다).
      for (let i = 0; i < nf; i++) { await raf(); noteSlash(); }

      const alive = v.fx().filter((f: any) => f.type === ty);
      if (!alive.length) return { err: "이펙트가 이미 사라짐" };
      if (v.fx().length !== 1) return { err: `fx 가 ${v.fx().length}개 — 단독 표본이 아님` };
      const f = alive[0];
      // 토큰 중심(캔버스 px) — **그린 쪽**에서 읽는다(카메라 변환을 밖에서 재구현하지 않는다).
      const near = v.curPlayers()
        .map((p: any) => ({ p, d: Math.hypot(p.x - f.x, p.y - f.y) }))
        .sort((a: any, b: any) => a.d - b.d)[0];
      const geom = v.screenGeom();
      const anchored = !!near && near.d < 0.6;
      const cx = anchored ? near.p.px : geom.ball.px;
      const cy = anchored ? near.p.py : geom.ball.py;
      const rExcl = (anchored ? near.p.r : geom.ball.r) + 4; // 원판 + 소유자 링 여유

      // 같은 상태를 두 번 그린다 — 여기서부터 끝까지 **동기 블록**이라 rAF 가 끼지 못한다.
      const cv = document.getElementById("pitch") as HTMLCanvasElement;
      const c2 = cv.getContext("2d")!;
      v.setFxLayer(false); v.redraw();
      const off = c2.getImageData(0, 0, cv.width, cv.height).data;
      v.setFxLayer(true); v.redraw();
      const on = c2.getImageData(0, 0, cv.width, cv.height).data;

      // 선택 링 층 = 토큰 반경 + 9(`SELECT.ringGap`, hero 확정 ②). ③-b 가 역산의 근거로 삼은
      // 바로 그 층이라 여기서 **같은 기하로** 다시 잰다(리터럴 9 — 렌더 상수를 되읽으면 임계
      // 변이가 계약을 데리고 움직인다, apps/web CLAUDE.md "초록으로 거짓말하는 방식" #2).
      const tokenR = anchored ? near.p.r : geom.ball.r;
      const ringLayer = tokenR + 9;
      const onCanvas = cx >= 0 && cy >= 0 && cx <= cv.width && cy <= cv.height;

      let outside = 0, inside = 0, mono = 0, monoInside = 0, monoBeyondRing = 0;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
          if (d < 24) continue; // 안티에일리어싱 잡음 컷
          const dist = Math.hypot(x - cx, y - cy);
          const out = dist > rExcl;
          if (out) outside++; else inside++;
          const lo = Math.min(on[i], on[i + 1], on[i + 2]);
          const hi = Math.max(on[i], on[i + 1], on[i + 2]);
          if (lo < 190 || hi - lo > 40) continue; // 밝은 무채색만(팀색 파랑/빨강·잔디 초록 제외)
          if (out) mono++; else monoInside++;
          if (dist > ringLayer) monoBeyondRing++;
        }
      }
      return {
        outside, inside, mono, monoInside, monoBeyondRing,
        rExcl, anchored, slashL: f.slashL ?? null, tokenR, slashMin, onCanvas,
      };
    },
    [startTick, fxType, frames, follow] as [number, string, number, boolean],
  );
}

for (const [evType, fxType] of [
  ["pass", "pass"],
  ["interception", "steal"],
  ["clearance", "clear"],
  ["tackle", "tackle"],
] as const) {
  test(`${fxType} 이펙트가 토큰 바깥에서 보인다 (가시성 하한)`, async ({ page }) => {
    const e = await pickSolo(page, evType, 3);
    const m = await measureFxPixels(page, e.tick, fxType);
    expect(m.err ?? null, `${fxType} 측정`).toBeNull();
    console.log(`[가시성] ${fxType}: 토큰밖 ${m.outside}px · 토큰안 ${m.inside}px (제외반경 ${m.rExcl})`);
    expect(m.outside, `${fxType} 토큰 원판 **바깥**에서 바뀐 픽셀`).toBeGreaterThanOrEqual(VISIBLE_MIN_PX);
  });
}

/**
 * ③-b 가로챔 X 슬래시 — **무채색 대비가 토큰 밖에 실제로 찍힌다**.
 *
 * ⚠️ 위 ③(가시성 하한)은 이 결함을 못 잡는다. `steal` 은 확산 링이 이미 토큰 밖으로 나가므로
 * 슬래시를 통째로 지워도 토큰밖 픽셀이 하한을 넘는다(실측: 링만으로도 수백 px). 즉 ③ 은
 * "이펙트가 보인다"는 재지만 "**판별자**가 보인다"는 못 잰다 — MAJOR-2 가 바로 그 자리였다.
 *
 * 그래서 슬래시가 자기 몫으로 가져온 성질만 골라 잰다: **밝은 무채색**(팀색 링·팀색 토큰·잔디
 * 어디에도 없는 값). 초판처럼 슬래시를 팀색으로 되돌리면 이 카운트가 0 이 된다.
 * (색 자체를 박제하는 게 아니라 "팀색 위에서 갈리는 대비가 있다"를 잰다 — 흰색을 다른 무채색으로
 *  바꿔도 통과하고, 팀색으로 되돌리면 죽는다.)
 *
 * ⚠️ **팔로우 줌 기하에서 잰다**(독립검증 MAJOR-1 수리). 초판은 `autoPace(false)` 로 재서 언제나
 *    와이드 뷰(토큰 `R=8` · 제외반경 12)였고, 그래서 `slashL > rExcl` 가 사실상 `L > 12` 였다 —
 *    `FX_STEAL_SLASH_MIN` 을 주석이 스스로 "부족"이라 기록한 **13** 으로 되돌려도 12/12 가 살아
 *    남았다. 그런데 게임 화면은 하이라이트 창에서 `nearKey` 로 **팔로우 줌**에 든다
 *    (`viewer.impl.mjs` 의 `useFollow` — 토큰 `R=11`, 선택 링 `R+9=20`). 즉 값을 역산한 그 기하가
 *    통째로 미검정이었다. 여기서 `setFollow(true)` 로 그 기하를 만들고 두 축을 건다:
 *      ⓐ **스폰 시점** 반팔의 대각 끝 `√2·L` 이 선택 링 층(`R+9`)을 넘는다 — 값 자체의 계약.
 *      ⓑ 그 층 **밖에서** 밝은 무채색 픽셀이 실제로 찍힌다 — 그려졌다는 계약.
 */
test("가로챔 X 슬래시가 **팔로우 줌 기하**의 토큰·선택 링 밖에 무채색 대비로 찍힌다", async ({ page }) => {
  const e = await pickSolo(page, "interception", 3);
  const m = await measureFxPixels(page, e.tick, "steal", 3, true);
  expect(m.err ?? null, "슬래시 측정").toBeNull();
  console.log(
    `[슬래시] 기하 R=${m.tokenR} · 토큰밖 무채색 ${m.mono}px · 토큰안 ${m.monoInside}px · ` +
      `선택링(R+9=${m.tokenR + 9}) 밖 ${m.monoBeyondRing}px · 반팔 ${m.slashL}px(스폰 ${m.slashMin}) ` +
      `(제외반경 ${m.rExcl})`,
  );
  // 측정 전제 — 실사용 기하(팔로우 줌 R=11)에서 쟀고, 앵커가 화면 안이다.
  expect(m.tokenR, "실사용(팔로우 줌) 기하에서 쟀다 — 와이드(8)면 이 계약의 근거가 사라진다").toBe(11);
  expect(m.onCanvas, "앵커가 캔버스 안").toBe(true);
  // ⓐ 값의 계약: 스폰 반팔의 대각 끝이 선택 링 층 밖. `MIN` 을 13 으로 되돌리면 √2·13.3 ≈ 18.8 < 20.
  expect(m.slashMin, "스폰 반팔 길이(그린 값)").not.toBeNull();
  expect(
    Math.SQRT2 * (m.slashMin as number),
    `대각 끝 ${(Math.SQRT2 * (m.slashMin as number)).toFixed(1)}px 이 선택 링 층 ${m.tokenR + 9}px 밖`,
  ).toBeGreaterThan(m.tokenR + 9);
  // ⓑ 그렸다는 계약(토큰 원판 밖 · 선택 링 층 밖). 팀색 회귀는 정의상 0 이라 어느 하한에도 죽는다.
  expect(m.mono, "토큰 원판 **밖**의 밝은 무채색 픽셀").toBeGreaterThanOrEqual(60);
  expect(m.monoBeyondRing, "**선택 링 층 밖**의 밝은 무채색 픽셀").toBeGreaterThanOrEqual(30);
});

/**
 * ④ 토스트 가독성 — 그려진 어떤 토스트 쌍도 겹치지 않는다.
 *
 * #69 가 "동시 토스트 세로 스택"으로 막아 둔 성질인데 **리포 전체에 계약이 0건**이었다. 그래서
 * W5 가 TACKLE/INTERCEPT 를 공 앵커 → 선수 앵커로 옮기고 CLEARED! 를 추가했을 때, 스택 키가
 * `틱:팀:앵커` 라 **틱이 다르면 스택하지 않는** 성질이 그대로 드러나 읽기 불가 쌍이 5→50 이
 * 됐는데도 82건 중 아무것도 빨강이 되지 않았다(독립검증 BLOCKER-1, 실측 dx=0·dy=4.4px).
 *
 * 임계는 렌더 상수를 되읽지 않고 **글자 크기에서 나온 절대값**으로 박는다. 렌더가 임계를
 * 넓히면 계약도 같이 느슨해지는 자기참조를 피하기 위해서다.
 *
 * ⚠️ **그 절대값이 처음엔 너무 작았다**(#406 W6 m3). 초판은 `dy<14 && dx<70` 이었는데 실측 여유가
 *    **1px** 이었다 — 한 칸만 넓혀 재면(`dy<20 && dx<90`) 읽기 불가 쌍이 **56건**이고 최악이
 *    `INTERCEPT`/`CLEARED!` `dx=0 · dy=17` = 그때의 `TOAST_STACK_GAP` 그 값이었다. 즉 계약이
 *    "겹치지 않는다"고 말한 근거는 렌더가 정확히 그 임계 바로 위에 앉아 있었다는 것뿐이다.
 *
 *    글자는 `bold 15px sans-serif` + 외곽선 `lineWidth 3`(바깥 1.5px)이고 `textBaseline="middle"`.
 *
 * ⚠️ **그 다음 문장이 또 틀렸다**(W7 m-3). 여기엔 *"한 줄이 세로로 잡아먹는 높이 ≈ 19.5px
 *    (15 × 1.1 + 3)"* 라고 적혀 있었는데 그건 **산술 추정**이었다. 실측은 잉크 11.3px
 *    (asc 11.0 · desc 0.3 — 전부 대문자라 디센더가 없다) · 외곽선까지 14.3px · 폭 90.0px 라,
 *    되돌렸던 17 도 여유가 2.7px 있었다.
 *    임계 20 은 그대로 두되(잉크 위 5.7px = 두 줄이 확실히 갈린다) **근거를 추정에서 실측으로**
 *    바꾼다 — 아래 첫 블록이 브라우저에서 직접 재고, 임계가 그 실측을 덮는지 단언한다.
 *    가로는 실측이 근거를 받쳤다(`INTERCEPT!` 폭 ≈90.0px → 70 은 절반만 덮었다 → **90**).
 */
test("토스트가 서로 겹치지 않는다 (경기 전 구간 스윕)", async ({ page }) => {
  const MIN_DY = 20, NEAR_DX = 90;

  /*
   * **임계의 근거를 매번 다시 잰다**(W7 m-3). 폰트·외곽선이 바뀌면 여기서 먼저 빨강이 난다 —
   * 주석의 숫자가 스테일해지는 것이 이 축에서 두 번 사고를 냈다.
   */
  const ink = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = "bold 15px sans-serif"; // 렌더와 같은 문자열(viewer.impl.mjs 토스트)
    const m = c.measureText("INTERCEPT!");
    return { asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent, w: m.width };
  });
  const inkH = ink.asc + ink.desc;
  const strokeH = inkH + 3; // lineWidth 3 = 위아래 1.5px 씩
  console.log(
    `[토스트 기하] 잉크 ${inkH.toFixed(1)}px (asc ${ink.asc.toFixed(1)} · desc ${ink.desc.toFixed(1)}) · ` +
      `외곽선 포함 ${strokeH.toFixed(1)}px · 폭 ${ink.w.toFixed(1)}px`,
  );
  expect(MIN_DY, `세로 임계가 실측 글자 높이(${strokeH.toFixed(1)}px)를 덮어야 한다`).toBeGreaterThanOrEqual(strokeH);
  expect(NEAR_DX, `가로 임계가 실측 라벨 폭(${ink.w.toFixed(1)}px)을 덮어야 한다`).toBeGreaterThanOrEqual(ink.w - 1);
  const found = await page.evaluate(
    ([minDy, nearDx]: [number, number]) => {
      const v = (window as any).__viewer;
      const ticks: number[] = v.events().map((e: any) => e.tick);
      const last = Math.max(...ticks);
      const bad: any[] = [];
      let drawn = 0, multi = 0, stacked = 0;
      for (let t = 0; t <= last; t++) {
        v.seek(t);
        const ts = v.toasts();
        drawn += ts.length;
        if (ts.length > 1) multi++;
        for (const a of ts) if (a.py !== a.py0) stacked++;
        for (let i = 0; i < ts.length; i++) {
          for (let j = i + 1; j < ts.length; j++) {
            const dx = Math.abs(ts[i].px - ts[j].px), dy = Math.abs(ts[i].py - ts[j].py);
            if (dx < nearDx && dy < minDy) {
              bad.push({ t, a: ts[i].text, b: ts[j].text, dx: +dx.toFixed(1), dy: +dy.toFixed(1) });
            }
          }
        }
      }
      return { bad: bad.slice(0, 12), n: bad.length, drawn, multi, last, stacked };
    },
    [MIN_DY, NEAR_DX] as [number, number],
  );
  console.log(
    `[토스트] 스윕 ${found.last + 1}틱 · 그린 토스트 ${found.drawn} · 다중 프레임 ${found.multi} · ` +
      `밀려난 토스트 ${found.stacked} · 읽기불가 쌍 ${found.n}`,
  );
  // 표본 전제 — 겹칠 기회가 없으면 이 계약은 공허하다.
  expect(found.drawn, "스윕 중 그려진 토스트 수").toBeGreaterThan(200);
  expect(found.multi, "한 틱에 토스트가 2개 이상인 프레임").toBeGreaterThan(20);
  expect(found.stacked, "실제로 밀려난 토스트 — 0 이면 밀어내기 자체가 발화하지 않은 것").toBeGreaterThan(0);
  expect(
    found.n,
    `읽기 불가 쌍 ${found.n}건 (dy<${MIN_DY} && dx<${NEAR_DX}) 예: ${JSON.stringify(found.bad)}`,
  ).toBe(0);
});

/**
 * ④-b **밀어낸 결과가 화면 안에 있다** (독립검증 MAJOR-2).
 *
 * ⚠️ 겹침(④)만 재면 **"화면 밖으로 치웠다"가 정답이 된다** — 독립검증이 `py -= 900`(전 토스트를
 * 캔버스 위로) 변이를 태워 12/12 생존을 확인했다. 픽스는 "겹치면 **위로 밀어낸다**"인데 위가
 * 화면 밖이면 못 읽는 것은 마찬가지다.
 *
 * ⚠️ 두 가지를 **가른다**:
 *   · **선행 성질**(#406 W5 밖, m-4) — 토스트는 앵커 위 18~40px 에 뜨므로 위쪽 터치라인 선수는
 *     원래부터 `py` 가 음수가 될 수 있고(`SHOT!`·`SAVE!` 도 같다), 하이라이트 **팔로우 줌**에서는
 *     앵커가 아예 화면 밖이라 실측 `py0` 최솟값이 **−476** 까지 간다. 그건 이 웨이브가 만든 것이
 *     아니고 카메라의 성질이다.
 *   · **이 웨이브가 책임지는 것** — 밀어내기(`TOAST_STACK_GAP`)가 **화면 안에 있던 것을 밖으로**
 *     보내지 않는다.
 * 그래서 카메라를 **와이드로 고정**해(앵커가 전부 화면 안) 두 축을 잰다: ⓐ 스택이 안→밖으로
 * 보낸 건수 0 ⓑ 앵커 기준 자리(`py0`)가 상식 범위. ⓐ 는 밀어내기 **뒤**에 붙은 변이를, ⓑ 는
 * 그 **앞**에 붙은 변이를 죽인다.
 */
test("④-b 밀어낸 토스트가 화면 밖으로 나가지 않는다 (와이드 뷰 스윕)", async ({ page }) => {
  const found = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const cv = document.getElementById("pitch") as HTMLCanvasElement;
    // 카메라 고정 — 팔로우 줌은 앵커를 화면 밖에 두므로 이 축을 잴 수 없다(위 주석).
    v.autoPace(false); v.setFollow(false); v.setViewMode("fix");
    const ticks: number[] = v.events().map((e: any) => e.tick);
    const last = Math.max(...ticks);
    const pushedOff: any[] = [];
    let drawn = 0, stacked = 0;
    let minPy = Infinity, maxPy = -Infinity, minPy0 = Infinity, maxPy0 = -Infinity;
    for (let t = 0; t <= last; t++) {
      v.seek(t);
      for (const a of v.toasts()) {
        drawn++;
        if (a.py !== a.py0) stacked++;
        minPy = Math.min(minPy, a.py); maxPy = Math.max(maxPy, a.py);
        minPy0 = Math.min(minPy0, a.py0); maxPy0 = Math.max(maxPy0, a.py0);
        if (a.py0 >= 0 && a.py0 <= cv.height && (a.py < 0 || a.py > cv.height)) {
          pushedOff.push({ t, text: a.text, py0: +a.py0.toFixed(1), py: +a.py.toFixed(1) });
        }
      }
    }
    return {
      drawn, stacked, nPushedOff: pushedOff.length, pushedOff: pushedOff.slice(0, 12),
      minPy, maxPy, minPy0, maxPy0, h: cv.height,
    };
  });
  console.log(
    `[토스트-화면] 그린 ${found.drawn} · 밀려난 ${found.stacked} · 화면밖으로 밀림 ${found.nPushedOff} · ` +
      `py [${found.minPy.toFixed(1)}, ${found.maxPy.toFixed(1)}] · ` +
      `py0 [${found.minPy0.toFixed(1)}, ${found.maxPy0.toFixed(1)}] · 캔버스 높이 ${found.h}`,
  );
  expect(found.drawn, "스윕 중 그려진 토스트 수").toBeGreaterThan(200);
  expect(found.stacked, "밀어내기가 실제로 발화한 표본").toBeGreaterThan(0);
  expect(
    found.nPushedOff,
    `밀어내기가 화면 밖으로 보낸 토스트 ${found.nPushedOff}건 예: ${JSON.stringify(found.pushedOff)}`,
  ).toBe(0);
  /*
   * 앵커 기준 자리(`py0`)의 상식 범위 — 와이드 뷰에서 선수는 전부 캔버스 안이고 토스트는 그보다
   * 최대 40px(18 + prog·22) 위다. 피치는 캔버스 위쪽 여백(MARGIN=30) 안에서 시작하므로 위쪽
   * 터치라인 선수라도 −10 언저리가 하한이다. 임계 −40 은 렌더 상수를 되읽지 않고 그 기하에서
   * 나온 값이다(자기참조 회피).
   */
  expect(found.minPy0, "앵커 기준 토스트 자리가 캔버스 위쪽 상식 범위 안").toBeGreaterThan(-40);
  expect(found.maxPy0, "앵커 기준 토스트 자리가 캔버스 아래 밖으로 나가지 않는다").toBeLessThanOrEqual(found.h);
});

/**
 * m-3 — **걷어내기 방향 폴백**. 공이 그 다음 틱에 사실상 안 움직였을 때(`d < 0.5`) 쐐기는
 * **그 팀의 전진 방향**으로 떨어진다(`spawnClearFx`). `fixture-real` 에선 이 분기가 **발화 0** 이라
 * 위 ① 방향 계약이 통째로 지나친다 — 부호를 뒤집는 변이가 생존한다.
 *
 * 그래서 **합성 표본**으로 그 분기만 태운다: 공이 두 틱 동안 정지해 있는 `clearance` 를 홈·어웨이
 * 양쪽으로 심고, 쐐기 끝이 각자의 공격 방향(홈 `+x` · 어웨이 `−x`)을 가리키는지 본다.
 */
const CLEAR_FALLBACK_LOG = {
  configVersion: "clear-fallback@1",
  seed: "cf-1",
  finalScore: { home: 0, away: 0 },
  events: [
    { tick: 4, minute: 0, type: "clearance", team: "home", playerId: "P200" },
    { tick: 14, minute: 0, type: "clearance", team: "away", playerId: "P300" },
  ],
  // 공은 **한 번도 움직이지 않는다** → `d < 0.5` 폴백이 반드시 탄다.
  tickSnapshots: Array.from({ length: 30 }, (_, t) => ({
    tick: t,
    minute: 0,
    ball: { x: 52.5, y: 34 },
    ballOwner: null,
    players: [
      { playerId: "P200", team: "home", pos: { x: 52.5, y: 34 } },
      { playerId: "P300", team: "away", pos: { x: 52.5, y: 34 } },
    ],
  })),
};

test("걷어내기 방향 폴백 — 공이 안 움직인 틱이면 **그 팀 전진 방향**을 가리킨다", async ({ page }) => {
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), CLEAR_FALLBACK_LOG);
  await page.waitForFunction(
    (n) => (window as any).__viewer?.ready() && (window as any).__viewer.events().length === n,
    CLEAR_FALLBACK_LOG.events.length,
    { timeout: 15000 },
  );
  for (const [tick, team, sign] of [[4, "home", 1], [14, "away", -1]] as const) {
    const f = await playUntilFx(page, tick, "clear", 2);
    expect(f.rgb, `${team} 폴백 표본 색`).toBe(rgbOf(team));
    expect(f.tip, "쐐기 끝(그린 값)").toBeTruthy();
    const wx = f.tip!.x - f.x;
    console.log(`[폴백] ${team}: 쐐기 x 성분 ${wx.toFixed(2)}m (기대 부호 ${sign > 0 ? "+" : "−"})`);
    expect(Math.abs(wx), "쐐기가 길이를 가져야").toBeGreaterThan(0.5);
    expect(
      Math.sign(wx),
      `${team} 는 ${sign > 0 ? "+x" : "−x"} 로 걷어낸다 — 부호를 뒤집으면 자기 골대로 찬다`,
    ).toBe(sign);
  }
});
