import type { CatalogPlayer } from "../api/hooks";
import { GRADE_COLORS, GRADE_GLOW_COLORS, GRADE_LABELS } from "../common/grades";
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
  /**
   * 이 카드에 **미룬 강화 선택권**이 있나 (#457 D). 판정은 `CodexPage` 가 `usePendingChoices()`
   * 로 한 번에 하고, 카드는 그리기만 한다 — 카드마다 조회를 걸면 목록 한 판에 172 왕복이다.
   */
  growthPending?: boolean;
}

/**
 * 도감 카드 — 등급 색상, 미보유 **전신 실루엣**+잠금, 보유 수. 탭하면 9개 능력치 확장.
 *
 * ── ⚠️ #187 정책을 hero 가 뒤집었다 (#286 W3) ─────────────────────────────────
 * 원래 규칙은 "그리드는 172장이 깔리는 밀집 UI라 아이콘 48 유지, 풀아트는 강화 상세가 갖는다"
 * 였다. hero 판정: *"아이콘 아니라 전신 보여주자. 아이콘만 하면 모으는 재미가 떨어질 것 같아."*
 *
 * 원 규칙의 근거는 두 가지였고 둘 다 처리했다:
 *  1. **밀집 UI 성능/밀도** → 카드 폭은 그리드 토큰(`size="grid"`)으로 묶는다.
 *  2. **"잠긴 카드에 원색 전신을 띄우면 잠금 표현과 어긋난다"** → 미보유는 **전신 실루엣**이라
 *     그 어긋남이 사라진다. 오히려 "무엇을 못 가졌는지"가 실루엣으로 읽힌다.
 *
 * ⚠️ 아트 실태를 알고 쓴다: 선수 180명에 그림 23종이고 **133명이 공용 `default-unit`** 을
 * 공유한다. 전신 전환의 실효는 LEGEND·DIA 39명에 있고, 나머지는 **아트 발행**이 있어야 한다
 * (data/design 스코프 — `docs/plan-v5/home-nav.md` §3.5).
 */
export function PlayerCard({ player, expanded, onToggle, growthPending = false }: PlayerCardProps) {
  const gradeColor = GRADE_COLORS[player.grade];

  return (
    <div
      className={[styles.card, player.owned ? "" : styles.unowned, expanded ? styles.expanded : ""]
        .filter(Boolean)
        .join(" ")}
      data-testid={`codex-card-${player.id}`}
      data-owned={player.owned ? "true" : "false"}
      data-growth-pending={growthPending ? "true" : "false"}
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
          {/* **강화 가능 뱃지** (#457 D, hero: *"강화 가능 선수 표시"*) — 목록에서 "할 일이 있다"를
              말하는 유일한 신호다. 빛은 `GRADE_GLOW_COLORS`(프레임 광원색, #250 축)를 쓴다. */}
          {growthPending && (
            <span
              className={styles.growthPending}
              style={{ ["--glow" as string]: GRADE_GLOW_COLORS[player.grade] }}
              data-testid={`codex-growth-${player.id}`}
              title="강화 선택 대기"
            >
              강화
            </span>
          )}
          <span className={styles.topRight}>
            {/* 비활성 표기(#207 U-D7) — hero 지시 그대로 **텍스트 "off"**, 베타 단계 최소형.
                왜 필요한가: 표기가 없으면 도감에 보이는데 아무리 뽑아도 안 나오는 카드가
                "버그인가?"가 된다. 서버가 미보유 비활성은 아예 안 내려주므로 여기 걸리는 건
                **보유 중인 비활성 카드**뿐이다. `active` 가 없는 구 서버 응답에는 안 붙는다. */}
            {player.active === false && (
              <span className={styles.off} data-testid={`codex-off-${player.id}`} title="신규 획득 불가">
                off
              </span>
            )}
            {player.owned ? (
              player.ownedCount > 1 && <span className={styles.count}>×{player.ownedCount}</span>
            ) : (
              <span className={styles.lock} title="미보유">
                잠금
              </span>
            )}
          </span>
        </span>
        {/* 전신 카드. 이름·등급은 **카드 밖**에서 이미 보여주므로 `variant="art"` 로 아트만 쓴다 —
            프레임 통짜를 쓰면 에셋의 하단 밴드가 빈 검은 띠로 남는다(#207 실측). */}
        <span
          className={player.owned ? styles.art : `${styles.art} ${styles.artLocked}`}
          /* ⚠️ 접두어를 `codex-card-` 로 되돌리지 마라 — 카드 루트가 `codex-card-{id}` 라
             `[data-testid^="codex-card-"]` 셀렉터가 카드마다 **2개**를 잡는다(실측 24장 → 48노드).
             `FullArtCard` 가 `full-art-` 로 이미 당한 함정이다(독립검증 MIN-1). */
          data-testid="codex-art"
        >
          <FullArtCard
            playerId={player.id}
            /* ⚠️ 미보유면 **이름도 넘기지 않는다** — 아트가 없는 등급(#285 임계 아래)에서는
               폴백이 **이름 파생 이니셜**을 그려서, 라벨만 `？？？` 로 가려도 카드 안에 이름이
               그대로 남는다(실측: "선2"). 가린 척만 하는 상태였다(독립검증 W3 MAJ-1). */
            name={player.owned ? player.name : "？"}
            grade={player.grade}
            position={player.position}
            size="grid"
            variant="art"
            showLabels={false}
          />
        </span>
        {/* 미보유는 이름을 감춘다 — 실루엣인데 이름이 보이면 "가린 것"이 아니라 "덜 그린 것"이 된다. */}
        <span className={styles.name}>{player.owned ? player.name : "？？？"}</span>
        <span className={styles.grade} style={{ color: gradeColor }}>
          {GRADE_LABELS[player.grade]}
        </span>
        {player.personality && (
          <span className={styles.personality}>
            <PersonalityBadge personality={player.personality} size="xs" />
          </span>
        )}
      </button>

      {/* 펼침 = **미보유(잠금) 카드 전용** 경로다 — main(#179)에서 보유 선수 탭은 강화 상세
          모달로 바뀌었다(CodexPage `onToggle`). 그래서 여기에 풀아트를 두지 않는다:
          잠긴 카드에 전신 일러스트를 원색으로 띄우면 잠금 표현과 어긋나고, 풀아트가 필요한
          자리는 강화 상세(`CardGrowthDetail`)다(#187). */}
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
