/**
 * 관전 렌더 코어 — 타입 표면. 런타임은 **`./viewer.impl.mjs`**(createViewer) 가 원본이다.
 * web(React)·QA(dev-viewer 셸) 가 이 타입으로 코어를 마운트한다(stats.ts↔stats.impl.mjs 패턴).
 *
 * P4-D3 S3: apps/web 이 iframe 없이 이 코어를 직접 마운트한다(브리지·문자열 치환 파이프라인 제거).
 */
// plain ESM(JSDoc) 런타임. allowJs 로 로드, 아래에서 타입을 입혀 재수출.
import * as impl from "./viewer.impl.mjs";

/** 코어가 프레임/이벤트마다 호출하는 호스트 DOM 갱신 콜백(전부 선택). */
export interface ViewerChrome {
  /** 원시 플레이헤드 틱(게임초) — 호스트가 통계/로그/시계 "지금까지"를 계산. */
  onTick?(tick: number): void;
  /** 골 거대 자막(#flash 상당). */
  onBigCaption?(text: string, color: string): void;
  /** 상황 카드(선방/빗나감/파울/오프사이드/PK). */
  onSituation?(text: string, color: string): void;
  /** 상황 배너(프레임별, text=null 이면 숨김). */
  onBanner?(text: string | null, color: string | null): void;
  /** 모든 자막 즉시 정리. */
  onClearCaptions?(): void;
  onScore?(home: number, away: number): void;
  onMinute?(mmss: string): void;
  onClock?(text: string): void;
  onScrub?(pct: number): void;
  onHud?(data: {
    home: unknown;
    away: unknown;
    possHome: number;
    momentum: number;
  }): void;
  onPlaying?(playing: boolean): void;
  onLoaded?(info: { events: unknown[]; snapCount: number; statusText: string }): void;
  onStatus?(text: string): void;
}

/** window.__viewer 읽기 표면(계약검증·QA 훅). captions 는 호스트가 DOM 에서 제공. */
export interface ViewerHooks {
  ready(): boolean;
  events(): unknown[];
  seek(tick: number): void;
  play(): void;
  pause(): void;
  autoPace(on: boolean): void;
  showSituationAt(tick: number): void;
  cur(): { tick: number; [k: string]: unknown };
  render(): unknown;
  renderAt(tp: number): unknown;
  screenGeom(): unknown;
  renderPlayersAt(tp: number): unknown[];
  curPlayers(): unknown[];
  trail(): unknown[];
  playerTrailAt(tick: number): unknown[];
  /** 살아 있는 행동 이펙트 + **실제로 그린** 기하(`r`·`tip`·`slashL`, #406 W5). */
  fx(): unknown[];
  /** 행동 이펙트 **그리기만** on/off(스폰·감쇠 무영향) — 가시성 하한 계약용(#406 W5). */
  setFxLayer(on: boolean): void;
  fxLayer(): boolean;
  /** 상태를 바꾸지 않고 현재 상태를 다시 그린다(seek/renderAt 과 달리 정지 시퀀스를 리셋하지 않음). */
  redraw(): void;
  /** 공 따라가기(팔로우 줌, 토큰 R=11) — 계약이 **실사용 기하**를 재현할 수 있게(#406 MAJOR-1). */
  setFollow(on: boolean): void;
  follow(): boolean;
  surgeTicks(): number[];
  cardMarks(): unknown[];
  /** 이 프레임에 그려진 토스트(앵커 계약 검증용, #324). */
  toasts(): unknown[];
  liveStats(): { tick: number; [k: string]: unknown };
  trailAt(tick: number): unknown[];
  cam(): { cx: number; cy: number; zoom: number };
  viewMode(): string;
  setViewMode(m: string): void;
  fixZoom(): number;
  setFixZoom(z: number): number;
  idxOfTick(tick: number): number;
  setSkin(payload: unknown): void;
  skinReady(): boolean;
  /** 선수 하이라이트 주입(#406 W4). `team` 은 필수 — 같은 playerId 가 양 팀에 있다(#324). */
  setSelection(list: PlayerSelectionInput[] | PlayerSelectionInput | null): void;
  /** 이 프레임에 **실제로 그린** 선택 링(주입값이 아니라 렌더 결과). */
  selection(): DrawnSelection[];
}

/** 코어에 넘기는 선택 항목(#406 W4). */
export interface PlayerSelectionInput {
  /** **필수** — 없으면 그 항목은 무시된다(fail-closed: 반대 팀을 켜느니 안 켠다). */
  team: "home" | "away";
  playerId: string;
  /**
   * 내 팀 선수인가(스타일 축) — **3값**. 판정은 부모 몫이다(코어는 유저를 모른다).
   * `true` 흰 굵은 링 / `false` 슬레이트 실선 / **`null`·미지정 = 점선**(모른다, #406 W6 m6).
   */
  mine?: boolean | null;
  /** 이름표 문구. 없으면 코어가 실제로 그린 등번호(`#7`)로 떨어진다. */
  label?: string | null;
}

/** `hooks.selection()` 이 돌려주는, 그려진 링 하나. */
export interface DrawnSelection {
  id: string;
  team: "home" | "away";
  /** 3값 그대로 나온다 — `null` = 모른다(점선 링). 접으면 "모른다"가 "상대"로 읽힌다. */
  mine: boolean | null;
  /** 그린 링 반경(px). 맥동하므로 프레임마다 조금씩 다르다 — 층 관계(> R+6)는 항상 참. */
  r: number;
  label: string | null;
  px: number;
  py: number;
}

/** createViewer 반환 컨트롤러 — 마운트/재생/컨트롤 + 읽기 훅. */
export interface ViewerController {
  start(): void;
  stop(): void;
  load(log: unknown): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  restart(): void;
  scrubTo(pct: number | string): void;
  jumpToTick(tick: number): void;
  jumpEvent(type: string, dir: number): void;
  setFollow(on: boolean): void;
  setTrail(on: boolean): void;
  setAutoPace(on: boolean): void;
  setSpeed(n: number | string): void;
  setViewMode(m: string): void;
  setFixZoom(z: number): number;
  setSkin(payload: unknown): void;
  /** 선수 하이라이트(#406 W4) — 컨트롤러 표면(호스트가 상태를 소유하고 프레임마다 밀어 넣는다). */
  setSelection(list: PlayerSelectionInput[] | PlayerSelectionInput | null): void;
  hooks: ViewerHooks;
}

/**
 * 캔버스에 관전 렌더 엔진을 마운트한다. `chrome` 콜백으로 DOM 크롬을 호스트가 소유한다.
 * 사용: `const v = createViewer(canvas, chrome); v.setSkin(skins); v.load(log); v.start();`
 */
export const createViewer: (canvas: HTMLCanvasElement, chrome?: ViewerChrome) => ViewerController =
  (impl as unknown as { createViewer: (c: HTMLCanvasElement, ch?: ViewerChrome) => ViewerController })
    .createViewer;
