import { Amount } from "../common/Amount";
import { missionTierLabel, normalizeMatchMissions } from "./mission-logic";
import styles from "./MissionRewardSection.module.css";

/**
 * 결과 화면의 **미션 섹션** (#408, 설계 §8 "결과 화면 — additive 필드").
 *
 * 그 경기가 오늘의 미션을 얼마나 밀었는지 보여준다. 진행만 오른 미션도 실려 오므로 같이
 * 그린다 — "이 경기로 미션이 얼마나 갔나"를 보여주는 게 결과 화면의 일이다.
 *
 * <p>⚠️ **일부러 독립 컴포넌트다.** #405(성장·보상 개편)가 `ResultPanel`·`StageShell`·
 * `GrowthReportSection` 을 재작성 중이라, 호출부에는 **한 줄만** 얹어 머지 충돌면을 최소화한다.
 * #405 의 보상 탭이 랜딩하면 이 컴포넌트를 그 탭 안으로 **옮기기만** 하면 된다.
 *
 * <p>⚠️ **수령 버튼은 여기 없다.** `GET /api/matches/{id}/result` 의 미션 객체에는 `state`·
 * `rerollable` 이 없어 "지금 받을 수 있나"를 알 수 없고, 클라가 `progress >= target` 으로
 * 추론하면 그게 설계 §8 이 금지한 재계산이다. 수령은 원정 페이지의 미션 섹션이 한다.
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
        {rows.map((m) => {
          const tierLabel = missionTierLabel(m.tier);
          const label = [
            m.title,
            tierLabel,
            `진행 ${m.progress} / ${m.target}`,
            m.completedNow ? "이번 경기로 달성" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={m.id}
              className={styles.row}
              data-testid="result-mission"
              data-mission-id={m.id}
              data-completed-now={m.completedNow ? "1" : "0"}
              aria-label={label}
            >
              <span className={styles.name}>{m.title}</span>
              <span className={styles.progress} data-testid="result-mission-progress">
                {m.progress} / {m.target}
              </span>
              {/* 달성은 색이 아니라 **말**로 알린다(#262 규율). */}
              {m.completedNow && (
                <span className={styles.done} data-testid="result-mission-done">
                  달성!
                </span>
              )}
              <span className={styles.reward}>
                <Amount code={m.currency} value={m.amount} />
              </span>
            </li>
          );
        })}
      </ul>
      {/* 여기서 받게 하지 않는 이유는 위 주석 — 받는 자리를 한 곳으로 유지한다. */}
      <p className={styles.foot}>달성한 보상은 원정 화면에서 받을 수 있습니다.</p>
    </section>
  );
}
