import { test, expect } from "@playwright/test";
import { loadViewer, VIEWER_URL } from "./fixture";

/**
 * #406 W4 — **선수 하이라이트**(요구 5-2). hero 확정 ② = 펄스 링 `R+9`.
 *
 * <p>계약이 겨누는 결함 넷:
 * <ol>
 *   <li><b>단독 id 키</b> — 같은 playerId 가 양 팀에 뛰므로(#324) `playerId` 만으로 조회하면
 *       <b>반대 팀 선수가 같이 켜진다</b>. `duplicate-id-render.spec.ts` 가 등번호·카드·줌 축에서
 *       세운 것과 같은 축이고, 선택은 그 축이 새로 생긴 표면이다.</li>
 *   <li><b>층 붕괴</b> — 링이 카드 마커(`R+6`)·소유자 링(`R+2`) 아래로 내려오면 셋이 겹친 선수에서
 *       무엇이 무엇인지 안 읽힌다. 반경 관계로 박는다(절대 px 가 아니라 <b>관계</b>).</li>
 *   <li><b>벽시계 맥동</b> — 펄스가 `Date.now`/`performance.now` 에 걸리면 §2-5 결정론을 깨고
 *       `skin.spec.ts` 의 "같은 틱 두 번 찍어 비교"가 공허해진다. 같은 틱 재렌더 <b>바이트 동일</b> +
 *       플레이헤드가 다르면 반경이 <b>다르다</b> 를 같이 건다(둘 중 하나만 있으면 상수 링도 통과한다).</li>
 *   <li><b>읽기 표면 부재</b> — 그린 결과를 밖에서 못 읽으면 위 셋 중 무엇을 되돌려도 조용하다.</li>
 * </ol>
 */

/** 라이브 라인업 모양: **P078 이 양 팀에** 있다(#324 표본, 라이브 하프의 38%). */
const DUP_LOG = {
  configVersion: "sel-test@1",
  seed: "sel-1",
  finalScore: { home: 0, away: 0 },
  events: [
    // 카드 마커(R+6)와 **같은 선수 위에서** 층이 갈리는지 볼 수 있게 홈 P078 에 옐로.
    { tick: 3, minute: 0, type: "foul", team: "home", playerId: "P078" },
    { tick: 3, minute: 0, type: "card", team: "home", playerId: "P078", detail: "yellow" },
  ],
  tickSnapshots: Array.from({ length: 20 }, (_, t) => ({
    tick: t,
    minute: 0,
    ball: { x: 20, y: 34 },
    ballOwner: "P078", // 소유자 링(R+2)도 같이 걸리는 표본
    players: [
      { playerId: "P074", team: "home", pos: { x: 5, y: 34 } },
      { playerId: "P078", team: "home", pos: { x: 21, y: 34 } },
      { playerId: "P078", team: "away", pos: { x: 87, y: 20 } },
      { playerId: "P116", team: "away", pos: { x: 99, y: 34 } },
    ],
  })),
};

const SKIN = {
  atlases: [],
  byPlayer: {},
  nums: { "home:P074": "1", "home:P078": "3", "away:P078": "5", "away:P116": "1" },
  atlasUrl: "",
  tile: 0,
};

type Sel = { team: string; playerId: string; mine?: boolean; label?: string };

async function inject(page: import("@playwright/test").Page) {
  await loadViewer(page, VIEWER_URL);
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), DUP_LOG);
  await page.waitForFunction(
    (n) => (window as any).__viewer?.ready() && (window as any).__viewer.events().length === n,
    DUP_LOG.events.length,
    { timeout: 15000 },
  );
  await page.evaluate((skin) => (window as any).__viewer.setSkin(skin), SKIN);
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.autoPace(false);
    v.setViewMode("fix");
    v.seek(1);
  });
}

/** 선택을 주입하고 그 프레임을 다시 그린 뒤 `curPlayers()` 를 읽는다. */
async function pick(page: import("@playwright/test").Page, list: Sel[]) {
  return page.evaluate((sel) => {
    const v = (window as any).__viewer;
    v.setSelection(sel);
    return { players: v.curPlayers(), drawn: v.selection() };
  }, list);
}

test.beforeEach(async ({ page }) => {
  await inject(page);
});

test("선택 링은 **그 선수에게만** 뜬다", async ({ page }) => {
  const { players, drawn } = await pick(page, [{ team: "home", playerId: "P074", mine: true }]);
  const on = players.filter((p: any) => p.selected);
  expect(on.length, "켜진 토큰은 정확히 1개").toBe(1);
  expect(on[0].id).toBe("P074");
  expect(on[0].team).toBe("home");
  // 읽기 표면 두 개(`curPlayers().selected` · `selection()`)가 같은 것을 말해야 한다.
  expect(drawn.map((d: any) => `${d.team}:${d.id}`)).toEqual(["home:P074"]);
});

test("#324 축: 같은 playerId 를 가진 **반대 팀 선수가 안 켜진다**", async ({ page }) => {
  const { players } = await pick(page, [{ team: "home", playerId: "P078", mine: true }]);
  const home = players.find((p: any) => p.id === "P078" && p.team === "home");
  const away = players.find((p: any) => p.id === "P078" && p.team === "away");
  expect(home, "홈 P078 토큰").toBeTruthy();
  expect(away, "어웨이 P078 토큰").toBeTruthy();
  expect(home.selected, "고른 쪽은 켜진다").toBe(true);
  // 단독 id 키로 되돌리면 여기가 true 가 된다 = 반대 팀이 같이 하이라이트된다.
  expect(away.selected, "반대 팀 동명 선수는 꺼져 있어야").toBe(false);
});

test("팀을 안 준 항목은 **아무도 안 켠다**(fail-closed)", async ({ page }) => {
  const { players } = await pick(page, [{ playerId: "P078" } as unknown as Sel]);
  expect(players.filter((p: any) => p.selected).length, "팀 없는 선택은 무시").toBe(0);
});

test("해제된다 — 빈 배열·null 둘 다", async ({ page }) => {
  const first = await pick(page, [{ team: "away", playerId: "P116" }]);
  expect(first.players.filter((p: any) => p.selected).length).toBe(1);
  const cleared = await pick(page, []);
  expect(cleared.players.filter((p: any) => p.selected).length, "빈 배열 = 해제").toBe(0);
  const byNull = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.setSelection([{ team: "away", playerId: "P116" }]);
    v.setSelection(null);
    return v.curPlayers().filter((p: any) => p.selected).length;
  });
  expect(byNull, "null = 해제").toBe(0);
});

test("팀당 1명씩 동시에 — 홈·어웨이 두 링이 각자 자기 팀에", async ({ page }) => {
  const { players } = await pick(page, [
    { team: "home", playerId: "P078", mine: true },
    { team: "away", playerId: "P078", mine: false },
  ]);
  const on = players.filter((p: any) => p.selected);
  expect(on.length).toBe(2);
  expect(on.filter((p: any) => p.selectMine).map((p: any) => p.team), "내 선수 스타일은 홈에만").toEqual(["home"]);
  // 두 인스턴스가 서로 다른 자리에 그려져 있다(같은 자리면 표본이 무너진 것).
  const [a, b] = on;
  expect(Math.abs(a.px - b.px)).toBeGreaterThan(50);
});

/*
 * 층 밴드의 **위쪽 임계** (#406 W6 m1).
 *
 * ⚠️ 초판 하한은 `selectR >= r + 9` 였다 — 그런데 `R+9` 는 **hero 조정 포인트 ①**(#406)이라
 *    hero 가 내일 `R+7` 을 고르면 **계약이 빨강**이 된다: 오늘의 튜닝값을 계약으로 박은 것이다.
 *    거꾸로 위쪽은 아무것도 안 막아서 `ringGap 9 → 30`(토큰을 삼키는 거대 링)이 **41/41 생존**
 *    했다(독립검증 변이 X_ringgap).
 *
 *    진짜 요구는 **층 분리**다 — 아래로는 카드 마커(`R+6`)를 침범하지 않고, 위로는 그 층에서
 *    **토큰 반경 하나 이상** 더 벌어지지 않는다("바로 위층"이라는 말의 기하). 둘 다 `r` 로 쓴
 *    관계라 hero 가 `ringGap` 을 7~11 사이 어디로 옮겨도 산다.
 */
const LAYER_CARD = 6;   // 카드 마커 층 = R+6.

test("층 관계: 선택 링 > 카드 마커(R+6) > 소유자 링(R+2) — 맥동 어느 위상에서도", async ({ page }) => {
  // 홈 P078 = 소유자 + 옐로 카드 + 선택. 세 신호가 한 토큰에 겹치는 최악의 표본이다.
  const samples = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.setSelection([{ team: "home", playerId: "P078", mine: true }]);
    const out: Array<{ r: number; selectR: number }> = [];
    // 한 주기(pulseTicks=9)를 넘겨 훑는다 — 최소 위상도 반드시 표본에 든다.
    for (let tp = 3; tp <= 15; tp += 0.5) {
      const p = v.renderPlayersAt(tp).find((q: any) => q.id === "P078" && q.team === "home");
      if (p) out.push({ r: p.r, selectR: p.selectR });
    }
    return out;
  });
  expect(samples.length).toBeGreaterThan(20);
  const rs = samples.map((s) => s.selectR);
  console.log(
    `[층밴드] R=${samples[0]!.r} · selectR ${Math.min(...rs).toFixed(2)}~${Math.max(...rs).toFixed(2)} · ` +
      `밴드 (${samples[0]!.r + LAYER_CARD}, ${samples[0]!.r + LAYER_CARD + samples[0]!.r}]`,
  );
  for (const s of samples) {
    expect(s.selectR, "카드 마커(R+6) 층을 침범하지 않는다").toBeGreaterThan(s.r + LAYER_CARD);
    // 위쪽 — "바로 위층"이지 별개의 후광이 아니다. `ringGap` 을 크게 키우는 변이가 여기서 죽는다.
    expect(
      s.selectR,
      `카드 마커 층에서 토큰 반경(${s.r}) 이상 벌어지지 않는다`,
    ).toBeLessThanOrEqual(s.r + LAYER_CARD + s.r);
  }
  // 실제로 맥동한다 — 상수 링이면 여기가 죽는다.
  const spread = Math.max(...samples.map((s) => s.selectR)) - Math.min(...samples.map((s) => s.selectR));
  expect(spread, "위상에 따라 반경이 변한다").toBeGreaterThan(0.5);
});

test("맥동 위상은 **플레이헤드에서** 나온다 — 같은 틱 재렌더는 픽셀 동일", async ({ page }) => {
  const { a, b } = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.setSelection([{ team: "home", playerId: "P078", mine: true, label: "테스트(3)" }]);
    const shot = () => {
      v.renderAt(7.25);
      return (document.getElementById("pitch") as HTMLCanvasElement).toDataURL();
    };
    const a = shot();
    // 벽시계 위상이면 이 대기 사이에 그림이 달라진다(= skin.spec 의 픽셀 계약이 공허해지는 조건).
    await new Promise((r) => setTimeout(r, 350));
    const b = shot();
    return { a, b };
  });
  expect(a.length, "렌더가 비어있지 않다").toBeGreaterThan(1000);
  expect(b, "같은 플레이헤드 = 같은 픽셀(벽시계 위상 금지)").toBe(a);
});

test("이름표: 부모가 주면 그 문구, 안 주면 **그린 등번호**로 떨어진다", async ({ page }) => {
  const withLabel = await pick(page, [{ team: "away", playerId: "P078", label: "빠름이(5)" }]);
  expect(withLabel.drawn[0].label).toBe("빠름이(5)");
  const noLabel = await pick(page, [{ team: "away", playerId: "P078" }]);
  // nums 는 팀 키 조회 → away 는 "5"(홈의 "3" 이 아니다).
  expect(noLabel.drawn[0].label).toBe("#5");
});

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * 링이 **실제로 그 반경에 그려지는가** — 장부(`selectR`)가 아니라 픽셀로.
 *
 * ⚠️ 위 "층 관계" 계약은 결함 ②(층 붕괴)를 막는다고 적어 뒀지만 **막지 못했다.** `pr.selectR = rr`
 *    은 `ctx.arc(...)` 와 **인접할 뿐 파생 관계가 아니다** — 독립검증이 두 변이를 태워 이 파일
 *    12/12 가 그대로 초록인 것을 확인했다(BLOCKER-1):
 *      V7  `ctx.arc(...)` 삭제(장부 유지)            → 링이 화면에 아예 없다
 *      V7b `ctx.arc(pr.px, pr.py, R + 2, …)`(장부는 R+9) → 소유자 링 층으로 붕괴
 *    유일한 픽셀 단언("링이 실제로 픽셀을 바꾼다")은 **이름표 알약이 혼자 만족**시킨다.
 *
 * 처방 = W5 가 이펙트에 쓴 것과 같은 방식 — 같은 상태를 선택 off/on 으로 두 번 그려 **바뀐 픽셀의
 * 반경 분포**를 잰다. 그러면 둘이 동시에 죽는다:
 *   · V7  → 변경 픽셀이 알약 자리(토큰 아래, 최소 `rr+3.7`)에만 있어 링 밴드가 빈다.
 *   · V7b → 변경 픽셀이 `R+2` 대에 몰려 링 밴드가 비고, 카드 마커 층(`R+6`) 안쪽이 찬다.
 *
 * 표본은 **P074**(소유자도 아니고 카드도 없다) — off/on 차분이 오직 선택 레이어여야 한다.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */
const RING_BAND = 2;      // 링 밴드 반폭(px). lineWidth 3 + AA 를 덮되 알약(최소 rr+3.7)은 안 든다.
const CARD_LAYER = 6;     // 카드 마커 반경 = R+6. 그 안쪽에 선택 레이어가 그리면 층이 무너진 것.

test("선택 링이 **장부가 말한 반경의 픽셀**을 바꾼다 (링 삭제·층 붕괴 동시 사살)", async ({ page }) => {
  const m = await page.evaluate(([band, cardLayer]: [number, number]) => {
    const v = (window as any).__viewer;
    const cv = document.getElementById("pitch") as HTMLCanvasElement;
    const c2 = cv.getContext("2d")!;
    const TP = 6.25; // 맥동 위상 고정 — 두 렌더가 같은 플레이헤드여야 차분이 선택 레이어뿐이다.

    v.setSelection([]);
    v.renderAt(TP);
    const off = c2.getImageData(0, 0, cv.width, cv.height).data;

    v.setSelection([{ team: "home", playerId: "P074", mine: true }]);
    v.renderAt(TP);
    const on = c2.getImageData(0, 0, cv.width, cv.height).data;

    const p = v.curPlayers().find((q: any) => q.id === "P074" && q.team === "home");
    if (!p) return { err: "P074 토큰 없음" } as any;

    let ring = 0, belowCard = 0, total = 0;
    const hist: Record<string, number> = {};
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
        if (d < 24) continue; // AA 잡음 컷
        total++;
        const rr = Math.hypot(x - p.px, y - p.py);
        if (Math.abs(rr - p.selectR) <= band) ring++;
        if (rr <= p.r + cardLayer) belowCard++;
        const b = String(Math.floor(rr / 4) * 4);
        hist[b] = (hist[b] ?? 0) + 1;
      }
    }
    return { ring, belowCard, total, r: p.r, selectR: p.selectR, hist };
  }, [RING_BAND, CARD_LAYER] as [number, number]);

  expect(m.err ?? null, "표본").toBeNull();
  console.log(
    `[선택링] R=${m.r} 장부 selectR=${m.selectR.toFixed(2)} · 총 변경 ${m.total}px · ` +
      `링밴드(±${RING_BAND}) ${m.ring}px · 카드층(R+${CARD_LAYER}) 안쪽 ${m.belowCard}px · ` +
      `반경히스토그램 ${JSON.stringify(m.hist)}`,
  );
  // 표본 전제 — 아무것도 안 바뀌면 아래 두 단언이 공허하다.
  expect(m.total, "선택 on/off 로 바뀐 픽셀이 있어야").toBeGreaterThan(200);
  // ① 링이 존재하고 ② 장부가 말한 그 반경에 있다. V7(삭제)·V7b(R+2 붕괴) 둘 다 여기서 0 이 된다.
  expect(m.ring, `장부 반경 ${m.selectR.toFixed(1)}px 밴드의 변경 픽셀`).toBeGreaterThanOrEqual(60);
  // ③ 층 붕괴의 반대 방향 — 선택 레이어는 카드 마커 층 **안쪽을 건드리지 않는다**(AA 여유만).
  expect(m.belowCard, `카드 마커 층(R+${CARD_LAYER}) 안쪽을 침범한 변경 픽셀`).toBeLessThanOrEqual(12);
});

/**
 * m-11 — **새 로그를 물면 선택은 끝난다.** web 은 부모(`VisualPlayback`)가 `half` 변화로 지워
 * 주지만, 코어를 단독으로 쓰는 소비자(QA 셸·튜닝 하네스)엔 그 부모가 없다. 로그가 갈리면 라인업도
 * 갈리므로 남은 선택은 **유령 링**(없는 선수를 가리키거나, 같은 id 의 다른 선수에 붙는다)이 된다.
 */
test("새 로그를 로드하면 선택이 초기화된다 (코어 단독 소비자의 유령 링 금지)", async ({ page }) => {
  const before = await pick(page, [{ team: "home", playerId: "P074", mine: true }]);
  expect(before.drawn.length, "선택이 켜져 있다").toBe(1);
  const after = await page.evaluate(async (log) => {
    window.postMessage({ type: "loadMatchLog", matchLog: log }, "*");
    await new Promise((r) => setTimeout(r, 300));
    const v = (window as any).__viewer;
    v.seek(1);
    return { drawn: v.selection().length, on: v.curPlayers().filter((p: any) => p.selected).length };
  }, DUP_LOG);
  expect(after.drawn, "재로드 후 그려진 선택 링 0").toBe(0);
  expect(after.on, "재로드 후 켜진 토큰 0").toBe(0);
});

/**
 * 내/상대 링 스타일 구분(hero 조정포인트 ②) — `SELECT.opp = SELECT.mine` 변이가 죽는다.
 * 색·굵기 중 무엇으로 갈리든 상관없다. **화면이 둘을 다르게 그린다**만 요구한다.
 */
test("내 선수 링과 상대 링은 **다르게 그려진다**", async ({ page }) => {
  const { mine, opp } = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const cv = document.getElementById("pitch") as HTMLCanvasElement;
    const shot = (m: boolean) => {
      // 같은 선수 · 같은 플레이헤드 · 같은 라벨 — `mine` 축만 다르다.
      v.setSelection([{ team: "home", playerId: "P074", mine: m, label: "동일라벨" }]);
      v.renderAt(6.25);
      return cv.toDataURL();
    };
    return { mine: shot(true), opp: shot(false) };
  });
  expect(mine.length, "렌더가 비어있지 않다").toBeGreaterThan(1000);
  expect(opp, "내 선수/상대 스타일이 같은 픽셀이면 구분이 없는 것").not.toBe(mine);
});

/**
 * m6 — **모른다**는 세 번째 상태다(#406 W6).
 *
 * 종전 `sel.mine ? mine : opp` 는 미지정을 **상대 스타일**로 떨어뜨렸다. 그런데 호스트 카드는 같은
 * 상태에서 뱃지를 달지 않는다(거짓 표식 금지 #322) — 링은 "상대"라 말하고 카드는 아무 말도 안 하는
 * 화면이 나온다. 코어에 세 번째 스타일(점선)을 둬서 두 표면을 맞춘다.
 *
 * 계약은 두 겹: ⓐ 읽기 표면이 3값을 **접지 않는다** ⓑ 화면이 셋을 실제로 **다르게** 그린다
 * (`SELECT.unknown = SELECT.opp` 로 되돌리는 변이가 ⓑ 에서 죽는다).
 */
test("m6 `mine` 미지정 = 내 선수도 상대도 아닌 **제3 스타일**로 그려진다", async ({ page }) => {
  // ⓐ 읽기 표면 — `!!` 로 접으면 여기서 false 가 나온다.
  const read = await pick(page, [{ team: "home", playerId: "P074" }]);
  expect(read.drawn, "링은 그려진다").toHaveLength(1);
  expect(read.drawn[0].mine, "모른다는 null 로 나온다(상대(false)가 아니다)").toBeNull();
  const asOpp = await pick(page, [{ team: "home", playerId: "P074", mine: false }]);
  expect(asOpp.drawn[0].mine, "명시한 상대는 false").toBe(false);

  // ⓑ 픽셀 — 같은 선수·같은 플레이헤드·같은 라벨. `mine` 축만 세 갈래.
  const { asMine, asOppPx, unknown } = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const cv = document.getElementById("pitch") as HTMLCanvasElement;
    const shot = (sel: any) => {
      v.setSelection([{ team: "home", playerId: "P074", label: "동일라벨", ...sel }]);
      v.renderAt(6.25);
      return cv.toDataURL();
    };
    return { asMine: shot({ mine: true }), asOppPx: shot({ mine: false }), unknown: shot({}) };
  });
  expect(unknown.length).toBeGreaterThan(1000);
  expect(unknown, "모른다 ≠ 내 선수").not.toBe(asMine);
  expect(unknown, "모른다 ≠ 상대 — 여기가 m6 의 결함 자리다").not.toBe(asOppPx);
});

test("선택 없음은 **아무것도 그리지 않는다**(기존 픽셀 계약 무회귀)", async ({ page }) => {
  const same = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const cv = document.getElementById("pitch") as HTMLCanvasElement;
    v.setSelection([]);
    v.renderAt(6);
    const before = cv.toDataURL();
    v.setSelection([{ team: "home", playerId: "P074", mine: true }]);
    v.renderAt(6);
    const on = cv.toDataURL();
    v.setSelection([]);
    v.renderAt(6);
    const after = cv.toDataURL();
    return { before, on, after };
  });
  expect(same.on, "링이 실제로 픽셀을 바꾼다").not.toBe(same.before);
  expect(same.after, "해제하면 원래 그림으로 정확히 돌아온다").toBe(same.before);
});
