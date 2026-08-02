import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import styles from "./CelebrationOverlay.module.css";

/** `growth` = 3지선다 적용(#405 §2.5) — 성★/잠재와 같은 연출 인터페이스를 쓴다. */
export type CelebrationVariant = "starUp" | "tierUp" | "growth";

export interface CelebrationOverlayProps {
  /** 연출 종류 — 현재는 data-variant 마킹에만 쓰이고, 실제 색은 accentColor 로 별도 주입된다. */
  variant: CelebrationVariant;
  /** 플래시·뱃지·스텝 전부가 따라가는 강조색 — CSS 변수(`--celebration-accent`)로 주입. */
  accentColor: string;
  /** 중앙 뱃지 텍스트(예: "에픽", "2★ 달성!"). */
  title: string;
  /** 뱃지 아래 보조 텍스트(예: "잠재 에픽 승급!", "잠재능력 해금!"). */
  subtitle?: string;
  /** 순차 공개되는 항목들(예: 잠재 줄 dot, ★ 아이콘) — 인덱스 순서로 스태거 팝인. */
  steps?: ReactNode[];
  /** 오버레이 총 노출 시간(ms) — 플래시 애니메이션 길이 + onDone 콜백 타이밍을 함께 결정. */
  durationMs?: number;
  /** durationMs 경과 후 1회 호출 — 이 컴포넌트는 스스로 unmount 하지 않는다, 부모가 onDone 에서 상태를 지워야 사라진다. */
  onDone?: () => void;
  /** 루트 엘리먼트 data-testid. */
  testId?: string;
  /** 루트 엘리먼트에 얹을 추가 data-* 속성(예: `{"data-tier": "EPIC"}`) — 도메인 메타데이터 통로.
   *  React/JSX 스프레드 타이핑 이슈를 피하려 ref+setAttribute 로 부여한다(런타임 전용, 계약 외 확장 훅). */
  dataAttrs?: Record<string, string>;
}

const DEFAULT_DURATION_MS = 2400;

/**
 * 승급/축하 연출 공용 오버레이(에픽 #179 GM7b — hero 피드백 "이펙트 인터페이스화").
 * 티어업(잠재 승급, V2.1-3)과 성★ 승급 둘 다 이 컴포넌트 하나로 렌더된다 — variant 는 마킹용일 뿐,
 * 실제 표시 내용(색·텍스트·스텝)은 전부 props 로 호출부(CardGrowthDetail)가 채운다.
 *
 * ⚠️ 디자인 개편 대상 — 색·타이밍은 마크업이 아니라 CSS 변수 토큰
 * (`--celebration-accent`, `--celebration-duration`, `--celebration-step-base`,
 * `--celebration-step-stagger`, 전부 CelebrationOverlay.module.css 에 정의)으로만 흘러간다.
 * 다음 리디자인 때는 이 파일의 마크업이 아니라 module.css 의 토큰/키프레임만 갈아끼우면 된다 —
 * props 계약(variant/accentColor/title/subtitle/steps/durationMs/onDone)은 유지할 것.
 */
export function CelebrationOverlay({
  variant,
  accentColor,
  title,
  subtitle,
  steps,
  durationMs = DEFAULT_DURATION_MS,
  onDone,
  testId,
  dataAttrs,
}: CelebrationOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !dataAttrs) return;
    for (const [key, value] of Object.entries(dataAttrs)) el.setAttribute(key, value);
  }, [dataAttrs]);

  useEffect(() => {
    if (!onDone) return;
    const t = window.setTimeout(onDone, durationMs);
    return () => window.clearTimeout(t);
  }, [durationMs, onDone]);

  const rootStyle = {
    "--celebration-accent": accentColor,
    "--celebration-duration": `${durationMs}ms`,
  } as CSSProperties;

  return (
    <div ref={rootRef} className={styles.overlay} data-testid={testId} data-variant={variant} role="status" style={rootStyle}>
      <div className={styles.flash} />
      <div className={styles.body}>
        <span className={styles.badge}>{title}</span>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        {steps && steps.length > 0 && (
          <div className={styles.steps} aria-hidden>
            {steps.map((step, i) => (
              <span
                key={i}
                className={styles.step}
                style={{ animationDelay: `calc(var(--celebration-step-base) + ${i} * var(--celebration-step-stagger))` }}
              >
                {step}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
