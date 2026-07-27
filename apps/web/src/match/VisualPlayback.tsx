import { useEffect, useMemo, useRef, useState } from "react";
import { createViewer, type ViewerChrome, type ViewerController } from "@hmb/viewer-core";
import type { MatchClock } from "@hmb/shared";
import { liveGate } from "./live-clock";
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
 * 캔버스 위 오버레이(호스트 DOM)로 그린다. 컨트롤(플레이=하이라이트 토글 / admin=풀컨트롤)은
 * 코어 컨트롤러를 직접 조작한다. 손상 로그는 load 가 throw → 텍스트 타임라인으로 폴백.
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
  // 하이라이트 연출(autoPace) 표시 상태 — 코어 기본 on.
  const [highlight, setHighlight] = useState(true);

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
      v.setSpeed(4); // 기본 배속(hero 지시) — 하이라이트 off 시 이 속도로 진행.
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
    setHighlight(true);
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

  // ── 라이브 게이트(P4-E2 #170 / AC-W3-1) ───────────────────────────────
  // 늦게 접속하면 **경과 시점부터** 재생하고, 그 뒤로는 "지금"을 앞질러 가지 못한다(되감기는 자유).
  // viewer-core 는 자체 프레임 루프를 도므로 코어를 고치지 않고 호스트가 주기적으로 플레이헤드를
  // 확인해 상한 밖이면 되돌린다(코어는 QA 뷰어와 공유하는 SoT — 여기서 건드리지 않는다).
  const gateInput = useRef({ clock, clockOffsetMs, half });
  gateInput.current = { clock, clockOffsetMs, half };
  const tickCount = useMemo(() => {
    const snaps = (log as { tickSnapshots?: unknown[] } | null)?.tickSnapshots;
    return Array.isArray(snaps) ? snaps.length : 0;
  }, [log]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!viewerReady || !v || tickCount <= 0) return;
    const gateNow = () => {
      const { clock: c, clockOffsetMs: off, half: h } = gateInput.current;
      return liveGate(c, h, tickCount, Date.now(), off);
    };

    const entry = gateNow();
    if (!entry.isLive) return; // 지나간 하프·종료·레거시 = 제한 없음(기존 동작 그대로)

    // 라이브에서는 하이라이트 연출(autoPace)을 끈다 — 줌·슬로우가 실시간을 따라가지 못한다.
    setHighlight(false);
    v.setAutoPace(false);
    if (entry.speed) v.setSpeed(entry.speed);
    v.jumpToTick(entry.liveTick); // seek-to-now
    v.play();

    const timer = window.setInterval(() => {
      const gate = gateNow();
      if (!gate.isLive) return;
      const cur = Number(v.hooks.cur()?.tick ?? 0);
      if (cur > gate.clamp(cur)) {
        v.jumpToTick(gate.liveTick); // 앞질러 갔으면(스크럽·배속) 지금으로 되돌린다
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [viewerReady, tickCount, clock?.phase, clock?.phaseStartAt]);

  const onHighlight = (on: boolean) => {
    setHighlight(on);
    viewerRef.current?.setAutoPace(on);
  };

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
          highlight={highlight}
          onHighlight={onHighlight}
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
