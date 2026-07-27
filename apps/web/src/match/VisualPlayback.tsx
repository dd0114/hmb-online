import { useEffect, useMemo, useRef, useState } from "react";
import { createViewer, type ViewerChrome, type ViewerController } from "@hmb/viewer-core";
import type { MatchClock } from "@hmb/shared";
import { liveGate } from "./live-clock";
import { driftAllowanceTicks, indexOfPlayhead, paceRate, tickOfIndex } from "./live-pace";
import type { ControlMode } from "./playback-controls";
import { PlaybackControls } from "./PlaybackControls";
import { buildTimelinePins, type TimelinePin } from "./timeline-pins";
import { indexFromPct } from "./qa-time-controls";
import { buildViewerSkins } from "./viewer-skins";
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
  onControlMode: (m: ControlMode) => void;
  onTick?: (tick: number) => void;
  clock: MatchClock | null;
  clockOffsetMs: number;
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
  onControlMode,
  onTick,
  clock,
  clockOffsetMs,
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
  const [pins, setPins] = useState<TimelinePin[]>([]);
  // 재생 범위 메타(#180) — 초단위 스텝/스크럽이 "어디까지 갈 수 있나"를 알아야 한다.
  const [range, setRange] = useState<{ snapCount: number; lastTick: number }>({ snapCount: 0, lastTick: 0 });
  // onScrub 은 프레임마다 오는 콜백이라 마운트 시점 클로저에 갇힌다 → 스냅샷 수는 ref 로 본다.
  const snapCountRef = useRef(0);
  const [viewerReady, setViewerReady] = useState(false);
  // 경기장 캐릭터 스킨(#145). 에셋이 아직/영영 없으면 null → 코어는 현행 단색 원(무회귀).
  const charAssets = useCharAssets();
  const skins = useMemo(() => buildViewerSkins(charAssets, log), [charAssets, log]);
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
        const el = scrubRef.current;
        if (el && document.activeElement !== el) el.value = String(indexFromPct(pct, snapCountRef.current));
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

  // ── 라이브 게이트(P4-E2 #170 / AC-W3-1, #216 재정합) ──────────────────
  // 늦게 접속하면 **경과 시점부터** 재생한다(seek-to-now). 그 뒤로는 연출(autoPace)을 켠 채로
  // **배율**만 조금씩 손봐 재생이 서버 창의 끝에 맞물리게 한다(live-pace.paceRate).
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

  useEffect(() => {
    const v = viewerRef.current;
    if (!viewerReady || !v || tickCount <= 0) return;
    const gateNow = () => {
      const { clock: c, clockOffsetMs: off, half: h } = gateInput.current;
      return liveGate(c, h, tickCount, Date.now(), off);
    };

    const entry = gateNow();
    // 지나간 하프·종료·레거시 = 제한 없음. 배율도 자연 페이스로 돌려놓는다(단계가 바뀐 뒤에도
    // 직전 창의 배율이 남아 있으면 다시보기가 미묘하게 빠르거나 느려진다).
    if (!entry.isLive) {
      v.setSpeed(1);
      return;
    }

    // 서버 시계는 **인덱스**로 말하고 뷰어는 절대 틱으로 움직인다 — 후반 로그(틱 2700~)에서
    // 이 둘을 섞으면 seek-to-now 가 로그 맨 앞으로 가고 상한 비교가 늘 참이 된다(후반 정지).
    const drift = driftAllowanceTicks(tickCount);
    v.jumpToTick(tickOfIndex(snapTicks, entry.liveTick)); // seek-to-now
    v.play();

    const timer = window.setInterval(() => {
      const gate = gateNow();
      if (!gate.isLive) return;
      const curIdx = indexOfPlayhead(snapTicks, Number(v.hooks.cur()?.tick ?? 0));
      // 자유 재생의 앞섬은 배율로 되돌린다. 드리프트 폭을 넘는 건 의도적 점프(스크럽·핀)로 보고
      // 상한으로 회수한다 — 앞서보기 차단(AC-W3-1)은 여기 한 곳에만 남는다.
      if (curIdx > gate.clamp(curIdx) + drift) {
        v.jumpToTick(tickOfIndex(snapTicks, gate.liveTick));
        return;
      }
      v.setSpeed(paceRate(curIdx / tickCount, gate.liveTick / tickCount));
    }, 250);
    return () => {
      window.clearInterval(timer);
      v.setSpeed(1);
    };
  }, [viewerReady, tickCount, snapTicks, clock?.phase, clock?.phaseStartAt]);

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
      {/* 무대 모드에선 컨트롤을 화면 모서리에 겹친다(리서치 R6 — 뷰 컨트롤은 무대 가장자리). */}
      <div className={styles.controlsOverlay}>
        <PlaybackControls
          half={half}
          mode={controlMode}
          canSwitch={canSwitch}
          onMode={onControlMode}
          viewer={viewerReady ? viewerRef.current : null}
          clockRef={clockRef}
          scrubRef={scrubRef}
          pins={pins}
          snapCount={range.snapCount}
          lastTick={range.lastTick}
        />
      </div>
    </div>
  );
}
