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
    private final EngineRunnerClient runnerClient;
    private final AiJobQueue jobQueue;
    private final WalletService walletService;
    private final EconomyService economyService;
    private final ObjectMapper objectMapper;

    public MatchOrchestrator(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             MatchService matchService,
                             PromptContextBuilder contextBuilder,
                             BotService botService,
                             EngineRunnerClient runnerClient,
                             AiJobQueue jobQueue,
                             WalletService walletService,
                             EconomyService economyService,
                             ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.matchService = matchService;
        this.contextBuilder = contextBuilder;
        this.botService = botService;
        this.runnerClient = runnerClient;
        this.jobQueue = jobQueue;
        this.walletService = walletService;
        this.economyService = economyService;
        this.objectMapper = objectMapper;
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

        Map<String, Object> homeContext = contextBuilder.buildUserContext(match, half, snapshot, subs, prevSummary);
        Map<String, Object> awayContext = contextBuilder.buildBotContext(match, half, bot, prevSummary);

        jobQueue.enqueue(matchId, "home", half, homeContext);
        jobQueue.enqueue(matchId, "away", half, awayContext);

        // 이미 done인 행 재사용(L1) — enqueue가 no-op이었고 양측 다 done이면 즉시 진행 (AC-Q2)
        maybeSimulate(matchId, half);
    }

    /**
     * 봇(away) 잡 선(先)enqueue — #1 프리페치. 크리티컬 패스 밖(브리핑 h1 · H1_BREAK h2)에서 미리 생성해
     * 유저 대기시간을 봇 콜만큼 줄인다. 봇 컨텍스트는 유저 입력과 무관(buildBotContext 는 match.id/seed·
     * bot·half·prevSummary 만 사용)이라, 이후 kickoff/resume 의 enqueueHalf 가 만드는 away 컨텍스트와
     * 동일 promptHash → INSERT OR IGNORE 멱등(중복 잡 없음). 프리페치 실패는 로그만 — 매치를 막지 않고
     * enqueueHalf 가 다시 시도한다. h2 는 h1 로그(prevSummary)가 필요하므로 아직 없으면 조용히 스킵.
     */
    public void prefetchBotHalf(String matchId, int half) {
        try {
            MatchService.MatchRow match = matchService.find(matchId).orElse(null);
            if (match == null) {
                return;
            }
            BotService.BotRow bot = botService.get(match.botId());
            Map<String, Object> prevSummary = null;
            if (half == 2) {
                Optional<JsonNode> h1Log = halfRow(matchId, 1).map(r -> matchService.readJson(r.matchLogJson()));
                if (h1Log.isEmpty()) {
                    return; // h1 아직 미완 — 재개 때 enqueueHalf 가 처리
                }
                prevSummary = contextBuilder.prevSummaryFrom(h1Log.get());
            }
            Map<String, Object> awayContext = contextBuilder.buildBotContext(match, half, bot, prevSummary);
            jobQueue.enqueue(matchId, "away", half, awayContext);
        } catch (Exception e) {
            log.warn("봇 프리페치(match {} h{}) 실패 — 무시(kickoff/resume 때 재시도): {}", matchId, half, e.toString());
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

        // #1 프리페치: h1 저장·H1_BREAK 후, 재개 전에 봇 h2 를 미리 생성(하프타임 대기시간 활용).
        // 트랜잭션 밖에서 호출(프리페치 실패가 h1 커밋을 롤백하지 않도록) — h1 로그가 이제 존재해 prevSummary 확보 가능.
        if (half == 1) {
            prefetchBotHalf(match.id(), 2);
        }
    }

    /**
     * FINISHED 전이 트랜잭션 (LLD §5.5, AC-M6): 스코어 합산 → result → CAS → 보상(멱등).
     * CAS가 실패하면(이미 FINISHED) 보상도 건드리지 않는다 + 원장 유니크 인덱스가 이중 방어.
     */
    private void finishMatch(MatchService.MatchRow match, int h2ScoreHome, int h2ScoreAway) {
        int totalHome = nvl(match.scoreH1Home()) + h2ScoreHome;
        int totalAway = nvl(match.scoreH1Away()) + h2ScoreAway;
        String result = totalHome > totalAway ? "WIN" : totalHome < totalAway ? "LOSS" : "DRAW";

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

        List<PromptContextBuilder.RosterEntry> homeRoster = contextBuilder.buildRoster(snapshot, subs);
        List<PromptContextBuilder.RosterEntry> awayRoster =
                contextBuilder.buildRoster(contextBuilder.readJson(bot.deckJson()), List.of());

        Map<String, Object> selectData = new LinkedHashMap<>();
        selectData.put("home", teamRoster(nickname, homeRoster));
        selectData.put("away", teamRoster(bot.name(), awayRoster));
        return selectData;
    }

    private Map<String, Object> teamRoster(String name, List<PromptContextBuilder.RosterEntry> roster) {
        Map<String, Object> team = new LinkedHashMap<>();
        team.put("name", name);
        team.put("players", roster.stream().map(r -> {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("playerId", r.playerId());
            card.put("name", r.name());
            card.put("position", r.position());
            card.put("attributes", r.attributes());
            return card;
        }).toList());
        return team;
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
