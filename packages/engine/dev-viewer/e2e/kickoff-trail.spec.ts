import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// #100 (§8 백로그): "킥오프 직후 궤적 잔상선이 피치 가로질러 지그재그로 그려짐(시각 클러터)".
// 근본 원인: 킥오프 틱에서 선수가 포메이션 리셋으로 ~42m 순간이동하는데, 선수 잔상(도트, PLAYER_TRAIL)이
// 재배치를 컷하지 않아 재배치 전(옛) 위치 도트가 ~10틱 남아 새 포메이션 도트와 섞여 피치를 가로지른다.
// 공 트레일은 이미 ballCutTickSet 로 컷되지만(#51) 선수 잔상은 아니었다.
// 계약: 재배치(킥오프/코너/스로인/골킥/프리킥/페널티) 이후 프레임의 선수 잔상 도트는 그 재배치 틱 이전
// 스냅샷(순간이동한 옛 좌표)을 포함하지 않는다 = 잔상이 최근 재배치 이후 위치로만 클립된다.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("골 후 킥오프 직후: 선수 잔상에 킥오프 전(순간이동한 옛) 위치 도트가 없다", async ({ page }) => {
  const res = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const kos = v.events().filter((e: any) => e.type === "kickoff" && e.detail == null && e.minute > 0);
    const out: any[] = [];
    for (const ko of kos) {
      // 킥오프 직후 잔상 창 전체(ko+1 .. ko+9). 옛 위치 도트가 살아있으면 srcTick < ko.
      for (let t = ko.tick + 1; t <= ko.tick + 9; t++) {
        const dots = v.playerTrailAt(t);
        const stale = dots.filter((d: any) => d.srcTick < ko.tick);
        if (stale.length) out.push({ frame: t, ko: ko.tick, stale: stale.slice(0, 3) });
      }
    }
    return { koCount: kos.length, bad: out };
  });
  expect(res.koCount, "post-goal 킥오프가 있어야(테스트 유효성)").toBeGreaterThan(2);
  expect(res.bad, `킥오프 전 위치가 잔상에 남음(피치 가로지르는 클러터): ${JSON.stringify(res.bad.slice(0, 4))}`).toEqual([]);
});

test("킥오프 직후 인접 잔상 도트 사이 점프가 순간이동(≈42m) 없이 연속적", async ({ page }) => {
  // 같은 선수의 시간순 인접 잔상 도트 사이 거리는 1틱 정상 이동(<~10m)이어야. 재배치 전→후를 잇는
  // 42m 단일 세그먼트가 남아있으면(클립 실패) 이 한계를 넘는다. 누적 스프레드(여러 틱 합)는 허용.
  const worst = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const kos = v.events().filter((e: any) => e.type === "kickoff" && e.detail == null && e.minute > 0);
    let maxStep = 0; let sample: any = null;
    for (const ko of kos) {
      for (let t = ko.tick + 1; t <= ko.tick + 9; t++) {
        const dots = v.playerTrailAt(t);
        // 선수별 srcTick 오름차순으로 인접 스텝 측정.
        const byId: Record<string, any[]> = {};
        for (const d of dots) (byId[d.id] ||= []).push(d);
        for (const id of Object.keys(byId)) {
          const seq = byId[id].sort((a, b) => a.srcTick - b.srcTick);
          for (let k = 1; k < seq.length; k++) {
            const step = Math.hypot(seq[k].x - seq[k - 1].x, seq[k].y - seq[k - 1].y);
            if (step > maxStep) { maxStep = step; sample = { frame: t, ko: ko.tick, id, step: +step.toFixed(1), from: seq[k - 1].srcTick, to: seq[k].srcTick }; }
          }
        }
      }
    }
    return { maxStep: +maxStep.toFixed(1), sample };
  });
  expect(worst.maxStep, `킥오프 후 인접 잔상 도트 사이 순간이동 세그먼트 잔존: ${JSON.stringify(worst.sample)}`).toBeLessThan(15);
});

test("일반 오픈플레이 잔상은 유지(클립이 잔상을 통째로 지우지 않음)", async ({ page }) => {
  const res = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const ev = v.events();
    const restart = new Set(
      ev.filter((e: any) => e.type === "kickoff" || e.type === "free_kick" || e.type === "penalty").map((e: any) => e.tick)
    );
    const last = ev.length ? ev[ev.length - 1].tick : 0;
    let framesWithTrail = 0, sampled = 0;
    for (let t = 40; t <= Math.min(last, 1200); t += 20) {
      // 최근 12틱 내 재배치 없는(오픈플레이) 프레임만.
      let clean = true;
      for (let u = t - 12; u <= t; u++) if (restart.has(u)) { clean = false; break; }
      if (!clean) continue;
      sampled++;
      if (v.playerTrailAt(t).length > 0) framesWithTrail++;
    }
    return { sampled, framesWithTrail };
  });
  expect(res.sampled, "오픈플레이 샘플이 있어야").toBeGreaterThan(5);
  // 오픈플레이에선 잔상이 계속 있어야(클립 회귀 방지).
  expect(res.framesWithTrail).toBe(res.sampled);
});

test("모든 재배치 직후 프레임: 선수 잔상에 그 재배치 전 스냅샷 도트 없음(일반 회귀)", async ({ page }) => {
  const bad = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const ticks = (() => {
      const ev = v.events();
      return ev.filter((e: any) => e.type === "kickoff" || e.type === "free_kick" || e.type === "penalty").map((e: any) => e.tick);
    })();
    const out: any[] = [];
    for (const rt of ticks) {
      for (let t = rt + 1; t <= rt + 9; t++) {
        const dots = v.playerTrailAt(t);
        // 이 프레임과 t 사이에 더 최근 재배치가 없으면, 잔상은 rt 이후만 있어야.
        const laterRestart = ticks.some((x: number) => x > rt && x <= t);
        if (laterRestart) continue;
        const stale = dots.filter((d: any) => d.srcTick < rt);
        if (stale.length) out.push({ frame: t, restart: rt, staleSrc: stale[0].srcTick });
      }
    }
    return out;
  });
  expect(bad, `재배치 전 위치가 잔상에 남음: ${JSON.stringify(bad.slice(0, 5))}`).toEqual([]);
});
