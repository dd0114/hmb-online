import { CardFxStage, fxRevealed, useRevealFx } from "./GachaFx";
import { RevealCard } from "./RevealCard";
import { FX_CONFIG, fxTierOf, type FxConfig, type FxPhase, type FxTimings } from "./gacha-fx";
import type { Grade } from "./grades";
import type { FullArtSize } from "./full-art";

/**
 * **이펙트를 두른 리빌 카드 1장** (#250) — 뽑기 결과 화면과 `/design/gacha-fx` 시안 프리뷰가
 * **같은 컴포넌트**를 쓴다.
 *
 * 왜 공유하는가: 프리뷰는 hero 컨펌 게이트다. 프리뷰가 자기 카드를 따로 그리면 **컨펌한 그림과
 * 배선된 그림이 갈라진다** — 그러면 "봤을 때는 괜찮았는데"가 성립한다. 카드 자체(`RevealCard`)를
 * 뽑기·가입지급이 공유하는 이유(#209)와 같은 원칙이다.
 *
 * 이 컴포넌트가 소유하는 것: **자기 시계 하나**. 트리거(`triggered`)를 받으면 A(→B) → 개봉 →
 * 잔광을 스스로 돌고, 그 동안 카드 앞면을 가린다. 부모는 "언제 시작하나"만 정한다.
 */
export interface RevealFxCardProps {
  playerId: string;
  name: string;
  grade: Grade;
  position?: string;
  isNew?: boolean;
  size?: FullArtSize;
  /** 연출 시작 여부. false 면 뒷면 그대로 멈춰 있다. */
  triggered: boolean;
  /** 일괄 공개 스태거(ms). 개별 공개는 0. */
  startDelay?: number;
  timings: FxTimings;
  reduced?: boolean;
  cfg?: FxConfig;
  /** 단계 변화 통지 — 부모가 피날레·완료를 집계한다. */
  onPhase?: (phase: FxPhase) => void;
  onClick?: () => void;
  testId?: string;
}

export function RevealFxCard({
  playerId,
  name,
  grade,
  position,
  isNew = false,
  size = "grid",
  triggered,
  startDelay = 0,
  timings,
  reduced = false,
  cfg = FX_CONFIG,
  onPhase,
  onClick,
  testId,
}: RevealFxCardProps) {
  const tier = fxTierOf(grade, cfg);
  // runId 는 "몇 번째 재생인가"가 아니라 **재생 트리거**다. 0 = 아직 안 눌림.
  const phase = useRevealFx(tier, timings, { runId: triggered ? 1 : 0, startDelay, onPhase });

  return (
    <CardFxStage
      grade={grade}
      phase={phase}
      variant={cfg.variant}
      timings={timings}
      reduced={reduced}
      cfg={cfg}
      /* 좁은 화면에서 파티클을 줄인다 — 판정 기준은 **뷰포트 폭**이고 CSS 미디어쿼리와 같은 경계다. */
      particles={
        typeof window !== "undefined" && window.matchMedia?.("(max-width: 430px)").matches
          ? cfg.particles.mobile
          : cfg.particles.desktop
      }
    >
      <RevealCard
        playerId={playerId}
        name={name}
        grade={grade}
        position={position}
        /* 앞면은 A(+B)가 끝나야 보인다 — 이 한 줄이 anticipation 의 전부다. */
        revealed={fxRevealed(phase)}
        isNew={isNew}
        size={size}
        testId={testId}
        onClick={onClick}
      />
    </CardFxStage>
  );
}
