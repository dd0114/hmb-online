import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { ViewerController } from "@hmb/viewer-core";
import type { ControlMode } from "./playback-controls";
import { type TimelinePin } from "./timeline-pins";
import { parseClockInput, qaKeyAction, stepSeconds } from "./qa-time-controls";
import { trackGeometry, type GatedSeek } from "./seek-gate";
import styles from "./PlaybackControls.module.css";

/**
 * 시크바 다시 그리기 핸들. 재생 헤드·라이브 상한은 **프레임마다** 바뀌므로 state 로 받으면
 * 초당 60회 리렌더가 난다 — 자막 오버레이·QA 스크럽과 같은 패턴으로 ref + 직접 DOM 이다.
 * 호스트(`VisualPlayback`)가 값을 자기 ref 에 쓰고 이 핸들로 "다시 그려라"만 알린다.
 */
export interface SeekBarHandle {
  paint(): void;
}

interface PlaybackControlsProps {
  half: 1 | 2;
  mode: ControlMode;
  /** admin/QA 자격 — 모드 전환 토글 노출 여부. */
  canSwitch: boolean;
  onMode: (m: ControlMode) => void;
  /** 직접 마운트한 코어 컨트롤러(#169 S3) — full 모드 풀컨트롤이 이걸 조작한다. */
  viewer: ViewerController | null;
  /**
   * **모든 유저 시크가 지나야 하는 창구**(#406 W3). 컨트롤은 `viewer.scrubTo/jumpToTick` 을 직접
   * 부르지 않는다 — 그 호출은 라이브 상한(`clampSeek`)을 거치지 않아 미래로 끌린다.
   */
  seek: GatedSeek | null;
  /** 재생 헤드(스냅샷 인덱스) — 호스트가 코어 onScrub 에서 쓴다. */
  headRef?: MutableRefObject<number>;
  /** 라이브 상한(스냅샷 인덱스). null = 상한 없음(종료·지나간 하프). */
  liveRef?: MutableRefObject<number | null>;
  /** "유저가 과거를 보는 중"인가 — 배지·[현재로] 노출과 복구 루프 억제가 같은 값을 본다. */
  pastRef?: MutableRefObject<boolean>;
  /** 시크바 다시 그리기 핸들 등록처. */
  seekBarRef?: MutableRefObject<SeekBarHandle | null>;
  /** QA 시계(`12'34" / 24'00"`) 표시 슬롯 — 호스트가 코어 onClock 으로 직접 갱신한다(#177). */
  clockRef?: RefObject<HTMLSpanElement>;
  /** 스크럽 핸들 — 호스트가 코어 onScrub 으로 위치를 따라가게 한다(#177). */
  scrubRef?: RefObject<HTMLInputElement>;
  /** 타임라인 키 장면 핀(골/PK/선방/유효슛/코너) — 클릭하면 그 틱으로 점프(#177). */
  pins?: TimelinePin[];
  /** 로그 스냅샷 수 — 스크럽 눈금(1칸 = 1스냅샷)과 프레임 스텝 기준(#180). */
  snapCount?: number;
  /** 마지막 재생 가능 틱 — 초 스텝이 경기 밖으로 나가지 않게(#180). */
  lastTick?: number;
  /**
   * **돌려보는 화면**(감독시간 경기장면 탭 등, #244). 같은 도구를 유저 언어로 다시 배치한다:
   * 트랜스포트 4개(이전 장면·재생·다음 장면·배속) + 한 축 타임라인 + 장면 리스트,
   * 그리고 QA 풀컨트롤(배속 6단·프레임 스텝·mm:ss)은 **"고급"으로 접는다**.
   * 끄면 예전 그대로(관전/QA 무대) — 이게 롤백 스위치다.
   */
  review?: boolean;
}

// 연출 페이스에 곱하는 **배율**(#216) — 1x = 자연 페이스(크루즈 4x / 키장면 1x).
// ⚠️ #216 이후 절대속도가 아니다: 0.1x 는 키장면 창에서 0.2 게임초/실초(구 #180 의 그 속도)지만
// 빌드업 구간에서는 그 4배(0.8)다. **정확한 초를 짚는 건 배속이 아니라 초/프레임 스텝**(hooks.seek,
// 아래 timeGroup)이 담당한다 — 그쪽은 이 변경과 무관하다.
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4] as const;

/**
 * 경기 재생 컨트롤 바 (#148, #169 S3 직접 마운트).
 *  - 플레이 모드(일반 유저): QA 도구는 **없다**(재생/정지·배속·프레임 스텝·모드 토글). 경기는
 *    하이라이트 연출로 자동 진행된다. (#216 에서 하이라이트 토글을 지웠다 — 끔 모드는 렌더가 깨진
 *    채였고, 라이브 재생이 그 경로를 강제로 타고 있었다.)
 *    ⚠️ **#406 W3 에서 여기에 유저용 시크바가 들어왔다**(요구 5-3 "과거만 돌려보기"). 예전 계약
 *    ("플레이 모드엔 컨트롤이 0개")은 그 요구가 대체한 것이지, 잊어서 깨진 게 아니다.
 *  - full 모드(admin/QA): 코어 풀컨트롤(재생·배속·스크럽·프레임점프·뷰모드) — 디버그/검수용.
 *    (S2 이전엔 iframe 안 dev-viewer 컨트롤을 썼으나, S3 에서 iframe 이 사라져 web 이 직접 그린다.)
 */
export function PlaybackControls({
  half,
  mode,
  canSwitch,
  onMode,
  viewer,
  seek,
  headRef,
  liveRef,
  pastRef,
  seekBarRef,
  clockRef,
  scrubRef,
  pins,
  snapCount,
  lastTick,
  review,
}: PlaybackControlsProps) {
  return (
    <div
      className={review ? `${styles.bar} ${styles.barReview}` : styles.bar}
      data-testid={`viewer-controls-half${half}`}
      data-mode={mode}
      data-review={review ? "true" : undefined}
    >
      {review && (
        <ReviewControls
          half={half}
          viewer={viewer}
          seek={seek}
          clockRef={clockRef}
          scrubRef={scrubRef}
          pins={pins}
          snapCount={snapCount ?? 0}
        />
      )}

      {/*
        유저용 과거 전용 시크바 (#406 W3). 관전(라이브)·결과 화면 **양쪽 다 이 하나**다 —
        종료 뒤에는 서버 시계가 null 이라 게이트가 저절로 꺼지고 전 구간이 열린다(잠금만 빠진 같은 바).

        **플레이 모드에만** 그린다:
         · 돌려보기(#244 review)는 자기 트랜스포트를 이미 갖고 있다 — 여기서 또 그리면 트랙이 둘이 된다.
         · full(admin/QA)에는 스크럽·핀·초 스텝이 이미 있다. 그쪽도 이제 `seek` 을 지나므로 상한은
           똑같이 걸리고, 과거로 갔다면 QA 스크럽을 오른쪽 끝까지 끌면(= 상한으로 클램프) 추종이 재개된다.
        스냅샷이 1개 이하면 애초에 이동할 곳이 없다 → 바를 만들지 않는다.
      */}
      {mode === "play" && !review && (snapCount ?? 0) > 1 && headRef && liveRef && pastRef && (
        <SeekBar
          half={half}
          snapCount={snapCount ?? 0}
          pins={pins ?? []}
          seek={seek}
          headRef={headRef}
          liveRef={liveRef}
          pastRef={pastRef}
          handleRef={seekBarRef}
        />
      )}

      {mode === "full" && review && (
        /* 고급 = QA 도구. 유저 화면에선 접혀 있고, 펴면 예전 풀컨트롤 그대로다(도구를 뺏지 않는다). */
        <details className={styles.advanced} data-testid={`viewer-advanced-half${half}`}>
          <summary>고급 컨트롤 — 배속·프레임 스텝·시간 점프</summary>
          <AdminControls
            half={half}
            viewer={viewer}
            seek={seek}
            pins={[]}
            snapCount={snapCount ?? 0}
            lastTick={lastTick ?? 0}
            /* 시계·시간바는 위 돌려보기 줄이 소유한다 — 여기서 또 그리면 같은 testid 가 둘이 된다. */
            nested
          />
        </details>
      )}

      {mode === "full" && !review && (
        <AdminControls
          half={half}
          viewer={viewer}
          seek={seek}
          clockRef={clockRef}
          scrubRef={scrubRef}
          pins={pins}
          snapCount={snapCount ?? 0}
          lastTick={lastTick ?? 0}
        />
      )}

      {canSwitch && (
        <div className={styles.modes} role="group" aria-label="컨트롤 모드" data-testid={`viewer-mode-toggle-half${half}`}>
          <button
            type="button"
            className={[styles.mode, mode === "play" ? styles.modeOn : ""].join(" ")}
            data-testid={`viewer-mode-play-half${half}`}
            aria-pressed={mode === "play"}
            onClick={() => onMode("play")}
          >
            🎮 플레이
          </button>
          <button
            type="button"
            className={[styles.mode, mode === "full" ? styles.modeOn : ""].join(" ")}
            data-testid={`viewer-mode-full-half${half}`}
            aria-pressed={mode === "full"}
            onClick={() => onMode("full")}
          >
            🛠 풀컨트롤
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * **과거 전용 시크바** (#406 W3 / 요구 5-3, 목업 `docs/plan-v5/mock/406-matchux/match-ux.html` §3).
 *
 *   [⏪ 과거 보는 중] [현재로 ▶]
 *   ▓▓▓▓▓▓▓▓░░░░│▨▨▨▨▨▨▨▨▨▨▨▨   ← 재생된 과거 / 진행됐지만 안 본 구간 / │현재 / 아직 안 온 미래(잠김)
 *
 * 세 가지가 이 부품의 계약이다:
 *  ① **미래로 못 간다** — 슬라이더가 트랙 전체가 아니라 **라이브 헤드까지만** 덮고(`maxIndex`),
 *     그 오른쪽은 빗금 친 비대화 영역이다. 값 자체도 `seek.toIndex` 에서 `clampSeek` 를 한 번 더 지난다
 *     (두 층 — 어느 한 층이 지워져도 스포일러가 새지 않게).
 *  ② **미래 핀은 DOM 에 만들지 않는다** — 상한이 흐르면 그때 나타난다.
 *     ⚠️ 처음엔 `opacity: .28` 로 **흐리게만** 그렸고 그게 독립검증 blocker 였다: 라벨(`title`/
 *     `aria-label` = `30' · HOME GOAL`)·색·위치가 그대로 살아 있어 호버·스크린리더·DOM 조회로
 *     **아직 안 온 골이 읽혔다**(후반 25% 시점 실측 핀 46개 중 미래 34개, 미발생 골 8개).
 *     `opacity` 는 방어가 아니다 — apps/web CLAUDE.md §"스포일러 규칙은 폴백에도 걸린다"(#233/#238)
 *     가 텍스트 폴백까지 막아 둔 규칙을 무대 위 상시 부품이 우회하는 꼴이었다.
 *     클릭 거부(`seek.toScene`)는 **두 번째 층으로 남긴다** — 한 층이 지워져도 새지 않게.
 *  ③ **자동 복귀는 없다**(hero 확정 ③=B) — 뒤로 가면 배지와 [현재로]가 뜨고, 유저가 누를 때까지
 *     화면은 그 자리에 머문다. 재생이 자연히 라이브 헤드에 닿으면 그때 추종이 재개된다.
 *
 * ⚠️ 그리기는 **명령형**이다(state 아님). 헤드·상한이 프레임마다 바뀌어서다. 그래서 아래 요소들은
 * JSX 에서 `style`·`max`·`disabled` 를 **주지 않는다** — 주면 React 가 리렌더마다 그 값을 되돌려
 * 놓아 화면이 깜빡이며 낡은 상태로 돌아간다.
 * **예외는 핀 목록 하나**(`shown`) — 감추는 수단이 "속성"이 아니라 **DOM 부재**라 state 여야 하고,
 * 열리는 사건은 프레임이 아니라 핀 개수만큼만 일어나 리렌더가 싸다.
 */
function SeekBar({
  half,
  snapCount,
  pins,
  seek,
  headRef,
  liveRef,
  pastRef,
  handleRef,
}: {
  half: 1 | 2;
  snapCount: number;
  pins: TimelinePin[];
  seek: GatedSeek | null;
  headRef: MutableRefObject<number>;
  liveRef: MutableRefObject<number | null>;
  pastRef: MutableRefObject<boolean>;
  handleRef?: MutableRefObject<SeekBarHandle | null>;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pastSegRef = useRef<HTMLSpanElement>(null);
  const unseenSegRef = useRef<HTMLSpanElement>(null);
  const futureSegRef = useRef<HTMLSpanElement>(null);
  const liveMarkRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const nowRef = useRef<HTMLButtonElement>(null);

  // 최신 seek 을 그리기 루프에서 보기 위한 참조(핸들은 마운트 때 한 번만 등록한다).
  const seekRef = useRef(seek);
  seekRef.current = seek;

  /**
   * **지금 그려도 되는 핀** — 아직 안 온 장면은 여기 없다(위 계약 ②).
   *
   * 이것만 state 인 이유: 나머지 그리기(세그먼트·핸들·배지)는 프레임마다 바뀌어 명령형이지만,
   * "핀 하나가 열렸다"는 하프당 핀 수만큼만 일어나는 **드문 사건**이라 리렌더가 싸다. 그리고
   * 감추는 수단이 **DOM 부재**여야 하므로 style 토글로는 표현할 수 없다.
   */
  const [shown, setShown] = useState<TimelinePin[]>([]);

  useEffect(() => {
    /**
     * ⚠️ 미래 판정은 `seek.isFutureTick`(→ `seek-gate.isFutureIndex`) **하나만** 쓴다.
     * 예전엔 여기서 `Number(el.dataset.pinPct) > g.livePct` 로 상한 규칙을 **pct 축에 복제**했다 —
     * `seek-gate.ts` 머리말이 스스로 금지한 형태고, 그래서 정책이 바뀌어도 화면만 조용히 갈라졌다.
     * 창구가 아직 없으면(뷰어 준비 전) **fail-closed**: 상한이 걸린 하프에서는 아무것도 그리지 않는다.
     */
    const visiblePins = (): TimelinePin[] => {
      const s = seekRef.current;
      if (!s) return liveRef.current == null ? pins : [];
      return pins.filter((p) => !s.isFutureTick(p.tick));
    };
    const sameTicks = (a: readonly TimelinePin[], b: readonly TimelinePin[]) =>
      a.length === b.length && a.every((p, i) => p.tick === b[i]!.tick);

    const paint = () => {
      const live = liveRef.current;
      const g = trackGeometry(headRef.current, live, snapCount);
      const seg = (el: HTMLElement | null, left: number, width: number) => {
        if (!el) return;
        el.style.left = `${left}%`;
        el.style.width = `${Math.max(0, width)}%`;
      };
      seg(pastSegRef.current, 0, g.headPct);
      seg(unseenSegRef.current, g.headPct, g.reachPct - g.headPct);
      seg(futureSegRef.current, g.reachPct, 100 - g.reachPct);
      if (futureSegRef.current) futureSegRef.current.hidden = !g.locked;
      if (liveMarkRef.current) {
        liveMarkRef.current.hidden = live == null;
        liveMarkRef.current.style.left = `${g.livePct}%`;
      }

      const input = inputRef.current;
      if (input) {
        input.max = String(g.maxIndex);
        // 슬라이더는 **닿을 수 있는 구간만** 덮는다 — 오른쪽 끝이 곧 스포일러였던 자리(#406 W0).
        input.style.width = `${g.livePct}%`;
        input.disabled = !seekRef.current || g.maxIndex <= 0;
        input.setAttribute("aria-valuemax", String(g.maxIndex));
        input.setAttribute("aria-valuenow", String(Math.min(headRef.current, g.maxIndex)));
        // 드래그 중에는 사용자 입력이 이긴다(핸들이 손에서 튀지 않게 — QA 스크럽과 같은 규칙).
        if (document.activeElement !== input) input.value = String(Math.min(headRef.current, g.maxIndex));
      }

      // 상한이 흐르면 새로 열린 핀이 여기서 붙는다(값이 같으면 React 가 리렌더를 건너뛴다).
      setShown((prev) => {
        const next = visiblePins();
        return sameTicks(prev, next) ? prev : next;
      });

      const past = pastRef.current && live != null;
      if (badgeRef.current) badgeRef.current.hidden = !past;
      if (nowRef.current) nowRef.current.hidden = !past;
    };
    if (handleRef) handleRef.current = { paint };
    paint();
    return () => {
      if (handleRef && handleRef.current?.paint === paint) handleRef.current = null;
    };
  }, [snapCount, pins, handleRef, headRef, liveRef, pastRef]);

  return (
    <div className={styles.seek} data-testid={`viewer-seek-bar-half${half}`}>
      <div className={styles.seekTop}>
        <span className={styles.seekBadge} data-testid={`viewer-seek-past-half${half}`} ref={badgeRef} hidden>
          ⏪ 과거 보는 중
        </span>
        <button
          type="button"
          className={styles.seekNow}
          data-testid={`viewer-seek-now-half${half}`}
          ref={nowRef}
          hidden
          onClick={() => seekRef.current?.toNow()}
        >
          현재로 ▶
        </button>
      </div>
      <span className={styles.seekTrack} data-testid={`viewer-seek-track-half${half}`} ref={trackRef}>
        <span className={`${styles.seg} ${styles.segPast}`} ref={pastSegRef} aria-hidden="true" />
        <span className={`${styles.seg} ${styles.segUnseen}`} ref={unseenSegRef} aria-hidden="true" />
        <span
          className={`${styles.seg} ${styles.segFuture}`}
          data-testid={`viewer-seek-future-half${half}`}
          ref={futureSegRef}
          aria-hidden="true"
        />
        <span
          className={styles.liveMark}
          data-testid={`viewer-seek-live-half${half}`}
          ref={liveMarkRef}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="range"
          min={0}
          step={1}
          defaultValue={0}
          className={styles.seekInput}
          data-testid={`viewer-seek-half${half}`}
          aria-label="시간바 (뒤로만 이동 — 아직 진행되지 않은 구간은 잠깁니다)"
          onInput={(e) => seekRef.current?.toIndex(Number((e.target as HTMLInputElement).value))}
        />
        {/* ⚠️ `pins` 가 아니라 `shown` 이다 — 미래 핀은 렌더 자체를 하지 않는다(계약 ②). */}
        {shown.map((p) => (
          <button
            key={`${p.kind}-${p.tick}`}
            type="button"
            className={`${styles.seekPin} ${p.major ? styles.seekPinMajor : ""}`}
            data-testid={`viewer-seek-pin-${p.tick}`}
            title={p.label}
            aria-label={p.label}
            style={{ left: `${p.pct}%`, background: p.color }}
            onClick={() => seekRef.current?.toScene(p.tick)}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * admin/QA 풀컨트롤 — 코어 컨트롤러 직접 조작(#169 S3). 뷰어 준비 전이면 비활성.
 * #177: 구 QA 뷰어 셸이 갖고 있던 **시계(분:초)·재생위치 추종 스크럽·타임라인 이벤트 핀**을
 * 여기로 되살렸다. hero 의 눈 QA 절차("몇 분 몇 초 장면을 지목하고 되돌려 본다")가 이것에 걸려 있다.
 */
function AdminControls({
  half,
  viewer,
  seek,
  clockRef,
  scrubRef,
  pins,
  snapCount,
  lastTick,
  nested = false,
}: {
  half: 1 | 2;
  viewer: ViewerController | null;
  /** 게이트를 지나는 시크 창구(#406 W3) — QA 도구도 라이브 상한을 우회하지 않는다. */
  seek: GatedSeek | null;
  clockRef?: RefObject<HTMLSpanElement>;
  scrubRef?: RefObject<HTMLInputElement>;
  pins?: TimelinePin[];
  snapCount: number;
  lastTick: number;
  /**
   * 돌려보기 화면의 "고급" 안에 들어갈 때 — 재생/처음·시계·시간바는 **바깥 줄이 소유**한다.
   * 여기서 또 그리면 같은 testid 가 화면에 둘이 되어 계약(그리고 사용자)이 어느 쪽인지 모른다.
   */
  nested?: boolean;
}) {
  const v = viewer;
  const disabled = !v;
  const gotoRef = useRef<HTMLInputElement>(null);

  // --- 초단위 이동(#180) ---
  // 정밀 이동은 **hooks.seek** 로만 한다: 컨트롤러의 jumpToTick 은 맥락용으로 3 스냅샷 되감기 때문에
  // (viewer.impl.mjs) "그 초에 정확히 선다"를 만족하지 못한다. 핀 클릭(장면 점프)만 jumpToTick 유지.
  // ⚠️ #406 W3: 호출은 전부 `seek`(게이트 창구)을 지난다 — 여기서 `hooks.seek`/`scrubTo` 를 직접
  //    부르면 QA 경로만 라이브 상한을 우회한다(그 상태로 앞을 보면 그게 곧 스포일러다).
  const hooks = () => v?.hooks as unknown as {
    cur?: () => { tick?: number; tickPosIdx?: number };
  } | undefined;
  const curTick = () => Number(hooks()?.cur?.()?.tick ?? 0);
  const curIndex = () => {
    const c = hooks()?.cur?.();
    return Number(c?.tickPosIdx ?? c?.tick ?? 0);
  };
  const seekTick = (tick: number) => seek?.toTick(tick);
  const stepSec = (delta: number) => seekTick(stepSeconds(curTick(), delta, lastTick));
  const stepFrame = (delta: number) => {
    if (snapCount <= 1) return;
    seek?.toIndex(curIndex() + delta);
  };
  const gotoClock = () => {
    const tick = parseClockInput(gotoRef.current?.value);
    if (tick == null) return;
    seekTick(tick);
  };

  // 키보드: ←/→ ∓1초, Shift+←/→ ∓5초, `,`/`.` ∓1프레임, Space 재생/정지.
  // 입력창 타이핑 중에는 무시한다(qa-key-action 이 판단).
  useEffect(() => {
    if (!v) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const action = qaKeyAction({ key: e.key, shiftKey: e.shiftKey, typing });
      if (!action) return;
      e.preventDefault(); // 스페이스/화살표의 페이지 스크롤 방지
      if (action.kind === "second") stepSec(action.delta);
      else if (action.kind === "frame") stepFrame(action.delta);
      else v.togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 콜백들은 매 렌더 새로 만들어지지만 참조는 v·범위값만 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, lastTick, snapCount]);
  return (
    <div className={styles.admin} data-testid={`viewer-admin-half${half}`}>
      {!nested && (
        <>
          <button
            type="button"
            className={styles.mode}
            data-testid={`viewer-play-toggle-half${half}`}
            disabled={disabled}
            onClick={() => v?.togglePlay()}
          >
            ⏯ 재생/정지
          </button>
          <button type="button" className={styles.mode} data-testid={`viewer-restart-half${half}`} disabled={disabled} onClick={() => v?.restart()}>
            ⟲ 처음
          </button>
        </>
      )}
      <span className={styles.speeds} role="group" aria-label="배속">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={styles.mode}
            data-testid={`viewer-speed-${s}-half${half}`}
            disabled={disabled}
            title={`연출 페이스의 ${s}배로 재생 (1x = 자연 페이스, 하이라이트 슬로우 유지)`}
            onClick={() => v?.setSpeed(s)}
          >
            {s}x
          </button>
        ))}
      </span>
      <button type="button" className={styles.mode} data-testid={`viewer-prev-goal-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("goal", -1)}>
        ◀골
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-next-goal-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("goal", 1)}>
        골▶
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-prev-shot-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("shot", -1)}>
        ◀슛
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-next-shot-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("shot", 1)}>
        슛▶
      </button>
      {/* 초단위 시간 컨트롤(#180) — 정확한 초에 세워 "mm:ss 에 X 발생" 이라 말할 수 있게. */}
      <span className={styles.timeGroup} role="group" aria-label="초단위 시간 이동">
        <button type="button" className={styles.mode} data-testid={`viewer-step-minus5s-half${half}`} disabled={disabled} title="5초 뒤로 (Shift+←)" onClick={() => stepSec(-5)}>
          ⏪5s
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-minus1s-half${half}`} disabled={disabled} title="1초 뒤로 (←)" onClick={() => stepSec(-1)}>
          ◀1s
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-minus1f-half${half}`} disabled={disabled} title="1프레임(스냅샷) 뒤로 (,)" onClick={() => stepFrame(-1)}>
          ◂f
        </button>
        {/* 경기 시계 — 코어 onClock 이 `12'34" / 24'00"` 로 매 프레임 갱신(호스트 ref 직접 조작). */}
        {!nested && (
          <span className={styles.clock} data-testid={`viewer-clock-half${half}`} ref={clockRef} aria-label="경기 시계" />
        )}
        <button type="button" className={styles.mode} data-testid={`viewer-step-plus1f-half${half}`} disabled={disabled} title="1프레임(스냅샷) 앞으로 (.)" onClick={() => stepFrame(1)}>
          f▸
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-plus1s-half${half}`} disabled={disabled} title="1초 앞으로 (→)" onClick={() => stepSec(1)}>
          1s▶
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-plus5s-half${half}`} disabled={disabled} title="5초 앞으로 (Shift+→)" onClick={() => stepSec(5)}>
          5s⏩
        </button>
        <input
          ref={gotoRef}
          type="text"
          inputMode="numeric"
          className={styles.goto}
          data-testid={`viewer-goto-half${half}`}
          placeholder="mm:ss"
          aria-label="mm:ss 로 이동"
          title="예: 12:34 · 입력 후 Enter"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              gotoClock();
            }
          }}
        />
      </span>
      {!nested && (
      <span className={styles.timeline} data-testid={`viewer-timeline-half${half}`}>
        {/* 눈금 = 스냅샷 인덱스(1칸 = 1스냅샷 = 리얼 로그에서 1초). % 눈금이면 한 칸이 5초를
            넘어가 "그 초"를 집을 수 없다(#180). 값 동기화는 호스트가 onScrub 으로 한다. */}
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={Math.max(1, snapCount - 1)}
          step={1}
          defaultValue={0}
          className={styles.scrub}
          data-testid={`viewer-scrub-half${half}`}
          disabled={disabled || snapCount <= 1}
          onInput={(e) => seek?.toIndex(Number((e.target as HTMLInputElement).value))}
          aria-label="스크럽(1칸 = 1초)"
        />
        {/* 키 장면 핀 — 클릭하면 그 틱으로 점프(구 QA 뷰어와 동일한 색·높이 규칙). */}
        {(pins ?? []).map((p) => (
          <button
            key={`${p.kind}-${p.tick}`}
            type="button"
            className={`${styles.pin} ${p.major ? styles.pinMajor : styles.pinMinor}`}
            data-testid={`viewer-pin-${p.tick}`}
            title={p.label}
            aria-label={p.label}
            disabled={disabled}
            style={{
              left: `${p.pct}%`,
              width: p.width,
              height: p.height,
              background: p.color,
              zIndex: p.z,
            }}
            onClick={() => seek?.toScene(p.tick)}
          />
        ))}
      </span>
      )}
    </div>
  );
}

/** 배속은 유저 화면에선 **한 버튼 순환**이다(6단 나열은 QA 도구다 — 고급으로 내렸다). */
const REVIEW_SPEEDS = [1, 2, 0.5] as const;

/**
 * 돌려보기 컨트롤 (#244) — "필요한 장면을 본다"를 유저 언어로.
 *
 *   [⏮ 이전 장면] ( ▶ ) [다음 장면 ⏭] [1x]
 *   12'34"                     ─ 한 축 타임라인(이벤트 마커 + 재생 핸들이 같은 트랙) ─
 *   8'12" 선방 · 12'34" 선제골 · 19'02" 유효슛 …   ← 이름으로 점프
 *
 * 그전에는 같은 정보가 버튼 21개 + 3층 타임라인으로 흩어져 있었다(재설계 진단).
 * ⚠️ 마커와 핸들이 **같은 트랙 위**에 있어야 "지금 어디"를 읽을 수 있다 — 레인을 나누지 말 것.
 */
function ReviewControls({
  half,
  viewer,
  seek,
  clockRef,
  scrubRef,
  pins,
  snapCount,
}: {
  half: 1 | 2;
  viewer: ViewerController | null;
  /** 게이트를 지나는 시크 창구(#406 W3). 돌려보기 화면은 보통 지나간 하프라 clamp 가 무해하지만,
   *  규칙은 한 곳이어야 한다 — 여기만 raw 로 두면 다음 사람이 그걸 복사한다. */
  seek: GatedSeek | null;
  clockRef?: RefObject<HTMLSpanElement>;
  scrubRef?: RefObject<HTMLInputElement>;
  pins?: TimelinePin[];
  snapCount: number;
}) {
  const v = viewer;
  const disabled = !v;
  const [speedIdx, setSpeedIdx] = useState(0);
  const scenes = [...(pins ?? [])].sort((a, b) => a.tick - b.tick);

  /** 지금 위치 기준 앞/뒤 장면. 없으면 처음/마지막으로 — 버튼이 죽은 것처럼 보이지 않게. */
  const jumpScene = (dir: 1 | -1) => {
    if (!v || scenes.length === 0) return;
    const cur = Number((v.hooks as unknown as { cur?: () => { tick?: number } })?.cur?.()?.tick ?? 0);
    const next =
      dir === 1
        ? (scenes.find((p) => p.tick > cur + 1) ?? scenes[scenes.length - 1])
        : ([...scenes].reverse().find((p) => p.tick < cur - 1) ?? scenes[0]);
    if (next) seek?.toScene(next.tick);
  };

  return (
    <div className={styles.review} data-testid={`viewer-review-half${half}`}>
      <div className={styles.transport}>
        <button
          type="button"
          className={styles.tbtn}
          data-testid={`viewer-prev-scene-half${half}`}
          disabled={disabled || scenes.length === 0}
          onClick={() => jumpScene(-1)}
        >
          ⏮ 이전 장면
        </button>
        <button
          type="button"
          className={styles.play}
          data-testid={`viewer-play-toggle-half${half}`}
          aria-label="재생/정지"
          disabled={disabled}
          onClick={() => v?.togglePlay()}
        >
          ▶
        </button>
        <button
          type="button"
          className={styles.tbtn}
          data-testid={`viewer-next-scene-half${half}`}
          disabled={disabled || scenes.length === 0}
          onClick={() => jumpScene(1)}
        >
          다음 장면 ⏭
        </button>
        <button
          type="button"
          className={styles.speed}
          data-testid={`viewer-speed-cycle-half${half}`}
          disabled={disabled}
          title="재생 속도"
          onClick={() => {
            const next = (speedIdx + 1) % REVIEW_SPEEDS.length;
            setSpeedIdx(next);
            v?.setSpeed(REVIEW_SPEEDS[next]!);
          }}
        >
          {REVIEW_SPEEDS[speedIdx]}x
        </button>
      </div>

      <div className={styles.trackRow}>
        <span className={styles.reviewClock} data-testid={`viewer-clock-half${half}`} ref={clockRef} aria-label="경기 시계" />
        <span className={styles.track} data-testid={`viewer-timeline-half${half}`}>
          <input
            ref={scrubRef}
            type="range"
            min={0}
            max={Math.max(1, snapCount - 1)}
            step={1}
            defaultValue={0}
            className={styles.reviewScrub}
            data-testid={`viewer-scrub-half${half}`}
            disabled={disabled || snapCount <= 1}
            onInput={(e) => seek?.toIndex(Number((e.target as HTMLInputElement).value))}
            aria-label="시간바 (드래그해서 장면 이동)"
          />
          {scenes.map((p) => (
            <button
              key={`${p.kind}-${p.tick}`}
              type="button"
              className={`${styles.marker} ${p.major ? styles.markerMajor : ""}`}
              data-testid={`viewer-pin-${p.tick}`}
              title={p.label}
              aria-label={p.label}
              disabled={disabled}
              style={{ left: `${p.pct}%`, background: p.color }}
              onClick={() => seek?.toScene(p.tick)}
            />
          ))}
        </span>
      </div>

      <ul className={styles.scenes} data-testid={`viewer-scenes-half${half}`}>
        {scenes.map((p) => (
          <li key={`s-${p.kind}-${p.tick}`}>
            <button
              type="button"
              className={p.major ? `${styles.scene} ${styles.sceneMajor}` : styles.scene}
              data-testid={`viewer-scene-${p.tick}`}
              disabled={disabled}
              onClick={() => seek?.toScene(p.tick)}
            >
              <span className={styles.sceneTime}>{p.clock}</span>
              <span className={styles.sceneName}>{sceneLabel(p)}</span>
              <span className={styles.sceneDot} style={{ background: p.color }} aria-hidden="true" />
            </button>
          </li>
        ))}
        {scenes.length === 0 && <li className={styles.scenesEmpty}>기록된 장면이 없습니다</li>}
      </ul>
    </div>
  );
}

/** 핀 툴팁(`12'34" · GOAL`)은 QA 표기다 — 리스트에는 사람 말로 적는다. */
function sceneLabel(p: TimelinePin): string {
  switch (p.kind) {
    case "goal":
      return "골";
    case "penalty":
      return "페널티킥";
    case "save":
      return "선방";
    case "shot_on":
      return "유효슛";
    case "corner":
      return "코너킥";
    default:
      return p.label;
  }
}
