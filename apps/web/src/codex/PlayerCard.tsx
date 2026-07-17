import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import styles from "./PlayerCard.module.css";

const ATTRIBUTE_LABELS: Array<[key: keyof CatalogPlayer["attributes"], label: string]> = [
  ["technical", "기술"],
  ["mental", "멘탈"],
  ["physical", "피지컬"],
  ["passing", "패스"],
  ["shooting", "슈팅"],
  ["tackling", "태클"],
  ["pace", "스피드"],
  ["stamina", "지구력"],
  ["positioning", "위치선정"],
];

interface PlayerCardProps {
  player: CatalogPlayer;
  expanded: boolean;
  onToggle: () => void;
}

/** 도감 카드 — 등급 색상, 미보유 흑백+잠금, 보유 수. 탭하면 9개 능력치 확장. */
export function PlayerCard({ player, expanded, onToggle }: PlayerCardProps) {
  const gradeColor = GRADE_COLORS[player.grade];

  return (
    <div
      className={[styles.card, player.owned ? "" : styles.unowned, expanded ? styles.expanded : ""]
        .filter(Boolean)
        .join(" ")}
      data-testid={`codex-card-${player.id}`}
      data-owned={player.owned ? "true" : "false"}
    >
      <button type="button" className={styles.summary} onClick={onToggle}>
        <span className={styles.topRow}>
          <span className={styles.pos}>{player.position}</span>
          {player.owned ? (
            player.ownedCount > 1 && <span className={styles.count}>×{player.ownedCount}</span>
          ) : (
            <span className={styles.lock} title="미보유">
              잠금
            </span>
          )}
        </span>
        <span className={styles.name}>{player.name}</span>
        <span className={styles.grade} style={{ color: gradeColor }}>
          {GRADE_LABELS[player.grade]}
        </span>
      </button>

      {expanded && (
        <dl className={styles.attrs} data-testid={`codex-attrs-${player.id}`}>
          {ATTRIBUTE_LABELS.map(([key, label]) => (
            <div key={key} className={styles.attrRow}>
              <dt className={styles.attrLabel}>{label}</dt>
              <dd className={styles.attrValue}>
                <span className={styles.attrBar}>
                  <span
                    className={styles.attrFill}
                    style={{ width: `${player.attributes[key]}%`, background: gradeColor }}
                  />
                </span>
                <span className={styles.attrNum}>{Math.round(player.attributes[key])}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
