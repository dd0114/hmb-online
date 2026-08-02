package online.hmb.mission;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.Hashes;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.match.ConditionService;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 원정 데일리 미션 (#408, hero 확정 2026-08-02 — 설계 SoT = {@code docs/plan-v5/away-daily-mission.md}).
 *
 * <p>하루(KST) 2개 · 14종 균등 추첨(중복만 금지) · 전부 <b>원정 경기</b>로만 판정 · 티어별 다이아
 * (쉬움 100 · 보통 200 · 어려움 300) · 미션당 리롤 1회 · <b>미완료는 이월 없음, 달성한 보상은 기한
 * 없이 남는다</b>(§6.3).
 *
 * <h2>이 클래스가 지키는 불변</h2>
 * <ol>
 *   <li><b>리셋 잡이 없다.</b> "오늘"은 항상 KST 현재 날짜로 lazy 계산하고, 그날의 행이 없으면
 *       <b>조회 또는 정산</b> 시점에 만든다. 스위퍼를 두면 서버가 잠깐 죽은 새벽에 조용히 건너뛴다
 *       (§6.1). 추첨이 시드 결정론이라 어느 쪽이 먼저 만들어도 <b>같은 미션 2개</b>가 나온다 —
 *       그래서 "첫 조회"(§6.4)를 "첫 조회 <b>또는</b> 첫 정산"으로 넓혀도 결과가 흔들리지 않는다.
 *       넓히지 않으면 앱을 안 켜고 원정만 친 유저의 진행도가 통째로 사라진다.</li>
 *   <li><b>날짜 앵커는 경기 종료 시각</b>이다(생성 시각이 아니다). 23:58 에 시작해 00:03 에 끝난
 *       경기가 어제 미션을 채우면 유저는 오늘 화면에서 그 판이 사라진 걸 본다 — 이 리포가 같은
 *       종류의 시각 버그에 이미 두 번 당했다(#245).</li>
 *   <li><b>행 하나로 표시·판정·지급이 완결된다.</b> 문구·티어·규칙·목표·금액이 전부 박제라
 *       카탈로그/economy 를 돌려도 오늘 것이 소급 변조되지 않고, 카탈로그에서 사라진 미션의
 *       미수령 보상도 계속 받을 수 있다.</li>
 *   <li><b>포기(ABANDONED)는 진행도를 올리지 않는다</b>(§6.5). 이 서비스는 {@code finishMatch} 의
 *       FINISHED CAS 통과 경로에서만 불린다 — 자발 포기는 그 경로를 아예 지나지 않으므로
 *       "출전 3회"를 포기 3번으로 클리어하는 문이 <b>구조적으로</b> 닫힌다.</li>
 * </ol>
 */
@Service
public class MissionService {

    private static final Logger log = LoggerFactory.getLogger(MissionService.class);

    /**
     * 지급 원장 사유. <b>새 원장을 만들지 않는다</b> — 돈은 {@code gem_ledger} 로 나가고 멱등은
     * {@code uq(user_id, reason, ref_id)} 가 보장한다({@code V33__mailbox.sql} 규율:
     * "왜 다이아가 늘었나"의 답이 두 곳이 되면 안 된다). ref_id = {@code daily_missions.id}.
     */
    public static final String LEDGER_REASON = "daily_mission";

    static final String STATE_IN_PROGRESS = "IN_PROGRESS";
    static final String STATE_COMPLETED = "COMPLETED";
    static final String STATE_CLAIMED = "CLAIMED";

    /** {@code resetAtKst} 표기 — 초까지 고정폭으로 쓴다(ISO_OFFSET_DATE_TIME 은 0초를 생략한다). */
    private static final DateTimeFormatter RESET_AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX");

    private final JdbcClient jdbcClient;
    private final MissionProperties props;
    private final EconomyService economyService;
    private final ConditionService conditionService;
    private final WalletService walletService;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    public MissionService(JdbcClient jdbcClient, MissionProperties props, EconomyService economyService,
                          ConditionService conditionService, WalletService walletService,
                          TxRunner txRunner, ObjectMapper objectMapper, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.props = props;
        this.economyService = economyService;
        this.conditionService = conditionService;
        this.walletService = walletService;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.clock = clock;
    }

    // ── 응답 모양 (클라는 아무것도 계산하지 않는다, §8) ──────────────────

    /**
     * 화면에 나가는 미션 하나. <b>문구·금액·목표·상태·리롤 가능 여부가 전부 완성돼서</b> 내려간다 —
     * 클라가 티어→금액이나 "리롤 남았나"를 다시 계산하면 노브를 돌린 순간 화면이 거짓말한다(#368 규율).
     */
    public record MissionView(String id, String missionId, String title, String tier,
                              String currency, int amount, int progress, int target,
                              String state, boolean rerollable) {
    }

    /**
     * @param pendingClaims <b>지난 날짜</b>의 달성·미수령분. 오늘 것은 여기 없다 — 이미
     *                      {@code missions} 에 {@code state=COMPLETED} 로 있다(중복 금지).
     * @param claimableCount <b>오늘 것만이 아니다</b> — §6.3 대로 달성분은 기한 없이 남으므로 어제·
     *                       그제 미수령분을 합산한다. 안 그러면 홈 한 줄이 "받을 게 없다"고 말하는데
     *                       미션 화면엔 받을 게 있는 상태가 된다.
     *                       <p>⚠️ <b>그 반대 방향이 실제로 터졌다</b>(W3): 합계만 전 기간이고 목록은
     *                       오늘 것뿐이라, 어제 달성하고 안 받은 유저는 홈에서 "받을 보상 1건"을 보는데
     *                       원정 화면엔 받을 카드가 없었다 = §6.3 이 <b>화면에서 도달 불가능</b>했다.
     *                       그래서 이 수는 독립 집계가 아니라 <b>화면이 실제로 그릴 수 있는 것에서
     *                       파생</b>시킨다(아래 {@code daily()}) — 구조적으로 어긋날 수 없게.
     */
    public record DailyView(String day, String resetAtKst, List<MissionView> missions,
                            List<PendingClaim> pendingClaims,
                            int claimableCount, long claimableAmount) {
    }

    /**
     * 지난 날짜에 달성했는데 아직 안 받은 보상 한 건.
     *
     * <p>{@code progress}/{@code target}/{@code rerollable} 이 없다 — 이미 끝난 미션이라 진행도는
     * 의미가 없고, 리롤은 <b>오늘 것만</b> 되기 때문이다(지난 미션은 410 {@code MISSION_EXPIRED}).
     * 수령은 오늘 것과 <b>같은 엔드포인트</b>를 쓴다({@code claim} 은 날짜를 보지 않는다).
     */
    public record PendingClaim(String id, String day, String missionId, String title, String tier,
                               String currency, int amount) {
    }

    /** 수령 결과 — 재화와 금액은 항상 같이 온다(#232). */
    public record ClaimResult(Claimed claimed, Wallet wallet) {

        public record Claimed(String currency, int amount) {
        }

        /** {@code MailService.WalletView} 와 같은 모양 — 수령 응답은 갱신된 잔액을 같이 준다. */
        public record Wallet(long points, long gems) {
        }
    }

    /**
     * 결과 화면의 미션 한 줄 (§8 additive).
     *
     * @param completedNow <b>이 경기로</b> 달성됐다 — 이전에 이미 달성돼 있던 것과 구분한다.
     * @param state {@code IN_PROGRESS|COMPLETED|CLAIMED}. ⚠️ <b>필수 필드다.</b> 없으면 결과 화면이
     *              "지금 받을 수 있나"를 {@code progress >= target} 으로 재계산해야 하고, 그러면
     *              <b>수령한 뒤에도 "받기"가 계속 보인다</b> — 이 설계가 금지한 바로 그 짓이다.
     */
    public record MatchMissionView(String id, String missionId, String title, String tier,
                                   String currency, int amount, int progress, int target,
                                   boolean completedNow, String state) {
    }

    // ── 조회 ────────────────────────────────────────────────────────────

    /** {@code GET /api/missions/daily} — 오늘 미션 2개(없으면 지금 만든다) + 전 기간 미수령 요약. */
    public DailyView daily(String userId) {
        String day = today();
        ensureDay(userId, day);
        List<Row> rows = rowsOf(userId, day);
        List<MissionView> views = new ArrayList<>();
        for (Row row : live(rows)) {
            views.add(toView(row, rerollsUsed(rows, row.slotNo())));
        }
        List<PendingClaim> pending = pendingClaims(userId, day);
        // ⚠️ 합계는 **화면이 그릴 수 있는 것에서 파생**시킨다 — 독립 쿼리로 세면 "홈은 1건이라는데
        // 화면엔 카드가 없다"(또는 그 반대)가 조용히 다시 열린다. 원본이 하나면 어긋날 수 없다.
        int count = pending.size();
        long amount = 0;
        for (PendingClaim p : pending) {
            amount += p.amount();
        }
        for (MissionView v : views) {
            if (STATE_COMPLETED.equals(v.state())) {   // CLAIMED 는 이미 받은 것이라 세지 않는다
                count++;
                amount += v.amount();
            }
        }
        return new DailyView(day, resetAtKst(), views, pending, count, amount);
    }

    // ── 정산(판정) ──────────────────────────────────────────────────────

    /**
     * 원정 경기 한 판이 오늘의 미션들을 민다. {@code MatchOrchestrator.finishMatch} 의
     * <b>FINISHED CAS 통과 이후</b>, 원정 정산({@code awayService.settle}) 바로 옆에서 불린다.
     *
     * <p><b>멱등은 {@code daily_mission_progress} 의 복합 PK</b>(경기 × 미션)가 잡는다. 재정산이
     * 진행도를 두 번 올리면 "출전 3회"가 한 판으로 끝나고, 연승 미션은 값이 부풀어 오른다
     * (#245 가 연승에서 정확히 그 형태로 당했다).
     *
     * @param finishedAt 경기 <b>종료</b> 시각(생성 시각 아님) — 날짜 앵커
     * @param userHome   유저가 엔진 관점의 home 인가. 선제골 판정이 이벤트의 {@code team} 과 대조한다
     * @return 이 경기가 민 미션들(결과 화면용). 기능이 꺼져 있거나 재진입이면 빈 리스트
     */
    public List<MatchMissionView> settle(String matchId, String userId, String result,
                                         int userGoals, int oppGoals, boolean userHome,
                                         Instant finishedAt) {
        String day = conditionService.dateOf(finishedAt);
        ensureDay(userId, day);
        List<Row> rows = live(rowsOf(userId, day));
        if (rows.isEmpty()) {
            return List.of();
        }
        // 매치로그 파싱은 **필요할 때만** 한다(선제골 미션이 안 걸린 날엔 하프 로그를 읽지 않는다).
        Boolean firstGoalOurs = null;
        String now = Instant.now().toString();
        List<MatchMissionView> applied = new ArrayList<>();
        for (Row row : rows) {
            if (row.rule() == MissionRule.FIRST_GOAL && firstGoalOurs == null) {
                firstGoalOurs = scoredFirst(matchId, userHome);
            }
            int before = row.progress();
            int after = row.completedAt() != null
                    ? before   // 달성 후엔 진행도가 움직이지 않는다(연승이 나중 패배로 0 이 되면 안 된다)
                    : advance(row, result, userGoals, oppGoals, Boolean.TRUE.equals(firstGoalOurs));

            int recorded = jdbcClient.sql("""
                            INSERT OR IGNORE INTO daily_mission_progress(
                                match_id, mission_row_id, progress_before, progress_after, created_at)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(matchId, row.id(), before, after, now)
                    .update();
            if (recorded == 0) {
                continue;   // 이 경기 × 이 미션은 이미 반영됐다 — 재진입(멱등)
            }
            if (after != before) {
                // completed_at 은 **여기서만** 찍힌다. `completed_at IS NULL` 가드가 있으므로
                // 이미 달성한 행은 진행도도 달성 시각도 다시 움직이지 않는다.
                jdbcClient.sql("""
                                UPDATE daily_missions
                                   SET progress = ?,
                                       completed_at = CASE WHEN ? >= target THEN ? ELSE NULL END
                                 WHERE id = ? AND completed_at IS NULL
                                """)
                        .params(after, after, now, row.id())
                        .update();
            }
            applied.add(new MatchMissionView(row.id(), row.missionId(), row.title(), row.tier(),
                    row.currency(), row.amount(), after, row.target(),
                    before < row.target() && after >= row.target(),
                    // 방금 UPDATE 한 결과를 반영한다 — row 는 갱신 **전** 스냅샷이라 completed_at 만
                    // 보면 이 경기로 달성된 미션이 IN_PROGRESS 로 나간다.
                    stateOf(row.completedAt() != null || after >= row.target(), row.claimedAt())));
        }
        return applied;
    }

    /** 규칙별 진행도 전이 — {@link MissionRule} 이 그 의미의 SoT 다. */
    private static int advance(Row row, String result, int userGoals, int oppGoals, boolean scoredFirst) {
        boolean win = "WIN".equals(result);
        boolean loss = "LOSS".equals(result);
        return switch (row.rule()) {
            case PLAY -> row.progress() + 1;
            case WIN -> win ? row.progress() + 1 : row.progress();
            // 승 +1 · 패 0 으로 끊김 · **무승부는 유지**(AwayService 통산 연승과 같은 규칙).
            case WIN_STREAK -> win ? row.progress() + 1 : loss ? 0 : row.progress();
            case BEST_MATCH_GOALS -> Math.max(row.progress(), userGoals);
            case CLEAN_WIN -> win && oppGoals == 0 ? row.progress() + 1 : row.progress();
            case BEST_WIN_MARGIN -> Math.max(row.progress(), win ? userGoals - oppGoals : 0);
            case FIRST_GOAL -> scoredFirst ? row.progress() + 1 : row.progress();
        };
    }

    /**
     * 매치로그의 <b>첫 goal 이벤트</b>가 우리 팀인가. {@code GrowthService.eventCountsByPlayer} 가
     * 같은 트랜잭션에서 하는 일과 동형이다(하프 로그를 읽어 {@code team} 으로 귀속).
     *
     * <p>골이 하나도 없으면 false — "선제골"은 득점이 있어야 성립한다.
     */
    private boolean scoredFirst(String matchId, boolean userHome) {
        String ourSide = userHome ? "home" : "away";
        for (int half = 1; half <= 2; half++) {
            String logJson = jdbcClient.sql(
                            "SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                    .params(matchId, half)
                    .query(String.class)
                    .optional()
                    .orElse(null);
            if (logJson == null) {
                continue;
            }
            JsonNode root;
            try {
                root = objectMapper.readTree(logJson);
            } catch (Exception e) {
                log.warn("mission first-goal parse failed for match {} half {}: {}", matchId, half, e.toString());
                continue;
            }
            for (JsonNode event : root.path("events")) {
                if ("goal".equals(event.path("type").asText())) {
                    return ourSide.equals(event.path("team").asText(""));
                }
            }
        }
        return false;
    }

    /**
     * 그 경기가 민 미션들(결과 화면 additive).
     *
     * <p>⚠️ {@code viewerId} 로 <b>반드시</b> 좁힌다. {@code GET /api/matches/{id}/result} 는 원정
     * 수비자에게도 열려 있는데(#245 {@code getViewable}), 좁히지 않으면 <b>공격자의 미션 진행도</b>가
     * 상대에게 그대로 나간다. 관전 권한이 "무엇을 읽느냐"까지 좁혀야 한다는 것이 #245 BL-1 이다.
     */
    public List<MatchMissionView> progressOf(String matchId, String viewerId) {
        return jdbcClient.sql("""
                        SELECT m.id, m.mission_id, m.title, m.tier, m.currency, m.amount, m.target,
                               m.completed_at, m.claimed_at, p.progress_before, p.progress_after
                          FROM daily_mission_progress p
                          JOIN daily_missions m ON m.id = p.mission_row_id
                         WHERE p.match_id = ? AND m.user_id = ?
                         ORDER BY m.slot_no
                        """)
                .params(matchId, viewerId)
                .query((rs, n) -> {
                    int target = rs.getInt("target");
                    int before = rs.getInt("progress_before");
                    int after = rs.getInt("progress_after");
                    return new MatchMissionView(rs.getString("id"), rs.getString("mission_id"),
                            rs.getString("title"), rs.getString("tier"), rs.getString("currency"),
                            rs.getInt("amount"), after, target, before < target && after >= target,
                            stateOf(rs.getString("completed_at") != null, rs.getString("claimed_at")));
                })
                .list();
    }

    // ── 수령 ────────────────────────────────────────────────────────────

    /**
     * 보상 수령. <b>판정 조건이 전부 CAS UPDATE 안에 있다</b>({@code MailService.claim} 규율) —
     * 앞에서 미리 걸러 주면 더블탭 계약이 선검사만 태우고 지나가, CAS 조건을 지워도 스위트가 green 이
     * 된다(#323 독립검증 MAJOR-1). 못 가져간 이유는 행을 <b>다시 읽어</b> 구분한다.
     *
     * <p>멱등은 3층: ① 수령 CAS ② 슬롯 부분 유니크 ③ 원장 {@code uq(user_id, reason, ref_id)}.
     */
    public ClaimResult claim(String userId, String missionRowId) {
        String now = Instant.now().toString();
        Boolean took = txRunner.run(() -> {
            int taken = jdbcClient.sql("""
                            UPDATE daily_missions SET claimed_at = ?
                             WHERE id = ? AND user_id = ?
                               AND completed_at IS NOT NULL AND claimed_at IS NULL
                               AND rerolled_at IS NULL
                            """)
                    .params(now, missionRowId, userId)
                    .update();
            if (taken == 0) {
                return false;
            }
            Row row = require(userId, missionRowId);
            if (!walletService.applyGems(userId, row.amount(), LEDGER_REASON, row.id())) {
                // 상태는 새로 넘어갔는데 원장엔 이미 있었다 = 두 층이 어긋난 상태. 돈은 안 샜지만
                // (원장이 막았다) 조용히 넘기면 원인을 영영 모른다(#368 과 같은 자리).
                log.warn("daily mission ledger already had an entry for mission {} (user {})",
                        missionRowId, userId);
            }
            return true;
        });

        Row row = require(userId, missionRowId);
        if (!Boolean.TRUE.equals(took)) {
            if (row.claimedAt() != null) {
                throw new ApiException(HttpStatus.CONFLICT, "MISSION_ALREADY_CLAIMED",
                        "이미 받은 보상입니다");
            }
            throw new ApiException(HttpStatus.CONFLICT, "MISSION_NOT_COMPLETED",
                    "아직 달성하지 않은 미션입니다",
                    Map.of("progress", row.progress(), "target", row.target()));
        }
        return new ClaimResult(new ClaimResult.Claimed(row.currency(), row.amount()),
                new ClaimResult.Wallet(walletService.points(userId), walletService.gems(userId)));
    }

    // ── 리롤 ────────────────────────────────────────────────────────────

    /**
     * 미션 교체 — 슬롯당 {@code reroll-per-slot} 회, <b>전체 풀에서</b> 재추첨(보유 중인 것 제외),
     * 진행도는 0 부터 다시. 이미 달성한 미션은 리롤할 수 없다(보상만 챙기고 새 미션을 받는 무한
     * 루프가 된다, §6.2).
     *
     * <p><b>제자리 UPDATE 가 아니라 은퇴 + 새 행</b>이다 — 진행도 원장이 가리키는 행의 미션이 사후에
     * 바뀌면 지난 경기의 결과 화면이 "그 경기가 밀지도 않은 미션"을 그린다.
     *
     * <p>"쉬운 걸로 갈아타는 어뷰징"은 성립하지 않는다: 보상이 티어에 비례하므로 어려운 미션을 굴려
     * 쉬운 걸 뽑으면 받는 다이아가 같이 줄어든다. 리롤은 이득이 아니라 <b>달성 가능성 ↔ 보상</b>의 선택이다.
     */
    public MissionView reroll(String userId, String missionRowId) {
        String day = today();
        Row row = require(userId, missionRowId);
        if (row.rerolledAt() != null || !day.equals(row.day())) {
            // 지난 날짜의 미션은 교체 대상이 아니다(그날은 이미 끝났다). 남은 것은 수령뿐이다.
            throw new ApiException(HttpStatus.GONE, "MISSION_EXPIRED",
                    "지난 미션은 교체할 수 없습니다");
        }
        if (row.completedAt() != null) {
            throw new ApiException(HttpStatus.CONFLICT, "MISSION_ALREADY_COMPLETED",
                    "이미 달성한 미션은 교체할 수 없습니다");
        }
        List<Row> all = rowsOf(userId, day);
        if (rerollsUsed(all, row.slotNo()) >= props.getRerollPerSlot()) {
            throw new ApiException(HttpStatus.CONFLICT, "MISSION_REROLL_USED",
                    "이 미션은 이미 한 번 교체했습니다");
        }
        Set<String> held = new HashSet<>();
        for (Row r : live(all)) {
            held.add(r.missionId());   // 보유 중인 것(자기 자신 포함)과 중복 추첨 금지
        }
        List<MissionProperties.Entry> candidates = new ArrayList<>();
        for (MissionProperties.Entry e : props.getCatalog()) {
            if (!held.contains(e.getId())) {
                candidates.add(e);
            }
        }
        if (candidates.isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT, "MISSION_REROLL_UNAVAILABLE",
                    "교체할 수 있는 미션이 없습니다");
        }

        String now = Instant.now().toString();
        MissionProperties.Entry picked = pick(
                userId + ":" + day + ":slot" + row.slotNo() + ":reroll" + rerollsUsed(all, row.slotNo()),
                candidates);
        String newId = txRunner.run(() -> {
            int retired = jdbcClient.sql("""
                            UPDATE daily_missions SET rerolled_at = ?
                             WHERE id = ? AND user_id = ? AND rerolled_at IS NULL AND completed_at IS NULL
                            """)
                    .params(now, missionRowId, userId)
                    .update();
            if (retired == 0) {
                return null;   // 경합 — 다른 요청이 먼저 교체했다
            }
            return insert(userId, day, row.slotNo(), picked, now);
        });
        if (newId == null) {
            throw new ApiException(HttpStatus.CONFLICT, "MISSION_REROLL_USED",
                    "이 미션은 이미 한 번 교체했습니다");
        }
        List<Row> after = rowsOf(userId, day);
        Row fresh = require(userId, newId);
        return toView(fresh, rerollsUsed(after, fresh.slotNo()));
    }

    // ── 생성(추첨) ──────────────────────────────────────────────────────

    /**
     * 그날의 미션이 없으면 지금 만든다(§6.1 lazy — 리셋 잡을 만들지 않는 이유가 여기 있다).
     *
     * <p>추첨은 <b>시드 결정론</b>({@code sha256(userId:day:slotN)}) 이라 "왜 이 미션이 나왔나"를
     * 재현할 수 있고, 조회와 정산 중 무엇이 먼저 이 함수를 부르든 같은 두 미션이 나온다.
     * {@code Math.random}·{@code ThreadLocalRandom} 은 쓰지 않는다.
     */
    private void ensureDay(String userId, String day) {
        int count = Math.min(props.getCount(), props.getCatalog().size());
        if (count <= 0) {
            return;   // 롤백 스위치(count=0) 또는 빈 카탈로그 = 새 미션을 만들지 않는다
        }
        List<Row> existing = live(rowsOf(userId, day));
        if (existing.size() >= count) {
            return;
        }
        Set<Integer> filled = new HashSet<>();
        Set<String> held = new HashSet<>();
        for (Row r : existing) {
            filled.add(r.slotNo());
            held.add(r.missionId());
        }
        String now = Instant.now().toString();
        List<MissionProperties.Entry> remaining = new ArrayList<>();
        for (MissionProperties.Entry e : props.getCatalog()) {
            if (!held.contains(e.getId())) {
                remaining.add(e);
            }
        }
        for (int slotNo = 1; slotNo <= count; slotNo++) {
            if (filled.contains(slotNo) || remaining.isEmpty()) {
                continue;
            }
            MissionProperties.Entry picked = pick(userId + ":" + day + ":slot" + slotNo, remaining);
            remaining.remove(picked);
            insert(userId, day, slotNo, picked, now);
        }
    }

    /**
     * @return 새 행 id. 슬롯이 이미 차 있으면(동시 조회 경합) 기존 행 id — 부분 유니크 인덱스가 SoT 다.
     */
    private String insert(String userId, String day, int slotNo, MissionProperties.Entry entry, String now) {
        String id = Ulid.next();
        // 금액은 **박제**한다. 지금 economy 를 읽어 두면 노브를 돌리는 순간 오늘 이미 받은 이력이
        // 소급 변조된다(#368 규율). 접근자는 economy 파일이 없어도 값을 준다(override 트랩).
        int amount = economyService.dailyMissionReward().amountFor(entry.getTier());
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO daily_missions(
                            id, user_id, day, slot_no, mission_id, title, tier, rule, currency,
                            amount, target, progress, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                        """)
                .params(id, userId, day, slotNo, entry.getId(), entry.getTitle(), entry.getTier(),
                        entry.getRule().name(), CURRENCY, amount, entry.getTarget(), now)
                .update();
        if (inserted == 1) {
            return id;
        }
        log.warn("daily mission slot {} for user {} day {} was filled concurrently", slotNo, userId, day);
        return jdbcClient.sql("""
                        SELECT id FROM daily_missions
                         WHERE user_id = ? AND day = ? AND slot_no = ? AND rerolled_at IS NULL
                        """)
                .params(userId, day, slotNo)
                .query(String.class)
                .single();
    }

    /**
     * 시드 결정론 추첨 — {@code sha256(seed)} 앞 15 hex(60bit) 를 후보 수로 나눈 나머지.
     * {@code UserOnboardingService.pickStarterTop} 과 같은 계열이다(시계·전역 난수 없음).
     */
    private static MissionProperties.Entry pick(String seed, List<MissionProperties.Entry> candidates) {
        long v = Long.parseLong(Hashes.sha256Hex(seed).substring(0, 15), 16);
        return candidates.get((int) (v % candidates.size()));
    }

    // ── 내부 ────────────────────────────────────────────────────────────

    /**
     * 보상 재화. hero 요구 원문이 <b>"보상은 전부 다이아"</b> 라 노브가 아니다 — 노브로 두면 지급
     * 분기가 하나 늘고 그 분기엔 계약이 없다(#368 의 POINT 분기가 그 상태다). 재화를 바꾸는 것은
     * 값을 돌리는 일이 아니라 축을 새로 설계하는 일이고, 그때 이 상수가 먼저 눈에 띈다.
     * 금액과 함께 응답·행에 항상 실린다(#232).
     */
    private static final String CURRENCY = EconomyService.CURRENCY_GEM;

    private record Row(String id, String userId, String day, int slotNo, String missionId, String title,
                       String tier, MissionRule rule, String currency, int amount, int target,
                       int progress, String completedAt, String claimedAt, String rerolledAt) {
    }

    private static final String COLUMNS = """
            id, user_id, day, slot_no, mission_id, title, tier, rule, currency, amount, target,
            progress, completed_at, claimed_at, rerolled_at
            """;

    private static Row map(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Row(rs.getString("id"), rs.getString("user_id"), rs.getString("day"),
                rs.getInt("slot_no"), rs.getString("mission_id"), rs.getString("title"),
                rs.getString("tier"), MissionRule.valueOf(rs.getString("rule")), rs.getString("currency"),
                rs.getInt("amount"), rs.getInt("target"), rs.getInt("progress"),
                rs.getString("completed_at"), rs.getString("claimed_at"), rs.getString("rerolled_at"));
    }

    /** 그날의 <b>모든</b> 행(은퇴 포함) — 리롤 소진 여부를 은퇴 행 수로 세기 때문에 같이 읽는다. */
    private List<Row> rowsOf(String userId, String day) {
        return jdbcClient.sql("SELECT " + COLUMNS
                        + " FROM daily_missions WHERE user_id = ? AND day = ? ORDER BY slot_no, created_at")
                .params(userId, day)
                .query((rs, n) -> map(rs))
                .list();
    }

    private static List<Row> live(List<Row> rows) {
        List<Row> out = new ArrayList<>();
        for (Row r : rows) {
            if (r.rerolledAt() == null) {
                out.add(r);
            }
        }
        return out;
    }

    private static int rerollsUsed(List<Row> rows, int slotNo) {
        int used = 0;
        for (Row r : rows) {
            if (r.slotNo() == slotNo && r.rerolledAt() != null) {
                used++;
            }
        }
        return used;
    }

    private Row require(String userId, String missionRowId) {
        return find(userId, missionRowId).orElseThrow(() ->
                // 남의 미션과 없는 미션의 응답이 같다 — id 실재가 새어 나가지 않게(#297·#323 규율).
                ApiException.notFound("미션을 찾을 수 없습니다"));
    }

    private Optional<Row> find(String userId, String missionRowId) {
        return jdbcClient.sql("SELECT " + COLUMNS + " FROM daily_missions WHERE id = ? AND user_id = ?")
                .params(missionRowId, userId)
                .query((rs, n) -> map(rs))
                .optional();
    }

    private MissionView toView(Row row, int rerollsUsed) {
        String state = stateOf(row.completedAt() != null, row.claimedAt());
        // 리롤 가능 여부는 **서버 판단**이다 — 클라가 "1회 소진·달성 여부"를 추론하면 규칙이 바뀔 때
        // 조용히 어긋난다(§8).
        boolean rerollable = row.completedAt() == null && rerollsUsed < props.getRerollPerSlot();
        return new MissionView(row.id(), row.missionId(), row.title(), row.tier(), row.currency(),
                row.amount(), row.progress(), row.target(), state, rerollable);
    }

    /**
     * <b>지난 날짜</b>의 달성·미수령분(오래된 것부터). 오늘 것은 {@code missions} 가 이미 싣고 있다.
     *
     * <p>⚠️ {@code day < today} 의 문자열 비교는 여기서만 안전하다 — {@code day} 는 <b>고정폭</b>
     * {@code yyyy-MM-dd} 라 사전순 = 시간순이다. ISO <b>타임스탬프</b>를 문자열로 비교하면 소수초가
     * 붙은 값이 안 붙은 값보다 작게 정렬돼 어긋난다(#245 가 겪은 함정) — 그건 이 컬럼 얘기가 아니다.
     */
    private List<PendingClaim> pendingClaims(String userId, String today) {
        return jdbcClient.sql("""
                        SELECT id, day, mission_id, title, tier, currency, amount
                          FROM daily_missions
                         WHERE user_id = ? AND day < ?
                           AND completed_at IS NOT NULL AND claimed_at IS NULL
                           AND rerolled_at IS NULL
                         ORDER BY day, slot_no
                        """)
                .params(userId, today)
                .query((rs, n) -> new PendingClaim(rs.getString("id"), rs.getString("day"),
                        rs.getString("mission_id"), rs.getString("title"), rs.getString("tier"),
                        rs.getString("currency"), rs.getInt("amount")))
                .list();
    }

    /** 상태 판정의 유일한 자리 — 조회·정산·결과 화면이 같은 규칙을 쓴다(두 곳에 적으면 갈라진다). */
    private static String stateOf(boolean completed, String claimedAt) {
        return claimedAt != null ? STATE_CLAIMED : completed ? STATE_COMPLETED : STATE_IN_PROGRESS;
    }

    /** 오늘(KST) — 주입된 Clock 존이 SoT 다({@code hmb.match.condition.zone}). */
    private String today() {
        return conditionService.dateOf(clock.instant());
    }

    /**
     * 다음 KST 자정 — 화면의 "자정에 초기화" 문구용. <b>클라가 계산하지 않는다</b>(존을 클라에 적으면
     * 서버가 존을 바꾸는 날 화면만 어긋난다).
     */
    private String resetAtKst() {
        return LocalDate.now(clock).plusDays(1).atStartOfDay(clock.getZone()).format(RESET_AT);
    }
}
