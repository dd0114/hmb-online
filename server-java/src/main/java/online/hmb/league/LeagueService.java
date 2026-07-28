package online.hmb.league;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.SplittableRandom;
import online.hmb.catalog.EconomyService;
import online.hmb.catalog.LeagueDataService;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.match.MatchLockService;
import online.hmb.match.MatchService;
import online.hmb.meta.DeckService;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 리그 모드 (AC-F1~F5, LLD-p2-server §6). 규칙 고증 = {@code docs/plan-v3/league-rules.md}.
 *
 * <p><b>구성</b>(시드 결정론 — {@code league_seasons.seed} 저장, 재계산 일치): 유저 팀({@link #USER_TEAM_ID})
 * + 봇 9팀 = 10팀. 봇팀은 {@code league.v1.json} 클럽명·페르소나 풀 + 실선수 풀에서 등급-층화 라운드로빈
 * 샘플링으로 로스터 15명(선발 11 + 벤치 4, GK≥1)을 구성한다. 팀당 중복 없음, 팀 간 공유 허용
 * (유저 보유와도 중복 허용 — AC-F1).
 *
 * <p><b>일정</b>: 서클 메서드 더블 라운드로빈 18R. 각 팀 라운드당 1경기, 각 순서쌍(home,away)이 정확히
 * 1회 등장(홈/어웨이 대칭). 유저 경기 18 + 봇전 72 = 90 픽스처. 유저 픽스처만 풀 매치 플로우로 진행,
 * 봇전은 유저가 그 라운드 경기를 마칠 때 간이결과로 일괄 정산.
 *
 * <p><b>순위</b>: 승점 3-1-0 → 골득실 → 다득점 → 승자승(head-to-head). {@code league_fixtures} PLAYED
 * 파생 — 저장 순위표 없음(항상 재계산).
 */
@Service
public class LeagueService {

    private static final Logger log = LoggerFactory.getLogger(LeagueService.class);

    /** 유저 팀 teamId(고정). 픽스처 home/away 가 이 값이면 유저 경기(is_user=1). */
    public static final String USER_TEAM_ID = "USER";
    private static final int WIN_POINTS = 3;
    private static final int DRAW_POINTS = 1;
    /** 등급 서열(등급-층화 샘플 순회 기준). */
    private static final List<String> GRADE_ORDER = List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND");
    /** gem_ledger 사유 — 리그 입상 젬 보상(#212). ref=seasonId 로 멱등. */
    public static final String LEDGER_REASON_LEAGUE_GEM = "league_gem_reward";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final LeagueDataService leagueDataService;
    private final MatchService matchService;
    private final MatchLockService lockService;
    private final DeckService deckService;
    private final WalletService walletService;
    private final LeagueSeedSource seedSource;
    private final EconomyService economyService;

    private final int botTeamCount;
    private final int rosterSize;
    private final int promoteRankMax;
    private final int relegateRankMin;
    private final double simBaseGoals;
    private final double simPowerDivisor;
    private final double simHomeAdvantage;
    private final int simMaxGoals;

    public LeagueService(JdbcClient jdbcClient,
                         TxRunner txRunner,
                         ObjectMapper objectMapper,
                         LeagueDataService leagueDataService,
                         MatchService matchService,
                         MatchLockService lockService,
                         DeckService deckService,
                         WalletService walletService,
                         LeagueSeedSource seedSource,
                         EconomyService economyService,
                         @Value("${hmb.league.bot-team-count}") int botTeamCount,
                         @Value("${hmb.league.roster-size}") int rosterSize,
                         @Value("${hmb.league.sim.base-goals}") double simBaseGoals,
                         @Value("${hmb.league.sim.power-divisor}") double simPowerDivisor,
                         @Value("${hmb.league.sim.home-advantage}") double simHomeAdvantage,
                         @Value("${hmb.league.sim.max-goals}") int simMaxGoals,
                         @Value("${hmb.league.division.promote-rank-max}") int promoteRankMax,
                         @Value("${hmb.league.division.relegate-rank-min}") int relegateRankMin) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.leagueDataService = leagueDataService;
        this.matchService = matchService;
        this.lockService = lockService;
        this.deckService = deckService;
        this.walletService = walletService;
        this.seedSource = seedSource;
        this.economyService = economyService;
        this.botTeamCount = botTeamCount;
        this.rosterSize = rosterSize;
        this.simBaseGoals = simBaseGoals;
        this.simPowerDivisor = simPowerDivisor;
        this.simHomeAdvantage = simHomeAdvantage;
        this.simMaxGoals = simMaxGoals;
        this.promoteRankMax = promoteRankMax;
        this.relegateRankMin = relegateRankMin;
    }

    // ── 행 모델 ──────────────────────────────────────────────────────────

    public record SeasonRow(String id, String userId, int seasonNo, String state, String seed,
                            String teamsJson, String createdAt, String finishedAt, int division) {
    }

    public record FixtureRow(String id, String seasonId, int round, String homeTeam, String awayTeam,
                             boolean isUser, String state, Integer scoreHome, Integer scoreAway,
                             String matchId) {
    }

    // ── DTO (openapi-v2) ─────────────────────────────────────────────────

    public record LeagueTeam(String teamId, String name, String persona, Integer power, boolean isUser) {
    }

    public record LeagueStanding(String teamId, String name, int played, int won, int drawn, int lost,
                                 int goalsFor, int goalsAgainst, int goalDiff, int points, int rank,
                                 boolean isUser) {
    }

    public record LeagueFixture(String id, int round, String homeTeam, String awayTeam, boolean isUser,
                                String state, Integer scoreHome, Integer scoreAway, String matchId) {
    }

    /**
     * @param division      이 시즌의 디비전 level(#252, 작을수록 상위). 시즌 생성 시 박제된 값이다.
     * @param divisionName  표시명(league.v2.json). 서버가 SoT — 클라가 level→이름을 복제하면 표가
     *                      바뀔 때 조용히 어긋난다.
     * @param promoteRankMax 이 순위 이내면 승급 / @param relegateRankMin 이 순위 이상이면 강등.
     *                      규칙을 내려주는 이유도 같다(클라가 컷을 하드코딩하지 않게).
     */
    public record LeagueSeason(String id, int seasonNo, String state, List<LeagueTeam> teams,
                               List<LeagueStanding> standings, List<LeagueFixture> fixtures,
                               LeagueFixture nextUserFixture, SeasonReward seasonReward,
                               int division, String divisionName,
                               int promoteRankMax, int relegateRankMin) {
    }

    /**
     * 시즌 보상 요약(additive, web 시즌종료 연출용 — P3-D8/AC-E1). <b>SoT = 기존 데이터에서 파생</b>:
     * 지급 사실·금액·시각은 {@code point_ledger}(reason='league_reward', ref=seasonId)에서,
     * {@code rank} 은 {@link #computeStandings} 유저 순위에서. 별도 상태 컬럼을 두지 않는다(원장과 드리프트 방지).
     *
     * <ul>
     *   <li>{@code status=PENDING}: 시즌 ACTIVE(미종료) — 아직 미지급. 이때 {@code rank} 은 <b>현재 잠정 순위</b>,
     *       {@code points=0}(예정 보상액이 아님 — 채우면 web 이 "이미 받았다"로 오인하므로 0으로 고정),
     *       {@code awardedAt=null}.</li>
     *   <li>{@code status=GRANTED}: FINISHED + 원장에 지급 행 존재. {@code points} = <b>원장 delta(실지급액)</b>,
     *       {@code awardedAt} = 원장 created_at, {@code rank} = 최종 순위.</li>
     *   <li>{@code status=NONE}: FINISHED 인데 원장 없음(방어 케이스 — userRank 미확인 또는 보상액 0).
     *       {@code points=0}, {@code awardedAt=null}.</li>
     * </ul>
     */
    /**
     * gems(#251) = 시즌 종료 젬 보상 실지급액(gem_ledger delta 파생 — 계산이 아니라 <b>원장</b>이 SoT).
     * 완주 기본 + 순위 보너스 가산이라 <b>완주한 전 순위가 &gt; 0</b> 이다(#212 의 "1등만"에서 개정).
     * 미종료/미지급이면 0. web 종료 화면이 G 와 <b>병기</b>하는 입력값.
     */
    public record SeasonReward(int rank, int points, int gems, String status, String awardedAt) {
    }

    public record LeagueResponse(LeagueSeason season) {
    }

    public record LeagueNextMatchResponse(MatchService.MatchDetail match, LeagueFixture fixture) {
    }

    // ── POST /api/league/start (AC-F1) ──────────────────────────────────

    /** ACTIVE 시즌 있으면 그대로 반환(멱등), 없으면 시드로 새 시즌 생성(season_no+1). */
    public LeagueResponse startSeason(String userId) {
        return txRunner.run(() -> {
            Optional<SeasonRow> active = activeSeason(userId);
            if (active.isPresent()) {
                return new LeagueResponse(buildSeasonDto(active.get()));
            }
            LeagueDataService.LeagueData data = leagueDataService.get().orElseThrow(() ->
                    leagueInvalid("리그 데이터(league.v1.json)가 로딩되지 않아 시즌을 시작할 수 없습니다"));
            int nextNo = jdbcClient.sql("SELECT COALESCE(MAX(season_no), 0) FROM league_seasons WHERE user_id = ?")
                    .param(userId).query(Integer.class).single() + 1;
            String seasonId = Ulid.next();
            String seed = seedSource.newSeed();
            String now = Instant.now().toString();

            // #252: 시즌 난이도는 **시작 시점의 유저 디비전**으로 확정하고 시즌에 박제한다.
            // 시즌 도중 승급/강등이 반영되면 이미 치른 라운드와 남은 라운드의 상대 강도가 달라져
            // 순위표가 뜻을 잃는다.
            int division = divisionOf(userId);
            List<TeamBuild> teams = buildTeams(userId, seasonId, seed, data, division);
            insertBotRows(teams, divisionSpec(data, division));
            String teamsJson = teamsJson(teams);
            jdbcClient.sql("""
                            INSERT INTO league_seasons(id, user_id, season_no, state, seed, teams_json,
                                                       created_at, division)
                            VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
                            """)
                    .params(seasonId, userId, nextNo, seed, teamsJson, now, division)
                    .update();
            insertFixtures(seasonId, teams);

            SeasonRow row = seasonById(seasonId).orElseThrow();
            return new LeagueResponse(buildSeasonDto(row));
        });
    }

    // ── GET /api/league (AC-F3) ─────────────────────────────────────────

    /** 최신 시즌(ACTIVE 우선, 없으면 최근 FINISHED) 상태·순위·일정·다음 유저 경기. 없으면 season=null. */
    public LeagueResponse getLeague(String userId) {
        return latestSeason(userId)
                .map(s -> new LeagueResponse(buildSeasonDto(s)))
                .orElse(new LeagueResponse(null));
    }

    // ── POST /api/league/next-match (AC-F2) ─────────────────────────────

    /**
     * 다음 SCHEDULED 유저 픽스처로 매치 생성(mode=league, 홈/어웨이 반영). 이미 생성돼 진행 중인
     * 유저 매치가 있으면 그걸 반환(중복 생성 방지). 이후 기존 매치 플로우 그대로.
     */
    public LeagueNextMatchResponse nextMatch(String userId) {
        return txRunner.run(() -> {
            SeasonRow season = activeSeason(userId)
                    .orElseThrow(() -> leagueInvalid("진행 중인 ACTIVE 시즌이 없습니다"));
            FixtureRow fixture = nextUserFixtureRow(season.id())
                    .orElseThrow(() -> leagueInvalid("남은 유저 경기가 없습니다(시즌 종료)"));

            // 이미 진행 중인 매치가 연결돼 있으면 재사용.
            // ⚠️ 판정은 "FINISHED 가 아님"이 아니라 **ACTIVE 집합**이다(#217): 포기(ABANDONED)한 매치도
            // FINISHED 가 아니므로, 예전 조건이면 죽은 매치를 영원히 되돌려줘 픽스처가 잠긴다.
            if (fixture.matchId() != null) {
                Optional<MatchService.MatchRow> existing = matchService.find(fixture.matchId());
                if (existing.isPresent() && MatchService.ACTIVE_STATES.contains(existing.get().state())) {
                    return new LeagueNextMatchResponse(matchService.toDetail(existing.get()), toDto(fixture));
                }
            }

            // 여기부터는 **새 매치를 만드는** 경로다 — 다른 매치(연습 포함)가 진행 중이면 막는다(AC2).
            // 위의 재사용 분기보다 뒤에 있어야 한다: 이 픽스처의 매치로 돌아가는 건 재입장이지 생성이 아니다.
            lockService.assertCanCreateMatch(userId);

            String botTeamId = USER_TEAM_ID.equals(fixture.homeTeam()) ? fixture.awayTeam() : fixture.homeTeam();
            MatchService.MatchRow match = matchService.createLeagueMatch(userId, botTeamId, fixture.id());
            jdbcClient.sql("UPDATE league_fixtures SET match_id = ? WHERE id = ?")
                    .params(match.id(), fixture.id())
                    .update();
            FixtureRow linked = fixtureById(fixture.id()).orElseThrow();
            return new LeagueNextMatchResponse(matchService.toDetail(match), toDto(linked));
        });
    }

    // ── FINISHED 훅 (MatchOrchestrator.finishMatch 내부, 유저 매치 정산) ──

    /** 픽스처 home/away 가 유저 팀인지(엔진 home=픽스처 home 계약 — 어웨이면 유저가 away 사이드). */
    public boolean userIsHomeForFixture(String fixtureId) {
        String homeTeam = jdbcClient.sql("SELECT home_team FROM league_fixtures WHERE id = ?")
                .param(fixtureId).query(String.class).single();
        return USER_TEAM_ID.equals(homeTeam);
    }

    /**
     * 유저 매치 FINISHED 정산(엔진 home/away 관점 = 픽스처 home/away 관점): 픽스처 스코어 기록(CAS,
     * 멱등) → 같은 라운드 봇전 4경기 간이결과 일괄 생성 → 시즌 완료 검사(→ FINISHED + 보상 멱등).
     * finishMatch 트랜잭션 내부에서 호출된다(별도 tx 없음).
     */
    public void settleUserFixture(String fixtureId, int homeGoals, int awayGoals) {
        int claimed = jdbcClient.sql("""
                        UPDATE league_fixtures SET state = 'PLAYED', score_home = ?, score_away = ?
                        WHERE id = ? AND state = 'SCHEDULED'
                        """)
                .params(homeGoals, awayGoals, fixtureId)
                .update();
        if (claimed != 1) {
            return; // 이미 정산됨 — 멱등
        }
        FixtureRow fixture = fixtureById(fixtureId).orElseThrow();
        generateRoundBotResults(fixture.seasonId(), fixture.round());
        maybeFinishSeason(fixture.seasonId());
    }

    /** 라운드의 봇전(is_user=0) SCHEDULED 픽스처를 간이결과로 일괄 PLAYED(시드 결정론, CAS 멱등). */
    public void generateRoundBotResults(String seasonId, int round) {
        SeasonRow season = seasonById(seasonId).orElseThrow();
        Map<String, Integer> power = powersOf(season);
        List<FixtureRow> botFixtures = jdbcClient.sql("""
                        SELECT id, season_id, round, home_team, away_team, is_user, state,
                               score_home, score_away, match_id
                        FROM league_fixtures
                        WHERE season_id = ? AND round = ? AND is_user = 0 AND state = 'SCHEDULED'
                        ORDER BY home_team
                        """)
                .params(seasonId, round)
                .query(FIXTURE_MAPPER)
                .list();
        for (FixtureRow f : botFixtures) {
            BotScore score = botMatchResult(season.seed(), f.id(),
                    power.getOrDefault(f.homeTeam(), 0), power.getOrDefault(f.awayTeam(), 0));
            jdbcClient.sql("""
                            UPDATE league_fixtures SET state = 'PLAYED', score_home = ?, score_away = ?
                            WHERE id = ? AND state = 'SCHEDULED'
                            """)
                    .params(score.home(), score.away(), f.id())
                    .update();
        }
    }

    // 패키지 가시성(테스트 재진입 검증용) — 외부 모듈은 서비스 API 로만 소비.
    void maybeFinishSeason(String seasonId) {
        long remaining = jdbcClient.sql(
                        "SELECT COUNT(*) FROM league_fixtures WHERE season_id = ? AND state = 'SCHEDULED'")
                .param(seasonId).query(Long.class).single();
        if (remaining > 0) {
            return;
        }
        int finished = jdbcClient.sql("""
                        UPDATE league_seasons SET state = 'FINISHED', finished_at = ?
                        WHERE id = ? AND state = 'ACTIVE'
                        """)
                .params(Instant.now().toString(), seasonId)
                .update();
        if (finished == 1) {
            awardSeasonRewards(seasonId);
        }
    }

    /** 순위별 포인트 보상(league.v1 rewards) — 유저 순위 기준, 원장 ref=seasonId 멱등(AC-F4). */
    // 패키지 가시성(테스트: 재호출해도 원장 백스톱으로 중복 지급 0 검증용).
    void awardSeasonRewards(String seasonId) {
        SeasonRow season = seasonById(seasonId).orElseThrow();
        List<LeagueStanding> standings = computeStandings(seasonId);
        int userRank = standings.stream().filter(LeagueStanding::isUser)
                .map(LeagueStanding::rank).findFirst().orElse(-1);
        if (userRank < 0) {
            return;
        }
        List<LeagueDataService.RankReward> rewards = leagueDataService.get()
                .map(LeagueDataService.LeagueData::rewards).orElse(List.of());
        int points = rewards.stream().filter(r -> r.rank() == userRank)
                .map(LeagueDataService.RankReward::points).findFirst().orElse(0);
        if (points > 0) {
            walletService.apply(season.userId(), points, "league_reward", seasonId);
        }
        awardSeasonGems(season, userRank);
        // #252 승급/강등 — 보상과 **같은 지점**(시즌 FINISHED CAS 통과 경로)에서 처리한다.
        // 순위 확정과 떨어뜨리면 "보상은 받았는데 승급은 안 된" 중간 상태가 생긴다.
        applyPromotion(season, userRank);
    }

    /**
     * 시즌 젬 보상(#251 개정) — hero 확정: <b>완주하면 전원 기본 지급</b>(config
     * {@code league.gemReward.completion}) + <b>순위 보너스 가산</b>({@code rankBonus[rank]}).
     * 1등 3,000+6,000=9,000 · 2등 6,000 · 3등 4,000 · 4등 이하 3,000. 젬 수급원은 가입 지급과 이것 둘뿐이다.
     *
     * <p><b>#212 대체</b>(hero 컨펌): 기존 "우승만 [min,max] 랜덤"을 이 고정액이 대체한다 — 얹으면
     * 1등 총액이 요구(9,000)와 어긋난다. 랜덤이 없어졌으므로 시즌 seed 파생 RNG 도 쓰지 않는다
     * (고정액 = 그 자체로 결정론이라 재현성 계약이 더 강해진다).
     *
     * <p><b>멱등</b>: {@code gem_ledger}(reason='league_gem_reward', ref=seasonId) 유니크가 중복 지급을
     * 막는다(P 보상과 동형). reason/ref 를 그대로 두므로 <b>이미 지급된 시즌은 소급되지 않는다</b> —
     * 재진입해도 원장 행이 이미 있어 아무 일도 일어나지 않는다(신규 종료분부터 새 금액).
     */
    private void awardSeasonGems(SeasonRow season, int userRank) {
        // 수치는 항상 값을 돌려주는 접근자로 읽는다 — economy 파일/override 에 새 필드가 없어도
        // 폴백 상수로 메워진다(override 트랩, EconomyService#DEFAULT_LEAGUE_GEM_REWARD).
        int gems = economyService.leagueGemReward().amountFor(userRank);
        if (gems > 0) {
            walletService.applyGems(season.userId(), gems, LEDGER_REASON_LEAGUE_GEM, season.id());
        }
    }

    // ── 순위표 파생 (AC-F3) ──────────────────────────────────────────────

    /** league_fixtures PLAYED 파생 순위 — 승점→골득실→다득점→승자승. teams_json 전 팀 포함(미출전=0). */
    public List<LeagueStanding> computeStandings(String seasonId) {
        SeasonRow season = seasonById(seasonId).orElseThrow();
        List<TeamMeta> teams = teamsOf(season);
        Map<String, Acc> acc = new LinkedHashMap<>();
        for (TeamMeta t : teams) {
            acc.put(t.teamId(), new Acc(t.teamId(), t.name(), t.isUser()));
        }
        List<FixtureRow> played = playedFixtures(seasonId);
        // 승자승(head-to-head) 계산용: 상대별 획득 승점.
        Map<String, Map<String, Integer>> h2hPoints = new LinkedHashMap<>();
        for (FixtureRow f : played) {
            Acc home = acc.get(f.homeTeam());
            Acc away = acc.get(f.awayTeam());
            if (home == null || away == null) {
                continue;
            }
            int sh = f.scoreHome();
            int sa = f.scoreAway();
            home.played++;
            away.played++;
            home.goalsFor += sh;
            home.goalsAgainst += sa;
            away.goalsFor += sa;
            away.goalsAgainst += sh;
            if (sh > sa) {
                home.won++;
                home.points += WIN_POINTS;
                away.lost++;
                addH2h(h2hPoints, f.homeTeam(), f.awayTeam(), WIN_POINTS);
            } else if (sh < sa) {
                away.won++;
                away.points += WIN_POINTS;
                home.lost++;
                addH2h(h2hPoints, f.awayTeam(), f.homeTeam(), WIN_POINTS);
            } else {
                home.drawn++;
                away.drawn++;
                home.points += DRAW_POINTS;
                away.points += DRAW_POINTS;
                addH2h(h2hPoints, f.homeTeam(), f.awayTeam(), DRAW_POINTS);
                addH2h(h2hPoints, f.awayTeam(), f.homeTeam(), DRAW_POINTS);
            }
        }

        List<Acc> ordered = new ArrayList<>(acc.values());
        // 정렬: 승점 → 골득실 → 다득점 → 승자승(pairwise, 동률 2팀에 정확) → teamId(안정).
        ordered.sort(standingsComparator(h2hPoints));
        List<LeagueStanding> result = new ArrayList<>();
        for (int i = 0; i < ordered.size(); i++) {
            Acc a = ordered.get(i);
            result.add(new LeagueStanding(a.teamId, a.name, a.played, a.won, a.drawn, a.lost,
                    a.goalsFor, a.goalsAgainst, a.goalsFor - a.goalsAgainst, a.points, i + 1, a.isUser));
        }
        return result;
    }

    private Comparator<Acc> standingsComparator(Map<String, Map<String, Integer>> h2hPoints) {
        return (x, y) -> {
            if (x.points != y.points) {
                return Integer.compare(y.points, x.points);
            }
            int xGd = x.goalsFor - x.goalsAgainst;
            int yGd = y.goalsFor - y.goalsAgainst;
            if (xGd != yGd) {
                return Integer.compare(yGd, xGd);
            }
            if (x.goalsFor != y.goalsFor) {
                return Integer.compare(y.goalsFor, x.goalsFor);
            }
            // 승자승: 두 팀 상호 대결 승점 비교(2팀 동률에 정확 — 문서화된 pairwise 근사).
            int xh = h2h(h2hPoints, x.teamId, y.teamId);
            int yh = h2h(h2hPoints, y.teamId, x.teamId);
            if (xh != yh) {
                return Integer.compare(yh, xh);
            }
            return x.teamId.compareTo(y.teamId); // 완전 동률은 teamId 안정 정렬
        };
    }

    private static void addH2h(Map<String, Map<String, Integer>> h2h, String team, String opp, int pts) {
        h2h.computeIfAbsent(team, k -> new LinkedHashMap<>()).merge(opp, pts, Integer::sum);
    }

    private static int h2h(Map<String, Map<String, Integer>> h2h, String team, String opp) {
        return h2h.getOrDefault(team, Map.of()).getOrDefault(opp, 0);
    }

    private static final class Acc {
        final String teamId;
        final String name;
        final boolean isUser;
        int played, won, drawn, lost, goalsFor, goalsAgainst, points;

        Acc(String teamId, String name, boolean isUser) {
            this.teamId = teamId;
            this.name = name;
            this.isUser = isUser;
        }
    }

    // ── 봇전 간이 결과 (AC-F2, 시드 결정론) ──────────────────────────────

    public record BotScore(int home, int away) {
    }

    /** 봇전 스코어 — seed+fixtureId 파생 RNG로 홈/어웨이 기대득점 각각 푸아송 샘플(결정론). */
    public BotScore botMatchResult(String seasonSeed, String fixtureId, int homePower, int awayPower) {
        SplittableRandom rng = rngFromSeed(seasonSeed + ":botmatch:" + fixtureId);
        double[] exp = expectedGoals(homePower, awayPower);
        int home = poisson(rng, exp[0]);
        int away = poisson(rng, exp[1]);
        return new BotScore(home, away);
    }

    /**
     * 기대 득점 [home, away] — {@code base + (myPower-oppPower)/divisor (+ homeAdvantage)}, [0.05, maxGoals]
     * 클램프. 홈보정으로 파워 동일 시 homeExp &gt; awayExp(홈 어드밴티지 방향).
     */
    public double[] expectedGoals(int homePower, int awayPower) {
        double diff = (homePower - awayPower) / simPowerDivisor;
        double homeExp = clampGoals(simBaseGoals + diff + simHomeAdvantage);
        double awayExp = clampGoals(simBaseGoals - diff);
        return new double[] {homeExp, awayExp};
    }

    private double clampGoals(double lambda) {
        return Math.max(0.05, Math.min(simMaxGoals, lambda));
    }

    /** Knuth 푸아송 샘플(rng 결정론) — maxGoals 클램프(꼬리 방어). */
    private int poisson(SplittableRandom rng, double lambda) {
        double l = Math.exp(-lambda);
        int k = 0;
        double p = 1.0;
        do {
            k++;
            p *= rng.nextDouble();
        } while (p > l && k <= simMaxGoals + 1);
        int goals = k - 1;
        return Math.min(simMaxGoals, goals);
    }

    // ── 시즌/봇팀 구성 (시드 결정론) ─────────────────────────────────────

    private record TeamBuild(String teamId, String name, String persona, String description,
                             String formation, List<String> rosterPlayerIds, int power, boolean isUser) {
    }

    private List<TeamBuild> buildTeams(String userId, String seasonId, String seed,
                                       LeagueDataService.LeagueData data, int division) {
        List<TeamBuild> teams = new ArrayList<>();
        // 유저 팀(index 0) — 파워는 활성 덱 선발 능력치합(정보용).
        teams.add(new TeamBuild(USER_TEAM_ID, "내 팀", null, null, null, List.of(),
                userTeamPower(userId), true));

        Map<String, List<PlayerRow>> byGrade = playerPoolByGrade();
        List<PlayerRow> gkPool = gkPool();
        SplittableRandom clubRng = rngFromSeed(seed + ":clubs");
        List<String> clubNames = pickDistinct(clubRng, data.clubNames(), botTeamCount);
        List<PersonaPreset> personas = personaPresets(data);
        LeagueDataService.Division spec = divisionSpec(data, division);

        for (int i = 0; i < botTeamCount; i++) {
            String teamId = seasonId + "-T" + (i + 1);
            SplittableRandom rng = rngFromSeed(seed + ":team:" + teamId);
            PersonaPreset persona = personas.get(Math.floorMod(rng.nextInt(), personas.size()));
            List<String> roster = sampleRoster(rng, gkPool, byGrade, spec, persona.formation());
            // 파워는 **배율 적용 후** 값이다 — 화면에 뜨는 파워와 피치 위 실제 강도가 같아야 하고,
            // 봇전 간이결과(expectedGoals)도 이 값을 쓰므로 두 경로가 자동으로 정합한다.
            int power = scaledPower(teamPower(roster), spec);
            teams.add(new TeamBuild(teamId, clubNames.get(i), persona.name(), persona.description(),
                    persona.formation(), roster, power, false));
        }
        return teams;
    }

    /**
     * 봇 로스터 {@code rosterSize} 명. <b>선발 11명은 디비전 등급 슬롯</b>(slot 0 = GK)대로 뽑고,
     * 벤치는 같은 등급 분포에서 채운다(#252). 슬롯 등급의 풀이 비면 인접 등급으로 폴백한다 —
     * 테스트 카탈로그처럼 작은 풀에서도 팀이 서야 하기 때문이다.
     *
     * <p>디비전 표가 없으면(구 {@code league.v1.json}) <b>기존 등급-층화 라운드로빈</b>으로 돌아간다.
     * 발행물을 v1 으로 되돌리는 것이 곧 이 기능의 롤백이다.
     *
     * <p><b>포지션은 포메이션대로 채운다</b>(slot 0=GK, 이후 DF/MF/FW). W1 은 "GK 외엔 안 본다"로
     * 계획했다가 실측에서 뒤집었다 — 등급만 보고 뽑으니 선발 XI 의 평균 GK 수가 디비전마다
     * 1.11~<b>2.00</b> 으로 흔들려 <b>사다리가 단조롭지 않았다</b>(D2 승률 47.6% &gt; D3 33.7%).
     * 골키퍼 둘이 필드에 선 팀은 등급과 무관하게 약하다 = 난이도가 로스터 추첨 운에 좌우된다.
     * 근거 = {@code docs/plan-v5/opponent-balance.md} §6.1.
     */
    private List<String> sampleRoster(SplittableRandom rng, List<PlayerRow> gkPool,
                                      Map<String, List<PlayerRow>> byGrade,
                                      LeagueDataService.Division spec, String formation) {
        if (spec == null) {
            return sampleRosterLegacy(rng, gkPool, byGrade);
        }
        // (등급, 포지션) 2차원 큐. 팀 내 중복 없음.
        Map<String, Map<String, List<PlayerRow>>> pool = new LinkedHashMap<>();
        for (String grade : GRADE_ORDER) {
            Map<String, List<PlayerRow>> byPos = new LinkedHashMap<>();
            for (PlayerRow p : byGrade.getOrDefault(grade, List.of())) {
                byPos.computeIfAbsent(p.position(), k -> new ArrayList<>()).add(p);
            }
            for (List<PlayerRow> q : byPos.values()) {
                shuffle(rng, q);
            }
            pool.put(grade, byPos);
        }

        // 선발 11칸의 포지션 = 포메이션, 등급 = 디비전 슬롯.
        // 등급은 섞어서 배정한다 — gradeSlots 는 낮은 등급부터 정렬돼 있어 그대로 쓰면 상위 등급이
        // 항상 공격수에만 몰린다(포지션과 등급이 상관되면 사다리 해석이 흐려진다).
        List<String> positions = startingPositions(formation);
        List<String> grades = new ArrayList<>(spec.gradeSlots());
        List<String> outfieldGrades = new ArrayList<>(grades.subList(1, grades.size()));
        shuffle(rng, outfieldGrades);

        List<String> roster = new ArrayList<>();
        // slot 0 = GK (등급은 gradeSlots[0]).
        PlayerRow gk = takeAt(pool, grades.get(0), "GK");
        if (gk != null) {
            roster.add(gk.id());
        }
        for (int i = 0; i < outfieldGrades.size() && roster.size() < 11; i++) {
            PlayerRow p = takeAt(pool, outfieldGrades.get(i), positions.get(i + 1));
            if (p != null) {
                roster.add(p.id());
            }
        }
        // 벤치: GK/DF/MF/FW 한 명씩(시드 봇 덱과 같은 형태), 등급은 선발 분포를 재사용.
        List<String> benchPositions = List.of("GK", "DF", "MF", "FW");
        for (int i = 0; roster.size() < rosterSize && i < benchPositions.size(); i++) {
            PlayerRow p = takeAt(pool, outfieldGrades.get(i % outfieldGrades.size()), benchPositions.get(i));
            if (p != null) {
                roster.add(p.id());
            }
        }
        // 그래도 모자라면(작은 카탈로그) 아무나 채운다 — 팀은 서야 한다.
        while (roster.size() < rosterSize) {
            PlayerRow p = takeAt(pool, grades.get(0), null);
            if (p == null) {
                break;
            }
            roster.add(p.id());
        }
        return roster;
    }

    /**
     * 포메이션 문자열 → 선발 11칸의 포지션. {@code "4-3-3"} → GK,DF×4,MF×3,FW×3.
     * 첫 숫자=DF, 마지막=FW, 가운데 합=MF ({@code "4-2-3-1"} → DF4·MF5·FW1).
     * 파싱이 11칸을 못 만들면 4-4-2 로 폴백한다(팀이 안 서는 것보다 낫다).
     */
    public static List<String> startingPositions(String formation) {
        List<String> out = new ArrayList<>();
        out.add("GK");
        try {
            String[] parts = (formation == null ? "4-4-2" : formation).split("-");
            int df = Integer.parseInt(parts[0].trim());
            int fw = Integer.parseInt(parts[parts.length - 1].trim());
            int mf = 0;
            for (int i = 1; i < parts.length - 1; i++) {
                mf += Integer.parseInt(parts[i].trim());
            }
            if (df + mf + fw != 10) {
                throw new IllegalArgumentException("outfield != 10");
            }
            for (int i = 0; i < df; i++) {
                out.add("DF");
            }
            for (int i = 0; i < mf; i++) {
                out.add("MF");
            }
            for (int i = 0; i < fw; i++) {
                out.add("FW");
            }
        } catch (RuntimeException e) {
            out = new ArrayList<>(List.of("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"));
        }
        return out;
    }

    /**
     * (등급, 포지션)에서 하나 꺼낸다. 정확히 맞는 후보가 없으면 <b>같은 포지션의 인접 등급</b>을 먼저
     * 찾고(파워보다 포메이션 정합이 먼저다 — 골키퍼 둘인 팀이 나오지 않게), 그래도 없으면 같은 등급의
     * 아무 포지션, 마지막으로 아무거나. {@code position=null} 이면 포지션을 보지 않는다.
     */
    private PlayerRow takeAt(Map<String, Map<String, List<PlayerRow>>> pool, String grade, String position) {
        int idx = Math.max(0, GRADE_ORDER.indexOf(grade));
        if (position != null) {
            for (int d = 0; d < GRADE_ORDER.size(); d++) {
                for (int sign : new int[] {-1, 1}) {
                    if (d == 0 && sign == 1) {
                        continue;
                    }
                    int j = idx + sign * d;
                    if (j < 0 || j >= GRADE_ORDER.size()) {
                        continue;
                    }
                    List<PlayerRow> q = pool.get(GRADE_ORDER.get(j)).get(position);
                    if (q != null && !q.isEmpty()) {
                        return q.remove(q.size() - 1);
                    }
                }
            }
        }
        for (int d = 0; d < GRADE_ORDER.size(); d++) {
            for (int sign : new int[] {-1, 1}) {
                if (d == 0 && sign == 1) {
                    continue;
                }
                int j = idx + sign * d;
                if (j < 0 || j >= GRADE_ORDER.size()) {
                    continue;
                }
                for (List<PlayerRow> q : pool.get(GRADE_ORDER.get(j)).values()) {
                    if (!q.isEmpty()) {
                        return q.remove(q.size() - 1);
                    }
                }
            }
        }
        return null;
    }

    /**
     * 구 로스터 구성(디비전 표 없는 발행물 폴백) — GK 1(시드) + 등급-층화 라운드로빈.
     * 이 경로가 살아 있어야 `league.v1.json` 으로 되돌리는 롤백이 성립한다.
     */
    private List<String> sampleRosterLegacy(SplittableRandom rng, List<PlayerRow> gkPool,
                                            Map<String, List<PlayerRow>> byGrade) {
        List<String> roster = new ArrayList<>();
        if (!gkPool.isEmpty()) {
            roster.add(gkPool.get(rng.nextInt(gkPool.size())).id());
        }
        Map<String, List<PlayerRow>> remaining = new LinkedHashMap<>();
        for (String grade : GRADE_ORDER) {
            List<PlayerRow> pool = new ArrayList<>(byGrade.getOrDefault(grade, List.of()));
            pool.removeIf(p -> roster.contains(p.id()));
            shuffle(rng, pool);
            remaining.put(grade, pool);
        }
        while (roster.size() < rosterSize) {
            boolean progressed = false;
            for (String grade : GRADE_ORDER) {
                if (roster.size() >= rosterSize) {
                    break;
                }
                List<PlayerRow> pool = remaining.get(grade);
                if (!pool.isEmpty()) {
                    roster.add(pool.remove(pool.size() - 1).id());
                    progressed = true;
                }
            }
            if (!progressed) {
                break;
            }
        }
        return roster;
    }

    // ── 디비전 (#252) ────────────────────────────────────────────────────

    /** 유저 현재 디비전. 컬럼 기본값 = 입문(가장 큰 level). */
    public int divisionOf(String userId) {
        return jdbcClient.sql("SELECT division FROM users WHERE id = ?")
                .param(userId).query(Integer.class).optional().orElse(entryDivision());
    }

    /** 입문 디비전 = 표에서 가장 큰 level(표가 없으면 컬럼 기본값과 같은 10). */
    private int entryDivision() {
        return leagueDataService.get().map(LeagueDataService.LeagueData::divisions)
                .filter(d -> !d.isEmpty())
                .map(d -> d.stream().mapToInt(LeagueDataService.Division::level).max().orElse(10))
                .orElse(10);
    }

    /** 해당 level 의 디비전 스펙. 표가 없거나 level 이 표 밖이면 null(= 구 동작 폴백). */
    private LeagueDataService.Division divisionSpec(LeagueDataService.LeagueData data, int level) {
        if (data == null || data.divisions().isEmpty()) {
            return null;
        }
        return data.divisions().stream().filter(d -> d.level() == level).findFirst()
                .orElseGet(() -> data.divisions().stream()
                        .max(Comparator.comparingInt(LeagueDataService.Division::level)).orElse(null));
    }

    private static int scaledPower(int rawPower, LeagueDataService.Division spec) {
        double mul = spec == null ? 1.0 : spec.strengthMul();
        return (int) Math.round(rawPower * mul);
    }

    /**
     * 승급/강등 전이 규칙(순수 함수 — 부수효과·조회 없음, 그래서 그대로 단언할 수 있다).
     *
     * <p>{@code level} 은 <b>작을수록 상위</b>다: 승급 = −1, 강등 = +1. 사다리 양 끝에서는 클램프
     * (최상위에서 우승해도 더 올라갈 곳이 없고, 입문에서 꼴찌여도 더 내려갈 곳이 없다).
     *
     * @param top    사다리 최상위 level(가장 작은 값) / @param bottom 입문 level(가장 큰 값)
     */
    public static int nextDivision(int from, int userRank, int top, int bottom,
                                   int promoteRankMax, int relegateRankMin) {
        if (userRank >= 1 && userRank <= promoteRankMax) {
            return Math.max(top, from - 1);
        }
        if (userRank >= relegateRankMin) {
            return Math.min(bottom, from + 1);
        }
        return from;
    }

    /**
     * 시즌 종료 승급/강등(#252). 순위 컷은 config(`hmb.league.division.*`).
     * level 은 <b>작을수록 상위</b>이므로 승급 = level−1, 강등 = level+1 이다.
     *
     * <p>멱등: 시즌 FINISHED CAS 를 통과한 경로에서만 호출되고(보상과 같은 지점), 계산은 저장된
     * {@code league_seasons.division} 기준이라 재호출해도 같은 결과다.
     */
    private void applyPromotion(SeasonRow season, int userRank) {
        List<LeagueDataService.Division> divisions = leagueDataService.get()
                .map(LeagueDataService.LeagueData::divisions).orElse(List.of());
        if (divisions.isEmpty()) {
            // 구 발행물(league.v1 = 사다리 없음)로 되돌린 상태 — 승급도 강등도 하지 않는다.
            // ⚠️ 예전엔 top 이 from 으로 폴백돼 **승급만 no-op 이 되고 강등은 계속 걸렸다**.
            // 그 비대칭으로 롤백 상태를 오래 굴리면 전 유저가 입문 디비전으로 흘러내리고,
            // 롤포워드했을 때 진행도가 사라진다. 롤백은 **기능이 꺼지는 것**이어야 한다.
            return;
        }
        int from = season.division();
        int top = divisions.stream().mapToInt(LeagueDataService.Division::level).min().orElse(from);
        int bottom = entryDivision();
        int to = nextDivision(from, userRank, top, bottom, promoteRankMax, relegateRankMin);
        if (to != from) {
            // **CAS**: 유저의 현재 디비전이 아직 이 시즌의 디비전일 때만 옮긴다.
            //
            // 단순 재호출은 CAS 없이도 안전하다 — from 을 박제된 league_seasons.division 에서 읽으므로
            // 몇 번을 돌려도 같은 to 를 쓴다. CAS 가 실제로 막는 것은 **유저가 이미 더 나아간 뒤 옛
            // 시즌 훅이 늦게 도는 경우**다: D5 우승→D4, D4 우승→D3 까지 간 유저에게 첫 시즌 훅이
            // 다시 돌면 CAS 없이는 division 을 4 로 덮어써 **한 칸 되돌린다**.
            // 계약 = LeagueDivisionTest.lateReplayOfAnOldSeasonHookDoesNotUndoALaterPromotion
            int moved = jdbcClient.sql("UPDATE users SET division = ? WHERE id = ? AND division = ?")
                    .params(to, season.userId(), from).update();
            if (moved == 1) {
                log.info("league division {} -> {} (user={}, season={}, rank={})",
                        from, to, season.userId(), season.id(), userRank);
            }
        }
    }

    private static <T> void shuffle(SplittableRandom rng, List<T> list) {
        for (int i = list.size() - 1; i > 0; i--) {
            int j = rng.nextInt(i + 1);
            T tmp = list.get(i);
            list.set(i, list.get(j));
            list.set(j, tmp);
        }
    }

    private static List<String> pickDistinct(SplittableRandom rng, List<String> source, int count) {
        List<String> pool = new ArrayList<>(source);
        shuffle(rng, pool);
        if (pool.size() < count) {
            throw new IllegalStateException("클럽명 풀 부족: " + pool.size() + " < " + count);
        }
        return new ArrayList<>(pool.subList(0, count));
    }

    private record PersonaPreset(String id, String name, String description, String formation) {
    }

    private List<PersonaPreset> personaPresets(LeagueDataService.LeagueData data) {
        List<PersonaPreset> list = new ArrayList<>();
        JsonNode presets = data.personaPresets();
        if (presets != null && presets.isArray()) {
            for (JsonNode p : presets) {
                list.add(new PersonaPreset(p.path("id").asText(), p.path("name").asText(),
                        p.path("description").asText(), p.path("formation").asText("4-4-2")));
            }
        }
        if (list.isEmpty()) {
            list.add(new PersonaPreset("BALANCED", "밸런스", "균형 잡힌 팀", "4-4-2"));
        }
        return list;
    }

    // ── 봇 bots 행 삽입 (매치 상대로 소비) ───────────────────────────────

    /**
     * 봇팀을 bots 테이블에 삽입(matches.bot_id FK). deck_json = 로스터에서 조립(선발 11 + 벤치).
     *
     * <p>{@code kind='league'} (#252): 이 행들은 <b>연습 매칭 풀이 아니다</b>. 예전엔 표식이 없어
     * {@code BotService.pickRandom} 이 이 행들까지 뽑았고, 시즌이 늘수록 연습 상대가 리그 봇팀으로
     * 대체됐다(라이브 45행 : 시드봇 3행). {@code strength_mul} 은 그 시즌 디비전의 값이다.
     */
    private void insertBotRows(List<TeamBuild> teams, LeagueDataService.Division spec) {
        double mul = spec == null ? 1.0 : spec.strengthMul();
        for (TeamBuild t : teams) {
            if (t.isUser()) {
                continue;
            }
            String deckJson = botDeckJson(t);
            jdbcClient.sql("""
                            INSERT INTO bots(id, name, persona, analysis_text, deck_json, kind, strength_mul)
                            VALUES (?, ?, ?, ?, ?, 'league', ?)
                            ON CONFLICT(id) DO UPDATE SET name = excluded.name, persona = excluded.persona,
                              analysis_text = excluded.analysis_text, deck_json = excluded.deck_json,
                              kind = 'league', strength_mul = excluded.strength_mul
                            """)
                    .params(t.teamId(), t.name(), t.persona() == null ? "" : t.persona(),
                            t.description() == null ? "" : t.description(), deckJson, mul)
                    .update();
        }
    }

    private String botDeckJson(TeamBuild t) {
        ObjectNode deck = objectMapper.createObjectNode();
        deck.put("formation", t.formation() == null ? "4-4-2" : t.formation());
        ArrayNode starters = deck.putArray("starters");
        ArrayNode bench = deck.putArray("bench");
        List<String> roster = t.rosterPlayerIds();
        for (int i = 0; i < roster.size(); i++) {
            ObjectNode entry = objectMapper.createObjectNode();
            entry.put("playerId", roster.get(i));
            entry.put("slotIndex", i < 11 ? i : i - 11);
            (i < 11 ? starters : bench).add(entry);
        }
        return deck.toString();
    }

    // ── 일정 (서클 메서드 더블 라운드로빈) ───────────────────────────────

    /** 더블 라운드로빈 18R 픽스처 삽입. 서클 메서드 + 2레그 홈/어웨이 스왑. */
    private void insertFixtures(String seasonId, List<TeamBuild> teams) {
        List<String> teamIds = teams.stream().map(TeamBuild::teamId).toList();
        List<List<int[]>> firstLeg = circleMethod(teamIds.size());
        int rounds = firstLeg.size() * 2;
        for (int r = 0; r < rounds; r++) {
            boolean secondLeg = r >= firstLeg.size();
            List<int[]> pairs = firstLeg.get(secondLeg ? r - firstLeg.size() : r);
            for (int[] pair : pairs) {
                int home = secondLeg ? pair[1] : pair[0];
                int away = secondLeg ? pair[0] : pair[1];
                String homeId = teamIds.get(home);
                String awayId = teamIds.get(away);
                boolean isUser = USER_TEAM_ID.equals(homeId) || USER_TEAM_ID.equals(awayId);
                jdbcClient.sql("""
                                INSERT INTO league_fixtures(id, season_id, round, home_team, away_team,
                                                            is_user, state)
                                VALUES (?, ?, ?, ?, ?, ?, 'SCHEDULED')
                                """)
                        .params(Ulid.next(), seasonId, r + 1, homeId, awayId, isUser ? 1 : 0)
                        .update();
            }
        }
    }

    /** 서클 메서드 단일 라운드로빈 — n(짝수)팀, n-1 라운드, 각 라운드 n/2 쌍 [homeIdx, awayIdx]. */
    public static List<List<int[]>> circleMethod(int n) {
        List<Integer> arr = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            arr.add(i);
        }
        List<List<int[]>> rounds = new ArrayList<>();
        for (int r = 0; r < n - 1; r++) {
            List<int[]> pairs = new ArrayList<>();
            for (int i = 0; i < n / 2; i++) {
                int a = arr.get(i);
                int b = arr.get(n - 1 - i);
                boolean aHome = ((r + i) % 2) == 0; // 홈/어웨이 균형(라운드·위치 패리티)
                pairs.add(aHome ? new int[] {a, b} : new int[] {b, a});
            }
            rounds.add(pairs);
            // 회전: arr[0] 고정, 나머지 시계 회전(마지막을 index1 로).
            List<Integer> rotated = new ArrayList<>();
            rotated.add(arr.get(0));
            rotated.add(arr.get(n - 1));
            for (int i = 1; i < n - 1; i++) {
                rotated.add(arr.get(i));
            }
            arr = rotated;
        }
        return rounds;
    }

    // ── 시즌 DTO 조립 ────────────────────────────────────────────────────

    private LeagueSeason buildSeasonDto(SeasonRow season) {
        List<TeamMeta> teamMetas = teamsOf(season);
        List<LeagueTeam> teams = teamMetas.stream()
                .map(t -> new LeagueTeam(t.teamId(), t.name(), t.persona(), t.power(), t.isUser()))
                .toList();
        List<LeagueStanding> standings = computeStandings(season.id());
        List<LeagueFixture> fixtures = allFixtures(season.id()).stream().map(this::toDto).toList();
        LeagueFixture next = nextUserFixtureRow(season.id()).map(this::toDto).orElse(null);
        SeasonReward reward = buildSeasonReward(season, standings);
        LeagueDataService.Division spec = leagueDataService.get()
                .map(d -> divisionSpec(d, season.division())).orElse(null);
        return new LeagueSeason(season.id(), season.seasonNo(), season.state(),
                teams, standings, fixtures, next, reward,
                season.division(), spec == null ? null : spec.name(),
                promoteRankMax, relegateRankMin);
    }

    /** {@link SeasonReward} 파생(SoT = point_ledger 지급행 + computeStandings 순위 — 새 컬럼 없음). */
    private SeasonReward buildSeasonReward(SeasonRow season, List<LeagueStanding> standings) {
        int userRank = standings.stream().filter(LeagueStanding::isUser)
                .map(LeagueStanding::rank).findFirst().orElse(-1);
        if (!"FINISHED".equals(season.state())) {
            // 시즌 진행 중: rank 은 현재 잠정 순위, 아직 미지급. points=0(예정액을 채우지 않아 web 오인 방지).
            return new SeasonReward(userRank, 0, 0, "PENDING", null);
        }
        // 종료: 지급 진실은 원장(reason='league_reward', ref=seasonId)이다. 원장이 SoT.
        // 젬도 동형(gem_ledger, reason='league_gem_reward') — 비대상이면 행이 없어 0.
        Optional<RewardLedgerRow> gemLedger = leagueGemLedger(season.userId(), season.id());
        int gems = gemLedger.map(r -> (int) r.delta()).orElse(0);
        Optional<RewardLedgerRow> ledger = leagueRewardLedger(season.userId(), season.id());
        if (ledger.isPresent()) {
            return new SeasonReward(userRank, (int) ledger.get().delta(), gems, "GRANTED",
                    ledger.get().createdAt());
        }
        // P 없이 젬만 지급된 경우도 GRANTED 다 — 이때 awardedAt 은 **젬 원장** 시각을 쓴다.
        // (예전엔 null 을 내보내 "GRANTED 인데 지급시각 없음"이라는 모순 상태가 나갔다.)
        if (gemLedger.isPresent()) {
            return new SeasonReward(userRank, 0, gems, "GRANTED", gemLedger.get().createdAt());
        }
        // 종료인데 원장 없음 = 방어 케이스(userRank 미확인 또는 보상액 0).
        return new SeasonReward(userRank, 0, 0, "NONE", null);
    }

    private record RewardLedgerRow(long delta, String createdAt) {
    }

    /** 리그 보상 원장 행(있으면) — 지급 여부·금액·시각의 SoT. */
    private Optional<RewardLedgerRow> leagueRewardLedger(String userId, String seasonId) {
        return jdbcClient.sql("""
                        SELECT delta, created_at FROM point_ledger
                        WHERE user_id = ? AND reason = 'league_reward' AND ref_id = ?
                        """)
                .params(userId, seasonId)
                .query((rs, n) -> new RewardLedgerRow(rs.getLong("delta"), rs.getString("created_at")))
                .optional();
    }

    /** 리그 젬 보상 원장 행(#212) — 있으면 지급됨. P 보상과 동형(ref=seasonId). */
    private Optional<RewardLedgerRow> leagueGemLedger(String userId, String seasonId) {
        return jdbcClient.sql("""
                        SELECT delta, created_at FROM gem_ledger
                        WHERE user_id = ? AND reason = ? AND ref_id = ?
                        """)
                .params(userId, LEDGER_REASON_LEAGUE_GEM, seasonId)
                .query((rs, n) -> new RewardLedgerRow(rs.getLong("delta"), rs.getString("created_at")))
                .optional();
    }

    private LeagueFixture toDto(FixtureRow f) {
        return new LeagueFixture(f.id(), f.round(), f.homeTeam(), f.awayTeam(), f.isUser(),
                f.state(), f.scoreHome(), f.scoreAway(), f.matchId());
    }

    // ── teams_json 직렬화/파싱 ───────────────────────────────────────────

    private record TeamMeta(String teamId, String name, String persona, Integer power, boolean isUser,
                            List<String> rosterPlayerIds) {
    }

    private String teamsJson(List<TeamBuild> teams) {
        ArrayNode arr = objectMapper.createArrayNode();
        for (TeamBuild t : teams) {
            ObjectNode node = objectMapper.createObjectNode();
            node.put("teamId", t.teamId());
            node.put("name", t.name());
            if (t.persona() != null) {
                node.put("persona", t.persona());
            } else {
                node.putNull("persona");
            }
            node.put("power", t.power());
            node.put("isUser", t.isUser());
            ArrayNode roster = node.putArray("rosterPlayerIds");
            t.rosterPlayerIds().forEach(roster::add);
            arr.add(node);
        }
        return arr.toString();
    }

    private List<TeamMeta> teamsOf(SeasonRow season) {
        List<TeamMeta> list = new ArrayList<>();
        JsonNode arr = readJson(season.teamsJson());
        for (JsonNode t : arr) {
            List<String> roster = new ArrayList<>();
            t.path("rosterPlayerIds").forEach(p -> roster.add(p.asText()));
            Integer power = t.hasNonNull("power") ? t.path("power").asInt() : null;
            String persona = t.hasNonNull("persona") ? t.path("persona").asText() : null;
            list.add(new TeamMeta(t.path("teamId").asText(), t.path("name").asText(), persona,
                    power, t.path("isUser").asBoolean(), roster));
        }
        return list;
    }

    private Map<String, Integer> powersOf(SeasonRow season) {
        Map<String, Integer> map = new LinkedHashMap<>();
        for (TeamMeta t : teamsOf(season)) {
            map.put(t.teamId(), t.power() == null ? 0 : t.power());
        }
        return map;
    }

    // ── 선수 풀 / 파워 ───────────────────────────────────────────────────

    private record PlayerRow(String id, String grade, String position, int attrSum) {
    }

    private Map<String, List<PlayerRow>> playerPoolByGrade() {
        Map<String, List<PlayerRow>> byGrade = new LinkedHashMap<>();
        for (PlayerRow p : allPlayers()) {
            byGrade.computeIfAbsent(p.grade(), g -> new ArrayList<>()).add(p);
        }
        return byGrade;
    }

    private List<PlayerRow> gkPool() {
        return jdbcClient.sql(
                        "SELECT id, grade, position, attributes_json FROM players WHERE position = 'GK' ORDER BY id")
                .query(playerMapper)
                .list();
    }

    private List<PlayerRow> allPlayers() {
        return jdbcClient.sql("SELECT id, grade, position, attributes_json FROM players ORDER BY id")
                .query(playerMapper)
                .list();
    }

    /** 인스턴스 매퍼 — attrSum 이 objectMapper 를 쓴다(static 불가). */
    private final org.springframework.jdbc.core.RowMapper<PlayerRow> playerMapper = (rs, n) ->
            new PlayerRow(rs.getString("id"), rs.getString("grade"), rs.getString("position"),
                    attrSum(rs.getString("attributes_json")));

    /** 팀 파워 = 선발 11명(로스터 앞 11) 능력치합 총합. */
    private int teamPower(List<String> roster) {
        int power = 0;
        int count = Math.min(11, roster.size());
        for (int i = 0; i < count; i++) {
            power += attrSumOf(roster.get(i));
        }
        return power;
    }

    private int userTeamPower(String userId) {
        try {
            DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
            int power = 0;
            for (DeckService.SlotDto slot : deck.slots()) {
                if (DeckService.ROLE_STARTER.equals(slot.role())) {
                    power += attrSumOf(slot.playerId());
                }
            }
            return power;
        } catch (RuntimeException e) {
            return 0; // 활성 덱이 없어도 시즌 생성은 진행(파워는 정보용).
        }
    }

    private int attrSumOf(String playerId) {
        return jdbcClient.sql("SELECT attributes_json FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> attrSum(rs.getString("attributes_json")))
                .optional()
                .orElse(0);
    }

    private int attrSum(String attributesJson) {
        try {
            JsonNode node = objectMapper.readTree(attributesJson);
            int sum = 0;
            for (JsonNode v : node) {
                if (v.isNumber()) {
                    sum += v.asInt();
                }
            }
            return sum;
        } catch (Exception e) {
            return 0;
        }
    }

    // ── 조회 헬퍼 ────────────────────────────────────────────────────────

    private Optional<SeasonRow> activeSeason(String userId) {
        return jdbcClient.sql(SEASON_SELECT + " WHERE user_id = ? AND state = 'ACTIVE' ORDER BY season_no DESC LIMIT 1")
                .param(userId).query(SEASON_MAPPER).optional();
    }

    private Optional<SeasonRow> latestSeason(String userId) {
        return jdbcClient.sql(SEASON_SELECT + " WHERE user_id = ? ORDER BY (state = 'ACTIVE') DESC, season_no DESC LIMIT 1")
                .param(userId).query(SEASON_MAPPER).optional();
    }

    private Optional<SeasonRow> seasonById(String seasonId) {
        return jdbcClient.sql(SEASON_SELECT + " WHERE id = ?")
                .param(seasonId).query(SEASON_MAPPER).optional();
    }

    private Optional<FixtureRow> nextUserFixtureRow(String seasonId) {
        return jdbcClient.sql(FIXTURE_SELECT + """
                         WHERE season_id = ? AND is_user = 1 AND state = 'SCHEDULED'
                         ORDER BY round ASC LIMIT 1
                        """)
                .param(seasonId).query(FIXTURE_MAPPER).optional();
    }

    private Optional<FixtureRow> fixtureById(String fixtureId) {
        return jdbcClient.sql(FIXTURE_SELECT + " WHERE id = ?")
                .param(fixtureId).query(FIXTURE_MAPPER).optional();
    }

    private List<FixtureRow> allFixtures(String seasonId) {
        return jdbcClient.sql(FIXTURE_SELECT + " WHERE season_id = ? ORDER BY round ASC, home_team ASC")
                .param(seasonId).query(FIXTURE_MAPPER).list();
    }

    private List<FixtureRow> playedFixtures(String seasonId) {
        return jdbcClient.sql(FIXTURE_SELECT + " WHERE season_id = ? AND state = 'PLAYED'")
                .param(seasonId).query(FIXTURE_MAPPER).list();
    }

    private static final String SEASON_SELECT =
            "SELECT id, user_id, season_no, state, seed, teams_json, created_at, finished_at, division "
                    + "FROM league_seasons";

    private static final org.springframework.jdbc.core.RowMapper<SeasonRow> SEASON_MAPPER = (rs, n) ->
            new SeasonRow(rs.getString("id"), rs.getString("user_id"), rs.getInt("season_no"),
                    rs.getString("state"), rs.getString("seed"), rs.getString("teams_json"),
                    rs.getString("created_at"), rs.getString("finished_at"), rs.getInt("division"));

    private static final String FIXTURE_SELECT =
            "SELECT id, season_id, round, home_team, away_team, is_user, state, score_home, score_away, match_id "
                    + "FROM league_fixtures";

    private static final org.springframework.jdbc.core.RowMapper<FixtureRow> FIXTURE_MAPPER = (rs, n) ->
            new FixtureRow(rs.getString("id"), rs.getString("season_id"), rs.getInt("round"),
                    rs.getString("home_team"), rs.getString("away_team"), rs.getInt("is_user") == 1,
                    rs.getString("state"), (Integer) rs.getObject("score_home"),
                    (Integer) rs.getObject("score_away"), rs.getString("match_id"));

    // ── 유틸 ─────────────────────────────────────────────────────────────

    private static ApiException leagueInvalid(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "LEAGUE_INVALID", message);
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 파싱 실패: " + e.getMessage(), e);
        }
    }

    /** seed 문자열 → SHA-256 첫 8바이트 long → SplittableRandom (Trade/Gacha 와 동일 결정론 규약). */
    static SplittableRandom rngFromSeed(String seed) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8));
            long value = 0;
            for (int i = 0; i < 8; i++) {
                value = (value << 8) | (digest[i] & 0xFF);
            }
            return new SplittableRandom(value);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
