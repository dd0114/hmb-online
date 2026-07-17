import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMe, useModes } from "../api/hooks";
import { useToken } from "../auth/TokenContext";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import styles from "./LobbyPage.module.css";

export function LobbyPage() {
  const { data: me, isLoading, isError } = useMe();
  const { logout } = useToken();
  const navigate = useNavigate();
  const [modeModalOpen, setModeModalOpen] = useState(false);

  const header = me ? (
    <div className={styles.headerRow}>
      <div>
        <div className={styles.nickname}>{me.user.nickname}</div>
        <div className={styles.record}>
          {me.records.wins}승 {me.records.draws}무 {me.records.losses}패
        </div>
      </div>
      <div className={styles.headerRight}>
        <PointsBadge points={me.wallet.points} />
        <button type="button" className={styles.logout} onClick={logout}>
          로그아웃
        </button>
      </div>
    </div>
  ) : undefined;

  return (
    <Layout header={header}>
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
  const navigate = useNavigate();

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <h2>모드 선택</h2>
        {isLoading && <p>불러오는 중…</p>}
        {isError && <ErrorToast message="모드 목록을 불러오지 못했습니다" />}
        <ul className={styles.modeList}>
          {modes?.map((mode) => (
            <li key={mode.id}>
              <button
                type="button"
                className={styles.modeButton}
                disabled={!mode.available}
                onClick={() => {
                  if (!mode.available) return;
                  // R1 전 임시 — 실제 매치 생성/브리핑 플로우는 W2. 지금은 라우팅 스켈레톤만.
                  navigate("/match/stub");
                }}
              >
                <span>{mode.id === "single" ? "싱글" : "멀티"}</span>
                {!mode.available && <span className={styles.badge}>{mode.label ?? "준비중"}</span>}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className={styles.close} onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
