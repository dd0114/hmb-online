import { useEffect, useMemo, useRef, useState } from "react";
import { GRADE_GLOW_COLORS, type Grade } from "./grades";
import {
  FX_CONFIG,
  fxAccentOf,
  fxMarks,
  fxRevealed,
  fxPhaseAt,
  fxTierOf,
  isDisguised,
  type FxConfig,
  type FxPhase,
  type FxTier,
  type FxTimings,
  type FxVariant,
} from "./gacha-fx";
import styles from "./GachaFx.module.css";

/**
 * 개봉 게이트·변주 타입은 **순수 모듈(`gacha-fx.ts`)이 소유**한다. 소비자가 어디서 가져올지
 * 헷갈리지 않게 여기서도 재수출만 한다 — 정의를 두 곳에 두면 조용히 갈라진다.
 */
export { fxRevealed };
export type { FxVariant };

/**
 * 고레어(에픽 이상) 뽑기 이펙트 — **보이는 층**(#250). 판정·타이밍은 `gacha-fx.ts`(순수)가 소유.
 *
 * ⚠️ W1(시안) 단계라 **연출안 3종(A/B/C)이 같이 들어 있다** — hero 가 로컬 프리뷰
 * (`/design/gacha-fx`)에서 눈으로 고르는 대상이다. 컨펌된 안만 W2 에서 남기고 나머지는 지운다.
 *
 * 성능 규칙(모바일 390):
 *  · 애니메이션은 `transform`·`opacity` 만 — layout/paint 를 유발하는 속성은 키프레임에 넣지 않는다.
 *  · 파티클 수는 `FX_CONFIG.particles` 한 곳. 좁은 화면에서 자동으로 줄어든다.
 *  · 재생이 끝나면 오버레이 DOM 을 **언마운트**한다(잔여 컴포지팅 레이어를 남기지 않는다).
 *
 * 접근성: `prefers-reduced-motion: reduce` 면 축약 타이밍(`reducedTimings`) + 이동 파티클 제거.
 * 완전히 끄지는 않는다 — 연출이 사라지면 "고레어를 뽑았다"는 정보 자체가 화면에서 빠진다.
 */

// ── 시계 ─────────────────────────────────────────────────────────────────────

export function usePrefersReducedMotion(): boolean {
  const [v, setV] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setV(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return v;
}

export interface RevealFxOptions {
  /** 0 = 미재생(카드는 뒷면 그대로). 값이 바뀔 때마다 처음부터 재생한다. */
  runId: number;
  /** 재생 시작을 늦춘다(일괄 공개 스태거). */
  startDelay?: number;
  /** 단계가 바뀔 때마다 호출(피날레 트리거 등). */
  onPhase?: (phase: FxPhase) => void;
  cfg?: FxConfig;
}

/**
 * 카드 1장의 단계 시계 — 경계마다 타이머 하나씩. 프레임마다 setState 하지 않는다(rAF 루프 없음).
 *
 * **개별 탭과 일괄 공개가 같은 시계를 쓴다.** 경로마다 따로 구현하면 두 경로의 연출이 조용히
 * 갈라진다(#250 요구가 "두 경로 모두"라 그게 곧 결함이다) — 차이는 `startDelay` 하나뿐이다.
 */
export function useRevealFx(tier: FxTier, timings: FxTimings, opts: RevealFxOptions): FxPhase {
  const { runId, startDelay = 0, onPhase } = opts;
  const [phase, setPhase] = useState<FxPhase>("idle");
  const timers = useRef<number[]>([]);
  // 콜백은 매 렌더 새 함수라 의존성에 넣으면 재생이 중간에 끊긴다 — ref 로 최신값만 본다.
  const cb = useRef(onPhase);
  cb.current = onPhase;

  useEffect(() => {
    const clear = () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
    clear();
    if (runId === 0) {
      setPhase("idle");
      return;
    }
    const emit = (p: FxPhase) => {
      setPhase(p);
      cb.current?.(p);
    };
    // 이펙트가 없는 등급은 지연 0 — 지금과 똑같이 즉시 뒤집힌다(대조군이 느려지면 안 된다).
    if (tier === "none") {
      timers.current.push(window.setTimeout(() => emit("done"), startDelay));
      return clear;
    }
    // 경계 계산은 순수 모듈이 소유한다(중복 없음이 거기서 계약으로 박혀 있다).
    const marks = fxMarks(tier, timings);
    for (const at of marks) {
      // at=0 은 fxPhaseAt 로도 "charge" 지만, 지연 0 재생에서 첫 프레임을 놓치지 않게 명시한다.
      timers.current.push(window.setTimeout(() => emit(at === 0 ? "charge" : fxPhaseAt(at, tier, timings)), startDelay + at));
    }
    return clear;
  }, [tier, timings, runId, startDelay]);

  return phase;
}

/** 지금 쓸 타이밍(모션 선호 반영). 참조가 매 렌더 바뀌지 않게 메모한다. */
export function useFxTimings(cfg: FxConfig = FX_CONFIG): { timings: FxTimings; reduced: boolean } {
  const reduced = usePrefersReducedMotion();
  const timings = useMemo(() => (reduced ? cfg.reducedTimings : cfg.timings), [reduced, cfg]);
  return { timings, reduced };
}

// ── 카드 위 이펙트 ───────────────────────────────────────────────────────────

export interface CardFxProps {
  grade: Grade;
  phase: FxPhase;
  variant: FxVariant;
  /**
   * 지금 재생 중인 타이밍. **CSS 로 그대로 내려간다**(`--fx-charge` 등) — 초를 CSS 에도 적으면
   * 출처가 둘이 되고 reduced-motion 축약이 한쪽만 따라온다.
   */
  timings: FxTimings;
  /** 파티클 수 상한(반응형 — 호출부가 결정). 미지정이면 config 데스크탑 값. */
  particles?: number;
  reduced?: boolean;
  cfg?: FxConfig;
}

/**
 * 카드 **한 장**을 감싸는 이펙트 층. 카드 자체는 children 으로 받는다 —
 * `RevealCard` 를 고치지 않고 위에 얹는 구조라 카드 계약(#187/#209)이 그대로 남는다.
 */
export function CardFxStage({
  grade,
  phase,
  variant,
  timings,
  particles,
  reduced = false,
  cfg = FX_CONFIG,
  children,
}: CardFxProps & { children: React.ReactNode }) {
  const tier = fxTierOf(grade, cfg);
  // 색·위장 여부는 **단계에서 파생**한다(별도 상태 없음) — A 구간의 레전드 = 다이아인 척.
  const accent = fxAccentOf(grade, phase, GRADE_GLOW_COLORS, cfg);
  const disguised = isDisguised(grade, phase, cfg);
  const n = particles ?? cfg.particles.desktop;
  const active = tier !== "none" && phase !== "idle" && phase !== "done";

  return (
    <div
      className={[styles.stage, styles[`ph_${phase}`] ?? ""].filter(Boolean).join(" ")}
      style={{
        ["--fx-accent" as string]: accent,
        ["--fx-charge" as string]: `${timings.charge}ms`,
        ["--fx-surge" as string]: `${timings.surge}ms`,
        ["--fx-burst" as string]: `${timings.burst}ms`,
        ["--fx-aura" as string]: `${timings.aura}ms`,
      }}
      /* 위장 중에는 `legend` 가 아니라 위장 등급으로 **선언한다** — CSS 의 레전드 전용 규칙이
         `[data-fx-tier="legend"]` 를 보므로, 여기 한 곳만 바꾸면 전용 층이 통째로 따라 숨는다. */
      data-fx-tier={disguised ? "epic" : tier}
      data-fx-phase={phase}
      data-fx-variant={variant}
      data-fx-disguised={disguised ? "true" : "false"}
      data-testid="gacha-fx-stage"
    >
      {/* 카드 본체 — 흔들림(anticipation)은 래퍼가 준다. 카드 컴포넌트는 무변경. */}
      <div className={styles.cardHolder}>{children}</div>

      {active && (
        /*
         * ⚠️ `key={phase}` 로 **단계마다 새로 마운트**한다. CSS 애니메이션은 `animation-name` 이
         * 그대로면 클래스가 바뀌어도 **다시 시작하지 않는다** — 기존 시작 시각을 유지한 채
         * duration/iteration 만 갈아끼운다. A(`.ph_charge .ray`)와 B(`.ph_surge .ray`)가 같은
         * `rayIn` 을 쓰므로, 이 키가 없으면 B 진입 시점엔 애니메이션이 **이미 끝난 상태**(opacity 0)로
         * 계산돼 B 구간이 통째로 빈 화면이 된다(실측: 1400ms 프레임에 아무것도 없었다).
         * 키프레임 이름을 단계마다 복제하는 방법도 있지만, 그러면 변주 3종 × 단계마다 늘어난다.
         */
        <div key={phase} className={styles.fxLayer} aria-hidden="true">
          {/* ── A안: 수렴 광선 ── */}
          {variant === "A" && !reduced && (
            <div className={styles.rays}>
              {Array.from({ length: n }, (_, i) => (
                <span
                  key={i}
                  className={styles.ray}
                  style={{
                    ["--i" as string]: i,
                    ["--deg" as string]: `${(360 / n) * i}deg`,
                    ["--delay" as string]: `${(i % 4) * 70}ms`,
                  }}
                />
              ))}
            </div>
          )}

          {/* ── B안: 궤도 오브 ── */}
          {variant === "B" && !reduced && (
            <>
              <div className={styles.orbit}>
                {Array.from({ length: n }, (_, i) => (
                  <span key={i} className={styles.orb} style={{ ["--deg" as string]: `${(360 / n) * i}deg` }} />
                ))}
              </div>
              {tier === "legend" && !disguised && (
                <div className={`${styles.orbit} ${styles.orbit2}`}>
                  {Array.from({ length: Math.max(3, Math.round(n / 2)) }, (_, i) => (
                    <span
                      key={i}
                      className={styles.orb}
                      style={{ ["--deg" as string]: `${(360 / Math.max(3, Math.round(n / 2))) * i}deg` }}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── C안: 심박 충전 (파티클 0 — 테두리 글로우만) ── */}
          {variant === "C" && <span className={styles.beat} />}

          {/*
            격상 펄스 — A 가 끝나고 B 가 **시작하는** 순간 한 번. 색이 뚝 바뀌면 글리치로 읽히는데
            여기서 터뜨리면 "격상됐다"로 읽힌다. B 구간 진입 신호라 `phase === "surge"` 에만 건다.
          */}
          {phase === "surge" && <span className={styles.escalate} />}

          {/* 공통: 수렴 링 · 개방 플래시 · 잔광 후광 */}
          <span className={styles.ring} />
          <span className={styles.flash} />
          <span className={styles.aura} />
        </div>
      )}
    </div>
  );
}

// ── 확장 피날레 (LEGEND 전용, 시트 전체) ─────────────────────────────────────

export interface FinaleFxProps {
  grade: Grade;
  variant: FxVariant;
  reduced?: boolean;
  /** 재생 트리거. 값이 바뀔 때마다 한 번 재생한다. */
  runId: number;
  durationMs: number;
  cfg?: FxConfig;
}

/**
 * LEGEND 확장 피날레 — 카드 밖(시트 전체)으로 번진다. "에픽처럼 시작하다가 더 큰 이펙트로
 * 마무리"의 **더 큰** 부분이 이것이다. epic 은 이 컴포넌트를 아예 렌더하지 않는다.
 *
 * 이 층은 카드 위가 아니라 **오버레이 최상단**에 깔린다 — 카드 안에 가두면 "확장" 이 안 보인다.
 * 클릭을 먹으면 안 되므로 `pointer-events: none`(CSS).
 */
export function FinaleFx({ grade, variant, reduced = false, runId, durationMs, cfg = FX_CONFIG }: FinaleFxProps) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(true);
    const t = window.setTimeout(() => setOn(false), durationMs);
    return () => window.clearTimeout(t);
  }, [runId, durationMs]);

  if (!on) return null;
  return (
    <div
      className={styles.finale}
      /* 피날레는 격상 **이후**라 언제나 진짜 색이다(위장 색이 여기까지 오면 격상이 안 된 것). */
      style={{
        ["--fx-accent" as string]: fxAccentOf(grade, "finale", GRADE_GLOW_COLORS, cfg),
        ["--fx-dur" as string]: `${durationMs}ms`,
      }}
      data-testid="gacha-fx-finale"
      data-fx-variant={variant}
      aria-hidden="true"
    >
      <span className={styles.finaleWash} />
      <span className={styles.shock} />
      <span className={`${styles.shock} ${styles.shock2}`} />
      {!reduced && (
        <div className={styles.sparks}>
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} className={styles.spark} style={{ ["--deg" as string]: `${(360 / 16) * i}deg` }} />
          ))}
        </div>
      )}
      {!reduced && <span className={styles.sweep} />}
    </div>
  );
}
