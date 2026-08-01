import { describe, expect, it } from "vitest";
import {
  briefTabVisible,
  CLOCK_PLACEHOLDER,
  clockLabel,
  DEFAULT_INFO_TAB,
  displayMinuteAt,
  halfEndMinuteOf,
  halfForState,
  headerScore,
  headerMinute,
  INFO_TAB_KEYS,
  isHalftimeState,
  myTeamSide,
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
    expect(INFO_TAB_KEYS).toEqual(["stats", "log", "brief"]);
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
    expect(headerMinute("HALFTIME", H1_LOG, 0)).toBe(45);
    expect(headerMinute("H1_BREAK", H1_LOG, 600)).toBe(45);
  });

  it("라이브 하프는 그대로 플레이헤드를 따라간다", () => {
    expect(headerMinute("FIRST_HALF", H1_LOG, 600)).toBe(20);
    expect(headerMinute("SECOND_HALF", H2_LOG, 2100)).toBe(70);
    expect(headerMinute("FINISHED", H2_LOG, 2699)).toBe(89);
  });

  it("하프 끝을 모르면(로그 미도착) 플레이헤드로 되돌아가지 않고 시계를 접는다", () => {
    // null 을 주면 ScoreBar 가 시계를 아예 안 그린다 = 틀린 분보다 없는 편이 낫다.
    expect(headerMinute("HALFTIME", null, 0)).toBeNull();
    expect(headerMinute("HALFTIME", {}, 600)).toBeNull();
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

describe("경기 분 표기 — 상시 표시 (#233 스코프 추가)", () => {
  it("라이브/다시보기는 재생 위치의 **표기 분**을 그대로 그린다", () => {
    // ⚠️ 인자가 틱이 아니라 **분**이다(#388) — 스케일 계산은 화면이 아니라 로그가 한다.
    expect(clockLabel("FIRST_HALF", 0)).toBe("0'");
    expect(clockLabel("FIRST_HALF", 43)).toBe("43'");
    expect(clockLabel("SECOND_HALF", 45)).toBe("45'");
    expect(clockLabel("FINISHED", 89)).toBe("89'");
  });

  it("플레이헤드가 아직 없으면 슬롯을 지운다 — 값만 비운다", () => {
    // 요소가 사라졌다 나타나면 헤더가 흔들린다. "경기 시간이 안 보인다"의 절반이 이거였다.
    expect(clockLabel("SECOND_HALF", null)).toBe(CLOCK_PLACEHOLDER);
    expect(clockLabel("FIRST_HALF", null)).toBe(CLOCK_PLACEHOLDER);
  });

  it("감독시간은 하프 끝 분을 그리고, 모르면 접는다(#226 유지)", () => {
    expect(clockLabel("HALFTIME", 45)).toBe("45'");
    expect(clockLabel("H1_BREAK", 45)).toBe("45'");
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
    expect(tabsFor("FIRST_HALF", null)).toEqual(["stats", "log", "brief"]);
    // #244: 감독시간에는 무대가 상시가 아니라 **탭**이다 → 감독 패널 바로 뒤에 `stage` 가 온다.
    expect(tabsFor("HALFTIME", "halftime")).toEqual(["halftime", "stage", "stats", "log"]);
    expect(tabsFor("H1_BREAK", "halftime"), "레거시 상태명도 같은 구성").toEqual([
      "halftime", "stage", "stats", "log",
    ]);
    expect(tabsFor("SECOND_HALF", null)).toEqual(["stats", "log"]);
    expect(tabsFor("FINISHED", "result"), "관전·결과에는 경기장면 탭이 없다").toEqual([
      "result", "stats", "log",
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

  it("활성 탭: 고른 탭이 살아 있으면 유지", () => {
    const tabs: TabKey[] = ["halftime", "stage", "stats", "log"];
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
