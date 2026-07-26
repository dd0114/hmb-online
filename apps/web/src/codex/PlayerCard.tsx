import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { FullArtCard } from "../common/FullArtCard";
import { PersonalityBadge } from "../common/RelationBits";
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

/**
 * 도감 카드 — 등급 색상, 미보유 흑백+잠금, 보유 수. 탭하면 9개 능력치 확장.
 *
 * #187: **접힘 = 아이콘 48**(그리드는 172장이 깔리는 밀집 UI), **펼침 = 풀아트**.
 * 그리드 전체를 풀아트로 바꾸면 첫 로드에 172장 × 2요청이 걸린다 —
 * 확장된 카드만 받으므로 실제 요청은 펼친 것 하나뿐이다(lazy).
 */
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
      <button
        type="button"
        className={styles.summary}
        aria-expanded={expanded}
        aria-controls={`codex-attrs-${player.id}`}
        onClick={onToggle}
      >
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
        <CharAvatar
          playerId={player.id}
          name={player.name}
          grade={player.grade}
          size={48}
          className={styles.avatar}
        />
        <span className={styles.name}>{player.name}</span>
        <span className={styles.grade} style={{ color: gradeColor }}>
          {GRADE_LABELS[player.grade]}
        </span>
        {player.personality && (
          <span className={styles.personality}>
            <PersonalityBadge personality={player.personality} size="xs" />
          </span>
        )}
      </button>

      {expanded && (
        <div className={styles.detail}>
          <FullArtCard
            playerId={player.id}
            name={player.name}
            grade={player.grade}
            position={player.position}
            size="detail"
            className={styles.detailArt}
          />
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
        </div>
      )}
    </div>
  );
}
