import { useMemo, useState } from "react";
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

  const notices = useActiveNotices();
  const [noticeDone, setNoticeDone] = useState(false);
  const noticeList: Notice[] = useMemo(
    () => visibleNotices(notices.data, Date.now()),
    [notices.data],
  );

  const ownedCount = useMemo(() => (players ?? []).filter((p) => p.owned).length, [players]);
  const tiles = useMemo(
    () =>
      homeTileState({
        me,
        deck,
        ownedTotal: players?.length ?? 0,
        ownedCount,
        openTrades: openTradeCount(trade?.slots),
      }),
    [me, deck, players, ownedCount, trade],
  );

  const header = (
    <div className={styles.headerRow}>
      <div className={styles.headerLeft}>
        <span className={styles.nickname}>{me ? me.user.nickname : "감독님"}</span>
        <NoticeCenter notices={notices.data} />
      </div>
      <div className={styles.headerRight}>
        {me && <PointsBadge points={me.wallet.points} gems={me.wallet.gems ?? 0} />}
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

        {!locked && noticeList.length > 0 && !noticeDone && (
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
