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
  // 보유 카드 = 성장 상세 시트(시안3), 미보유 = 기존 인라인 능력치 확장(잠금).
  const [detailPlayer, setDetailPlayer] = useState<CatalogPlayer | null>(null);

  const filtered = useMemo(
    () =>
      (players ?? []).filter(
        (p) =>
          (gradeFilter === "ALL" || p.grade === gradeFilter) &&
          (positionFilter === "ALL" || p.position === positionFilter),
      ),
    [players, gradeFilter, positionFilter],
  );

  const ownedTotal = useMemo(() => (players ?? []).filter((p) => p.owned).length, [players]);

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>도감</h1>
      <span className={styles.ownedTotal} data-testid="codex-owned-total">
        보유 {ownedTotal}/{players?.length ?? 0}
      </span>
    </div>
  );

  return (
    <Layout header={header} nav>
      {isLoading && <p>불러오는 중…</p>}
      {isError && <ErrorToast message="도감을 불러오지 못했습니다" />}

      <div className={styles.filters}>
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
