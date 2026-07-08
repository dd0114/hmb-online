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
  it("골(네트→킥오프) 재배치도 컷한다", () => {
    const restarts = buildRestartTicks([{ type: "goal", tick: 50 }]);
    expect(spansReposition(49, 50, restarts)).toBe(true);
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
  it("재배치 이벤트만 포함(shot/pass 제외)", () => {
    const r = buildRestartTicks([
      { type: "kickoff", detail: "corner", tick: 1 },
      { type: "goal", tick: 2 },
      { type: "free_kick", tick: 3 },
      { type: "shot", tick: 4 },
      { type: "pass", tick: 5 },
    ]);
    expect([...r].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe("buildStoppages — 원인→재시작 skip 대상", () => {
  it("선방 + 코너 → '선방!' 자막 + 코너로 skip", () => {
    const ev = [
      { type: "shot", tick: 95, detail: "saved" },
      { type: "save", tick: 96 },
      { type: "kickoff", detail: "corner", tick: 100 },
    ];
    const save = buildStoppages(ev).find((s) => s.causeTick === 96);
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
    expect(st[0].big).toContain("빗나감");
    expect(st[0].restartTick).toBe(164);
  });
  it("일반 패스/슛은 정지 시퀀스를 만들지 않는다", () => {
    expect(buildStoppages([{ type: "pass", tick: 1 }, { type: "shot", tick: 2 }])).toHaveLength(0);
  });
});

describe("buildAnnotations", () => {
  const snaps = [];
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
    const s = [];
    for (let t = 0; t < 8; t++) s.push({ tick: t, ballOwner: "H9", ball: { x: 40 + t * 3, y: 34 } });
    s.push({ tick: 8, ballOwner: "H6", ball: { x: 64, y: 34 } }); // 소유 변경으로 run 종료
    const a = buildAnnotations([], s);
    expect(a.find((x) => x.text === "돌파!")).toBeTruthy();
  });
});
