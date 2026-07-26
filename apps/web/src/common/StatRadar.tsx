import type { CSSProperties } from "react";
import styles from "./StatRadar.module.css";

/** 축 1개 — 값(원시 단위, window 와 같은 스케일)과 선택적 상한(있으면 점선 폴리곤). */
export interface StatRadarAxis {
  /** testid 앵커·React key용 안정 식별자(라벨과 별개). */
  key: string;
  /** 축에 표시할 라벨(예: "슛"). */
  label: string;
  /** 이 축의 현재 값. */
  value: number;
  /** 이 축의 상한 — axes 전원이 cap 을 갖고 있을 때만 캡 폴리곤을 그린다. */
  cap?: number;
}

export interface StatRadarWindow {
  lo: number;
  hi: number;
}

export interface StatRadarProps {
  /** 축 목록 — 길이만큼 N각으로 그려진다(6축 고정 아님). */
  axes: StatRadarAxis[];
  /** 모든 축 공통 정규화 윈도우(밴드 앵커) — [lo,hi] 밖은 클램프. */
  window: StatRadarWindow;
  /** SVG 정사각 픽셀 크기. */
  size?: number;
  /** 값 폴리곤 강조색(CSS 변수 `--radar-accent` 로 주입, 미지정 시 module.css 기본값). */
  accentColor?: string;
  /** axes 와 같은 순서의 보조 비교값(예: 이전 스탯) — 있으면 옅은 점선 폴리곤을 추가로 그린다.
   *  현재 호출부(CardGrowthDetail)는 아직 안 씀 — 향후 비교 연출을 위해 계약에 미리 열어둔 확장 훅. */
  compareValues?: number[];
  /** 루트/하위 엘리먼트 data-testid 접두어(예: "growth-radar" → `${testId}-svg`, `${testId}-axis-<key>` …). */
  testId?: string;
}

const DEFAULT_SIZE = 220;
const RING_FRACS = [0.25, 0.5, 0.75, 1] as const;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function normalize(value: number, win: StatRadarWindow): number {
  const span = win.hi - win.lo;
  if (span <= 0) return 0;
  return clamp01((value - win.lo) / span);
}

/** count 각형 위 fracs[i](0..1, 중심에서 반경 비율) 좌표를 "x,y x,y …" polyline 포맷으로. */
function polygonPoints(fracs: number[], cx: number, cy: number, maxR: number, count: number): string {
  return fracs
    .map((frac, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      const r = frac * maxR;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * 능력치 다각형(레이더) 차트 — 밴드 앵커 윈도우로 정규화한 값을 N각 폴리곤으로 그린다.
 * hero 피드백: "능력치를 막대 말고 다각형으로? / 숫자가 높아 격차 안 보임 → 주식 차트처럼
 * y축 하한 잘라서 드라마틱하게"(에픽 #179 후속). 6축 그룹핑 등 도메인 매핑은 이 컴포넌트가
 * 모른다 — 호출부(growth-config.ts RADAR_GROUPS)가 axes 를 미리 조립해 넘긴다.
 *
 * ⚠️ 디자인 개편 대상 — 인터페이스화(CelebrationOverlay 와 같은 철학). 축 개수는 axes.length 로
 * 결정되고, 색·치수는 이 컴포넌트의 props + module.css CSS 변수 토큰(`--radar-accent` 등)으로만
 * 흘러간다. 다음 리디자인 때는 이 파일의 SVG 마크업/geometry 상수가 아니라 module.css 토큰만
 * 갈아끼우면 된다 — props 계약(axes/window/size/accentColor/compareValues/testId)은 유지할 것.
 */
export function StatRadar({ axes, window, size = DEFAULT_SIZE, accentColor, compareValues, testId }: StatRadarProps) {
  const n = axes.length;
  const cx = size / 2;
  const cy = size / 2;
  const labelPad = Math.max(28, size * 0.16);
  const maxR = size / 2 - labelPad;
  const labelR = maxR + labelPad * 0.62;

  const rootStyle = accentColor ? ({ "--radar-accent": accentColor } as CSSProperties) : undefined;

  const valueFracs = axes.map((a) => normalize(a.value, window));
  const hasCaps = n > 0 && axes.every((a) => a.cap !== undefined);
  const capFracs = hasCaps ? axes.map((a) => normalize(a.cap as number, window)) : null;
  const compareFracs =
    compareValues && compareValues.length === n ? compareValues.map((v) => normalize(v, window)) : null;

  if (n === 0) return null;

  return (
    <div className={styles.wrap} data-testid={testId} style={rootStyle}>
      <svg
        className={styles.svg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="능력치 레이더 차트"
        data-testid={testId ? `${testId}-svg` : undefined}
      >
        {RING_FRACS.map((f) => (
          <polygon key={f} className={styles.ring} points={polygonPoints(axes.map(() => f), cx, cy, maxR, n)} />
        ))}
        {axes.map((a, i) => {
          const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const x = cx + maxR * Math.cos(angle);
          const y = cy + maxR * Math.sin(angle);
          return <line key={a.key} className={styles.axisLine} x1={cx} y1={cy} x2={x} y2={y} />;
        })}
        {compareFracs && (
          <polygon
            className={styles.comparePolygon}
            points={polygonPoints(compareFracs, cx, cy, maxR, n)}
            data-testid={testId ? `${testId}-polygon-compare` : undefined}
          />
        )}
        {capFracs && (
          <polygon
            className={styles.capPolygon}
            points={polygonPoints(capFracs, cx, cy, maxR, n)}
            data-testid={testId ? `${testId}-polygon-cap` : undefined}
          />
        )}
        <polygon
          className={styles.valuePolygon}
          points={polygonPoints(valueFracs, cx, cy, maxR, n)}
          data-testid={testId ? `${testId}-polygon-value` : undefined}
        />
        {axes.map((a, i) => {
          const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const lx = cx + labelR * Math.cos(angle);
          const ly = cy + labelR * Math.sin(angle);
          return (
            <text
              key={a.key}
              className={styles.axisLabel}
              textAnchor="middle"
              data-testid={testId ? `${testId}-axis-${a.key}` : undefined}
            >
              <tspan x={lx} y={ly} dy="-0.15em">
                {a.label}
              </tspan>
              <tspan className={styles.axisValue} x={lx} y={ly} dy="1.15em">
                {Math.round(a.value)}
              </tspan>
            </text>
          );
        })}
      </svg>
      <p className={styles.windowLabel} data-testid={testId ? `${testId}-window` : undefined}>
        {Math.round(window.lo)}–{Math.round(window.hi)}
      </p>
    </div>
  );
}
