import { describe, it, expect } from "vitest";
import {
  eventKind,
  buildRestartTicks,
  spansReposition,
  buildStoppages,
  buildAnnotations,
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
    expect(save.big).toContain("선방");
    expect(save.restartTick).toBe(100);
  });
  it("빗나감 + 골킥 → '빗나감!' + 골킥으로 skip", () => {
    const ev = [
      { type: "shot", tick: 160, detail: "off_target" },
      { type: "kickoff", detail: "goal_kick", tick: 164 },
    ];
    const st = buildStoppages(ev);
    expect(st[0]!.big).toContain("빗나감");
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
    expect(save.big).toContain("선방");
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
    expect(corner.big).toContain("코너킥"); // 큰 상황자막(무음 pauseOnly 아님)
    expect(corner.pauseOnly).toBeFalsy();
    expect(corner.setPiece).toBe(true); // freeze 중 taker 로 줌 표시
    expect(corner.restartTick).toBe(200); // 제자리 재개(프레임 스킵 없음)
    expect(corner.isGoal).toBeFalsy();
    expect(corner.hold).toBeGreaterThan(0);

    const thr = st.find((x) => x.causeTick === 500)!;
    expect(thr, "스로인 정지 있어야").toBeTruthy();
    expect(thr.big).toContain("스로인");
    expect(thr.pauseOnly).toBeFalsy();
    expect(thr.setPiece).toBe(true);
    expect(thr.restartTick).toBe(500);
    expect(thr.hold).toBeGreaterThan(0);
  });
  it("프리킥은 pauseOnly 정지 비트 유지, 골킥은 정지 없음(빈도 높음)", () => {
    const st = buildStoppages([
      { type: "free_kick", detail: "foul", tick: 300 },
      { type: "kickoff", detail: "goal_kick", tick: 400 },
    ]);
    const fk = st.find((x) => x.causeTick === 300)!;
    expect(fk.pauseOnly).toBe(true);
    expect(fk.big).toBe("");
    expect(fk.restartTick).toBe(300);
    // 골킥은 잦아서 정지 제외.
    expect(st.find((x) => x.causeTick === 400)).toBeFalsy();
  });
  // #42: CAUSE 정지 skip 은 "원인→재시작 사이 = 데드타임"일 때만. 세이브 후 공이 라이브인
  // 체인(패스→2차슛→빗나감→골킥)을 스킵하면 라이브 플레이가 사라지고(2차 슛 미표시),
  // 중간 상황자막이 드롭되며, 착지 프레임에 토스트/궤적선/선수 잔상이 유령처럼 몰아 나타난다.
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
      expect(off.big).toContain("빗나감");
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
    expect(a.find((x) => x.text === "슛!" && x.kind === "toast")).toBeTruthy();
    expect(a.find((x) => x.text.includes("선방"))).toBeTruthy();
    expect(a.find((x) => x.text.includes("오프사이드") && x.kind === "banner")).toBeTruthy();
    expect(a.find((x) => x.text === "코너킥" && x.kind === "banner")).toBeTruthy();
  });
  it("롱 드리블(같은 소유자 6틱+ 전진)에 '돌파!' 토스트", () => {
    const s: any[] = [];
    for (let t = 0; t < 8; t++) s.push({ tick: t, ballOwner: "H9", ball: { x: 40 + t * 3, y: 34 } });
    s.push({ tick: 8, ballOwner: "H6", ball: { x: 64, y: 34 } }); // 소유 변경으로 run 종료
    const a = buildAnnotations([], s);
    expect(a.find((x) => x.text === "돌파!")).toBeTruthy();
  });
});
