/**
 * 고레어 뽑기 이펙트 — **순수 로직 + 튜닝값**(#250). DOM/React 의존 0.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 왜 로직을 따로 빼는가
 *
 * 연출은 "언제 발동하나"와 "어떻게 보이나"가 섞이기 쉽다. 발동 판정(등급 임계)·순서
 * (일괄 공개 스태거)·단계 타이밍은 **눈으로 판정할 수 없는 계약**이라 여기서 순수 함수로
 * 소유하고 테스트한다. 보이는 것(빛·파티클)은 `GachaFx.tsx` + CSS 가 갖는다.
 *
 * ⚠️ **등급 임계를 코드 여기저기에 적지 마라.** `FX_CONFIG.threshold` 한 줄이 "에픽 이상"의
 * 유일한 출처다 — hero 가 DIA↔GOLD 를 바꾸면 여기만 바뀐다. `grade === "LEGEND"` 같은
 * 비교를 컴포넌트에 박으면 임계가 두 곳이 되고 조용히 어긋난다.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { GRADE_ORDER, type Grade } from "./grades";

/** 발동 등급대. `none` = 이펙트 없음(기존 하이라이트만). */
export type FxTier = "none" | "epic" | "legend";

/**
 * 연출 변주. **hero 가 프리뷰에서 눈으로 고른 값**(2026-07-29 = A).
 * 셋 다 남겨 둔 이유: 고르는 근거가 취향이라 되돌릴 일이 생긴다 — 지우면 그때 다시 만들어야 한다.
 * 바꾸는 방법 = `FX_CONFIG.variant` 한 줄(`/design/gacha-fx` 에서 미리 비교 가능).
 */
export type FxVariant = "A" | "B" | "C";

/**
 * 연출 단계. 카드 1장이 지나가는 상태 기계.
 *
 * ```
 *  DIA    : charge(A) ─────────────→ burst(개봉) → aura
 *  LEGEND : charge(A) → surge(B) ──→ burst(개봉) → aura → finale
 * ```
 * **레전드는 다이아 연출(A)을 끝까지 돌린 뒤에 B 를 하나 더 붙이고 나서 열린다.** 이게 요지다 —
 * 같은 A 안에서 색만 갈아끼우면 기대감 길이가 다이아와 같아져 반전이 성립하지 않는다.
 */
export type FxPhase = "idle" | "charge" | "surge" | "burst" | "aura" | "finale" | "done";

export interface FxTimings {
  /** A — 빛이 모이는 기대감 구간. 카드는 **아직 뒷면**. 레전드도 여기선 다이아와 구별되지 않는다. */
  charge: number;
  /** B — LEGEND 전용 격상 구간. A 가 **끝난 뒤에** 시작하고, 여기서도 카드는 아직 뒷면이다. */
  surge: number;
  /** 개방 = 플래시 + 뒤집기. */
  burst: number;
  /** 잔광(등급색 후광). */
  aura: number;
  /** LEGEND 확장 피날레(전체 화면). epic 은 이 구간이 없다. */
  finale: number;
}

export interface FxConfig {
  /** **이 등급 이상이면 이펙트 발동**(= '에픽 이상'의 실체). hero 컨펌 대상. */
  threshold: Grade;
  /** 이 등급 이상은 확장 피날레까지. */
  finaleThreshold: Grade;
  timings: FxTimings;
  /** reduced-motion 일 때의 축약 타이밍(모션 없이 색·플래시만). */
  reducedTimings: FxTimings;
  /** 일괄 공개에서 고레어 카드끼리 벌리는 간격(ms). 0 이면 동시. */
  batchStaggerMs: number;
  /** 파티클 수(데스크탑 / 모바일). 모바일 390 프레임 예산. */
  particles: { desktop: number; mobile: number };
  /** LEGEND 위장 격상 — 아래 `LegendDisguise` 참조. */
  legendDisguise: LegendDisguise;
  /** 연출 변주(hero 확정). 바꾸려면 여기 한 줄. */
  variant: FxVariant;
}

/**
 * **LEGEND 위장(fake-out)** — hero 요구(2026-07-29).
 *
 * 레전드는 처음 1초 동안 **한 등급 아래(다이아) 색**으로 빛이 모이다가, 진짜 색으로 **격상**된다.
 * "다이아인가 → 아니 레전드다!" 한 박자를 만드는 게 목적이라, 격상 전에는 레전드 전용 층
 * (2중 링·2중 궤도)도 **같이 숨긴다** — 하나라도 새면 위장이 아니라 그냥 색이 변하는 연출이 된다.
 */
export interface LegendDisguise {
  /** 끄면 레전드가 처음부터 자기 색으로 간다(롤백 스위치). B 구간 자체는 남는다. */
  enabled: boolean;
  /** 위장에 **색만** 빌려 오는 등급(티어 판정에는 영향 없음). */
  asGrade: Grade;
  /** 격상 후(B 구간) 색. `null` = 등급색(레전드 보라). 금색 등으로 바꾸려면 여기 한 곳. */
  finalColor: string | null;
}

export const FX_CONFIG: FxConfig = {
  threshold: "DIA",
  finaleThreshold: "LEGEND",
  // ⚠️ `burst` 는 **RevealCard 의 뒤집기 transition(0.45s)보다 길어야** 한다 — 짧으면 플래시가
  // 꺼진 뒤에 카드가 돌아 "터지면서 열린다"가 두 동작으로 쪼개진다(W1 캡처에서 실제로 그랬다).
  timings: { charge: 950, surge: 850, burst: 520, aura: 720, finale: 1150 },
  // reduced-motion: charge 를 **0 으로 죽이지 않는다** — 0 이면 등급 신호 자체가 사라져
  // "고레어를 뽑았다"는 정보가 연출에서 빠진다. 움직임 대신 색·밝기를 **머물게** 한다.
  // 그래서 charge 가 260 이 아니라 420 이다 — 움직이지 않는 신호는 짧으면 못 읽는다(캡처로 확인).
  // burst 는 짧아도 된다: 모션 최소화에서는 카드 뒤집기 transition 자체가 꺼진다(RevealCard).
  // surge 는 **남긴다** — 모션을 줄여도 "A 다음에 B 가 하나 더 있다"는 구조는 정보다.
  reducedTimings: { charge: 420, surge: 380, burst: 200, aura: 420, finale: 500 },
  batchStaggerMs: 160,
  particles: { desktop: 14, mobile: 8 },
  legendDisguise: { enabled: true, asGrade: "DIA", finalColor: null },
  // hero 확정(2026-07-29, `/design/gacha-fx` 실관전): A = 수렴 광선.
  variant: "A",
};

const rank = (g: Grade): number => GRADE_ORDER.indexOf(g);

/**
 * 등급 → 발동 티어. 임계 등급을 못 찾으면(스키마가 늘어난 경우) **발동하지 않는다** —
 * 모르는 등급에 연출을 태우는 것보다 조용히 빠지는 쪽이 안전하다.
 */
export function fxTierOf(grade: Grade, cfg: FxConfig = FX_CONFIG): FxTier {
  const g = rank(grade);
  const lo = rank(cfg.threshold);
  const hi = rank(cfg.finaleThreshold);
  if (g < 0 || lo < 0) return "none";
  if (hi >= 0 && g >= hi) return "legend";
  if (g >= lo) return "epic";
  return "none";
}

export function hasFx(grade: Grade, cfg: FxConfig = FX_CONFIG): boolean {
  return fxTierOf(grade, cfg) !== "none";
}

/** 여러 장 중 가장 높은 티어(일괄 공개에서 피날레를 띄울지 판정). */
export function highestTier(grades: Grade[], cfg: FxConfig = FX_CONFIG): FxTier {
  let best: FxTier = "none";
  for (const g of grades) {
    const t = fxTierOf(g, cfg);
    if (t === "legend") return "legend";
    if (t === "epic") best = "epic";
  }
  return best;
}

/**
 * B(surge) 구간 길이 — **레전드만** 갖는다. 다이아는 0 이라 A 다음이 곧 개봉이다.
 * 이 함수가 "레전드는 한 단계 더 있다"의 유일한 출처다.
 */
export function surgeOf(tier: FxTier, t: FxTimings): number {
  return tier === "legend" ? t.surge : 0;
}

/** 티어별 총 재생 길이(ms). epic 은 surge·finale 구간이 없다. */
export function fxDuration(tier: FxTier, t: FxTimings): number {
  if (tier === "none") return 0;
  const base = t.charge + surgeOf(tier, t) + t.burst + t.aura;
  return tier === "legend" ? base + t.finale : base;
}

/**
 * 경과 시간 → 단계. 타이머 여러 개를 겹치는 대신 **하나의 시계에서 파생**한다 —
 * 중간에 건너뛰기(탭)로 끊어도 상태가 어긋나지 않는다.
 */
export function fxPhaseAt(elapsedMs: number, tier: FxTier, t: FxTimings): FxPhase {
  if (tier === "none") return "done";
  if (elapsedMs < 0) return "idle";
  const s = surgeOf(tier, t);
  if (elapsedMs < t.charge) return "charge";
  if (elapsedMs < t.charge + s) return "surge";
  if (elapsedMs < t.charge + s + t.burst) return "burst";
  if (elapsedMs < t.charge + s + t.burst + t.aura) return "aura";
  if (tier === "legend" && elapsedMs < fxDuration(tier, t)) return "finale";
  return "done";
}

/**
 * **카드 앞면을 지금 보여도 되는가** — 제품의 개봉 게이트 그 자체(`RevealFxCard` 가 이걸 쓴다).
 *
 * A(charge)·B(surge) 중에는 뒷면이어야 anticipation 이 성립한다: 빛이 모이는 동안 결과가 이미
 * 보이면 그건 기대감이 아니라 장식이다. 레전드에서 `surge` 를 빠뜨리면 **B 구간 내내 정답이 보인 채로**
 * 격상 연출이 도는 꼴이 되고, 카드 프레임이 곧 정답이라 위장이 무의미해진다.
 *
 * ⚠️ 예전엔 이 옆에 `flipAt(tier, t)`(개봉 시각을 ms 로 돌려주는 함수)가 같이 있었는데 **제품은 그걸
 * 쓰지 않았다** — 소비자가 자기 테스트뿐이라, "개봉은 B 뒤다"를 지킨다고 말하면서 실제로는 아무것도
 * 강제하지 못했다(독립검증 MJ-2). 그래서 지우고, 계약을 **제품이 실제로 쓰는 이 함수**에 건다.
 */
export function fxRevealed(phase: FxPhase): boolean {
  return phase !== "idle" && phase !== "charge" && phase !== "surge";
}

/**
 * 단계 경계(ms) 목록 — 시계가 타이머를 걸 지점. **중복이 없다**는 게 계약이다.
 *
 * ⚠️ epic 은 `surgeOf`=0 이라 소박하게 적으면 `charge` 와 `charge+s` 가 같고, 마지막 두 경계도
 * 같아진다 → 같은 ms 에 타이머가 두 개 걸려 **단계 통지가 두 번** 나간다. 호출부가 그걸로 완료
 * 카드를 세면 집계가 부풀어 **확인 버튼이 피날레보다 먼저 뜨고 클라이맥스가 잘린다**(BL-1 실측:
 * 확인 2362ms vs 피날레 3373ms). 그래서 여기서 유일화하고, 그 사실을 테스트로 박는다 —
 * 소비자 쪽 방어(집합 집계)가 있더라도 **이 층이 단독으로 옳아야** 한다.
 */
export function fxMarks(tier: FxTier, t: FxTimings): number[] {
  if (tier === "none") return [0];
  const s = surgeOf(tier, t);
  return [
    ...new Set([
      0,
      t.charge,
      t.charge + s,
      t.charge + s + t.burst,
      t.charge + s + t.burst + t.aura,
      fxDuration(tier, t),
    ]),
  ];
}

export interface BatchStep {
  /** 결과 배열에서의 인덱스. */
  index: number;
  tier: FxTier;
  /** 일괄 공개 시작 기준 지연(ms). */
  delayMs: number;
}

/**
 * 일괄 공개("모두 공개") 계획 — 고레어만 골라 **낮은 티어부터** 순서대로 스태거한다.
 *
 * 왜 낮은 것부터인가: 클라이맥스가 마지막에 와야 한다. 인덱스 순서(뽑힌 순서)대로 두면
 * LEGEND 가 1번 슬롯에 나왔을 때 가장 큰 연출이 먼저 터지고 그 뒤로 작은 것들이 붙어
 * 김이 샌다. 같은 티어 안에서는 인덱스 순서를 지킨다(결과 그리드와 눈이 맞게).
 */
export function batchFxPlan(grades: Grade[], cfg: FxConfig = FX_CONFIG): BatchStep[] {
  const tierWeight: Record<FxTier, number> = { none: 0, epic: 1, legend: 2 };
  const hits = grades
    .map((grade, index) => ({ index, tier: fxTierOf(grade, cfg) }))
    .filter((h) => h.tier !== "none")
    .sort((a, b) => tierWeight[a.tier] - tierWeight[b.tier] || a.index - b.index);
  return hits.map((h, i) => ({ ...h, delayMs: i * cfg.batchStaggerMs }));
}

// ── LEGEND 위장 격상 ─────────────────────────────────────────────────────────

/**
 * 위장이 유지 중인가 = **A 구간(charge)에 있는 레전드인가**.
 *
 * ⚠️ 위장은 별도 상태가 아니라 **단계에서 파생**된다. 예전엔 `escalated` 불리언을 따로 들고
 * A 안에서 색만 갈아끼웠는데, 그러면 레전드의 기대감 길이가 다이아와 **같아져서** 반전이
 * 성립하지 않았다(hero 지적). 지금은 A 가 끝나야 B(surge)로 넘어가므로 "A → B → 개봉"이
 * 구조로 보장되고, 위장 해제 시점을 따로 튜닝할 값이 아예 없다.
 */
export function isDisguised(grade: Grade, phase: FxPhase, cfg: FxConfig = FX_CONFIG): boolean {
  return fxTierOf(grade, cfg) === "legend" && cfg.legendDisguise.enabled && phase === "charge";
}

/**
 * 지금 쓸 연출 색. A 구간의 레전드는 **아래 등급 색**(= 다이아인 척), B 구간부터 진짜 색.
 *
 * 색을 컴포넌트가 직접 고르지 않고 여기서 파생시키는 이유: 위장은 "색 하나"가 아니라
 * **색 + 레전드 전용 층의 노출 여부**가 한 몸이라, 판정이 두 곳에 있으면 한쪽만 새기 쉽다.
 */
export function fxAccentOf(
  grade: Grade,
  phase: FxPhase,
  colors: Record<Grade, string>,
  cfg: FxConfig = FX_CONFIG,
): string {
  const d = cfg.legendDisguise;
  if (fxTierOf(grade, cfg) !== "legend" || !d.enabled) return colors[grade];
  if (isDisguised(grade, phase, cfg)) return colors[d.asGrade] ?? colors[grade];
  return d.finalColor ?? colors[grade];
}
