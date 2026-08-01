/**
 * 타임라인 핀 계약 (#177) — "몇 분 몇 초에 무슨 장면"을 QA 가 집어서 되돌려볼 수 있어야 한다.
 * 구 QA 뷰어 셸(dev-viewer index.html buildMarks)이 갖고 있던 규칙을 web 호스트로 옮긴 것이라,
 * 여기서 색·높이·필터 규칙을 박제해 재유실을 막는다.
 */
import { describe, expect, it } from "vitest";
import { buildTimelinePins, formatMatchClock, pinClock } from "./timeline-pins";

// 스냅샷 = 틱 그대로(서브샘플 없음) 가정한 단순 매핑.
const idOfTick = (t: number) => t;

describe("formatMatchClock", () => {
  it("틱(게임초)을 분:초로 — 초는 2자리 고정", () => {
    expect(formatMatchClock(0)).toBe(`0'00"`);
    expect(formatMatchClock(9)).toBe(`0'09"`);
    expect(formatMatchClock(754)).toBe(`12'34"`);
  });

  it("음수·소수는 안전하게 바닥값으로", () => {
    expect(formatMatchClock(-5)).toBe(`0'00"`);
    expect(formatMatchClock(61.9)).toBe(`1'01"`);
  });
});

describe("buildTimelinePins", () => {
  const events = [
    { tick: 0, type: "kickoff" },
    { tick: 60, type: "shot", detail: "off_target", team: "home" },
    { tick: 120, type: "shot", detail: "one_on_one", team: "home" },
    { tick: 121, type: "save", team: "away" },
    { tick: 300, type: "goal", team: "away" },
    { tick: 400, type: "goal", team: "home" },
    { tick: 500, type: "penalty", team: "home" },
    { tick: 600, type: "kickoff", detail: "corner", team: "home" },
    { tick: 700, type: "pass", team: "home" },
  ];

  it("키 장면만 핀이 된다 — 빗나간 슛·패스·일반 킥오프는 제외", () => {
    const pins = buildTimelinePins(events, idOfTick, 901);
    expect(pins.map((p) => p.tick)).toEqual([120, 121, 300, 400, 500, 600]);
    expect(pins.map((p) => p.kind)).toEqual(["shot_on", "save", "goal", "goal", "penalty", "corner"]);
  });

  it("골 핀은 팀색(홈 파랑 / 원정 빨강)이고 가장 크고 위에 온다", () => {
    const pins = buildTimelinePins(events, idOfTick, 901);
    const away = pins.find((p) => p.tick === 300)!;
    const home = pins.find((p) => p.tick === 400)!;
    expect(away.color).toBe("#ef4444");
    expect(home.color).toBe("#3b82f6");
    for (const other of pins.filter((p) => p.kind !== "goal")) {
      expect(home.height).toBeGreaterThan(other.height);
      expect(home.z).toBeGreaterThan(other.z);
    }
  });

  it("큰 장면(골·PK·선방)은 위 레인, 작은 장면(유효슛·코너)은 아래 레인 — 겹쳐서 클릭이 막히지 않게", () => {
    const pins = buildTimelinePins(events, idOfTick, 901);
    const majorOf = (tick: number) => pins.find((p) => p.tick === tick)!.major;
    expect([300, 400, 500, 121].every(majorOf)).toBe(true);
    expect([120, 600].some(majorOf)).toBe(false);
  });

  it("위치는 스냅샷 인덱스 비율(%) — 스크럽 바와 같은 기준", () => {
    const pins = buildTimelinePins(events, idOfTick, 901);
    expect(pins.find((p) => p.tick === 900)).toBeUndefined();
    expect(pins.find((p) => p.tick === 400)!.pct).toBeCloseTo((400 / 900) * 100, 5);
  });

  it("서브샘플 로그(틱≠인덱스)에서도 인덱스 기준으로 찍는다", () => {
    // 2:1 서브샘플 = 인덱스 = 틱/2.
    const pins = buildTimelinePins(events, (t) => Math.floor(t / 2), 451);
    expect(pins.find((p) => p.tick === 400)!.pct).toBeCloseTo((200 / 450) * 100, 5);
  });

  it("툴팁은 시:초 + 장면 이름", () => {
    const pins = buildTimelinePins(events, idOfTick, 901);
    expect(pins.find((p) => p.tick === 300)!.label).toBe(`5'00" · AWAY GOAL`);
    expect(pins.find((p) => p.tick === 121)!.label).toBe(`2'01" · Save`);
  });

  it("픽셀 단위로 겹치는 핀은 우선순위 높은 하나로 합친다(뒤 핀이 앞 핀 클릭을 막지 않게)", () => {
    // 90분(5400틱) 경기에서 1~2초 차 이벤트 = 트랙에서 0.02% 차이 → 사실상 같은 자리.
    const tight = [
      { tick: 3000, type: "shot", detail: "one_on_one", team: "home" },
      { tick: 3001, type: "shot", detail: "one_on_one", team: "home" },
      { tick: 3002, type: "goal", team: "home" },
      { tick: 4000, type: "corner", detail: "corner" },
    ];
    const pins = buildTimelinePins(tight, idOfTick, 5401);
    // 같은 자리 3건 → 골 하나만 남는다. (골=위 레인, 유효슛=아래 레인이라 레인별로 각각 1개.)
    expect(pins.filter((p) => p.major).map((p) => p.tick)).toEqual([3002]);
    expect(pins.filter((p) => !p.major).map((p) => p.tick)).toEqual([3000]);
  });

  it("충분히 떨어진 핀은 합치지 않는다", () => {
    const spread = [
      { tick: 100, type: "goal", team: "home" },
      { tick: 2700, type: "goal", team: "away" },
      { tick: 5300, type: "goal", team: "home" },
    ];
    expect(buildTimelinePins(spread, idOfTick, 5401).map((p) => p.tick)).toEqual([100, 2700, 5300]);
  });

  it("로그가 없거나 스냅샷이 1개 이하면 빈 배열(0으로 나누지 않는다)", () => {
    expect(buildTimelinePins(null, idOfTick, 900)).toEqual([]);
    expect(buildTimelinePins(events, idOfTick, 1)).toEqual([]);
  });
});

/**
 * #388 — **핀·장면 목록도 로그줄과 같은 축을 쓴다.**
 *
 * 엔진은 45분(하프 1350틱)을 돌리고 표기만 0~90' 로 스케일해 이벤트에 `minute` 을 구워 내린다.
 * 틱을 직독하면 정확히 절반이라, 로그줄이 `48'` 이라고 말하는 장면을 이 목록은 `24'00"` 라고 말했다
 * (한 화면이 두 시각을 말한다 — 헤더와 같은 뿌리).
 */
describe("#388 pinClock — 구워진 표기 분을 쓴다", () => {
  it("이벤트의 minute 을 그대로 쓴다 (틱/60 아님)", () => {
    // 하프 1350틱 레짐: tick 1440 은 구운 분 48. 예전 규칙이면 24'00".
    expect(pinClock({ tick: 1440, minute: 48 })).toBe("48'");
    expect(pinClock({ tick: 0, minute: 0 })).toBe("0'");
  });

  it("minute 이 없는 로그(구 서버·손상)에서만 틱 폴백 — 숫자가 사라지지는 않는다", () => {
    expect(pinClock({ tick: 754 })).toBe(`12'34"`);
  });

  it("핀 label·clock 이 같은 값을 말한다 (툴팁과 목록이 갈라지지 않는다)", () => {
    const pins = buildTimelinePins(
      [{ tick: 1440, minute: 48, type: "goal", team: "home" }],
      (t) => t,
      2000,
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]!.clock).toBe("48'");
    expect(pins[0]!.label).toBe("48' · HOME GOAL");
  });
});
