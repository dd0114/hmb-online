import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createViewer, type ViewerChrome, type ViewerController } from "@hmb/viewer-core";
import type { MatchClock } from "@hmb/shared";
import { liveGate } from "./live-clock";
import { driftAllowanceTicks, indexOfPlayhead, tickOfIndex } from "./live-pace";
import type { ControlMode } from "./playback-controls";
import { PlaybackControls, type SeekBarHandle } from "./PlaybackControls";
import { buildTimelinePins, type TimelinePin } from "./timeline-pins";
import { clampTick, indexFromPct, pctFromIndex } from "./qa-time-controls";
import {
  atLiveEdge,
  gatedTick,
  indexOfTick,
  isFutureIndex,
  policyOf,
  tickOfSnapIndex,
  withinTrack,
  type GatedSeek,
  type SeekPolicy,
} from "./seek-gate";
import { buildViewerSkins } from "./viewer-skins";
// #421 W4 하이라이트 순서 재생 — 판정은 순수 모듈, 구동은 이 훅, 표시는 이 부품(호출부엔 한 줄씩).
import { useHighlightSequencer } from "./useHighlightSequencer";
import { HighlightToggle } from "./HighlightToggle";
import type { Grade } from "../common/grades";
import { useCharAssets } from "../common/useCharAssets";
import styles from "./MatchViewer.module.css";

// 관전 캔버스 부품 — `MatchViewer.tsx` 에서 **파일만 분리**했다(#191, 동작 변경 0).
//
// 왜 뗐나: QA 콘솔(#191)이 같은 재생을 필요로 하는데, 이 부품은 이미 `log: unknown` 만 받고
// API 를 모른다 = 재사용 가능한 조각이 프로덕션 파일 안에 갇혀 있었다. 콘솔에 복사하면 자막·스킨·
// 타임라인 핀 배선이 이중화돼 갈라진다 → **게임화면과 QA 콘솔이 같은 부품을 공유**하도록 옮겼다
// (v6 "뷰어 SoT 수렴"의 연장). 게임 흐름 쪽 진입점은 `MatchViewer` 가 그대로 유지한다.

export interface VisualPlaybackProps {
  log: unknown;
  half: 1 | 2;
  onFallback: () => void;
  controlMode: ControlMode;
  canSwitch: boolean;
  /** 돌려보는 화면(#244) — 컨트롤을 무대에 겹치지 않고 아래로 흘리고, 유저용 레이아웃으로 그린다. */
  review?: boolean;
  onControlMode: (m: ControlMode) => void;
  onTick?: (tick: number) => void;
  clock: MatchClock | null;
  clockOffsetMs: number;
  /**
   * 아이콘 노출 정책(#285) 판정용 playerId→등급 표. **부모가 주입한다** — 이 부품은 API 를
   * 모르는 재사용 조각이라(위 주석) 여기서 카탈로그를 조회하면 QA 콘솔까지 쿼리 컨텍스트를
   * 요구하게 된다. 안 주면 `buildViewerSkins` 의 공용 디폴트 백스톱이 정책을 지킨다.
   */
  grades?: Record<string, Grade | undefined> | null;
  /**
   * 경기 스킵 버튼(#421) — **부품을 받기만 한다**(이 부품은 매치도 API 도 모르는 재사용 조각이다).
   * 자리는 아래 렌더 주석 참조: 무대 오버레이 층이되 재생 컨트롤 바 **밖**이다.
   */
  skipSlot?: ReactNode;
}

/**
 * viewer-core 직접 마운트(#169 S3). 캔버스에 createViewer 로 코어를 붙이고, 골/상황/배너 자막은
 * 캔버스 위 오버레이(호스트 DOM)로 그린다. 재생은 **하이라이트 연출(autoPace) 단일 모드**다(#216 —
 * 끔 경로 제거). 컨트롤은 admin 풀컨트롤만 남고 플레이 모드엔 없다. 손상 로그는 load 가 throw →
 * 텍스트 타임라인으로 폴백.
 */
export function VisualPlayback({
  log,
  half,
  onFallback,
  controlMode,
  canSwitch,
  review = false,
  onControlMode,
  onTick,
  clock,
  clockOffsetMs,
  grades = null,
  skipSlot,
}: VisualPlaybackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const situationRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerController | null>(null);
  // QA 시계·스크럽(#177)은 코어가 **프레임마다** 갱신한다 → state 가 아니라 ref 로 DOM 을 직접
  // 건드린다(자막 오버레이와 같은 패턴). state 로 받으면 초당 60회 리렌더가 난다.
  const clockRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);
  /*
   * ── 과거 전용 시크바의 상태(#406 W3) ──────────────────────────────────────────────────────
   * 셋 다 **ref** 다. 재생 헤드와 라이브 상한은 프레임/250ms 마다 바뀌므로 state 로 들면 관전
   * 화면이 초당 수십 번 리렌더된다(위 시계·스크럽과 같은 이유). 시크바는 이 값을 읽어 직접 그린다.
   */
  const headIndexRef = useRef(0);
  // ⚠️ 초기값 0 = **fail-closed**. 상한을 모르는 동안 전 구간을 열어 두면 그 한 프레임이 곧 스포일러다
  //    (#285 아이콘 정책과 같은 태도 — 모르면 잠근다). 라이브가 아니면 아래 게이트 effect 가 null 로 연다.
  const liveIndexRef = useRef<number | null>(0);
  const pastModeRef = useRef(false);
  const seekBarRef = useRef<SeekBarHandle | null>(null);
  const repaintSeekBar = () => seekBarRef.current?.paint();
  const [pins, setPins] = useState<TimelinePin[]>([]);
  // 재생 범위 메타(#180) — 초단위 스텝/스크럽이 "어디까지 갈 수 있나"를 알아야 한다.
  const [range, setRange] = useState<{ snapCount: number; lastTick: number }>({ snapCount: 0, lastTick: 0 });
  // onScrub 은 프레임마다 오는 콜백이라 마운트 시점 클로저에 갇힌다 → 스냅샷 수는 ref 로 본다.
  const snapCountRef = useRef(0);
  const [viewerReady, setViewerReady] = useState(false);
  // 경기장 캐릭터 스킨(#145). 에셋이 아직/영영 없으면 null → 코어는 현행 단색 원(무회귀).
  const charAssets = useCharAssets();
  const skins = useMemo(() => buildViewerSkins(charAssets, log, grades), [charAssets, log, grades]);
  const [failed, setFailed] = useState(false);

  // 콜백은 마운트 시 고정하되 최신 onTick 은 ref 로 본다(stale closure 방지).
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  // 스킨은 아틀라스 매핑 로드가 늦을 수 있어, 마운트 후 준비되면 반영한다.
  useEffect(() => {
    if (skins && viewerRef.current) viewerRef.current.setSkin(skins);
  }, [skins]);

  // 코어 마운트 — half/로그가 바뀌면 재마운트(캔버스 key 로 새 캔버스).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !log) return;

    // 코어 인스턴스 지역 참조 — chrome 콜백이 마운트 도중(load 안)에도 코어 훅을 볼 수 있게.
    let created: ViewerController | null = null;
    const SHOW = styles.capShow as string;
    const showAnim = (el: HTMLElement | null, text: string, col: string) => {
      if (!el) return;
      el.textContent = text;
      el.style.color = col;
      el.classList.remove(SHOW);
      void el.offsetWidth; // reflow → 애니메이션 재발화
      el.classList.add(SHOW);
    };
    const chrome: ViewerChrome = {
      onTick: (t) => onTickRef.current?.(t),
      onBigCaption: (text, col) => showAnim(flashRef.current, text, col),
      onSituation: (text, col) => showAnim(situationRef.current, text, col),
      onBanner: (text, col) => {
        const el = bannerRef.current;
        if (!el) return;
        if (text != null) {
          el.textContent = text;
          el.style.color = col ?? "";
          el.classList.add(SHOW);
        } else {
          el.classList.remove(SHOW);
        }
      },
      onClearCaptions: () => {
        for (const el of [flashRef.current, situationRef.current, bannerRef.current]) el?.classList.remove(SHOW);
      },
      // --- QA 관전 도구(#177): 코어가 이미 내보내던 시계/스크럽/로드정보를 호스트가 받는다.
      //     S3(iframe 제거) 때 이 배선이 빠져 "몇 분 몇 초"를 볼 수 없었다.
      onClock: (text) => {
        if (clockRef.current) clockRef.current.textContent = text;
      },
      onScrub: (pct) => {
        // 드래그 중에는 사용자 입력이 이긴다(핸들이 손에서 튀지 않게).
        // 슬라이더 눈금은 % 가 아니라 **스냅샷 인덱스**다(1칸 = 1초, #180).
        const idx = indexFromPct(pct, snapCountRef.current);
        const el = scrubRef.current;
        if (el && document.activeElement !== el) el.value = String(idx);
        // 유저 시크바(#406 W3)도 같은 신호로 헤드를 따라간다 — 재생 위치의 출처를 둘로 만들지 않는다.
        headIndexRef.current = idx;
        repaintSeekBar();
      },
      onLoaded: ({ events, snapCount }) => {
        // onLoaded 는 v.load() 안에서 불린다 = viewerRef 대입 **전** → 지역 참조(created)를 본다.
        const hooks = created?.hooks as { idxOfTick?: (t: number) => number } | undefined;
        const idxOf = typeof hooks?.idxOfTick === "function" ? hooks.idxOfTick : (t: number) => t;
        setPins(buildTimelinePins(events as { tick: number }[], idxOf, snapCount));
        // 마지막 틱: 서브샘플 로그면 인덱스≠틱이라 스냅샷에서 직접 읽고, 없으면 인덱스로 근사.
        const snaps = (log as { tickSnapshots?: { tick: number }[] } | null)?.tickSnapshots ?? [];
        const lastSnap = snaps[snaps.length - 1];
        const lastTick = lastSnap ? lastSnap.tick : Math.max(0, snapCount - 1);
        snapCountRef.current = snapCount;
        setRange({ snapCount, lastTick });
      },
    };

    let v: ViewerController;
    try {
      v = createViewer(canvas, chrome);
      created = v;
      if (skins) v.setSkin(skins);
      // 배속은 건드리지 않는다(=1, 코어 자연 페이스). #216 이후 speed 는 연출 페이싱 위의
      // **배율**이라, 여기서 4 를 박으면 하이라이트까지 4배로 지나간다.
      v.load(log); // 손상 로그면 throw
      v.start();
    } catch {
      // 로드 실패 → 같은 자리에 실패 안내 표시(빈 피치 방지). 텍스트 타임라인 전환은 유저 버튼으로
      // (자동 전환하면 손상 로그의 빈 타임라인만 남아 "왜 안 나오지"가 된다).
      setFailed(true);
      return;
    }
    viewerRef.current = v;
    setViewerReady(true);
    // QA/e2e 훅 — dev-viewer 가 제공하던 window.__viewer 와 동형(읽기 표면 + 스킨/뷰모드).
    (window as unknown as { __viewer?: unknown }).__viewer = v.hooks;

    return () => {
      v.stop();
      viewerRef.current = null;
      setViewerReady(false);
      const w = window as unknown as { __viewer?: unknown };
      if (w.__viewer === v.hooks) delete w.__viewer;
    };
    // 스킨은 위 별도 effect 로 반영(마운트 재실행 트리거에서 제외).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, half]);

  // ── 라이브 게이트(P4-E2 #170 / AC-W3-1, #216 재정합 · #365 보정 제거) ──────────────────
  // 늦게 접속하면 **경과 시점부터** 재생한다(seek-to-now). 그 뒤로는 **손대지 않는다** —
  // 재생 속도는 코어의 고정 배속(연출 페이싱 × PACE.TICKS_PER_SEC)뿐이다.
  //
  // #365(hero 확정 "고정 배속만, 가변 보정 안 쓴다"): 서버 창이 이제 **그 하프의 실제 재생 길이**다
  // (러너가 viewer-core 페이싱 모델로 재서 준다) → 창과 재생이 애초에 같은 길이라 맞출 것이 없다.
  // 구 `paceRate`(잔여 비율 배율 0.6~1.6)는 창이 **고정값**이던 시절 그 차이를 흡수하던 장치다.
  // ⚠️ 되감기가 되살아나지 않는가: 자연 재생은 구간마다 속도가 달라(크루즈 4x / 키장면 1x) 선형인
  // 서버 게이트를 앞서거나 뒤처진다. 8시드×2하프 실측 = **최대 앞섬 4.2% · 뒤처짐 8.6%** 로
  // 허용폭 `PACE_DRIFT_FRAC`(12%) 안이다 → 회수 점프는 발화하지 않는다(스크럽·핀 같은 의도적
  // 점프만 남는다). 이 관계가 계약(`live-pace.test.ts`)으로 박혀 있다.
  //
  // 구 구현은 여기서 autoPace 를 끄고 압축비를 speed 에 직접 넣은 뒤, 넘칠 때마다 플레이헤드를
  // 되감았다 — ①유저의 실경기가 항상 "하이라이트 끔"이었고 ②코어 1x = 2게임초/실초라 압축비를
  // 그대로 넣으면 두 배로 빨랐으며 ③연출 페이싱은 속도가 균일하지 않아 되감기가 상시 발화했다
  // (초당 4회 = 고무줄). #216 은 셋 다 지운다. 코어는 QA 뷰어와 공유하는 SoT 라 최소로만 쓴다.
  const gateInput = useRef({ clock, clockOffsetMs, half });
  gateInput.current = { clock, clockOffsetMs, half };
  const snapTicks = useMemo(() => {
    const snaps = (log as { tickSnapshots?: { tick: number }[] } | null)?.tickSnapshots;
    return Array.isArray(snaps) ? snaps.map((s) => s.tick) : [];
  }, [log]);
  const tickCount = snapTicks.length;

  /** 지금 이 순간의 정책. **호출할 때마다 다시 잰다** — 라이브 상한은 계속 흐른다. */
  const policyNow = (): SeekPolicy => {
    const { clock: c, clockOffsetMs: off, half: h } = gateInput.current;
    return policyOf(liveGate(c, h, tickCount, Date.now(), off));
  };

  /*
   * ── 유저 시크 창구 (#406 W3 / 요구 5-3) ────────────────────────────────────────────────────
   * 컨트롤(시크바·QA 스텝·핀)은 **여기만** 부른다. 예전에는 각자 `viewer.scrubTo`·`jumpToTick`·
   * `hooks.seek` 를 직접 불렀고 그 호출들은 `clampSeek` 를 거치지 않았다 — 그래서 라이브에서도
   * 바 오른쪽 끝까지 끌렸다(= 아직 일어나지 않은 장면이 열렸다).
   *
   * ⚠️ 상한 규칙을 여기서 다시 쓰지 않는다. `policy.clampIndex` 는 `liveGate.clamp` → `clampSeek`
   *    (shared) 그대로다. 계산을 복제하면 변이체가 통과한다(#233 독립검증 minor-1).
   */
  const seek = useMemo<GatedSeek | null>(() => {
    if (!viewerReady) return null;
    const snapCount = range.snapCount;
    const lastTick = range.lastTick;
    /** 이동한 자리가 라이브 헤드에서 떨어져 있으면 = 유저가 과거를 보는 중. */
    const note = (index: number, p: SeekPolicy) => {
      pastModeRef.current = !atLiveEdge(index, p);
      repaintSeekBar();
    };
    return {
      toIndex(index) {
        const v = viewerRef.current;
        if (!v) return 0;
        const p = policyNow();
        const capped = p.clampIndex(withinTrack(index, snapCount));
        v.scrubTo(pctFromIndex(capped, snapCount));
        note(capped, p);
        return capped;
      },
      toTick(tick) {
        const v = viewerRef.current;
        if (!v) return 0;
        const p = policyNow();
        const target = gatedTick(clampTick(tick, lastTick), snapTicks, p);
        // 정밀 이동은 hooks.seek 로만 — jumpToTick 은 맥락용 3 스냅샷 되감기가 붙는다(#180).
        (v.hooks as unknown as { seek?: (t: number) => void }).seek?.(target);
        note(indexOfTick(snapTicks, target), p);
        return target;
      },
      toScene(tick) {
        const v = viewerRef.current;
        if (!v) return false;
        const p = policyNow();
        const idx = indexOfTick(snapTicks, tick);
        // 아직 안 온 장면으로는 보내지 않는다 — 상한으로 당겨서 "엉뚱한 데로 간다"보다 거부가 정직하다.
        if (isFutureIndex(idx, p)) return false;
        v.jumpToTick(clampTick(tick, lastTick));
        note(idx, p);
        return true;
      },
      isFutureTick(tick) {
        return isFutureIndex(indexOfTick(snapTicks, tick), policyNow());
      },
      toNow() {
        const v = viewerRef.current;
        if (!v) return;
        const p = policyNow();
        pastModeRef.current = false;
        repaintSeekBar();
        if (p.liveIndex == null) return;
        v.jumpToTick(tickOfSnapIndex(snapTicks, p.liveIndex));
        v.play();
      },
    };
    // policyNow 는 매 호출 새로 재므로 의존성이 아니다(gateInput ref 를 본다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady, snapTicks, range.snapCount, range.lastTick]);

  /**
   * 하프·로그·단계가 바뀌면 "과거 보는 중"은 끝난다 — 새 하프에서 배지가 남아 있으면 유저가
   * 라이브를 놓친 줄 알고, 복구 루프도 억제된 채 시작한다.
   */
  useEffect(() => {
    pastModeRef.current = false;
    repaintSeekBar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, half, clock?.phase]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!viewerReady || !v) return;
    const gateNow = () => {
      const { clock: c, clockOffsetMs: off, half: h } = gateInput.current;
      return liveGate(c, h, tickCount, Date.now(), off);
    };
    /** 시크바가 그릴 상한. 라이브가 아니면 **null = 잠금 없음**(종료 후 전 구간 이동, 요구 5-3 후반부). */
    const pushLive = (g: ReturnType<typeof gateNow>) => {
      liveIndexRef.current = g.isLive ? g.liveTick : null;
      repaintSeekBar();
    };

    const entry = gateNow();
    pushLive(entry);
    if (tickCount <= 0) return;
    // 지나간 하프·종료·레거시 = 제한 없음. 배율도 자연 페이스로 돌려놓는다(단계가 바뀐 뒤에도
    // 직전 창의 배율이 남아 있으면 다시보기가 미묘하게 빠르거나 느려진다).
    if (!entry.isLive) {
      v.setSpeed(1);
      return;
    }

    // 서버 시계는 **인덱스**로 말하고 뷰어는 절대 틱으로 움직인다 — 후반 로그(틱 2700~)에서
    // 이 둘을 섞으면 seek-to-now 가 로그 맨 앞으로 가고 상한 비교가 늘 참이 된다(후반 정지).
    const drift = driftAllowanceTicks(tickCount);
    // ⚠️ 유저가 과거를 보는 중이면 **입장 점프도 하지 않는다**(#406 W3). 이 effect 는 단계가 바뀔 때
    //    다시 도는데, 그때마다 현재로 끌어당기면 뒤로 돌려놓은 화면이 이유 없이 튄다.
    if (!pastModeRef.current) {
      v.jumpToTick(tickOfIndex(snapTicks, entry.liveTick)); // seek-to-now
      v.play();
    }

    const timer = window.setInterval(() => {
      const gate = gateNow();
      pushLive(gate);
      if (!gate.isLive) return;
      const curIdx = indexOfPlayhead(snapTicks, Number(v.hooks.cur()?.tick ?? 0));
      headIndexRef.current = curIdx;
      /*
       * **유저가 과거를 보는 중이면 끌어당기지 않는다**(#406 W3, hero 확정 ③=B 수동 [현재로]만).
       * 이 억제가 없으면 뒤로 끌어 놓아도 0.25초 뒤에 현재로 튕겨 온다 = 과거를 붙잡을 수 없다.
       * 자동 복귀는 넣지 않는다 — 다만 자유 재생이 **스스로** 라이브 헤드에 닿으면 그건 유저가
       * 따라잡은 것이므로 추종을 재개한다(그래야 배지가 영영 켜져 있지 않다).
       */
      if (pastModeRef.current) {
        if (atLiveEdge(curIdx, policyOf(gate))) {
          pastModeRef.current = false;
          repaintSeekBar();
        }
        return;
      }
      // 자유 재생의 앞섬은 배율로 되돌린다. 드리프트 폭을 넘는 건 의도적 점프(스크럽·핀)로 보고
      // 상한으로 회수한다 — 앞서보기 차단(AC-W3-1)은 여기 한 곳에만 남는다.
      if (curIdx > gate.clamp(curIdx) + drift) {
        v.jumpToTick(tickOfIndex(snapTicks, gate.liveTick));
        return;
      }
      // #365: 배율은 **건드리지 않는다**(고정 배속만). 위 회수 점프만 남는다.
    }, 250);
    return () => {
      window.clearInterval(timer);
      v.setSpeed(1);
    };
  }, [viewerReady, tickCount, snapTicks, clock?.phase, clock?.phaseStartAt]);

  /*
   * 돌려보는 화면(#244 review)은 **정지 상태로 연다**. 관전 무대는 자동 재생이 맞지만, 여기서
   * 유저가 하려는 일은 "그 장면을 찾아 본다"라 들어오자마자 흘러가면 방금 본 장면을 놓친다
   * (독립 검증 minor: 무조작 2초에 0'05" → 0'09").
   * ⚠️ **조기 반환(`if (failed)`)보다 위**에 둔다 — 아래로 내리면 실패 경로에서 훅 수가 줄어
   *    "Rendered fewer hooks than expected" 로 화면이 통째로 크래시한다(실제로 그렇게 넣었다가 잡혔다).
   */
  useEffect(() => {
    if (!review || !viewerReady) return;
    (viewerRef.current as unknown as { pause?: () => void } | null)?.pause?.();
  }, [review, viewerReady]);

  /*
   * 하이라이트 순서 재생(#421 W4) — 후반 디폴트. **라이브 게이트 effect(위)는 무수정**이고, 이 훅은
   * 그것과 **배타**로만 움직인다(배타 규칙·근거 = `highlight-sequencer.ts` 머리말 ①).
   * ⚠️ 조기 반환(`if (failed)`)보다 **위**에 둔다 — 아래로 내리면 실패 경로에서 훅 수가 줄어
   *    "Rendered fewer hooks than expected" 로 화면이 통째로 크래시한다(위 review effect 와 같은 함정).
   */
  const highlight = useHighlightSequencer({
    viewerRef,
    viewerReady,
    log,
    half,
    review,
    clock,
    clockOffsetMs,
    snapTicks,
  });

  if (failed) {
    return (
      <div className={styles.note} data-testid={`viewer-visual-error-half${half}`}>
        시각 재생을 불러오지 못했습니다.{" "}
        <button type="button" className={styles.control} onClick={onFallback}>
          타임라인으로 보기
        </button>
      </div>
    );
  }

  return (
    <div className={styles.stageWrapFill} data-testid={`viewer-visual-half${half}`}>
      <canvas
        ref={canvasRef}
        key={`viewer-canvas-half${half}`}
        width={1050}
        height={680}
        className={styles.stageCanvas}
        data-testid={`viewer-canvas-half${half}`}
      />
      {/* 자막 오버레이(호스트 DOM) — 코어가 chrome 콜백으로 표시/숨김 토글. aria-live 로 골만 읽어줌. */}
      <div ref={flashRef} className={styles.capFlash} aria-live="polite" />
      <div ref={situationRef} className={styles.capSituation} aria-hidden="true" />
      <div ref={bannerRef} className={styles.capBanner} aria-hidden="true" />
      {/*
       * 무대 모드에선 컨트롤을 화면 모서리에 **겹친다**(리서치 R6 — 뷰 컨트롤은 무대 가장자리).
       * 돌려보는 화면(#244 review)에서는 겹치면 피치를 가리므로 **캔버스 아래 흐름**으로 내린다.
       * 유저 시크바(#406 W3)는 같은 오버레이지만 **무대 가로 전체**를 쓴다 — 오른쪽 구석에 모인
       * QA 칩 묶음과 다른 축이라(목업 §3 "무대 아래(돌려보기) 또는 무대 위 오버레이") 자리를 가른다.
       */}
      {/*
       * ⚠️ 플레이 모드는 **무대 가로 전체**를 쓰는 시크바 층(#406 W3)이고, 그 안에 #421 의
       * 하이라이트 토글·스킵 버튼이 같이 앉는다 — 두 축이 같은 오버레이 컨테이너를 공유한다.
       */}
      <div
        className={
          review
            ? styles.controlsFlow
            : controlMode === "play"
              ? styles.controlsSeek
              : styles.controlsOverlay
        }
      >
        {/* 하이라이트 ↔ 전체 보기(#421 W4) — 스킵 버튼 위 줄. 돌려보는 화면엔 뜨지 않는다(view.visible). */}
        <HighlightToggle view={highlight.view} onToggle={highlight.toggle} />
        {/*
          경기 스킵(#421) — **재생 컨트롤 바 옆이지, 그 안이 아니다.**
          #216 계약은 *"플레이 모드 컨트롤 바에는 버튼이 0개"* 다(`matchui-controls-mock` ·
          `MatchViewer.controls.test`). 그 계약의 뜻은 "일반 유저에게 **재생 조작**(재생·배속·
          스크럽·프레임)을 주지 않는다"이고, 스킵은 재생 조작이 아니라 **경기 흐름 액션**
          (서버 상태를 바꾼다)이다. 그래서 같은 오버레이 층에 두되 바 밖에 세워, 그 계약을
          글자 그대로 살려 둔다 — 안에 넣으면 버튼 수가 0 → 1 이 되어 남의 스펙을 고쳐야 한다.
          돌려보는 화면(review)에는 그리지 않는다(지나간 하프엔 건너뛸 재생이 없다).
        */}
        {!review && skipSlot}
        <PlaybackControls
          half={half}
          mode={controlMode}
          canSwitch={canSwitch}
          onMode={onControlMode}
          viewer={viewerReady ? viewerRef.current : null}
          seek={seek}
          headRef={headIndexRef}
          liveRef={liveIndexRef}
          pastRef={pastModeRef}
          seekBarRef={seekBarRef}
          clockRef={clockRef}
          scrubRef={scrubRef}
          pins={pins}
          snapCount={range.snapCount}
          lastTick={range.lastTick}
          review={review}
        />
      </div>
    </div>
  );
}
