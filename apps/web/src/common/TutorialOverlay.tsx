import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { computeBubbleLayout, isTargetUsable } from "./tutorial-logic";
import type { BubbleLayout, Rect } from "./tutorial-logic";
import type { TutorialStep } from "./tutorial-steps";
import styles from "./Tutorial.module.css";

interface TutorialOverlayProps {
  step: TutorialStep;
  /** 0-based, 실행 대상(enabled) 스텝 기준. */
  index: number;
  total: number;
  onNext: () => void;
  onSkip: () => void;
  /** 대상이 없거나 화면 밖 — 이 스텝은 건너뛴다(깨짐 0, 무한 대기 0). */
  onMissingTarget: () => void;
  /**
   * 이 스텝을 **실제로 화면에 그렸다**고 알린다(진행 상태의 SoT).
   * 건너뛰어진 스텝은 여기 안 걸리므로 완료 판정에서 자동으로 빠진다.
   */
  onShown: (stepId: string) => void;
  /**
   * 이번 '다음'으로 튜토리얼이 끝나는가(=아직 못 본 스텝이 더 없다).
   * 위치(마지막 인덱스)가 아니라 **seen 집합**으로 결정되므로 provider 가 계산해 내려준다.
   */
  isLast: boolean;
  /**
   * 대상을 못 찾았을 때 스킵으로 확정하기까지의 유예(ms).
   * 라우트 전환·지연 렌더 직후의 **일시적** 부재를 영구 스킵으로 오인하지 않기 위한 창.
   * 0 이면 즉시 스킵(테스트).
   */
  missingGraceMs?: number;
}

/** 말풍선 최대 폭 / 화면 여백 — 폭을 JS 가 확정해 CSS 와 어긋날 여지를 없앤다(AC-B2). */
const BUBBLE_MAX_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

const FOCUSABLE = 'button:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** 첫 렌더에서 실측 전 쓰는 높이 추정치 — 곧바로 실측으로 교체된다. */
const INITIAL_BUBBLE_HEIGHT = 150;

/** 0.5px 미만 차이는 같은 위치로 본다(불필요한 리렌더 차단). */
function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * 코치마크 말고 **다른** 다이얼로그가 떠 있는가(모달·확인창).
 * 열려 있으면 코치마크를 감춘다 — 안 그러면 z-index 상 말풍선이 모달 위에 남아
 * 옵션을 가리고 딤이 이중으로 겹친다(실제 증빙: 모드 선택 모달 전면 가림).
 */
function hasForeignDialog(self: Element | null): boolean {
  const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]');
  for (const d of dialogs) {
    if (d === self) continue;
    if (self && self.contains(d)) continue;
    return true;
  }
  return false;
}

/**
 * 코치마크 오버레이 (PRD-v4 §B, AC-B2).
 * - 대상 주변 4분할 딤 + 하이라이트 링(대상 자체는 뚫려 보인다).
 * - 말풍선은 `computeBubbleLayout` 으로 대상을 가리키고 화면 안에 clamp 된다.
 * - 매 프레임 대상 추적. 대상이 사라지면(유예 경과 후) 다음 스텝으로.
 * - **비-모달**: 딤은 시각 강조일 뿐 입력을 막지 않는다. role="dialog"+라벨만 두고
 *   aria-modal·포커스 트랩은 두지 않는다. ESC=건너뛰기.
 */
export function TutorialOverlay({
  step,
  index,
  total,
  onNext,
  onSkip,
  onMissingTarget,
  onShown,
  isLast,
  missingGraceMs = 400,
}: TutorialOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [bubbleHeight, setBubbleHeight] = useState(INITIAL_BUBBLE_HEIGHT);
  /** 다른 모달이 열려 있어 잠시 비켜난 상태(스텝은 그대로 유지). */
  const [suppressed, setSuppressed] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * 대상을 놓치기 시작한 시각(ms). **경과 시간**으로 유예를 판단한다 —
   * 폴링 횟수로 세면 스크롤/리사이즈로 measure 가 자주 불릴 때 수십 ms 만에 유예가
   * 소진돼 멀쩡한 대상을 '없음'으로 확정해 버린다.
   */
  const missSince = useRef<number | null>(null);

  /**
   * 대상 위치를 다시 재고 반영한다(매 프레임 + 스크롤/리사이즈).
   * 로비는 지연 쿼리 응답이 오면 콘텐츠가 늘어나 대상이 아래로 밀리는데(실측 78px),
   * 그때 어떤 이벤트도 발생하지 않아 1회 측정만 하면 옛 위치에 남는다(AC-B2 위반).
   */
  const measure = useCallback(() => {
    // 다른 다이얼로그(모달)가 열려 있으면 코치마크는 비켜준다 — 말풍선이 모달 옵션을
    // 덮어 선택 자체를 막았다(AC-B2 위반). 이때는 '대상 부재'로 세지 않는다.
    if (hasForeignDialog(dialogRef.current)) {
      missSince.current = null;
      setSuppressed(true);
      return;
    }
    setSuppressed(false);

    const vp = { width: window.innerWidth, height: window.innerHeight };
    const el = document.querySelector(`[data-testid="${step.targetTestId}"]`);
    const next = el ? toRect(el) : null;

    if (!isTargetUsable(next, vp)) {
      setRect(null);
      // 라우트 전환 직후의 일시적 부재를 영구 스킵으로 오인하지 않는다(경과 시간 기준).
      const now = performance.now();
      if (missSince.current === null) missSince.current = now;
      if (now - missSince.current >= missingGraceMs) onMissingTarget();
      return;
    }

    missSince.current = null;
    setViewport((prev) =>
      prev.width === vp.width && prev.height === vp.height ? prev : vp,
    );

    setRect((prev) => (prev && sameRect(prev, next!) ? prev : next));
  }, [step.targetTestId, missingGraceMs, onMissingTarget]);

  // 스텝 전환 즉시 1회 + 뒤이은 두 프레임에 한 번 더(마운트 직후 레이아웃 안정화 대비).
  useLayoutEffect(() => {
    missSince.current = null;
    measure();
    let second = 0;
    const first = requestAnimationFrame(() => {
      measure();
      second = requestAnimationFrame(measure);
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [measure]);

  // 이후에는 매 프레임 추적 + 스크롤(중첩 스크롤러 포함 — capture)·리사이즈·방향전환.
  useEffect(() => {
    // **매 프레임** 추적한다. 대상이 '움직이기만' 할 때(지연 쿼리로 위 콘텐츠가 늘어나 버튼이
    // 아래로 밀림)는 body 크기가 그대로라 ResizeObserver 가 못 잡고, 간격을 두고 재면 그만큼
    // 링이 엉뚱한 위치에 남는 프레임이 실제로 보였다(캡처로 확인). rect 읽기 1회/프레임이라
    // 비용은 무시할 수준이고, 오버레이가 떠 있는 동안에만 돈다.
    let raf = requestAnimationFrame(function tick() {
      measure();
      raf = requestAnimationFrame(tick);
    });
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    ro?.observe(document.body);

    // 모달 개폐를 다음 프레임까지 기다리지 않고 즉시 반영한다.
    // 자기 자신(코치마크)의 DOM 변화는 무시해 되먹임을 막는다.
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            const self = dialogRef.current;
            const foreign = records.some((r) => !(self && self.contains(r.target as Node)));
            if (foreign) measure();
          });
    mo?.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [measure]);

  // 말풍선 **높이**만 실측한다(텍스트 길이에 따라 달라짐). 폭은 JS 가 확정하므로
  // 추정 폭으로 배치했다가 실측 폭과 어긋나 화면 밖으로 나가는 일이 없다(AC-B2).
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node) return;
    const h = node.getBoundingClientRect().height;
    setBubbleHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, [rect, viewport.width, step.id]);

  // 실제로 그려진 스텝만 '봤다'로 보고한다(딤만 뜬 상태·모달에 가린 상태는 제외).
  useEffect(() => {
    if (!rect || suppressed) return;
    onShown(step.id);
  }, [rect, suppressed, step.id, onShown]);

  // 스텝이 바뀌면 '다음' 버튼으로 포커스를 옮긴다(키보드 진행).
  useEffect(() => {
    if (!rect) return;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [rect, step.id]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onSkip();
      }
      // Tab 은 가두지 않는다 — 비-모달이므로 뒤 화면으로 자연스럽게 빠져나가야 한다
      // (가두면 aria 계약·실제 조작과 어긋나고, 키보드로 로그아웃 같은 조작이 불가능해진다).
      // 스텝이 열리면 '다음'에 포커스를 주므로 키보드만으로 진행하는 데는 지장이 없다.
    },
    [onSkip],
  );

  if (suppressed || !rect) return null;

  // 폭은 화면에 맞춰 JS 가 정하고(=렌더 폭과 동일), 높이만 실측값을 쓴다.
  const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  const layout: BubbleLayout = computeBubbleLayout(
    rect,
    viewport,
    { width: bubbleWidth, height: bubbleHeight },
    { margin: VIEWPORT_MARGIN },
  );
  const pad = 6;
  const holeLeft = Math.max(rect.left - pad, 0);
  const holeTop = Math.max(rect.top - pad, 0);
  const holeRight = Math.min(rect.left + rect.width + pad, viewport.width);
  const holeBottom = Math.min(rect.top + rect.height + pad, viewport.height);

  return (
    <div
      className={styles.root}
      data-testid="tutorial-overlay"
      role="dialog"
      // aria-modal 은 선언하지 않는다 — 이 코치마크는 **비-모달**이다(딤이 입력을 막지 않고
      // 뒤의 UI 를 그대로 쓸 수 있다). modal 이라고 알리면 스크린리더에게 "뒤는 못 쓴다"고
      // 거짓말을 하게 되고, 실제 상호작용과 어긋난다.
      aria-labelledby="tutorial-title"
      aria-describedby="tutorial-body"
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      {/* 대상 주변만 딤 — 대상 영역은 뚫려 있어 실제 UI 가 그대로 보인다. */}
      <div className={styles.dim} style={{ left: 0, top: 0, width: "100%", height: holeTop }} />
      <div
        className={styles.dim}
        style={{ left: 0, top: holeBottom, width: "100%", height: Math.max(viewport.height - holeBottom, 0) }}
      />
      <div
        className={styles.dim}
        style={{ left: 0, top: holeTop, width: holeLeft, height: Math.max(holeBottom - holeTop, 0) }}
      />
      <div
        className={styles.dim}
        style={{
          left: holeRight,
          top: holeTop,
          width: Math.max(viewport.width - holeRight, 0),
          height: Math.max(holeBottom - holeTop, 0),
        }}
      />

      <div
        className={styles.highlight}
        data-testid="tutorial-highlight"
        style={{
          left: holeLeft,
          top: holeTop,
          width: Math.max(holeRight - holeLeft, 0),
          height: Math.max(holeBottom - holeTop, 0),
        }}
      />

      <div
        className={styles.bubble}
        data-testid="tutorial-bubble"
        data-step-id={step.id}
        data-placement={layout.placement}
        ref={bubbleRef}
        style={{ left: layout.left, top: layout.top, width: bubbleWidth }}
      >
        <span
          className={styles.arrow}
          data-testid="tutorial-arrow"
          style={{ left: layout.arrowLeft }}
          aria-hidden="true"
        />
        {/* 스텝이 바뀌면 제목·본문·진행도를 스크린리더가 다시 읽도록 라이브 영역으로 묶는다
            (오버레이 자체는 한 번만 마운트되므로 안 묶으면 전환이 전혀 전달되지 않는다). */}
        <div aria-live="polite" aria-atomic="true">
          <p className={styles.progress} data-testid="tutorial-progress">
            {index + 1} / {total}
          </p>
          <h2 className={styles.title} id="tutorial-title" data-testid="tutorial-title">
            {step.title}
          </h2>
          <p className={styles.body} id="tutorial-body" data-testid="tutorial-body">
            {step.body}
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.next}
            data-testid="tutorial-next"
            onClick={onNext}
          >
            {isLast ? "시작하기" : "다음"}
          </button>
          <button
            type="button"
            className={styles.skip}
            data-testid="tutorial-skip"
            onClick={onSkip}
          >
            건너뛰기
          </button>
        </div>
      </div>
    </div>
  );
}
