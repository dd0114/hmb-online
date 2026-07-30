import { describe, it, expect } from "vitest";
import {
  FORMATION_BASE_POSITIONS,
  FORMATION_ROWS,
  DEFAULT_BASE_FORMATION,
  formationBasePositions,
  formationSlot,
} from "./formation.js";

/**
 * 슬롯→좌표 계약 (#324).
 *
 * 이 표가 지키지 못하면 라이브에서 난 두 결함이 그대로 재현된다 —
 *  ① 좌표가 겹치면 선수 둘이 한 점에 포개진다(어웨이 CB 2명, 전반 24.9%).
 *  ② 행 안에서 slotIndex 순서와 y 순서가 어긋나면 유저가 보드에서 잡은 좌우가 뒤집힌다.
 * 그래서 "표에 값이 있다"가 아니라 **겹침 없음 · 좌우 순서 보존**을 계약으로 건다.
 */
describe("FORMATION_BASE_POSITIONS — 슬롯→기준 좌표 (#324)", () => {
  const formations = Object.keys(FORMATION_BASE_POSITIONS);

  it("라이브에서 쓰이는 포메이션 4종을 모두 덮는다", () => {
    // 라이브 봇 덱 실측: 4-4-2(29) · 4-3-3(23) · 4-2-3-1(16) · 5-3-2(12).
    expect(formations.sort()).toEqual(["4-2-3-1", "4-3-3", "4-4-2", "5-3-2"]);
  });

  it.each(formations)("%s — 선발 11슬롯이 정확히 채워진다", (f) => {
    expect(FORMATION_BASE_POSITIONS[f]).toHaveLength(11);
  });

  it.each(formations)("%s — 좌표가 0..1 안에 있다", (f) => {
    for (const [i, p] of FORMATION_BASE_POSITIONS[f]!.entries()) {
      expect(p.x, `${f} slot${i}.x`).toBeGreaterThanOrEqual(0);
      expect(p.x, `${f} slot${i}.x`).toBeLessThanOrEqual(1);
      expect(p.y, `${f} slot${i}.y`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${f} slot${i}.y`).toBeLessThanOrEqual(1);
    }
  });

  // ① 겹침 — 라이브 결함의 직접 재현 방지. 같은 좌표는 물론, 사람 눈에 한 점으로 보이는
  //    거리(정규화 0.03 ≈ 피치 3.2m×2.0m)도 금지한다.
  const MIN_SEPARATION = 0.03;
  it.each(formations)("%s — 어떤 두 슬롯도 겹치지 않는다", (f) => {
    const slots = FORMATION_BASE_POSITIONS[f]!;
    const tooClose: string[] = [];
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i]!.x - slots[j]!.x, slots[i]!.y - slots[j]!.y);
        if (d < MIN_SEPARATION) tooClose.push(`slot${i}~slot${j} (${d.toFixed(3)})`);
      }
    }
    expect(tooClose, `${f} 겹친 슬롯쌍`).toEqual([]);
  });

  // ② 좌우 순서 — 보드에서 오른쪽에 둔 선수가 피치에서도 오른쪽이어야 한다.
  it.each(formations)("%s — 행 안에서 slotIndex 가 커지면 y 도 커진다", (f) => {
    const slots = FORMATION_BASE_POSITIONS[f]!;
    for (const row of FORMATION_ROWS[f]!) {
      const ys = row.map((i) => slots[i]!.y);
      const ascending = ys.every((y, k) => k === 0 || ys[k - 1]! < y);
      expect(ascending, `${f} 행 [${row.join(",")}] 의 y = [${ys.join(", ")}]`).toBe(true);
    }
  });

  it.each(formations)("%s — 행 구성이 슬롯 0..10 을 빠짐없이 한 번씩 덮는다", (f) => {
    expect(FORMATION_ROWS[f]!.flat().slice().sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it.each(formations)("%s — GK 는 자기 골문 쪽 끝, 중앙", (f) => {
    const gk = FORMATION_BASE_POSITIONS[f]![0]!;
    expect(gk.x, `${f} GK.x`).toBeLessThan(0.1);
    expect(gk.y, `${f} GK.y`).toBe(0.5);
  });

  it.each(formations)("%s — 표시 순서는 FW 행이 먼저다(x 가 앞 행일수록 크다)", (f) => {
    const slots = FORMATION_BASE_POSITIONS[f]!;
    const rowX = FORMATION_ROWS[f]!.map((row) => row.reduce((s, i) => s + slots[i]!.x, 0) / row.length);
    const descending = rowX.every((x, k) => k === 0 || rowX[k - 1]! > x);
    expect(descending, `행 평균 x = [${rowX.map((v) => v.toFixed(2)).join(", ")}]`).toBe(true);
  });
});

describe("조회 헬퍼", () => {
  it("모르는 포메이션은 기본 포메이션으로 떨어진다(좌표를 못 싣는 것보다 낫다)", () => {
    expect(formationBasePositions("3-5-2")).toBe(FORMATION_BASE_POSITIONS[DEFAULT_BASE_FORMATION]);
  });

  it("formationSlot 은 슬롯 좌표를, 범위 밖이면 undefined", () => {
    expect(formationSlot("4-3-3", 9)).toEqual({ x: 0.78, y: 0.5 });
    expect(formationSlot("4-3-3", 11)).toBeUndefined();
  });
});
