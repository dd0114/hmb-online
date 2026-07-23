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
  fx(): unknown[];
  surgeTicks(): number[];
  cardMarks(): unknown[];
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
  hooks: ViewerHooks;
}

/**
 * 캔버스에 관전 렌더 엔진을 마운트한다. `chrome` 콜백으로 DOM 크롬을 호스트가 소유한다.
 * 사용: `const v = createViewer(canvas, chrome); v.setSkin(skins); v.load(log); v.start();`
 */
export const createViewer: (canvas: HTMLCanvasElement, chrome?: ViewerChrome) => ViewerController =
  (impl as unknown as { createViewer: (c: HTMLCanvasElement, ch?: ViewerChrome) => ViewerController })
    .createViewer;
