import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, PITCH_W, PITCH_H, POST_MIN, POST_MAX } from "./fixture";

// #47: 세트피스 아웃 비행 계약 — 코너/스로인에서 공이 나가는 경로가 끊긴 채 진행되면 안 된다.
// 엔진은 아웃 레그를 데이터로 남기지 않아(재시작 틱에 곧장 스팟 파킹) 뷰어가 freeze 도입부에
// 합성 레그를 그린다. synthAt(causeTick) 훅이 그 레그 {from, via?, exit} 를 freeze 와 동일
// 경로로 계산 → 애니 wall-clock 의존 없이 결정론적으로 계약. (실비주얼 육안은 독립 QA/캡처 몫.)
test.beforeEach(async ({ page }) => { await loadViewer(page); });

const near = (v: number, line: number, tol = 1) => Math.abs(v - line) <= tol;

async function synthAt(page: any, tick: number) {
  return page.evaluate((t: number) => (window as any).__viewer.synthAt(t), tick);
}

// AC1: 코너 전량 — 공이 골라인(x=0/105)을 넘는 레그가 있고(순간이동 아님), 스팟(깃발)에서 끝난다.
test("#47 corner → 골라인 밖 wide 교차 후 깃발에서 끝나는 합성 레그(파킹→깃발 순간이동 아님)", async ({ page }) => {
  const corners = await eventsOfType(page, "kickoff", "corner");
  expect(corners.length).toBeGreaterThan(0);
  for (const c of corners) {
    const s = await synthAt(page, c.tick);
    expect(s, `corner t${c.tick}: 합성 레그 없음(컷) — 파킹→깃발 순간이동`).toBeTruthy();
    // via = 골라인 위를 넘는 지점.
    expect(s.via, `corner t${c.tick}: via(골라인 교차) 없음`).toBeTruthy();
    expect(near(s.via.x, 0) || near(s.via.x, PITCH_W), `corner t${c.tick}: via.x=${s.via.x} 골라인 아님`).toBe(true);
    // wide(포스트 밖) — 포스트 사이면 '골'로 오인.
    expect(s.via.y > POST_MAX || s.via.y < POST_MIN, `corner t${c.tick}: via.y=${s.via.y} 포스트 사이(골 오인)`).toBe(true);
    // exit == 스팟(코너 깃발)에서 끝남은 AC3 전용 테스트에서 검증.
  }
});

// AC2: 스로인 전량(showcase) — 사이드라인(y=0/68)에서 끝나는 아웃 레그(느린 롤아웃 포함).
test("#47 throw_in → 사이드라인에서 끝나는 아웃 레그(느린 롤아웃도 컷 안 됨)", async ({ page }) => {
  const throwins = await eventsOfType(page, "kickoff", "throw_in");
  expect(throwins.length).toBeGreaterThan(0);
  let synthed = 0;
  for (const t of throwins) {
    const s = await synthAt(page, t.tick);
    if (!s) continue; // 비국소(>25m)만 컷 허용
    synthed++;
    expect(near(s.exit.y, 0) || near(s.exit.y, PITCH_H), `throw_in t${t.tick}: exit.y=${s.exit.y} 사이드라인 아님`).toBe(true);
  }
  // showcase 스로인 대부분은 국소 → 합성돼야 한다(전부 컷이면 회귀).
  expect(synthed, "합성된 스로인이 없음 — 느린 롤아웃까지 컷됨(회귀)").toBeGreaterThan(throwins.length / 2);
});

// AC3: 합성 레그가 항상 재시작 스팟에서 끝난다(exit==spot) → freeze 착지 프레임과 단일프레임 순간이동 없음.
test("#47 세트피스 합성 레그는 재시작 스팟에서 끝난다(순간이동 없음, 코너+스로인)", async ({ page }) => {
  const setpieces = [
    ...(await eventsOfType(page, "kickoff", "corner")),
    ...(await eventsOfType(page, "kickoff", "throw_in")),
  ];
  expect(setpieces.length).toBeGreaterThan(0);
  for (const ev of setpieces) {
    const s = await synthAt(page, ev.tick);
    if (!s) continue;
    // 재시작 스팟 = causeTick 스냅샷의 공(엔진이 파킹한 스팟).
    const spot = await page.evaluate((t: number) => {
      const v = (window as any).__viewer; v.seek(t); return v.cur().ball;
    }, ev.tick);
    const gap = Math.hypot(s.exit.x - spot.x, s.exit.y - spot.y);
    expect(gap, `${ev.detail} t${ev.tick}: 합성 exit↔스팟 gap ${gap.toFixed(2)}m (순간이동)`).toBeLessThan(0.5);
  }
});
