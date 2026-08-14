import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAbandonMatch, useActiveMatch, useAwayReports, useDeck, useMe, usePlayers, type CatalogPlayer } from "../api/hooks";
import { useTradeSlots } from "../api/hooks-v2";
import { useActiveNotices } from "../api/notice-hooks";
import { useDailyMissions } from "../api/mission-hooks";
import { claimableSummary } from "../mission/mission-logic";
import { useToken } from "../auth/TokenContext";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { CharAvatar } from "../common/CharAvatar";
import { NoticeCenter } from "../lobby/NoticeCenter";
import { MailCenter } from "../mail/MailCenter";
import { NoticePopup } from "../lobby/NoticePopup";
import { visibleNotices, type Notice } from "../lobby/notice-logic";
import { pickLobbyPopup } from "../lobby/lobby-popup";
import { useUnbiddenPopupHold } from "../lobby/tutorial-hold";
import { useTutorial } from "../common/tutorial-context";
import { useGuide } from "../common/guide-context";
import { DecklessDialog } from "../common/DecklessDialog";
import { deckMissing } from "../common/deckless";
import { shouldOfferPracticeTutorial } from "../common/guide-storage";
import { practiceOfferDecision } from "../onrail/practice-offer";
import { resumeLabelFor, shouldOfferResume, type ActiveMatchInfo } from "../common/match-lock";
import { HOME_TILES, homeNotice, homeTileState, openTradeCount, teamLine } from "./home-logic";
import styles from "./HomePage.module.css";

/**
 * 홈 (#286 W2) — **하단탭을 크게 펼친 런처**.
 *
 * hero 가 6차 반복으로 확정한 형태다. 되돌리려는 사람을 위해 이유를 남긴다:
 *
 *  1. **홈은 내비 그 자체**라 `Layout` 의 `nav` 를 끈다(hero 4R: "홈화면때는 하단탭 안보이고").
 *     홈이 내비인데 그 밑에 또 내비를 그릴 이유가 없다. 그 짝으로 **다른 화면의 탭바에는
 *     `[홈]` 칸이 반드시 남아야 한다**(AppNav) — 한쪽만 바꾸면 홈으로 돌아올 길이 사라진다.
 *  2. **타일은 전부 통칸**(hero 5R: "반칸 나누지 말라"). 이름·순서도 hero 지정이라
 *     `home-logic.ts` 의 `HOME_TILES` 하나가 SoT 다(계약이 순서까지 본다).
 *  3. **카운트 뱃지는 한 형식**(hero 6R). 무엇을 센 숫자인지는 뱃지가 아니라 **부제**가 말한다 —
 *     리본(라벨+숫자)과 원형(숫자)이 섞이면 같은 뜻이 다르게 읽힌다.
 *  4. **경기 중에는 타일이 전부 잠기고** 잠금 카드만 남는다(hero 2R). 현행 `MatchLockGate` 는
 *     *누른 뒤에 되돌리는* 방식이라 그 사이에 강화·덱 편집이 들어갈 창이 있었다 — 여기선
 *     애초에 `disabled` 다.
 *
 * ⚠️ **로그아웃이 여기 있는 이유**: 홈은 유일하게 잠기지 않는 화면이라(`LOCKED_ROUTES` 주석)
 * 불량 세션의 탈출구가 될 수 있는 자리가 여기뿐이다(#73 P1 "로그아웃은 항상 노출").
 */
export function HomePage() {
  const navigate = useNavigate();
  const { data: me, isError } = useMe();
  const { data: deck } = useDeck();
  const { data: players } = usePlayers();
  const { data: active, isLoading: activeLoading } = useActiveMatch();
  const { logout } = useToken();

  /**
   * **두 값을 구분한다** — 여기서 한 번 틀렸다.
   *  · `unfinished` = 끝나지 않은 매치가 있다 → **잠금 카드**를 띄운다. 브리핑(locked=false,
   *    abandonable=true)도 여기 들어온다 — 이어하기 진입점이 없으면 그 매치는 미아가 된다.
   *  · `locked`     = 서버가 잠갔다 → **타일을 비활성**한다. 브리핑은 킥오프 전이라 잠그지
   *    않는다(#217 이 의도적으로 자유를 준 구간이고, 덱을 고치러 갈 수 있어야 한다).
   * 재생 중(locked && !abandonable)은 애초에 `MatchLockGate` 가 매치로 되돌려 여기 못 온다.
   */
  const unfinished = shouldOfferResume(active);
  const locked = Boolean(active?.locked);
  // ⚠️ 훅이 인자를 받지 않는다 — 경기 중에도 조회는 나가지만 그 화면에선 타일이 잠겨 있어
  // 결과를 쓰지 않는다. 조회를 끊고 싶으면 훅에 enabled 를 여는 게 맞고, 그건 이 에픽 밖이다.
  const { data: trade } = useTradeSlots();

  // ── 공지 팝업 (#248 → #286 로 이관) ──────────────────────────────────────
  // ⚠️ **온보딩 우선 규칙을 반드시 같이 옮겨야 한다.** 처음 이관할 때 이걸 빠뜨렸고, 그 결과
  // 게임을 처음 켠 사람이 무엇을 하라는 안내를 받기 전에 "새벽 점검 안내"부터 읽게 됐다
  // (코치마크는 다른 다이얼로그가 열리면 스스로 숨으므로 **조용히 사라져 있었다**).
  // p248b 계약이 그걸 잡았다.
  // 미확인 피원정 건수 — 알림 줄의 절반. **모르는 동안(로딩)도 묻지 않는다** — GamePage 와 같은
  // 표현이어야 한다(#245 규칙이 화면마다 다르면 다음 사람이 어느 쪽을 따를지 모른다).
  const { data: awayReports } = useAwayReports("unseen", !activeLoading && !locked);
  /**
   * 받을 수 있는 미션 보상 (#408). `/api/me` 에 요약이 없어 이 한 줄을 위해 조회가 하나 는다 —
   * `retry:false` + 30초 stale 이고, 구 서버(404)면 조용히 0 이다. (`me.mail` 처럼 요약 필드가
   * 생기면 그쪽으로 옮기는 게 맞다 — 우편함이 그렇게 정리됐다.)
   */
  const { data: missions } = useDailyMissions(!activeLoading && !locked);
  const notice = homeNotice({
    unseenAwayReports: typeof awayReports?.unseen === "number" ? awayReports.unseen : 0,
    openTrades: openTradeCount(trade?.slots),
    claimableMissions: claimableSummary(missions).count,
  });

  const notices = useActiveNotices();
  const [noticeDone, setNoticeDone] = useState(false);
  const { active: tutorialActive } = useTutorial();
  const { active: guideActive } = useGuide();
  const candidates: Notice[] = useMemo(
    () => visibleNotices(notices.data, Date.now()),
    [notices.data],
  );

  /**
   * **지금 온보딩이 화면을 잡고 있는가** — 코치마크가 도는 동안 + 그 직후 정착 시간만(#386).
   *
   * ⚠️ 예전 구조는 *이번 방문 동안 한 번이라도 튜토리얼이 돌았으면 계속 참*인 래치였고, 공지를
   * "다음 홈 진입"으로 미뤘다(#248b). 그 미룸이 **온보딩이 완료 저장되지 않는 경로**와 겹쳐
   * "다음 진입"이 영영 오지 않았다 — 신규 유저가 공지를 한 번도 못 보는 실제 원인이었다.
   * 판정 규칙과 근거는 `lobby/tutorial-hold.ts`.
   */
  // #493 W2: 화면별 가이드(GuideProvider)도 같은 홀드 축에 태운다 — 오늘 홈에는 가이드가
  // 없지만(guide-steps 계약), 생기는 날 공지·원정 팝업과 겹치는 사고를 여기서 미리 막는다.
  const tutorialHold = useUnbiddenPopupHold(tutorialActive || guideActive);

  // 첫 진입에 보인 목록을 **고정**한다. 포커스 복귀 refetch 로 목록이 갈리면 스택 인덱스가
  // 어긋나 유저가 이미 닫은 장이 다시 앞으로 나온다. 온보딩이 잡은 방문에서는 고정도 하지
  // 않는다 — 어차피 열지 않을 목록을 붙들면 그 사이 헤더 [공지]로 읽은 것까지 나중에 다시 민다.
  const latched = useRef<Notice[] | null>(null);
  if (latched.current === null && !tutorialHold && candidates.length > 0) {
    latched.current = candidates;
  }
  const noticeList = latched.current ?? [];

  /**
   * 홈 팝업 판정은 `pickLobbyPopup` 한 곳(#248 §4).
   *
   * ⚠️ 지금 홈에 뜨는 팝업은 공지 하나뿐이다(원정 리포트는 #286 에서 **게임 탭**으로 갔다).
   * 그래도 이 함수를 계속 쓰는 이유는 **"온보딩 중에는 저절로 뜨는 팝업을 미룬다"** 는 규칙이
   * 여기 살아 있고 테스트도 여기 붙어 있기 때문이다 — 조건을 화면에 풀어 쓰면 그 규칙이
   * 사라진다. 팝업이 다시 둘 이상 모이면 `away` 를 채우기만 하면 된다.
   */
  const popup = pickLobbyPopup(
    { notice: !noticeDone && noticeList.length > 0 },
    { tutorialHold },
  );

  /**
   * ⚠️ **응답 형태를 믿지 않는다.** `(players ?? [])` 는 부족하다 — 구 서버·빈 응답이 200 `{}` 를
   * 주면 `{}` 는 nullish 가 아니라서 그대로 통과하고 `.filter` 가 던진다. 그러면 **홈 전체가
   * 흰 화면**이다(실측: `TypeError: (players ?? []).filter is not a function`).
   * #245 가 로비에서 같은 방식으로 당했고("부가 기능이 앱 진입점을 죽이면 안 된다"), 홈은 이제
   * 그 진입점이라 더 세게 지킨다. 계약 = `e2e/p248-notice-popup`(전 엔드포인트 캐치올 `{}`).
   */
  const roster = Array.isArray(players) ? players : [];
  const ownedCount = useMemo(() => roster.filter((p) => p.owned).length, [players]);
  const tiles = useMemo(
    () =>
      homeTileState({
        me,
        deck,
        ownedTotal: roster.length,
        ownedCount,
        openTrades: openTradeCount(trade?.slots),
      }),
    [me, deck, players, ownedCount, trade],
  );

  /**
   * 덱 없는 유저 가드 — L1 (#286 W3.5, hero 발제).
   *
   * 여기서 막으면 `/game` 에 **진입조차 하지 않으므로** #245 원정 팝업과 순서를 다투지 않는다.
   * 다만 이건 첫 겹일 뿐이다 — URL 직접 진입은 `GamePage` 가, 경합은 서버 응답이 받는다.
   */
  const [decklessOpen, setDecklessOpen] = useState(false);

  /**
   * ⚠️ **연습경기 튜토리얼 제안은 더 이상 여기 없다** (#504 D1-A, hero 결정 2026-08-15).
   *
   * W5 는 이 타일 클릭을 판정 지점으로 삼았다(*"게임시작 눌렀을때 '연습경기로 튜토리얼을
   * 해보시겠습니까?' 하고"*). 그런데 게임 화면으로 가는 길은 이 타일 하나가 아니다 — 하단탭
   * [게임]·덱 화면의 `navigate("/game")`·URL 직접·뒤로가기는 이 코드를 **지나가지도 않아**
   * 신규 유저가 온레일의 존재를 모른 채 통과했다(실유저 2명 / 발화 0명).
   *
   * 그래서 판정은 **도착 지점**(`GamePage`) 하나로 옮겼다. 이 타일은 이제 이동만 한다 —
   * 여기에 판정을 남겨 두면 같은 결정이 두 벌이 되고, 그게 이번 결함의 형태 그 자체다.
   */
  /**
   * 게임 타일 = **이동뿐**이다. 남는 것은 덱없음 안내(L1) 한 겹인데, 그것도 D3 스위치를 탄다.
   *
   * ⚠️ `practiceOfferDecision` 을 **여기서도 부르는 이유**: D3 를 ①제안 먼저로 뒤집으면 덱이 없는
   * 자격자는 이 가드에 막히는 대신 게임 화면까지 가서 제안을 받아야 한다(온레일 1스텝이 덱 화면이라
   * 그쪽이 정합이다). 순서를 두 화면의 if 순서로 표현하면 스위치가 한 줄이 아니게 된다 —
   * 기본값(`false`)에서는 이 항이 언제나 거짓이라 **동작은 종전과 같다**.
   */
  function pressTile(key: string, to: string) {
    if (key === "game" && deckMissing(deck)) {
      const decision = practiceOfferDecision({
        eligible: shouldOfferPracticeTutorial(me?.user?.id ?? null),
        deckMissing: true,
      });
      if (decision !== "offer") {
        setDecklessOpen(true);
        return;
      }
    }
    navigate(to);
  }

  const header = (
    <div className={styles.headerRow}>
      <div className={styles.headerLeft}>
        {/* ⚠️ **닉네임은 여기 없다**(#323, hero 확정). 390px 헤더는 지갑 2칩(204px) + [로그아웃](62px)이
            줄지 않는 오른쪽이라 왼쪽 몫이 90px 뿐인데, 공지 + 우편 진입점만으로 68px 를 쓴다 —
            닉네임을 두면 22px 로 눌리거나(“김”) 오른쪽 위로 **겹쳐 그려진다**(실측 캡처
            .smoke/p323-opt0-now.png). 정보는 사라지지 않는다: 바로 아래 팀 카드가 “{닉네임}의 팀”
            이고 [내 정보] 탭에도 그대로 있다. 되살리려면 오른쪽에서 무언가를 먼저 빼라. */}
        <NoticeCenter notices={notices.data} />
        {/* 우편함(#323, hero 확정 = 홈 헤더). **공지 옆·닉네임 쪽**인 이유는 취향이 아니라 실측이다 —
            오른쪽(지갑 옆)에 얹으면 390px 헤더가 한 줄 더 접힌다(#248 실측 69→113px). 첨부는
            만료되는 자산이라 발견성이 곧 손해와 직결돼 홈에 두고, 뱃지는 **숫자**다(할 일 개수). */}
        <MailCenter />
      </div>
      <div className={styles.headerRight}>
        {/* ⚠️ `me &&` 로는 부족하다 — 구 서버·빈 응답의 200 `{}` 는 truthy 라서 통과하고
            `me.wallet.points` 가 던진다(실측). 지갑은 **숫자가 실제로 있을 때만** 그린다. */}
        {typeof me?.wallet?.points === "number" && (
          <PointsBadge points={me.wallet.points} gems={me.wallet.gems ?? 0} />
        )}
        {/* me 조회가 실패해도 이 버튼은 남는다 — 불량 세션 탈출구(#73 P1). */}
        <button type="button" className={styles.logout} onClick={logout}>
          로그아웃
        </button>
      </div>
    </div>
  );

  return (
    <Layout header={header}>
      <div className={styles.page} data-testid="home-page">
        {isError && <ErrorToast message="내 정보를 불러오지 못했습니다" />}

        {unfinished && active?.match ? (
          <LockCard active={active as ActiveMatchInfo} />
        ) : (
          <TeamRow me={me} deck={deck} roster={roster} />
        )}

        <div className={styles.tiles} data-testid="home-tiles">
          {HOME_TILES.map((t) => {
            const state = tiles[t.key];
            return (
              <button
                key={t.key}
                type="button"
                className={t.primary ? `${styles.tile} ${styles.tilePrimary}` : styles.tile}
                data-testid={`home-tile-${t.key}`}
                disabled={locked}
                onClick={() => pressTile(t.key, t.to)}
              >
                <span className={styles.tileIcon} aria-hidden="true">
                  {t.icon}
                </span>
                <span className={styles.tileText}>
                  <b className={styles.tileLabel}>{t.label}</b>
                  <span className={styles.tileSub}>{state.sub}</span>
                </span>
                {/* 뱃지는 셀 게 있을 때만. 형식은 전 타일 공통(hero 6R). */}
                {state.count > 0 && (
                  <span className={styles.count} data-testid={`home-count-${t.key}`}>
                    {state.count}
                  </span>
                )}
                <span className={styles.chev} aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>

        {/* 알림 한 줄 — **있을 때만**. 없으면 홈은 카드 한 장 + 타일로 끝난다(hero 3R). */}
        {!locked && notice && (
          <button
            type="button"
            className={styles.notifRow}
            data-testid="home-notif"
            onClick={() => navigate(notice.to)}
          >
            <span className={styles.notifCount}>{notice.count}</span>
            <span className={styles.notifText}>{notice.text}</span>
            <span className={styles.chev} aria-hidden="true">
              ›
            </span>
          </button>
        )}

        {popup === "notice" && (
          <NoticePopup notices={noticeList} onDone={() => setNoticeDone(true)} />
        )}

        {/* ⚠️ 카탈로그가 아직 없으면 **0 이 아니라 `null`** 을 넘긴다 — 0 을 넘기면 로딩 중인
            유저에게 "현재 0/11명입니다"라는 **틀린 숫자**가 뜬다(`roster` 는 미도착도 `[]`). */}
        {decklessOpen && (
          <DecklessDialog
            ownedCount={Array.isArray(players) ? ownedCount : null}
            onClose={() => setDecklessOpen(false)}
          />
        )}

        {/* ⚠️ 연습경기 튜토리얼 제안은 **`GamePage` 로 옮겼다**(#504 D1-A) — 이 화면에는 없다. */}
      </div>
    </Layout>
  );
}

/** 팀 한 줄 — "내 팀이 어떤 팀인지"만. 상세는 전부 자기 탭에 있다. */
function TeamRow({
  me,
  deck,
  roster,
}: {
  me: ReturnType<typeof useMe>["data"];
  deck: ReturnType<typeof useDeck>["data"];
  roster: CatalogPlayer[];
}) {
  const line = teamLine(me, deck, roster);
  return (
    <section className={styles.teamRow} data-testid="home-team-row">
      <div className={styles.teamArt}>
        {/* 밀집 UI 라 얼굴 타일이다(apps/web/CLAUDE.md 카드 아트 표) — 풀아트는 도감·강화 상세에서. */}
        {/* 주장 슬롯이 비면(덱 미구성) 아바타를 그리지 않는다 — 빈 id 로 부르면 폴백 이니셜이
            엉뚱한 이름으로 뜬다. */}
        {/* 등급을 모르면(카탈로그 미도착) 아트를 그리지 않는다 — #285 정책이 등급으로 판정한다. */}
        {line.captainId && line.captainGrade ? (
          <CharAvatar
            playerId={line.captainId}
            name={line.teamName}
            grade={line.captainGrade}
            size={40}
          />
        ) : (
          <span className={styles.teamArtEmpty} aria-hidden="true">⚽</span>
        )}
      </div>
      <div className={styles.teamInfo}>
        <b className={styles.teamName}>{line.teamName}</b>
        <span className={styles.teamSub}>{line.sub}</span>
      </div>
      {line.rating !== null && (
        <span className={styles.ratingBadge} data-testid="home-rating">
          레이팅 {line.rating}
        </span>
      )}
    </section>
  );
}

/**
 * 경기 진행 중 — 홈이 통째로 이 카드가 된다(hero 2R).
 *
 * [경기 포기]는 서버가 `abandonable` 을 준 경우에만 뜬다. 회수 가능한 사고 매치(생성 실패·시계
 * 멈춤)에게 이건 편의가 아니라 **유일한 탈출구**다(#217 AC3).
 */
function LockCard({ active }: { active: ActiveMatchInfo }) {
  const navigate = useNavigate();
  const matchId = active.match!.id;
  const abandon = useAbandonMatch(matchId);
  const [abandonError, setAbandonError] = useState<string | null>(null);

  return (
    <section className={styles.lockCard} data-testid="home-lock-card">
      <div className={styles.lockHead}>
        <span className={styles.lockIcon} aria-hidden="true">
          ⏸
        </span>
        <div>
          <b className={styles.lockTitle}>경기 진행 중</b>
          <div className={styles.lockNote} data-testid="home-lock-note">
            {resumeLabelFor(active.match!.state)}
          </div>
        </div>
      </div>
      <div className={styles.lockActions}>
        <button
          type="button"
          className={styles.lockPrimary}
          data-testid="home-resume"
          onClick={() => navigate(`/match/${matchId}`)}
        >
          이어하기
        </button>
        <button
          type="button"
          className={styles.lockSecondary}
          data-testid="home-abandon"
          disabled={!active.abandonable || abandon.isPending}
          onClick={() =>
            abandon.mutate(undefined, {
              onError: (err) =>
                setAbandonError(err instanceof Error ? err.message : "포기하지 못했습니다"),
            })
          }
        >
          {abandon.isPending ? "포기하는 중…" : "경기 포기"}
        </button>
      </div>
      <p className={styles.lockHint}>경기를 끝내거나 포기해야 다른 메뉴를 쓸 수 있습니다.</p>
      <ErrorToast message={abandonError} onDismiss={() => setAbandonError(null)} />
    </section>
  );
}
