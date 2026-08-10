package online.hmb.match;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.catalog.EconomyService;
import online.hmb.rewards.RewardBundleService;
import online.hmb.common.Hashes;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.engine.EngineRunnerClient;
import online.hmb.events.BusinessEvent;
import online.hmb.events.BusinessEventRecorder;
import online.hmb.jobs.AiJobQueue;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
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
    private final DeckPrewarmService prewarmService;
    private final BotService botService;
    private final online.hmb.away.AwayService awayService;
    private final String awayRewardMode;
    private final ConditionService conditionService;
    private final RelationService relationService;
    private final EngineRunnerClient runnerClient;
    private final AiJobQueue jobQueue;
    private final WalletService walletService;
    private final EconomyService economyService;
    private final online.hmb.league.LeagueService leagueService;
    private final online.hmb.league.LeagueDailyRewardService leagueDailyRewardService;
    private final online.hmb.growth.GrowthService growthService;
    /** #405 W2b §2.9 — 정산 결과를 한 장으로 묶는 공용 보상 봉투(표시용, 지급의 SoT 아님). */
    private final RewardBundleService rewardBundleService;
    private final online.hmb.mission.MissionService missionService;
    private final MatchClockService clockService;
    /** #492 비즈니스 이벤트 — match_finish 는 정산 커밋 **후**에만 기록한다. */
    private final BusinessEventRecorder eventRecorder;
    private final ObjectMapper objectMapper;
    /** #193 라운드2 — 지시 델타 라우팅 노브(전부 config, 하드코딩 금지). */
    private final boolean deltaEnabled;
    private final int overhaulAxisCount;
    private final String overhaulEffort;
    private final boolean reuseOnNoChange;

    public MatchOrchestrator(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             MatchService matchService,
                             PromptContextBuilder contextBuilder,
                             BotService botService,
                             online.hmb.away.AwayService awayService,
                             @Value("${hmb.away.reward.mode}") String awayRewardMode,
                             ConditionService conditionService,
                             RelationService relationService,
                             EngineRunnerClient runnerClient,
                             AiJobQueue jobQueue,
                             WalletService walletService,
                             EconomyService economyService,
                             online.hmb.league.LeagueService leagueService,
                             online.hmb.league.LeagueDailyRewardService leagueDailyRewardService,
                             online.hmb.growth.GrowthService growthService,
                             RewardBundleService rewardBundleService,
                             online.hmb.mission.MissionService missionService,
                             MatchClockService clockService,
                             DeckPrewarmService prewarmService,
                             BusinessEventRecorder eventRecorder,
                             ObjectMapper objectMapper,
                             @Value("${hmb.match.delta.enabled}") boolean deltaEnabled,
                             @Value("${hmb.match.delta.overhaul-axis-count}") int overhaulAxisCount,
                             @Value("${hmb.match.delta.overhaul-effort}") String overhaulEffort,
                             @Value("${hmb.match.delta.reuse-on-no-change}") boolean reuseOnNoChange) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.prewarmService = prewarmService;
        this.eventRecorder = eventRecorder;
        this.matchService = matchService;
        this.contextBuilder = contextBuilder;
        this.botService = botService;
        this.awayService = awayService;
        this.awayRewardMode = awayRewardMode;
        this.conditionService = conditionService;
        this.relationService = relationService;
        this.runnerClient = runnerClient;
        this.jobQueue = jobQueue;
        this.walletService = walletService;
        this.economyService = economyService;
        this.leagueService = leagueService;
        this.leagueDailyRewardService = leagueDailyRewardService;
        this.growthService = growthService;
        this.rewardBundleService = rewardBundleService;
        this.missionService = missionService;
        this.clockService = clockService;
        this.objectMapper = objectMapper;
        this.deltaEnabled = deltaEnabled;
        this.overhaulAxisCount = overhaulAxisCount;
        this.overhaulEffort = overhaulEffort;
        this.reuseOnNoChange = reuseOnNoChange;
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

    /** 보상 조회용 모드 키(#212) — 레거시 행(mode NULL)은 practice 로 본다(MatchService 뷰와 동일 규칙). */
    private static String modeOf(MatchService.MatchRow match) {
        return match.mode() == null ? "practice" : match.mode();
    }

    // ── 잡 enqueue (kickoff/resume/retry 직후) ──────────────────────────

    public void enqueueHalf(String matchId, int half) {
        MatchService.MatchRow match = matchService.find(matchId)
                .orElseThrow(() -> new IllegalStateException("매치 없음: " + matchId));

        // GEN 진입 호출(킥오프/재개/재시도)이면 미완 잡의 타임아웃 시계를 여기서 시작한다 — h2 선행
        // 생성(#193 W2b-B2)은 GEN2 보다 한 하프 앞서 잡을 만들기 때문. GEN 이전(선행 생성·재해소
        // 호출)엔 아무 것도 건드리지 않는다.
        String genState = half == 1 ? MatchService.S_GEN1 : MatchService.S_GEN2;
        if (genState.equals(match.state())) {
            jobQueue.restartPendingTimeout(matchId, half);
        }

        BotService.BotRow bot = botService.get(match.botId());
        List<MatchService.Substitution> subs = parseSubs(match.subsJson());

        // half 2 면 감독시간 전술(#254) + 배치(#276)가 얹힌 <b>실효 스냅샷</b>이다 — 전술은 컨텍스트의
        // manualTactics 로(addPhase2Context), 포메이션·slotIndex 는 context.formation/roster[] 로
        // 흘러가므로(PromptContextBuilder 는 이미 둘을 싣고 있다) 여기서 갈아끼우는 것만으로 AI
        // 프롬프트까지 자동 관통한다(추가 배선 0). SelectData 엔 formation·slotIndex 가 없어 불변.
        // subs 를 넘기는 이유: 배치 병합이 <b>투입 선수 기준</b>으로 슬롯을 조회해야 교체와 배치가
        // 서로를 덮지 않는다(snapshotForHalf javadoc).
        JsonNode snapshot = matchService.snapshotForHalf(match, half, subs);

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
     * <p><b>half 2</b> — 베이스 = h1 최종 인풋. 교체 있음 <b>또는 배치 변경</b>(#276) → 풀 생성
     * (로스터·포메이션 변경은 패치 부적합) / 하프타임
     * 프롬프트만 있음 → B잡(base=h1 인풋, prevSummary 포함) / 둘 다 없음 → h1 인풋 재사용(seed 교체, 콜0).
     * 봇(isBot)은 매치시점 입력이 없어 항상 재사용 또는 폴백(B 없음).
     *
     * <p><b>h2 는 해소가 여러 번 일어난다</b>(#193 W2b-B2 선행 생성 + 감독시간 편집 재해소) — 그래서
     * 매번 이번 해소의 잡 id 로 {@link AiJobQueue#supersede} 를 걸어 <b>(match,half,side) 당 유효 잡 1개</b>
     * 를 유지한다. h1 은 GEN1 안에서만 해소되므로 그대로 둔다(기존 경로 무변경).
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
            // 매치시점 입력 = pre 프롬프트 **또는 수동 전술**. 전술은 A 키에서 빠졌으므로(#215 W2)
            // A 는 그 값을 모른다 — 있으면 재사용이 아니라 A 위의 패치로 얹어야 유저 슬라이더가 반영된다.
            boolean hasInput = !isBot
                    && (hasPhasePrompts(matchId, "pre") || contextBuilder.hasManualTactics(snapshot));
            String h1JobId;
            if (baseResult != null && hasInput) {
                // 킥오프 B 패치: A 가 쓴 덱 사전 지시 → 매치시점(pre) 지시의 변경분만 델타로 얹는다.
                Map<String, Object> delta = promptDeltaFor(match, snapshot, List.of(),
                        PromptContextBuilder.BASE_PHASES, PromptContextBuilder.PRE_PHASES);
                if (isNoOpAgainstBase(delta, snapshot)) {
                    // 매치시점 입력이 **있긴 하지만 A 가 이미 쓴 값과 같다**. 덱 팀 문장(#253)이 생긴
                    // 뒤로 흔해진 경로다 — 브리핑은 그 문장을 그대로 pre 로 제출하므로 "지시가 있다"는
                    // 참이지만 내용은 A 와 동일하다. 여기서 패치를 태우면 같은 답을 다시 만드는 AI 콜이라
                    // #215 가 노린 "무변경이면 즉시 시작(콜0)"이 팀 문장을 쓴 유저에게만 사라진다.
                    h1JobId = jobQueue.insertMaterialized(matchId, side, half, seedSwap(baseResult, jobSeed));
                } else {
                    h1JobId = isTeamOverhaul(delta, matchId, half, side)
                            // 대변경 → 이 사이드만 풀생성으로 (#193 라운드2)
                            ? enqueueFull(match, half, side, snapshot, bot, subs, prevSummary, isBot,
                                    overhaulEffort)
                            : enqueuePatch(match, half, side, baseResult, snapshot, bot, subs, prevSummary,
                                    isBot, delta);
                }
            } else if (baseResult != null) {
                h1JobId = jobQueue.insertMaterialized(matchId, side, half, seedSwap(baseResult, jobSeed));
            } else {
                h1JobId = enqueueFull(match, half, side, snapshot, bot, subs, prevSummary, isBot, null);
            }
            // h1 은 GEN1 안에서만 해소되므로 보통 행이 하나다 — 그래도 "유효 잡 = 이번 해소 대상"
            // 불변식은 양쪽 half 에 똑같이 건다(재시도·폴백 경로가 행을 늘려도 선택이 흔들리지 않게).
            jobQueue.supersede(matchId, half, side, h1JobId);
            return;
        }

        // half 2 — base = h1 최종 인풋(해당 side 컬럼).
        String h1Input = h1InputForSide(matchId, side);
        boolean subsPresent = !isBot && !subs.isEmpty();
        boolean halftimePrompts = !isBot && hasPhasePrompts(matchId, "halftime");
        // 감독시간 전술 변경(#254) — 지시와 <b>같은 자격</b>의 후반 입력이다. 이게 없으면 유저가 다이얼을
        // 돌려도 h1 인풋 재사용(콜0) 분기로 떨어져 후반이 전반 전술 그대로 돌아간다(= 조용한 무시).
        boolean halftimeTactics = !isBot && matchService.secondHalfTacticsChanged(match);
        // 감독시간 배치 변경(#276) — 전술과 달리 <b>패치로는 표현할 수 없다</b>.
        // packages/shared/src/tactical-patch.ts 가 "formation 은 A(덱) 소유라 패치 불가"라고 못 박았고
        // 패치 프롬프트(packages/server/src/prompt/coach.ts)는 **베이스의** 포메이션을 출력한다 →
        // 패치로 보내면 AI 가 포메이션이 바뀐 줄 모르고 basePosition 11개를 그대로 물려준다
        // (**조용한 무시**). 그래서 유저 사이드를 풀 생성으로 강제한다 — 교체(subsPresent)가 이미
        // 같은 이유(로스터 변경 = 패치 부적합)로 같은 분기를 쓴다. 봇 사이드는 종전대로.
        boolean halftimeShape = !isBot && matchService.secondHalfShapeChanged(match, subs);
        String targetJobId;
        if (h1Input != null && !subsPresent && !halftimeShape && (halftimePrompts || halftimeTactics)) {
            // h2 B 패치: 전반에 유효했던 지시(pre) → 하프타임 지시의 변경분.
            Map<String, Object> delta = promptDeltaFor(match, snapshot, subs,
                    PromptContextBuilder.PRE_PHASES, PromptContextBuilder.HALFTIME_PHASES);
            if (isNoOpAgainstBase(delta, halftimeTactics)) {
                // 하프타임 지시를 냈지만 전반 지시와 내용이 같고 전술도 그대로 → 재사용(콜0).
                targetJobId = jobQueue.insertMaterialized(matchId, side, half, seedSwap(h1Input, jobSeed));
            } else {
                targetJobId = isTeamOverhaul(delta, matchId, half, side)
                        ? enqueueFull(match, half, side, snapshot, bot, subs, prevSummary, isBot, overhaulEffort)
                        : enqueuePatch(match, half, side, h1Input, snapshot, bot, subs, prevSummary, isBot, delta);
            }
        } else if (h1Input != null && !subsPresent && !halftimeShape) {
            targetJobId = jobQueue.insertMaterialized(matchId, side, half, seedSwap(h1Input, jobSeed));
        } else {
            targetJobId = enqueueFull(match, half, side, snapshot, bot, subs, prevSummary, isBot, null);
        }
        jobQueue.supersede(matchId, half, side, targetJobId);
    }

    /**
     * 유저팀 프롬프트 델타(#193 W2b-B2). {@code oldPhases}→{@code newPhases} 두 시점의 유효 지시 세트를
     * 같은 함수로 만들어(=컨텍스트에 실리는 값과 동일) 차이만 뽑는다. 차이가 없으면 null(필드 생략).
     *
     * <p>{@code hmb.match.delta.enabled=false} 면 항상 null — 델타 도입 이전의 "베이스 위 <b>풀 패치</b>"
     * 동작으로 통째 롤백된다(라우팅도 델타를 입력으로 하므로 함께 멈춘다).
     */
    private Map<String, Object> promptDeltaFor(MatchService.MatchRow match, JsonNode snapshot,
                                               List<MatchService.Substitution> subs,
                                               List<String> oldPhases, List<String> newPhases) {
        if (!deltaEnabled) {
            return null;
        }
        Set<String> rosterIds = contextBuilder.rosterIds(snapshot, subs);
        return contextBuilder.promptDelta(
                contextBuilder.userPromptSet(match.id(), snapshot, rosterIds, oldPhases),
                contextBuilder.userPromptSet(match.id(), snapshot, rosterIds, newPhases));
    }

    /**
     * 이 해소가 <b>베이스와 완전히 같은 입력</b>인가 = 패치를 태워도 같은 답이 나오는가.
     *
     * <p>참이면 B 패치 대신 베이스 재사용(콜0)으로 간다. 조건은 둘 다여야 한다:
     * <ul>
     *   <li>지시 델타가 <b>없다</b> — 유효 지시 세트가 베이스가 쓴 것과 글자 단위로 같다.</li>
     *   <li>수동 전술이 <b>없다</b> — 전술은 A 키 밖(#215 W2)이라 델타가 비어도 베이스는 그 값을 모른다.
     *       (h2 는 전술 변경 여부를 호출측이 판정해 {@code tacticsPending} 로 넘긴다.)</li>
     * </ul>
     *
     * <p>{@code hmb.match.delta.enabled=false} 면 델타 자체가 항상 null 이라 "같다"를 판정할 근거가
     * 없다 → 항상 false(델타 도입 이전의 풀 패치 동작으로 통째 롤백).
     *
     * <p><b>트레이드오프</b>(독립검증 major-1, hero 소급 리뷰용): 재사용이 쓰는 A 컨텍스트는 덱만 안다 —
     * {@code opponentRoster}·{@code conditions}·{@code relations}·{@code teamMorale} 이 없다(A 는 매치보다
     * 먼저 만들어지므로 원리상 가질 수 없다). 그래서 이 분기는 <b>"이 경기에 대해 새로 말한 게 없는
     * 유저"를 지시가 아예 없는 유저와 같이 취급</b>한다 — 후자는 이 변경 전에도 상대 비의존 재사용이었으니
     * 새 성질이 아니라 <b>적용 범위 확대</b>다. 상대를 보고 쓴 문장(브리핑에서 덱 문장과 다르게 쓴 경우)은
     * 델타가 생겨 그대로 B 패치이므로 상대 컨텍스트를 받는다. 품질을 우선해 되돌리려면 코드가 아니라
     * {@code hmb.match.delta.reuse-on-no-change=false}.
     */
    private boolean isNoOpAgainstBase(Map<String, Object> delta, boolean tacticsPending) {
        return reuseOnNoChange && deltaEnabled && delta == null && !tacticsPending;
    }

    private boolean isNoOpAgainstBase(Map<String, Object> delta, JsonNode snapshot) {
        return isNoOpAgainstBase(delta, contextBuilder.hasManualTactics(snapshot));
    }

    /**
     * <b>팀 지시 대변경</b> 판정 (#193 라운드2). 델타에 팀 지시 변경이 있고, <b>새 팀 지시가 건드리는
     * 전술 축</b>({@link OverhaulDetector})이 {@code hmb.match.delta.overhaul-axis-count} 개 이상이면
     * 이 사이드는 델타 패치가 아니라 <b>풀생성</b>으로 간다.
     *
     * <p>근거(블라인드 맞대결 라운드2): 풀생성이 이긴 것은 <b>다축 대변경 K1</b> 하나뿐이다
     * (델타 3.13 vs 풀 4.75 — 델타가 파급을 반쪽만 구현). 반대로 소변경 K2(델타 4.63 vs 풀 3.25)·
     * 돌발 3종(델타 3.83~5.00 PASS)·개인지시 K3(4.00)는 델타가 동급 이상이라 그대로 둔다. 즉 잘못
     * 라우팅하면 지연뿐 아니라 <b>품질도 잃는다</b> → 신호는 "얼마나 다른 낱말인가"(자카드)가 아니라
     * "<b>몇 개의 축을 동시에 건드리는가</b>"다. 자카드는 실 경로에서 old 가 항상 비어(덱에 팀 지시 없음)
     * 모든 킥오프를 풀생성으로 보냈다 — 폐기 사유는 {@link OverhaulDetector} 참조.
     *
     * <p>판정 대상은 <b>팀 지시</b>뿐이다 — 선수 지시만 바뀐 변경은 여기서 항상 false.
     */
    private boolean isTeamOverhaul(Map<String, Object> delta, String matchId, int half, String side) {
        if (delta == null || !(delta.get("team") instanceof Map<?, ?> team)) {
            return false;
        }
        String newText = team.get("new") == null ? "" : String.valueOf(team.get("new"));
        Set<String> axes = OverhaulDetector.axes(newText);
        if (axes.size() < overhaulAxisCount) {
            log.debug("팀 지시 소변경(match {} h{} {}) — 전술 축 {}개{} < {} → 델타 유지",
                    matchId, half, side, axes.size(), axes, overhaulAxisCount);
            return false;
        }
        log.info("팀 지시 대변경 감지(match {} h{} {}) — 전술 축 {}개{} ≥ {} → 풀생성 라우팅(effortHint='{}')",
                matchId, half, side, axes.size(), axes, overhaulAxisCount, overhaulEffort);
        return true;
    }

    /**
     * B(패치) 잡 enqueue — 풀 컨텍스트(매치시점 프롬프트·phase2·prevSummary)에 kind=team-input-patch + base.
     * {@code promptDelta} 는 <b>추가 필드</b>다: 기존 필드는 그대로 두고(서번트 후방 호환·풀 컨텍스트
     * 폴백), 있으면 실행기가 변경분만 제시하는 델타 모드로 프롬프트를 조립한다.
     *
     * @return 잡 id
     */
    private String enqueuePatch(MatchService.MatchRow match, int half, String side, String baseResultJson,
                                JsonNode snapshot, BotService.BotRow bot,
                                List<MatchService.Substitution> subs, Map<String, Object> prevSummary,
                                boolean isBot, Map<String, Object> promptDelta) {
        Map<String, Object> ctx = isBot // 봇은 B 없음(방어적 — 실경로는 유저만)
                ? contextBuilder.buildBotContext(match, half, bot, prevSummary, side)
                : contextBuilder.buildUserContext(match, half, snapshot, subs, prevSummary,
                        contextBuilder.readJson(bot.deckJson()), side);
        ctx.put("kind", "team-input-patch");
        ctx.put("base", matchService.readJson(baseResultJson)); // A/h1 결과 위에 실행기가 패치 정적 머지.
        if (promptDelta != null && !promptDelta.isEmpty()) {
            ctx.put("promptDelta", promptDelta);
        }
        return jobQueue.enqueue(match.id(), side, half, ctx);
    }

    /**
     * 풀 생성(team-input) — 기존 폴백 경로(A 미완·교체 등) + <b>대변경 라우팅</b>(#193 라운드2)의 목적지.
     * 컨텍스트엔 매치시점 프롬프트 전체가 이미 들어 있다(buildUserContext).
     *
     * @param effortHint 대변경 라우팅으로 왔을 때만 non-null — 그 잡에만 {@code effortHint} 를 실어
     *     실행기(claude-code)가 env 기본 대신 이 effort 로 돌게 한다(빈 문자열 = 세션 기본 effort,
     *     맞대결 4.75 의 조건). <b>일반 폴백은 null</b> = 필드 미첨부(기존 동작 불변).
     *     shared 계약은 무변경 — 비엄격 zod 가 통과시키고 실행기는 raw context 로 읽는다.
     * @return 잡 id
     */
    private String enqueueFull(MatchService.MatchRow match, int half, String side,
                               JsonNode snapshot, BotService.BotRow bot,
                               List<MatchService.Substitution> subs, Map<String, Object> prevSummary,
                               boolean isBot, String effortHint) {
        Map<String, Object> ctx = isBot
                ? contextBuilder.buildBotContext(match, half, bot, prevSummary, side)
                : contextBuilder.buildUserContext(match, half, snapshot, subs, prevSummary,
                        contextBuilder.readJson(bot.deckJson()), side);
        if (effortHint != null) {
            ctx.put("effortHint", effortHint);
        }
        return jobQueue.enqueue(match.id(), side, half, ctx);
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
            // enqueue 와 원장 기록은 한 트랜잭션이다 — 사이가 벌어지면 그 틈에 남의 덱 재저장이
            // 이 A 를 회수해 폴백으로 떨어뜨린다(#215 독립검증 F2 의 잔여 창 R3).
            // 이 유저도 "A 를 기다리는 사람"이므로 원장에 실어야 회수 보호가 성립한다(행 있으면 안 덮음).
            txRunner.run(() -> {
                jobQueue.enqueueBase(userBase.baseId(), userBase.context());
                jobQueue.enqueueBase(botBase.baseId(), botBase.context());
                prewarmService.noteWaiting(match.userId(), userBase.baseId());
                return null;
            });
        } catch (Exception e) {
            log.warn("A 프리페치(match {}) 실패 — 무시(킥오프 때 풀생성 폴백): {}", matchId, e.toString());
        }
    }

    /**
     * 봇 A(베이스) 프리페치 — <b>매치 없이 봇 id 목록만으로</b>(#402 AC7).
     *
     * <p>리그 시즌이 만들어지는 순간 상대 9팀은 이미 정해져 있는데, A 를 매치 생성 때만 예열하면
     * 더블 라운드로빈의 <b>첫 만남 9번이 전부 풀생성</b>(라이브 19~107초)이고 두 번째 만남만 캐시에
     * 맞는다. 시즌 시작에서 한꺼번에 세워 두면 첫 경기 때 이미 준비돼 있다.
     *
     * <p>멱등: baseId = 덱 재료 해시 + {@code enqueueBase} 가 INSERT OR IGNORE 라 이미 있으면 no-op
     * (AI 콜 0). <b>호출자는 시즌 생성 트랜잭션 바깥에서 부른다</b> — 선실행은 최적화지 정합성
     * 경로가 아니므로 여기서 나는 실패가 시즌 생성을 깨뜨리면 안 된다. 봇 하나가 실패해도 나머지는
     * 계속 세운다(로그만).
     */
    public void prefetchBotBaseInputs(List<String> botIds) {
        for (String botId : botIds) {
            try {
                BotService.BotRow bot = botService.find(botId).orElse(null);
                if (bot == null) {
                    continue;
                }
                PromptContextBuilder.BaseJob base = contextBuilder.botBaseJob(bot);
                jobQueue.enqueueBase(base.baseId(), base.context());
            } catch (Exception e) {
                log.warn("봇 A 프리페치(bot {}) 실패 — 무시(킥오프 때 풀생성 폴백): {}", botId, e.toString());
            }
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

        // #383: 오버레이는 **이 매치가 시작할 때 박힌 값**이다(라이브 조회 아님). h1·h2 가 같은 컬럼을
        // 읽으므로 그 사이 운영이 값을 바꿔도 이 매치는 끝까지 하나의 config 로 돈다.
        JsonNode configOverrides = match.configOverridesJson() == null || match.configOverridesJson().isBlank()
                ? null : matchService.readJson(match.configOverridesJson());

        EngineRunnerClient.SimulateResult result =
                runnerClient.simulate(halfSeed, selectData, homeInput, awayInput, half, resumeState,
                        configOverrides);

        // #383 B3 — 러너가 버린 경로가 있으면 **소리를 낸다**. 조용히 버리면 "설정했는데 아무 일도
        // 안 일어난다"(= #338)가 되고, 400 으로 죽이면 엔진 노브 삭제 한 번이 게임 루프를 세운다.
        // 그 사이가 이것이다 — 매치는 계속 돌고, 사실은 하프 번들과 로그 양쪽에 남는다.
        final String droppedJson =
                result.droppedOverrides() != null && result.droppedOverrides().size() > 0
                        ? result.droppedOverrides().toString() : null;
        if (droppedJson != null) {
            log.warn("match {} half {}: 박힌 계수 오버레이 {}개를 적용하지 못해 버렸습니다(엔진이 그 노브를 "
                            + "지웠거나 타입이 바뀌었습니다). 현재 라이브 리비전도 같은 키를 들고 있다면 "
                            + "PUT /api/admin/engine-config 로 갱신하세요: {}",
                    match.id(), half, result.droppedOverrides().size(), droppedJson);
        }

        JsonNode finalScore = result.matchLog().path("finalScore");
        int scoreHome = finalScore.path("home").asInt();
        int scoreAway = finalScore.path("away").asInt();
        String engineVersion = result.matchLog().path("configVersion").asText("unknown");

        Boolean stored = txRunner.run(() -> {
            try {
                jdbcClient.sql("""
                                INSERT INTO match_halves(match_id, half, select_data_json, home_input_json,
                                                         away_input_json, half_seed, match_log_json,
                                                         resume_state_json, last_hash,
                                                         config_overrides_json, effective_config_hash,
                                                         dropped_overrides_json)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """)
                        .params(match.id(), half, toJson(selectData), homeInputJson, awayInputJson,
                                halfSeed, result.matchLog().toString(),
                                result.resumeState() == null ? null : result.resumeState().toString(),
                                result.lastHash(),
                                // 하프 번들 = **실적**(실제로 이걸로 돌았다). matches.* 는 의도.
                                // 갈라질 수 있으니 따로 적는다 — 갈라진 사실이 보여야 고칠 수 있다.
                                configOverrides == null ? null : configOverrides.toString(),
                                result.effectiveConfigHash(),
                                droppedJson)
                        .update();
            } catch (DataAccessException e) {
                if (SqliteErrors.isUniqueViolation(e)) {
                    return false; // 동시 처리 경합 — 다른 쪽이 이미 저장/전이함
                }
                throw e;
            }

            if (half == 1) {
                enterFirstHalf(match.id(), scoreHome, scoreAway, engineVersion, result.playbackMs());
            } else {
                enterSecondHalf(match, scoreHome, scoreAway, result.playbackMs());
            }
            return true;
        });

        // h2 는 별도 A-잡이 없다(#95): h2 베이스 = h1 최종 인풋 → resolveSide 가 재사용(콜0) 또는
        // 하프타임 프롬프트가 있으면 B 패치로 태운다. 봇 h2 도 재사용(콜0)이라 프리페치할 콜이 없다.
        // 그 해소를 **재개 때가 아니라 전반 진입 직후**에 미리 돌린다(#193 W2b-B2 h2 선행 생성) —
        // 트랜잭션 밖에서(h1 로그 커밋 후) 돌려야 h1InputForSide 가 방금 저장한 인풋을 본다.
        if (half == 1 && Boolean.TRUE.equals(stored)) {
            resolveSecondHalfInputs(match.id());
        }
    }

    /**
     * 전반 인풋 <b>즉시 해소</b> (#193 라운드2). {@code POST /prompts(phase=pre)} 마다 호출된다 —
     * 킥오프를 기다리지 않고 <b>제출한 그 순간</b> h1 잡을 해소해, AI 생성을 "제출~킥오프" 사이(유저가
     * 계속 지시를 쓰는 시간)에 숨긴다. h2 선행 생성({@link #resolveSecondHalfInputs})의 대칭이고,
     * 여러 번 고쳐도 {@link AiJobQueue#supersede} 가 (match,half,side) 유효 잡 1개를 보장한다.
     *
     * <p><b>A(베이스) 미완이면 아무 것도 하지 않는다</b>. 그 상태에서 해소하면 {@link #resolveSide} 가
     * 풀 생성 폴백을 타는데, 편집할 때마다 컨텍스트(=promptHash)가 달라져 <b>편집 횟수만큼 풀 생성</b>이
     * 쌓인다(가장 비싼 잡을, 쓰이지도 않을 수로). 그건 킥오프의 {@link #enqueueHalf} 가 원래대로
     * 소유한다(폴백 불변). 봇 사이드도 같은 이유로 폴백이 필요하면 통째로 미룬다 — 유저 A 만 done 이면
     * 봇은 풀 생성이 되고, 그건 아직 돌고 있는 봇 A 프리페치와 중복 콜이다.
     *
     * <p>킥오프 시 이미 done 이어도 {@code enqueueHalf} 는 그대로 다시 돈다 — 같은 컨텍스트면
     * promptHash 멱등이라 행이 늘지 않고, {@code supersede} 가 같은 잡을 유효로 재확정한다. 브리핑 중
     * 잡이 done 이 돼도 시뮬로 넘어가지 않는다({@link #maybeSimulate} 의 GEN1 state 체크).
     */
    public void resolveFirstHalfInputs(String matchId) {
        try {
            MatchService.MatchRow match = matchService.find(matchId).orElse(null);
            if (match == null || !MatchService.S_BRIEFING.equals(match.state())) {
                return; // 킥오프 이후(GEN1~)는 기존 경로가 소유한다
            }
            JsonNode snapshot = matchService.readJson(match.userDeckJson());
            BotService.BotRow bot = botService.get(match.botId());
            boolean basesReady = doneResultOf(contextBuilder.userBaseJob(match, snapshot).baseId()) != null
                    && doneResultOf(contextBuilder.botBaseJob(match, bot).baseId()) != null;
            if (!basesReady) {
                log.debug("h1 즉시 해소 스킵(match {}) — A 미완, 킥오프 폴백이 소유", matchId);
                return;
            }
            enqueueHalf(matchId, 1);
        } catch (Exception e) {
            log.warn("h1 즉시 해소 실패(match {}) — 무시(킥오프 때 재해소): {}", matchId, e.toString());
        }
    }

    /**
     * 후반 인풋 <b>선행/재해소</b> (#193 W2b-B2). 전반 라이브 진입 직후 한 번(선행 생성), 그리고 전반
     * 재생·감독시간 중 하프타임 지시·교체가 바뀔 때마다 다시 호출된다. 같은 컨텍스트면 promptHash 가
     * 같아 no-op(멱등), 바뀌었으면 새 잡 + {@link AiJobQueue#supersede} 로 옛 결과 무효화.
     *
     * <p>목적은 <b>감독시간 대기 제거</b>다: 재개(GEN2) 시점엔 이미 done 이라 그 자리에서 시뮬한다.
     * 선행 생성된 잡이 done 이어도 GEN2 진입 전에는 시뮬로 넘어가지 않는다({@link #maybeSimulate} 의
     * state 체크). 실패는 삼킨다 — 재개 때 {@link #enqueueHalf} 가 같은 해소를 다시 한다(폴백 불변).
     */
    public void resolveSecondHalfInputs(String matchId) {
        try {
            MatchService.MatchRow match = matchService.find(matchId).orElse(null);
            if (match == null || !MatchService.PRE_SECOND_HALF_STATES.contains(match.state())) {
                return; // 전반 재생/감독시간 밖 — 후반 인풋은 GEN2 경로가 소유한다
            }
            if (halfRow(matchId, 1).isEmpty()) {
                return; // h1 로그 없음(도달 불가) — 선행 해소할 베이스가 없다
            }
            enqueueHalf(matchId, 2);
        } catch (Exception e) {
            log.warn("h2 선행/재해소 실패(match {}) — 무시(재개 때 재해소): {}", matchId, e.toString());
        }
    }

    /**
     * 전반 시뮬 완료 → <b>전반 라이브 재생 창</b> 진입(P4-E2 #170). "킥오프"는 요청 시각이 아니라
     * <b>경기를 실제로 볼 수 있게 된 이 순간</b>이다 — AI 생성이 수 초~수 분 걸리므로 요청 시각을
     * 기준 삼으면 열자마자 전반이 끝나 있다(LLD §2.2).
     *
     * <p>시계가 꺼져 있으면(롤백) 곧바로 감독시간 대기 = 시계 이전 동작(§7.7).
     */
    private void enterFirstHalf(String matchId, int scoreHome, int scoreAway, String engineVersion, long playbackMs) {
        if (!clockService.enabled()) {
            jdbcClient.sql("""
                            UPDATE matches SET state = 'HALFTIME', score_h1_home = ?, score_h1_away = ?,
                                   engine_version = ?
                            WHERE id = ? AND state = 'GEN1'
                            """)
                    .params(scoreHome, scoreAway, engineVersion, matchId)
                    .update();
            return;
        }
        Instant kickoff = clockService.now();
        jdbcClient.sql("""
                        UPDATE matches SET state = 'FIRST_HALF', score_h1_home = ?, score_h1_away = ?,
                               engine_version = ?, kickoff_at = ?, phase_start_at = ?, phase_ends_at = ?
                        WHERE id = ? AND state = 'GEN1'
                        """)
                .params(scoreHome, scoreAway, engineVersion, MatchClockService.format(kickoff),
                        MatchClockService.format(kickoff), clockService.liveWindowEnd(kickoff, playbackMs), matchId)
                .update();
    }

    /**
     * 후반 시뮬 완료 → <b>후반 라이브 재생 창</b> 진입. 정산(스코어 합산·보상·리그·관계)은 이 창이
     * 끝날 때 한다({@link #settleFinishedIfDue}) — 라이브 모델 정합 + 재생 중 스포일러 방지(매니저 R2 결정).
     * 그 사이 후반 스코어는 score_h2_* 에만 보관하고 응답에는 싣지 않는다.
     */
    private void enterSecondHalf(MatchService.MatchRow match, int scoreHome, int scoreAway, long playbackMs) {
        if (!clockService.enabled()) {
            finishMatch(match, scoreHome, scoreAway, MatchService.S_GEN2);
            return;
        }
        Instant start = clockService.now();
        jdbcClient.sql("""
                        UPDATE matches SET state = 'SECOND_HALF', score_h2_home = ?, score_h2_away = ?,
                               phase_start_at = ?, phase_ends_at = ?
                        WHERE id = ? AND state = 'GEN2'
                        """)
                .params(scoreHome, scoreAway, MatchClockService.format(start),
                        clockService.liveWindowEnd(start, playbackMs), match.id())
                .update();
    }

    /**
     * 후반 재생 창 만료 → FINISHED + 정산(MatchClockService 가 호출). 경계값 CAS 라 스위퍼 N개와
     * 지연평가 GET M개가 동시에 들어와도 정확히 1회만 성공한다 = 보상도 1회(AC-M6 멱등 유지).
     *
     * @return 이번 호출이 실제로 종료·정산했으면 true
     */
    public boolean settleFinishedIfDue(String matchId, String boundary) {
        MatchService.MatchRow match = matchService.find(matchId).orElse(null);
        if (match == null || !MatchService.S_SECOND_HALF.equals(match.state())) {
            return false;
        }
        // #492 match_finish — 결과·득점·지급 포인트는 **트랜잭션 안에서만** 정해지므로 값을 sink 로
        // 받아 두고, 기록은 커밋이 끝난 <b>뒤</b>에 한다. 이게 이 웨이브에서 유일한 "커밋 후" 훅이다
        // (다른 6종은 전부 비-tx 경계에 있다).
        // ⚠️ 여기서 events.record 를 람다 **안**으로 옮기면 기록 실패가 정산을 통째로 롤백시킨다 —
        //    보상·리그 픽스처·레이팅·성장까지 같이 되돌아간다. 계약 = BusinessEventHookPlacementTest.
        FinishOutcome[] sink = new FinishOutcome[1];
        boolean settled = Boolean.TRUE.equals(txRunner.run(() ->
                finishMatch(match, nvl(match.scoreH2Home()), nvl(match.scoreH2Away()),
                        MatchService.S_SECOND_HALF, boundary, sink)));
        if (settled && sink[0] != null) {
            FinishOutcome outcome = sink[0];
            eventRecorder.record(BusinessEvent.MATCH_FINISH, match.userId(), () -> Map.of(
                    "mode", outcome.mode(),
                    "matchId", match.id(),
                    "result", outcome.result(),
                    "goalsFor", outcome.goalsFor(),
                    "goalsAgainst", outcome.goalsAgainst(),
                    "pointsAwarded", outcome.pointsAwarded()));
        }
        return settled;
    }

    /**
     * 정산이 <b>실제로 일어났을 때</b>의 결과 — {@code match_finish} 이벤트(#492)의 재료.
     *
     * <p>왜 스냅샷을 따로 나르나: 이 값들은 CAS 를 통과한 트랜잭션 안에서만 확정되는데, 기록은
     * 커밋 후에 해야 한다(위 참조). 커밋 후 DB 를 다시 읽는 방법도 있지만 지급 포인트는 행이 아니라
     * 원장에 흩어져 있어 재조회가 정산 규칙을 <b>두 번째로 구현</b>하게 된다.
     */
    private record FinishOutcome(String mode, String result, int goalsFor, int goalsAgainst,
                                 long pointsAwarded) {
    }

    private boolean finishMatch(MatchService.MatchRow match, int h2ScoreHome, int h2ScoreAway,
                                String fromState) {
        return finishMatch(match, h2ScoreHome, h2ScoreAway, fromState, null);
    }

    private boolean finishMatch(MatchService.MatchRow match, int h2ScoreHome, int h2ScoreAway,
                                String fromState, String boundary) {
        return finishMatch(match, h2ScoreHome, h2ScoreAway, fromState, boundary, null);
    }

    /**
     * FINISHED 전이 트랜잭션 (LLD §5.5, AC-M6): 스코어 합산 → result → CAS → 보상(멱등).
     * CAS가 실패하면(이미 FINISHED) 보상도 건드리지 않는다 + 원장 유니크 인덱스가 이중 방어.
     *
     * <p>{@code fromState} = GEN2(시계 꺼짐: 시뮬 직후 종료) 또는 SECOND_HALF(시계 켜짐: 재생 창 만료).
     * 후자는 {@code boundary}(그 창의 phase_ends_at)까지 CAS 조건에 넣어 경계 재현·경합 안전을 지킨다.
     */
    private boolean finishMatch(MatchService.MatchRow match, int h2ScoreHome, int h2ScoreAway,
                                String fromState, String boundary, FinishOutcome[] sink) {
        // totalHome/totalAway = 엔진(=픽스처) home/away 관점. score_home/away 컬럼도 이 관점으로 저장.
        int totalHome = nvl(match.scoreH1Home()) + h2ScoreHome;
        int totalAway = nvl(match.scoreH1Away()) + h2ScoreAway;
        // result·보상·관계는 유저 관점(어웨이 리그경기면 유저 골=away). 연습/홈경기는 userHome=true 라 불변.
        boolean userHome = userIsHome(match);
        int userGoals = userHome ? totalHome : totalAway;
        int oppGoals = userHome ? totalAway : totalHome;
        String result = userGoals > oppGoals ? "WIN" : userGoals < oppGoals ? "LOSS" : "DRAW";

        int updated = boundary == null
                ? jdbcClient.sql("""
                                UPDATE matches SET state = 'FINISHED', score_home = ?, score_away = ?,
                                       result = ?, finished_at = ?, phase_start_at = NULL, phase_ends_at = NULL
                                WHERE id = ? AND state = ?
                                """)
                        .params(totalHome, totalAway, result, clockService.nowText(), match.id(), fromState)
                        .update()
                : jdbcClient.sql("""
                                UPDATE matches SET state = 'FINISHED', score_home = ?, score_away = ?,
                                       result = ?, finished_at = ?, phase_start_at = NULL, phase_ends_at = NULL
                                WHERE id = ? AND state = ? AND phase_ends_at = ?
                                """)
                        .params(totalHome, totalAway, result, clockService.nowText(), match.id(),
                                fromState, boundary)
                        .update();
        if (updated != 1) {
            return false; // 경합 — 이미 완료 처리됨
        }

        // AC-F2: 리그 매치면 픽스처 정산 + 같은 라운드 봇전 일괄 + 시즌 완료/보상(멱등, LeagueService).
        if ("league".equals(match.mode()) && match.leagueFixtureId() != null) {
            leagueService.settleUserFixture(match.leagueFixtureId(), totalHome, totalAway);
            // #368: 매판 일일 보상 트랙 — 칸은 승패 무관 소비, 지급은 승리에만(내부 멱등).
            // 날짜 앵커는 **종료 시각**이다(생성 시각이 아니다 — 자정을 넘겨 끝난 판이 어제 칸을
            // 먹으면 유저의 오늘 트랙에서 그 판이 사라진다).
            leagueDailyRewardService.settle(match.id(), match.userId(), result, clockService.now());
        }

        // #245: 원정이면 피원정 리포트 + 양쪽 레이팅(±10) 정산. 리그 정산과 같은 자리·같은 규율
        // (FINISHED CAS 통과 후 1회, 내부 멱등). 수비자는 이 경로 말고는 결과를 알 길이 없다.
        if ("away".equals(modeOf(match))) {
            awayService.settle(match.id(), match.userId(), result, userGoals, oppGoals);
            // #408: 원정 데일리 미션 판정 — 원정 정산과 **같은 자리**(FINISHED CAS 통과 후 1회,
            // 내부 멱등). 날짜 앵커는 **종료 시각**이다(생성 시각이면 자정을 넘겨 끝난 판이 어제
            // 미션을 채우고, 유저는 오늘 화면에서 그 판이 사라진 걸 본다).
            // ⚠️ 훅이 **여기에만** 있는 것이 §6.5("포기는 진행도를 올리지 않는다")를 구조적으로
            //    보장한다 — 자발 포기는 forfeitIfVoluntaryAwayAbandon 경로라 finishMatch 를 지나지
            //    않는다. 훅을 awayService.settle 안으로 옮기면 몰수도 세어져 "출전 3회"를 포기
            //    3번으로 클리어할 수 있다(계약 = MissionMatchFlowTest 의 포기 표본).
            missionService.settle(match.id(), match.userId(), result, userGoals, oppGoals,
                    userHome, clockService.now());
        }

        // AC-C4: 관계/사기 변동 — FINISHED 전이 트랜잭션 내 멱등 적용(relations_applied 플래그 CAS).
        relationService.applyMatchResult(match.userId(), match.id(), result);

        // #179 §4 / #405 W2b: 성장 정산 — 기용 선수별 카드 XP 적립 + 레벨업마다 3지선다 선택권
        // (growth_applied PK 멱등). FINISHED CAS 통과 후 1회. 결과(WIN/DRAW/LOSS)가 XP 배율이다.
        settleGrowth(match, result);

        // #212: 보상은 **모드별**(rewards.byMode) — hero 확정 곡선 "연습 적게 < 리그 매판 적당".
        // byMode 에 해당 모드가 없으면 레거시 flat 값으로 폴백한다(구 economy 파일 호환).
        long[] awarded = {0};
        economyService.get().ifPresentOrElse(economy -> {
            // #245 E6: 원정의 돈은 **리그 한 판과 같게**(hero 지시). economy 에 away 키를 새로 만들지
            // 않고 리그 곡선을 **참조**한다 — data/** 는 이 모듈 소유가 아니고, "리그와 같게"는 값
            // 복제가 아니라 참조로 표현해야 값이 바뀔 때 같이 따라간다.
            String rewardMode = "away".equals(modeOf(match)) ? awayRewardMode : modeOf(match);
            int amount = economy.rewards().forMode(rewardMode).by(result);
            String reason = "reward_" + result.toLowerCase();
            walletService.apply(match.userId(), amount, reason, match.id());
            awarded[0] = amount;
        }, () -> log.warn("economy unavailable — match {} finished without reward", match.id()));

        // #405 W2b §2.9: 보상 봉투 — 정산이 <b>끝난 뒤</b> 그 결과를 한 장으로 묶는다(멱등).
        // 표시용이므로 실패해도 정산을 되돌리지 않는다(RewardBundleService 내부에서 삼킨다).
        createRewardBundle(match, awarded[0]);
        // #492: 값만 담아 나간다(쓰기 없음). 실제 기록은 settleFinishedIfDue 가 커밋 후에 한다.
        if (sink != null) {
            sink[0] = new FinishOutcome(modeOf(match), result, userGoals, oppGoals, awarded[0]);
        }
        return true;
    }

    /**
     * 매치 보상 봉투(§2.9) — 재화 섹션 + 성장 섹션. <b>재화는 코드만</b> 싣는다(#232 표기 메타).
     * 성장 섹션의 내용은 {@code growth_applied.report_json} 스냅샷 그대로다 — 여기서 다시 계산하면
     * 화면 둘이 같은 경기를 다르게 말한다.
     */
    private void createRewardBundle(MatchService.MatchRow match, long pointsAwarded) {
        try {
            List<Map<String, Object>> currency = new ArrayList<>();
            if (pointsAwarded != 0) {
                currency.add(RewardBundleService.currency(EconomyService.CURRENCY_POINT, pointsAwarded));
            }
            List<Map<String, Object>> growth = growthService.growthEntries(match.userId(), match.id());
            rewardBundleService.create(match.userId(), RewardBundleService.SOURCE_MATCH, match.id(),
                    List.of(new RewardBundleService.Section(RewardBundleService.KIND_CURRENCY, currency),
                            new RewardBundleService.Section(RewardBundleService.KIND_GROWTH, growth)));
        } catch (RuntimeException e) {
            log.warn("reward bundle 생성 실패 match={}: {}", match.id(), e.toString());
        }
    }

    /**
     * 성장 정산 호출(#179 §4) — 매치 스냅샷 로스터(선발+벤치) + 교체를 GrowthService 에 넘긴다.
     * 멱등은 GrowthService(growth_applied PK)에서 보장 — FINISHED CAS 통과 경로에서만 도달한다.
     */
    private void settleGrowth(MatchService.MatchRow match, String result) {
        try {
            JsonNode snapshot = matchService.readJson(match.userDeckJson());
            List<String> starters = new ArrayList<>();
            List<String> bench = new ArrayList<>();
            snapshot.path("starters").forEach(s -> starters.add(s.path("playerId").asText()));
            snapshot.path("bench").forEach(b -> bench.add(b.path("playerId").asText()));
            Set<String> subsOut = new HashSet<>();
            Set<String> subsIn = new HashSet<>();
            for (MatchService.Substitution sub : parseSubs(match.subsJson())) {
                if (sub.out() != null) {
                    subsOut.add(sub.out());
                }
                if (sub.in() != null) {
                    subsIn.add(sub.in());
                }
            }
            // B2(#179 gverify): 유저 사이드 전달 — 이벤트 귀속을 event.team 으로 필터(봇과 playerId 겹침).
            growthService.settleMatch(match.id(), match.userId(), starters, bench, subsOut, subsIn,
                    userIsHome(match), result);
        } catch (RuntimeException e) {
            // 정산 실패가 매치 완료(보상/전적)를 되돌리지 않게 — 로그만(멱등이라 재정산 가능).
            log.error("growth settlement failed for match {}: {}", match.id(), e.toString());
        }
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
        // 유저팀만 성장·강화 유효스탯 주입(#179 §2·§6) — 봇팀은 원본. 성장 0 카드는 원본과 동일(무회귀).
        Map<String, Object> userTeam = teamRoster(nickname, userRoster, conditions, match.userId(),
                Map.of());
        // #245: 원정 고스트는 덱 JSON 에 **얼려둔** 수비자 유효스탯을 쓴다(AwayService.withFrozenAttributes).
        // 시뮬 시점에 조회하지 않는 이유가 핵심이다 — 수비자는 이 매치에 잠기지 않으므로 조회식이면
        // 전·후반 사이 강화가 후반 스탯만 올린다(#217 이 잠금으로 막는 그 버그). 시드 봇·리그 봇팀엔
        // 이 필드가 없어 그대로 원본이다(무회귀).
        Map<String, Object> botTeam = teamRoster(bot.name(), botRoster, Map.of(), null,
                frozenAttributesOf(matchService.readJson(bot.deckJson())));
        // #252: 봇 강도 배율(디비전 사다리의 미세 노브). **여기가 상대 강도의 유일한 결정 지점**이다 —
        // 엔진은 card.attributes 만 읽으므로(match.ts buildPlayers) 난이도를 엔진 무접촉으로 정할 수 있다.
        // 시드봇·원정 고스트는 1.0 이라 무회귀. 원정 고스트에 배율이 걸리면 실유저 덱을 왜곡하는 셈이라
        // 절대 1.0 이 아니어선 안 된다(AwayService 는 strength_mul 을 쓰지 않는다 = 기본값 유지).
        if (bot.strengthMul() != 1.0) {
            botTeam = withStrengthMultiplier(botTeam, bot.strengthMul());
        }

        // 엔진 home = 픽스처 home_team(어웨이 리그경기면 유저가 away 사이드). homeInput/awayInput 도
        // 같은 사이드 라벨로 enqueue 되므로 selectData.home 팀과 정합.
        boolean userHome = userIsHome(match);
        Map<String, Object> selectData = new LinkedHashMap<>();
        selectData.put("home", userHome ? userTeam : botTeam);
        selectData.put("away", userHome ? botTeam : userTeam);
        return selectData;
    }

    /** 덱 JSON 의 slot.attributes(있으면) → playerId 별 얼린 능력치. 없으면 빈 맵(=원본 사용). */
    private Map<String, Map<String, Object>> frozenAttributesOf(JsonNode deckJson) {
        Map<String, Map<String, Object>> frozen = new LinkedHashMap<>();
        for (String group : List.of("starters", "bench")) {
            for (JsonNode slot : deckJson.path(group)) {
                if (slot.isObject() && slot.path("playerId").isTextual() && slot.path("attributes").isObject()) {
                    Map<String, Object> attrs = new LinkedHashMap<>();
                    slot.get("attributes").fields()
                            .forEachRemaining(e -> attrs.put(e.getKey(),
                                    e.getValue().isNumber() ? e.getValue().numberValue() : e.getValue().asText()));
                    frozen.put(slot.path("playerId").asText(), attrs);
                }
            }
        }
        return frozen;
    }

    /**
     * @param growthUserId 유저팀이면 소유자 userId(성장·강화 유효스탯 주입), 봇팀이면 null(원본 유지).
     * @param frozenAttributes 덱에 얼려둔 능력치(원정 고스트) — 있으면 카탈로그·성장 조회보다 우선한다.
     */
    private Map<String, Object> teamRoster(String name, List<PromptContextBuilder.RosterEntry> roster,
                                           Map<String, Double> conditions, String growthUserId,
                                           Map<String, Map<String, Object>> frozenAttributes) {
        Map<String, Object> team = new LinkedHashMap<>();
        team.put("name", name);
        team.put("players", roster.stream().map(r -> {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("playerId", r.playerId());
            card.put("name", r.name());
            card.put("position", r.position());
            // 성장/강화 유효스탯 → 그 위에 컨디션 배율(주입 순서: 성장 먼저, 컨디션 나중 — §6 통합지점).
            Map<String, Object> frozen = frozenAttributes.get(r.playerId());
            Map<String, Object> attrs = frozen != null
                    ? frozen
                    : growthUserId == null
                            ? r.attributes()
                            : growthService.effectiveAttributes(growthUserId, r.playerId(), r.attributes());
            Double condition = conditions.get(r.playerId());
            card.put("attributes", condition == null ? attrs : scaleAttributes(attrs, condition));
            return card;
        }).toList());
        return team;
    }

    /**
     * 팀 전원의 능력치에 강도 배율(#252). 컨디션과 달리 {@code [minMul,maxMul]} 매핑이 아니라
     * <b>직접 곱</b>이다 — 디비전 표의 {@code strengthMul} 이 그대로 파워비가 되어야 사다리를
     * 파워로 계산할 수 있다(표시 파워 = 실제 파워).
     *
     * <p>클램프 하한이 0 이 아니라 <b>1</b> 인 이유: 능력치 0 은 엔진에서 "값 없음"과 구분되지 않고,
     * 배율은 팀 전체를 약하게 만들려는 것이지 특정 능력치를 소거하려는 것이 아니다.
     */
    private Map<String, Object> withStrengthMultiplier(Map<String, Object> team, double mul) {
        Map<String, Object> scaled = new LinkedHashMap<>(team);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> players = (List<Map<String, Object>>) team.get("players");
        scaled.put("players", players.stream().map(card -> {
            Map<String, Object> copy = new LinkedHashMap<>(card);
            @SuppressWarnings("unchecked")
            Map<String, Object> attrs = (Map<String, Object>) card.get("attributes");
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : attrs.entrySet()) {
                out.put(e.getKey(), e.getValue() instanceof Number n
                        ? Math.max(1, Math.min(100, (int) Math.round(n.doubleValue() * mul)))
                        : e.getValue());
            }
            copy.put("attributes", out);
            return copy;
        }).toList());
        return scaled;
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

    /**
     * 이 (match, half, side) 의 <b>유효 잡</b>이 done 이면 그 결과 — 아니면 비어 있음(=기다린다).
     *
     * <p>"가장 최근 done"(updated_at DESC)이 아니다(#193 검증 B-2). 그 시각은 <b>워커가 언제 보고했나</b>
     * 지 <b>유저가 언제 지시했나</b>가 아니어서, 지시가 바뀐 뒤 늦게 도착한 낡은 잡의 complete 가
     * 최신 지시를 이겼다. 유효 잡은 {@link AiJobQueue#supersede} 가 해소 때마다 정하는 단 한 행이다
     * (effective=1). 그 행이 아직 안 끝났으면 낡은 done 이 있어도 <b>기다린다</b>.
     */
    private Optional<String> latestDoneResult(String matchId, int half, String side) {
        return jdbcClient.sql("""
                        SELECT result_json FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = ? AND status = 'done'
                          AND effective = 1
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
