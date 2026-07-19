import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// R1(#100) 계약: 공 궤적 트레일 세그먼트 색 = 그 구간 **소유팀 색**(home 파랑/away 빨강).
// 트레일 색은 canvas 픽셀이라 좌표 추론 대신 렌더가 실제 사용한 세그먼트 side 를 __viewer.trailAt 로
// 박제해 검증한다(= 그려진 것과 동일 데이터). 소유자 있는 틱에서 최신 세그먼트 side 가 소유팀과 일치해야.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("소유자 있는 틱: 최신 트레일 세그먼트 색이 소유팀과 일치 + home/away 둘 다 등장", async ({ page }) => {
  const snaps = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const out: { tick: number; side: string | null; ownerSide: string | null }[] = [];
    // 경기 전반 60개 틱 샘플. 각 틱에서 소유팀과 최신 트레일 세그먼트 side 비교.
    const ev = v.events();
    const lastTick = ev.length ? ev[ev.length - 1].tick : 0;
    for (let t = 8; t <= Math.min(lastTick, 1200); t += 4) {
      const cur = (() => { v.seek(t); return v.cur(); })();
      const trail = v.trailAt(t);
      const owner: string | null = cur.ballOwner;
      const ownerSide = owner ? (owner[0] === "H" ? "home" : "away") : null;
      // 현재 틱에서 끝나는 그려진 세그먼트(있으면). 컷(재배치) 틱엔 세그먼트가 없어 null → 스킵.
      const seg = trail.filter((x: any) => x.endTick === cur.tick).pop();
      out.push({ tick: cur.tick, side: seg ? seg.side : null, ownerSide });
    }
    return out;
  });
  const owned = snaps.filter((s) => s.ownerSide != null && s.side != null);
  expect(owned.length, "소유자 있는 샘플이 있어야").toBeGreaterThan(5);
  // 소유팀 있는 틱의 최신 세그먼트는 그 팀 색이어야(carry-forward 없이 직접 소유).
  const mismatches = owned.filter((s) => s.side !== s.ownerSide);
  expect(
    mismatches.length,
    `소유팀↔트레일색 불일치 ${mismatches.length}/${owned.length}: ${JSON.stringify(mismatches.slice(0, 5))}`,
  ).toBe(0);
  // 양팀 색이 모두 등장(노랑 고정 회귀 방지).
  const sides = new Set(owned.map((s) => s.side));
  expect(sides.has("home"), "home(파랑) 트레일 등장").toBe(true);
  expect(sides.has("away"), "away(빨강) 트레일 등장").toBe(true);
});

// R1 정련(#100, hero): 슛 비행 구간(공 무소유)의 트레일 색은 **슛한 팀**이어야 한다(슛 판정까지
// 소유권=슛한 팀). 무소유 틱에서 상대 색/중립으로 빠지면 "슛한 순간 소유권 뺏긴 것처럼" 보임.
test("슛 비행(무소유) 트레일 = 슛한 팀 색 (중립/상대 아님)", async ({ page }) => {
  const res = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const shots = v.events().filter((e: any) => e.type === "shot" && !e.detail); // 슛 시도(결과마커 제외)
    let matched = 0, mismatched = 0, neutral = 0;
    const bad: any[] = [];
    for (const sh of shots) {
      let flying = false; // 슛 비행이 시작됐는가(선행 슈터 명목소유 스킵 후).
      for (let t = sh.tick; t <= sh.tick + 4; t++) {
        v.seek(t);
        const cur = v.cur();
        // 소유되면 비행 아님. 비행 시작 전(슈터 명목소유)이면 스킵, 시작 후 점유되면 슛 비행 종료(세이브/
        // 리시버) → 이후 무소유는 그 팀 소유 플레이(예: 키퍼 배급)라 슛 트레일이 아님 → 이 슛은 끝.
        if (cur.ballOwner !== null) { if (flying) break; else continue; }
        flying = true;
        const seg = v.trailAt(t).filter((x: any) => x.endTick === t).pop();
        if (!seg) continue; // 그 틱에 그려진 세그먼트 없음(공 정지)
        if (seg.side === sh.team) matched++;
        else if (seg.side == null) { neutral++; bad.push({ tick: t, got: "neutral", exp: sh.team }); }
        else { mismatched++; bad.push({ tick: t, got: seg.side, exp: sh.team }); }
      }
    }
    return { matched, mismatched, neutral, bad: bad.slice(0, 6) };
  });
  expect(res.matched, "슛 비행 트레일이 슛한 팀 색인 케이스가 있어야").toBeGreaterThan(3);
  expect(res.mismatched, `상대팀 색으로 빠진 비행 세그먼트: ${JSON.stringify(res.bad)}`).toBe(0);
  expect(res.neutral, `중립으로 빠진 비행 세그먼트: ${JSON.stringify(res.bad)}`).toBe(0);
});

test("비행 중(무소유) 트레일은 직전 소유팀 색을 유지(carry-forward) — 최신 세그먼트 null 아님", async ({ page }) => {
  // 슛 이벤트 직후 비행 구간: ballOwner 는 null 이지만 트레일은 출발팀 색을 이어야(중립 회색이 기본 아님).
  const result = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const shots = v.events().filter((e: any) => e.type === "shot" && !e.detail);
    for (const sh of shots) {
      v.seek(sh.tick + 1);
      const trail = v.trailAt(sh.tick + 1);
      const newest = trail.length ? trail[trail.length - 1].side : null;
      if (newest === "home" || newest === "away") return { ok: true, tick: sh.tick, side: newest };
    }
    return { ok: false };
  });
  expect(result.ok, "슛 비행 직후 트레일이 팀색(carry-forward)로 유지되는 케이스가 있어야").toBe(true);
});
