import type { Personality, RelationsResponse } from "../api/v2";
import {
  moraleTier,
  personalityMeta,
  streakLabel,
  streakTone,
  trustTier,
} from "./relations";
import styles from "./RelationBits.module.css";

/** 성격 뱃지 (도감·선수 시트) — 이모지 + 라벨, 툴팁에 AI 반응 힌트. */
export function PersonalityBadge({
  personality,
  size = "sm",
}: {
  personality: Personality | undefined;
  size?: "sm" | "xs";
}) {
  const meta = personalityMeta(personality);
  if (!meta) return null;
  return (
    <span
      className={size === "xs" ? styles.badgeXs : styles.badge}
      data-testid="personality-badge"
      data-personality={meta.id}
      title={meta.hint}
    >
      <span aria-hidden="true">{meta.emoji}</span>
      <span className={styles.badgeLabel}>{meta.label}</span>
    </span>
  );
}

/** 신뢰도 게이지 (선수 시트) — 0..100 채움 바 + 티어 라벨. */
export function TrustGauge({ trust }: { trust: number }) {
  const tier = trustTier(trust);
  return (
    <span className={styles.trust} data-testid="trust-gauge" data-trust={tier.value} title={`신뢰도 ${tier.value}% · ${tier.label}`}>
      <span className={styles.trustLabel}>신뢰</span>
      <span className={styles.trustBar}>
        <span
          className={styles.trustFill}
          style={{ width: `${Math.round(tier.ratio * 100)}%`, background: tier.color }}
        />
      </span>
      <span className={styles.trustValue} style={{ color: tier.color }}>
        {tier.value}
      </span>
    </span>
  );
}

/** 팀 사기 위젯 (로비·덱) — 사기 게이지 + 연승/연패 스트릭. */
export function TeamMoraleWidget({
  relations,
  compact = false,
}: {
  relations: RelationsResponse | undefined;
  compact?: boolean;
}) {
  if (!relations) return null;
  const tier = moraleTier(relations.morale);
  const tone = streakTone(relations.streak);
  const toneClass = tone === "win" ? styles.streakWin : tone === "loss" ? styles.streakLoss : styles.streakNone;
  return (
    <div
      className={compact ? styles.moraleCompact : styles.morale}
      data-testid="team-morale"
      data-morale={tier.value}
      data-streak={relations.streak}
    >
      <div className={styles.moraleHead}>
        <span className={styles.moraleTitle}>팀 사기</span>
        <span className={styles.moraleTierLabel} style={{ color: tier.color }}>
          {tier.label}
        </span>
      </div>
      <span className={styles.moraleBar}>
        <span
          className={styles.moraleFill}
          style={{ width: `${Math.round(tier.ratio * 100)}%`, background: tier.color }}
        />
      </span>
      <span className={`${styles.streak} ${toneClass}`} data-testid="team-streak">
        {streakLabel(relations.streak)}
      </span>
    </div>
  );
}
