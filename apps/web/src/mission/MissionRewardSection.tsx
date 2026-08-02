import { useState } from "react";
import { Amount } from "../common/Amount";
import { missionError, useClaimMission } from "../api/mission-hooks";
import {
  missionClaimable,
  missionTierLabel,
  normalizeMatchMissions,
  type MatchMission,
} from "./mission-logic";
import styles from "./MissionRewardSection.module.css";

/**
 * 결과 화면의 **미션 섹션** (#408, 설계 §8 "결과 화면 — additive 필드").
 *
 * 그 경기가 오늘의 미션을 얼마나 밀었는지 보여주고, **달성한 것은 그 자리에서 받는다**
 * (설계 §6.6: *"원정 경기 직후면 결과 보상 탭에 미션 달성 섹션으로"*). 진행만 오른 미션도
 * 실려 오므로 같이 그린다 — "이 경기로 미션이 얼마나 갔나"를 보여주는 게 결과 화면의 일이다.
 *
 * <p>⚠️ **일부러 독립 컴포넌트다.** #405(성장·보상 개편)가 `ResultPanel`·`StageShell`·
 * `GrowthReportSection` 을 재작성 중이라, 호출부에는 **한 줄만** 얹어 머지 충돌면을 최소화한다.
 * #405 의 보상 탭이 랜딩하면 이 컴포넌트를 그 탭 안으로 **옮기기만** 하면 된다.
 *
 * <p>⚠️ **[받기]의 문은 서버 `state` 하나다**(`6b38674` 가 실어 준 필드). 그 필드가 없던 동안은
 * 버튼을 아예 두지 못했다 — `progress >= target` 으로 열면 **수령한 뒤에도 버튼이 남는다**
 * (`2/2 + CLAIMED` 가 그 표본이다). 구 서버(필드 부재)는 `state:""` 라 문이 닫힌 쪽으로 떨어진다.
 *
 * <p>⚠️ **`completedNow` 는 서버가 준 사실이다** — 진행도에서 파생하지 않는다. 이전 경기에서
 * 이미 달성돼 있던 미션도 배열에 실려 오고, 그 둘은 화면에서 다른 말을 해야 한다.
 */
export function MissionRewardSection({ missions }: { missions?: unknown }) {
  const rows = normalizeMatchMissions(missions);
  // 원정이 아니거나 구 서버면 배열 자체가 없다 — 그때는 구역을 통째로 안 그린다(#286 W5 규율).
  if (rows.length === 0) return null;

  return (
    <section className={styles.card} data-testid="result-missions">
      <h3 className={styles.title}>🎯 오늘의 미션</h3>
      <ul className={styles.list}>
        {rows.map((m) => (
          <MissionRow key={m.id} mission={m} />
        ))}
      </ul>
    </section>
  );
}

function MissionRow({ mission: m }: { mission: MatchMission }) {
  const claim = useClaimMission();
  const [error, setError] = useState<string | null>(null);
  const tierLabel = missionTierLabel(m.tier);
  const claimable = missionClaimable(m);

  const label = [
    m.title,
    tierLabel,
    `진행 ${m.progress} / ${m.target}`,
    m.completedNow ? "이번 경기로 달성" : null,
    m.state === "CLAIMED" ? "수령 완료" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      className={styles.row}
      data-testid="result-mission"
      data-mission-id={m.id}
      data-completed-now={m.completedNow ? "1" : "0"}
      data-state={m.state}
      aria-label={label}
    >
      <div className={styles.line}>
        <span className={styles.name}>{m.title}</span>
        <span className={styles.reward}>
          <Amount code={m.currency} value={m.amount} />
        </span>
      </div>
      <div className={styles.line}>
        <span className={styles.progress} data-testid="result-mission-progress">
          {m.progress} / {m.target}
        </span>
        {/* 달성은 색이 아니라 **말**로 알린다(#262 규율). */}
        {m.completedNow && (
          <span className={styles.done} data-testid="result-mission-done">
            달성!
          </span>
        )}
        {claimable ? (
          <button
            type="button"
            className={styles.claim}
            data-testid="result-mission-claim"
            disabled={claim.isPending}
            onClick={() => {
              setError(null);
              claim.mutate(m.id, { onError: (e) => setError(missionError(e)) });
            }}
          >
            {claim.isPending ? "받는 중…" : "받기"}
          </button>
        ) : (
          // 이미 받았으면 그렇게 말한다. 진행 중이면 누를 것이 없으니 버튼 자체가 없다.
          m.state === "CLAIMED" && (
            <span className={styles.claimed} data-testid="result-mission-claimed">
              ✓ 받음
            </span>
          )
        )}
      </div>
      {error && (
        <p className={styles.error} data-testid="result-mission-error">
          {error}
        </p>
      )}
    </li>
  );
}
