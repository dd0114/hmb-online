import { describe, expect, it } from "vitest";
import { FORMATION_ROWS, FORMATION_BASE_POSITIONS } from "@hmb/shared";
import { FORMATION_LAYOUTS } from "./deck-logic";
import { starterCoords } from "./tactics-logic";

/**
 * #324 — **전술보드의 좌우가 곧 피치의 좌우**라는 약속을 묶는 자리.
 *
 * <p>유저는 이 보드에서 선수를 좌우로 끌어다 놓고, 서버는 그 배치를 `slotIndex` <b>하나로만</b>
 * 받는다. 그 번호가 피치 어디인지는 `@hmb/shared` 의 {@link FORMATION_BASE_POSITIONS} 가 정하고,
 * AI 프롬프트가 그 좌표를 그대로 싣는다. 그래서 **보드 행 구성과 shared 표가 어긋나는 순간**
 * 유저가 왼쪽에 둔 선수가 경기에선 오른쪽에 선다 — #324 가 고친 결함 그 자체다.
 *
 * <p>⚠️ 이 파일이 생기기 전엔 그 등식을 묶는 것이 <b>아무것도 없었다</b>(독립검증 blocker-2).
 * `formation.ts` 주석은 "web 테스트가 계약으로 건다"고 적어 뒀지만 실제로는 존재하지 않았고,
 * `FORMATION_ROWS` 는 자기 테스트 말고 소비자가 없는 상수였다. 지금은 web 보드를 바꾸면 여기서 죽는다.
 */
describe("#324 전술보드 ↔ shared 슬롯 좌표 드리프트 락", () => {
  const offered = Object.keys(FORMATION_LAYOUTS);

  it("보드가 유저에게 제시하는 포메이션은 shared 표가 전부 덮는다", () => {
    for (const f of offered) {
      expect(FORMATION_BASE_POSITIONS[f], `shared 에 ${f} 없음`).toBeDefined();
      expect(FORMATION_ROWS[f], `shared ROWS 에 ${f} 없음`).toBeDefined();
    }
  });

  it("보드 행 구성(순서 포함)이 shared FORMATION_ROWS 와 같다", () => {
    for (const f of offered) {
      const board = FORMATION_LAYOUTS[f]!.map((r) => r.slotIndexes);
      expect(FORMATION_ROWS[f]!.map((r) => [...r]), `${f} 행 구성`).toEqual(board);
    }
  });

  /*
   * 위 두 개만으로는 "같은 배열을 두 곳에 적었다"까지밖에 못 지킨다. 진짜 약속은
   * **보드에서 오른쪽에 그려진 토큰이 피치에서도 오른쪽**이라는 것이므로, 실제 렌더 좌표
   * (`starterCoords` — 보드가 토큰을 그리는 바로 그 함수)와 피치 y 를 직접 대조한다.
   */
  it("보드에서 오른쪽에 그려진 선수는 피치에서도 오른쪽이다(행 안 좌→우 == y 오름차순)", () => {
    for (const f of offered) {
      const coords = starterCoords(f);
      const slots = FORMATION_BASE_POSITIONS[f]!;
      for (const row of FORMATION_ROWS[f]!) {
        if (row.length < 2) continue;
        const boardX = row.map((i) => coords.find((c) => c.slotIndex === i)!.x);
        const pitchY = row.map((i) => slots[i]!.y);
        for (let k = 1; k < row.length; k++) {
          expect(boardX[k]!, `${f} 보드 x: slot${row[k - 1]} < slot${row[k]}`).toBeGreaterThan(boardX[k - 1]!);
          expect(pitchY[k]!, `${f} 피치 y: slot${row[k - 1]} < slot${row[k]}`).toBeGreaterThan(pitchY[k - 1]!);
        }
      }
    }
  });

  it("보드에서 위(공격)쪽 행은 피치에서 상대 골문에 가깝다(전후 축도 뒤집히지 않게)", () => {
    for (const f of offered) {
      const coords = starterCoords(f);
      const slots = FORMATION_BASE_POSITIONS[f]!;
      const rows = FORMATION_ROWS[f]!;
      for (let r = 1; r < rows.length; r++) {
        const upperY = coords.find((c) => c.slotIndex === rows[r - 1]![0])!.y; // 보드 y 는 위가 작다
        const lowerY = coords.find((c) => c.slotIndex === rows[r]![0])!.y;
        const upperX = slots[rows[r - 1]![0]!]!.x; // 피치 x 는 상대 골문이 크다
        const lowerX = slots[rows[r]![0]!]!.x;
        expect(upperY, `${f} 보드 행 순서`).toBeLessThan(lowerY);
        expect(upperX, `${f} 피치 전진도`).toBeGreaterThan(lowerX);
      }
    }
  });
});
