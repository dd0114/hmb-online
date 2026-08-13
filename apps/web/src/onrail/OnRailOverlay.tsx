import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { computeBubbleLayout, isTargetUsable } from "../common/tutorial-logic";
import type { BubbleLayout, Rect } from "../common/tutorial-logic";
import { shieldFor, targetRefusesInput } from "./onrail-logic";
import type { OnRailShield } from "./onrail-logic";
import type { OnRailStep } from "./onrail-script";
import styles from "./OnRail.module.css";

interface OnRailOverlayProps {
  step: OnRailStep;
  /** 이미 치환된 대상 testid. `null` = 대상 없는 전면 안내. */
  targetTestId: string | null;
  index: number;
  total: number;
  /** [다음]·CTA 를 눌렀다. */
  onAdvance: () => void;
  /** `skipIfMissing` 스텝의 대상이 끝내 안 나타났다. */
  onMissingTarget: () => void;
  /**
   * 대상이 **화면에 있는데 입력을 거절한다**(#493 W9) — 유예 내내 그랬다.
   *
   * ⚠️ `onMissingTarget` 과 **다른 문**이다. 없는 것은 나타날 수 있으니 각본이 허락한 스텝만
   * 넘기지만(hold 가 기본), 거절하는 것은 이 유저에게 **열리지 않는다** — 쿠폰이 없고 후보가
   * 없으니 기다려도 오지 않는다. 그래서 `skipIfMissing` 과 무관하게 걸린다.
   */
  onTargetDisabled?: () => void;
  /** 탈출구 — 갇힘 방지. 무엇을 하는지는 호출부가 정한다(라벨도 같이 넘긴다). */
  onExit: () => void;
  /**
   * 탈출구 라벨. **동작과 반드시 같은 말이어야 한다** — 진행도를 남기고 나가는 문에 "그만두기"라고
   * 쓰면 유저는 튜토리얼을 버린 줄 알고, 실제로는 홈에 이어하기 카드가 떠 혼란이 된다.
   */
  exitLabel?: string;
  /**
   * 지금은 부재를 **확정하지 않는다**(#493 W11) — `skipIfMissing` 스텝이어도 기다린다.
   *
   * 호출부가 "손잡이가 없는 것이 이 유저의 사정이 아니라 **화면이 아직 안 열린 것**"임을 아는
   * 경우에만 참이다(무대가 열리기 전 브리핑·GEN 창). 부재 판정은 DOM 만 보므로 그 구분을
   * 오버레이 혼자서는 할 수 없다 — 그래서 프로바이더가 알려 준다.
   */
  holdMissing?: boolean;
  /** 대상 부재를 '없음'으로 확정하기까지의 유예(ms). 0 이면 즉시(테스트). */
  missingGraceMs?: number;
  /**
   * 비활성을 '못 한다'로 확정하기까지의 유예(ms) — **부재보다 길다**.
   *
   * `disabled` 는 순간적일 수 있다: [저장]은 저장 중에 잠기고(`busy`), AUTO 도 뮤테이션이 도는
   * 동안 잠긴다. 짧게 잡으면 **느린 네트워크에서 정상 스텝이 건너뛰어진다** — 스킵은 되돌릴 수
   * 없으니 이쪽 오판이 훨씬 비싸다. 그래서 "잠깐 잠긴 것"과 "이 유저에겐 안 열리는 것"을
   * 가르는 값은 넉넉하게 둔다.
   */
  disabledGraceMs?: number;
  /**
   * 말풍선이 대신 말해 주는 실패 한 줄 (#493 W8-v3).
   *
   * ⚠️ 온레일이 뜬 화면에서는 **다른 알림 채널이 유저에게 도달하지 않는다** — 딤이 화면을 덮고
   * `ErrorToast` 는 그 아래로 깔린다. 그래서 CTA 가 서버에 닿았다가 실패하면 여기서 말한다.
   */
  note?: string | null;
}

const BUBBLE_MAX_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
/** 화면 밖 대상을 끌어오는 재시도 간격(ms) — 부드러운 스크롤이 자기를 재시작하지 않을 만큼. */
const SCROLL_RETRY_MS = 400;

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
 * 온레일 오버레이 (#493 W7-v3) — **막는** 코치마크.
 *
 * `common/TutorialOverlay` 와 그림은 닮았지만 성질이 반대다:
 *  · 딤이 **입력을 실제로 막는다**(`OnRail.module.css` 의 그 한 줄). 허용된 것은 대상 구멍과
 *    말풍선뿐이다 — hero: *"거의 정해진 화면에서 유저가 선택할 여유가 없이 강제해야돼."*
 *  · 대상이 없으면 **기다린다**(렌더 0). 코치마크처럼 스텝을 버리면 다음 스텝의 전제가 무너진다.
 *    `skipIfMissing` 스텝만 유예 뒤 넘어간다.
 *  · 남의 다이얼로그가 뜨면 `shieldFor` 판정에 따라 **비켜나거나**(확인창) **안내만
 *    남긴다**(대상이 그 모달 안일 때). 판정은 순수 함수라 화면에 규칙이 흩어지지 않는다.
 *
 * ⚠️ **`aria-modal` 을 선언한다** — 코치마크는 비-모달이라 안 붙였지만(뒤를 쓸 수 있으니까)
 * 온레일은 실제로 뒤를 못 쓴다. 여기서 거짓말을 하면 스크린리더 사용자는 존재하지 않는
 * 선택지를 탐색하게 된다.
 */
export function OnRailOverlay({
  step,
  targetTestId,
  index,
  total,
  onAdvance,
  onMissingTarget,
  onTargetDisabled,
  onExit,
  exitLabel = "나중에",
  holdMissing = false,
  missingGraceMs = 1500,
  disabledGraceMs = 2500,
  note = null,
}: OnRailOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [shield, setShield] = useState<OnRailShield>("block");
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [bubbleHeight, setBubbleHeight] = useState(150);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  /** 대상을 놓치기 시작한 시각(ms) — **경과 시간**으로 유예를 판단한다(폴링 횟수로 세면
   *  스크롤/리사이즈로 measure 가 잦을 때 수십 ms 만에 소진된다, TutorialOverlay 선례). */
  const missSince = useRef<number | null>(null);
  /** 대상이 입력을 거절하기 시작한 시각(ms) — 위와 같은 이유로 **경과 시간**으로 잰다. */
  const refuseSince = useRef<number | null>(null);
  /**
   * 이 스텝에서 대상이 **한 번이라도 눌릴 수 있었나**.
   *
   * ⚠️ 이 래치가 "잠깐 잠긴 것"과 "이 유저에겐 안 열리는 것"을 실제로 가른다. [저장]은 저장 중에
   * `busy` 로 잠기는데(`DeckPage.saveDisabled`), 서버가 느려 그 잠금이 유예를 넘기면 **정상적으로
   * 저장을 누른 유저의 스텝이 건너뛰어진다**. 그래서 **도착한 뒤 줄곧 거절해 온 대상만** 넘긴다 —
   * 쿠폰 없음·후보 없음은 처음부터 끝까지 거절이므로 이 래치가 서지 않는다.
   */
  const everUsableRef = useRef(false);
  /** 마지막으로 대상을 화면 안으로 끌어온 시각 — 매 프레임 스크롤을 다시 걸지 않기 위한 스로틀. */
  const lastScrollAt = useRef(0);

  /** 대상 없는 전면 안내(완주 연출)는 잴 것이 없다. */
  const centered = targetTestId === null;

  const measure = useCallback(() => {
    const vp = { width: window.innerWidth, height: window.innerHeight };
    setViewport((prev) => (prev.width === vp.width && prev.height === vp.height ? prev : vp));

    const el = targetTestId
      ? document.querySelector(`[data-testid="${targetTestId}"]`)
      : null;

    // 남의 다이얼로그 판정은 대상 유무와 무관하게 매번 한다(모달이 열리고 닫히는 그 프레임에
    // 곧바로 따라가야 확인창이 가려지지 않는다).
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'),
    ).filter((d) => !(dialogRef.current && (d === dialogRef.current || dialogRef.current.contains(d))));
    setShield(shieldFor(el, dialogs));

    if (centered) {
      missSince.current = null;
      refuseSince.current = null;
      return;
    }

    /*
     * **거절 판정은 부재 판정보다 앞이다** (#493 W9). 비활성 버튼도 사각형은 멀쩡하므로 아래
     * `isTargetUsable` 를 통과하고, 그러면 레일은 "대상을 찾았다"고 판단해 **영원히 기다린다**.
     * 그게 W8-v3 blocker B2·B6 의 형태였다.
     */
    if (targetRefusesInput(el)) {
      const now = performance.now();
      if (refuseSince.current === null) refuseSince.current = now;
      // 한 번이라도 눌릴 수 있었으면 지금의 잠금은 **이 화면의 사정**이지 유저의 자격이 아니다.
      if (!everUsableRef.current && now - refuseSince.current >= disabledGraceMs) onTargetDisabled?.();
      // ⚠️ **return 하지 않는다** — 넘어가기 전까지는 그 버튼을 계속 비춘다. 유예 동안 화면이
      //    비면 유저에게는 튜토리얼이 깜빡 죽은 것으로 보인다.
    } else {
      refuseSince.current = null;
      // ⚠️ 대상이 **있을 때만** 세운다 — 아직 렌더 전(`el === null`)은 "눌릴 수 있었다"가 아니다.
      //    여기서 null 을 통과시키면 래치가 도착 즉시 서서 이 기능 전체가 무효가 된다.
      if (el) everUsableRef.current = true;
    }

    const next = el ? toRect(el) : null;
    if (!isTargetUsable(next, vp)) {
      setRect(null);
      /*
       * ⚠️ **대상이 화면 밖이면 끌어온다** — 온레일에서는 이게 편의가 아니라 필수다.
       *
       * 코치마크는 딤이 입력을 막지 않으니 대상이 접혀 있어도 유저가 스스로 스크롤해 찾아갈 수
       * 있다. 온레일은 **나머지를 전부 막아 놓고** 그 하나만 허용하므로, 그것이 접힌 자리에
       * 있으면 유저에게 남는 선택지가 0 이 된다(스크롤조차 딤이 받는다). 실측으로 그 상태를
       * 밟았다: 1280×720 데스크탑에서 [⚡ 자동 채우기]가 보드 아래 접혀 있어 첫 스텝이 통째로
       * 스킵됐다(`document.elementFromPoint` 가 null = 뷰포트 밖).
       *
       * **요소가 있는데 밖일 때만** 건다(없으면 스크롤할 대상이 없다). 매 프레임 다시 걸면
       * 부드러운 스크롤이 자기 자신을 계속 재시작하므로 스로틀을 둔다.
       */
      if (el && performance.now() - lastScrollAt.current > SCROLL_RETRY_MS) {
        lastScrollAt.current = performance.now();
        el.scrollIntoView({ block: "center", inline: "center" });
      }
      // ⚠️ 기다리는 것이 기본이다. 넘기는 것은 그렇게 하겠다고 **각본에 적힌** 스텝뿐이고,
      //    그마저도 화면이 아직 안 열린 동안에는 유예한다(`holdMissing`, #493 W11).
      if (!step.skipIfMissing || holdMissing) {
        missSince.current = null;
        return;
      }
      const now = performance.now();
      if (missSince.current === null) missSince.current = now;
      if (now - missSince.current >= missingGraceMs) onMissingTarget();
      return;
    }

    missSince.current = null;
    setRect((prev) => (prev && sameRect(prev, next!) ? prev : next));
  }, [
    targetTestId,
    centered,
    step.skipIfMissing,
    holdMissing,
    missingGraceMs,
    onMissingTarget,
    disabledGraceMs,
    onTargetDisabled,
  ]);

  // 스텝 전환 즉시 1회 + 뒤이은 두 프레임에 한 번 더(마운트 직후 레이아웃 안정화 대비).
  useLayoutEffect(() => {
    missSince.current = null;
    refuseSince.current = null;
    everUsableRef.current = false; // 래치는 **스텝마다** 새로 판정한다
    lastScrollAt.current = 0;
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
    let raf = requestAnimationFrame(function tick() {
      measure();
      raf = requestAnimationFrame(tick);
    });
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [measure]);

  // 말풍선 **높이**만 실측한다(폭은 JS 가 확정하므로 렌더 폭과 어긋날 여지가 없다).
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node) return;
    const h = node.getBoundingClientRect().height;
    setBubbleHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, [rect, viewport.width, step.id, centered]);

  if (shield === "hidden") return null;
  if (!centered && !rect) return null; // hold — 대상이 나타날 때까지 조용히 기다린다

  const blocking = shield === "block";
  const advance = step.advance;

  const chrome = (
    <>
      <p className={styles.progress} data-testid="onrail-progress">
        {index} / {total}
      </p>
      <h2 className={styles.title} id="onrail-title" data-testid="onrail-title">
        {step.title}
      </h2>
      <p className={styles.body} id="onrail-body" data-testid="onrail-body">
        {step.body}
      </p>
      {note && (
        <p className={styles.note} data-testid="onrail-note" role="alert">
          {note}
        </p>
      )}
      <div className={styles.actions}>
        {advance.kind === "action" ? (
          <span className={styles.await} data-testid="onrail-await" role="status">
            직접 해보세요
          </span>
        ) : (
          <button
            type="button"
            className={styles.next}
            data-testid="onrail-next"
            onClick={onAdvance}
          >
            {advance.kind === "cta" ? advance.label : "다음"}
          </button>
        )}
        {/* 갇힘 방지 탈출구 — **어느 스텝에서나 하나는 있다**(스토리보드 엣지 표: *"온레일 중에도
            홈 복귀 탈출구 1개는 유지"*). 진행 중에는 진행도를 지우지 않는다 — 나갔다 돌아오면
            이 스텝부터 이어진다. 그래서 기본 라벨이 "그만두기"가 아니라 "나중에"다. */}
        <button type="button" className={styles.exit} data-testid="onrail-exit" onClick={onExit}>
          {exitLabel}
        </button>
      </div>
    </>
  );

  if (centered) {
    return (
      <div
        className={styles.root}
        data-testid="onrail-overlay"
        data-step-id={step.id}
        data-shield={shield}
        data-mode="centered"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onrail-title"
        aria-describedby="onrail-body"
        ref={dialogRef}
      >
        <div
          className={styles.dim}
          data-testid="onrail-dim"
          data-blocking={blocking ? "true" : "false"}
          style={{ left: 0, top: 0, width: "100%", height: "100%" }}
        />
        <div
          className={`${styles.bubble} ${styles.centered}`}
          data-testid="onrail-bubble"
          data-step-id={step.id}
          ref={bubbleRef}
        >
          {chrome}
        </div>
      </div>
    );
  }

  const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  const layout: BubbleLayout = computeBubbleLayout(
    rect!,
    viewport,
    { width: bubbleWidth, height: bubbleHeight },
    { margin: VIEWPORT_MARGIN },
  );
  const pad = 6;
  const holeLeft = Math.max(rect!.left - pad, 0);
  const holeTop = Math.max(rect!.top - pad, 0);
  const holeRight = Math.min(rect!.left + rect!.width + pad, viewport.width);
  const holeBottom = Math.min(rect!.top + rect!.height + pad, viewport.height);
  const blockAttr = blocking ? "true" : "false";

  return (
    <div
      className={styles.root}
      data-testid="onrail-overlay"
      data-step-id={step.id}
      data-shield={shield}
      data-mode="target"
      role="dialog"
      aria-modal={blocking ? "true" : undefined}
      aria-labelledby="onrail-title"
      aria-describedby="onrail-body"
      ref={dialogRef}
    >
      {/* 대상 주변만 딤 — 대상 영역은 **구멍**이라 그 요소가 그대로 눌린다(덮지 않는다).
          `guide-only`(모달 안 대상)에서는 같은 판을 그리되 막지 않는다. */}
      <div
        className={styles.dim}
        data-testid="onrail-dim"
        data-blocking={blockAttr}
        style={{ left: 0, top: 0, width: "100%", height: holeTop }}
      />
      <div
        className={styles.dim}
        data-testid="onrail-dim"
        data-blocking={blockAttr}
        style={{
          left: 0,
          top: holeBottom,
          width: "100%",
          height: Math.max(viewport.height - holeBottom, 0),
        }}
      />
      <div
        className={styles.dim}
        data-testid="onrail-dim"
        data-blocking={blockAttr}
        style={{ left: 0, top: holeTop, width: holeLeft, height: Math.max(holeBottom - holeTop, 0) }}
      />
      <div
        className={styles.dim}
        data-testid="onrail-dim"
        data-blocking={blockAttr}
        style={{
          left: holeRight,
          top: holeTop,
          width: Math.max(viewport.width - holeRight, 0),
          height: Math.max(holeBottom - holeTop, 0),
        }}
      />

      <div
        className={styles.highlight}
        data-testid="onrail-highlight"
        style={{
          left: holeLeft,
          top: holeTop,
          width: Math.max(holeRight - holeLeft, 0),
          height: Math.max(holeBottom - holeTop, 0),
        }}
      />

      <div
        className={styles.bubble}
        data-testid="onrail-bubble"
        data-step-id={step.id}
        data-placement={layout.placement}
        ref={bubbleRef}
        style={{ left: layout.left, top: layout.top, width: bubbleWidth }}
      >
        <span
          className={styles.arrow}
          data-testid="onrail-arrow"
          style={{ left: layout.arrowLeft }}
          aria-hidden="true"
        />
        <div aria-live="polite" aria-atomic="true">
          {chrome}
        </div>
      </div>
    </div>
  );
}
