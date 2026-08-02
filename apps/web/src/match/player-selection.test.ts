import { describe, expect, it } from "vitest";
import {
  arenaLabelOf,
  canvasPointOf,
  hitTestToken,
  isSelected,
  mineOf,
  selectedOf,
  selectionKey,
  toggleSelection,
  type DrawnToken,
} from "./player-selection";

/**
 * #406 W4 — 피치 선수 선택의 **순수 규칙**.
 *
 * <p>여기서 겨누는 결함은 셋이다: ①`object-fit: contain` 을 무시한 좌표 변환(폰에서 히트테스트가
 * 통째로 빗나간다) ②단독 id 키(반대 팀이 같이 켜진다, #324) ③"모르면 내 선수"라는 거짓 표식(#322).
 */

const token = (id: string, team: "home" | "away", px: number, py: number, r = 8): DrawnToken => ({
  id,
  team,
  px,
  py,
  r,
});

describe("canvasPointOf — object-fit: contain 을 존중한다", () => {
  // 실제 형상: backing 1050×680, 폰에서 무대 박스가 366×237 쯤(같은 비율이라 레터박스 0).
  it("같은 비율이면 순수 축소 — 중앙 클릭이 backing 중앙", () => {
    const p = canvasPointOf({ left: 0, top: 0, width: 525, height: 340 }, 1050, 680, 262.5, 170);
    expect(p).toEqual({ x: 525, y: 340 });
  });

  it("박스가 더 넓으면 **가로 레터박스**가 생기고 그만큼 원점이 밀린다", () => {
    // 1000×340 박스에 1050×680(비율 1.544) → scale=0.5, 그림 525×340, 좌우 여백 237.5 씩.
    const p = canvasPointOf({ left: 0, top: 0, width: 1000, height: 340 }, 1050, 680, 237.5, 0);
    expect(p).toEqual({ x: 0, y: 0 });
    // ⚠️ 레터박스를 무시하면(clientX-left)/scale = 475 가 나온다 — 피치 왼쪽 끝이 아니라 한복판.
    const naive = 237.5 / 0.5;
    expect(naive).not.toBe(0);
  });

  it("rect.left/top 오프셋을 뺀다(무대가 화면 위쪽에 있지 않다)", () => {
    const p = canvasPointOf({ left: 40, top: 100, width: 525, height: 340 }, 1050, 680, 40, 100);
    expect(p).toEqual({ x: 0, y: 0 });
  });

  it("레터박스 띠·박스 밖은 null — 피치가 아닌 자리를 선수 탭으로 읽지 않는다", () => {
    expect(canvasPointOf({ left: 0, top: 0, width: 1000, height: 340 }, 1050, 680, 10, 170)).toBeNull();
    expect(canvasPointOf({ left: 0, top: 0, width: 525, height: 340 }, 1050, 680, -5, 10)).toBeNull();
  });

  it("폭·높이 0(미마운트)에서 죽지 않는다", () => {
    expect(canvasPointOf({ left: 0, top: 0, width: 0, height: 0 }, 1050, 680, 1, 1)).toBeNull();
  });
});

describe("hitTestToken", () => {
  const tokens = [token("P074", "home", 100, 100), token("P078", "away", 400, 300)];

  it("토큰 위를 누르면 그 토큰", () => {
    expect(hitTestToken(tokens, 103, 97)?.id).toBe("P074");
  });

  it("반경 + 여유 밖이면 null(빈 공간)", () => {
    expect(hitTestToken(tokens, 250, 200)).toBeNull();
  });

  it("여유는 **코어가 준 r** 위에 붙는다 — 팔로우 줌(r=11)에서 히트 영역이 같이 커진다", () => {
    const near = [token("P074", "home", 100, 100, 8)];
    const zoomed = [token("P074", "home", 100, 100, 11)];
    // r=8 기준 반경 22 밖 / r=11 기준 25 안 → 같은 좌표가 갈린다.
    expect(hitTestToken(near, 123.5, 100)).toBeNull();
    expect(hitTestToken(zoomed, 123.5, 100)?.id).toBe("P074");
  });

  it("가장 가까운 하나만 — 두 토큰이 겹쳐도 둘 다 켜지지 않는다", () => {
    const packed = [token("A", "home", 100, 100), token("B", "away", 108, 100)];
    expect(hitTestToken(packed, 101, 100)?.id).toBe("A");
    expect(hitTestToken(packed, 107, 100)?.id).toBe("B");
  });
});

describe("toggleSelection — 팀당 1명, 재탭이 해제", () => {
  it("빈 상태에서 고르면 1명", () => {
    expect(toggleSelection([], { team: "home", playerId: "P074" })).toEqual([
      { team: "home", playerId: "P074" },
    ]);
  });

  it("같은 선수를 다시 누르면 해제된다", () => {
    const cur = [{ team: "home" as const, playerId: "P074" }];
    expect(toggleSelection(cur, { team: "home", playerId: "P074" })).toEqual([]);
  });

  it("같은 팀의 다른 선수를 누르면 **교체**(팀당 1명)", () => {
    const cur = [{ team: "home" as const, playerId: "P074" }];
    expect(toggleSelection(cur, { team: "home", playerId: "P078" })).toEqual([
      { team: "home", playerId: "P078" },
    ]);
  });

  it("다른 팀은 **공존**한다 — 내가 고른 선수 + 정보 보는 상대(목업 §2)", () => {
    const cur = toggleSelection([], { team: "home", playerId: "P078" });
    const both = toggleSelection(cur, { team: "away", playerId: "P078" });
    expect(both).toHaveLength(2);
    expect(both.map((s) => s.team)).toEqual(["home", "away"]);
  });

  it("#324: 같은 playerId 라도 팀이 다르면 **다른 선택**이다", () => {
    const cur = [{ team: "home" as const, playerId: "P078" }];
    // 단독 id 로 비교하면 여기서 홈 선택이 해제된다(= 상대를 눌렀는데 내 링이 꺼진다).
    const next = toggleSelection(cur, { team: "away", playerId: "P078" });
    expect(next).toHaveLength(2);
    expect(isSelected(next, "home", "P078")).toBe(true);
    expect(isSelected(next, "away", "P078")).toBe(true);
  });

  it("selectionKey 는 코어와 같은 규칙(팀 접두)", () => {
    expect(selectionKey("home", "P078")).toBe("home:P078");
    expect(selectionKey("away", "P078")).toBe("away:P078");
  });

  it("selectedOf 는 팀별로 답한다", () => {
    const cur = [
      { team: "home" as const, playerId: "P074" },
      { team: "away" as const, playerId: "P116" },
    ];
    expect(selectedOf(cur, "away")?.playerId).toBe("P116");
    expect(selectedOf([], "home")).toBeNull();
  });
});

describe("mineOf — 모르면 거짓말하지 않는다(#322)", () => {
  it("어웨이 라운드: 내 팀이 away 면 away 가 내 선수다", () => {
    expect(mineOf("away", "away")).toBe(true);
    expect(mineOf("home", "away")).toBe(false);
  });

  it("사이드를 모르면 null — `false`(=상대) 로 단정하지 않는다", () => {
    expect(mineOf("home", null)).toBeNull();
    expect(mineOf("home", undefined)).toBeNull();
  });
});

describe("arenaLabelOf — 밀집 UI 축", () => {
  it("이름 + 등번호", () => {
    expect(arenaLabelOf("손번개", "7")).toBe("손번개(7)");
  });

  it("번호만 있으면 `#n`, 이름만 있으면 이름", () => {
    expect(arenaLabelOf(null, "7")).toBe("#7");
    expect(arenaLabelOf("손번개", null)).toBe("손번개");
  });

  it("둘 다 없으면 null — 코어가 자기 폴백(그린 등번호)을 쓰게 둔다", () => {
    expect(arenaLabelOf(null, null)).toBeNull();
    expect(arenaLabelOf("  ", " ")).toBeNull();
  });
});
