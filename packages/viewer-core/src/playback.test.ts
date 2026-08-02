import { describe, it, expect } from "vitest";
import {
  eventKind,
  buildRestartTicks,
  spansReposition,
  buildStoppages,
  buildAnnotations,
  isContinuousOut,
  buildBallCutTicks,
  inHighlight,
  buildFlightSides,
  effectiveSpeed,
  autoPaceDurationMs,
  clockScaleOf,
  PACE,
} from "./playback.mjs";

describe("spansReposition — 슛 궤적은 컷 금지, 데드볼 재배치만 컷 (하이라이트 순간이동 버그 회귀방지)", () => {
  it("빠른 슛 궤적(재배치 이벤트 없음)은 거리가 커도 컷하지 않는다", () => {
    // 슛: t100 슈터 → t102 골대(28m 이동). shot 은 재배치 이벤트가 아니다.
    const restarts = buildRestartTicks([{ type: "shot", tick: 100 }]);
    expect(spansReposition(100, 102, restarts)).toBe(false);
  });
  it("구간 안에 코너 재배치가 있으면 컷한다", () => {
    const restarts = buildRestartTicks([{ type: "kickoff", detail: "corner", tick: 110 }]);
    expect(spansReposition(108, 110, restarts)).toBe(true);
    expect(spansReposition(110, 112, restarts)).toBe(false); // 재배치 이후 구간은 정상 보간
  });
  it("골 인바운드 비행은 컷하지 않는다(발사→네트가 부드럽게 보간). 골 후 리셋은 킥오프가 컷", () => {
    // goal 단독은 재배치 집합에 없음 → 발사→네트 구간 보간 유지(순간이동 방지, V3 #16).
    const goalOnly = buildRestartTicks([{ type: "goal", tick: 50 }]);
    expect(spansReposition(49, 50, goalOnly)).toBe(false);
    // 골 후 네트→센터 리셋은 뒤따르는 kickoff 이벤트가 컷한다.
    const withKickoff = buildRestartTicks([{ type: "goal", tick: 50 }, { type: "kickoff", tick: 75 }]);
    expect(spansReposition(74, 75, withKickoff)).toBe(true);
  });
});

describe("#51 isContinuousOut / buildBallCutTicks — 연속 아웃은 공 라이브(컷 제외)", () => {
  const S = (arr: [number, number, number][]) => arr.map(([tick, x, y]) => ({ tick, ball: { x, y } }));
  it("스로인(직전 움직이는 공 + 스팟 근거리)은 continuous=true", () => {
    const snaps = S([[0, 20, 40], [1, 26, 52], [2, 30, 68]]); // 필드 안 이동 → 사이드라인
    expect(isContinuousOut(snaps, 2)).toBe(true);
  });
  it("코너(직전 정지 파킹공)는 continuous=false → 컷 유지", () => {
    const snaps = S([[0, 102.5, 34], [1, 102.5, 34], [2, 105, 0]]); // 파킹 → 깃발 순간이동
    expect(isContinuousOut(snaps, 2)).toBe(false);
  });
  it("직전이 움직여도 스팟이 멀면(>25m) continuous=false", () => {
    const snaps = S([[0, 10, 10], [1, 12, 12], [2, 60, 68]]);
    expect(isContinuousOut(snaps, 2)).toBe(false);
  });
  it("buildBallCutTicks: 연속 스로인은 제외, 코너는 포함", () => {
    const snaps = S([[0, 20, 40], [1, 26, 52], [2, 30, 68], [3, 102.5, 34], [4, 102.5, 34], [5, 105, 0]]);
    const events = [
      { type: "kickoff", detail: "throw_in", tick: 2 }, // 연속 → 공 라이브(컷 제외)
      { type: "kickoff", detail: "corner", tick: 5 }, // 순간이동 → 컷
    ];
    const cut = buildBallCutTicks(events, snaps);
    expect(cut.has(2)).toBe(false); // 연속 스로인 공 라이브
    expect(cut.has(5)).toBe(true); // 코너 컷
  });
});

describe("#83 inHighlight — 비대칭 하이라이트 창(세이브 후 늦은 릴리스 방지)", () => {
  const keys = [100];
  it("keyTick 후엔 POST 만큼만(짧게 풀림), 앞엔 PRE 만큼(빌드업)", () => {
    // 뒤(post=3): kt+3 까지만 하이라이트, kt+4 부터 풀림 — 구 대칭(±8)이면 kt+8 까지라 늦음.
    expect(inHighlight(103, keys, 8, 3)).toBe(true);
    expect(inHighlight(104, keys, 8, 3)).toBe(false);
    expect(inHighlight(108, keys, 8, 3)).toBe(false); // 대칭이면 true(늦은 릴리스 버그)
    // 앞(pre=8): 빌드업 유지.
    expect(inHighlight(92, keys, 8, 3)).toBe(true);
    expect(inHighlight(91, keys, 8, 3)).toBe(false);
    // keyTick 자체.
    expect(inHighlight(100, keys, 8, 3)).toBe(true);
  });
  it("post < pre (비대칭) + keyTick 없으면 false", () => {
    expect(inHighlight(50, [], 8, 3)).toBe(false);
    // 다중 keyTick: 어느 하나의 창에 들면 true.
    expect(inHighlight(203, [100, 200], 8, 3)).toBe(true);
  });
});

describe("#216 effectiveSpeed — speed 는 연출 페이싱 위의 배율(끔 경로 없이 속도 조절)", () => {
  const CRUISE = 4, HL = 1;
  it("speed=1 이면 연출 자연 페이스 그대로다(기존 소비자 무회귀)", () => {
    expect(effectiveSpeed(true, false, 1, CRUISE, HL)).toBe(CRUISE);
    expect(effectiveSpeed(true, true, 1, CRUISE, HL)).toBe(HL);
  });
  it("배율이 크루즈·키장면에 **같은 비율**로 걸린다 = 슬로우모션 대비 유지", () => {
    const cruise = effectiveSpeed(true, false, 1.5, CRUISE, HL);
    const key = effectiveSpeed(true, true, 1.5, CRUISE, HL);
    expect(cruise).toBeCloseTo(6);
    expect(key).toBeCloseTo(1.5);
    // 대비(크루즈/키장면)는 배율과 무관하게 4:1 로 보존된다 — 이게 "연출을 죽이지 않는다"의 뜻.
    expect(cruise / key).toBeCloseTo(CRUISE / HL);
  });
  it("연출 페이싱이 꺼진 프레임(fix 뷰 등)에서는 speed 가 곧 속도다", () => {
    expect(effectiveSpeed(false, true, 2, CRUISE, HL)).toBe(2);
    expect(effectiveSpeed(false, false, 0.25, CRUISE, HL)).toBe(0.25);
  });
});

describe("eventKind", () => {
  it("kickoff+detail, shot+detail 를 펼친다", () => {
    expect(eventKind({ type: "kickoff", detail: "corner" })).toBe("corner");
    expect(eventKind({ type: "shot", detail: "saved" })).toBe("shot_saved");
    expect(eventKind({ type: "save" })).toBe("save");
  });
});

describe("buildRestartTicks", () => {
  it("데드볼 재배치 이벤트만 포함(shot/pass/goal 제외 — goal 인바운드는 보간 유지)", () => {
    const r = buildRestartTicks([
      { type: "kickoff", detail: "corner", tick: 1 },
      { type: "goal", tick: 2 }, // 골 인바운드 비행은 컷 안 함 → 제외
      { type: "free_kick", tick: 3 },
      { type: "shot", tick: 4 },
      { type: "pass", tick: 5 },
      { type: "kickoff", tick: 6 }, // 골 후 킥오프 리셋은 컷
    ]);
    expect([...r].sort((a, b) => a - b)).toEqual([1, 3, 6]);
  });
});

describe("buildStoppages — 원인→재시작 skip 대상", () => {
  it("선방 + 코너 → '선방!' 자막 + 코너로 skip", () => {
    const ev = [
      { type: "shot", tick: 95, detail: "saved" },
      { type: "save", tick: 96 },
      { type: "kickoff", detail: "corner", tick: 100 },
    ];
    const save = buildStoppages(ev).find((s) => s.causeTick === 96)!;
    expect(save).toBeTruthy();
    expect(save.big).toContain("SAVE");
    expect(save.restartTick).toBe(100);
  });
  it("빗나감 + 골킥 → '빗나감!' + 골킥으로 skip", () => {
    const ev = [
      { type: "shot", tick: 160, detail: "off_target" },
      { type: "kickoff", detail: "goal_kick", tick: 164 },
    ];
    const st = buildStoppages(ev);
    expect(st[0]!.big).toContain("OFF TARGET");
    expect(st[0]!.restartTick).toBe(164);
  });
  it("일반 패스/슛은 정지 시퀀스를 만들지 않는다", () => {
    expect(buildStoppages([{ type: "pass", tick: 1 }, { type: "shot", tick: 2 }])).toHaveLength(0);
  });
  it("골은 isGoal:true(GOAL 자막+색종이), 선방은 isGoal:false(상황카드) — '선방인데 골처럼' 방지", () => {
    const st = buildStoppages([
      { type: "goal", tick: 50, team: "home" },
      { type: "kickoff", tick: 60 },
      { type: "save", tick: 100 },
      { type: "kickoff", detail: "corner", tick: 104 },
    ]);
    const goal = st.find((s) => s.causeTick === 50)!;
    const save = st.find((s) => s.causeTick === 100)!;
    expect(goal.isGoal).toBe(true);
    expect(goal.big).toContain("GOAL");
    expect(goal.restartTick).toBe(60); // 킥오프로 skip
    expect(save.isGoal).toBeFalsy();
    expect(save.big).toContain("SAVE");
    expect(save.big).not.toContain("GOAL");
  });
  // #29: hero 요구 — 코너/스로인도 "코너킥!/스로인!" 큰 자막 + 정지 → 제자리 재개(관전 인지).
  it("코너·스로인은 큰 상황자막 정지(제자리 재개) — 관객이 세트피스를 인지", () => {
    const st = buildStoppages([
      { type: "kickoff", detail: "corner", tick: 200 },
      { type: "kickoff", detail: "throw_in", tick: 500 },
    ]);
    const corner = st.find((x) => x.causeTick === 200)!;
    expect(corner, "코너 정지 있어야").toBeTruthy();
    expect(corner.big).toContain("CORNER"); // 큰 상황자막(무음 pauseOnly 아님)
    expect(corner.pauseOnly).toBeFalsy();
    expect(corner.setPiece).toBe(true); // freeze 중 taker 로 줌 표시
    expect(corner.restartTick).toBe(200); // 제자리 재개(프레임 스킵 없음)
    expect(corner.isGoal).toBeFalsy();
    expect(corner.hold).toBeGreaterThan(0);

    const thr = st.find((x) => x.causeTick === 500)!;
    expect(thr, "스로인 정지 있어야").toBeTruthy();
    expect(thr.big).toContain("THROW");
    expect(thr.pauseOnly).toBeFalsy();
    expect(thr.setPiece).toBe(true);
    expect(thr.restartTick).toBe(500);
    expect(thr.hold).toBeGreaterThan(0);
  });
  // #230(hero 지시): 골킥도 데드볼이므로 코너/스로인과 같은 대접을 받는다. 이전에는 "빈도 높음"을
  // 이유로 정지 자체를 두지 않아, 관객 입장에서 골킥은 아무 신호 없이 지나가는 유일한 세트피스였다
  // (그래서 골킥 중 골키퍼가 걸어 나가는 #230 버그가 "무슨 상황인지 모를 장면"으로 보였다).
  // 빈도 부담은 정지를 없애는 대신 **hold 를 스로인급으로 짧게** 잡아 흡수한다.
  it("프리킥은 pauseOnly 정지 비트 유지, 골킥은 코너/스로인과 같은 상황자막 정지 (#230)", () => {
    const st = buildStoppages([
      { type: "free_kick", detail: "foul", tick: 300 },
      { type: "kickoff", detail: "goal_kick", tick: 400 },
    ]);
    const fk = st.find((x) => x.causeTick === 300)!;
    expect(fk.pauseOnly).toBe(true);
    expect(fk.big).toBe("");
    expect(fk.restartTick).toBe(300);

    const gk = st.find((x) => x.causeTick === 400)!;
    expect(gk, "골킥 정지 있어야").toBeTruthy();
    expect(gk.big).toContain("GOAL KICK");
    expect(gk.pauseOnly).toBeFalsy();
    expect(gk.setPiece).toBe(true); // freeze 중 taker(=골키퍼)로 줌
    expect(gk.restartTick).toBe(400); // 제자리 재개(프레임 스킵 없음)
    expect(gk.isGoal).toBeFalsy();
    // 빈도가 높으므로 코너(900ms)보다 길지 않게 — 스로인급 이하.
    expect(gk.hold).toBeGreaterThan(0);
    expect(gk.hold).toBeLessThanOrEqual(650);
  });
  // #42: CAUSE 정지 skip 은 "원인→재시작 사이 = 데드타임"일 때만. 세이브 후 공이 라이브인
  // 체인(패스→2차슛→빗나감→골킥)을 스킵하면 라이브 플레이가 사라지고(2차 슛 미표시),
  // 중간 상황자막이 드롭되며, 착지 프레임에 토스트/궤적선/선수 잔상이 유령처럼 몰아 나타난다.
  it("파울/페널티 정지는 접촉 앵커(파울러)를 갖는다 — 카메라 접촉 줌용(충돌 가시화)", () => {
    const foul = buildStoppages([{ type: "foul", tick: 30, team: "away", playerId: "A2" }]);
    expect(foul.find((s) => s.causeTick === 30)?.contactAnchor, "파울 정지 contactAnchor=파울러").toBe("A2");
    // 페널티: 같은 틱 파울 이벤트의 playerId 를 접촉 앵커로(페널티 이벤트엔 pid 없음).
    const pen = buildStoppages([
      { type: "foul", tick: 40, team: "away", playerId: "A5" },
      { type: "penalty", tick: 40, team: "home" },
    ]);
    // 병합 후 살아남는 40틱 정지(페널티가 이김)가 접촉앵커=파울러 A5.
    expect(pen.find((s) => s.causeTick === 40)?.contactAnchor, "페널티 정지 contactAnchor=같은 틱 파울러").toBe("A5");
  });

  describe("#42 — 라이브 플레이 개입 시 skip 금지", () => {
    const chain = [
      { type: "save", tick: 96 },
      { type: "pass", tick: 97 },
      { type: "interception", tick: 98 },
      { type: "shot", tick: 100 },
      { type: "shot", detail: "off_target", tick: 101 },
      { type: "kickoff", detail: "goal_kick", tick: 104 },
    ];
    it("세이브→라이브 체인→골킥: 세이브 정지는 제자리 재개(라이브 10틱 스킵 금지)", () => {
      const save = buildStoppages(chain).find((s) => s.causeTick === 96)!;
      expect(save.restartTick).toBe(96); // 스킵하면 pass~off_target 이 통째로 사라진다
      expect(save.wide).toBeFalsy(); // 라이브 계속 → 카메라 미리 와이드 금지
    });
    it("체인 안의 빗나감 정지는 정상 유지(빗나감→골킥은 진짜 데드타임 → 스킵)", () => {
      const off = buildStoppages(chain).find((s) => s.causeTick === 101)!;
      expect(off.big).toContain("OFF TARGET");
      expect(off.restartTick).toBe(104);
    });
    it("card 는 북키핑 이벤트라 스킵을 막지 않는다(파울→카드→프리킥은 기존대로 스킵)", () => {
      const st = buildStoppages([
        { type: "foul", tick: 300 },
        { type: "card", detail: "yellow", tick: 301 },
        { type: "free_kick", detail: "foul", tick: 303 },
      ]);
      expect(st.find((s) => s.causeTick === 300)!.restartTick).toBe(303);
    });
    it("라이브 체인 후 코너로 이어져도 wide 미리보기 금지(스킵이 없으므로)", () => {
      const st = buildStoppages([
        { type: "save", tick: 96 },
        { type: "pass", tick: 97 },
        { type: "kickoff", detail: "corner", tick: 103 },
      ]);
      const save = st.find((s) => s.causeTick === 96)!;
      expect(save.restartTick).toBe(96);
      expect(save.wide).toBeFalsy();
    });
  });

  // #43: 페이싱 — 정확성(#42)을 지키면서 데드타임은 최대한 스킵.
  describe("#43 — 페이싱: 이중 정지 병합 + 라이브 직전까지 데드타임 스킵", () => {
    it("같은 틱 파울+페널티 → 정지는 페널티 하나만(홀드 스태킹 제거)", () => {
      const st = buildStoppages([
        { type: "foul", tick: 163, team: "away" },
        { type: "card", detail: "yellow", tick: 163 },
        { type: "penalty", tick: 163, team: "home" },
        { type: "shot", detail: "penalty", tick: 171 },
        { type: "kickoff", tick: 197 },
      ]);
      const at163 = st.filter((s) => s.causeTick === 163);
      expect(at163).toHaveLength(1);
      expect(at163[0]!.big).toContain("PENALTY"); // 더 구체적인(나중) 이벤트가 이긴다
    });
    it("같은 틱 파울+프리킥(pauseOnly) → 상황카드(파울)가 이긴다(자막 없는 비트가 카드를 지우면 안 됨)", () => {
      const st = buildStoppages([
        { type: "foul", tick: 300, team: "away" },
        { type: "free_kick", detail: "foul", tick: 300 },
      ]);
      const at300 = st.filter((s) => s.causeTick === 300);
      expect(at300).toHaveLength(1);
      expect(at300[0]!.big).toContain("FOUL");
    });
    it("정지→라이브 이벤트가 멀면 라이브 2틱 전까지 스킵(PK 준비 데드타임 회수)", () => {
      const st = buildStoppages([
        { type: "penalty", tick: 163, team: "home" },
        { type: "shot", detail: "penalty", tick: 171 },
        { type: "kickoff", tick: 197 },
      ]);
      const pk = st.find((s) => s.causeTick === 163)!;
      expect(pk.restartTick).toBe(169); // 171(첫 라이브) - 2 — 킥 준비는 건너뛰고 런업부터 보여준다
    });
    it("라이브가 바로 다음 틱이면 스킵 없음(제자리 재개, #42 유지)", () => {
      const st = buildStoppages([
        { type: "save", tick: 96 },
        { type: "pass", tick: 97 },
        { type: "kickoff", detail: "goal_kick", tick: 104 },
      ]);
      expect(st.find((s) => s.causeTick === 96)!.restartTick).toBe(96);
    });
  });

  // #43: 스로인 아웃 비행 합성 — 엔진 데이터에 없는 "공이 라인을 넘는" 마지막 레그를
  // 마지막 속도 외삽으로 만들어 freeze 도입부에 보여준다(공이 나가는 걸 끝까지 보고 정지).

  it("골 정지의 재시작은 킥오프 이벤트로 skip(코너 등 다른 재시작보다 킥오프 우선)", () => {
    const st = buildStoppages([
      { type: "goal", tick: 100, team: "home" },
      { type: "kickoff", detail: "corner", tick: 110 }, // 방해용(코너) — 골 후엔 이걸 고르면 안 됨
      { type: "kickoff", tick: 126 }, // 실제 골 후 킥오프
    ]);
    expect(st.find((s) => s.causeTick === 100)!.restartTick).toBe(126);
  });
});

describe("buildAnnotations", () => {
  const snaps: any[] = [];
  it("슛/선방/오프사이드에 토스트·배너를 만든다", () => {
    const a = buildAnnotations(
      [
        { type: "shot", tick: 10 },
        { type: "save", tick: 12 },
        { type: "offside", tick: 20 },
        { type: "kickoff", detail: "corner", tick: 24 },
      ],
      snaps,
    );
    expect(a.find((x) => x.text === "SHOT!" && x.kind === "toast")).toBeTruthy();
    expect(a.find((x) => x.text.includes("SAVE"))).toBeTruthy();
    expect(a.find((x) => x.text.includes("OFFSIDE") && x.kind === "banner")).toBeTruthy();
    expect(a.find((x) => x.text === "CORNER" && x.kind === "banner")).toBeTruthy();
  });
  it("#69 파울/카드 토스트는 선수(파울러)에 앵커된다 — 공 아님(페널티 스팟 불일치 방지)", () => {
    const a = buildAnnotations(
      [
        { type: "foul", tick: 30, team: "away", playerId: "A2" },
        { type: "card", detail: "yellow", tick: 30, team: "away", playerId: "A2" },
        { type: "penalty", tick: 30, team: "home" },
      ],
      snaps,
    );
    const foul = a.find((x) => x.text === "FOUL" && x.kind === "toast");
    const card = a.find((x) => x.text.includes("YELLOW") && x.kind === "toast");
    // 카드/파울은 '선수 사건' → anchor=파울러 playerId. 렌더가 공 아니라 그 선수 위치에 그린다.
    expect(foul?.anchor, "파울 토스트 anchor=파울러").toBe("A2");
    expect(card?.anchor, "카드 토스트 anchor=파울러").toBe("A2");
  });
  /**
   * #406 W5 (요구 4-2). 걷어내기는 **토스트가 아예 없었고**, 태클·가로챔은 무채색이라 "어느 팀
   * 행동인지"를 말하지 못했다. 셋 다 행동 주체 앵커 + `team` 표식으로 통일한다.
   *
   * ⚠️ **색은 여기서 정하지 않는다** — 팔레트 SoT 는 `viewer.impl.mjs.teamRgb` 하나다. 이 층이
   * 색을 실으면 두 곳이 되어 조용히 갈라진다. 그래서 단언도 `team` 필드에 건다.
   */
  it("#406 걷어내기·태클·가로챔 토스트 = 행동 주체 앵커 + team 표식(색은 렌더가 정한다)", () => {
    const a = buildAnnotations(
      [
        { type: "clearance", tick: 40, team: "home", playerId: "P004" },
        { type: "tackle", tick: 50, team: "away", playerId: "P077" },
        { type: "interception", tick: 60, team: "home", playerId: "P009" },
      ],
      snaps,
    );
    const pick = (text: string) => a.find((x) => x.text === text && x.kind === "toast");
    const cleared = pick("CLEARED!"), tackle = pick("TACKLE"), intc = pick("INTERCEPT");
    expect(cleared, "걷어내기 토스트가 생긴다(종전 0건)").toBeTruthy();
    for (const [t, id, side] of [[cleared, "P004", "home"], [tackle, "P077", "away"], [intc, "P009", "home"]] as const) {
      expect(t!.anchor, `${t!.text} 앵커`).toBe(id);
      expect(t!.anchorTeam, `${t!.text} 앵커 팀`).toBe(side);
      expect((t as any).team, `${t!.text} team 표식`).toBe(side);
    }
    // 팔레트가 이 층으로 새 나가지 않았다 — col 은 팀 없는 구 로그 폴백값 그대로.
    expect(cleared!.col).toBe("#cbd5e1");
  });
  it("#406 팀이 없는 구 로그에서는 team 표식 없이 종전 무채색으로 떨어진다", () => {
    const a = buildAnnotations([{ type: "tackle", tick: 40 }], snaps);
    const t = a.find((x) => x.text === "TACKLE")!;
    expect((t as any).team).toBeUndefined();
    expect(t.anchor).toBeUndefined();
    expect(t.col).toBe("#cbd5e1");
  });
  it("롱 드리블(같은 소유자 6틱+ 전진)에 '돌파!' 토스트", () => {
    const s: any[] = [];
    // #324: 전진 방향 판정이 소유팀을 **스냅샷에서** 찾으므로 players 를 싣는다(실 로그와 같은 모양).
    const P = (id: string, x: number) => [{ playerId: id, team: "home", pos: { x, y: 34 } }];
    for (let t = 0; t < 8; t++) {
      s.push({ tick: t, ballOwner: "H9", ball: { x: 40 + t * 3, y: 34 }, players: P("H9", 40 + t * 3) });
    }
    s.push({ tick: 8, ballOwner: "H6", ball: { x: 64, y: 34 }, players: P("H6", 64) }); // 소유 변경으로 run 종료
    const a = buildAnnotations([], s);
    expect(a.find((x) => x.text === "SURGE!")).toBeTruthy();
  });

  it("buildFlightSides — 슛 비행(무소유) 틱을 슛한 팀으로, 재점유 시 종료", () => {
    const snaps = [
      { tick: 10, ballOwner: "H9" },
      { tick: 11, ballOwner: null }, // 슛 발사(무소유)
      { tick: 12, ballOwner: null }, // 비행
      { tick: 13, ballOwner: null }, // 골문 안착(무소유)
      { tick: 14, ballOwner: "A1" }, // 상대 재점유 → 비행 끝
    ];
    const m = buildFlightSides([{ type: "shot", tick: 11, team: "home" }], snaps);
    expect(m.get(11)).toBe("home");
    expect(m.get(12)).toBe("home");
    expect(m.get(13)).toBe("home");
    expect(m.has(14)).toBe(false);
    expect(m.has(10)).toBe(false); // 발사 전은 실소유(H9)로 이미 처리.
  });

  it("buildFlightSides — 패스 발사팀 색, 결과마커(saved/off_target)는 발사 아님", () => {
    const snaps = [{ tick: 1, ballOwner: "A3" }, { tick: 2, ballOwner: null }, { tick: 3, ballOwner: "A5" }];
    expect(buildFlightSides([{ type: "pass", tick: 2, team: "away" }], snaps).get(2)).toBe("away");
    expect(buildFlightSides([{ type: "shot", tick: 2, detail: "saved", team: "home" }], snaps).has(2)).toBe(false);
    expect(buildFlightSides([{ type: "shot", tick: 2, detail: "off_target", team: "home" }], snaps).has(2)).toBe(false);
  });
});

describe("#216 autoPaceDurationMs — 켬 모드 재생 길이(서버 half-real-ms 의 근거)", () => {
  /** 정지·키장면 없는 로그 = 순수 크루즈. 1440틱 / (TICKS_PER_SEC × CRUISE_SPEED). */
  const plain = Array.from({ length: 1441 }, (_, i) => ({ tick: i, ball: { x: 50, y: 34 } }));

  it("정지·키장면이 없으면 크루즈 속도 그대로다", () => {
    // 기대값을 상수로 박지 않는다 — #365 가 배속을 바꾸자(2 → 2.4) 이 단언만 옛 속도를 주장하며
    // 깨졌다. 계약의 내용은 "크루즈 구간은 PACE 가 말하는 속도로 정확히 흐른다"이지 180초가 아니다.
    const expectedMs = ((1440 / (PACE.TICKS_PER_SEC * PACE.CRUISE_SPEED)) * 1000);
    expect(autoPaceDurationMs(plain, [])).toBeGreaterThan(expectedMs - 1_000);
    expect(autoPaceDurationMs(plain, [])).toBeLessThan(expectedMs + 1_000);
  });

  it("키장면이 있으면 그 구간이 슬로우라 **길어진다**(연출의 대가)", () => {
    const withGoal = [{ tick: 700, type: "goal" }];
    expect(autoPaceDurationMs(plain, withGoal)).toBeGreaterThan(autoPaceDurationMs(plain, []));
  });

  it("배율을 곱하면 길이가 그만큼 줄어든다(라이브 페이스 정합의 근거)", () => {
    const base = autoPaceDurationMs(plain, []);
    expect(autoPaceDurationMs(plain, [], 2)).toBeCloseTo(base / 2, -3);
  });

  it("스냅샷이 없거나 하나뿐이면 0(모델이 폭주하지 않는다)", () => {
    expect(autoPaceDurationMs([], [])).toBe(0);
    expect(autoPaceDurationMs([{ tick: 0, ball: { x: 0, y: 0 } }], [])).toBe(0);
  });
});

describe("#365 clockScaleOf — 화면 시계가 표기 분(0~90')을 따른다", () => {
  /**
   * ⚠️ 이 계약이 없어서 실제로 뚫렸다: 엔진은 45분(하프 1350틱)을 돌면서 `minute` 에 0~90 을
   * 구워 보내는데, **뷰어 시계만 엔진 틱을 그대로 분으로 읽어** 화면이 0~44' 로 흘렀다.
   * 로그줄·타임라인은 구워진 `minute` 을 쓰므로 **한 화면이 두 시각을 말하는** 상태였다.
   */
  const snapsTo = (last: number, minute: number) => [{ tick: 0, minute: 0 }, { tick: last, minute }];

  it("half_whistle 이 있으면 그것으로 정확히 유도한다 (45분 경기 → ×2)", () => {
    const events = [{ type: "half_whistle", tick: 1350, minute: 45 }];
    expect(clockScaleOf(events, snapsTo(2699, 89))).toBe(2);
  });

  it("후반만 있는 로그(half_whistle 없음)는 full_whistle 로 유도한다", () => {
    const events = [{ type: "full_whistle", tick: 2699, minute: 90 }];
    expect(clockScaleOf(events, snapsTo(2699, 89))).toBeCloseTo(2, 6);
  });

  it("휘슬이 없으면 마지막 스냅샷으로 근사한다", () => {
    expect(clockScaleOf([], snapsTo(2699, 89))).toBeCloseTo(2, 6);
  });

  it("구 로그(경기 분 = 표기 분)는 1 — 동작이 안 바뀐다", () => {
    const events = [{ type: "half_whistle", tick: 2700, minute: 45 }];
    expect(clockScaleOf(events, snapsTo(5399, 89))).toBe(1);
  });

  it("근거가 하나도 없으면 1 로 폴백한다(시계가 죽지 않는다)", () => {
    expect(clockScaleOf([], [])).toBe(1);
    expect(clockScaleOf(undefined as never, undefined as never)).toBe(1);
    expect(clockScaleOf([], [{ tick: 0, minute: 0 }])).toBe(1);
  });
});
