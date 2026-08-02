import type { PendingChoice } from "../../api/growth";
import { CharAvatar, initialsOf } from "../../common/CharAvatar";
import { GRADE_COLORS, GRADE_LABELS, GRADE_ORDER, type Grade } from "../../common/grades";
import type { RewardGrowthEntry } from "../types";
import styles from "./GrowthSection.module.css";

/**
 * 보상 봉투의 **성장 섹션** (#405 §2.9, 목업 화면 ②).
 *
 * 한 판이 누구에게 얼마의 XP 를 줬고 누가 레벨업했는지를 **한 페이지**에서 본다.
 * 선발 11 + 투입 교체가 위, 미투입 벤치는 구분선 아래 `+0 XP` 회색 — *"안 뛰면 안 큰다"* 가
 * 화면에서 읽혀야 한다는 게 이 섹션의 확인 포인트다.
 *
 * ⚠️ **행의 XP 진행바는 없다**(목업에는 있었다). 봉투의 성장 엔트리에는 `xpGained`·`levelBefore`
 * ·`levelAfter` 만 있고 **현재 레벨 안에서 얼마나 찼는지(`cardXp`/`xpToNext`)가 없다** — 서버가
 * 정산 스냅샷에 싣지 않는다. 임계는 무배포 조정 대상이라(§2.8 `xp.lvBase`/`lvPow`) 클라가 곡선을
 * 미러링해 그리면 계수를 바꾸는 날 막대만 조용히 거짓말한다. 그래서 **레벨 전이(Lv N → Lv M)를
 * 직접 보여주고 막대는 그리지 않는다**. 되살리려면 서버가 엔트리에 두 값을 실어야 한다.
 *
 * ⚠️ **'교체 투입' 칩도 없다** — 엔트리에 출전 구분(starter/partial/bench)이 없다. 화면이 아는
 * 것은 `xpGained === 0`(미투입)뿐이라 그 축만 그린다. 반쯤 아는 것을 다 아는 척 그리지 않는다.
 */

/** 등급을 아는 행만 아바타를 그린다 — `CharAvatar.grade` 는 필수 prop 이고 정책은 fail-closed(#285). */
function isGrade(g: string | null | undefined): g is Grade {
  return typeof g === "string" && (GRADE_ORDER as readonly string[]).includes(g);
}

function RowAvatar({ entry }: { entry: RewardGrowthEntry }) {
  if (isGrade(entry.grade)) {
    return (
      <CharAvatar
        playerId={entry.playerId}
        name={entry.name}
        grade={entry.grade}
        size={38}
        className={styles.avatar}
      />
    );
  }
  // 카탈로그에 없는 선수(발행 사고). 등급을 모르므로 아트도 등급색도 없다 — 자리만 지킨다.
  return (
    <span className={styles.avatarFallback} data-art-policy="hidden" aria-hidden="true">
      {initialsOf(entry.name)}
    </span>
  );
}

interface GrowthRowProps {
  entry: RewardGrowthEntry;
  open: PendingChoice[];
  onPick?: ((choice: PendingChoice) => void) | undefined;
}

function GrowthRow({ entry, open, onPick }: GrowthRowProps) {
  const leveled =
    typeof entry.levelBefore === "number" &&
    typeof entry.levelAfter === "number" &&
    entry.levelAfter > entry.levelBefore;
  const idle = !entry.xpGained;
  const tappable = open.length > 0 && Boolean(onPick);
  const cls = [styles.row, leveled ? styles.rowLevelUp : "", idle ? styles.rowIdle : ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <RowAvatar entry={entry} />
      <span className={styles.rowMain}>
        <span className={styles.rowTop}>
          <span className={styles.rowName}>{entry.name}</span>
          {entry.position && <span className={styles.chip}>{entry.position}</span>}
          {isGrade(entry.grade) && (
            <span className={styles.chip} style={{ color: GRADE_COLORS[entry.grade], borderColor: "currentColor" }}>
              {GRADE_LABELS[entry.grade]}
            </span>
          )}
          <span
            className={idle ? `${styles.xpGain} ${styles.xpGainZero}` : styles.xpGain}
            data-testid={`growth-row-xp-${entry.playerId}`}
          >
            +{entry.xpGained ?? 0} XP
          </span>
        </span>
        <span className={styles.rowBot}>
          {typeof entry.levelBefore === "number" && typeof entry.levelAfter === "number" ? (
            <span className={styles.lvLine} data-testid={`growth-level-${entry.playerId}`}>
              Lv {entry.levelBefore}
              {leveled && (
                <>
                  <span className={styles.lvArrow} aria-hidden="true">
                    →
                  </span>
                  <b className={styles.lvNext}>Lv {entry.levelAfter}</b>
                </>
              )}
            </span>
          ) : (
            // W2b 이전 정산분 — 서버가 레벨을 모른다. 0 으로 때우면 "Lv 0" 이라는 거짓이 뜬다.
            <span className={styles.lvLine}>레벨 기록 없음</span>
          )}
          {open.length > 0 && (
            <span className={styles.pendTag} data-testid={`growth-pending-${entry.playerId}`}>
              선택 대기 {open.length}
            </span>
          )}
        </span>
      </span>
    </>
  );

  if (tappable) {
    return (
      <button
        type="button"
        className={`${cls} ${styles.rowTappable}`}
        data-testid={`growth-row-${entry.playerId}`}
        onClick={() => onPick?.(open[0]!)}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={cls} data-testid={`growth-row-${entry.playerId}`}>
      {body}
    </div>
  );
}

export interface GrowthRowsProps {
  entries: RewardGrowthEntry[];
  /**
   * **아직 안 고른** 선택권 id. `undefined` 면 엔트리의 정산 스냅샷을 그대로 센다(경기 직후에는
   * 둘이 같다 — `openChoicesOf` 주석). 이걸 안 넘기면 고른 선택이 뱃지에 영원히 남는다.
   */
  openChoiceIds?: ReadonlySet<string> | undefined;
  onPick?: ((choice: PendingChoice) => void) | undefined;
}

function openOf(entry: RewardGrowthEntry, ids: ReadonlySet<string> | undefined): PendingChoice[] {
  const all = Array.isArray(entry.pendingChoices) ? entry.pendingChoices : [];
  return ids ? all.filter((c) => ids.has(c.choiceId)) : all;
}

/** 행 목록만 — 결과 화면의 성장 리포트가 같은 행을 재사용한다(두 화면이 갈리지 않게). */
export function GrowthRows({ entries, openChoiceIds, onPick }: GrowthRowsProps) {
  const played = entries.filter((e) => (e.xpGained ?? 0) > 0);
  const bench = entries.filter((e) => !(e.xpGained ?? 0));
  const ups = played.filter(
    (e) =>
      typeof e.levelBefore === "number" &&
      typeof e.levelAfter === "number" &&
      e.levelAfter > e.levelBefore,
  ).length;
  const pending = entries.reduce((n, e) => n + openOf(e, openChoiceIds).length, 0);

  return (
    <>
      <p className={styles.summary} data-testid="growth-summary">
        <b>{played.length}명</b> 출전 · <b>{ups}명</b> 레벨업 · 선택 대기 <b>{pending}회</b>
      </p>
      <div className={styles.rows}>
        {played.map((e) => (
          <GrowthRow key={e.playerId} entry={e} open={openOf(e, openChoiceIds)} onPick={onPick} />
        ))}
      </div>
      {bench.length > 0 && (
        <>
          <p className={styles.benchDivider} data-testid="growth-bench-divider">
            미투입 벤치 · XP 0
          </p>
          <div className={styles.rows}>
            {bench.map((e) => (
              <GrowthRow key={e.playerId} entry={e} open={openOf(e, openChoiceIds)} onPick={onPick} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export interface GrowthSectionProps extends GrowthRowsProps {}

/** 보상 시트의 `GROWTH` 탭 본문. */
export function GrowthSection(props: GrowthSectionProps) {
  return (
    <section data-testid="reward-section-GROWTH">
      <GrowthRows {...props} />
    </section>
  );
}
