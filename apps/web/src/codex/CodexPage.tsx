import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayers } from "../api/hooks";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { GRADE_LABELS, GRADE_ORDER, type Grade } from "../common/grades";
import type { components } from "../api/schema";
import { PlayerCard } from "./PlayerCard";
import { CardGrowthDetail } from "./CardGrowthDetail";
import type { CatalogPlayer } from "../api/hooks";
import styles from "./CodexPage.module.css";

type Position = components["schemas"]["Position"];
const POSITION_FILTERS: Array<Position | "ALL"> = ["ALL", "GK", "DF", "MF", "FW"];

export function CodexPage() {
  const navigate = useNavigate();
  const { data: players, isLoading, isError } = usePlayers();
  const [gradeFilter, setGradeFilter] = useState<Grade | "ALL">("ALL");
  const [positionFilter, setPositionFilter] = useState<Position | "ALL">("ALL");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * 보유만 볼지 전체를 볼지 (#286).
   *
   * 육성 탭(`/growth`)이 이 화면으로 병합되면서 **"내가 키우는 카드만 보는 뷰"가 갈 곳을
   * 잃었다** — 그 탭이 하던 일이 정확히 `owned` 필터 하나였다(독립검증 MIN-5).
   * 기본값이 **보유**인 이유: 이 탭은 hero 지정 이름이 "선수 도감"이지만 일상 용도는
   * 내 선수를 보는 것이고, 전체 수집 현황은 한 번 더 눌러서 본다.
   */
  const [ownedOnly, setOwnedOnly] = useState(true);
  // 보유 카드 = 성장 상세 시트(시안3), 미보유 = 기존 인라인 능력치 확장(잠금).
  const [detailPlayer, setDetailPlayer] = useState<CatalogPlayer | null>(null);

  // ⚠️ `(players ?? [])` 로는 부족하다 — 구 서버·빈 응답의 200 `{}` 는 nullish 가 아니라
  // 통과하고 `.filter` 가 던져 **화면이 통째로 흰 화면**이 된다(#245 와 같은 규칙, #286 실측).
  const roster = useMemo(() => (Array.isArray(players) ? players : []), [players]);

  const filtered = useMemo(
    () =>
      roster.filter(
        (p) =>
          (!ownedOnly || p.owned) &&
          (gradeFilter === "ALL" || p.grade === gradeFilter) &&
          (positionFilter === "ALL" || p.position === positionFilter),
      ),
    [roster, ownedOnly, gradeFilter, positionFilter],
  );

  const ownedTotal = useMemo(() => roster.filter((p) => p.owned).length, [roster]);

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/home")}>
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>도감</h1>
      <span className={styles.ownedTotal} data-testid="codex-owned-total">
        보유 {ownedTotal}/{roster.length}
      </span>
    </div>
  );

  return (
    <Layout header={header} nav>
      {isLoading && <p>불러오는 중…</p>}
      {isError && <ErrorToast message="도감을 불러오지 못했습니다" />}

      <div className={styles.filters}>
        <div className={styles.tabRow} role="tablist" aria-label="보유 여부">
          <button
            type="button"
            role="tab"
            aria-selected={ownedOnly}
            className={ownedOnly ? styles.tabActive : styles.tab}
            data-testid="codex-scope-owned"
            onClick={() => setOwnedOnly(true)}
          >
            보유 {ownedTotal}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!ownedOnly}
            className={!ownedOnly ? styles.tabActive : styles.tab}
            data-testid="codex-scope-all"
            onClick={() => setOwnedOnly(false)}
          >
            전체 {roster.length}
          </button>
        </div>
        <div className={styles.tabRow} role="tablist" aria-label="등급 필터">
          {(["ALL", ...GRADE_ORDER] as Array<Grade | "ALL">).map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={gradeFilter === g}
              className={gradeFilter === g ? styles.tabActive : styles.tab}
              data-testid={`codex-grade-${g}`}
              onClick={() => setGradeFilter(g)}
            >
              {g === "ALL" ? "전체" : GRADE_LABELS[g]}
            </button>
          ))}
        </div>
        <div className={styles.tabRow} role="tablist" aria-label="포지션 필터">
          {POSITION_FILTERS.map((pos) => (
            <button
              key={pos}
              type="button"
              role="tab"
              aria-selected={positionFilter === pos}
              className={positionFilter === pos ? styles.tabActive : styles.tab}
              data-testid={`codex-pos-${pos}`}
              onClick={() => setPositionFilter(pos)}
            >
              {pos === "ALL" ? "전체" : pos}
            </button>
          ))}
        </div>
      </div>

      <p className={styles.countNote} data-testid="codex-filtered-count">
        {filtered.length}명
      </p>

      {!isLoading && !isError && filtered.length === 0 ? (
        <p className={styles.emptyNote} data-testid="codex-empty">
          조건에 맞는 선수가 없습니다
        </p>
      ) : (
        <div className={styles.grid} data-testid="codex-grid">
          {filtered.map((p) => (
            <PlayerCard
              key={p.id}
              player={p}
              expanded={expandedId === p.id}
              onToggle={() =>
                p.owned
                  ? setDetailPlayer(p)
                  : setExpandedId((cur) => (cur === p.id ? null : p.id))
              }
            />
          ))}
        </div>
      )}

      {detailPlayer && (
        <CardGrowthDetail player={detailPlayer} onClose={() => setDetailPlayer(null)} />
      )}
    </Layout>
  );
}
