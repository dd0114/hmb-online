import type { PlayerRef } from "../api/v2";
import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { PersonalityBadge } from "../common/RelationBits";
import styles from "./TradePlayerCard.module.css";

/** Attributes shown compactly on a trade card (subset of codex's 9). */
const KEY_ATTRS: Array<[key: keyof CatalogPlayer["attributes"], label: string]> = [
  ["technical", "기술"],
  ["physical", "피지컬"],
  ["passing", "패스"],
  ["shooting", "슈팅"],
  ["pace", "스피드"],
];

interface TradePlayerCardProps {
  player: PlayerRef;
  /**
   * Catalog enrichment (attributes·personality) joined by playerId. PlayerRef itself carries only
   * grade/position/name (openapi-v2), so 능력치·성격 come from the /api/players catalog when known.
   */
  detail?: CatalogPlayer;
  /** Small heading above the card (e.g. "영입 대상", "대가", "요구"). */
  caption?: string;
  reveal?: boolean;
  testId?: string;
}

export function TradePlayerCard({ player, detail, caption, reveal = true, testId }: TradePlayerCardProps) {
  const gradeColor = GRADE_COLORS[player.grade];
  return (
    <div
      className={[styles.card, reveal ? styles.reveal : ""].filter(Boolean).join(" ")}
      style={{ borderColor: gradeColor }}
      data-testid={testId}
      data-grade={player.grade}
    >
      {caption && <span className={styles.caption}>{caption}</span>}
      <span className={styles.pos}>{player.position}</span>
      <CharAvatar
        playerId={player.playerId}
        name={player.name}
        grade={player.grade}
        size={44}
        className={styles.face}
      />
      <span className={styles.name}>{player.name}</span>
      <span className={styles.grade} style={{ color: gradeColor }}>
        {GRADE_LABELS[player.grade]}
      </span>
      {detail?.personality && (
        <span className={styles.personality}>
          <PersonalityBadge personality={detail.personality} size="xs" />
        </span>
      )}
      {detail && (
        <dl className={styles.attrs}>
          {KEY_ATTRS.map(([key, label]) => (
            <div key={key} className={styles.attrRow}>
              <dt className={styles.attrLabel}>{label}</dt>
              <dd className={styles.attrValue}>
                <span className={styles.attrBar}>
                  <span
                    className={styles.attrFill}
                    style={{ width: `${detail.attributes[key]}%`, background: gradeColor }}
                  />
                </span>
                <span className={styles.attrNum}>{Math.round(detail.attributes[key])}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
