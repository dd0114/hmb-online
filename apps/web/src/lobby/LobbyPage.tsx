import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCreateMatch, useMe, useModes } from "../api/hooks";
import { useToken } from "../auth/TokenContext";
import { providerMeta } from "../auth/login-flow";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import styles from "./LobbyPage.module.css";

export function LobbyPage() {
  const { data: me, isLoading, isError } = useMe();
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

      <div className={styles.menu}>
        <button type="button" className={styles.menuButton} onClick={() => setModeModalOpen(true)}>
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

function ModeModal({ onClose }: { onClose: () => void }) {
  const { data: modes, isLoading, isError } = useModes();
  const createMatch = useCreateMatch();
  const navigate = useNavigate();
  const [createError, setCreateError] = useState<string | null>(null);

  function startSingle() {
    setCreateError(null);
    // POST /api/matches → BRIEFING 매치 생성 → /match/:id (LLD-web §2 /lobby)
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
      {isLoading && <p>불러오는 중…</p>}
      {isError && <ErrorToast message="모드 목록을 불러오지 못했습니다" />}
      <ul className={styles.modeList}>
        {modes?.map((mode) => (
          <li key={mode.id}>
            <button
              type="button"
              className={styles.modeButton}
              disabled={!mode.available || createMatch.isPending}
              onClick={() => {
                if (!mode.available) return;
                if (mode.id === "single") startSingle();
              }}
            >
              <span>
                {mode.id === "single"
                  ? createMatch.isPending
                    ? "매치 생성 중…"
                    : "싱글"
                  : "멀티"}
              </span>
              {!mode.available && <span className={styles.badge}>{mode.label ?? "준비중"}</span>}
            </button>
          </li>
        ))}
      </ul>
      <ErrorToast message={createError} onDismiss={() => setCreateError(null)} />
      <button type="button" className={styles.close} onClick={onClose}>
        닫기
      </button>
    </Modal>
  );
}
