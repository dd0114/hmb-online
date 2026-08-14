import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useActiveMatch, useAwayReports, useDeck, useMe } from "../api/hooks";
import { useLeague } from "../api/hooks-v2";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { AwayReportModal } from "../lobby/AwayReportModal";
import { shouldShowAwayPopup } from "../lobby/away-report-logic";
import { useDecklessGuard } from "../common/useDecklessGuard";
import { deckMissing } from "../common/deckless";
import {
  markPracticeTutorialAnswered,
  shouldOfferPracticeTutorial,
} from "../common/guide-storage";
import { PracticeTutorialDialog } from "../home/PracticeTutorialDialog";
import { useOnRail } from "../onrail/onrail-context";
import { practiceOfferDecision } from "../onrail/practice-offer";
import { ONRAIL_EVENTS, reportOnRail } from "../onrail/onrail-telemetry";
import { shouldForceResume } from "../common/match-lock";
import { useAppConfigValue } from "../common/AppConfigContext";
import { usePracticeStart } from "../common/usePracticeStart";
import { aiModeNotice, leagueModeHint } from "./game-logic";
import styles from "./GamePage.module.css";

/**
 * 게임 탭 (#286 W2) — **모드 선택 하나만** 한다.
 *
 * 현행 로비의 `[게임 시작]` **모달이 이 화면으로 승격**된 자리다. 모달이던 시절엔 눌러 보기
 * 전까지 리그·원정의 존재조차 알 수 없었고, 내 리그가 몇 라운드인지 원정에서 무슨 일이 있었는지
 * 놓을 자리가 없었다. 이제 카드마다 **자기 상태**를 단다.
 *
 * ⚠️ **연습은 최하단·무채색·축소**다(hero Q1 확정). 리그·원정이 본 게임이고 연습은 시험대라는
 * 뜻을 배치로 읽히게 한 것이라, 순서를 올리거나 색을 주면 그 뜻이 사라진다.
 * 계약 = `e2e/p286-home-nav.spec.ts`("연습이 마지막이다").
 */
export function GamePage() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: league } = useLeague();

  /**
   * #245 피원정 리포트 팝업 — 트리거가 **[원정] 카드 클릭**으로 옮겨왔다(#286).
   *
   * 예전 트리거는 로비 `[게임 시작]` 이었는데 그 버튼이 없어졌다. 홈의 [게임 시작]에 걸지 않은
   * 이유는 그게 이제 **탭 이동일 뿐**이라서다 — "자리를 비운 사이 이런 일이 있었다"는 원정을
   * 하러 가는 순간에 보여주는 게 맥락이 맞다. 조회는 **미리** 해 둔다(누른 뒤 받아오면 한 박자 늦다).
   */
  // ⚠️ **강제 이동 중에는 조회조차 하지 않는다**(apps/web/CLAUDE.md #245 절). 이 화면을 스쳐
  // 매치로 튕기는 사이 팝업이 뜨면 읽지도 못한 채 ack 이 소진되고, 이 앱엔 지난 리포트를 볼
  // 화면이 없으므로 **영구 소실**이다. 로딩 중(`activeLoading`)도 보류다 — 모르는 동안은 묻지
  // 않는다(#245 3R blocker 가 그 창을 잡았다). 이관하면서 한 번 잃었다(독립검증 MAJ-1).
  // #471 AC3 — 라이브 AI 가 아니면 여기서 한 번 알려 준다(막지 않는다, 안내만).
  const aiNotice = aiModeNotice(useAppConfigValue()?.ai);

  const { data: active, isLoading: activeLoading } = useActiveMatch();
  const forcedToMatch = activeLoading || shouldForceResume(active);
  const { data: awayReports } = useAwayReports("unseen", !forcedToMatch);
  const [awayDismissed, setAwayDismissed] = useState(false);
  const [awayPressed, setAwayPressed] = useState(false);
  const showAwayPopup =
    awayPressed && !forcedToMatch && !awayDismissed && shouldShowAwayPopup(awayReports);

  /**
   * 덱 없는 유저 가드 — L2·L3 (#286 W3.5).
   *
   * L2 = URL 직접 진입·뒤로가기로 홈 타일(L1)을 지나쳐 온 경로.
   * L3 = 클라 가드를 통과한 뒤 **서버가 거부**하는 경합(다른 탭에서 덱 삭제 등).
   *      클라 가드는 진실이 아니므로, 서버 응답도 **같은 안내**로 흡수한다.
   */
  const deckless = useDecklessGuard();

  /**
   * #504 D1-A — **온레일 제안의 판정 지점**(hero 결정, 2026-08-15).
   *
   * ## 왜 여기인가
   * 이 판정은 원래 홈 타일 `pressTile` 한 곳에만 있었다. 그런데 이 화면으로 오는 길은 그것 하나가
   * 아니다 — **하단탭 [게임]**(전 화면 상시 노출) · 덱 화면의 `navigate("/game")` · URL 직접 ·
   * 뒤로가기. 그 경로들은 판정을 **평가조차 하지 않아** 신규 유저가 온레일의 존재를 모른 채
   * 지나갔다(오픈베타 실유저 2명 / 발화 0명). 그래서 판정을 **버튼이 아니라 도착**으로 올렸다.
   *
   * ⚠️ **홈 타일은 이제 이동만 한다.** 두 화면이 각자 판정하면 그게 다시 두 벌이 되고, 새 진입로가
   * 생길 때마다 또 샌다 — 이번 결함의 형태 그대로다.
   *
   * ⚠️ **덱을 알기 전에는 판정하지 않는다**(`deck === undefined` = 로딩). `deckMissing` 은 로딩을
   * `false` 로 읽으므로, 기다리지 않으면 D3 분기가 언제나 "제안"으로 굳어 스위치가 무의미해진다.
   * 같은 이유로 `userId` 도 `me` 도착 뒤에만 본다(익명 키를 만들지 않는 규율 때문에 로딩 중
   * `shouldOfferPracticeTutorial` 은 언제나 false 다).
   *
   * ⚠️ **한 마운트에 한 번만 판정한다**(`decidedRef`). 이유는 "답한 유저가 다시 막힌다"가 **아니다** —
   * 답하면 `eligible` 이 거짓이 되어 판정이 `"none"` 이라 그 일은 일어날 수 없다(초판 주석의 근거가
   * 틀렸다, 독립 검증 m2). 실제 이유는 **한 방문의 판정을 하나로 굳히는 것**이다: `deck` 이 리페치로
   * `null → 객체` 로 바뀌면 같은 방문에서 `offer_missed` 와 `offer_shown` 이 **둘 다** 나가고, 그러면
   * D3 창의 크기를 재는 축이 흐려진다(서버는 각각 유저당 1행으로 받으므로 지워지지도 않는다).
   *
   * ⚠️ **대가**: 캐시가 아직 `null` 인 채로 도착하면 그 방문은 `deckless-first` 로 굳는다(늦게 도착한
   * 덱으로 제안이 승격되지 않는다). 자격은 소모되지 않으므로 **다음 진입에 제안된다** — 그 창을 없애려면
   * 위 두 이벤트가 같이 나가는 것을 감수해야 하고, 지금은 측정을 택했다.
   */
  const userId = me?.user?.id ?? null;
  const { data: deck } = useDeck();
  const [practiceAsk, setPracticeAsk] = useState(false);
  const decidedRef = useRef<string | null>(null);
  const onRail = useOnRail();

  useEffect(() => {
    if (!userId || deck === undefined) return;
    if (decidedRef.current === userId) return;
    const decision = practiceOfferDecision({
      eligible: shouldOfferPracticeTutorial(userId),
      deckMissing: deckMissing(deck),
    });
    if (decision === "none") return;
    decidedRef.current = userId;
    if (decision === "offer") {
      // 제안이 **실제로 떴다**는 사실. 이게 없으면 "못 받았다"와 "받고 거절했다"의 서버 흔적이 같다.
      reportOnRail(userId, ONRAIL_EVENTS.offerShown);
      setPracticeAsk(true);
      return;
    }
    /*
     * `deckless-first` — D3 기본값(②현행 유지)이 만드는 **남은 우회 창**이다. 자격이 있는데
     * 제안 없이 도착한 것이므로 그대로 센다. ⚠️ D1-A 로 동선 우회가 사라져도 이 이벤트가 죽지
     * 않는 이유가 여기다 — 그 크기가 D3 스위치를 뒤집을지의 근거가 된다.
     */
    reportOnRail(userId, ONRAIL_EVENTS.offerMissed);
  }, [userId, deck]);

  /**
   * 수락 = **온레일 시작**(#493 W7-v3) — 매치는 여기서 만들지 않는다. 덱 화면부터 안내하고,
   * 경기는 온레일이 S2(덱 저장)를 마친 뒤 [경기 시작] CTA 에서 만든다(`onRail.start()` 가 `/deck` 로).
   */
  function acceptPracticeTutorial() {
    markPracticeTutorialAnswered(userId);
    reportOnRail(userId, ONRAIL_EVENTS.accepted);
    setPracticeAsk(false);
    onRail.start();
  }

  /**
   * 거절 = **이 화면에 그대로** 둔다. 안내가 동선을 끊지 않는다 — 유저는 원래 여기로 오려던
   * 참이었다(구 동작은 홈에서 물었으므로 `/game` 으로 보내 줘야 했다). 다시 묻지 않는다.
   */
  function declinePracticeTutorial() {
    markPracticeTutorialAnswered(userId);
    reportOnRail(userId, ONRAIL_EVENTS.declined);
    onRail.skip();
    setPracticeAsk(false);
  }

  function pressAway() {
    if (!deckless.guard()) return;
    if (!forcedToMatch && !awayDismissed && shouldShowAwayPopup(awayReports)) {
      setAwayPressed(true);
      return;
    }
    navigate("/away");
  }

  /**
   * ⚠️ **연습경기 시작 로직은 여기 있지 않다** — 홈 [게임 시작]의 튜토리얼 제안(#493 W5)이
   * 두 번째 호출부가 되면서 `common/usePracticeStart` 한 곳으로 옮겼다. 409(이어하기)·L3(서버
   * 덱 거부) 처리가 두 벌이 되면 한쪽이 조용히 낡는다(`useDecklessGuard` 와 같은 이유).
   */
  const practice = usePracticeStart(deckless);

  const header = (
    <div className={styles.headerRow}>
      <h1 className={styles.pageTitle}>게임</h1>
    </div>
  );

  const hint = leagueModeHint(me?.league?.divisionName ?? null, league?.season ?? null);

  return (
    <Layout header={header} nav>
      <div className={styles.page} data-testid="game-page">
        {aiNotice && (
          <p className={styles.aiNotice} data-testid="ai-mode-notice" role="status">
            {aiNotice}
          </p>
        )}
        <button
          type="button"
          className={`${styles.mode} ${styles.league}`}
          data-testid="mode-league"
          onClick={() => {
            // 리그도 결국 매치를 만든다 — 리그 화면까지 들여보낸 뒤 [다음 경기]에서 막으면
            // 유저는 순위표를 한 바퀴 돈 뒤에야 자기가 못 한다는 걸 안다.
            if (deckless.guard()) navigate("/league");
          }}
        >
          <span className={styles.modeTop}>
            <span className={styles.modeIcon} aria-hidden="true">
              🏆
            </span>
            <b className={styles.modeTitle}>리그</b>
            <span className={styles.chev} aria-hidden="true">
              ›
            </span>
          </span>
          <p className={styles.modeDesc}>10팀 18라운드 정규 시즌. 순위로 승급·강등한다.</p>
          {/* 라운드 진행은 **서버가 준 값만** 쓴다 — 없으면 그 줄을 그리지 않는다(#262 BL-1). */}
          {hint.round && (
            <span className={styles.modeStat} data-testid="mode-league-round">
              {hint.round}
            </span>
          )}
          <span className={styles.modeHint} data-testid="mode-league-hint">
            {hint.label}
          </span>
        </button>

        <button
          type="button"
          className={`${styles.mode} ${styles.away}`}
          data-testid="mode-away"
          onClick={pressAway}
        >
          <span className={styles.modeTop}>
            <span className={styles.modeIcon} aria-hidden="true">
              ⚔️
            </span>
            <b className={styles.modeTitle}>원정</b>
            <span className={styles.chev} aria-hidden="true">
              ›
            </span>
          </span>
          <p className={styles.modeDesc}>
            다른 감독의 팀에 쳐들어간다. 승패로 레이팅이 오르내린다.
          </p>
          {me?.rating !== undefined && (
            <span className={styles.modeStat} data-testid="mode-away-rating">
              레이팅 {me.rating}
            </span>
          )}
        </button>

        {/* hero Q1 — 최하단 · 무채색 · 축소. */}
        <button
          type="button"
          className={`${styles.mode} ${styles.practice}`}
          data-testid="mode-practice"
          disabled={practice.isPending}
          onClick={() => practice.start()}
        >
          <span className={styles.modeTop}>
            <span className={`${styles.modeIcon} ${styles.practiceIcon}`} aria-hidden="true">
              🎯
            </span>
            <b className={styles.practiceTitle}>
              {practice.isPending ? "매치 생성 중…" : "연습 경기"}
            </b>
            <span className={styles.chev} aria-hidden="true">
              ›
            </span>
          </span>
          <p className={styles.practiceDesc}>봇과 단판 · 기록·보상 없음 · 전술 시험용</p>
        </button>

        <ErrorToast message={practice.error} onDismiss={practice.dismissError} />

        {deckless.dialog}

        {/* #504 D1-A — 제안은 이제 **도착한 이 화면**에서 뜬다(구: 홈 타일). 판정은 위 이펙트 하나. */}
        {practiceAsk && (
          <PracticeTutorialDialog
            onAccept={acceptPracticeTutorial}
            onDecline={declinePracticeTutorial}
          />
        )}

        {showAwayPopup && awayReports && (
          <AwayReportModal
            data={awayReports}
            onClose={() => {
              setAwayDismissed(true);
              setAwayPressed(false);
              navigate("/away"); // 원래 가려던 곳으로 이어준다 — 한 번 더 누르게 하지 않는다.
            }}
          />
        )}
      </div>
    </Layout>
  );
}
