/**
 * 하이라이트 **순서 재생 배선** 계약 (#421 W4).
 *
 * W3(`highlight-reel.test.ts`)이 "무엇이 장면인가"를 박았다면 여기는 **"그 목록을 라이브 화면에서
 * 어떻게 태우는가"** 다. 반드시 죽여야 하는 결함 다섯:
 *  ① 라이브 게이트와 시퀀서가 서로 seek 를 민다(두 주인).
 *  ② `liveTick` 상한을 넘는 **미래 장면**으로 뛴다(스포일러, #233/#238).
 *  ③ 따라잡았을 때 멈추거나 에러가 된다(정상 동작은 **라이브 이어 재생**).
 *  ④ 전체 재생으로 돌아갈 길이 없다.
 *  ⑤ 장면이 0개일 때 화면이 성립하지 않는다.
 *
 * 표본 규율은 W3 과 같다 — **실경기 로그**로 재고(합성은 규칙 하나당 하나), 수치는 리터럴과
 * 관계식을 **둘 다** 건다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCENE_LEAD_IN_TICKS,
  buildHighlightReel,
  sceneWindow,
  type ReelEventLike,
  type Scene,
} from "./highlight-reel";
import {
  CURSOR_START,
  DEFAULT_ON_WHILE_LIVE,
  HIGHLIGHT_DEFAULT_HALVES,
  gateWouldRecover,
  highlightAvailable,
  highlightDefaultOn,
  highlightToggleView,
  nextSequencerAction,
  reelEventsOf,
  reelFor,
  type SequencerAction,
} from "./highlight-sequencer";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

function loadFixture(name: string): { events: ReelEventLike[] } {
  return JSON.parse(readFileSync(join(repoRoot, "apps", "web", "e2e", "fixtures", name), "utf8"));
}

/** 실경기 후반(이벤트 628 · 장면 8) — #322 가 쓴 라이브 리그 경기 로그. */
const REAL = loadFixture("p322-half2.json");
const SCENES = buildHighlightReel(REAL.events);

/**
 * 시퀀서를 **한 화면분 돌린다**. 폴 하나가 뷰어에 무엇을 시키는지만 흉내 낸다:
 * `jump` 면 플레이헤드가 그 틱에 착지하고, 아니면 재생이 조금 흐른다.
 * (실제 훅도 이 루프 그대로다 — `useHighlightSequencer` 는 여기에 `jumpToTick`/`play` 만 붙인다.)
 */
function drive(opts: {
  scenes: readonly Scene[];
  liveTick?: number;
  /** 시작 플레이헤드 — 라이브에서 게이트가 seek-to-now 로 세워 둔 자리. */
  startTick?: number;
  /** 한 폴에 재생이 흐르는 틱 수. */
  step?: number;
  polls?: number;
  gateRecovering?: (poll: number) => boolean;
}): { visited: number[]; indexes: number[]; reasons: string[]; targets: number[]; endTick: number } {
  const step = opts.step ?? 4;
  let cursor = CURSOR_START;
  let active: Scene | null = null;
  let curTick = opts.startTick ?? 0;
  const visited: number[] = [];
  const indexes: number[] = [];
  const reasons: string[] = [];
  const targets: number[] = [];
  for (let poll = 0; poll < (opts.polls ?? 200); poll++) {
    const action: SequencerAction = nextSequencerAction({
      scenes: opts.scenes,
      cursorTick: cursor,
      active,
      curTick,
      ...(opts.liveTick !== undefined ? { liveTick: opts.liveTick } : {}),
      gateRecovering: opts.gateRecovering?.(poll) ?? false,
    });
    cursor = action.cursorTick;
    if (action.kind === "jump") {
      active = action.scene;
      curTick = action.toTick; // 뷰어가 그 자리에 착지한다.
      visited.push(action.scene.tick);
      indexes.push(action.index);
      targets.push(action.toTick);
    } else {
      reasons.push(action.reason);
      curTick += step;
    }
  }
  return { visited, indexes, reasons, targets, endTick: curTick };
}

// ─────────────────────────────────────────────── ① 라이브 게이트와 배타(두 주인 금지)

describe("① 라이브 게이트 배타 — 시퀀서와 게이트는 같은 창에서 seek 를 다투지 않는다", () => {
  it("게이트가 회수 점프를 할 폴에서는 시퀀서가 **아무것도 하지 않는다**", () => {
    const action = nextSequencerAction({
      scenes: SCENES,
      cursorTick: CURSOR_START,
      active: null,
      curTick: 0,
      gateRecovering: true,
    });
    expect(action.kind).toBe("idle");
    expect(action.kind === "idle" && action.reason).toBe("gate-busy");
    // 커서도 안 움직인다 — 이 폴은 없었던 것으로 하고 다음 폴에서 다시 판단한다.
    expect(action.cursorTick).toBe(CURSOR_START);
  });

  it("게이트가 계속 일하는 동안 시퀀서 점프는 **0건**이고, 게이트가 손을 떼면 그때 #1부터 시작한다", () => {
    const busy = drive({ scenes: SCENES, polls: 40, gateRecovering: () => true });
    expect(busy.visited, "게이트가 일하는 동안 시퀀서가 끼어들면 안 된다").toEqual([]);
    expect(new Set(busy.reasons)).toEqual(new Set(["gate-busy"]));

    const later = drive({ scenes: SCENES, polls: 40, gateRecovering: (p) => p < 5 });
    expect(later.indexes[0], "게이트가 손을 뗀 뒤엔 하이라이트 #1부터").toBe(1);
    expect(later.visited[0]).toBe(SCENES[0]!.tick);
  });

  it("🔴 시퀀서 점프 목표는 **언제나 상한 이하** — 그래서 게이트 회수를 유발할 수 없다", () => {
    // 상한을 여러 지점에 두고 전 구간을 돌려도 목표가 상한을 넘는 폴이 하나도 없어야 한다.
    for (const scene of SCENES) {
      const cap = scene.tick;
      const run = drive({ scenes: reelFor(REAL.events, cap), liveTick: cap, polls: 300 });
      expect(run.targets.length, "이 상한에서도 볼 장면은 있어야 계약이 성립한다").toBeGreaterThan(0);
      for (const t of run.targets) expect(t, `상한 ${cap} 을 넘는 점프`).toBeLessThanOrEqual(cap);
    }
  });

  it("`gateWouldRecover` 는 게이트 effect 와 같은 조건식이다(드리프트 폭 안은 회수하지 않는다)", () => {
    expect(gateWouldRecover(120, 100, 12)).toBe(true); // 상한 + 폭을 넘겼다
    expect(gateWouldRecover(112, 100, 12)).toBe(false); // 정확히 폭 안 — 자유 재생의 앞섬
    expect(gateWouldRecover(80, 100, 12)).toBe(false); // 뒤처짐은 자유
  });
});

// ─────────────────────────────────────────────── ② liveTick 상한(스포일러 금지)

describe("② 라이브 상한 — 미래 장면으로 뛰지 않는다", () => {
  it("상한 안 장면만 재생하고, 상한 밖 장면은 **한 건도** 방문하지 않는다", () => {
    const cap = SCENES[2]!.tick; // 앞의 3개만 열려 있는 순간
    const run = drive({ scenes: reelFor(REAL.events, cap), liveTick: cap, polls: 300 });
    expect(run.visited).toEqual(SCENES.slice(0, 3).map((s) => s.tick));
    for (const t of run.visited) expect(t).toBeLessThanOrEqual(cap);
  });

  it("상한이 없으면(종료된 경기·지나간 하프) 장면 전량을 순서대로 본다", () => {
    const run = drive({ scenes: SCENES, polls: 400 });
    expect(run.visited).toEqual(SCENES.map((s) => s.tick));
    expect(run.indexes).toEqual(SCENES.map((_, i) => i + 1));
  });

  it("상한이 흐르면 그때그때 열린 장면까지만 — 목록을 캐시해도 새어 나가지 않는다", () => {
    // 목록은 상한 없이 **한 번** 만들고(=캐시), 판정에만 상한을 준다. `nextSceneAfter` 의 상한이
    // 마지막 방벽이다(#421 W3 ④).
    const cap = SCENES[1]!.tick;
    const run = drive({ scenes: SCENES, liveTick: cap, polls: 300 });
    expect(run.visited).toEqual(SCENES.slice(0, 2).map((s) => s.tick));
  });
});

// ─────────────────────────────────────────────── ③ 따라잡음 = 라이브 이어 재생

describe("③ 따라잡으면 null — 정지도 에러도 아니고 라이브를 이어 재생한다", () => {
  it("다음 장면이 없으면 `caught-up` idle 이고, 재생은 계속 흐른다", () => {
    const cap = SCENES[0]!.tick;
    const run = drive({ scenes: reelFor(REAL.events, cap), liveTick: cap, polls: 60 });
    expect(run.visited).toEqual([SCENES[0]!.tick]);
    expect(run.reasons.at(-1)).toBe("caught-up");
    // 재생이 멈추지 않았다 = 플레이헤드가 계속 나아간다.
    expect(run.endTick).toBeGreaterThan(SCENES[0]!.tick);
  });

  it("따라잡은 뒤 새 장면이 상한 안으로 들어오면 **다시 점프**한다", () => {
    const cap1 = SCENES[0]!.tick;
    // 1단계: 상한이 첫 장면까지 — #1 만 보고 따라잡는다.
    let cursor = CURSOR_START;
    let active: Scene | null = null;
    let curTick = 0;
    const visited: number[] = [];
    const runOne = (liveTick: number) => {
      const a = nextSequencerAction({ scenes: reelFor(REAL.events, liveTick), cursorTick: cursor, active, curTick, liveTick });
      cursor = a.cursorTick;
      if (a.kind === "jump") {
        active = a.scene;
        curTick = a.toTick;
        visited.push(a.scene.tick);
      } else curTick += 4;
      return a;
    };
    for (let i = 0; i < 40; i++) runOne(cap1);
    expect(visited).toEqual([SCENES[0]!.tick]);
    // 2단계: 시계가 흘러 둘째 장면이 열린다.
    for (let i = 0; i < 40; i++) runOne(SCENES[1]!.tick);
    expect(visited, "상한이 흐르면 그 장면으로 이어진다").toEqual([SCENES[0]!.tick, SCENES[1]!.tick]);
  });

  it("따라잡은 동안 라이브로 **지나쳐 본 장면은 되감지 않는다**(커서가 플레이헤드를 따라간다)", () => {
    // 상한 밖이라 못 보던 장면을, 플레이헤드가 라이브 재생으로 이미 지나간 뒤에 열어 준다.
    const past = SCENES[0]!.tick;
    let cursor = CURSOR_START;
    // 장면이 아직 없는 동안 라이브가 흐른다 → 커서가 플레이헤드를 따라간다.
    for (let curTick = 0; curTick <= past + 60; curTick += 10) {
      const a = nextSequencerAction({ scenes: [], cursorTick: cursor, active: null, curTick, liveTick: curTick });
      expect(a.kind === "idle" && a.reason).toBe("caught-up");
      cursor = a.cursorTick;
    }
    expect(cursor).toBeGreaterThan(past);
    // 이제 상한이 열려도 이미 지나간 장면은 다시 잡지 않는다.
    const after = nextSequencerAction({
      scenes: SCENES,
      cursorTick: cursor,
      active: null,
      curTick: past + 60,
      liveTick: SCENES[1]!.tick,
    });
    expect(after.kind === "jump" && after.scene.tick, "지나간 #1 이 아니라 다음 장면으로").toBe(SCENES[1]!.tick);
  });

  it("장면이 0개여도 idle 이지 예외가 아니다(⑤ 장면 없음)", () => {
    const run = drive({ scenes: [], polls: 20 });
    expect(run.visited).toEqual([]);
    expect(new Set(run.reasons)).toEqual(new Set(["caught-up"]));
    expect(run.endTick).toBeGreaterThan(0); // 재생은 정상 진행
    // 로그가 손상돼 이벤트를 못 읽는 경우까지.
    expect(reelEventsOf(null)).toEqual([]);
    expect(reelEventsOf({ events: "nope" })).toEqual([]);
    expect(reelFor(reelEventsOf({}))).toEqual([]);
  });
});

// ─────────────────────────────────────────────── ④ 순서·중복

describe("④ 하이라이트 #1부터 순서대로 — 같은 장면을 두 번 잡지 않는다", () => {
  it("커서 시작은 -1 이라 **플레이헤드가 어디에 있든** #1부터 시작한다(seek-to-now 상태 포함)", () => {
    // 늦게 접속하면 게이트가 플레이헤드를 라이브 끝(여기선 마지막 장면 뒤)에 세워 둔다.
    const late = drive({ scenes: SCENES, startTick: SCENES.at(-1)!.tick + 100, polls: 400 });
    expect(late.indexes[0]).toBe(1);
    expect(late.visited).toEqual(SCENES.map((s) => s.tick));
  });

  it("재생 중인 장면은 그 구간이 끝나기 전에 다음으로 넘기지 않는다(리드인 되감기로 재점프 금지)", () => {
    const scene = SCENES[0]!;
    const win = sceneWindow(scene);
    expect(win.fromTick).toBe(Math.max(0, scene.tick - SCENE_LEAD_IN_TICKS));
    // 착지 직후 = 장면 틱보다 **앞**이다. 여기서 다시 점프하면 무한 루프가 된다.
    const a = nextSequencerAction({
      scenes: SCENES,
      cursorTick: scene.tick,
      active: scene,
      curTick: win.fromTick,
    });
    expect(a.kind === "idle" && a.reason).toBe("in-scene");
    // 구간 끝을 넘으면 다음 장면으로.
    const b = nextSequencerAction({
      scenes: SCENES,
      cursorTick: scene.tick,
      active: scene,
      curTick: win.toTick + 1,
    });
    expect(b.kind === "jump" && b.scene.tick).toBe(SCENES[1]!.tick);
    expect(b.kind === "jump" && b.index).toBe(2);
  });

  it("방문 순서는 시각 순이고 중복이 없다(실경기 장면 8건)", () => {
    const run = drive({ scenes: SCENES, polls: 400 });
    expect(SCENES).toHaveLength(8);
    expect(new Set(run.visited).size).toBe(run.visited.length);
    expect([...run.visited].sort((a, b) => a - b)).toEqual(run.visited);
  });
});

// ─────────────────────────────────────────────── ⑤ 디폴트·전체 재생 복귀

describe("⑤ 적용 범위와 전체 재생 복귀", () => {
  /**
   * ⚠️ **#456 B1 에서 뒤집혔다.** 원래는 *"디폴트는 후반만 — 전반은 토글로 연다"*(`[2]`)였고,
   * 그 전제는 **화면에 토글이 있다**는 것이었다. hero 가 그 토글을 내리면서(B1) 전제가 사라졌다 —
   * 디폴트 ON 을 그대로 두면 유저는 **끄는 버튼 없이** 릴이 도는 화면을 보게 된다(#421 이관 발견:
   * 릴 점프로 플레이헤드가 튀는데 전체 재생으로 돌아갈 경로가 없다).
   *
   * 그래서 **범위를 비운다**(`[]`) — 부품·순수 로직은 그대로 살아 있고(롤백 자산) 켜는 문만 닫는다.
   * 토글을 다시 노출하는 날 이 상수를 되돌리면 그대로 살아난다.
   */
  it("디폴트는 **없다** — 토글을 내렸으므로 켜는 문도 닫는다 (#456 B1)", () => {
    expect(HIGHLIGHT_DEFAULT_HALVES).toEqual([]);
    expect(highlightDefaultOn({ half: 2 })).toBe(false);
    expect(highlightDefaultOn({ half: 1 })).toBe(false);
  });

  it("🔴 **아직 진행 중인 하프**에서는 디폴트로 켜지 않는다 — 라이브 되감기 계약과 다투지 않는다", () => {
    // 근거·트레이드오프 = `DEFAULT_ON_WHILE_LIVE` 주석(`e2e/match-live-clock.spec.ts` h 가 후반
    // 라이브의 되감기 표본 0 을 계약으로 들고 있다). 상수를 true 로 되돌리면 그 계약이 먼저 깨진다.
    expect(DEFAULT_ON_WHILE_LIVE).toBe(false);
    expect(highlightDefaultOn({ half: 2, live: true })).toBe(false);
    /*
     * ⚠️ **여기가 #456 B1 로 바뀐 두 번째 줄이다.** 원래는 *"하프가 끝나면 그 자리에서 켜진다
     * (= 스킵의 종착 화면)"* 이라 `true` 였다. 지금은 적용 범위(`HIGHLIGHT_DEFAULT_HALVES`)가
     * 비어 있어 **어떤 하프도 자동으로 켜지지 않는다** — 이 줄이 재는 것은 `live` 축이 아니라
     * 범위 축이므로, 범위를 `[2]` 로 되돌리면 이 기대도 함께 `true` 로 돌아간다.
     *
     * ⚠️ **정직하게 적는다 — 라이브 축은 지금 `highlightDefaultOn` 으로는 관측되지 않는다.**
     * 범위 게이트가 먼저 걸려 어떤 `live` 값이든 `false` 라, `DEFAULT_ON_WHILE_LIVE` 를 `true` 로
     * 되돌리는 변이는 300행을 **통과한다**. 그 변이를 죽이는 것은 위 299행(상수 직접 단언)뿐이고,
     * 행동 축은 범위를 되돌리는 날 함께 살아난다. 여기에 "죽는다"고 적어 두면 다음 사람이
     * 있지도 않은 방어를 믿는다(apps/web CLAUDE.md "초록으로 거짓말하는 방식").
     */
    expect(highlightDefaultOn({ half: 2, live: false })).toBe(false);
    // 그래도 **고를 수는 있다** — 라이브에서도 토글은 살아 있다(유저가 요청한 되감기는 별개다).
    expect(highlightAvailable({ half: 2, live: true })).toBe(true);
  });

  it("돌려보는 화면(review)은 대상이 아니다 — 스크럽 도구를 든 자리다", () => {
    expect(highlightDefaultOn({ half: 2, review: true })).toBe(false);
    expect(highlightAvailable({ half: 2, review: true })).toBe(false);
    expect(highlightAvailable({ half: 1 })).toBe(true);
  });

  it("토글은 전체 재생으로 돌아가는 **유일한 경로**라 장면이 0개여도 사라지지 않는다", () => {
    const empty = highlightToggleView({ available: true, enabled: true, total: 0 });
    expect(empty.visible).toBe(true);
    expect(empty.pressed).toBe(true);
    expect(empty.status).toBeNull();
    expect(empty.hint).toContain("전체 재생");

    const off = highlightToggleView({ available: true, enabled: false, total: 8 });
    expect(off.visible).toBe(true);
    expect(off.pressed).toBe(false);
    expect(off.label).not.toBe(empty.label); // 두 상태가 화면에서 구분된다

    const playing = highlightToggleView({
      available: true,
      enabled: true,
      scene: SCENES[1]!,
      index: 2,
      total: 8,
    });
    expect(playing.status).toContain("#2/8");
    expect(playing.status).toContain(SCENES[1]!.label);

    expect(highlightToggleView({ available: false, enabled: true }).visible).toBe(false);
  });

  /*
   * 독립검증 N5 — 라벨과 `aria-pressed` 가 **같은 의미축**을 가리켜야 한다.
   *
   * 구 동작: `✨ 하이라이트`(켜짐) / `▶ 전체 보기`(꺼짐) + `aria-pressed=enabled`.
   * 꺼진 상태의 이름이 `전체 보기` 인데 `aria-pressed=false` 라 스크린리더는 *"전체 보기, 안 눌림"*
   * 이라고 읽는데 화면은 실제로 **전체 보기 중**이었다(모순). 시각 사용자에겐 그 글자가 상태가
   * 아니라 **액션**으로 읽혔다. 지금은 `auto-mode.autoCopy`(`오토 ON`/`오토 OFF`)와 같은 모양이다.
   *
   * 변이 킬 확인: 라벨을 `enabled ? "✨ 하이라이트" : "▶ 전체 보기"` 로 되돌리면 아래 ①②가
   * 죽는다(주어 고정 · 상태 표기). 컴포넌트 쪽(`aria-label` 을 `hint` 로 되돌리기)은
   * `HighlightToggle` 렌더 계약이 잡는다.
   */
  it("N5 — 주어는 고정이고 상태만 바뀐다(라벨 축 == aria-pressed 축)", () => {
    const on = highlightToggleView({ available: true, enabled: true, total: 8 });
    const off = highlightToggleView({ available: true, enabled: false, total: 8 });

    // ① 주어 고정 — 켜짐/꺼짐 둘 다 같은 것을 가리킨다(액션으로 읽히는 다른 이름이 아니다).
    expect(on.label).toContain("하이라이트");
    expect(off.label).toContain("하이라이트");
    // 구 라벨(액션 문구)이 되돌아오면 죽는다.
    expect(off.label).not.toContain("전체 보기");

    // ② 라벨의 상태 표기가 `pressed` 와 같은 것을 말한다.
    expect(on.label).toContain("ON");
    expect(off.label).toContain("OFF");
    expect(on.pressed).toBe(true);
    expect(off.pressed).toBe(false);

    // ③ `hint` 는 **액션**이라 이름이 아니라 설명 자리다 — 두 축이 섞이지 않게 서로 다르다.
    expect(on.hint).not.toBe(on.label);
    expect(off.hint).not.toBe(off.label);
  });
});
