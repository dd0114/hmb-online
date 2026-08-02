import type { PlayerRef } from "../api/v2";
import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { FullArtCard } from "../common/FullArtCard";
import { PersonalityBadge } from "../common/RelationBits";
import { playerNameOf } from "../common/player-names";
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
  /**
   * 얼굴을 **풀아트 카드**로 그린다 (#187). 협상의 주인공(영입 대상)에만 켠다 —
   * 대가/요구까지 켜면 모바일 390 에서 카드 3장이 90px 밑으로 내려가 일러스트가 안 읽힌다.
   */
  fullArt?: boolean;
}

export function TradePlayerCard({
  player,
  detail,
  caption,
  reveal = true,
  testId,
  fullArt = false,
}: TradePlayerCardProps) {
  const gradeColor = GRADE_COLORS[player.grade];
  /*
   * ⚠️ **여기서만 우선순위가 뒤집혀 있었다**(#406 W1b). 부모(`TradeSlotCard`)는 `catalog.get(playerId)`
   * 로 카탈로그 행을 조인해 `detail` 로 넘기는데, 이 카드는 이름만 서버 `PlayerRef.name` 에서
   * 읽었다 — 사다리(카탈로그 → given → `미상 선수`)와 정반대다. 카탈로그가 한글로 갈린 뒤
   * 트레이드에서만 옛 이름이 남는 형태가 된다. 축은 **full**: 카드 한 줄을 통째로 쓰는 자리이고
   * 아바타 이니셜(`initialsOf`)도 풀네임 전제다(TacticsBoard 선례).
   */
  const displayName = playerNameOf(detail, "full", player.name);
  return (
    <div
      className={[styles.card, reveal ? styles.reveal : ""].filter(Boolean).join(" ")}
      style={{ borderColor: gradeColor }}
      data-testid={testId}
      data-grade={player.grade}
    >
      {caption && <span className={styles.caption}>{caption}</span>}
      {/* 풀아트일 때는 카드 좌상단 뱃지가 포지션을 이미 말한다 → 캡션 줄에서 빼서 중복을 없앤다.
          (뱃지 쪽을 빼면 아트에 구워진 **캐릭터** 포지션이 노출돼 교차 매핑 선수에서 틀린다.) */}
      {!fullArt && <span className={styles.pos}>{player.position}</span>}
      {fullArt ? (
        <FullArtCard
          playerId={player.playerId}
          name={displayName}
          grade={player.grade}
          position={player.position}
          size="detail"
          /* 이름·등급·능력치는 카드 밖에 이미 있다 → 아트만(빈 밴드 제거). 포지션은 **카드 뱃지**가
             맡고 캡션 줄에서 뺐다 — 뱃지는 선수 값으로 덮여 있어 교차 매핑에서도 정확하다(#187). */
          variant="art"
          className={styles.face}
        />
      ) : (
        <CharAvatar
          playerId={player.playerId}
          name={displayName}
          grade={player.grade}
          size={44}
          className={styles.face}
        />
      )}
      <span className={styles.name}>{displayName}</span>
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
