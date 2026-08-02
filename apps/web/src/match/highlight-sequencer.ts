/**
 * 하이라이트 **순서 재생 배선 규칙** — 순수 모듈 (#421 W4).
 *
 * 요구(hero ③): *후반 입력 후 디폴트 경기 화면 = 전체 재생이 아니라 하이라이트 #1부터 주요 장면 순*.
 * 무엇이 장면인가(골·유효슛·세이브)와 그 구간은 **`highlight-reel.ts`(W3)** 가 소유한다. 이 파일은
 * 그 목록을 **뷰어에 어떻게 태울까** — 다음에 무엇을 할지 한 번에 하나씩 정하는 상태 없는 결정기다.
 * 실제 구동(`jumpToTick`/`play`/폴링)은 `useHighlightSequencer.ts` 가 하고, 여기엔 React·DOM·뷰어
 * 의존이 0 이라 vitest 로 계약을 박을 수 있다(`skip-mode.ts`·`auto-mode.ts` 선례).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ① 🔴 **라이브 게이트와 배타** — 이 파일이 존재하는 가장 큰 이유다.
 *
 * 후반은 진행 중이고 서버 권위 시계에 묶여 있다. 앞서보기 차단은 `clampSeek`(shared) +
 * `live-clock.liveGate` + `VisualPlayback` 의 250ms 회수 루프가 소유한다 — **그 effect 는 이 웨이브가
 * 한 줄도 건드리지 않는다.** 둘이 같은 창에서 각자 `seek` 를 밀면 서로 싸워 화면이 고무줄이 된다.
 * 그래서 배타를 **두 겹**으로 못 박는다:
 *
 *  ⓐ **시퀀서는 게이트를 발화시킬 수 없다** — 점프 목표는 언제나 `liveTick` **이하**다. 장면 목록이
 *    이미 상한으로 잘려 있고(`buildHighlightReel({liveTick})`), 리드인은 장면보다 **앞**이라
 *    `fromTick ≤ scene.tick ≤ liveTick` 이 구조적으로 성립한다. 게이트의 회수 조건은
 *    "플레이헤드가 상한보다 **앞**"이므로 시퀀서 점프는 그 조건을 만들 수 없다.
 *  ⓑ **게이트가 일하는 창에서 시퀀서는 손을 뗀다** — 회수 조건이 참인 폴에서는 `gate-busy` 로 아무
 *    것도 하지 않는다(`gateWouldRecover`). 그래서 한 폴에서 두 주인이 동시에 `seek` 를 내는 일이 없다.
 *
 * 게이트가 회수 점프를 하면 플레이헤드는 상한(=지금)으로 간다 → 그 뒤 시퀀서는 "다음 장면 없음"이
 * 되어 **조용히 라이브를 이어 재생**한다(아래 ③). 즉 충돌이 아니라 **게이트가 항상 이긴다**.
 *
 * ② **커서는 플레이헤드가 아니다.** 시작값은 `-1` — 그래야 늦게 접속해 게이트가 seek-to-now 로
 * 플레이헤드를 라이브 끝에 세워 둔 상태에서도 **하이라이트 #1부터** 시작한다(요구 원문). 커서를
 * 플레이헤드에서 유도하면 그 화면은 "볼 장면이 없다"가 되어 요구가 통째로 성립하지 않는다.
 * 대신 **따라잡은 동안(idle)은 커서가 플레이헤드를 따라간다** — 안 그러면 라이브로 이미 지나쳐 본
 * 장면을 나중에 되감아 다시 보여준다.
 *
 * ③ **"따라잡으면 없음(null)"은 정상이다** — 에러도 정지도 아니다(#421 W3 ④, 스포일러 계약
 * #233/#238). 하프 로그는 창이 열리는 순간 전량 오지만 상한을 넘는 장면은 **보여주면 안 된다**.
 * 그때 화면은 그냥 **라이브를 이어 재생**하고, 새 장면이 상한 안으로 들어오면 다시 점프한다.
 */

import {
  buildHighlightReel,
  nextSceneAfter,
  sceneWindow,
  type ReelEventLike,
  type Scene,
} from "./highlight-reel";

/**
 * 폴링 주기(ms). 라이브 게이트 회수 루프와 **같은 값**이다 — 다르게 잡으면 두 루프가 어긋난 격자로
 * 만나 "게이트가 일하는 창"을 시퀀서가 못 보는 폴이 생긴다(위 ①ⓑ).
 */
export const SEQUENCER_POLL_MS = 250;

/** 커서 시작값 — 하이라이트 **#1부터**(장면 틱은 0 이상이므로 항상 첫 장면이 잡힌다, 위 ②). */
export const CURSOR_START = -1;

/**
 * 디폴트로 하이라이트 순서 재생을 켤 하프.
 *
 * 요구는 **후반**이다("후반 입력 후 디폴트 경기 화면"). 전반은 유저가 방금 킥오프를 지시하고 들어온
 * 화면이라 처음부터 보는 것이 자연스럽고, 하이라이트는 **토글로 열어 둔다**(끄고 켜는 곳은 이 상수
 * 하나 + `DEFAULT_ON_WHILE_LIVE` + 토글 버튼). 다시보기(`review`)는 유저가 스크럽 도구를 들고 직접
 * 찾는 자리라 제외한다 — 스킵 버튼을 그 자리에서 뺀 것과 같은 이유(`skip-mode.skipButtonView`).
 */
export const HIGHLIGHT_DEFAULT_HALVES: readonly (1 | 2)[] = [2];

/**
 * ⚠️ **아직 진행 중인(라이브) 하프에서는 디폴트로 켜지 않는다 — 요구 문언에서 좁힌 유일한 지점이다.**
 *
 * 왜: 하이라이트 #1부터 틀려면 플레이헤드를 **뒤로** 끌어야 하는데(장면은 이미 지나간 자리에 있고,
 * 서버 권위 시계는 늦게 들어온 화면을 항상 **지금**에 세운다 = seek-to-now), 그 되감기는 라이브
 * 재생 규율과 정면으로 부딪힌다. 실제로 그 규율이 계약으로 박혀 있다 —
 * `e2e/match-live-clock.spec.ts` h("후반도 경과 지점부터 돌아간다"): **후반 라이브에서 되감기 표본 0**.
 * 디폴트로 켜면 그 계약이 깨지고, 그건 이 웨이브가 고칠 수 있는 스펙이 아니다(#406 이 e2e 재작성
 * 중이라 기존 스펙 무편집이 이 에픽의 선언 경계다).
 *
 * 그래서 **라이브 하프는 평소대로 지금부터 흐르고**, 그 하프가 끝나 상한이 풀리는 순간(FINISHED =
 * 스킵의 종착 화면이자 후반 종료 화면) **그 자리에서 하이라이트 리플레이로 바뀐다.** 라이브 중에도
 * 유저가 토글을 켜면 즉시 #1부터 돈다 — 유저가 명시적으로 요청한 되감기는 seek-to-now 규율과 다투지
 * 않는다(스크럽·핀 점프와 같은 성질).
 *
 * 되돌리려면 이 상수를 `true` 로 바꾸면 되고, 그때 위 계약이 먼저 깨진다 = 그게 이 결정을 다시 보라는
 * 신호다. 상세·트레이드오프는 #421 W4 보고.
 */
export const DEFAULT_ON_WHILE_LIVE = false;

export interface HighlightDefaultInput {
  half: 1 | 2;
  /** 돌려보는 화면(#244) — 감독시간 `경기장면` 탭·다시보기. */
  review?: boolean;
  /** 이 하프가 **아직 진행 중**인가(서버 권위 시계의 라이브 하프). */
  live?: boolean;
}

/** 이 화면이 하이라이트 모드로 **시작**하는가. 유저 토글은 이 값을 이긴다(그게 복귀 경로다). */
export function highlightDefaultOn(input: HighlightDefaultInput): boolean {
  if (input.review) return false;
  if (input.live && !DEFAULT_ON_WHILE_LIVE) return false;
  return HIGHLIGHT_DEFAULT_HALVES.includes(input.half);
}

/** 하이라이트 모드를 **고를 수 있는** 화면인가(토글 노출). */
export function highlightAvailable(input: HighlightDefaultInput): boolean {
  return input.review !== true;
}

/**
 * 라이브 게이트가 이 폴에서 **회수 점프를 할 상태**인가.
 *
 * ⚠️ 조건식은 `VisualPlayback` 의 게이트 effect 와 **같은 모양**이다(`curIdx > clamp(curIdx) + drift`).
 * 그 effect 를 수정하지 않기로 했으므로 판정을 여기에 한 벌 더 두는데, **읽는 입력이 같아서**
 * (같은 `liveGate`·`indexOfPlayhead`·`driftAllowanceTicks`) 두 벌이 갈라질 여지는 인자 계산뿐이다.
 * 그 계산도 훅 한 곳(`useHighlightSequencer`)이 게이트와 동일한 헬퍼로 한다.
 */
export function gateWouldRecover(curIdx: number, clampedIdx: number, driftTicks: number): boolean {
  if (!Number.isFinite(curIdx) || !Number.isFinite(clampedIdx)) return false;
  return curIdx > clampedIdx + (Number.isFinite(driftTicks) ? driftTicks : 0);
}

export type SequencerIdleReason =
  /** 라이브 게이트가 일하는 창 — 손을 뗀다(위 ①ⓑ). */
  | "gate-busy"
  /** 지금 장면을 재생 중 — 그 구간이 끝나기 전엔 다음으로 넘어가지 않는다. */
  | "in-scene"
  /** 상한 안에 다음 장면이 없다 = **따라잡았다**. 라이브를 이어 재생한다(위 ③). */
  | "caught-up";

export type SequencerAction =
  | {
      kind: "jump";
      scene: Scene;
      /** 1-based 하이라이트 번호(#1 부터) — 화면 표시용. */
      index: number;
      /** 뷰어에 넘길 절대 틱(= 리드인 시작). 언제나 `liveTick` 이하다(위 ①ⓐ). */
      toTick: number;
      cursorTick: number;
    }
  | { kind: "idle"; reason: SequencerIdleReason; cursorTick: number };

export interface SequencerInput {
  /** 상한이 이미 걸린 장면 목록(`buildHighlightReel(events, { liveTick })`). */
  scenes: readonly Scene[];
  /** 시퀀서가 마지막으로 소비한 지점. 시작 = {@link CURSOR_START}. */
  cursorTick: number;
  /** 지금 재생 중인 장면(없으면 null). */
  active: Scene | null;
  /** 현재 플레이헤드 틱(`hooks.cur().tick`). */
  curTick: number;
  /** 라이브 재생 상한(절대 틱). 생략 = 상한 없음(지나간 하프·종료된 경기). */
  liveTick?: number;
  /** 라이브 게이트가 회수 점프를 할 상태인가({@link gateWouldRecover}). */
  gateRecovering?: boolean;
}

/**
 * 다음에 할 일 하나. **부작용 없음** — 호출자가 `jump` 면 `jumpToTick(toTick)` + `play()` 를 하고,
 * 반환된 `cursorTick`·`scene` 을 자기 상태로 들고 다음 폴에 다시 넣는다.
 *
 * 판정 순서 자체가 계약이다:
 *  1. **게이트 우선**(배타) → 2. 재생 중인 장면 존중 → 3. 다음 장면 → 4. 없으면 따라잡음.
 */
export function nextSequencerAction(input: SequencerInput): SequencerAction {
  const { scenes, cursorTick, active, curTick, liveTick } = input;
  const capOpt = typeof liveTick === "number" && Number.isFinite(liveTick) ? { liveTick } : {};

  if (input.gateRecovering === true) return { kind: "idle", reason: "gate-busy", cursorTick };

  if (active) {
    // 리드인으로 되감아 착지했으므로 초반엔 `curTick < scene.tick` 이다. 구간 끝을 넘어야 다음으로.
    const win = sceneWindow(active, capOpt);
    if (curTick <= win.toTick) return { kind: "idle", reason: "in-scene", cursorTick };
  }

  const next = nextSceneAfter(scenes, cursorTick, capOpt);
  if (!next) {
    // 따라잡음 — 라이브를 이어 재생한다. 커서는 플레이헤드를 따라가서, 그 사이 흘러간 장면을
    // 나중에 되감아 다시 보여주지 않는다(위 ②).
    return {
      kind: "idle",
      reason: "caught-up",
      cursorTick: Number.isFinite(curTick) ? Math.max(cursorTick, curTick) : cursorTick,
    };
  }

  return {
    kind: "jump",
    scene: next,
    index: scenes.indexOf(next) + 1,
    toTick: sceneWindow(next, capOpt).fromTick,
    cursorTick: next.tick,
  };
}

/** 로그(임의 형태)에서 이벤트 배열만 안전하게 꺼낸다 — 응답 형태를 믿지 않는다(apps/web 규율). */
export function reelEventsOf(log: unknown): ReelEventLike[] {
  const events = (log as { events?: unknown } | null | undefined)?.events;
  return Array.isArray(events) ? (events as ReelEventLike[]) : [];
}

/** 상한을 적용한 장면 목록 — 훅과 계약이 **같은 경로**로 만든다. */
export function reelFor(events: readonly ReelEventLike[], liveTick?: number): Scene[] {
  return buildHighlightReel(events, typeof liveTick === "number" ? { liveTick } : {});
}

export interface HighlightToggleView {
  visible: boolean;
  /**
   * 버튼에 쓰는 글자 — **주어는 고정(`하이라이트`)이고 뒤에 상태(`ON`/`OFF`)만 붙는다**.
   *
   * ⚠️ 예전엔 `✨ 하이라이트`(켜짐) / `▶ 전체 보기`(꺼짐)였다. 주어가 상태마다 **바뀌면서**
   * `aria-pressed` 와 의미축이 갈렸다(독립검증 N5): 꺼진 상태의 이름이 `전체 보기` 인데
   * `aria-pressed=false` 라, 스크린리더는 *"전체 보기, 안 눌림"* 이라고 읽는데 화면은 실제로
   * **전체 보기 중**이었다. 시각 사용자에게도 그 글자는 상태가 아니라 **액션**으로 읽혔다.
   * 지금은 `auto-mode.autoCopy`(`오토 ON`/`오토 OFF` + `aria-pressed`)와 **같은 모양**이다 —
   * 주어 고정 + 상태 표기 + `aria-pressed` 가 한 축을 가리킨다.
   */
  label: string;
  /** title — 누르면 **뭐가 달라지나**(`auto-mode` 규칙). **접근성 이름이 아니다**(아래 `pressed` 주석). */
  hint: string;
  /**
   * 하이라이트 모드가 켜져 있나 = `aria-pressed`.
   *
   * ⚠️ 이 값이 `aria-pressed` 로 나가므로 **`label` 의 주어와 같은 것**을 가리켜야 한다.
   * 그리고 버튼의 접근성 이름은 **고정**이어야 한다(`aria-label="하이라이트 모드"`) — `hint`
   * 를 이름으로 쓰면 이름이 액션 문장이 되어 `aria-pressed`(상태)와 또 갈린다.
   */
  pressed: boolean;
  /** 지금 재생 중인 하이라이트(`#2 · 48' HOME GOAL`). 없으면 null. */
  status: string | null;
}

const TOGGLE_HIDDEN: HighlightToggleView = {
  visible: false,
  label: "",
  hint: "",
  pressed: false,
  status: null,
};

export interface HighlightToggleInput {
  available: boolean;
  enabled: boolean;
  /** 지금 재생 중인 장면(없으면 null). */
  scene?: Scene | null;
  /** 그 장면의 1-based 번호. */
  index?: number;
  /** 상한 안에서 지금까지 잡힌 장면 수. */
  total?: number;
}

/**
 * 토글 버튼의 화면 상태.
 *
 * **전체 재생으로 돌아갈 길이 반드시 있어야 한다** — 하이라이트만 보면 경기를 못 본 셈이 된다.
 * 그래서 이 토글은 하이라이트를 켤 수 있는 화면이면 **항상** 보인다(장면이 0개여도 보인다 —
 * 아직 안 나온 것이지 기능이 없는 게 아니고, 그때 사라지면 유저는 켜 둔 모드를 끌 수 없다).
 */
export function highlightToggleView(input: HighlightToggleInput): HighlightToggleView {
  if (!input.available) return TOGGLE_HIDDEN;
  const total = input.total ?? 0;
  const scene = input.scene ?? null;
  const index = input.index ?? 0;
  return {
    visible: true,
    label: input.enabled ? "✨ 하이라이트 ON" : "✨ 하이라이트 OFF",
    hint: input.enabled
      ? "골·유효슛·세이브 장면만 순서대로 봅니다. 누르면 전체 재생으로 돌아갑니다."
      : "경기를 처음부터 전부 재생합니다. 누르면 주요 장면만 순서대로 봅니다.",
    pressed: input.enabled,
    status:
      input.enabled && scene && index > 0
        ? `#${index}${total > 0 ? `/${total}` : ""} · ${scene.label}`
        : null,
  };
}
