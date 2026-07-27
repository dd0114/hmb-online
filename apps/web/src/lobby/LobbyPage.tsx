import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAbandonMatch, useActiveMatch, useCreateMatch, useMe } from "../api/hooks";
import { useRelations } from "../api/hooks-v2";
import { useToken } from "../auth/TokenContext";
import { providerMeta } from "../auth/login-flow";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { TeamMoraleWidget } from "../common/RelationBits";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { useTutorial } from "../common/tutorial-context";
import {
  matchInProgressIdOf,
  resumeLabelFor,
  shouldOfferResume,
  type ActiveMatchInfo,
} from "../common/match-lock";
import styles from "./LobbyPage.module.css";

export function LobbyPage() {
  const { data: me, isLoading, isError } = useMe();
  const { data: relations } = useRelations();
  const { logout, provider } = useToken();
  const navigate = useNavigate();
  const [modeModalOpen, setModeModalOpen] = useState(false);
  const { restart: restartTutorial } = useTutorial();
  // #217: 강제 이동(MatchLockGate) 대상이 아닌 미완 매치 — 브리핑/사고 상태 — 는 여기서 이어간다.
  const { data: active } = useActiveMatch();

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
        {me && <PointsBadge points={me.wallet.points} gems={me.wallet.gems ?? 0} />}
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

      {shouldOfferResume(active) && active?.match && (
        <ResumeMatchCard active={active as ActiveMatchInfo} />
      )}

      <div className={styles.menu}>
        <button
          type="button"
          className={styles.menuButton}
          data-testid="play-cta"
          onClick={() => setModeModalOpen(true)}
        >
          게임 시작
        </button>
        {/* data-testid = 튜토리얼 코치마크 대상(src/common/tutorial-steps.ts). */}
        <button
          type="button"
          className={styles.menuButton}
          data-testid="lobby-deck"
          onClick={() => navigate("/deck")}
        >
          덱 구성
        </button>
        <button
          type="button"
          className={styles.menuButton}
          data-testid="lobby-shop"
          onClick={() => navigate("/shop")}
        >
          상점
        </button>
        <button
          type="button"
          className={styles.menuButton}
          data-testid="lobby-codex"
          onClick={() => navigate("/codex")}
        >
          도감
        </button>
      </div>

      {/* 설정 진입점이 아직 없으므로 로비에 다시보기 1개(PRD-v4 §B "설정에서 다시보기 옵션"). */}
      <button
        type="button"
        className={styles.tutorialReplay}
        data-testid="tutorial-replay"
        onClick={restartTutorial}
      >
        튜토리얼 다시 보기
      </button>

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
          // #217: "이미 진행 중인 경기가 있다"(409)는 실패가 아니라 **이어가라는 안내**다.
          // 서버가 detail.matchId 를 싣는 이유가 이것 — 문구만 띄우면 유저는 막다른 길에 선다.
          const resumeId = matchInProgressIdOf(err);
          if (resumeId) {
            navigate(`/match/${resumeId}`);
            return;
          }
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

/**
 * 진행 중 매치 이어하기 카드 (#217 AC1/AC3).
 *
 * <p>강제 이동(MatchLockGate)이 걸리지 않는 두 부류가 여기로 온다: <b>브리핑</b>(아직 킥오프 전이라
 * 고를 자유가 있다)과 <b>회수 가능한 사고 매치</b>(생성 실패·시계 멈춤). 후자에게 이 카드는 단순한
 * 편의가 아니라 <b>유일한 탈출구</b>다 — 포기 버튼이 없으면 그 계정은 새 경기를 영영 못 만든다.
 */
function ResumeMatchCard({ active }: { active: ActiveMatchInfo }) {
  const navigate = useNavigate();
  const matchId = active.match!.id;
  const abandon = useAbandonMatch(matchId);
  const [abandonError, setAbandonError] = useState<string | null>(null);

  return (
    <section className={styles.resumeCard} data-testid="resume-match-card">
      <h2 className={styles.resumeTitle}>진행 중인 경기</h2>
      <p className={styles.resumeNote} data-testid="resume-match-note">
        {resumeLabelFor(active.match!.state)}
      </p>
      <div className={styles.resumeActions}>
        <button
          type="button"
          className={styles.resumePrimary}
          data-testid="resume-match"
          onClick={() => navigate(`/match/${matchId}`)}
        >
          이어하기
        </button>
        {active.abandonable && (
          <button
            type="button"
            className={styles.resumeSecondary}
            data-testid="abandon-match"
            disabled={abandon.isPending}
            onClick={() =>
              abandon.mutate(undefined, {
                onError: (err) =>
                  setAbandonError(err instanceof Error ? err.message : "포기하지 못했습니다"),
              })
            }
          >
            {abandon.isPending ? "포기하는 중…" : "경기 포기"}
          </button>
        )}
      </div>
      <ErrorToast message={abandonError} onDismiss={() => setAbandonError(null)} />
    </section>
  );
}
