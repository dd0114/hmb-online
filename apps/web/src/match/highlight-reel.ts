/**
 * 하이라이트 시퀀서 — "주요 장면"만 골라 순서대로 재생하기 위한 **순수 모듈** (#421 W3).
 *
 * 요구(hero): 후반 입력 후 디폴트 경기 화면은 전체 재생이 아니라 **하이라이트 #1부터 주요 장면
 * 순**이다. 주요 장면 = **골 · 유효슈팅 · 세이브**.
 *
 * React·DOM·API 의존 0 — 배선(뷰어 구동)은 후속 웨이브가 한다. 이 파일은 "무엇이 장면이고,
 * 어느 순서로, 어느 구간을 보여주는가"만 소유한다.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ① 왜 `timeline-pins.kindOf` 를 그대로 쓰면 안 되는가 (#421 W0-3)
 *
 * 엔진은 슛 하나에 이벤트를 **둘** 낸다 — **발사** `shot`(playerId·xg 있음, detail 은 없거나
 * `one_on_one`)과 **도착 결과마커**(빗나감 `shot detail:"off_target"`(playerId 없음) / 선방
 * `shot detail:"saved"` + 같은 틱 `save`(GK) / 골은 결과마커 shot 없이 `goal`).
 *
 * `timeline-pins.kindOf` 는 `shot && detail !== "off_target"` 이라 **발사 이벤트 전부**가
 * `shot_on` 핀이 된다. 타임라인 핀(=QA 가 집어서 되돌려 볼 자리)으로는 그게 의도지만,
 * "유효슈팅 장면"으로 재생하면 **빗나간 슛까지 하이라이트**가 된다(fixture-real 실측 38핀 vs
 * 실제 유효슛 10). 그래서 **필터는 이 모듈 안에서 자체 정의**한다.
 * `timeline-pins.ts` 는 고치지 않는다 — #406 의 표본 가정과 얽혀 있다.
 *
 * 유효슛 정의는 집계 SoT(`packages/viewer-core/src/stats.impl.mjs` `liveEventStats`)와 **같은 축**이다:
 * `goal` 이 `onTarget++`, `shot detail:"saved"` 가 `onTarget++`, 발사 `shot` 은 `shots++`.
 * ⇒ **장면 = `goal` ∪ `shot(detail==="saved")` ∪ `save`**.
 *
 * ② 그런데 **핀 자료구조와 `buildTimelinePins` 자체는 재사용한다**(재발명 금지, #57).
 * 이벤트를 먼저 장면으로 거른 뒤 그 목록을 `buildTimelinePins` 에 넘겨 `kind·clock·label` 을
 * 받아온다 — 라벨 문구와 시각 표기(#388: 로그가 구운 `minute` 이 SoT, 틱 직독 금지)가
 * 타임라인 핀과 **한 글자도 갈라지지 않게** 하려는 것이다. 화면 두 곳이 같은 장면을 다르게
 * 부르면 그게 곧 다음 버그다.
 *
 * ③ 리드인/리드아웃 상수의 SoT 는 `packages/viewer-core/src/playback.mjs` 의
 * `PACE.HL_PRE`(8) / `PACE.HL_POST`(3) 다 — 뷰어 연출(슬로우+줌) 창과 같은 값이라야 장면 앞뒤가
 * 연출과 맞물린다. **여기서 다시 입력하지 않는다**: 아래 상수는 그 값을 그대로 옮긴 것이고,
 * `highlight-reel.test.ts` 가 `@hmb/viewer-core/playback` 의 실제 `PACE` 와 대조해 드리프트를
 * 계약으로 막는다. (소스에서 직접 import 하지 않는 이유는 apps/web 의 tsconfig paths·vite alias 에
 * 서브패스 별칭이 없어서다 — 그 두 파일은 이 웨이브의 소유 밖이라 건드리지 않는다. 별칭이
 * 추가되면 아래 두 줄을 import 로 바꾸면 된다.)
 *
 * ④ **라이브 게이트와 양립**(#233/#238 스포일러 계약). 하프 로그는 창이 열리는 순간 **전량**
 * 클라에 온다 — 미래 장면이 자료에는 있다. 서버 권위 시계가 잡은 상한(`liveTick`)을 넘는 장면은
 * **내주지 않는다**. "따라잡으면 다음 장면이 생길 때까지 없음(null)"이 정상 동작이다.
 */

import { buildTimelinePins, type PinEventLike, type TimelinePin } from "./timeline-pins";

/** 장면 앞 리드인(틱). SoT = `viewer-core/src/playback.mjs` `PACE.HL_PRE`(위 ③). */
export const SCENE_LEAD_IN_TICKS = 8;
/** 장면 뒤 리드아웃(틱). SoT = `viewer-core/src/playback.mjs` `PACE.HL_POST`(위 ③). 앞보다 짧다(#83). */
export const SCENE_LEAD_OUT_TICKS = 3;

/**
 * 같은 장면으로 볼 틱 간격(기본값).
 *
 * 선방은 **같은 틱에 이벤트가 둘**이다(`shot detail:"saved"` + `save`) — 실측으로 정확히 같은 틱이라
 * 기본 1(같은 틱 또는 바로 옆 틱)이면 충분하다. 더 넓히면 서로 **다른 순간**(예: 선방 직후의 별개
 * 슛)이 조용히 하나로 삼켜져 하이라이트가 사라진다. 넓혀야 할 근거가 생기면 opts 로 넘겨라.
 */
export const SCENE_MERGE_TICKS = 1;

export type SceneKind = "goal" | "shot_on" | "save";

/** 하이라이트 한 장면. `clock`·`label` 은 타임라인 핀과 같은 규칙으로 만들어진다(위 ②). */
export interface Scene {
  /** 점프 대상 틱(= 게임초). */
  tick: number;
  kind: SceneKind;
  /** 표기 분(`48'`) — 로그가 구운 `minute` (#388). */
  clock: string;
  /** 툴팁·자막 문구(`48' · AWAY GOAL`). */
  label: string;
  /**
   * 이벤트가 말하는 팀.
   * ⚠️ **`save` 장면은 막은 쪽(GK 팀)이다** — 찬 쪽이 아니다. 선방 병합에서 대표로 남는 것이
   * `save` 이벤트이기 때문이고(우선순위는 아래 `PRIORITY`), 그게 "누가 선방했나"라는 장면의
   * 의미와도 맞는다. 찬 팀이 필요하면 `shot detail:"saved"` 를 따로 봐야 한다.
   */
  team?: string;
  /** 이벤트 주체(골=득점자, 세이브=GK). 결과마커 `shot detail:"saved"` 에는 없다. */
  playerId?: string;
}

/** 이 모듈이 읽는 이벤트 모양 — 핀과 같은 필드 + `playerId`. */
export interface ReelEventLike extends PinEventLike {
  playerId?: string;
}

export interface HighlightReelOptions {
  /**
   * 라이브 재생 상한(포함). 서버 권위 시계가 정한 "지금 어디까지 보여도 되는가"다
   * (`live-clock.liveGate().liveTick`). 이 틱을 **넘는** 장면은 목록에 들어가지 않는다.
   * 생략하면 상한 없음(다시보기·종료된 경기).
   */
  liveTick?: number;
  /** 같은 장면 병합 창(틱). 기본 {@link SCENE_MERGE_TICKS}. */
  mergeWindowTicks?: number;
}

/**
 * 장면 우선순위 — 병합에서 살아남는 순서. `timeline-pins` 의 핀 z(골 5 > 선방 3 > 유효슛 2)와
 * 같은 서열이다. 선방 한 장면이 `shot_on` + `save` 두 이벤트로 오면 **`save` 가 대표**로 남는다
 * (그쪽에 GK `playerId` 가 실려 있고, 관객이 보는 것도 "선방"이다).
 */
const PRIORITY: Record<SceneKind, number> = { goal: 3, save: 2, shot_on: 1 };

/**
 * 주요 장면인가 — **결과마커만** 본다(발사 `shot` 은 아니다, 위 ①).
 *
 * - `goal`                       → 골
 * - `shot` + `detail === "saved"` → 유효슛(선방된 슛의 도착 마커)
 * - `save`                       → 세이브(GK)
 *
 * ⚠️ `shot detail:"one_on_one"` 은 **발사**다(결과가 아니다) — 여기 들어오면 빗나간 일대일까지
 * 하이라이트가 된다.
 */
export function isSceneEvent(e: ReelEventLike | null | undefined): boolean {
  if (!e) return false;
  if (e.type === "goal") return true;
  if (e.type === "save") return true;
  return e.type === "shot" && e.detail === "saved";
}

function sceneKindOf(e: ReelEventLike): SceneKind | null {
  if (e.type === "goal") return "goal";
  if (e.type === "save") return "save";
  if (e.type === "shot" && e.detail === "saved") return "shot_on";
  return null;
}

/**
 * 이벤트 목록 → 하이라이트 장면 목록. **시각 순 정렬 + 중복 병합 + 라이브 상한**까지 끝난 결과다.
 *
 * 하이라이트 #1 = `scenes[0]`. 이후 진행은 {@link nextSceneAfter} 로 잇는다.
 */
export function buildHighlightReel(
  events: readonly ReelEventLike[] | null | undefined,
  opts: HighlightReelOptions = {},
): Scene[] {
  if (!events || events.length === 0) return [];
  const cap = opts.liveTick;
  const hasCap = typeof cap === "number" && Number.isFinite(cap);

  // ⚠️ 상한은 **병합 전에** 건다. 병합 뒤에 걸면 대표로 뽑힌 이벤트만 잘려 나가 같은 장면이
  //    통째로 사라지거나(대표가 미래) 남은 조각이 다시 대표가 되어 라벨이 흔들린다.
  const src = events.filter(
    (e) =>
      isSceneEvent(e) &&
      typeof e.tick === "number" &&
      Number.isFinite(e.tick) &&
      e.tick >= 0 &&
      (!hasCap || e.tick <= (cap as number)),
  );
  if (src.length === 0) return [];

  // 핀 생성기를 그대로 쓴다(위 ②). `idxOfTick` 은 항등, `snapCount` 는 상한+1 — 여기서 쓰는 것은
  // `kind·clock·label` 뿐이고 `pct` 는 버린다(장면 목록은 타임라인 좌표가 아니다). 핀 쪽 근접
  // 병합은 **끄고**(minGapPct 0) 아래에서 **틱 기준**으로 다시 묶는다 — 장면의 의미는 픽셀
  // 간격이 아니라 "같은 순간인가"라서다.
  const maxTick = src.reduce((m, e) => Math.max(m, e.tick), 0);
  const pins = buildTimelinePins(src, (t) => t, Math.max(2, maxTick + 1), 0);
  const byKey = new Map<string, TimelinePin>();
  for (const p of pins) {
    const key = `${p.tick}:${p.kind}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }

  const scenes: Scene[] = [];
  for (const e of src) {
    const kind = sceneKindOf(e);
    if (!kind) continue;
    const pin = byKey.get(`${e.tick}:${kind}`);
    if (!pin) continue; // 핀 생성기가 거른 이벤트 — 규칙을 두 벌로 갖지 않는다.
    scenes.push({
      tick: e.tick,
      kind,
      clock: pin.clock,
      label: pin.label,
      ...(e.team !== undefined ? { team: e.team } : {}),
      ...(e.playerId !== undefined ? { playerId: e.playerId } : {}),
    });
  }

  scenes.sort((a, b) => a.tick - b.tick || PRIORITY[b.kind] - PRIORITY[a.kind]);
  const window = opts.mergeWindowTicks ?? SCENE_MERGE_TICKS;
  return mergeAdjacent(scenes, window);
}

/**
 * 같은 순간의 장면을 하나로 — 뭉치 안에서 우선순위가 가장 높은 것, 같으면 먼저 일어난 것을 남긴다
 * (`timeline-pins.dedupeClusters` 와 같은 규칙, 축만 pct → 틱).
 */
function mergeAdjacent(sorted: readonly Scene[], windowTicks: number): Scene[] {
  if (windowTicks <= 0 || sorted.length <= 1) return [...sorted];
  const out: Scene[] = [];
  let cluster: Scene[] = [];
  const flush = () => {
    if (cluster.length === 0) return;
    const best = cluster.reduce((a, b) =>
      PRIORITY[b.kind] > PRIORITY[a.kind] || (PRIORITY[b.kind] === PRIORITY[a.kind] && b.tick < a.tick) ? b : a,
    );
    out.push(best);
    cluster = [];
  };
  for (const s of sorted) {
    const prev = cluster[cluster.length - 1];
    if (prev && s.tick - prev.tick > windowTicks) flush();
    cluster.push(s);
  }
  flush();
  return out;
}

/**
 * `tick` **다음** 장면. 없으면 `null`.
 *
 * - 하이라이트 #1 = `nextSceneAfter(scenes, -1)`(틱은 0 이상이므로 항상 첫 장면).
 * - `liveTick` 을 주면 그 상한을 **한 번 더** 건다. `buildHighlightReel` 에서 이미 걸었더라도,
 *   화면은 목록을 캐시해 두고 시계만 흐르는 구조라(로그는 창이 열릴 때 전량 온다) 여기서 다시
 *   막지 않으면 **캐시된 미래 장면이 새어 나간다**. "따라잡으면 null" 이 정상이다.
 */
export function nextSceneAfter(
  scenes: readonly Scene[] | null | undefined,
  tick: number,
  opts: { liveTick?: number } = {},
): Scene | null {
  if (!scenes || scenes.length === 0) return null;
  const cap = opts.liveTick;
  const hasCap = typeof cap === "number" && Number.isFinite(cap);
  for (const s of scenes) {
    if (s.tick <= tick) continue;
    if (hasCap && s.tick > (cap as number)) return null; // 정렬돼 있으므로 여기서 끝
    return s;
  }
  return null;
}

/**
 * 장면 재생 구간 — 리드인/리드아웃(위 ③).
 *
 * 구동은 후속 웨이브가 기존 컨트롤러 API 로만 한다: `v.jumpToTick(scene.tick)` 은 스냅샷 3개를
 * 되감아 착지하므로 리드인이 사실상 공짜고(`viewer.impl.mjs`), 정확한 구간이 필요하면
 * `jumpToTick(fromTick)` 을 쓴다. (`jumpEvent` 는 ±2틱 가드가 있어 장면 구동에 부적합하다.)
 *
 * `liveTick` 을 주면 `toTick` 을 그 상한으로 자른다 — 장면 자체는 이미 일어났어도 **꼬리가 아직
 * 미래**일 수 있고, 그 앞서보기는 라이브 게이트(`clampSeek`)가 어차피 되돌린다.
 */
export function sceneWindow(
  scene: Scene,
  opts: { liveTick?: number } = {},
): { fromTick: number; toTick: number } {
  const fromTick = Math.max(0, scene.tick - SCENE_LEAD_IN_TICKS);
  let toTick = scene.tick + SCENE_LEAD_OUT_TICKS;
  const cap = opts.liveTick;
  if (typeof cap === "number" && Number.isFinite(cap)) toTick = Math.min(toTick, Math.max(scene.tick, cap));
  return { fromTick, toTick };
}
