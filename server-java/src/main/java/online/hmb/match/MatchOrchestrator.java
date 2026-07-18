package online.hmb.match;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.catalog.EconomyService;
import online.hmb.common.Hashes;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.engine.EngineRunnerClient;
import online.hmb.jobs.AiJobQueue;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * 매치 오케스트레이션 (LLD §5.2~5.5).
 *
 * 흐름: kickoff/resume(CAS는 MatchService) → enqueueHalf(양팀 컨텍스트 → ai_jobs 멱등 enqueue)
 * → (서번트/W3는 테스트 픽스처가) complete → AiJobQueue가 onJobDone 콜백 → 해당 half의
 * 양측 잡 done 확인 → EngineRunnerClient.simulate → match_halves 저장 + CAS 전이
 * (GEN1→H1_BREAK / GEN2→FINISHED+보상). 이미 done인 잡 재사용(L1, AC-Q2)을 위해
 * enqueue 직후에도 완료 여부를 확인한다.
 *
 * 시뮬 실패(재시도 소진)·잡 영구 실패 → failMatch(CAS → FAILED, AC-M7 재시도 대상).
 */
@Component
public class MatchOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(MatchOrchestrator.class);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final MatchService matchService;
    private final PromptContextBuilder contextBuilder;
    private final BotService botService;
    private final ConditionService conditionService;
    private final RelationService relationService;
    private final EngineRunnerClient runnerClient;
    private final AiJobQueue jobQueue;
    private final WalletService walletService;
    private final EconomyService economyService;
    private final online.hmb.league.LeagueService leagueService;
    private final ObjectMapper objectMapper;

    public MatchOrchestrator(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             MatchService matchService,
                             PromptContextBuilder contextBuilder,
                             BotService botService,
                             ConditionService conditionService,
                             RelationService relationService,
                             EngineRunnerClient runnerClient,
                             AiJobQueue jobQueue,
                             WalletService walletService,
                             EconomyService economyService,
                             online.hmb.league.LeagueService leagueService,
                             ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.matchService = matchService;
        this.contextBuilder = contextBuilder;
        this.botService = botService;
        this.conditionService = conditionService;
        this.relationService = relationService;
        this.runnerClient = runnerClient;
        this.jobQueue = jobQueue;
        this.walletService = walletService;
        this.economyService = economyService;
        this.leagueService = leagueService;
        this.objectMapper = objectMapper;
    }

    /**
     * 엔진 사이드 배치: 엔진 home = 픽스처 home_team 계약. 연습 매치·유저 홈 리그경기는 유저=home,
     * 유저 어웨이 리그경기는 유저=away(홈 어드밴티지가 봇에게, 픽스처 정산이 직접 매핑). league_fixture
     * 없으면 항상 true(연습 경로 불변).
     */
    private boolean userIsHome(MatchService.MatchRow match) {
        if (!"league".equals(match.mode()) || match.leagueFixtureId() == null) {
            return true;
        }
        return leagueService.userIsHomeForFixture(match.leagueFixtureId());
    }

    // ── 잡 enqueue (kickoff/resume/retry 직후) ──────────────────────────

    public void enqueueHalf(String matchId, int half) {
        MatchService.MatchRow match = matchService.find(matchId)
                .orElseThrow(() -> new IllegalStateException("매치 없음: " + matchId));
        JsonNode snapshot = matchService.readJson(match.userDeckJson());
        BotService.BotRow bot = botService.get(match.botId());
        List<MatchService.Substitution> subs = parseSubs(match.subsJson());

        Map<String, Object> prevSummary = null;
        if (half == 2) {
            JsonNode h1Log = halfRow(matchId, 1)
                    .map(r -> matchService.readJson(r.matchLogJson()))
                    .orElseThrow(() -> new IllegalStateException("h1 로그 없이 h2 enqueue 불가"));
            prevSummary = contextBuilder.prevSummaryFrom(h1Log);
        }

        boolean userHome = userIsHome(match);
        String userSide = userHome ? "home" : "away";
        String botSide = userHome ? "away" : "home";

        // A+B 분기(#95): 각 side 를 A재사용(콜0) / B패치 / 풀생성(폴백) 중 하나로 해소한다.
        resolveSide(match, half, userSide, false, snapshot, bot, subs, prevSummary);
        resolveSide(match, half, botSide, true, snapshot, bot, List.of(), prevSummary);

        // 재사용(materialize)·이미 done인 행이 양측 다 준비되면 즉시 진행 (AC-Q2)
        maybeSimulate(matchId, half);
    }

    /**
     * side 1개의 잡을 A+B 분기(#95)로 해소한다.
     *
     * <p><b>half 1</b> — 베이스 = 덱 A(프리컴퓨트/캐시). ① A done + 매치시점 프롬프트 있음 → B잡
     * (team-input-patch, base=A) ② A done + 프롬프트 없음 → A 재사용(seed 교체 후 materialize, 콜0)
     * ③ A 미완 → 풀 생성(team-input) 폴백.
     * <p><b>half 2</b> — 베이스 = h1 최종 인풋. 교체 있음 → 풀 생성(로스터 변경, 패치 부적합) / 하프타임
     * 프롬프트만 있음 → B잡(base=h1 인풋, prevSummary 포함) / 둘 다 없음 → h1 인풋 재사용(seed 교체, 콜0).
     * 봇(isBot)은 매치시점 입력이 없어 항상 재사용 또는 폴백(B 없음).
     */
    private void resolveSide(MatchService.MatchRow match, int half, String side, boolean isBot,
                             JsonNode snapshot, BotService.BotRow bot,
                             List<MatchService.Substitution> subs, Map<String, Object> prevSummary) {
        String matchId = match.id();
        String jobSeed = Hashes.jobSeed(match.seed(), half, side);

        if (half == 1) {
            PromptContextBuilder.BaseJob base = isBot
                    ? contextBuilder.botBaseJob(match, bot)
                    : contextBuilder.userBaseJob(match, snapshot);
            String baseResult = doneResultOf(base.baseId());
            boolean hasInput = !isBot && hasPhasePrompts(matchId, "pre");
            if (baseResult != null && hasInput) {
                enqueuePatch(match, half, side, baseResult, snapshot, bot, subs, prevSummary, isBot);
            } else if (baseResult != null) {
                jobQueue.insertMaterialized(matchId, side, half, seedSwap(baseResult, jobSeed));
            } else {
                enqueueFull(match, half, side, snapshot, bot, subs, prevSummary, isBot);
            }
            return;
        }

        // half 2 — base = h1 최종 인풋(해당 side 컬럼).
        String h1Input = h1InputForSide(matchId, side);
        boolean subsPresent = !isBot && !subs.isEmpty();
        boolean halftimePrompts = !isBot && hasPhasePrompts(matchId, "halftime");
        if (h1Input != null && !subsPresent && halftimePrompts) {
            enqueuePatch(match, half, side, h1Input, snapshot, bot, subs, prevSummary, isBot);
        } else if (h1Input != null && !subsPresent) {
            jobQueue.insertMaterialized(matchId, side, half, seedSwap(h1Input, jobSeed));
        } else {
            enqueueFull(match, half, side, snapshot, bot, subs, prevSummary, isBot);
        }
    }

    /** B(패치) 잡 enqueue — 풀 컨텍스트(매치시점 프롬프트·phase2·prevSummary)에 kind=team-input-patch + base. */
    private void enqueuePatch(MatchService.MatchRow match, int half, String side, String baseResultJson,
                              JsonNode snapshot, BotService.BotRow bot,
                              List<MatchService.Substitution> subs, Map<String, Object> prevSummary,
                              boolean isBot) {
        Map<String, Object> ctx = isBot // 봇은 B 없음(방어적 — 실경로는 유저만)
                ? contextBuilder.buildBotContext(match, half, bot, prevSummary, side)
                : contextBuilder.buildUserContext(match, half, snapshot, subs, prevSummary,
                        contextBuilder.readJson(bot.deckJson()), side);
        ctx.put("kind", "team-input-patch");
        ctx.put("base", matchService.readJson(baseResultJson)); // A/h1 결과 위에 실행기가 패치 정적 머지.
        jobQueue.enqueue(match.id(), side, half, ctx);
    }

    /** 풀 생성(team-input) 폴백 — 기존 경로(A 미완·교체 등). */
    private void enqueueFull(MatchService.MatchRow match, int half, String side,
                             JsonNode snapshot, BotService.BotRow bot,
                             List<MatchService.Substitution> subs, Map<String, Object> prevSummary,
                             boolean isBot) {
        Map<String, Object> ctx = isBot
                ? contextBuilder.buildBotContext(match, half, bot, prevSummary, side)
                : contextBuilder.buildUserContext(match, half, snapshot, subs, prevSummary,
                        contextBuilder.readJson(bot.deckJson()), side);
        jobQueue.enqueue(match.id(), side, half, ctx);
    }

    /**
     * A(베이스) 프리컴퓨트 — 매치 생성(BRIEFING 진입) 즉시 유저팀 A + 봇 A 를 크로스매치 캐시로 enqueue.
     * 유저가 프롬프트를 쓰는 동안 백그라운드에서 A 가 생성돼, 킥오프 때 프롬프트 없으면 콜0(재사용) /
     * 있으면 가벼운 B 패치만 태운다. A-id = sha256(baseContextKeyMaterial)(덱만) → 같은 덱 재경기·양팀 재사용.
     * 봇은 B 가 없으므로 봇 A 가 곧 봇 인풋(크로스매치 캐시 자동). 실패는 로그만(킥오프 enqueueHalf 가 폴백).
     */
    public void prefetchBaseInputs(String matchId) {
        try {
            MatchService.MatchRow match = matchService.find(matchId).orElse(null);
            if (match == null) {
                return;
            }
            JsonNode snapshot = matchService.readJson(match.userDeckJson());
            BotService.BotRow bot = botService.get(match.botId());
            PromptContextBuilder.BaseJob userBase = contextBuilder.userBaseJob(match, snapshot);
            PromptContextBuilder.BaseJob botBase = contextBuilder.botBaseJob(match, bot);
            jobQueue.enqueueBase(userBase.baseId(), userBase.context());
            jobQueue.enqueueBase(botBase.baseId(), botBase.context());
        } catch (Exception e) {
            log.warn("A 프리페치(match {}) 실패 — 무시(킥오프 때 풀생성 폴백): {}", matchId, e.toString());
        }
    }

    /** done 인 A(베이스) 잡의 result_json(없거나 미완이면 null). */
    private String doneResultOf(String baseId) {
        return jobQueue.find(baseId)
                .filter(j -> "done".equals(j.status()) && j.resultJson() != null)
                .map(AiJobQueue.JobRow::resultJson)
                .orElse(null);
    }

    /** h1 최종 인풋(해당 side): match_halves 의 home_input_json/away_input_json. 없으면 null. */
    private String h1InputForSide(String matchId, String side) {
        String column = "home".equals(side) ? "home_input_json" : "away_input_json";
        return jdbcClient.sql("SELECT " + column + " FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    /** 매치시점 프롬프트 존재 여부(phase='pre' or 'halftime', team|player 무관). */
    private boolean hasPhasePrompts(String matchId, String phase) {
        Integer n = jdbcClient.sql(
                        "SELECT COUNT(*) FROM match_prompts WHERE match_id = ? AND phase = ?")
                .params(matchId, phase)
                .query(Integer.class)
                .single();
        return n != null && n > 0;
    }

    /** A/h1 결과의 seed 필드를 halfSeed 로 교체(구조 불변 — 엔진 통과 필드). */
    private String seedSwap(String resultJson, String halfSeed) {
        try {
            JsonNode node = objectMapper.readTree(resultJson);
            if (!node.isObject()) {
                throw new IllegalStateException("TacticalInput 이 오브젝트가 아님");
            }
            ((com.fasterxml.jackson.databind.node.ObjectNode) node).put("seed", halfSeed);
            return objectMapper.writeValueAsString(node);
        } catch (Exception e) {
            throw new IllegalStateException("seed 교체 실패", e);
        }
    }

    // ── 잡 완료 콜백 (AiJobQueue.complete → 여기) ────────────────────────

    public void onJobDone(String jobId) {
        AiJobQueue.JobRow job = jobQueue.find(jobId).orElse(null);
        if (job == null || job.matchId() == null || job.half() == null) {
            return;
        }
        maybeSimulate(job.matchId(), job.half());
    }

    private void maybeSimulate(String matchId, int half) {
        Optional<String> homeResult = latestDoneResult(matchId, half, "home");
        Optional<String> awayResult = latestDoneResult(matchId, half, "away");
        if (homeResult.isEmpty() || awayResult.isEmpty()) {
            return; // 한쪽 미완 — 다음 complete 때 재확인
        }
        MatchService.MatchRow match = matchService.find(matchId).orElse(null);
        String expectedState = half == 1 ? MatchService.S_GEN1 : MatchService.S_GEN2;
        if (match == null || !match.state().equals(expectedState)) {
            return; // 이미 처리됐거나(FINISHED 등) 아직 GEN 진입 전
        }
        if (halfRow(matchId, half).isPresent()) {
            return; // 이미 시뮬·저장 완료
        }

        try {
            simulateAndStore(match, half, homeResult.get(), awayResult.get());
        } catch (Exception e) {
            log.error("simulate half {} for match {} failed: {}", half, matchId, e.toString());
            failMatch(matchId, "simulate failed (h" + half + "): " + e.getMessage());
        }
    }

    // ── 시뮬 + 저장 + 전이 (LLD §5.3~5.5) ────────────────────────────────

    private void simulateAndStore(MatchService.MatchRow match, int half,
                                  String homeInputJson, String awayInputJson) {
        JsonNode snapshot = matchService.readJson(match.userDeckJson());
        BotService.BotRow bot = botService.get(match.botId());
        List<MatchService.Substitution> subs = parseSubs(match.subsJson());
        List<MatchService.Substitution> effectiveSubs = half == 2 ? subs : List.of();

        String halfSeed = Hashes.halfSeed(match.seed(), half);
        Map<String, Object> selectData = buildSelectData(match, snapshot, bot, effectiveSubs);
        JsonNode homeInput = matchService.readJson(homeInputJson);
        JsonNode awayInput = matchService.readJson(awayInputJson);

        // 교체 없음 → h1 resumeState 승계 / 교체 있음 → 생략 = 독립 시뮬 (LLD §5.4)
        // R2(#66) 엔진이 로스터 교체 resume을 지원하면 이 분기 제거.
        JsonNode resumeState = null;
        if (half == 2 && effectiveSubs.isEmpty()) {
            resumeState = halfRow(match.id(), 1)
                    .map(HalfRow::resumeStateJson)
                    .filter(s -> s != null && !s.isBlank())
                    .map(matchService::readJson)
                    .orElse(null);
        }

        EngineRunnerClient.SimulateResult result =
                runnerClient.simulate(halfSeed, selectData, homeInput, awayInput, half, resumeState);

        JsonNode finalScore = result.matchLog().path("finalScore");
        int scoreHome = finalScore.path("home").asInt();
        int scoreAway = finalScore.path("away").asInt();
        String engineVersion = result.matchLog().path("configVersion").asText("unknown");

        txRunner.run(() -> {
            try {
                jdbcClient.sql("""
                                INSERT INTO match_halves(match_id, half, select_data_json, home_input_json,
                                                         away_input_json, half_seed, match_log_json,
                                                         resume_state_json, last_hash)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """)
                        .params(match.id(), half, toJson(selectData), homeInputJson, awayInputJson,
                                halfSeed, result.matchLog().toString(),
                                result.resumeState() == null ? null : result.resumeState().toString(),
                                result.lastHash())
                        .update();
            } catch (DataAccessException e) {
                if (SqliteErrors.isUniqueViolation(e)) {
                    return; // 동시 처리 경합 — 다른 쪽이 이미 저장/전이함
                }
                throw e;
            }

            if (half == 1) {
                jdbcClient.sql("""
                                UPDATE matches SET state = 'H1_BREAK', score_h1_home = ?, score_h1_away = ?,
                                       engine_version = ?
                                WHERE id = ? AND state = 'GEN1'
                                """)
                        .params(scoreHome, scoreAway, engineVersion, match.id())
                        .update();
            } else {
                finishMatch(match, scoreHome, scoreAway);
            }
        });

        // h2 는 별도 A-잡이 없다(#95): h2 베이스 = h1 최종 인풋 → 재개 때 resolveSide 가 재사용(콜0) 또는
        // 하프타임 프롬프트가 있으면 B 패치로 태운다. 봇 h2 도 재사용(콜0)이라 프리페치할 콜이 없다.
    }

    /**
     * FINISHED 전이 트랜잭션 (LLD §5.5, AC-M6): 스코어 합산 → result → CAS → 보상(멱등).
     * CAS가 실패하면(이미 FINISHED) 보상도 건드리지 않는다 + 원장 유니크 인덱스가 이중 방어.
     */
    private void finishMatch(MatchService.MatchRow match, int h2ScoreHome, int h2ScoreAway) {
        // totalHome/totalAway = 엔진(=픽스처) home/away 관점. score_home/away 컬럼도 이 관점으로 저장.
        int totalHome = nvl(match.scoreH1Home()) + h2ScoreHome;
        int totalAway = nvl(match.scoreH1Away()) + h2ScoreAway;
        // result·보상·관계는 유저 관점(어웨이 리그경기면 유저 골=away). 연습/홈경기는 userHome=true 라 불변.
        boolean userHome = userIsHome(match);
        int userGoals = userHome ? totalHome : totalAway;
        int oppGoals = userHome ? totalAway : totalHome;
        String result = userGoals > oppGoals ? "WIN" : userGoals < oppGoals ? "LOSS" : "DRAW";

        int updated = jdbcClient.sql("""
                        UPDATE matches SET state = 'FINISHED', score_home = ?, score_away = ?,
                               result = ?, finished_at = ?
                        WHERE id = ? AND state = 'GEN2'
                        """)
                .params(totalHome, totalAway, result, Instant.now().toString(), match.id())
                .update();
        if (updated != 1) {
            return; // 경합 — 이미 완료 처리됨
        }

        // AC-F2: 리그 매치면 픽스처 정산 + 같은 라운드 봇전 일괄 + 시즌 완료/보상(멱등, LeagueService).
        if ("league".equals(match.mode()) && match.leagueFixtureId() != null) {
            leagueService.settleUserFixture(match.leagueFixtureId(), totalHome, totalAway);
        }

        // AC-C4: 관계/사기 변동 — FINISHED 전이 트랜잭션 내 멱등 적용(relations_applied 플래그 CAS).
        relationService.applyMatchResult(match.userId(), match.id(), result);

        economyService.get().ifPresentOrElse(economy -> {
            int amount = switch (result) {
                case "WIN" -> economy.rewards().win();
                case "LOSS" -> economy.rewards().loss();
                default -> economy.rewards().draw();
            };
            String reason = "reward_" + result.toLowerCase();
            walletService.apply(match.userId(), amount, reason, match.id());
        }, () -> log.warn("economy unavailable — match {} finished without reward", match.id()));
    }

    /** GEN* → FAILED (AC-M7). 그 외 상태면 no-op. */
    public void failMatch(String matchId, String reason) {
        jdbcClient.sql("""
                        UPDATE matches SET state = 'FAILED', fail_reason = ?
                        WHERE id = ? AND state IN ('GEN1', 'GEN2')
                        """)
                .params(reason, matchId)
                .update();
    }

    // ── 내부 ────────────────────────────────────────────────────────────

    /** SelectData (shared 계약): home=유저팀(닉네임), away=봇. 로스터는 현재 half 기준(교체 반영). */
    private Map<String, Object> buildSelectData(MatchService.MatchRow match, JsonNode snapshot,
                                                BotService.BotRow bot,
                                                List<MatchService.Substitution> subs) {
        String nickname = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(match.userId()).query(String.class).single();

        List<PromptContextBuilder.RosterEntry> userRoster = contextBuilder.buildRoster(snapshot, subs);
        List<PromptContextBuilder.RosterEntry> botRoster =
                contextBuilder.buildRoster(contextBuilder.readJson(bot.deckJson()), List.of());

        // AC-C1: 유저팀 능력치에 컨디션 배율 적용(교체 투입 포함 — conditions_json 은 선발+벤치 롤).
        // 봇팀은 컨디션 미적용(빈 맵) — 원본 능력치.
        Map<String, Double> conditions = matchService.conditionsOf(match);
        Map<String, Object> userTeam = teamRoster(nickname, userRoster, conditions);
        Map<String, Object> botTeam = teamRoster(bot.name(), botRoster, Map.of());

        // 엔진 home = 픽스처 home_team(어웨이 리그경기면 유저가 away 사이드). homeInput/awayInput 도
        // 같은 사이드 라벨로 enqueue 되므로 selectData.home 팀과 정합.
        boolean userHome = userIsHome(match);
        Map<String, Object> selectData = new LinkedHashMap<>();
        selectData.put("home", userHome ? userTeam : botTeam);
        selectData.put("away", userHome ? botTeam : userTeam);
        return selectData;
    }

    private Map<String, Object> teamRoster(String name, List<PromptContextBuilder.RosterEntry> roster,
                                           Map<String, Double> conditions) {
        Map<String, Object> team = new LinkedHashMap<>();
        team.put("name", name);
        team.put("players", roster.stream().map(r -> {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("playerId", r.playerId());
            card.put("name", r.name());
            card.put("position", r.position());
            Double condition = conditions.get(r.playerId());
            card.put("attributes", condition == null
                    ? r.attributes()
                    : scaleAttributes(r.attributes(), condition));
            return card;
        }).toList());
        return team;
    }

    /** 능력치 맵에 컨디션 배율 적용(숫자값만 스케일, 그 외 원본 유지). 반올림 후 0..100 클램프. */
    private Map<String, Object> scaleAttributes(Map<String, Object> attributes, double condition) {
        Map<String, Object> scaled = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : attributes.entrySet()) {
            Object v = e.getValue();
            if (v instanceof Number number) {
                scaled.put(e.getKey(), conditionService.scaleAttribute(number.intValue(), condition));
            } else {
                scaled.put(e.getKey(), v);
            }
        }
        return scaled;
    }

    private Optional<String> latestDoneResult(String matchId, int half, String side) {
        return jdbcClient.sql("""
                        SELECT result_json FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = ? AND status = 'done'
                        ORDER BY updated_at DESC, created_at DESC LIMIT 1
                        """)
                .params(matchId, half, side)
                .query(String.class)
                .optional();
    }

    private record HalfRow(String matchLogJson, String resumeStateJson) {
    }

    private Optional<HalfRow> halfRow(String matchId, int half) {
        return jdbcClient.sql(
                        "SELECT match_log_json, resume_state_json FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half)
                .query((rs, n) -> new HalfRow(rs.getString("match_log_json"), rs.getString("resume_state_json")))
                .optional();
    }

    private List<MatchService.Substitution> parseSubs(String subsJson) {
        if (subsJson == null || subsJson.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(subsJson, new TypeReference<List<MatchService.Substitution>>() {
            });
        } catch (Exception e) {
            throw new IllegalStateException("subs_json 파싱 실패", e);
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static int nvl(Integer value) {
        return value == null ? 0 : value;
    }
}
