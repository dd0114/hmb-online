import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RevealFxCard } from "../common/RevealFxCard";
import { FinaleFx, usePrefersReducedMotion } from "../common/GachaFx";
import {
  FX_CONFIG,
  batchFxPlan,
  fxDuration,
  fxTierOf,
  type FxConfig,
  type FxTimings,
  type FxVariant,
} from "../common/gacha-fx";
import { GRADE_COLORS, GRADE_GLOW_COLORS, GRADE_LABELS, GRADE_ORDER, type Grade } from "../common/grades";
import styles from "./GachaFxPreview.module.css";

/**
 * `/design/gacha-fx` — **#250 뽑기 이펙트 시안 프리뷰**. dev 빌드에만 존재한다(App.tsx 가드).
 *
 * 왜 필요한가: 연출은 지표로 고를 수 없다. hero 가 **직접 재생해 보고** 고르는 게 게이트라
 * 등급별 재생 버튼 · 두 경로(개별 탭 / 일괄 보기) · 모바일 390 프레임 · reduced-motion 을
 * 한 화면에 올렸다. 제품 화면(`shop/GachaReveal`)은 **아직 안 건드렸다** — 컨펌된 안만 W2 에서 배선한다.
 *
 * 여기 쓰는 연출·판정은 전부 제품 모듈(`common/GachaFx.tsx` · `common/gacha-fx.ts`)이다.
 * 목업을 따로 그리지 않는다 — 그러면 컨펌한 그림과 배선될 그림이 갈라진다.
 */

interface P {
  id: string;
  name: string;
  position: string;
  grade: Grade;
}

/** 실제 시드(`players.v2.1.json`)에서 뽑은 표본. 등급별 대표 1명씩. */
const SAMPLE: Record<Grade, P> = {
  BRONZE: { id: "P118", name: "Rico Lewis", position: "DF", grade: "BRONZE" },
  SILVER: { id: "P080", name: "Lisandro Martínez", position: "DF", grade: "SILVER" },
  GOLD: { id: "P055", name: "Federico Valverde", position: "MF", grade: "GOLD" },
  DIA: { id: "P027", name: "Kevin De Bruyne", position: "MF", grade: "DIA" },
  LEGEND: { id: "P011", name: "Pelé", position: "FW", grade: "LEGEND" },
};

/** 10+1 목업 — 하위 다수 + DIA 2 + 마지막 천장 LEGEND(고레어 2티어가 한 번에 들어간 경우). */
const PULL: P[] = [
  SAMPLE.BRONZE, SAMPLE.SILVER, SAMPLE.BRONZE, SAMPLE.GOLD, SAMPLE.DIA,
  SAMPLE.SILVER, SAMPLE.BRONZE, SAMPLE.GOLD, SAMPLE.DIA, SAMPLE.SILVER,
  SAMPLE.LEGEND,
];

const VARIANTS: Array<{ key: FxVariant; label: string; blurb: string }> = [
  {
    key: "A",
    label: "A안 · 수렴 광선",
    blurb:
      "화면 밖에서 빛줄기가 카드로 날아와 꽂힌다. 3파(波)로 점점 빨라지며 카드가 그때마다 떨린다. " +
      "가장 '모인다'가 직설적으로 읽히고 임팩트가 크다. 대신 파티클이 가장 많다(모바일 8개로 감축).",
  },
  {
    key: "B",
    label: "B안 · 궤도 오브",
    blurb:
      "빛구슬이 카드를 크게 돌다가 나선으로 조여든다. 회전이 있어 '충전' 느낌이 강하고 고급스럽다. " +
      "LEGEND 은 역방향 두 번째 궤도가 겹쳐 밀도가 두 배가 된다.",
  },
  {
    key: "C",
    label: "C안 · 심박 충전",
    blurb:
      "파티클 0. 카드 테두리 글로우가 심박처럼 4번 뛰는데 간격이 점점 좁아진다(가속). " +
      "가장 가볍고(모바일 최우수) 절제돼 있지만, 화려함은 A/B 보다 낮다.",
  },
];

type Path = "single" | "batch";
/** 일괄 공개에서 고레어를 어떻게 처리할지 — hero 컨펌 항목. */
type BatchMode = "stagger" | "top";

/**
 * LEGEND 위장 격상 후 색. `null` = **광원색 기본값**(`GRADE_GLOW_COLORS.LEGEND`).
 * hero 확정(2026-07-29): 금색 — 발행된 `frame-LEGEND.png` 테두리가 금색이라 보라 후광은
 * 카드 안팎이 어긋난다. 비교용으로 보라·백금도 남겨 둔다.
 */
const LEGEND_COLORS = {
  gold: { label: "금색(프레임색·기본)", value: null as string | null },
  purple: { label: "보라(등급 라벨색)", value: "#c07cf5" },
  white: { label: "백금", value: "#eaf2ff" },
} as const;
type LegendColorKey = keyof typeof LEGEND_COLORS;

/**
 * B(격상) 구간 길이 — 레전드가 다이아 연출(A)을 **끝낸 뒤** 추가로 도는 시간.
 * 길수록 반전이 세지만 전체가 늘어난다(레전드 총 길이 = A + B + 개봉 + 잔광 + 피날레).
 */
const SURGE_MS = {
  short: { label: "B 0.6초", ms: 600 },
  mid: { label: "B 0.85초", ms: 850 },
  long: { label: "B 1.2초", ms: 1200 },
} as const;
type SurgeKey = keyof typeof SURGE_MS;

export function GachaFxPreview() {
  const [params, setParams] = useSearchParams();
  const framed = params.get("frame") === "phone";
  const variant = (VARIANTS.find((v) => v.key === params.get("v"))?.key ?? "A") as FxVariant;
  const path = (params.get("p") === "batch" ? "batch" : "single") as Path;
  const batchMode = (params.get("b") === "top" ? "top" : "stagger") as BatchMode;
  const thresholdParam = params.get("t");
  const threshold: Grade = thresholdParam === "GOLD" ? "GOLD" : "DIA";
  const forceReduced = params.get("rm") === "1";
  // LEGEND 위장(hero 요구): 격상 후 색 · 격상 시점 — 둘 다 눈으로 골라야 하는 값이라 칩으로 뺐다.
  const legendColorKey = (params.get("lc") ?? "gold") as LegendColorKey;
  const surgeKey = (params.get("sg") ?? "mid") as SurgeKey;

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    p.set(k, v);
    setParams(p, { replace: true });
  };

  const cfg: FxConfig = useMemo(
    () => ({
      ...FX_CONFIG,
      threshold,
      variant,
      // B 구간 길이는 **타이밍**이지 위장 설정이 아니다 — 두 시계(정상/모션최소화)에 같이 얹는다.
      timings: { ...FX_CONFIG.timings, surge: SURGE_MS[surgeKey]?.ms ?? FX_CONFIG.timings.surge },
      reducedTimings: {
        ...FX_CONFIG.reducedTimings,
        surge: Math.round((SURGE_MS[surgeKey]?.ms ?? FX_CONFIG.timings.surge) * 0.45),
      },
      legendDisguise: {
        ...FX_CONFIG.legendDisguise,
        finalColor: LEGEND_COLORS[legendColorKey]?.value ?? null,
      },
    }),
    [threshold, variant, legendColorKey, surgeKey],
  );
  const systemReduced = usePrefersReducedMotion();
  const reduced = systemReduced || forceReduced;
  const timings = useMemo(() => (reduced ? cfg.reducedTimings : cfg.timings), [reduced, cfg]);

  if (framed) {
    const inner = new URLSearchParams(params);
    inner.delete("frame");
    return (
      <div className={styles.frameWrap}>
        <div className={styles.frameHead}>
          <span className={styles.frameTitle}>📱 390 × 844 — 실제 폭에서의 프레임·번짐 확인용</span>
          <a className={styles.chip} href={`/design/gacha-fx?${inner.toString()}`}>
            🖥 데스크탑
          </a>
        </div>
        <iframe className={styles.phone} title="모바일 프리뷰" src={`/design/gacha-fx?${inner.toString()}`} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.h1}>#250 뽑기 이펙트 시안 — 재생해 보고 고르세요</h1>
        <nav className={styles.tabs}>
          {VARIANTS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={`${styles.chip} ${v.key === variant ? styles.chipOn : ""}`}
              onClick={() => set("v", v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <nav className={styles.tabs}>
          <span className={styles.gLabel}>경로</span>
          <button
            type="button"
            className={`${styles.chip} ${path === "single" ? styles.chipOn : ""}`}
            onClick={() => set("p", "single")}
          >
            ① 하나씩 누르기
          </button>
          <button
            type="button"
            className={`${styles.chip} ${path === "batch" ? styles.chipOn : ""}`}
            onClick={() => set("p", "batch")}
          >
            ② 한번에 보기
          </button>
          <span className={styles.gLabel}>임계</span>
          {(["DIA", "GOLD"] as Grade[]).map((g) => (
            <button
              key={g}
              type="button"
              className={`${styles.chip} ${threshold === g ? styles.chipOn : ""}`}
              onClick={() => set("t", g)}
            >
              {GRADE_LABELS[g]} 이상
            </button>
          ))}
          <button
            type="button"
            className={`${styles.chip} ${forceReduced ? styles.chipOn : ""}`}
            onClick={() => set("rm", forceReduced ? "0" : "1")}
          >
            ♿ 모션 최소화 {forceReduced ? "ON" : "OFF"}
          </button>
          <a className={styles.chip} href={`/design/gacha-fx?${params.toString()}&frame=phone`}>
            📱 모바일 390
          </a>
        </nav>
        <nav className={styles.tabs}>
          <span className={styles.gLabel}>레전드 위장 격상색</span>
          {(Object.keys(LEGEND_COLORS) as LegendColorKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.chip} ${legendColorKey === k ? styles.chipOn : ""}`}
              style={{ color: LEGEND_COLORS[k].value ?? GRADE_GLOW_COLORS.LEGEND }}
              onClick={() => set("lc", k)}
            >
              {LEGEND_COLORS[k].label}
            </button>
          ))}
          <span className={styles.gLabel}>B 구간 길이</span>
          {(Object.keys(SURGE_MS) as SurgeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.chip} ${surgeKey === k ? styles.chipOn : ""}`}
              onClick={() => set("sg", k)}
            >
              {SURGE_MS[k].label}
            </button>
          ))}
        </nav>
      </header>

      <p className={styles.note}>{VARIANTS.find((v) => v.key === variant)?.blurb}</p>

      <TierTable cfg={cfg} />

      {path === "single" ? (
        <SinglePath variant={variant} cfg={cfg} timings={timings} reduced={reduced} />
      ) : (
        <BatchPath
          variant={variant}
          cfg={cfg}
          timings={timings}
          reduced={reduced}
          mode={batchMode}
          onMode={(m) => set("b", m)}
        />
      )}

      <FpsMeter />
    </div>
  );
}

// ── 등급 → 티어 매핑 표 (컨펌 항목 ①) ────────────────────────────────────────

function TierTable({ cfg }: { cfg: FxConfig }) {
  return (
    <section className={styles.sec}>
      <h2 className={styles.h2}>
        ① '에픽 이상' = 어디부터? <span className={styles.dim}>(임계 칩으로 바꿔 보세요 — 코드는 한 줄)</span>
      </h2>
      <div className={styles.tierRow}>
        {GRADE_ORDER.map((g) => {
          const tier = fxTierOf(g, cfg);
          return (
            <div key={g} className={styles.tierCell} data-tier={tier}>
              <b style={{ color: GRADE_COLORS[g] }}>{GRADE_LABELS[g]}</b>
              <span className={styles.tierTag}>
                {tier === "legend" ? "확장 피날레" : tier === "epic" ? "빛 모임" : "이펙트 없음"}
              </span>
            </div>
          );
        })}
      </div>
      <p className={styles.dim}>
        현행 등급은 5단(브론즈·실버·골드·다이아·레전드)이고 '에픽'이라는 등급은 없다. 기본안은{" "}
        <b>다이아 이상 = 빛 모임 / 레전드 = 확장 피날레</b>. 골드는 이미 기존 하이라이트(금색 글로우)를
        갖고 있어 이펙트를 붙이면 10연차에서 절반이 발동해 희소성이 죽는다.
      </p>
    </section>
  );
}

// ── ① 하나씩 누르기 ─────────────────────────────────────────────────────────

/** 카드 1장 = 자기 시계를 가진 연출 단위. */
/**
 * 프리뷰의 카드 = **제품과 같은 컴포넌트**(`common/RevealFxCard`). 여기서 카드를 따로 그리면
 * hero 가 컨펌한 그림과 실제 배선될 그림이 갈라진다 — 이 하니스의 존재 이유가 사라진다.
 * 프리뷰가 더 갖는 것은 `runId`(같은 등급 연타 재생)와 변주 칩뿐이라 그 둘만 여기서 얹는다.
 */
function FxCard({
  player,
  cfg,
  timings,
  reduced,
  runId,
  startDelay = 0,
  size = "grid",
  onFinale,
  testId,
}: {
  player: P;
  cfg: FxConfig;
  timings: FxTimings;
  reduced: boolean;
  /** 0 = 미재생(뒷면). 값이 바뀌면 처음부터 재생. */
  runId: number;
  startDelay?: number;
  size?: "grid" | "detail";
  onFinale?: () => void;
  testId?: string;
}) {
  return (
    <RevealFxCard
      /* key 로 재마운트해 같은 등급을 연타해도 처음부터 다시 재생된다(제품엔 없는 프리뷰 편의). */
      key={runId}
      playerId={player.id}
      name={player.name}
      grade={player.grade}
      position={player.position}
      triggered={runId > 0}
      startDelay={startDelay}
      timings={timings}
      reduced={reduced}
      cfg={cfg}
      size={size}
      testId={testId}
      onPhase={(p) => {
        if (p === "finale") onFinale?.();
      }}
    />
  );
}

function SinglePath({
  variant,
  cfg,
  timings,
  reduced,
}: {
  variant: FxVariant;
  cfg: FxConfig;
  timings: FxTimings;
  reduced: boolean;
}) {
  const [grade, setGrade] = useState<Grade>("DIA");
  const [runId, setRunId] = useState(0);
  const [finaleRun, setFinaleRun] = useState(0);
  const player = SAMPLE[grade];
  const tier = fxTierOf(grade, cfg);

  const play = useCallback((g: Grade) => {
    setGrade(g);
    setRunId(0);
    // 다음 프레임에 새 run — 같은 등급을 연타해도 처음부터 다시 재생된다.
    window.setTimeout(() => setRunId((n) => n + 1), 30);
  }, []);

  return (
    <section className={styles.sec}>
      <h2 className={styles.h2}>② 하나씩 누르기 — 카드를 누르면 빛이 모이고, 다 모이면 뒤집힌다</h2>
      <div className={styles.stageBox}>
        <FxCard
          key={grade}
          player={player}
          cfg={cfg}
          timings={timings}
          reduced={reduced}
          runId={runId}
          size="detail"
          onFinale={() => setFinaleRun((n) => n + 1)}
          testId="fx-single-card"
        />
      </div>
      <div className={styles.playRow}>
        {GRADE_ORDER.map((g) => (
          <button
            key={g}
            type="button"
            className={`${styles.play} ${grade === g ? styles.playOn : ""}`}
            style={{ borderColor: GRADE_COLORS[g] }}
            onClick={() => play(g)}
            data-testid={`fx-play-${g}`}
          >
            ▶ {GRADE_LABELS[g]}
            <span className={styles.playTag}>
              {fxTierOf(g, cfg) === "legend" ? "확장" : fxTierOf(g, cfg) === "epic" ? "빛 모임" : "대조군"}
            </span>
          </button>
        ))}
      </div>
      <p className={styles.dim}>
        총 길이 {tier === "none" ? 0 : fxDuration(tier, timings)}ms
        {tier !== "none" && ` (기대감 ${timings.charge} → 개방 ${timings.burst} → 잔광 ${timings.aura}${
          tier === "legend" ? ` → 피날레 ${timings.finale}` : ""
        })`}
        . <b>대조군(브론즈~골드)</b>은 지연 0 — 지금과 똑같이 즉시 뒤집힌다.
      </p>
      {tier === "legend" && finaleRun > 0 && (
        <FinaleFx
          grade={grade}
          variant={variant}
          reduced={reduced}
          runId={finaleRun}
          durationMs={timings.finale}
          cfg={cfg}
        />
      )}
    </section>
  );
}

// ── ② 한번에 보기 ───────────────────────────────────────────────────────────

function BatchPath({
  variant,
  cfg,
  timings,
  reduced,
  mode,
  onMode,
}: {
  variant: FxVariant;
  cfg: FxConfig;
  timings: FxTimings;
  reduced: boolean;
  mode: BatchMode;
  onMode: (m: BatchMode) => void;
}) {
  const [runId, setRunId] = useState(0);
  const [finaleRun, setFinaleRun] = useState(0);
  const [finaleGrade, setFinaleGrade] = useState<Grade>("LEGEND");

  const plan = useMemo(() => batchFxPlan(PULL.map((p) => p.grade), cfg), [cfg]);
  /** 인덱스 → 지연. 'top' 모드면 최고 티어 1장만 연출하고 나머지는 즉시 공개. */
  const delayOf = useMemo(() => {
    const m = new Map<number, number>();
    const steps = mode === "top" ? plan.slice(-1) : plan;
    steps.forEach((s) => m.set(s.index, s.delayMs));
    return m;
  }, [plan, mode]);

  return (
    <section className={styles.sec}>
      <h2 className={styles.h2}>③ 한번에 보기 — 고레어가 섞여 있을 때</h2>
      <div className={styles.tabs}>
        <span className={styles.gLabel}>일괄 정책</span>
        <button
          type="button"
          className={`${styles.chip} ${mode === "stagger" ? styles.chipOn : ""}`}
          onClick={() => onMode("stagger")}
        >
          전원 스태거(낮은 등급 → 높은 등급)
        </button>
        <button
          type="button"
          className={`${styles.chip} ${mode === "top" ? styles.chipOn : ""}`}
          onClick={() => onMode("top")}
        >
          최고 1장만
        </button>
      </div>
      <p className={styles.dim}>
        {mode === "stagger" ? (
          <>
            고레어 카드가 <b>낮은 등급부터</b> {cfg.batchStaggerMs}ms 간격으로 차례로 터진다 —
            클라이맥스(레전드)가 마지막에 온다. 이 목업엔 다이아 2 + 레전드 1 이 들어 있다.
          </>
        ) : (
          <>
            가장 높은 <b>1장만</b> 연출하고 나머지는 즉시 공개. 짧고 산만하지 않지만 다이아 2장이
            묻힌다.
          </>
        )}
      </p>
      <div className={styles.grid}>
        {PULL.map((p, i) => (
          <FxCard
            key={`${p.id}-${i}`}
            player={p}
            cfg={cfg}
            timings={timings}
            reduced={reduced}
            runId={runId}
            startDelay={delayOf.get(i) ?? 0}
            size="grid"
            onFinale={() => {
              setFinaleGrade(p.grade);
              setFinaleRun((n) => n + 1);
            }}
            testId={`fx-batch-card-${i}`}
          />
        ))}
      </div>
      <div className={styles.playRow}>
        <button
          type="button"
          className={styles.play}
          onClick={() => {
            setRunId(0);
            window.setTimeout(() => setRunId((n) => n + 1), 30);
          }}
          data-testid="fx-play-batch"
        >
          ▶ 모두 공개
        </button>
      </div>
      {finaleRun > 0 && (
        <FinaleFx
          grade={finaleGrade}
          variant={variant}
          reduced={reduced}
          runId={finaleRun}
          durationMs={timings.finale}
          cfg={cfg}
        />
      )}
    </section>
  );
}

// ── 프레임 계측 (모바일 성능 확인용) ─────────────────────────────────────────

/**
 * 재생 중 실제 프레임률. "모바일에서 버벅이나"는 눈으로도 보이지만 숫자가 있으면 안 싸운다.
 * 측정 자체가 부하가 되지 않게 rAF 카운트만 하고 **1초에 한 번** 상태를 갱신한다.
 */
function FpsMeter() {
  const [fps, setFps] = useState(0);
  const [low, setLow] = useState(0);
  // 최저치는 ref 가 소유한다 — 클로저 변수로 두면 [리셋] 이 화면만 지우고 실제 기록은 안 지운다.
  const worst = useRef(999);
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      frames += 1;
      if (t - last >= 1000) {
        const v = Math.round((frames * 1000) / (t - last));
        setFps(v);
        // 탭이 백그라운드로 갔을 때의 한 자릿수는 성능이 아니라 스로틀링이라 버린다.
        if (v > 5) {
          worst.current = Math.min(worst.current, v);
          setLow(worst.current);
        }
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className={styles.fps} data-testid="fx-fps">
      {fps} fps <span className={styles.dim}>· 최저 {low || "—"}</span>
      <button
        type="button"
        className={styles.fpsReset}
        onClick={() => {
          worst.current = 999;
          setLow(0);
        }}
      >
        리셋
      </button>
    </div>
  );
}
