import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCreateMatch, useMe } from "../api/hooks";
import { useRelations } from "../api/hooks-v2";
import { useToken } from "../auth/TokenContext";
import { providerMeta } from "../auth/login-flow";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { TeamMoraleWidget } from "../common/RelationBits";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import styles from "./LobbyPage.module.css";

export function LobbyPage() {
  const { data: me, isLoading, isError } = useMe();
  const { data: relations } = useRelations();
  const { logout, provider } = useToken();
  const navigate = useNavigate();
  const [modeModalOpen, setModeModalOpen] = useState(false);

  // me 로딩 실패로 header 가 통째로 사라지면 로그아웃 버튼까지 없어져 불량 세션 탈출이 불가했다(#73 P1).
  // 로그아웃은 항상 노출한다.
  const header = (
    <div className={styles.headerRow}>
      <div>
        <div className={styles.nickname}>
          {me ? me.user.nickname : "감독님"}
          {provider && (
            <span className={styles.providerBadge} data-testid="provider-badge">
              {providerMeta(provider).badge}
            </span>
          )}
        </div>
        {me && (
          <div className={styles.record}>
            {me.records.wins}승 {me.records.draws}무 {me.records.losses}패
          </div>
        )}
      </div>
      <div className={styles.headerRight}>
        {me && <PointsBadge points={me.wallet.points} />}
        <button type="button" className={styles.logout} onClick={logout}>
          로그아웃
        </button>
      </div>
    </div>
  );

  return (
    <Layout header={header} nav>
      {isLoading && <p>불러오는 중…</p>}
      {isError && <ErrorToast message="내 정보를 불러오지 못했습니다" />}

      <TeamMoraleWidget relations={relations} />

      <div className={styles.menu}>
        <button
          type="button"
          className={styles.menuButton}
          data-testid="play-cta"
          onClick={() => setModeModalOpen(true)}
        >
          게임 시작
        </button>
        <button type="button" className={styles.menuButton} onClick={() => navigate("/deck")}>
          덱 구성
        </button>
        <button type="button" className={styles.menuButton} onClick={() => navigate("/shop")}>
          상점
        </button>
        <button type="button" className={styles.menuButton} onClick={() => navigate("/codex")}>
          도감
        </button>
      </div>

      {modeModalOpen && <ModeModal onClose={() => setModeModalOpen(false)} />}
    </Layout>
  );
}

/**
 * 게임 시작 = 연습/리그 선택(AC-F1, LLD-p2-web §6 로비 개편).
 * - 연습: POST /api/matches → BRIEFING → /match/:id (기존 싱글 풀 플로우).
 * - 리그: /league 로 이동(시즌 없으면 시작 CTA, 있으면 대시보드).
 */
function ModeModal({ onClose }: { onClose: () => void }) {
  const createMatch = useCreateMatch();
  const navigate = useNavigate();
  const [createError, setCreateError] = useState<string | null>(null);

  function startPractice() {
    setCreateError(null);
    createMatch.mutate(
      {},
      {
        onSuccess: (match) => navigate(`/match/${match.id}`),
        onError: (err) => {
          setCreateError(
            err instanceof ApiError && err.code === "DECK_INVALID"
              ? `덱이 유효하지 않습니다 — ${err.message}`
              : err instanceof Error
                ? err.message
                : "매치 생성에 실패했습니다",
          );
        },
      },
    );
  }

  return (
    <Modal
      onClose={onClose}
      labelledBy="mode-modal-title"
      overlayClassName={styles.modalOverlay}
      className={styles.modal}
    >
      <h2 id="mode-modal-title">모드 선택</h2>
      <ul className={styles.modeList}>
        <li>
          <button
            type="button"
            className={styles.modeButton}
            disabled={createMatch.isPending}
            data-testid="mode-practice"
            onClick={startPractice}
          >
            <span>{createMatch.isPending ? "매치 생성 중…" : "연습 경기"}</span>
            <span className={styles.modeHint}>봇과 단판</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={styles.modeButton}
            data-testid="mode-league"
            onClick={() => navigate("/league")}
          >
            <span>리그</span>
            <span className={styles.modeHint}>10팀 18라운드</span>
          </button>
        </li>
      </ul>
      <ErrorToast message={createError} onDismiss={() => setCreateError(null)} />
      <button type="button" className={styles.close} onClick={onClose}>
        닫기
      </button>
    </Modal>
  );
}
