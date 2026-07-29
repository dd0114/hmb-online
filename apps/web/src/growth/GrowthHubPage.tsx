import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayers, type CatalogPlayer } from "../api/hooks";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import type { components } from "../api/schema";
import { PlayerCard } from "../codex/PlayerCard";
import { CardGrowthDetail } from "../codex/CardGrowthDetail";
import styles from "../codex/CodexPage.module.css";

type Position = components["schemas"]["Position"];
const POSITION_FILTERS: Array<Position | "ALL"> = ["ALL", "GK", "DF", "MF", "FW"];

/**
 * 육성 허브 (성장 시스템 #179) — 보유 카드만 그리드로. 카드 탭 → 성장 상세(시안3: OVR 링·완성도·돌파★)
 * 에서 강화/한계돌파. 도감(전체 수집)과 달리 여기는 "내가 키우는 카드" 전용 진입점.
 */
export function GrowthHubPage() {
  const navigate = useNavigate();
  const { data: players, isLoading, isError } = usePlayers();
  const [positionFilter, setPositionFilter] = useState<Position | "ALL">("ALL");
  const [detailPlayer, setDetailPlayer] = useState<CatalogPlayer | null>(null);

  const owned = useMemo(
    () =>
      (players ?? []).filter(
        (p) => p.owned && (positionFilter === "ALL" || p.position === positionFilter),
      ),
    [players, positionFilter],
  );
  const ownedTotal = useMemo(() => (players ?? []).filter((p) => p.owned).length, [players]);

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/home")}>
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>육성</h1>
      <span className={styles.ownedTotal} data-testid="growth-owned-total">
        보유 {ownedTotal}
      </span>
    </div>
  );

  return (
    <Layout header={header} nav>
      {isLoading && <p>불러오는 중…</p>}
      {isError && <ErrorToast message="보유 선수를 불러오지 못했습니다" />}

      <p className={styles.countNote}>탭하면 성★ 승급·잠재능력 다이스로 카드를 키울 수 있어요.</p>

      <div className={styles.filters}>
        <div className={styles.tabRow} role="tablist" aria-label="포지션 필터">
          {POSITION_FILTERS.map((pos) => (
            <button
              key={pos}
              type="button"
              role="tab"
              aria-selected={positionFilter === pos}
              className={positionFilter === pos ? styles.tabActive : styles.tab}
              data-testid={`growth-pos-${pos}`}
              onClick={() => setPositionFilter(pos)}
            >
              {pos === "ALL" ? "전체" : pos}
            </button>
          ))}
        </div>
      </div>

      {!isLoading && !isError && owned.length === 0 ? (
        <p className={styles.emptyNote} data-testid="growth-empty">
          보유한 선수가 없습니다. 상점에서 카드를 뽑아보세요.
        </p>
      ) : (
        <div className={styles.grid} data-testid="growth-grid">
          {owned.map((p) => (
            <PlayerCard key={p.id} player={p} expanded={false} onToggle={() => setDetailPlayer(p)} />
          ))}
        </div>
      )}

      {detailPlayer && (
        <CardGrowthDetail player={detailPlayer} onClose={() => setDetailPlayer(null)} />
      )}
    </Layout>
  );
}
