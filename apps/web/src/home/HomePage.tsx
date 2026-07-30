import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAbandonMatch, useActiveMatch, useDeck, useMe, usePlayers } from "../api/hooks";
import { useTradeSlots } from "../api/hooks-v2";
import { useActiveNotices } from "../api/notice-hooks";
import { useToken } from "../auth/TokenContext";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { CharAvatar } from "../common/CharAvatar";
import { NoticeCenter } from "../lobby/NoticeCenter";
import { NoticePopup } from "../lobby/NoticePopup";
import { visibleNotices, type Notice } from "../lobby/notice-logic";
import { pickLobbyPopup } from "../lobby/lobby-popup";
import { useTutorial } from "../common/tutorial-context";
import { resumeLabelFor, shouldOfferResume, type ActiveMatchInfo } from "../common/match-lock";
import { HOME_TILES, homeTileState, openTradeCount, teamLine } from "./home-logic";
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
  const { data: active } = useActiveMatch();
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
  const notices = useActiveNotices();
  const [noticeDone, setNoticeDone] = useState(false);
  const { active: tutorialActive } = useTutorial();
  const candidates: Notice[] = useMemo(
    () => visibleNotices(notices.data, Date.now()),
    [notices.data],
  );

  /**
   * **이번 방문 동안 온보딩이 화면을 잡았는가** — 한 번 참이면 이 방문 내내 참(래치).
   *
   * `tutorialActive` 만으로 부족한 이유: 튜토리얼이 **끝나는 그 순간**에 공지를 띄우면 완료
   * 저장(`persistTutorialDone`)이 `["deck"]`·`["me"]` 를 무효화해 화면이 바뀌는 바로 그 프레임에
   * 점검 공지가 덮는다. → 공지는 **다음에 홈에 들어올 때** 뜬다.
   * 서버 플래그로 판정하지 않는 이유: 그건 계정에 남는 값이라 리로드 뒤에도 "방금 끝났다"로
   * 읽혀 공지가 영영 미뤄질 수 있다. 이 래치는 **컴포넌트 수명**에만 산다 = 정확히 "다음 진입".
   */
  const tutorialHeldThisVisit = useRef(false);
  if (tutorialActive) tutorialHeldThisVisit.current = true;
  const tutorialHold = tutorialActive || tutorialHeldThisVisit.current;

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

  const header = (
    <div className={styles.headerRow}>
      <div className={styles.headerLeft}>
        <span className={styles.nickname}>{me?.user?.nickname ?? "감독님"}</span>
        <NoticeCenter notices={notices.data} />
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
          <TeamRow me={me} deck={deck} />
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
                onClick={() => navigate(t.to)}
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

        {popup === "notice" && (
          <NoticePopup notices={noticeList} onDone={() => setNoticeDone(true)} />
        )}
      </div>
    </Layout>
  );
}

/** 팀 한 줄 — "내 팀이 어떤 팀인지"만. 상세는 전부 자기 탭에 있다. */
function TeamRow({
  me,
  deck,
}: {
  me: ReturnType<typeof useMe>["data"];
  deck: ReturnType<typeof useDeck>["data"];
}) {
  const line = teamLine(me, deck);
  return (
    <section className={styles.teamRow} data-testid="home-team-row">
      <div className={styles.teamArt}>
        {/* 밀집 UI 라 얼굴 타일이다(apps/web/CLAUDE.md 카드 아트 표) — 풀아트는 도감·강화 상세에서. */}
        {/* 주장 슬롯이 비면(덱 미구성) 아바타를 그리지 않는다 — 빈 id 로 부르면 폴백 이니셜이
            엉뚱한 이름으로 뜬다. */}
        {line.captainId ? (
          <CharAvatar playerId={line.captainId} name={line.teamName} size={40} />
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
