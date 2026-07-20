/**
 * 모바일 독 기하 (#106 R3a). 실측 기준값은 390×844 크롬 실측(R3a 착수 시점):
 *   dockTop=344.5 / dockH=443.5 / 문서 런웨이 60vh=506 / 최대 스크롤 죽은 띠 175 / 접힘 점프 507.
 */
import { describe, expect, it } from "vitest";
import { runwayPx, scrollDeltaForToken } from "./dock-geometry";

describe("scrollDeltaForToken — 독을 펼쳐도 '누구에게 쓰는지' 가 보인다", () => {
  const strip = { dockTop: 344, headerBottom: 96 };

  it("토큰이 독에 가려 있으면 위로 끌어올린다(양수)", () => {
    const d = scrollDeltaForToken({ ...strip, tokenTop: 400, tokenBottom: 452 });
    expect(d).toBeGreaterThan(0);
    // 스크롤 후 토큰 하단이 띠 안으로 들어온다
    expect(452 - d).toBeLessThanOrEqual(344 - 8);
  });

  it("토큰이 시트 바 뒤에 있으면 아래로 내린다(음수)", () => {
    const d = scrollDeltaForToken({ ...strip, tokenTop: 40, tokenBottom: 92 });
    expect(d).toBeLessThan(0);
    expect(40 - d).toBeGreaterThanOrEqual(96 + 8 - 0.001);
  });

  it("이미 띠 안이면 스크롤하지 않는다(불필요한 점프 금지)", () => {
    expect(scrollDeltaForToken({ ...strip, tokenTop: 200, tokenBottom: 252 })).toBe(0);
  });

  it("띠가 토큰보다 좁으면 위 정렬(시트 바에 잘리지 않게)", () => {
    const d = scrollDeltaForToken({ dockTop: 260, headerBottom: 96, tokenTop: 300, tokenBottom: 452 });
    expect(300 - d).toBe(96 + 8);
  });

  it("띠 자체가 없으면 0", () => {
    expect(scrollDeltaForToken({ dockTop: 100, headerBottom: 96, tokenTop: 300, tokenBottom: 352 })).toBe(0);
  });
});

describe("runwayPx — 60vh 고정치 대신 덮인 만큼만 (m6/m7)", () => {
  it("뒤따르는 블록이 없으면 독이 덮은 높이만큼", () => {
    expect(runwayPx({ innerHeight: 844, dockTop: 344, trailingHeight: 0 })).toBe(508);
  });

  it("실측 케이스: 뒤 블록(노트 169px)이 있으면 그만큼 덜 늘린다 — 죽은 띠 175 → ~8", () => {
    const r = runwayPx({ innerHeight: 844, dockTop: 344.5, trailingHeight: 169 });
    expect(r).toBe(Math.round(844 - 344.5 - 169 + 8));
    expect(r).toBeLessThan(506); // 기존 60vh 고정치보다 작다
  });

  it("뒤 블록만으로 충분하면 0(런웨이 없음 = 접힘 점프 없음)", () => {
    expect(runwayPx({ innerHeight: 844, dockTop: 344, trailingHeight: 900 })).toBe(0);
  });
});
