import { describe, expect, it } from "vitest";
import {
  briefTabVisible,
  CLOCK_PLACEHOLDER,
  clockLabel,
  DEFAULT_INFO_TAB,
  displayMinuteAt,
  displaySecondAt,
  displayTicksPerMinute,
  halfEndMinuteOf,
  halfForState,
  headerScore,
  headerClock,
  headerMinute,
  INFO_TAB_KEYS,
  isHalftimeState,
  myTeamSide,
  needsPlayerStats,
  playedBaseline,
  resolveActiveTab,
  sheetHeight,
  statePanelFor,
  tabsFor,
  teamNamesOf,
  type TabKey,
} from "./stage-state";

describe("정보 탭 상수 (#284)", () => {
  it("표시 순서는 통계·로그·후반지시로 고정", () => {
    expect(INFO_TAB_KEYS).toEqual(["stats", "players", "log", "brief"]);
  });

  it("기본 탭은 로그 — 표시 순서의 첫 탭과 **다르다**(둘은 다른 축)", () => {
    expect(DEFAULT_INFO_TAB).toBe("log");
    expect(DEFAULT_INFO_TAB).not.toBe(INFO_TAB_KEYS[0]);
  });
});

describe("상태 패널 / 하프", () => {
  it("감독시간=감독, FINISHED=결과, 그 외 없음", () => {
    // 현행 상태명과 레거시 이름을 **둘 다** 통과시켜야 한다(#226 — 한쪽만 보면 배포본이 규칙 밖에 남는다).
    expect(statePanelFor("HALFTIME")).toBe("halftime");
    expect(statePanelFor("H1_BREAK")).toBe("halftime");
    expect(statePanelFor("FINISHED")).toBe("result");
    expect(statePanelFor("BRIEFING")).toBeNull();
    expect(statePanelFor(undefined)).toBeNull();

    // 오토(#249): 감독 패널을 열지 않는다. 서버가 감독시간을 0초로 열고 곧바로 후반으로 잇기
    // 때문에 이 상태는 이미 지나간 것이고, 한 프레임 보인다고 감독 패널이 번쩍이면 안 된다.
    expect(statePanelFor("HALFTIME", true)).toBeNull();
    expect(statePanelFor("H1_BREAK", true)).toBeNull();
    expect(statePanelFor("HALFTIME", false)).toBe("halftime"); // 회귀: 정상 흐름은 그대로
    expect(statePanelFor("FINISHED", true)).toBe("result"); // 결과는 오토와 무관
  });

  it("FINISHED 는 후반, 그 외는 전반을 재생한다", () => {
    expect(halfForState("FINISHED")).toBe(2);
    expect(halfForState("H1_BREAK")).toBe(1);
  });
});

describe("감독시간 판정 / 헤더 시계 (#226)", () => {
  it("현행 HALFTIME 과 레거시 H1_BREAK 둘 다 감독시간이다", () => {
    expect(isHalftimeState("HALFTIME")).toBe(true);
    expect(isHalftimeState("H1_BREAK")).toBe(true);
    for (const s of ["FIRST_HALF", "SECOND_HALF", "FINISHED", "BRIEFING", undefined]) {
      expect(isHalftimeState(s)).toBe(false);
    }
  });

  it("감독시간 헤더 시계는 재생 플레이헤드가 아니라 하프 끝을 가리킨다", () => {
    // 되감아 플레이헤드가 0 이어도 헤더는 하프 끝 — hero 제보(0')의 재현 조건이 바로 이것.
    expect(headerClock("HALFTIME", H1_LOG, 0)?.minute).toBe(45);
    expect(headerClock("H1_BREAK", H1_LOG, 600)?.minute).toBe(45);
    // 옛 이름은 별칭으로만 남는다(호출부가 다른 웨이브 소유) — 같은 함수여야 한다.
    expect(headerMinute).toBe(headerClock);
  });

  it("라이브 하프는 그대로 플레이헤드를 따라간다", () => {
    expect(headerClock("FIRST_HALF", H1_LOG, 600)?.minute).toBe(20);
    expect(headerClock("SECOND_HALF", H2_LOG, 2100)?.minute).toBe(70);
    expect(headerClock("FINISHED", H2_LOG, 2699)?.minute).toBe(89);
  });

  it("하프 끝을 모르면(로그 미도착) 플레이헤드로 되돌아가지 않고 시계를 접는다", () => {
    // null 을 주면 ScoreBar 가 시계를 아예 안 그린다 = 틀린 분보다 없는 편이 낫다.
    expect(headerClock("HALFTIME", null, 0)).toBeNull();
    expect(headerClock("HALFTIME", {}, 600)).toBeNull();
  });
});

/**
 * #388 — **헤더 시계가 로그줄과 같은 축을 쓴다.**
 *
 * 회귀의 정체: 엔진은 45분(하프 1350틱)을 돌리고 표기만 0~90' 로 스케일해
 * (`displayMinutes`, #365) 스냅샷·이벤트에 `minute` 을 **구워서** 내린다. 로그줄·타임라인은 그
 * 구운 값을 읽는데 헤더만 `floor(tick / 60)` 으로 **틱을 분으로 직독**해서 정확히 절반을 말했다
 * (라이브 실측: 헤더 25' / 로그줄 48-51').
 *
 * ⚠️ **이 테스트가 예전엔 초록이었다.** 값이 90분 레짐(하프 2700틱)으로 고정돼 있어서
 * `tick/60` 이 우연히 맞았기 때문이다 — #365 가 그 우연을 깼는데 계약은 그대로였다.
 * 그래서 여기 픽스처는 **지금 레짐(하프 1350틱 · minute = floor(tick/30))** 이다.
 */
const snap = (tick: number) => ({ tick, minute: Math.floor(tick / 30) });
/** 전반 로그: 틱 0..1349, 끝에 `half_whistle minute 45`(로그줄이 말하는 그 값). */
const H1_LOG = {
  tickSnapshots: Array.from({ length: 46 }, (_, i) => snap(i * 30)).concat([snap(1349)]),
  events: [{ tick: 1350, minute: 45, type: "half_whistle" }],
};
/** 후반 로그: 틱은 1350 부터 이어진다(인덱스 ≠ 틱). */
const H2_LOG = {
  tickSnapshots: Array.from({ length: 46 }, (_, i) => snap(1350 + i * 30)).concat([snap(2699)]),
  events: [{ tick: 2699, minute: 90, type: "full_whistle" }],
};

describe("#388 헤더 시계 — 구워진 표기 분을 쓴다", () => {
  it("플레이헤드의 스냅샷에 구워진 minute 을 그대로 쓴다 (틱/60 아님)", () => {
    // 같은 틱을 예전 규칙으로 읽으면 절반이 나온다: 1290/60 = 21' vs 구운 값 43'.
    expect(displayMinuteAt(H1_LOG, 1290)).toBe(43);
    expect(displayMinuteAt(H1_LOG, 0)).toBe(0);
    expect(displayMinuteAt(H2_LOG, 2100)).toBe(70);
  });

  it("스냅샷이 성기어도(트림된 로그) tick 이하의 마지막 스냅샷을 쓴다", () => {
    // 실서버 로그는 틱당 1개지만 리포 픽스처는 트림본이라 성기다 — 둘 다 견뎌야 한다.
    expect(displayMinuteAt(H1_LOG, 1295)).toBe(43); // 1290 스냅샷 구간
    expect(displayMinuteAt(H1_LOG, 29)).toBe(0);
  });

  it("모양이 아니면 숫자를 지어내지 않는다 (null)", () => {
    for (const bad of [null, undefined, {}, { tickSnapshots: [] }, { tickSnapshots: "x" }]) {
      expect(displayMinuteAt(bad, 100)).toBeNull();
    }
    // minute 이 빠진 스냅샷(구 서버·손상 응답)도 지어내지 않는다.
    expect(displayMinuteAt({ tickSnapshots: [{ tick: 0 }] }, 100)).toBeNull();
    expect(displayMinuteAt(H1_LOG, null)).toBeNull();
  });

  it("감독시간은 **하프 종료 휘슬의 minute** — 마지막 스냅샷(44')이 아니라 45'", () => {
    // 로그줄이 `45' 전반 종료` 라고 말하는데 헤더가 44' 면 그 화면이 또 두 시각을 말한다.
    expect(halfEndMinuteOf(H1_LOG)).toBe(45);
    expect(halfEndMinuteOf(H2_LOG)).toBe(90);
    // 휘슬 이벤트가 없으면 마지막 스냅샷으로 폴백(그래도 지어내지는 않는다).
    expect(halfEndMinuteOf({ tickSnapshots: [snap(1349)], events: [] })).toBe(44);
    expect(halfEndMinuteOf({})).toBeNull();
  });
});

/**
 * #406 W2 — **초를 붙이되 분은 여전히 로그가 굽는다.**
 *
 * hero 확정: `48'32"` 통합 표기 · 보간 없음(1틱 = 표기 2초라 초가 2씩 뛴다 — 데이터에 없는 값을
 * 화면이 지어내지 않는다). 그래서 초는 **그 분의 앵커 틱에서 흐른 만큼**이고, "1틱이 몇 표기초냐"는
 * **로그에서 되유도**한다. 상수를 적으면 엔진이 레짐을 바꾸는 날 #388 이 그대로 재발한다.
 *
 * ⚠️ 그래서 이 블록에는 **레짐이 다른 대조군**(90분 레짐 = 60틱/분)이 같이 탄다. 대조군이 없으면
 * `30` 을 박은 변이체가 전부 초록으로 통과한다 — 그게 #388 이 3개월 산 방식이다.
 */
/** 대조군: 구 레짐(하프 2700틱 · minute = floor(tick/60)). **틱→분 관계만** 다르다. */
const snap60 = (tick: number) => ({ tick, minute: Math.floor(tick / 60) });
const LEGACY_LOG = {
  tickSnapshots: Array.from({ length: 46 }, (_, i) => snap60(i * 60)),
  events: [{ tick: 2700, minute: 45, type: "half_whistle" }],
};

/**
 * ★ **라이브 형상 표본** — 한 분 안에 스냅샷이 **여러 개**다.
 *
 * 위 `H1_LOG`/`LEGACY_LOG` 는 분당 스냅샷이 정확히 1개(`i*30`)라 **그 분의 첫 틱과 마지막 틱이
 * 구조적으로 같다** → "앵커 = 그 분의 **첫** 틱" 규칙을 한 건도 검사하지 못한다. 실제로 앵커를
 * *마지막* 틱으로 바꾸는 변이가 **이 파일 전체를 통과**했다(e2e 에서만 죽었다) — 이 픽스처가
 * 생긴 뒤로는 그 변이에 **3건**이 죽고, 죽는 3건이 전부 아래 `DENSE_LOG` 블록이다(2026-08-03 실측).
 * ⚠️ 여기 한때 *"이 파일 **63**건"* 이라고 적혀 있었는데 **재보지 않은 숫자**였다 — 이 파일의
 * `it()` 수는 지금 **52** 이고 63 이었던 적이 없다(#406 W8 에서 정정, apps/web CLAUDE.md 표 #11).
 * 실서버는 `simulateRange` 가 **틱당 스냅샷 1개**를 내리므로 **라이브가 바로 이 케이스**다.
 *
 * ⚠️ **이벤트를 비워 둔 것은 의도다.** 진행 중인 하프에는 종료 휘슬이 아직 없다(= 실제 라이브 형상)
 * → `displayTicksPerMinute` 의 휘슬 폴백이 **앵커 계산의 오류를 가려 주지 못한다**. 휘슬을 넣으면
 * `1350/45 = 30` 이 우연히 같은 답을 내서 스케일 계약이 공허해진다.
 */
const DENSE_LOG = {
  /** 틱 600..690 = 표기 20'~23'(현행 레짐 30틱/분). 한 분에 스냅샷 30개. */
  tickSnapshots: Array.from({ length: 91 }, (_, i) => snap(600 + i)),
  events: [],
};

describe("#406 헤더 시계 초 — 앵커 기준, 스케일은 로그에서", () => {
  it("표기 1분의 틱 수를 **로그에서** 되유도한다 (레짐마다 다르다)", () => {
    expect(displayTicksPerMinute(H1_LOG)).toBe(30); // 현행: 하프 1350틱 / 45'
    expect(displayTicksPerMinute(H2_LOG)).toBe(30);
    expect(displayTicksPerMinute(LEGACY_LOG)).toBe(60); // 구 레짐: 2700틱 / 45'
  });

  it("분이 하나뿐인 트림 로그는 **휘슬**로 떨어진다(clockScaleOf 와 같은 재료)", () => {
    expect(displayTicksPerMinute({ tickSnapshots: [snap(600)], events: H1_LOG.events })).toBe(30);
    // full_whistle 은 그 틱까지 포함이라 +1 보정 — 2699 → 2700/90.
    expect(displayTicksPerMinute({ tickSnapshots: [snap(2100)], events: H2_LOG.events })).toBe(30);
  });

  it("근거가 없으면 스케일도 초도 **지어내지 않는다**", () => {
    const lonely = { tickSnapshots: [snap(600)], events: [] };
    expect(displayTicksPerMinute(lonely)).toBeNull();
    expect(displaySecondAt(lonely, 610, 20)).toBeNull();
    // 앵커가 없는 분(감독시간 휘슬 분 45 는 스냅샷에 없다)에도 초를 만들지 않는다.
    expect(displaySecondAt(H1_LOG, 1349, 46)).toBeNull();
    expect(displaySecondAt(H1_LOG, null, 20)).toBeNull();
    expect(displaySecondAt(H1_LOG, 600, null)).toBeNull();
  });

  it("초는 그 분의 **시작 틱에서 00**, 분이 넘어가기 직전이 최대다", () => {
    expect(displaySecondAt(H1_LOG, 600, 20)).toBe(0); // 20' 앵커
    expect(displaySecondAt(H1_LOG, 629, 20)).toBe(58); // 다음 틱이면 21'
    expect(displayMinuteAt(H1_LOG, 630)).toBe(21);
    expect(displaySecondAt(H1_LOG, 630, 21)).toBe(0);
    // 60 을 넘기지 않는다 — 넘으면 `20'60"` 이라는 없는 시각이 된다.
    for (let t = 600; t < 630; t += 1) {
      const s = displaySecondAt(H1_LOG, t, 20)!;
      expect(s, `tick ${t}`).toBeGreaterThanOrEqual(0);
      expect(s, `tick ${t}`).toBeLessThan(60);
    }
  });

  /**
   * ★ **변이체 킬** — `30`(또는 `2초/틱`)을 상수로 박으면 여기가 죽는다.
   * 같은 틱 620 이 레짐에 따라 다른 초를 말해야 한다: 현행 40" vs 구 레짐 20".
   */
  it("같은 틱이라도 로그의 레짐이 다르면 초도 다르다 (스케일 하드코딩 사망)", () => {
    expect(displayMinuteAt(H1_LOG, 620)).toBe(20);
    expect(displaySecondAt(H1_LOG, 620, 20)).toBe(40);

    expect(displayMinuteAt(LEGACY_LOG, 620)).toBe(10);
    expect(displaySecondAt(LEGACY_LOG, 620, 10)).toBe(20);

    // 라벨까지 관통 — 화면 문자열이 레짐을 따라간다.
    expect(clockLabel("FIRST_HALF", headerClock("FIRST_HALF", H1_LOG, 620))).toBe("20'40\"");
    expect(clockLabel("FIRST_HALF", headerClock("FIRST_HALF", LEGACY_LOG, 620))).toBe("10'20\"");
  });

  /**
   * ★ **이 웨이브의 불변식** — 초가 붙어도 헤더의 분은 **로그줄의 분**(구운 `minute`)과 같다.
   * #388 은 헤더가 분을 직접 유도해서 생긴 사고다. 초를 앵커로 만드는 한 이건 구조적으로 참이지만,
   * 누군가 `clockLabel` 안에서 시각을 다시 계산하는 순간 깨지므로 라벨 문자열에서 되읽어 확인한다.
   */
  it("헤더가 그리는 분 == 그 틱의 구운 분 (전 구간 스윕)", () => {
    for (const [log, ticks] of [
      [H1_LOG, [0, 1, 29, 30, 315, 620, 1290, 1349]],
      [H2_LOG, [1350, 1380, 2100, 2669, 2699]],
      [LEGACY_LOG, [0, 59, 60, 620, 2400, 2700]],
    ] as const) {
      for (const t of ticks) {
        const label = clockLabel("FIRST_HALF", headerClock("FIRST_HALF", log, t))!;
        const shown = Number(/^(\d+)'/.exec(label)?.[1]);
        expect(shown, `tick ${t} → ${label}`).toBe(displayMinuteAt(log, t));
      }
    }
  });
});

/**
 * #406 W2 계약 보강 — **앵커는 그 분의 첫 틱이다**(독립검증이 남긴 검정력 갭 ①).
 *
 * 위 블록의 계약들은 전부 "분당 스냅샷 1개" 로그로 서 있어서, 앵커를 **마지막** 틱으로 바꿔도
 * 값이 하나도 안 바뀐다(첫 = 마지막). 그 변이는 라이브 형상(틱당 1스냅샷)에서만 죽는다:
 * 마지막-틱 앵커는 ⓐ 앵커 간격을 왜곡해 **스케일 자체**를 틀리게 하고 ⓑ 분 앞부분의 초를
 * 음수로 만들어 **0 으로 눌러 버린다**(`19'..20'` 내내 `00"`).
 */
describe("#406 초의 앵커 = 그 분의 **첫** 틱 (라이브 형상: 틱당 1스냅샷)", () => {
  const ticksOfMinute = (log: { tickSnapshots: { tick: number; minute: number }[] }, m: number) =>
    log.tickSnapshots.filter((s) => s.minute === m).map((s) => s.tick);

  it("표본이 갭을 실제로 재현한다 — 프로브 분에 스냅샷이 여러 개다(신선도 가드)", () => {
    const ticks = ticksOfMinute(DENSE_LOG, 20);
    expect(ticks.length, "분당 1개면 첫/마지막이 같아 앵커 규칙을 못 잰다").toBeGreaterThan(1);
    expect(Math.min(...ticks)).not.toBe(Math.max(...ticks));
    // ⚠️ 기존 표본이 이 축에 **공허한 이유**를 같이 박제한다 — 20' 에 스냅샷이 딱 하나다.
    expect(ticksOfMinute(H1_LOG, 20)).toHaveLength(1);
  });

  it("틱/표기분을 **첫 앵커 간격**에서 되유도한다 (마지막-틱 앵커면 간격이 찌그러진다)", () => {
    // 첫 앵커: 600·630·660·690 → 30. 마지막-틱 앵커: 629·659·689·690 → 20.33(사망).
    expect(displayTicksPerMinute(DENSE_LOG)).toBe(30);
  });

  it("분 중간 틱의 초는 그 분의 **시작**에서 흐른 값이다", () => {
    expect(displayMinuteAt(DENSE_LOG, 610)).toBe(20);
    expect(displaySecondAt(DENSE_LOG, 600, 20)).toBe(0);
    expect(displaySecondAt(DENSE_LOG, 610, 20)).toBe(20);
    expect(displaySecondAt(DENSE_LOG, 629, 20)).toBe(58);
    // 분 경계 — 다음 틱은 새 분의 00.
    expect(displayMinuteAt(DENSE_LOG, 630)).toBe(21);
    expect(displaySecondAt(DENSE_LOG, 630, 21)).toBe(0);
    // 라벨까지 관통(화면이 실제로 그리는 문자열).
    expect(clockLabel("FIRST_HALF", headerClock("FIRST_HALF", DENSE_LOG, 610))).toBe("20'20\"");
  });

  it("한 분 내내 초가 **단조 증가**한다 — 앵커가 뒤로 밀리면 앞구간이 통째로 00\" 로 눌린다", () => {
    const secs = Array.from({ length: 30 }, (_, i) => displaySecondAt(DENSE_LOG, 600 + i, 20));
    // 1틱 = 표기 2초(보간 없음, hero 확정) → 00,02,…,58.
    expect(secs).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
  });
});

describe("경기 분 표기 — 상시 표시 (#233 스코프 추가 · #406 초)", () => {
  it("라이브/다시보기는 재생 위치의 **표기 분 + 초**를 그린다", () => {
    // ⚠️ 인자가 틱이 아니라 **시각 객체**다(#388/#406) — 스케일 계산은 화면이 아니라 로그가 한다.
    expect(clockLabel("FIRST_HALF", { minute: 0, second: 0 })).toBe("0'00\"");
    expect(clockLabel("FIRST_HALF", { minute: 43, second: 8 })).toBe("43'08\"");
    expect(clockLabel("SECOND_HALF", { minute: 48, second: 32 })).toBe("48'32\"");
    expect(clockLabel("FINISHED", { minute: 89, second: 58 })).toBe("89'58\"");
  });

  it("초를 모르면 분만 그린다 — `00\"` 을 지어내지 않는다", () => {
    expect(clockLabel("FIRST_HALF", { minute: 43, second: null })).toBe("43'");
  });

  it("플레이헤드가 아직 없으면 슬롯을 지운다 — 값만 비운다", () => {
    // 요소가 사라졌다 나타나면 헤더가 흔들린다. "경기 시간이 안 보인다"의 절반이 이거였다.
    expect(clockLabel("SECOND_HALF", null)).toBe(CLOCK_PLACEHOLDER);
    expect(clockLabel("FIRST_HALF", null)).toBe(CLOCK_PLACEHOLDER);
  });

  /**
   * 감독시간 시계는 **흐르는 시각이 아니라 끝난 지점**이다(#226) — 그 값의 권위는 종료 휘슬이고
   * 휘슬 분에는 앵커가 없다(전반 마지막 스냅샷은 44'). 초를 붙이면 없는 앵커에서 지어내는 것이다.
   */
  it("감독시간은 하프 끝 분을 **초 없이** 그리고, 모르면 접는다(#226 유지)", () => {
    expect(clockLabel("HALFTIME", headerClock("HALFTIME", H1_LOG, 0))).toBe("45'");
    expect(clockLabel("H1_BREAK", headerClock("H1_BREAK", H1_LOG, 600))).toBe("45'");
    expect(headerClock("HALFTIME", H1_LOG, 600)?.second).toBeNull();
    expect(clockLabel("HALFTIME", null)).toBeNull();
  });
});

describe("이미 끝난 하프의 확정 스코어 = 베이스라인 (#233)", () => {
  const h1 = { scoreH1Home: 1, scoreH1Away: 4, scoreHome: null, scoreAway: null };

  it("후반을 재생하는 상태는 전반 확정 스코어가 베이스라인", () => {
    // halfForState 가 2 를 주는 상태 전부 — 후반 로그의 골은 전반 위에 쌓인다.
    expect(playedBaseline("SECOND_HALF", h1)).toEqual({ home: 1, away: 4 });
    expect(playedBaseline("FINISHED", h1)).toEqual({ home: 1, away: 4 });
  });

  it("전반을 재생하는 상태는 베이스라인이 0 — 앞에 끝난 하프가 없다", () => {
    expect(playedBaseline("FIRST_HALF", { scoreH1Home: null, scoreH1Away: null })).toEqual({ home: 0, away: 0 });
    expect(playedBaseline("HALFTIME", h1)).toEqual({ home: 0, away: 0 });
  });

  it("후반인데 전반 확정값이 없으면 null — 0 으로 단정하지 않는다", () => {
    // 0 으로 때우면 배포본이 지금 보이는 그 틀린 값(후반만의 점수)이 그대로 나온다.
    expect(playedBaseline("SECOND_HALF", { scoreH1Home: null, scoreH1Away: null })).toBeNull();
    expect(playedBaseline("SECOND_HALF", { scoreH1Home: 1, scoreH1Away: null })).toBeNull();
  });
});

describe("헤더 스코어 — 확정(서버) + 진행 중 하프 델타(재생) (#233)", () => {
  it("후반 진행 중 = 전반 확정 + 후반 재생 델타", () => {
    const scores = { scoreH1Home: 1, scoreH1Away: 4 };
    // 후반 킥오프(아직 0골) 에도 전반 스코어가 살아 있어야 한다 — 배포본은 여기서 0:0 이었다.
    expect(headerScore("SECOND_HALF", scores, { home: 0, away: 0 })).toEqual({ home: 1, away: 4 });
    // 후반 2골(away) 뒤.
    expect(headerScore("SECOND_HALF", scores, { home: 0, away: 2 })).toEqual({ home: 1, away: 6 });
  });

  it("후반 재생 델타가 아직 없으면(로그 미도착) 전반 확정값만 보인다", () => {
    expect(headerScore("SECOND_HALF", { scoreH1Home: 1, scoreH1Away: 4 }, null)).toEqual({ home: 1, away: 4 });
  });

  it("후반인데 전반 확정값이 없으면 '-' — 틀린 숫자보다 없는 편이 낫다", () => {
    expect(headerScore("SECOND_HALF", {}, { home: 0, away: 2 })).toEqual({ home: "-", away: "-" });
  });

  it("전반 진행 중은 재생 델타 그대로(무회귀)", () => {
    expect(headerScore("FIRST_HALF", {}, { home: 1, away: 0 })).toEqual({ home: 1, away: 0 });
    expect(headerScore("FIRST_HALF", {}, null)).toEqual({ home: 0, away: 0 });
  });

  it("감독시간은 전반 확정, 종료는 최종 확정 — 재생 델타를 따라가지 않는다(#226)", () => {
    const rewound = { home: 0, away: 0 };
    expect(headerScore("HALFTIME", { scoreH1Home: 0, scoreH1Away: 4 }, rewound)).toEqual({ home: 0, away: 4 });
    expect(headerScore("H1_BREAK", { scoreH1Home: 2, scoreH1Away: 1 }, rewound)).toEqual({ home: 2, away: 1 });
    expect(headerScore("FINISHED", { scoreHome: 3, scoreAway: 2 }, rewound)).toEqual({ home: 3, away: 2 });
  });

  /**
   * 이 픽스의 **설계 근거 자체**를 박제한다(독립검증 minor-2). 검증자가 `state==="FINISHED"` 앞에
   * "`scoreHome` 이 있으면 무조건 그린다"를 끼웠는데 전 게이트가 green 이었다 — 진행 중 상태에
   * `scoreHome` 을 먹이는 테스트가 하나도 없었기 때문이다. 서버가 언젠가 `score_*` 를 조기에 채우면
   * (운영·마이그레이션) 화면이 즉시 결과를 뱉는데 아무도 못 잡는다.
   */
  it("후반 진행 중에는 최종 스코어가 와 있어도 무시한다 — 재생 위치보다 앞선 점수 금지", () => {
    const leaked = { scoreH1Home: 1, scoreH1Away: 4, scoreHome: 2, scoreAway: 8 };
    expect(headerScore("SECOND_HALF", leaked, { home: 0, away: 2 })).toEqual({ home: 1, away: 6 });
    expect(headerScore("FIRST_HALF", leaked, { home: 0, away: 1 })).toEqual({ home: 0, away: 1 });
    // 감독시간도 마찬가지 — 그 화면이 말할 것은 전반 결과지 경기 결과가 아니다.
    expect(headerScore("HALFTIME", leaked, { home: 0, away: 0 })).toEqual({ home: 1, away: 4 });
  });

  it("확정 상태인데 서버 값이 비어 있으면 '-'", () => {
    expect(headerScore("HALFTIME", {}, { home: 3, away: 3 })).toEqual({ home: "-", away: "-" });
    expect(headerScore("FINISHED", {}, { home: 3, away: 3 })).toEqual({ home: "-", away: "-" });
  });
});

describe("탭 구성 (#284 — 토글 제거, 상태가 정한다)", () => {
  it("정보 탭은 **항상** 있다 — 시트가 비는 상태가 없다", () => {
    // #284 의 요구가 이것이다("애초부터 열려 있게"). 예전엔 토글이 전부 off 면 빈 배열이었다.
    for (const state of ["FIRST_HALF", "SECOND_HALF", "HALFTIME", "FINISHED", "GEN2", undefined]) {
      expect(tabsFor(state, statePanelFor(state)).length, `${state} 에도 탭이 있어야 한다`)
        .toBeGreaterThan(0);
    }
  });

  it("상태별 탭 구성 — hero 확정(#284)", () => {
    expect(tabsFor("FIRST_HALF", null)).toEqual(["stats", "players", "log", "brief"]);
    // #244: 감독시간에는 무대가 상시가 아니라 **탭**이다 → 감독 패널 바로 뒤에 `stage` 가 온다.
    expect(tabsFor("HALFTIME", "halftime")).toEqual(["halftime", "stage", "stats", "players", "log"]);
    expect(tabsFor("H1_BREAK", "halftime"), "레거시 상태명도 같은 구성").toEqual([
      "halftime", "stage", "stats", "players", "log",
    ]);
    expect(tabsFor("SECOND_HALF", null)).toEqual(["stats", "players", "log"]);
    expect(tabsFor("FINISHED", "result"), "관전·결과에는 경기장면 탭이 없다").toEqual([
      "result", "stats", "players", "log",
    ]);
  });

  it("후반 지시 탭은 **전반에만** — 낼 수 없거나 감독 탭과 겹치는 상태에서는 안 뜬다", () => {
    expect(briefTabVisible("FIRST_HALF")).toBe(true);
    // 감독시간엔 감독 탭이 같은 입력을 프리필된 채로 갖는다 → 칸이 두 개가 되면 안 된다.
    expect(briefTabVisible("HALFTIME")).toBe(false);
    expect(briefTabVisible("H1_BREAK")).toBe(false);
    // 후반·종료는 서버가 409 로 막는다 — 만져도 아무 데도 안 가는 손잡이를 남기지 않는다.
    expect(briefTabVisible("SECOND_HALF")).toBe(false);
    expect(briefTabVisible("FINISHED")).toBe(false);
    expect(briefTabVisible(undefined)).toBe(false);

    for (const state of ["HALFTIME", "SECOND_HALF", "FINISHED"]) {
      expect(tabsFor(state, statePanelFor(state))).not.toContain("brief");
    }
  });

  it("시트 높이 등급은 탭 종류로만 갈린다(콘텐츠 무관 — 내용이 쌓여도 무대가 안 줄어든다)", () => {
    expect(sheetHeight(null)).toBeNull();
    expect(sheetHeight("stats")).toBe("info");
    expect(sheetHeight("log")).toBe("info");
    expect(sheetHeight("halftime")).toBe("state");
    expect(sheetHeight("stage")).toBe("state");
  });

  /**
   * #355 — **`result` 는 `state` 가 아니다.** 같은 등급이던 동안 상한 40svh(420px)가 결과 패널
   * 내용(449~481px)보다 작아 **[로비로] CTA 가 모든 데스크탑 비율에서 화면 밖**이었다
   * (3440×1440 에서도 bottom 1576 > 1440 — "화면이 크면 괜찮다"의 예외).
   *
   * ⚠️ 다만 **이 등급이 CTA 를 지키는 게 아니다.** 결과 패널 내용에는 상한이 없다
   * (`GrowthReportSection` 이 기용 선수 수만큼 행을 붙인다) → CTA 는 `ResultPanel` 의 **스크롤 밖
   * 고정층**이 지킨다. 두 층이 각각 계약을 갖는다(픽셀 = `p348-desktop-viewport.spec.ts` ⑥ —
   * 성장 리포트 유 + **스크롤 불변** 단언이 "높이만 키운 구현"을 죽인다).
   */
  it("결과는 **result** 등급 — 감독·경기장면과 같은 높이를 쓰면 [로비로] 가 화면 밖으로 나간다(#355)", () => {
    expect(sheetHeight("result")).toBe("result");
    expect(sheetHeight("result")).not.toBe(sheetHeight("halftime"));
    expect(sheetHeight("result")).not.toBe(sheetHeight("stage"));
  });

  /**
   * #348 — **`brief` 는 `info` 가 아니다.** 같은 등급이던 동안 데스크탑에서 26svh 를 받아
   * 프롬프트 입력 상자가 통째로 뷰포트 밖으로 밀렸다(1280×800 실측 bottom 876 > 800):
   * hero 에게는 "적을 칸이 없는 화면"이었다. **보는 패널과 쓰는 패널은 필요한 세로가 다르다.**
   * 여기서 되돌리면 픽셀 계약(`e2e/p348-desktop-viewport.spec.ts` ①)이 같이 깨진다 — 두 층이다.
   */
  it("후반 지시는 **입력** 등급 — 통계·로그와 같은 높이를 쓰면 입력칸이 화면 밖으로 나간다(#348)", () => {
    expect(sheetHeight("brief")).toBe("input");
    expect(sheetHeight("brief")).not.toBe(sheetHeight("log"));
  });

  /**
   * #403 W2 — **`players` 는 네 등급 어디에도 안 붙는다.**
   *
   * `info`(26svh → 1280×800 시트 208px)면 세그먼트+캡션+정렬 칩+표 머리만으로 크롬이 차서
   * 데이터가 한 줄도 안 남는다(= 목록인데 목록으로 안 보인다, #355 가 결과 카드에서 겪은 모양).
   * `state`·`result` 는 각각 **감독시간 조작 폼**·**종료 후 읽기**의 예산이라 움직여야 할 이유가
   * 다르다 — 붙여 두면 한쪽을 고칠 때 다른 쪽이 근거 없이 따라간다.
   *
   * ⚠️ 여기서 `"info"` 로 되돌리면 픽셀 계약(`e2e/p403-player-tab.spec.ts` ③ 데스크탑 스윕 —
   * 정렬 칩 + 표 머리 + 최소 4행)이 같이 깨진다. 두 층이다.
   */
  it("선수 기록은 **list** 등급 — info/state/result 어느 것도 아니다(#403)", () => {
    expect(sheetHeight("players")).toBe("list");
    for (const other of ["stats", "log", "brief", "halftime", "stage", "result"] as TabKey[]) {
      expect(sheetHeight("players"), `players 가 ${other} 와 같은 등급이면 안 된다`).not.toBe(
        sheetHeight(other),
      );
    }
  });

  it("활성 탭: 고른 탭이 살아 있으면 유지", () => {
    const tabs: TabKey[] = ["halftime", "stage", "stats", "players", "log"];
    expect(resolveActiveTab(tabs, "log")).toBe("log");
    expect(resolveActiveTab(tabs, "stage")).toBe("stage");
    expect(resolveActiveTab([], "stats")).toBeNull();
  });

  it("기본 탭: 상태 패널이 있으면 그것, 없으면 **로그**(첫 탭인 통계가 아니다)", () => {
    // 표시 순서(통계 먼저)와 기본 선택(로그)은 다른 축이다 — 여기가 그 계약이다.
    expect(resolveActiveTab(tabsFor("FIRST_HALF", null), null)).toBe("log");
    expect(resolveActiveTab(tabsFor("SECOND_HALF", null), null)).toBe("log");
    // 지금 해야 할 일이 정보 탭을 이긴다.
    expect(resolveActiveTab(tabsFor("HALFTIME", "halftime"), null)).toBe("halftime");
    expect(resolveActiveTab(tabsFor("FINISHED", "result"), null)).toBe("result");
    // 사라진 탭을 고르고 있었으면 같은 기본 규칙으로 떨어진다.
    expect(resolveActiveTab(tabsFor("SECOND_HALF", null), "brief")).toBe("log");
    expect(resolveActiveTab(tabsFor("HALFTIME", "halftime"), "brief")).toBe("halftime");
  });

  it("전반 → 감독시간으로 넘어가도 **보던 탭을 뺏지 않는다**", () => {
    // 통계를 보고 있었으면 감독시간에도 통계다(감독 탭으로 튕기지 않는다) — 탭은 여전히 있으므로.
    expect(resolveActiveTab(tabsFor("HALFTIME", "halftime"), "stats")).toBe("stats");
  });
});

describe("사이드 ↔ 팀 이름 (#322)", () => {
  const AWAY_FIXTURE = {
    homeName: "Thunder Bay United",
    awayName: "축구왕여르",
    ownerName: "축구왕여르",
    opponent: { name: "Thunder Bay United" },
  };

  it("서버가 준 **사이드 이름**이 이긴다 — 어웨이 라운드는 홈이 봇이다", () => {
    // 이게 이 이슈의 전부다. ownerName 을 홈에 박으면 스코어·로그·좌우가 통째로 뒤집힌다.
    expect(teamNamesOf(AWAY_FIXTURE, "축구왕여르")).toEqual({
      home: "Thunder Bay United",
      away: "축구왕여르",
    });
  });

  it("유저가 홈인 경기는 사이드 이름과 폴백이 **같은 답**을 낸다(무회귀)", () => {
    const homeFixture = {
      homeName: "축구왕여르",
      awayName: "Thunder Bay United",
      ownerName: "축구왕여르",
      opponent: { name: "Thunder Bay United" },
    };
    const legacy = { ownerName: "축구왕여르", opponent: { name: "Thunder Bay United" } };
    expect(teamNamesOf(homeFixture, "축구왕여르")).toEqual(teamNamesOf(legacy, "축구왕여르"));
  });

  it("구 서버(사이드 이름 없음) → ownerName/opponent 폴백", () => {
    expect(teamNamesOf({ ownerName: "별희", opponent: { name: "봇 FC" } }, "별희")).toEqual({
      home: "별희",
      away: "봇 FC",
    });
  });

  it("ownerName 도 없으면 내 닉네임, 그것도 없으면 자리 문구 — 빈 헤더를 만들지 않는다", () => {
    expect(teamNamesOf(null, "별희")).toEqual({ home: "별희", away: "상대" });
    expect(teamNamesOf(undefined, null)).toEqual({ home: "내 팀", away: "상대" });
  });

  it("내 팀 표식은 **이름 일치**로 찾는다 — 어웨이면 away", () => {
    expect(myTeamSide(teamNamesOf(AWAY_FIXTURE, "축구왕여르"), "축구왕여르")).toBe("away");
    expect(myTeamSide({ home: "축구왕여르", away: "봇 FC" }, "축구왕여르")).toBe("home");
  });

  it("내 팀이 없는 화면엔 표식을 달지 않는다 — 거짓 표식 금지", () => {
    // 관전(#245)·봇전 등. 닉네임을 모르는 순간에도 아무 데나 붙이지 않는다.
    expect(myTeamSide({ home: "A봇", away: "B봇" }, "축구왕여르")).toBeNull();
    expect(myTeamSide({ home: "축구왕여르", away: "봇 FC" }, null)).toBeNull();
    expect(myTeamSide({ home: "축구왕여르", away: "봇 FC" }, undefined)).toBeNull();
  });
});

/**
 * ── 선수 기록 집계 게이트 (#403 W2 MAJ-1 → W4) ─────────────────────────────────────────────
 *
 * 이 조건이 인라인(`activeTab === "players"`)이던 동안 **계약이 없었다**. W4 가 결과 탭을 더하며
 * "언제 켜지나"가 판단이 됐으므로 전수로 못 박는다.
 *
 * ⚠️ **전수인 것이 핵심이다.** `toBe(true)` 두 줄만 쓰면 *"항상 참"* 변이가 통과하고, 그러면
 * 관전 내내 아무도 안 보는 집계가 매 틱 돈다(실측 6초에 24회). 반대로 `result` 를 빼는 변이는
 * 아래 첫 줄에서 죽는다.
 */
describe("needsPlayerStats — 선수 기록을 켜는 탭은 정확히 둘", () => {
  it("players·result 만 참이고 나머지 전부 거짓 (탭 전수)", () => {
    // ⚠️ 리터럴 배열이다 — `TabKey` 를 import 해 순회하면 타입만 보고 값은 못 잰다.
    const ON = ["players", "result"] as const;
    const OFF = ["stats", "log", "brief", "halftime", "stage"] as const;
    for (const t of ON) expect(needsPlayerStats(t), `${t} 는 켜져야 한다`).toBe(true);
    for (const t of OFF) expect(needsPlayerStats(t), `${t} 에서 집계가 돌면 안 된다`).toBe(false);
  });

  it("탭이 없으면(시트 없음) 켜지 않는다", () => {
    expect(needsPlayerStats(null)).toBe(false);
  });

  /**
   * 위 두 목록이 **실제 탭 전체**를 덮는지 — 새 탭이 생기면 여기서 먼저 red 가 난다.
   * (안 그러면 새 탭이 조용히 검사 밖으로 빠지고, 그 탭이 집계를 켜야 하는지 아무도 안 묻는다.)
   */
  it("목록이 실제 탭 집합을 전부 덮는다", () => {
    const covered = new Set(["players", "result", "stats", "log", "brief", "halftime", "stage"]);
    const real = new Set<string>([
      ...INFO_TAB_KEYS,
      ...tabsFor("HALFTIME", "halftime"),
      ...tabsFor("FINISHED", "result"),
      ...tabsFor("FIRST_HALF", null),
    ]);
    for (const t of real) expect(covered.has(t), `탭 ${t} 가 게이트 계약에서 빠졌다`).toBe(true);
    expect(real.size).toBe(covered.size);
  });
});
