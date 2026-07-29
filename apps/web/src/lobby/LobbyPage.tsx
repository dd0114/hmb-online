import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  useAbandonMatch,
  useActiveMatch,
  useAwayCandidates,
  useAwayReports,
  useCreateMatch,
  useMe,
  useStartAwayMatch,
} from "../api/hooks";
import { useActiveNotices } from "../api/notice-hooks";
import { pickLobbyPopup } from "./lobby-popup";
import { NoticeCenter } from "./NoticeCenter";
import { NoticePopup } from "./NoticePopup";
import { visibleNotices, type Notice } from "./notice-logic";
import { useRelations } from "../api/hooks-v2";
import { useToken } from "../auth/TokenContext";
import { providerMeta } from "../auth/login-flow";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { TeamMoraleWidget } from "../common/RelationBits";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { useTutorial } from "../common/tutorial-context";
import { AwayReportModal } from "./AwayReportModal";
import { shouldShowAwayPopup } from "./away-report-logic";
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
  // `active` 는 **프로바이더의 진행 상태**다(코치마크가 지금 보이는지가 아니다 — 코치마크는
  // 다른 다이얼로그가 열리면 스스로 숨으므로 가시성으로 게이트를 걸면 되먹임이 된다).
  const { active: tutorialActive, restart: restartTutorial } = useTutorial();
  // #217: 강제 이동(MatchLockGate) 대상이 아닌 미완 매치 — 브리핑/사고 상태 — 는 여기서 이어간다.
  const { data: active, isLoading: activeLoading } = useActiveMatch();
  // #245: 부재중 피원정 결과. **강제 이동이 걸린 상태에서는 묻지 않는다** — 로비를 스쳐 지나가는
  // 중에 팝업이 뜨면 읽지도 못한 채 사라지고(멱등 확인이 소진돼) 결과를 영영 못 본다.
  // ⚠️ **로딩 중도 보류다.** `active` 가 오기 전엔 locked 를 알 수 없는데, MatchLockGate 는 의도적으로
  // 로딩 중 아무것도 하지 않는다 — 즉 **로비가 먼저 그려지는 창**이 있고, 그 창에 팝업이 뜨면
  // 오탭(백드롭·Escape) 한 번에 리포트가 소진된다. 이 앱엔 지난 리포트를 볼 화면이 없으므로 영구
  // 소실이다(독립검증 3R blocker). 하필 "자리를 비웠다 돌아온" = 콜드 로드 = 캐시 0 = 두 쿼리 경합이
  // 이 기능의 주 시나리오다. 모르는 동안은 묻지도 띄우지도 않는다.
  const forcedToMatch = activeLoading || Boolean(active?.locked && !active?.abandonable);
  const { data: awayReports } = useAwayReports("unseen", !forcedToMatch);
  const [awayDismissed, setAwayDismissed] = useState(false);
  // hero E1: 팝업은 **[게임 시작]을 누를 때** 뜬다(로비 진입 즉시가 아니라). 경기를 하러 온 순간에
  // "자리를 비운 사이 이런 일이 있었다"를 보여주는 게 맥락이 맞고, 로비를 스쳐 지나갈 때 소진되지도
  // 않는다. 조회는 미리 해둔다 — 누른 뒤에 받아오면 팝업이 한 박자 늦게 뜬다.
  const [playPressed, setPlayPressed] = useState(false);
  const showAwayPopup =
    playPressed && !forcedToMatch && !awayDismissed && shouldShowAwayPopup(awayReports);

  // 팝업을 닫으면 원래 가려던 곳(모드 선택)으로 이어준다 — 한 번 더 누르게 하지 않는다.
  function pressPlay() {
    if (!forcedToMatch && !awayDismissed && shouldShowAwayPopup(awayReports)) {
      setPlayPressed(true);
      return;
    }
    setModeModalOpen(true);
  }

  // ── 공지 팝업 (#248) ───────────────────────────────────────────────────────
  // 응답은 **정규화를 통과한 뒤에만** 만진다 — `data.notices.length` 를 그대로 읽으면 구 서버의
  // 200 `{}` 하나에 로비 전체가 흰 화면이 된다(#245 가 같은 회귀 계약을 갖고 있다).
  const notices = useActiveNotices();
  const [noticeDone, setNoticeDone] = useState(false);
  const candidates = useMemo(
    () => visibleNotices(notices.data, Date.now()),
    [notices.data],
  );

  /**
   * **이번 로비 방문 동안 온보딩이 화면을 잡았는가** — 한 번 참이면 이 방문 내내 참(래치).
   *
   * 왜 `tutorialActive` 만으로 부족한가: 튜토리얼이 **끝나는 그 순간**에 공지를 띄우면 지금
   * 고치려는 상황이 그대로 재현된다. 완료 저장(`persistTutorialDone`)이 `["deck"]`·`["me"]`
   * 캐시를 무효화해 덱 지급 결과로 화면이 바뀌는 바로 그 프레임에 점검 공지가 덮는다.
   * → 공지는 **다음에 로비에 들어올 때** 뜬다.
   *
   * 왜 서버 플래그(`user.tutorialDone`)의 변화로 판정하지 않는가: 그건 계정에 남는 값이라
   * 리로드 뒤에도 "방금 끝났다"로 읽힐 여지가 있고, 그러면 공지가 **영영** 미뤄질 수 있다.
   * 여기 래치는 **컴포넌트 마운트 수명**에만 산다 — 로비를 떠났다 오면(라우트 이동·리로드)
   * 자연히 풀린다. 그게 정확히 "다음 진입"의 정의다.
   *
   * ⚠️ 미룬 공지는 **소진되지 않는다** — 팝업을 렌더하지 않으므로 억제 저장소에 아무것도
   * 쓰이지 않는다(안 뜬 것을 "봤다"로 기록하면 그 공지는 영영 못 본다).
   */
  const tutorialHeldThisVisit = useRef(false);
  if (tutorialActive) tutorialHeldThisVisit.current = true;
  const tutorialHold = tutorialActive || tutorialHeldThisVisit.current;

  // 첫 진입에 보인 목록을 **고정**한다. 포커스 복귀 refetch 로 목록이 갈리면 스택 인덱스가
  // 어긋나 유저가 이미 닫은 장이 다시 앞으로 나온다.
  // 온보딩이 잡고 있는 방문에서는 고정도 하지 않는다 — 어차피 열지 않을 목록을 붙들면,
  // 그 사이 유저가 헤더의 [공지]로 읽은 것까지 나중에 다시 들이밀게 된다.
  const latched = useRef<Notice[] | null>(null);
  if (latched.current === null && !tutorialHold && candidates.length > 0) {
    latched.current = candidates;
  }
  const noticeList = latched.current ?? [];

  // 로비 팝업은 **동시에 하나만** 열린다(#248 §4). 판단은 lobby-popup.ts 한 곳.
  //
  // 두 팝업은 트리거가 다르다 — 공지는 **로비 진입**, 원정(#245)은 **[게임 시작] 클릭**(hero E1).
  // 그래서 현재 구조에선 겹칠 창이 거의 없지만, 트리거는 바뀐다(#245 가 이미 한 번 옮겼다).
  // 겹치면 **공지가 이긴다** — 점검·사고 안내라 시급하고, 원정은 공지를 닫고 CTA 를 다시 누르면
  // 그대로 이어진다(반대로 원정을 먼저 띄우면 점검 공지가 한 텀 늦는다).
  //
  // ⚠️ **온보딩이 잡은 방문에는 공지를 미룬다**(삼키지 않는다). 게임을 처음 켠 사람이 무엇을 하라는
  // 안내를 받기 전에 "새벽 점검 안내"부터 읽게 되던 상태를 막는다 — 코치마크는 다른 다이얼로그가
  // 열리면 스스로 숨으므로(TutorialOverlay), 공지가 뜨는 동안 온보딩은 **조용히 사라져 있었다**.
  // 미룸의 범위는 "튜토리얼이 떠 있는 동안"이 아니라 **이번 방문 전체**다(위 tutorialHeldThisVisit).
  const popup = pickLobbyPopup(
    {
      notice: !noticeDone && noticeList.length > 0,
      away: showAwayPopup,
    },
    { tutorialHold },
  );

  // me 로딩 실패로 header 가 통째로 사라지면 로그아웃 버튼까지 없어져 불량 세션 탈출이 불가했다(#73 P1).
  // 로그아웃은 항상 노출한다.
  const header = (
    <div className={styles.headerRow}>
      <div className={styles.headerLeft}>
        <div className={styles.nickname}>
          {/* 긴 닉네임이 헤더를 밀어 [로그아웃]을 화면 밖으로 내보내던 자리 — 여기서만 줄어든다. */}
          <span className={styles.nicknameText}>{me ? me.user.nickname : "감독님"}</span>
          {/* 놓친 공지를 다시 볼 곳 — 활성 공지가 0건이면 스스로 사라진다(NoticeCenter 주석 §2).
              ⚠️ 자리를 **오른쪽(지갑 옆)이 아니라 닉네임 옆**으로 잡은 것은 취향이 아니라 실측이다:
              오른쪽은 지갑 배지 2개 + [로그아웃] 으로 이미 꽉 차 있어 아이콘 하나를 얹으면 평범한
              계정에서도 헤더가 **한 줄 더 접혔다**(390px 실측 69→113px). 왼쪽은 어느 표본에서도
              +8px 로 끝난다(69→77 · 112→120). 계약 = p248b "진입점이 헤더를 한 줄 늘리지 않는다". */}
          <NoticeCenter notices={notices.data} />
          {provider && (
            <span className={styles.providerBadge} data-testid="provider-badge">
              {providerMeta(provider).badge}
            </span>
          )}
        </div>
        {me && (
          <div className={styles.record}>
            {me.records.wins}승 {me.records.draws}무 {me.records.losses}패
            {/* #245 원정 레이팅 — 지갑 P 와 다른 축이라 재화 배지가 아니라 전적 옆에 둔다.
                구 서버 응답엔 없을 수 있어 optional(없으면 표시하지 않는다). */}
            {me.rating !== undefined && (
              <span className={styles.rating} data-testid="rating-badge" data-rating={me.rating}>
                레이팅 {me.rating}
              </span>
            )}
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
          onClick={pressPlay}
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

      {/* 로비 팝업은 **동시에 하나만** 열린다 — 판정은 pickLobbyPopup 한 곳(#248 §4). */}
      {popup === "notice" && (
        <NoticePopup notices={noticeList} onDone={() => setNoticeDone(true)} />
      )}

      {popup === "away" && awayReports && (
        <AwayReportModal
          data={awayReports}
          onClose={() => {
            setAwayDismissed(true);
            setPlayPressed(false);
            setModeModalOpen(true);   // 원래 가려던 곳으로 이어준다
          }}
        />
      )}
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
  const startAway = useStartAwayMatch();
  const navigate = useNavigate();
  const [createError, setCreateError] = useState<string | null>(null);
  const [awayPicking, setAwayPicking] = useState(false);
  // 후보는 **누른 뒤에** 받아온다 — 미리 받아두면 모드 창을 열기만 해도 서버의 제시가 갱신돼
  // 앞서 받은 목록이 조용히 무효가 된다(제시는 유저당 1개다).
  const { data: offer, isLoading: offerLoading, error: offerError } = useAwayCandidates(awayPicking);

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

  /**
   * 원정(#245) — 상대는 **실유저 팀**이다. 상대가 없으면 서버가 404 NO_OPPONENT 를 주고 우리는
   * 그걸 그대로 말한다(봇으로 몰래 대체하지 않는다 — 그러면 "원정"이 거짓말이 된다).
   */
  /** hero E2: 서버가 제시한 2명 중 고른 상대로 원정을 떠난다. */
  function startAwayMatch(defenderId?: string) {
    setCreateError(null);
    startAway.mutate(defenderId, {
      onSuccess: (match) => navigate(`/match/${match.id}`),
      onError: (err) => {
        const resumeId = matchInProgressIdOf(err);
        if (resumeId) {
          navigate(`/match/${resumeId}`);
          return;
        }
        setCreateError(
          err instanceof ApiError && err.code === "AWAY_DAILY_LIMIT"
            ? err.message
            : err instanceof ApiError && err.code === "NO_OPPONENT"
            ? "아직 원정 갈 상대가 없습니다 — 다른 감독이 팀을 꾸리면 열립니다"
            : err instanceof ApiError && err.code === "DECK_INVALID"
              ? `덱이 유효하지 않습니다 — ${err.message}`
              : err instanceof Error
                ? err.message
                : "원정을 시작하지 못했습니다",
        );
      },
    });
  }

  if (awayPicking) {
    return (
      <Modal
        onClose={onClose}
        labelledBy="away-pick-title"
        overlayClassName={styles.modalOverlay}
        className={styles.modal}
      >
        <h2 id="away-pick-title">원정 상대</h2>
        <p className={styles.awayPickHint}>
          레이팅이 비슷한 두 팀입니다. 한 팀을 고르세요.
          {offer && offer.streak > 0 && (
            <strong data-testid="away-streak"> · {offer.streak}연승 중</strong>
          )}
          {/* 남은 횟수는 **누르기 전에** 말한다 — 눌렀는데 거부되는 건 나쁜 UX 다.
              -1 은 무제한이라 아무것도 표시하지 않는다. */}
          {offer && offer.remainingToday >= 0 && (
            <span data-testid="away-remaining"> · 오늘 {offer.remainingToday}회 남음</span>
          )}
        </p>
        {offerLoading && <p>상대를 찾는 중…</p>}
        {offerError instanceof ApiError && offerError.code === "NO_OPPONENT" && (
          <p data-testid="away-no-opponent">
            아직 원정 갈 상대가 없습니다 — 다른 감독이 팀을 꾸리면 열립니다
          </p>
        )}
        <ul className={styles.modeList}>
          {offer?.candidates.map((c) => (
            <li key={c.userId}>
              <button
                type="button"
                className={styles.modeButton}
                data-testid="away-candidate"
                disabled={startAway.isPending}
                onClick={() => startAwayMatch(c.userId)}
              >
                <span>{c.nickname}</span>
                <span className={styles.modeHint}>레이팅 {c.rating}</span>
              </button>
            </li>
          ))}
        </ul>
        <ErrorToast message={createError} onDismiss={() => setCreateError(null)} />
        <button type="button" className={styles.close} onClick={() => setAwayPicking(false)}>
          뒤로
        </button>
      </Modal>
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
        <li>
          <button
            type="button"
            className={styles.modeButton}
            data-testid="mode-away"
            onClick={() => setAwayPicking(true)}
          >
            <span>원정</span>
            {/* ⚠️ 증감폭을 여기 적지 않는다 — 값의 SoT 는 서버 config(hmb.away.rating.*)이고
                클라가 상수를 베끼면 운영에서 값을 바꿨을 때 화면만 거짓말한다(#213 과 같은 형태).
                실제 증감은 결과 리포트가 서버 값으로 보여준다. */}
            <span className={styles.modeHint}>실제 유저 팀 · 승패로 레이팅 변동</span>
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
