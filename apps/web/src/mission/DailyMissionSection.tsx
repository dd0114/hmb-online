import { useState } from "react";
import { Amount } from "../common/Amount";
import { missionError, useClaimMission, useDailyMissions, useRerollMission } from "../api/mission-hooks";
import {
  missionClaimLabel,
  missionClaimable,
  missionDayLabel,
  missionStateGlyph,
  missionStateLabel,
  missionTierLabel,
  pickDailyMissions,
  progressRatio,
  rerollBlockReason,
  resetNoticeText,
  type DailyMission,
  type PendingClaim,
} from "./mission-logic";
import styles from "./DailyMissionSection.module.css";

/**
 * 오늘의 원정 미션 (#408, 설계 = `docs/plan-v5/away-daily-mission.md`).
 *
 * hero 확정 자리 = **원정 페이지 안 섹션**(§7 Q5). 하루 2개가 14종에서 균등 추첨되고, 미션당
 * 한 번씩 다시 뽑을 수 있다.
 *
 * <p>⚠️ **여기엔 규칙이 하나도 없다.** 문구·티어·금액·진행도·달성 여부·리롤 가능 여부까지 전부
 * 서버가 완성해서 준 값을 그리기만 한다(`league/DailyRewardTrack` 과 같은 규율). `tier === "HARD"
 * ? 300` 같은 걸 적는 순간 economy 노브를 돌렸을 때 화면이 서버가 하지 않는 일을 단언한다.
 *
 * <p>⚠️ **서버가 미션 블록을 안 주면 섹션을 통째로 안 그린다**(#286 W5 규율). 구 서버(404)와
 * 롤백 스위치(`hmb.mission.daily.count: 0` → `missions: []`)가 그 상태이고, 스켈레톤이나 에러를
 * 띄우면 "아직 없는 기능"이 "고장 난 화면"으로 읽힌다.
 */
export function DailyMissionSection() {
  const { data } = useDailyMissions();
  const view = pickDailyMissions(data);
  if (!view) return null;

  return (
    <section className={styles.card} data-testid="daily-mission-section">
      {/* 오늘 미션이 없을 수도 있다(롤백 스위치) — 그때 이 머리말은 거짓말이라 같이 감춘다.
          그래도 아래 "받지 않은 보상"은 남는다(설계 §9: 끄기가 지갑을 뺏지 않는다). */}
      {view.missions.length > 0 && (
        <>
          <div className={styles.head}>
            <h2 className={styles.title}>🎯 오늘의 미션</h2>
            {/* "자정에 초기화"를 코드에 적지 않는다 — 경계는 서버가 `resetAtKst` 로 말한다. */}
            <ResetNote resetAtKst={view.resetAtKst} />
          </div>
          <p className={styles.hint}>원정 경기로만 채워집니다. 미션마다 한 번씩 다시 뽑을 수 있습니다.</p>

          <ul className={styles.list}>
            {view.missions.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </ul>
        </>
      )}

      {/**
       * 받지 않은 보상 (#408 갭1) — **지난 날짜**의 달성분.
       *
       * ⚠️ 이 묶음이 없던 것이 W3 의 버그였다: 홈은 "받을 보상 1건"이라고 말하는데 원정 화면엔
       * 받을 카드가 없었다 = §6.3(달성분은 기한 없이 남는다)이 **화면에서 도달 불가능**했다.
       * ⚠️ 오늘 것은 여기 안 들어온다(서버 보증) — 중복 제거를 클라가 하지 마라.
       */}
      {view.pendingClaims.length > 0 && (
        <div className={styles.group} data-testid="pending-claims">
          <h2 className={styles.title}>🎁 받지 않은 보상</h2>
          <p className={styles.hint}>지난 미션에서 달성한 보상입니다. 기한 없이 받을 수 있습니다.</p>
          <ul className={styles.list}>
            {view.pendingClaims.map((p) => (
              <PendingClaimRow key={p.id} claim={p} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * 지난 보상 한 줄. **진행 막대·[다시 뽑기]가 없다** — `progress`/`target`/`rerollable` 이 아예
 * 안 오고(끝난 미션), 지난 미션 리롤은 410 `MISSION_EXPIRED` 다. 없는 데이터를 0 으로 그리면
 * "0 / 0" 같은 거짓이 뜬다.
 */
function PendingClaimRow({ claim: row }: { claim: PendingClaim }) {
  const claim = useClaimMission();
  const [error, setError] = useState<string | null>(null);
  const tierLabel = missionTierLabel(row.tier);
  const dayLabel = missionDayLabel(row.day);

  return (
    <li
      className={styles.mission}
      data-testid="pending-claim"
      data-mission-id={row.id}
      data-tier={row.tier}
      aria-label={[row.title, tierLabel, dayLabel, "받지 않은 보상"].filter(Boolean).join(" · ")}
    >
      <div className={styles.row}>
        {tierLabel && (
          <span className={styles.tier} data-testid="mission-tier">
            {tierLabel}
          </span>
        )}
        <b className={styles.name} data-testid="mission-title">
          {row.title}
        </b>
        <span className={styles.reward}>
          <Amount code={row.currency} value={row.amount} />
        </span>
      </div>
      <div className={styles.row}>
        {/* 언제 것인지 말한다 — 안 그러면 "이게 왜 여기 있지"가 된다. 못 읽으면 아무 말 안 한다. */}
        <span className={styles.progress} data-testid="pending-claim-day">
          {dayLabel ?? ""}
        </span>
        <button
          type="button"
          className={styles.claimSmall}
          data-testid="pending-claim-claim"
          disabled={claim.isPending}
          onClick={() => {
            setError(null);
            claim.mutate(row.id, { onError: (e) => setError(missionError(e)) });
          }}
        >
          {claim.isPending ? "받는 중…" : "받기"}
        </button>
      </div>
      {error && (
        <p className={styles.error} data-testid="mission-error">
          {error}
        </p>
      )}
    </li>
  );
}

function ResetNote({ resetAtKst }: { resetAtKst: string }) {
  // 못 읽으면 아무 말도 하지 않는다 — 지어낸 시각이 진짜보다 나쁘다.
  const text = resetNoticeText(resetAtKst);
  if (!text) return null;
  return (
    <span className={styles.reset} data-testid="mission-reset">
      {text}
    </span>
  );
}

function MissionCard({ mission }: { mission: DailyMission }) {
  const claim = useClaimMission();
  const reroll = useRerollMission();
  const [error, setError] = useState<string | null>(null);

  const tierLabel = missionTierLabel(mission.tier);
  const stateLabel = missionStateLabel(mission.state);
  const glyph = missionStateGlyph(mission.state);
  const claimable = missionClaimable(mission);
  const rerollBlocked = rerollBlockReason(mission);
  const busy = claim.isPending || reroll.isPending;

  const label = [
    mission.title,
    tierLabel,
    `진행 ${mission.progress} / ${mission.target}`,
    stateLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  function run(kind: "claim" | "reroll") {
    setError(null);
    const mutation = kind === "claim" ? claim : reroll;
    mutation.mutate(mission.id, { onError: (e) => setError(missionError(e)) });
  }

  return (
    <li
      className={styles.mission}
      data-testid="mission-card"
      data-mission-id={mission.id}
      data-state={mission.state}
      data-tier={mission.tier}
      data-rerollable={mission.rerollable ? "1" : "0"}
      aria-label={label}
    >
      <div className={styles.row}>
        {/* 티어는 색만으로 말하지 않는다 — 라벨 텍스트가 1차 채널이다(#262 적록색약 규율). */}
        {tierLabel && (
          <span className={styles.tier} data-testid="mission-tier">
            {tierLabel}
          </span>
        )}
        <b className={styles.name} data-testid="mission-title">
          {mission.title}
        </b>
        <span className={styles.reward}>
          <Amount code={mission.currency} value={mission.amount} />
        </span>
      </div>

      <div className={styles.bar} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${progressRatio(mission) * 100}%` }} />
      </div>

      <div className={styles.row}>
        <span className={styles.progress} data-testid="mission-progress">
          {mission.progress} / {mission.target}
        </span>
        {stateLabel && (
          <span
            className={styles.state}
            data-testid="mission-state"
            aria-label={stateLabel}
          >
            {glyph && <span aria-hidden="true">{glyph} </span>}
            {stateLabel}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.claim}
          data-testid="mission-claim"
          // ⚠️ 문은 서버의 `state` 하나다 — `progress >= target` 으로 열지 마라(설계 §8).
          disabled={!claimable || busy}
          onClick={() => run("claim")}
        >
          {claim.isPending ? "받는 중…" : missionClaimLabel(mission)}
        </button>
        <button
          type="button"
          className={styles.reroll}
          data-testid="mission-reroll"
          // ⚠️ 문은 서버의 `rerollable` 하나다 — "1회 썼나/달성했나"를 클라가 추론하지 않는다.
          disabled={!mission.rerollable || busy}
          onClick={() => run("reroll")}
        >
          {reroll.isPending ? "바꾸는 중…" : "다시 뽑기"}
        </button>
      </div>

      {/* 잠긴 이유를 말한다 — 비활성 버튼만 두면 유저는 이유를 못 찾는다(복수 큐 선례). */}
      {rerollBlocked && (
        <span className={styles.reason} data-testid="mission-reroll-reason">
          {rerollBlocked}
        </span>
      )}
      {error && (
        <p className={styles.error} data-testid="mission-error">
          {error}
        </p>
      )}
    </li>
  );
}
