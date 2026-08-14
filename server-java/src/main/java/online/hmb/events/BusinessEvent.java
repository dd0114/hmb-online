package online.hmb.events;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 비즈니스 이벤트 종류(#492 D1) — <b>코드가 열거의 SoT</b>다.
 *
 * <p>DB 에는 CHECK 를 걸지 않는다(V42 주석 참조): 종류를 늘리는 일이 마이그레이션을 요구하면
 * 계측을 추가하는 비용이 배포 비용이 되고, 그러면 계측이 늘지 않는다. 대신 <b>조회 API 의 필터</b>가
 * 이 목록으로 검증한다(알 수 없는 {@code event} → 400) — 오타 난 필터가 "결과 0건"으로 조용히
 * 거짓말하는 것을 막는다.
 *
 * <p><b>매치는 종류로 쪼개지 않는다</b>. 연습·리그·원정은 전부 {@link #MATCH_START} /
 * {@link #MATCH_FINISH} 이고 {@code props.mode} 가 가른다. 쪼개면 "원정 매치 1건"이 away 이벤트와
 * match 이벤트로 <b>두 번 세어져</b> 총량과 퍼널이 서로 다른 말을 한다.
 */
public final class BusinessEvent {

    /** 계정이 실제로 새로 만들어진 순간(재로그인·경합 패자는 아니다). props: provider, nickname */
    public static final String USER_SIGNUP = "user_signup";
    /** 온보딩 완료(= 덱 지급 시점). props: grantedDeck */
    public static final String TUTORIAL_COMPLETE = "tutorial_complete";
    /** 덱 저장 또는 프리셋 적용. props: source(deck|preset), formation, slotCount, created */
    public static final String DECK_SAVE = "deck_save";
    /** 뽑기. props: kind(single|ten), count, cost, currency, grades[] */
    public static final String GACHA_PULL = "gacha_pull";
    /** 매치 생성. props: mode(practice|league|away), matchId, botId, leagueFixtureId?, round?, defenderId?, revenge? */
    public static final String MATCH_START = "match_start";
    /** 매치 종료(정산 커밋 후). props: mode, matchId, result, goalsFor, goalsAgainst, pointsAwarded */
    public static final String MATCH_FINISH = "match_finish";
    /** 리그 시즌 시작(재진입은 제외 — 새 시즌이 실제로 생겼을 때만). props: seasonId, seasonNo, division */
    public static final String LEAGUE_SEASON_START = "league_season_start";

    // ── 온레일 튜토리얼(#504) — 클라가 보고하는 유일한 이벤트군 ──────────────────
    //
    // ⚠️ 위 7종과 성격이 다르다: 저것들은 **서버가 자기 동작 중에** 남긴 사실이고, 이 6종은
    // 클라이언트가 보고한 것이다(온레일은 브라우저 안에서만 도는 안내 계층이라 서버에 남는
    // 흔적이 `matches.is_tutorial` 하나뿐이었다 — #504 조사). 그래서 "제안을 못 받았다"와
    // "제안을 받고 거절했다"를 DB 로 가를 수 없었고, 그게 #493 이 실사용자에게 발화했는지를
    // 판정 불가로 만든 결손이다.
    //
    // 신뢰 경계: 클라가 보내는 값이므로 **집계 지표로만** 쓴다 — 보상·권한·게이트의 근거로
    // 쓰지 마라(#493 W9 가 `tutorial_complete` 클라 신고를 보상 근거에서 걷어낸 것과 같은 이유).

    /** 홈 [게임 시작]에서 온레일 제안 모달이 실제로 떴다. props: 없음 */
    public static final String ONRAIL_OFFER_SHOWN = "onrail_offer_shown";
    /**
     * <b>제안 자격이 있는데 제안 없이 게임 화면에 도착했다</b>(하단탭 [게임] 등 우회 경로).
     *
     * <p>이 이벤트가 #504 관측의 값어치 대부분이다 — 판정이 <b>평가조차 되지 않는</b> 동선의
     * 크기를 재고, 그 동선을 고치면 0 으로 떨어지는 것이 수정의 증거가 된다. props: path
     */
    public static final String ONRAIL_OFFER_MISSED = "onrail_offer_missed";
    /** 제안을 수락했다(온레일 시작). props: 없음 */
    public static final String ONRAIL_ACCEPTED = "onrail_accepted";
    /** 제안을 거절했다. props: 없음 — 이 한 줄이 "미노출"과 "거절"을 가른다. */
    public static final String ONRAIL_DECLINED = "onrail_declined";
    /** 온레일 스텝에 진입했다. props: stepId (어디서 이탈하나) */
    public static final String ONRAIL_STEP = "onrail_step";
    /** 온레일을 완주했다(S7). props: 없음 */
    public static final String ONRAIL_DONE = "onrail_done";

    /**
     * 클라이언트가 보고할 수 있는 이벤트 = <b>이 집합뿐</b>. 입구({@code POST /api/me/onrail-events})가
     * 이 목록으로 검증한다 — 열어 두면 클라가 {@code match_finish} 같은 <b>서버 사실</b>을 위조해
     * 퍼널을 오염시킬 수 있다. 새 클라 이벤트는 여기에 등록해야 통과한다.
     */
    public static final Set<String> CLIENT_REPORTABLE = Set.copyOf(new LinkedHashSet<>(java.util.List.of(
            ONRAIL_OFFER_SHOWN, ONRAIL_OFFER_MISSED, ONRAIL_ACCEPTED,
            ONRAIL_DECLINED, ONRAIL_STEP, ONRAIL_DONE)));

    /**
     * <b>유저당 1행이면 충분한 것</b>(= {@code recordOnce} 대상). 나머지({@link #ONRAIL_STEP})는
     * 반복이 의미를 갖는다 — 스텝마다 한 행씩 남아야 "어디까지 갔나"를 읽는다.
     *
     * <p>⚠️ {@code recordOnce} 를 반복이 의미 있는 이벤트에 쓰면 <b>기록이 사라진다</b>
     * ({@code BusinessEventRecorder#recordOnce} javadoc).
     */
    public static final Set<String> CLIENT_ONCE_PER_USER = Set.copyOf(new LinkedHashSet<>(java.util.List.of(
            ONRAIL_OFFER_SHOWN, ONRAIL_OFFER_MISSED, ONRAIL_ACCEPTED,
            ONRAIL_DECLINED, ONRAIL_DONE)));

    /** 매치 모드 — {@code props.mode} 값이자 퍼널의 practice/league/away 칸의 근거. */
    public static final String MODE_PRACTICE = "practice";
    public static final String MODE_LEAGUE = "league";
    public static final String MODE_AWAY = "away";

    /**
     * 알려진 종류(선언 순서 = 퍼널의 진행 순서). 조회 필터 검증에 쓴다.
     *
     * <p>⚠️ 온레일 6종도 여기 든다 — 안 들면 {@code GET /api/admin/events?event=onrail_step} 이
     * <b>400</b> 이라 기록해 놓고 읽을 수 없다. 반대로 {@link #CLIENT_REPORTABLE} 은 KNOWN 의
     * <b>진부분집합</b>이어야 한다(클라가 서버 사실을 위조하지 못하게).
     */
    public static final Set<String> KNOWN = Set.copyOf(new LinkedHashSet<>(java.util.List.of(
            USER_SIGNUP, TUTORIAL_COMPLETE, DECK_SAVE, GACHA_PULL,
            MATCH_START, MATCH_FINISH, LEAGUE_SEASON_START,
            ONRAIL_OFFER_SHOWN, ONRAIL_OFFER_MISSED, ONRAIL_ACCEPTED,
            ONRAIL_DECLINED, ONRAIL_STEP, ONRAIL_DONE)));

    private BusinessEvent() {
    }
}
