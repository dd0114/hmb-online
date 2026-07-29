import { useCallback, useMemo, useState } from "react";
import type { GachaResponse } from "../api/hooks";
import { Modal } from "../common/Modal";
import { FinaleFx, useFxTimings } from "../common/GachaFx";
import { RevealFxCard } from "../common/RevealFxCard";
import { FX_CONFIG, batchFxPlan, fxTierOf, type FxPhase } from "../common/gacha-fx";
import type { Grade } from "../common/grades";
import {
  initialReveal,
  isAllRevealed,
  isCardRevealed,
  revealAll,
  revealNext,
} from "./reveal-logic";
import styles from "./GachaReveal.module.css";

interface GachaRevealProps {
  response: GachaResponse;
  onClose: () => void;
}

/**
 * 뽑기 결과 연출 (AC-W3): 카드 뒤집기 순차 공개(CSS transition), 하이라이트, isNew 뱃지.
 * 순차 진행 상태는 reveal-logic.ts(순수, 테스트됨)가 소유.
 *
 * #187 (hero 확정 A안): 공개된 카드는 **전부 풀아트**다 — 수집의 하이라이트라 아이콘으로
 * 때우지 않는다. 이름·포지션·등급은 카드 프레임의 하단 밴드가 이미 자리를 갖고 있어
 * `FullArtCard` 가 그 위에 얹는다(카드 밖 텍스트 중복 제거).
 *
 * **#250 고레어 이펙트**: 다이아 이상이면 카드가 곧바로 뒤집히지 않고 **빛이 모인 뒤**에 열린다
 * (레전드는 그 뒤에 격상 구간 B 가 하나 더 + 확장 피날레). 판정·타이밍은 `common/gacha-fx.ts`,
 * 카드 1장은 `common/RevealFxCard`(프리뷰와 공유) 소유. 여기 남은 것은 **언제 트리거하나** 뿐이다:
 *  · 개별 공개 = 트리거 즉시(지연 0)
 *  · 일괄 공개 = 고레어만 골라 낮은 등급 → 높은 등급 순 스태거(`batchFxPlan`)
 */
export function GachaReveal({ response, onClose }: GachaRevealProps) {
  const [state, setState] = useState(() => initialReveal(response.results.length));
  const { timings, reduced } = useFxTimings();

  /**
   * 인덱스별 연출 시작 지연(ms). 일괄 공개일 때만 채워진다.
   *
   * ⚠️ **"트리거됨"과 "앞면이 보임"은 다르다.** `reveal-logic` 은 전자만 센다(순수 상태 그대로).
   * 앞면 노출은 각 카드가 자기 시계로 정한다 — 그래야 고레어의 기대감 구간이 성립한다.
   */
  const [delays, setDelays] = useState<Record<number, number>>({});
  /** 확장 피날레(레전드) — 카드가 finale 단계에 들어갈 때 시트 전체에 한 번 깐다. */
  const [finale, setFinale] = useState<{ runId: number; grade: Grade } | null>(null);
  /**
   * 연출까지 **끝난 카드의 인덱스**. 확인 버튼은 이게 다 차야 나온다(끝나기 전에 닫히면 연출이 잘린다).
   *
   * ⚠️ 개수(`n + 1`)가 아니라 **집합**인 이유: 단계 통지가 어떤 이유로든 중복되면 카운터는 조용히
   * 부풀고 확인 버튼이 일찍 뜬다 — 실제로 타이머 경계 중복으로 그 일이 있었다(BL-1). 근본 원인은
   * `useRevealFx` 에서 고쳤지만, **집계 쪽도 중복에 무감각해야** 같은 사고가 다른 경로로 재발하지 않는다.
   */
  const [settled, setSettled] = useState<Set<number>>(() => new Set());

  const triggeredAll = isAllRevealed(state);
  const done = triggeredAll && settled.size >= state.total;

  const handleAdvance = useCallback(() => setState((s) => revealNext(s)), []);

  /**
   * 일괄 공개 — 아직 안 뒤집힌 카드들만 대상으로 계획을 세운다.
   * 이미 공개된 카드를 계획에 넣으면 그 자리만큼 스태거가 비어 **아무 일도 안 일어나는 공백**이 생긴다.
   */
  const handleRevealAll = useCallback(() => {
    // ⚠️ 계획은 **updater 밖에서** 세운다. `setState(s => …)` 안에서 다른 setState 를 부르면
    // updater 가 순수하지 않아 React 가 재실행할 때 부수효과가 중복된다(지연 표가 어긋난다).
    const pending = response.results
      .map((r, i) => ({ i, grade: r.player.grade as Grade }))
      .filter(({ i }) => !isCardRevealed(state, i));
    const plan = batchFxPlan(pending.map((p) => p.grade));
    const next: Record<number, number> = {};
    for (const step of plan) {
      const target = pending[step.index];
      if (target) next[target.i] = step.delayMs;
    }
    setDelays(next);
    setState((s) => revealAll(s));
  }, [response.results, state]);

  /** 카드 1장의 단계 변화 → 피날레 트리거 + 완료 집계. */
  const onCardPhase = useCallback(
    (index: number, grade: Grade, phase: FxPhase) => {
      if (phase === "finale") setFinale({ runId: index + 1, grade });
      if (phase === "done") {
        setSettled((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
      }
    },
    [],
  );

  /** 레전드가 하나라도 있으면 피날레 길이만큼 시트가 더 살아 있어야 한다. */
  const hasLegend = useMemo(
    () => response.results.some((r) => fxTierOf(r.player.grade as Grade) === "legend"),
    [response.results],
  );

  return (
    // 공개 도중에는 Escape/백드롭으로 닫히지 않게 dismissable=done (실수로 결과를 놓치지 않도록).
    <Modal
      onClose={onClose}
      labelledBy="gacha-reveal-title"
      dismissable={done}
      overlayClassName={styles.overlay}
      className={styles.sheet}
      testId="gacha-reveal"
    >
      <h2 id="gacha-reveal-title" className={styles.title}>
        뽑기 결과 ({response.results.length}명)
      </h2>

        <div className={styles.grid}>
          {response.results.map((item, i) => (
            /* 카드 1장의 뒤집기·풀아트·NEW 뱃지·고레어 이펙트는 공용 RevealFxCard 가 그린다
               (#209 로 추출한 RevealCard 위에 #250 이펙트 층). 여기 남은 것은 그리드와 진행 제어뿐. */
            <RevealFxCard
              key={`${item.player.id}-${i}`}
              playerId={item.player.id}
              name={item.player.name}
              grade={item.player.grade as Grade}
              position={item.player.position}
              triggered={isCardRevealed(state, i)}
              startDelay={delays[i] ?? 0}
              timings={timings}
              reduced={reduced}
              isNew={item.isNew}
              size="grid"
              testId={`gacha-card-${i}`}
              onPhase={(p) => onCardPhase(i, item.player.grade as Grade, p)}
              onClick={handleAdvance}
            />
          ))}
        </div>

        <div className={styles.actions}>
          {triggeredAll && !done ? (
            /*
             * 전부 트리거됐지만 연출이 남은 구간. 예전 버튼을 `disabled` 로 두면 "다음 공개 (7/7)"이
             * 그대로 남아 **누를 수 있어 보이는데 안 눌리는** 상태가 된다(모바일 캡처에서 실제로 그랬다).
             * 남은 것이 기다림뿐이면 화면도 기다림이라고 말해야 한다.
             */
            <button type="button" className={styles.primary} data-testid="gacha-revealing" disabled>
              공개 중…
            </button>
          ) : !done ? (
            <>
              <button
                type="button"
                className={styles.primary}
                data-testid="gacha-reveal-next"
                onClick={handleAdvance}
              >
                다음 공개 ({state.revealed}/{state.total})
              </button>
              <button
                type="button"
                className={styles.secondary}
                data-testid="gacha-reveal-all"
                onClick={handleRevealAll}
              >
                모두 공개
              </button>
            </>
          ) : (
            <button type="button" className={styles.primary} data-testid="gacha-close" onClick={onClose}>
              확인
            </button>
          )}
        </div>

        {/* 확장 피날레는 카드 밖(시트 전체)으로 번져야 해서 그리드가 아니라 여기 있다. */}
        {hasLegend && finale && (
          <FinaleFx
            grade={finale.grade}
            variant={FX_CONFIG.variant}
            reduced={reduced}
            runId={finale.runId}
            durationMs={timings.finale}
          />
        )}
    </Modal>
  );
}
