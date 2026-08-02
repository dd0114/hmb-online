/**
 * 경기 흐름 브릿지 — **순수 규칙** (#424 W1).
 *
 * 설계 SoT = `docs/plan-v5/match-flow-bridge.md`. 이 파일이 지키는 핵심 셋:
 *
 *  1. **브릿지는 상태가 아니라 _전이_ 에 붙는다**(`bridgeForTransition`). 상태만 보고 열면
 *     새로고침·`FINISHED` 재입장에 브릿지가 다시 뜬다 — 전이표가 그 결함을 **구조적으로** 막는다.
 *  2. **내용은 현재 상태가 정한다**(`bridgeCardModel`). 열림 시점에 문자열을 굳히면 감독시간이
 *     만료된 뒤에도 카드가 `이제 감독시간입니다` 라고 거짓말한다.
 *  3. **두 소스(스킵 응답 / 전이 관측)가 하나의 큐로 합쳐진다**(`enqueueBridge`·`mergeBridge`).
 *     React Query 훅 `onSuccess` 와 mutate 콜백 `onSuccess` 의 **순서에 의존하지 않는다**.
 *
 * React·DOM·API 의존 0(타입만) → vitest 로 계약을 박는다(`skip-mode.ts`·`auto-mode.ts` 선례).
 */
import type { ReactNode } from "react";
import type { MatchDetail } from "../../api/hooks";
import type { ScorePair } from "../match-logic";
import { FLOW_COPY, FLOW_STEPS, type FlowStepId } from "./flow-copy";

// ── 종류(키) ───────────────────────────────────────────────────────────

export type BridgeKind = "match_start" | "h1_end" | "h2_start" | "match_end";
export type BeatKind = "kickoff_h1" | "kickoff_h2";

/**
 * 브릿지의 **형태**.
 *  · `panel`  = 이미 있는 대기 화면(`GenWaitPanel`)의 승격. **오버레이 큐에 안 들어간다** —
 *               덮으면 그 화면의 경과 시계·[경기 포기](#217 AC3)가 가려진다.
 *  · `overlay`= 종료형 카드. 큐에 들어가고 유저 버튼으로 닫는다.
 */
export type BridgeForm = "panel" | "overlay";

/** 오버레이 큐에 들어가는 종류만 따로 좁힌다(타입이 §6.3 표를 강제한다). */
export type OverlayBridgeKind = Extract<BridgeKind, "h1_end" | "match_end">;

export interface BridgeSignal {
  kind: BridgeKind;
  form: BridgeForm;
}

/**
 * 전이표 (설계 §4 확정표 · §6.3).
 *
 * ⚠️ **`from`·`to` 가 둘 다 배열인 이유는 같다 — 관측이 중간 상태를 건너뛴다.**
 *  · `to` 가 넓은 이유 = **오토 모드(#249)**. 서버가 감독시간을 0초로 열고 같은 스윕에서 후반까지
 *    잇기 때문에 `FIRST_HALF` 다음 관측 상태가 `HALFTIME` 이 아니라 `GEN2`/`SECOND_HALF` 일 수 있다.
 *    여기서 그 타겟을 빼면 **오토 유저는 전반 종료 브릿지를 영영 못 본다**.
 *  · `from` 이 넓은 이유 = **`FINISHED` 로 들어오는 문이 `SECOND_HALF` 하나가 아니다.** 시계 롤백
 *    경로에서 `enterSecondHalf` 가 `finishMatch(..., S_GEN2)` 를 태우면 관측되는 전이는
 *    **`GEN2 → FINISHED`** 이고, 탭이 후반 창 내내 백그라운드였다가 돌아오면 중간 상태를 아예 못 보고
 *    `FIRST_HALF`/`HALFTIME` 에서 곧바로 `FINISHED` 가 관측된다. `from` 을 하나로 두면 그 경로에서
 *    **경기 종료 브릿지가 안 뜬다 = AC4 의 네 번째 지점이 소실**된다(독립검증 N3).
 *    → B2 를 `to` 로 넓힌 것과 **같은 논리**를 B4 의 `from` 에 적용한다.
 *
 * ⚠️ **`BRIEFING`·`GEN1` 도 같은 이유로 들어 있다**(W6 에서 정정). 한때 여기엔 *"거기서 `FINISHED`
 * 로 가는 전이는 실재한다(상대가 브리핑에서 무른 **몰수** — 0:0, 재생할 하프가 없다)"* 라고 적혀
 * 있었는데 **거짓이었다**. 서버 실측:
 *  · `state='FINISHED'` 를 쓰는 곳은 `MatchOrchestrator.java:786,793`(둘 다 `finishMatch`) **뿐**이고,
 *    그 `fromState` 는 `GEN2`(시계 롤백 — `enterSecondHalf`:731) 또는 `SECOND_HALF`(재생 창 만료 —
 *    `settleFinishedIfDue`:757) **둘뿐**이다.
 *  · **몰수·포기는 `ABANDONED`** 로 간다(`MatchLockService.java:246,310`). `to` 가 `FINISHED` 하나이므로
 *    몰수는 애초에 이 표에 닿지 않는다.
 * ⇒ 클라가 `BRIEFING`/`GEN1 → FINISHED` 를 보는 **유일한** 경로는 오토 모드 + 탭이 경기 내내
 *   백그라운드(React Query 가 hidden 에서 폴링을 멈춘다)다 = `HALFTIME`/`FIRST_HALF` 를 넣은 것과
 *   **정확히 같은 부류**(관측을 건너뛴 것). 자기 기준을 지키려면 넣어야 한다.
 *
 * ⚠️ **그래서 `90분이 끝났습니다` 도 거짓말이 아니다.** `FINISHED` 는 구조적으로 두 하프 시뮬을
 * 마친 상태에서만 도달한다(위 두 경로 뿐 — 몰수는 `ABANDONED`). 즉 문구의 참을 **상태가 보증**하므로
 * (설계 P7 "내용은 상태가 정한다") `from` 별 변종 문구가 필요 없다. 넓히는 기준은 여전히 "관측을
 * 건너뛴 것"이지 "전이가 있는 것"이 아니다 — `to: ["FINISHED"]` 가 그 경계를 지킨다.
 */
const BRIDGE_TABLE: ReadonlyArray<{
  from: readonly string[];
  to: readonly string[];
  kind: BridgeKind;
  form: BridgeForm;
}> = [
  { from: ["BRIEFING"], to: ["GEN1"], kind: "match_start", form: "panel" },
  {
    from: ["FIRST_HALF"],
    to: ["HALFTIME", "H1_BREAK", "GEN2", "SECOND_HALF"],
    kind: "h1_end",
    form: "overlay",
  },
  { from: ["HALFTIME"], to: ["GEN2"], kind: "h2_start", form: "panel" },
  // 레거시 상태명(P4 이전 배포본의 진행 중 매치) — `panelForState` 가 같이 취급한다.
  { from: ["H1_BREAK"], to: ["GEN2"], kind: "h2_start", form: "panel" },
  {
    from: ["SECOND_HALF", "GEN2", "HALFTIME", "H1_BREAK", "FIRST_HALF", "GEN1", "BRIEFING"],
    to: ["FINISHED"],
    kind: "match_end",
    form: "overlay",
  },
];

const BEAT_TABLE: ReadonlyArray<{ from: string; to: string; beat: BeatKind }> = [
  { from: "GEN1", to: "FIRST_HALF", beat: "kickoff_h1" },
  { from: "GEN2", to: "SECOND_HALF", beat: "kickoff_h2" },
];

/**
 * 이 전이가 브릿지를 여는가.
 *
 * ⚠️ **`prev == null`(첫 관측)에서는 절대 열지 않는다.** 이것이 "새로고침·재입장에 브릿지가 다시
 * 뜨지 않는다"의 구조적 보장이다 — 플래그 저장소가 필요 없다. `FINISHED` 매치를 나중에 다시 열어도
 * B4 가 안 뜬다(이미 본 경기이므로 옳다).
 */
export function bridgeForTransition(
  prev: string | null | undefined,
  next: string | null | undefined,
): BridgeSignal | null {
  if (prev == null || next == null || prev === next) return null;
  const row = BRIDGE_TABLE.find((r) => r.from.includes(prev) && r.to.includes(next));
  return row ? { kind: row.kind, form: row.form } : null;
}

/** 킥오프 비트(B1·B3 의 끝맺음 표현). 같은 첫 관측 규칙을 따른다. */
export function beatForTransition(
  prev: string | null | undefined,
  next: string | null | undefined,
): BeatKind | null {
  if (prev == null || next == null || prev === next) return null;
  return BEAT_TABLE.find((r) => r.from === prev && r.to === next)?.beat ?? null;
}

export function isOverlayKind(kind: BridgeKind): kind is OverlayBridgeKind {
  return kind === "h1_end" || kind === "match_end";
}

// ── 큐 · 중복 제거 · 병합 ──────────────────────────────────────────────

export interface QueuedBridge {
  kind: OverlayBridgeKind;
  /**
   * 앞에 붙는 **스킵 리포트가 말하는 하프**. `null` 이면 리포트 없음(=스킵하지 않고 창이 만료됐다).
   * 이 값이 곧 `viaSkip` 의 근거다 — 별도 플래그를 두면 두 축이 어긋난다.
   */
  report: 1 | 2 | null;
}

/**
 * 같은 종류의 두 신호를 합친다 — **리포트는 있는 쪽이 이긴다**.
 *
 * ⚠️ 순수 함수로 둔 이유(설계 §6.2): 인라인으로 쓰면 "이미 열려 있으면 무시"로 축소되기 쉽고,
 * 그 순간 **스킵 신호가 전이 관측보다 늦게 오는 경로에서 리포트가 통째로 사라진다**. React Query 는
 * 훅 옵션 `onSuccess` → mutate 콜백 `onSuccess` 순서라 그 경로가 실제로 존재한다.
 */
export function mergeBridge(existing: QueuedBridge, incoming: QueuedBridge): QueuedBridge {
  if (existing.kind !== incoming.kind) return existing;
  return { kind: existing.kind, report: existing.report ?? incoming.report };
}

/**
 * 큐에 넣는다. 규칙(설계 §6.2):
 *  · 이미 **소비된**(닫은) 종류면 무시 — 폴링이 같은 브릿지를 다시 열지 않는다.
 *  · 이미 큐에 있으면 **병합**(카드 스택이 두 벌 생기지 않는다).
 *  · 아니면 뒤에 붙인다(종료형이 두 개 쌓이는 경우 = B2 를 안 닫은 채 경기가 끝난 흐름).
 */
export function enqueueBridge(
  queue: readonly QueuedBridge[],
  seen: readonly OverlayBridgeKind[],
  incoming: QueuedBridge,
): QueuedBridge[] {
  if (seen.includes(incoming.kind)) return [...queue];
  const at = queue.findIndex((q) => q.kind === incoming.kind);
  if (at < 0) return [...queue, incoming];
  const next = [...queue];
  next[at] = mergeBridge(queue[at]!, incoming);
  return next;
}

// ── 카드 내용 (현재 상태 파생) ─────────────────────────────────────────

export interface BridgeCardContext {
  /** 지금 서버가 말하는 상태. **열림 시점이 아니라 매 렌더의 값**이다. */
  state: string | undefined;
  auto: boolean | undefined;
  /** `MatchDetail.result` 그대로("WIN"|"DRAW"|"LOSS"|null). */
  outcome: string | null | undefined;
  /** `countdownLabel` 이 만든 `분:초`. 시계가 없으면 null = 남은 시간을 말하지 않는다. */
  countdown?: string | null;
  /** #405 continuation 이 배선돼 있는가 — CTA 라벨이 갈린다(C2). */
  hasContinuation?: boolean;
}

export interface BridgeCardModel {
  kind: OverlayBridgeKind;
  kicker: string;
  title: string;
  body: string;
  /** 보조 줄(남은 감독시간). 없으면 null. */
  note: string | null;
  /** 다음 안내 줄. 없으면 null. */
  nextHint: string | null;
  cta: string;
}

/**
 * 브릿지 카드가 **지금** 말할 내용.
 *
 * ⚠️ 이 함수가 오토 모드 특수분기를 **0** 으로 만든다(설계 §4.4). 오토는 `HALFTIME` 이 0초라 B2 가
 * 뜬 직후 상태가 `GEN2`→`SECOND_HALF` 로 달려가는데, 내용이 상태 파생이므로 카드가 알아서 따라간다.
 * "오토면 B2+B3 를 병합한다" 같은 코드가 필요 없다.
 */
export function bridgeCardModel(kind: OverlayBridgeKind, ctx: BridgeCardContext): BridgeCardModel {
  if (kind === "match_end") {
    const c = FLOW_COPY.match_end;
    const key = ctx.outcome === "WIN" || ctx.outcome === "DRAW" || ctx.outcome === "LOSS" ? ctx.outcome : "unknown";
    return {
      kind,
      kicker: c.kicker,
      title: c.title,
      body: c.body[key]!,
      note: null,
      nextHint: c.nextHint,
      cta: ctx.hasContinuation ? c.cta.reward : c.cta.result,
    };
  }

  const c = FLOW_COPY.h1_end;
  const halftime = ctx.state === "HALFTIME" || ctx.state === "H1_BREAK";
  const variant = halftime
    ? ctx.auto === true
      ? c.halftimeAuto
      : c.halftime
    : ctx.state === "GEN2"
      ? c.gen2
      : ctx.state === "SECOND_HALF"
        ? c.secondHalf
        : ctx.state === "FINISHED"
          ? c.finished
          : c.fallback;
  // 남은 감독시간은 **감독시간을 실제로 쓰는 분기에서만** 말한다. 오토(0초)·이미 지나간 상태에
  // 남은 시간을 띄우면 유저가 없는 여유를 믿는다.
  const showCountdown = halftime && ctx.auto !== true && Boolean(ctx.countdown);
  return {
    kind,
    kicker: c.kicker,
    title: c.title,
    body: variant.body,
    note: showCountdown ? c.countdown(ctx.countdown!) : null,
    nextHint: null,
    cta: variant.cta,
  };
}

/**
 * 브릿지 카드 상단 스코어 줄이 쓸 값.
 *
 * 스킵 리포트가 붙은 스택에서는 **리포트가 로그에서 센 값**이 SoT 다(그쪽이 재생 지점과 맞는다).
 * 여기 값은 리포트가 없는 브릿지 전용 — 서버가 확정 스코어를 아직 안 줬으면 `null` 이고,
 * 그러면 **줄을 그리지 않는다**(0:0 을 지어내지 않는다).
 */
export function bridgeScore(kind: OverlayBridgeKind, match: MatchDetail | undefined): ScorePair | null {
  if (!match) return null;
  const [h, a] =
    kind === "match_end"
      ? [match.scoreHome, match.scoreAway]
      : [match.scoreH1Home, match.scoreH1Away];
  if (typeof h !== "number" || typeof a !== "number") return null;
  return { home: h, away: a };
}

// ── 스텝 모델 (대기형 브릿지의 "지금/다음") ────────────────────────────

export type FlowStepStatus = "done" | "current" | "upcoming";

export interface FlowStepView {
  id: FlowStepId;
  label: string;
  status: FlowStepStatus;
  /** 오토 모드의 `감독시간` — 흐림 + `건너뜀` 표기(스텝을 **제거하지 않는다**). */
  skipped: boolean;
}

const STATE_STEP: Record<string, FlowStepId> = {
  BRIEFING: "briefing",
  GEN1: "gen1",
  FIRST_HALF: "first_half",
  HALFTIME: "halftime",
  H1_BREAK: "halftime",
  GEN2: "gen2",
  SECOND_HALF: "second_half",
  FINISHED: "result",
};

/** 지금 서 있는 스텝. 모르는 상태(FAILED/ABANDONED/구 서버)는 null = 아무 스텝도 강조하지 않는다. */
export function stepOfState(state: string | undefined): FlowStepId | null {
  return state ? (STATE_STEP[state] ?? null) : null;
}

export function flowSteps(state: string | undefined, auto: boolean | undefined): FlowStepView[] {
  const cur = stepOfState(state);
  const curIndex = cur ? FLOW_STEPS.findIndex((s) => s.id === cur) : -1;
  return FLOW_STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    status: curIndex < 0 ? "upcoming" : i < curIndex ? "done" : i === curIndex ? "current" : "upcoming",
    skipped: s.id === "halftime" && auto === true,
  }));
}

/** 대기 화면의 "다음" 한 줄. 해당 없으면 null(문장을 지어내지 않는다). */
export function flowNextHint(state: string | undefined): string | null {
  return (state && FLOW_COPY.stepper.next[state]) ?? null;
}

// ── #405 보상 흐름 진입 계약 (설계 §9 — SoT 는 이 파일이다) ────────────

/** 경기 종료 브릿지가 후속 흐름에 넘기는 전부. 여기에 없는 것은 소비자가 스스로 조회한다. */
export interface MatchEndHandoff {
  /** 이 매치의 id — 소비자는 이것으로 자기 데이터를 조회한다(보상/성장은 #405 소관). */
  matchId: string;
  /** 항상 "FINISHED". 브릿지는 서버 상태를 앞지르지 않으므로 이 값이 곧 보증이다. */
  matchState: "FINISHED";
  /** 이 종료가 유저의 스킵으로 앞당겨졌나 — 연출 길이를 줄이는 판단에 쓸 수 있다. */
  viaSkip: boolean;
  /** 서버 확정 스코어(모르면 null). 소비자가 다시 조회할 필요를 줄이는 편의값이다. */
  score: ScorePair | null;
  /** "WIN" | "DRAW" | "LOSS" | null — `MatchDetail.result` 그대로. */
  outcome: string | null;
}

/**
 * 경기 종료 브릿지의 **다음 화면** 확장점.
 *
 * ⚠️ **현재 프로덕션 호출부는 0 이다**(W6 정정). #405 는 이 prop 이 아니라 **`StageShell` 이 소유한
 * `RewardSheet` + `!overlayOpen` 게이트**로 착지했다(브릿지가 앞, 닫으면 그 자리에서 시트 —
 * `e2e/p424-flow-bridge.spec.ts` ⑨). 그래도 이 타입·배선을 **지우지 않는다**: #405 에 공개한 계약이고,
 * C2(없어도 흐름이 완결된다)가 이 브랜치의 선배포 근거이며, "브릿지 CTA 뒤에 오버레이 안에서 뭔가를
 * 더 보여준다"는 확장점이 사라지면 다음 소비자가 라우트를 새로 파게 된다(C3 이 기각한 형태).
 *
 * · 넘기지 않으면 CTA 라벨은 `보상과 결과 보기` 이고, 누르면 오버레이가 닫혀 보상 시트(봉투 미확인
 *   시) → `FINISHED` 결과 탭이 보인다(C2).
 * · 넘기면 CTA 가 `보상 받기` 로 바뀌고, 누른 순간 **같은 오버레이 안에서** 이 노드가 렌더된다(C3).
 *   `onDone()` 을 부르면 오버레이가 닫히고 결과 탭으로 간다. `onDone` 은 **멱등**이다(C4).
 */
export type MatchEndContinuation = (handoff: MatchEndHandoff, onDone: () => void) => ReactNode;

export function matchEndHandoff(match: MatchDetail, viaSkip: boolean): MatchEndHandoff {
  return {
    matchId: match.id,
    matchState: "FINISHED",
    viaSkip,
    score: bridgeScore("match_end", match),
    outcome: match.result ?? null,
  };
}
