import { useMemo } from "react";
import { useMatchGrowthReport, usePendingChoices } from "../api/growth-hooks";
import { GrowthRows } from "../rewards/sections/GrowthSection";
import type { RewardGrowthEntry } from "../rewards/types";
import styles from "./ResultPage.module.css";

interface GrowthReportSectionProps {
  matchId: string;
  /**
   * 남은 선택이 있을 때 보상 시트를 다시 여는 문. 없으면 안내만 — 여기서 고를 수 없는데 뱃지만
   * 달아 두면 막다른 길이다.
   */
  onOpenRewards?: (() => void) | undefined;
}

/**
 * 결과 화면의 **성장 리포트** — 보상 시트를 이미 확인한 뒤 "그 판이 무슨 성장을 줬나"를 다시 보는
 * 자리. 행은 보상 시트 성장 탭과 **같은 컴포넌트**(`GrowthRows`)라 두 화면이 갈리지 않는다.
 *
 * ⚠️ **구현이 통째로 바뀌었다 — 서버 계약이 바뀌었기 때문이다** (#405 W2b). 예전 이 컴포넌트는
 * `Object.entries(e.statXp)` 로 스탯별 XP 막대를 그렸는데, 신 모델에는 `statXp`·`levelUps`·
 * `ovrBefore/After` 가 **없다**(스탯은 유저 선택으로만 오르므로 매치 로그로 복원되지 않는다).
 * 그대로 뒀다면 `Object.entries(undefined)` 가 **던져서 결과 화면이 흰 화면**이 됐다.
 *
 * 섹션 자체(`data-testid="growth-report"`)는 남긴다 — `p348-desktop-viewport` ⑥ 이 이 패널의
 * 세로 예산 계약을 여기에 걸고 있다(내용에 상한이 없다는 사실의 증인이다).
 */
export function GrowthReportSection({ matchId, onOpenRewards }: GrowthReportSectionProps) {
  const { data: report } = useMatchGrowthReport(matchId);
  const { data: openChoices } = usePendingChoices(undefined, true);
  const entries = (report?.entries ?? []) as RewardGrowthEntry[];

  const openIds = useMemo(
    () => (openChoices ? new Set(openChoices.map((c) => c.choiceId)) : undefined),
    [openChoices],
  );
  const openHere = useMemo(() => {
    let n = 0;
    for (const e of entries) {
      for (const c of e.pendingChoices ?? []) {
        if (!openIds || openIds.has(c.choiceId)) n += 1;
      }
    }
    return n;
  }, [entries, openIds]);

  if (entries.length === 0) return null;

  return (
    <section className={styles.growthCard} data-testid="growth-report">
      <h3 className={styles.growthTitle}>성장 리포트</h3>
      {openHere > 0 && onOpenRewards && (
        <button
          type="button"
          className={styles.growthPendingCta}
          data-testid="growth-open-rewards"
          onClick={onOpenRewards}
        >
          선택 대기 {openHere} · 지금 선택하기
        </button>
      )}
      <GrowthRows entries={entries} openChoiceIds={openIds} />
    </section>
  );
}
