import { describe, expect, it } from "vitest";
import {
  arenaLabelOf,
  CARD_HOME,
  CARD_INSET,
  CARD_RING_CLEAR_PX,
  canvasPointOf,
  cardRectOf,
  hitTestToken,
  isSelected,
  mineOf,
  pickCardPlacement,
  selectedOf,
  selectionKey,
  stagePointOf,
  toggleSelection,
  type CardPlacement,
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


/**
 * #406 W6 MAJOR-A — **정보 카드가 선택한 그 선수의 링을 덮지 않는다**.
 *
 * <p>여기(순수 기하)와 `e2e/p406-player-highlight.spec.ts` ⑨(실브라우저 픽셀 기하)가 한 쌍이다:
 * 규칙이 옳은가는 여기서, 화면이 그 규칙을 실제로 따르는가는 거기서 잰다.
 */
describe("stagePointOf — backing → 무대 CSS 좌표 (canvasPointOf 의 역변환)", () => {
  const box = { width: 366, height: 237 };

  it("왕복하면 제자리다 — 두 변환이 같은 레터박스 산술을 쓴다", () => {
    const stage = stagePointOf(box, 1050, 680, 700, 200)!;
    const back = canvasPointOf({ left: 0, top: 0, ...box }, 1050, 680, stage.x, stage.y)!;
    expect(back.x).toBeCloseTo(700, 3);
    expect(back.y).toBeCloseTo(200, 3);
  });

  it("레터박스가 생기는 박스에서도 왕복한다(세로가 남는 형상)", () => {
    const tall = { width: 366, height: 500 };
    const stage = stagePointOf(tall, 1050, 680, 10, 660)!;
    expect(stage.y, "위쪽 띠만큼 밀려 있다").toBeGreaterThan(0);
    const back = canvasPointOf({ left: 0, top: 0, ...tall }, 1050, 680, stage.x, stage.y)!;
    expect(back.x).toBeCloseTo(10, 3);
    expect(back.y).toBeCloseTo(660, 3);
  });

  it("박스가 0 이면 null(0 나누기로 NaN 좌표를 흘리지 않는다)", () => {
    expect(stagePointOf({ width: 0, height: 237 }, 1050, 680, 1, 1)).toBeNull();
  });
});

describe("pickCardPlacement — 링을 가리지 않는 자리", () => {
  // 390 폰 실측 형상(W7 재측정): 무대 390×253, 카드 200×76(내 선수) / 208×76(상대) / 152×76(미상).
  // 카드가 무대 폭의 절반을 넘어 좌·우 열이 겹치고 위·아래 줄도 겹친다 — "네 모서리" 모델의
  // 사각지대를 만드는 그 형상이다.
  const stage = { width: 390, height: 253 };
  const card = { width: 200, height: 76 };
  const RING_R = 8; // 와이드 뷰 링 최대 반경(backing 20) × 폰 축소율 ≈ 7.4 → 올림.

  const clearance = (p: CardPlacement, ring: { x: number; y: number }) => {
    const r = cardRectOf(p, stage, card);
    const dx = Math.max(r.left - ring.x, 0, ring.x - (r.left + r.width));
    const dy = Math.max(r.top - ring.y, 0, ring.y - (r.top + r.height));
    return Math.hypot(dx, dy);
  };

  it("기본은 왼쪽 위 — 링이 그 자리에 없으면 종전 그림 그대로", () => {
    expect(pickCardPlacement(stage, card, { x: 300, y: 210, r: RING_R })).toEqual(CARD_HOME);
    expect(pickCardPlacement(stage, card, null)).toEqual(CARD_HOME);
  });

  it("링이 기본 자리 안이면 비킨다", () => {
    const home = cardRectOf(CARD_HOME, stage, card);
    const ring = { x: home.left + home.width / 2, y: home.top + home.height / 2, r: RING_R };
    const got = pickCardPlacement(stage, card, ring);
    expect(got, "왼쪽 위를 그대로 두면 링이 통째로 덮인다").not.toEqual(CARD_HOME);
    expect(clearance(got, ring)).toBeGreaterThanOrEqual(RING_R + CARD_RING_CLEAR_PX);
  });

  /*
   * ⚠️ 이 격자 훑기가 이 계약의 알맹이다 — **무대 어느 자리에 서 있어도** 링이 남는가.
   * "네 모서리" 모델은 여기서 죽는다(무대 한가운데 y≈113 · x≈180 부근이 어느 모서리로도 안 피해진다).
   */
  it.each([
    ["출하 실측(내 선수 카드)", 390, 253, 200, 76],
    ["출하 실측(상대 카드)", 390, 253, 208, 76],
    ["출하 실측(내 팀 미상 카드)", 390, 253, 152, 76],
    ["더 좁은 무대(보수 — 셸이 무대를 줄이는 형상)", 366, 237, 234, 76],
    ["여유 검사 — 안내 문구가 한 줄 더 길어져도", 390, 253, 280, 90],
  ])("무대 전 구간 격자 — **어디에 서 있어도** 카드가 링을 비운다 [%s]", (_label, sw, sh, cw, ch) => {
    const stage = { width: sw as number, height: sh as number };
    const box = { width: cw as number, height: ch as number };
    const bad: string[] = [];
    let samples = 0;
    let moved = 0;
    for (let x = 4; x <= stage.width - 4; x += 4) {
      for (let y = 4; y <= stage.height - 4; y += 4) {
        const ring = { x, y, r: RING_R };
        const got = pickCardPlacement(stage, box, ring);
        samples++;
        const r = cardRectOf(got, stage, box);
        const dx = Math.max(r.left - x, 0, x - (r.left + r.width));
        const dy = Math.max(r.top - y, 0, y - (r.top + r.height));
        if (Math.hypot(dx, dy) < RING_R + CARD_RING_CLEAR_PX) bad.push(`(${x},${y})`);
        if (got.side !== CARD_HOME.side || got.top !== CARD_HOME.top) moved++;
      }
    }
    expect(samples, "격자 표본").toBeGreaterThan(4000);
    // 표본 전제 — 기본 자리로 전부 해결되면 이 계약은 기제를 안 재는 것이다.
    expect(moved, "비켜야 하는 자리가 표본에 실제로 있다").toBeGreaterThan(400);
    expect(bad.length, `링이 가려지는 자리 ${bad.length}곳 예: ${bad.slice(0, 8).join(" ")}`).toBe(0);
  });

  it("링 반경만큼의 여유를 요구한다 — 사각에 **닿기만 해도** 비킨다", () => {
    const r = cardRectOf(CARD_HOME, stage, card);
    // 사각 바로 오른쪽 3px — 중심은 밖이지만 링(반경 7)은 카드 위로 올라탄다.
    const grazing = { x: r.left + r.width + 3, y: r.top + r.height / 2, r: RING_R };
    expect(pickCardPlacement(stage, card, grazing)).not.toEqual(CARD_HOME);
  });

  it("히스테리시스: 지금 자리가 아직 안 가리면 근소한 이유로 되돌아가지 않는다", () => {
    const away: CardPlacement = { side: "right", top: CARD_INSET.top };
    const r = cardRectOf(CARD_HOME, stage, card);
    /*
     * 기본 사각 **바로 아래** — 기본 자리로 되돌아가도 "가리지는 않는" 정도(여유 4px 초과)라
     * 히스테리시스가 없으면 매 폴마다 좌↔우로 튄다. 좌표는 사각에서 유도한다(무대·카드 치수가
     * 바뀌어도 이 시나리오가 유지되게).
     */
    const marginal = {
      x: r.left + 40,
      y: r.top + r.height + RING_R + CARD_RING_CLEAR_PX + 4,
      r: RING_R,
    };
    expect(pickCardPlacement(stage, card, marginal, away), "경계에서 좌↔우로 튀지 않는다").toEqual(away);
    // 링이 무대 반대편 구석으로 충분히 물러나면 기본 자리로 돌아온다.
    const farAway = { x: stage.width - 20, y: stage.height - 20, r: RING_R };
    expect(pickCardPlacement(stage, card, farAway, away)).toEqual(CARD_HOME);
  });

  it("무대가 카드 두 장보다 낮은 극단에서도 **자리를 준다**(카드를 지우지 않는다)", () => {
    const tiny = { width: 120, height: 90 };
    const got = pickCardPlacement(tiny, card, { x: 60, y: 45, r: RING_R });
    expect(SIDES_OK).toContain(got.side);
    expect(Number.isFinite(got.top)).toBe(true);
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════
   * W7 BLOCKER-1 — **링이 둘일 때**. 이 화면은 팀당 1명씩 동시 선택을 1급으로 지원하는데
   * (`toggleSelection`), W6 은 카드가 보여주는 **마지막에 누른 선수**의 링 하나만 피했다.
   * 그래서 두 번째를 누르면 카드가 기본 자리로 돌아와 **첫 번째 링을 통째로 덮었다**.
   * ══════════════════════════════════════════════════════════════════════════════════════
   */
  it("링이 둘이면 **둘 다** 비운다 — 하나만 피하는 구현은 여기서 죽는다", () => {
    const home = cardRectOf(CARD_HOME, stage, card);
    // A = 기본 자리 한복판(= 카드가 피해야 하는 링) · B = 무대 오른쪽 아래(기본 자리와 무관).
    const a = { x: home.left + home.width / 2, y: home.top + home.height / 2, r: RING_R };
    const b = { x: stage.width - 24, y: stage.height - 24, r: RING_R };
    // 전제 — B 하나만 보면 기본 자리로 충분하다(그래서 "마지막 링만 피하기"가 A 를 덮는다).
    expect(pickCardPlacement(stage, card, [b])).toEqual(CARD_HOME);

    const got = pickCardPlacement(stage, card, [a, b]);
    expect(got, "두 링을 같이 보면 기본 자리는 답이 아니다").not.toEqual(CARD_HOME);
    expect(clearance(got, a), "먼저 고른 선수(A)의 링").toBeGreaterThanOrEqual(RING_R + CARD_RING_CLEAR_PX);
    expect(clearance(got, b), "나중에 고른 선수(B)의 링").toBeGreaterThanOrEqual(RING_R + CARD_RING_CLEAR_PX);
  });

  /**
   * 2링 격자 — 홈 링을 격자로 훑고 어웨이 링은 **점대칭 위치**에 둔다(양 팀이 서로 반대편에
   * 서는 실제 배치를 흉내낸다). 판정은 절대 임계가 아니라 **독립 오라클**이다: 연속 구간
   * `[topTight, 마지막줄]` × 두 열을 1px 로 전수 훑어 "둘 다 비우는 자리가 하나라도 있으면"
   * 고른 자리도 반드시 둘 다 비워야 한다. 실제로 자리가 없는 형상은 오라클도 없다고 말하므로
   * 계약이 **구조적으로 만족 불가**(초록거짓말 #7)가 되지 않는다.
   */
  it.each([
    ["출하 실측(내 선수 카드)", 390, 253, 200, 76],
    ["출하 실측(상대 카드)", 390, 253, 208, 76],
    ["여유 검사 — 안내 문구가 두 줄로 길어져도", 390, 253, 280, 90],
  ])("2링 격자 — 비킬 자리가 존재하면 **반드시 찾는다** [%s]", (_label, sw, sh, cw, ch) => {
    const st = { width: sw as number, height: sh as number };
    const box = { width: cw as number, height: ch as number };
    const need = RING_R + CARD_RING_CLEAR_PX;
    const clears = (place: CardPlacement, rings: { x: number; y: number }[]) => {
      const r = cardRectOf(place, st, box);
      return rings.every((g) => {
        const dx = Math.max(r.left - g.x, 0, g.x - (r.left + r.width));
        const dy = Math.max(r.top - g.y, 0, g.y - (r.top + r.height));
        return Math.hypot(dx, dy) >= need;
      });
    };
    let samples = 0;
    let feasible = 0;
    let dual = 0;
    const bad: string[] = [];
    for (let x = 6; x <= st.width - 6; x += 6) {
      for (let y = 6; y <= st.height - 6; y += 6) {
        const rings = [
          { x, y, r: RING_R },
          { x: st.width - x, y: st.height - y, r: RING_R },
        ];
        samples++;
        if (Math.hypot(rings[0]!.x - rings[1]!.x, rings[0]!.y - rings[1]!.y) > 2 * RING_R) dual++;
        // 독립 오라클 — 구현의 후보 목록을 쓰지 않고 연속 구간을 1px 로 전수.
        let exists = false;
        for (const side of ["left", "right"] as const) {
          for (let t = CARD_INSET.topTight; t <= st.height - CARD_INSET.side - box.height; t++) {
            if (clears({ side, top: t }, rings)) {
              exists = true;
              break;
            }
          }
          if (exists) break;
        }
        if (!exists) continue;
        feasible++;
        if (!clears(pickCardPlacement(st, box, rings), rings)) bad.push(`(${x},${y})`);
      }
    }
    // 표본 전제 — 링이 실제로 둘인 표본이 대부분이고, 비킬 자리가 있는 표본도 충분하다.
    expect(samples, "격자 표본").toBeGreaterThan(1500);
    expect(dual / samples, "두 링이 겹치지 않는 표본 비율").toBeGreaterThan(0.9);
    expect(feasible / samples, "비킬 자리가 존재하는 표본 비율").toBeGreaterThan(0.5);
    expect(bad.length, `자리가 있는데 못 찾은 곳 ${bad.length}곳 예: ${bad.slice(0, 8).join(" ")}`).toBe(0);
  });

  /*
   * W7 m-1 — **마지막 수단(시크바 자리)이 실제로 선택되는 형상**. W6 은 이 가지를
   * *"카드가 자라는 날의 안전망"* 이라고만 적고 **어떤 표본도 태우지 않았다**(제거해도 격자
   * 전수가 동일했다). 여기서 태운다: 링 둘이 세로로 갈라 서서 위 구간을 통째로 막는 형상.
   */
  it("링을 못 피하는 줄뿐이면 **시크바 아래로** 내려간다(확장 줄이 발화한다)", () => {
    const st = { width: 390, height: 253 };
    const box = { width: 200, height: 76 }; // 출하 실측 = 내 선수 카드
    const hi = st.height - CARD_INSET.bottom - box.height; // 예절을 지키는 마지막 줄
    const seekTop = st.height - CARD_INSET.bottom;
    // 출하 형상(폰 390 · 내 선수 카드)에서 실제로 이 가지가 나는 배치 = **세로로 갈라 선 두 링**.
    // ⚠️ 링이 하나뿐이면 이 폭에서 침범이 **한 번도 안 난다**(격자 전수 0) — 2선택이라야 난다.
    const rings = [
      { x: 195, y: 22, r: RING_R },
      { x: 195, y: 122, r: RING_R },
    ];
    const got = pickCardPlacement(st, box, rings);
    expect(got.top, "시크바 줄(hi)보다 아래 = 확장 후보").toBeGreaterThan(hi);
    const rect = cardRectOf(got, st, box);
    expect(rect.top + rect.height, "시크바 자리를 침범한다 — 그것이 이 가지의 대가다").toBeGreaterThan(seekTop);
    expect(rect.top + rect.height, "그래도 무대 안이다").toBeLessThanOrEqual(st.height);
    // 대가를 치른 이유 = 두 링이 다 산다.
    for (const g of rings) expect(clearance2(got, st, box, g)).toBeGreaterThanOrEqual(RING_R + CARD_RING_CLEAR_PX);
  });

  /*
   * W7 m-2 — **정말로 자리가 없을 때**. W6 주석은 *"그 상태는 계약이 표본으로 드러낸다"* 고
   * 적었지만 그 표본이 없었다. 여기서 그 가지를 태우고, 돌려준 자리가 **후보 전체의 최댓값**
   * 인지 독립 계산으로 확인한다(= "가장 덜 가리는 곳"이라는 약속의 검정).
   */
  it("자리가 정말 없으면 **가장 덜 가리는 곳**을 준다(연속 전수의 최댓값과 같다)", () => {
    const st = { width: 390, height: 150 };
    const box = { width: 234, height: 120 }; // 무대 높이의 80% — 어느 줄도 링을 못 피한다
    const ring = { x: st.width / 2, y: st.height / 2, r: RING_R };
    const got = pickCardPlacement(st, box, [ring]);

    // 전제 — 연속 전수에도 비킬 자리가 없다(있으면 이 계약이 다른 것을 재는 것이다).
    let bestSlack = Number.NEGATIVE_INFINITY;
    for (const side of ["left", "right"] as const) {
      for (let t = CARD_INSET.topTight; t <= st.height - CARD_INSET.side - box.height; t++) {
        const s = clearance2({ side, top: t }, st, box, ring) - RING_R;
        if (s > bestSlack) bestSlack = s;
      }
    }
    expect(bestSlack, "전제: 어떤 자리도 여유를 못 낸다").toBeLessThan(CARD_RING_CLEAR_PX);
    expect(clearance2(got, st, box, ring) - RING_R, "고른 자리가 그 최댓값이다").toBeCloseTo(bestSlack, 3);
    expect(SIDES_OK).toContain(got.side); // 카드를 지우지 않는다
    /*
     * ⚠️ **최댓값만 재면 "기본 자리로 되돌리는" 폴백을 못 죽인다** — 이 형상에서 `CARD_HOME`
     *   (top 34)은 밴드(4~24) **밖**이라 카드가 무대 아래로 삐져나가는데, 그 자리의 여유가
     *   우연히 최댓값과 같다. 그래서 **밴드 안**이라는 성질을 같이 건다(변이 U4 가 여기서 죽는다).
     */
    expect(got.top, "폴백도 밴드 위쪽 한계를 지킨다").toBeGreaterThanOrEqual(CARD_INSET.topTight);
    expect(got.top, "폴백도 무대 밖으로 내려가지 않는다").toBeLessThanOrEqual(
      st.height - CARD_INSET.side - box.height,
    );
  });

  /**
   * W7 m-6 — **비킨 자리의 자리 예절**. ⑤ 는 `data-side=left`/`data-top=34` 를 전제로 고정해서
   * `right@` · `top=4` · 아랫줄 · 마지막 수단의 **뷰포트 안·시크바 비침범**을 아무도 안 쟀다.
   * 여기서 격자 전수로 잰다 — ①항상 무대 안 ②시크바 침범은 **마지막 수단일 때만**.
   *
   * <p>폭별로 같이 잰다 — **출하 문구 길이에서는 320 까지도 침범 0**(W7 m-7 판단의 근거이자
   * 그 결정의 계약). 카드가 두 줄로 길어지는 형상만 확장 줄로 내려간다.
   */
  it.each([
    ["폰 390(출하 실측 카드)", 390, 253, 200, 76, false, false],
    ["분할 360", 360, 233, 208, 76, false, false],
    ["좁은 320 — 여기서부터 시크바를 내준다(m-7)", 320, 208, 208, 76, true, false],
    ["카드가 무대 절반을 넘는 320(안내 문구를 늘리면 이 형상이 된다)", 320, 208, 234, 110, true, true],
  ])("자리 예절 격자 — 무대 안 · 시크바 침범은 확장 줄뿐 [%s]", (_l, sw, sh, cw, ch, mayIntrude, wantsLastRow) => {
    const st = { width: sw as number, height: sh as number };
    const box = { width: cw as number, height: ch as number };
    const hi = st.height - CARD_INSET.bottom - box.height;
    const last = st.height - CARD_INSET.side - box.height;
    const seekTop = st.height - CARD_INSET.bottom;
    let samples = 0;
    let intruded = 0;
    let extended = 0;
    let lastRow = 0;
    const seen = new Set<string>();
    const sides = new Set<string>();
    const outside: string[] = [];
    for (let x = 6; x <= st.width - 6; x += 6) {
      for (let y = 6; y <= st.height - 6; y += 6) {
        const got = pickCardPlacement(st, box, [{ x, y, r: RING_R }]);
        const rect = cardRectOf(got, st, box);
        samples++;
        seen.add(`${got.side}@${Math.round(got.top)}`);
        sides.add(got.side);
        if (Math.abs(got.top - last) < 0.5) lastRow++;
        if (rect.left < -0.5 || rect.top < -0.5) outside.push(`(${x},${y}) 좌상단 밖`);
        if (rect.left + rect.width > st.width + 0.5) outside.push(`(${x},${y}) 오른쪽 밖`);
        if (rect.top + rect.height > st.height + 0.5) outside.push(`(${x},${y}) 아래 밖`);
        if (rect.top + rect.height > seekTop + 0.5) {
          intruded++;
          if (got.top > hi + 0.5) extended++;
        }
      }
    }
    expect(samples).toBeGreaterThan(1500);
    expect(seen.size, "여러 자리를 실제로 쓴다(한 자리만 나오면 이 계약은 공허하다)").toBeGreaterThanOrEqual(3);
    expect([...sides].sort(), "좌·우 두 열을 다 쓴다").toEqual(["left", "right"]);
    expect(outside, `카드가 무대 밖으로 나갔다: ${outside.slice(0, 5).join(" · ")}`).toEqual([]);
    expect(intruded - extended, "확장 줄이 아닌데 시크바를 덮는 자리").toBe(0);
    if (mayIntrude) {
      // 이 폭·형상에서는 발화가 **정상**이다 — 링을 살리려고 시크바를 내준다(카드는 포인터 통과).
      // 그 거래가 어디서 시작되는지를 폭별로 박제하는 것이 이 매개변수의 일이다(m-7 결정).
      expect(intruded, "이 형상에서는 확장 줄로 내려간다").toBeGreaterThan(0);
    } else {
      expect(intruded, "이 폭에서는 시크바를 덮지 않는다").toBe(0);
    }
    if (wantsLastRow) {
      expect(lastRow, "바닥 줄(무대 맨 아래)도 실제로 쓰인다").toBeGreaterThan(0);
    }
  });
});

/** 임의 무대·카드에서의 여유(위 `clearance` 는 그 describe 의 고정 형상 전용). */
function clearance2(
  place: CardPlacement,
  stage: { width: number; height: number },
  card: { width: number; height: number },
  ring: { x: number; y: number },
): number {
  const r = cardRectOf(place, stage, card);
  const dx = Math.max(r.left - ring.x, 0, ring.x - (r.left + r.width));
  const dy = Math.max(r.top - ring.y, 0, ring.y - (r.top + r.height));
  return Math.hypot(dx, dy);
}

const SIDES_OK = ["left", "right"];

describe("cardRectOf — CSS 와 같은 기하(여백의 SoT 는 CARD_INSET 하나)", () => {
  const stage = { width: 390, height: 253 };
  const card = { width: 234, height: 76 };

  it("왼쪽은 side 여백에서, 오른쪽은 무대 폭에서 되짚는다", () => {
    expect(cardRectOf({ side: "left", top: 34 }, stage, card)).toEqual({
      left: CARD_INSET.side,
      top: 34,
      width: card.width,
      height: card.height,
    });
    expect(cardRectOf({ side: "right", top: 34 }, stage, card).left).toBe(
      stage.width - CARD_INSET.side - card.width,
    );
  });

  it("아랫줄은 시크바 자리(`bottom:6px` + 트랙 36px) 위에서 끝난다", () => {
    const bottomTop = stage.height - CARD_INSET.bottom - card.height;
    expect(bottomTop + card.height, "카드 아랫변").toBeLessThanOrEqual(stage.height - 42);
    expect(CARD_INSET.topTight, "빠듯한 줄도 무대 안이다").toBeGreaterThan(0);
  });
});
