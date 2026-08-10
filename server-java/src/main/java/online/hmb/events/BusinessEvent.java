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

    /** 매치 모드 — {@code props.mode} 값이자 퍼널의 practice/league/away 칸의 근거. */
    public static final String MODE_PRACTICE = "practice";
    public static final String MODE_LEAGUE = "league";
    public static final String MODE_AWAY = "away";

    /** 알려진 종류(선언 순서 = 퍼널의 진행 순서). 조회 필터 검증에 쓴다. */
    public static final Set<String> KNOWN = Set.copyOf(new LinkedHashSet<>(java.util.List.of(
            USER_SIGNUP, TUTORIAL_COMPLETE, DECK_SAVE, GACHA_PULL,
            MATCH_START, MATCH_FINISH, LEAGUE_SEASON_START)));

    private BusinessEvent() {
    }
}
