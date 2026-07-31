package online.hmb.league;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.catalog.EconomyService;
import online.hmb.catalog.EconomyService.LeagueDailyReward;
import online.hmb.match.ConditionService;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 리그 매판 일일 보상 트랙 (#368, hero 확정 2026-07-31).
 *
 * <p><b>칸 = 그날(KST) 치른 리그 경기의 순번.</b> 승·무·패와 무관하게 소비되고, <b>지급은 승리에만</b>
 * 이다 — 진 판은 그 칸 보상이 소멸한다. 하루 {@code slotsPerDay}(18)칸을 다 쓰면 자정까지 트랙 보상이
 * 없다(경기 자체와 기존 모드별 경기 보상 #212 는 그대로 굴러간다 — <b>두 보상은 별개 축으로 얹힌다</b>).
 *
 * <p><b>왜 새 지급 경로를 만들지 않았나</b>: 지갑·원장은 {@link WalletService} 가 이미 소유하고 멱등도
 * 거기 유니크 인덱스가 보장한다. 여기서 하는 일은 <b>어느 칸이 얼마짜리인지 정하고 박제하는 것</b>뿐이다.
 *
 * <p><b>날짜 경계 = KST 자정</b>({@link ConditionService#dateOf}). #245 원정 일일제한이 같은 기준을 쓰고,
 * 그 세션은 <b>날짜를 문자열로 비교하다 UTC 자정이 경계가 되는 버그를 두 번</b> 잡혔다. 여기서도 날짜는
 * 항상 존을 살린 인스턴트에서 파생한다.
 */
@Service
public class LeagueDailyRewardService {

    private static final Logger log = LoggerFactory.getLogger(LeagueDailyRewardService.class);

    /** 원장 사유 — 통화별로 갈린다(#251 의 league_gem_reward 와 같은 명명 규율). */
    public static final String LEDGER_REASON_GEM = "league_daily_gem";
    public static final String LEDGER_REASON_POINT = "league_daily_point";

    private final JdbcClient jdbcClient;
    private final WalletService walletService;
    private final EconomyService economyService;
    private final ConditionService conditionService;

    public LeagueDailyRewardService(JdbcClient jdbcClient, WalletService walletService,
                                    EconomyService economyService, ConditionService conditionService) {
        this.jdbcClient = jdbcClient;
        this.walletService = walletService;
        this.economyService = economyService;
        this.conditionService = conditionService;
    }

    /**
     * 박제된 한 칸 — 지난 칸(소비됨)의 진실.
     *
     * <p>{@code big} 이 여기 있는 이유는 {@code amount} 와 같다: 읽을 때 지금 config 로 재계산하면
     * 노브를 돌린 순간 <b>이미 지나간 칸</b>의 표시가 소급 변조된다(독립검증 minor-2).
     */
    public record SlotRow(int slotNo, String currency, int amount, boolean big, String result,
                          boolean awarded, String opponentName) {
    }

    /** 화면에 나가는 한 칸 — 지난 칸이면 {@code state} 가 WON/MISSED, 앞으로 칠 칸이면 PENDING. */
    public record TrackSlot(int slotNo, String currency, int amount, boolean big, String state,
                            String opponentName) {
    }

    /**
     * FINISHED 리그 매치 한 판의 칸을 소비하고, <b>승리면</b> 지급한다.
     *
     * <p>호출 위치는 {@code MatchOrchestrator.finishMatch} 의 <b>FINISHED CAS 통과 이후</b> —
     * 리그 픽스처 정산·원정 정산·성장 정산과 같은 자리다(CAS 통과 후 1회, 내부 멱등).
     *
     * @param finishedAt 매치 <b>종료</b> 시각. 생성 시각이 아니다 — 23:58 에 시작해 00:03 에 끝난 경기가
     *                   어제 칸을 먹으면 유저의 오늘 트랙에서 그 판이 사라진다.
     * @return 이번에 소비한 칸(이미 정산된 매치면 {@code empty} — 재진입 시 아무 일도 일어나지 않는다)
     */
    public Optional<SlotRow> settle(String matchId, String userId, String result, Instant finishedAt) {
        String day = conditionService.dateOf(finishedAt);
        // 상대 팀명은 **그때의 값을 박제**한다(표시용 스냅샷). 봇 행은 시즌마다 새로 생기므로 나중에
        // 조인해 만들면 지난 트랙의 상대가 조용히 바뀌거나 사라진다.
        String opponentName = opponentNameOf(matchId);
        LeagueDailyReward config = economyService.leagueDailyReward();

        int slotNo = nextSlotNo(userId, day);
        int amount = config.amountFor(slotNo);   // 트랙 밖(18칸 초과)이면 0
        boolean big = config.isBig(slotNo);
        boolean win = "WIN".equals(result);
        boolean awarded = win && amount > 0;

        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO league_daily_rewards(match_id, user_id, day, slot_no,
                                currency, amount, result, awarded, big, opponent_name, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(matchId, userId, day, slotNo, config.currency(), amount, result,
                        awarded ? 1 : 0, big ? 1 : 0, opponentName, Instant.now().toString())
                .update();
        if (inserted == 0) {
            // ⚠️ `OR IGNORE` 는 **두 유니크 제약을 구분하지 못한다**(독립검증 minor-3):
            //   ① match_id PK 충돌 = 정상 재진입(멱등, 조용히 끝내는 게 맞다)
            //   ② uq(user_id, day, slot_no) 충돌 = nextSlotNo 가 같은 칸을 두 매치에 팔았다
            // ②는 **승리한 유저가 보상을 못 받고 행도 안 남는** 상태다. 도달성은 낮지만
            // (유저당 활성 매치 1 + SQLite 단일 writer + UPDATE 가 먼저 잠금을 잡는 순서) 조용히
            // 넘기면 원인을 영영 모른다 — 원장 불일치 쪽에만 있던 경고를 이쪽에도 남긴다.
            if (slotOfMatch(matchId).isEmpty()) {
                log.warn("league daily reward slot collision — user {} day {} slot {} lost to another "
                        + "match (match {} got no row)", userId, day, slotNo, matchId);
            }
            return Optional.empty();   // 이미 정산됨 — 멱등(재진입해도 칸이 더 소비되지 않는다)
        }

        if (awarded) {
            // 지급은 **기존 지갑·원장 경로**로만 — 멱등은 uq(user_id, reason, ref_id)가 보장한다.
            boolean applied = EconomyService.CURRENCY_GEM.equals(config.currency())
                    ? walletService.applyGems(userId, amount, LEDGER_REASON_GEM, matchId)
                    : walletService.apply(userId, amount, LEDGER_REASON_POINT, matchId);
            if (!applied) {
                // 행은 새로 생겼는데 원장엔 이미 있었다 = 두 층이 어긋난 상태. 돈은 안 샜지만(원장이
                // 막았다) 조용히 넘기면 원인을 영영 모른다.
                log.warn("league daily reward ledger already had an entry for match {} (user {}, slot {})",
                        matchId, userId, slotNo);
            }
        }
        return Optional.of(
                new SlotRow(slotNo, config.currency(), amount, big, result, awarded, opponentName));
    }

    /** 그 매치 상대 봇의 이름. 없으면 null(표시가 없을 뿐 트랙은 성립한다). */
    private String opponentNameOf(String matchId) {
        return jdbcClient.sql("""
                        SELECT b.name FROM matches m JOIN bots b ON b.id = m.bot_id WHERE m.id = ?
                        """)
                .param(matchId)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    /** 그날 다음 칸 번호(1-based). 칸은 트랙 상한을 넘어서도 계속 세어진다 — 상한 판정은 금액이 한다. */
    private int nextSlotNo(String userId, String day) {
        return jdbcClient.sql("""
                        SELECT COALESCE(MAX(slot_no), 0) + 1 FROM league_daily_rewards
                        WHERE user_id = ? AND day = ?
                        """)
                .params(userId, day)
                .query(Integer.class)
                .single();
    }

    /** 오늘 소비한 칸 전부(순번 오름차순). */
    public List<SlotRow> slotsOf(String userId, String day) {
        return jdbcClient.sql("""
                        SELECT slot_no, currency, amount, big, result, awarded, opponent_name
                        FROM league_daily_rewards
                        WHERE user_id = ? AND day = ?
                        ORDER BY slot_no
                        """)
                .params(userId, day)
                .query((rs, n) -> new SlotRow(rs.getInt("slot_no"), rs.getString("currency"),
                        rs.getInt("amount"), rs.getInt("big") == 1, rs.getString("result"),
                        rs.getInt("awarded") == 1, rs.getString("opponent_name")))
                .list();
    }

    /** 그 매치가 소비한 칸(결과 화면용). 리그 매치가 아니거나 미정산이면 empty. */
    public Optional<SlotRow> slotOfMatch(String matchId) {
        return jdbcClient.sql("""
                        SELECT slot_no, currency, amount, big, result, awarded, opponent_name
                        FROM league_daily_rewards WHERE match_id = ?
                        """)
                .param(matchId)
                .query((rs, n) -> new SlotRow(rs.getInt("slot_no"), rs.getString("currency"),
                        rs.getInt("amount"), rs.getInt("big") == 1, rs.getString("result"),
                        rs.getInt("awarded") == 1, rs.getString("opponent_name")))
                .optional();
    }

    /**
     * 오늘의 트랙 전체(화면이 그대로 그리는 배열) — 지난 칸은 결과가, 남은 칸은 예정 상대가 붙는다.
     *
     * <p><b>클라가 주기·대량 위치·금액을 다시 계산하지 않게 서버가 통째로 만든다</b>(#262 컷 규율).
     * 전부 economy 노브라 언제든 바뀌고, 복제하면 "9번째가 대박"이라 칠해 놓고 아무 일도 안 일어나는
     * 화면이 된다.
     *
     * @param upcomingOpponents 앞으로 칠 상대 이름(가까운 순). 모자라면 그 칸의 상대는 {@code null}
     *                          이다 — 시즌이 끝났거나 잔여 일정이 트랙보다 짧으면 정상이다.
     */
    public Track trackOf(String userId, String day, List<String> upcomingOpponents) {
        LeagueDailyReward config = economyService.leagueDailyReward();
        Map<Integer, SlotRow> played = new LinkedHashMap<>();
        for (SlotRow row : slotsOf(userId, day)) {
            played.put(row.slotNo(), row);
        }
        int consumed = played.keySet().stream().mapToInt(Integer::intValue).max().orElse(0);

        List<TrackSlot> slots = new ArrayList<>();
        int upcomingCursor = 0;
        for (int slotNo = 1; slotNo <= config.slotsPerDay(); slotNo++) {
            SlotRow row = played.get(slotNo);
            if (row != null) {
                // 지난 칸은 **행이 진실**이다 — config.isBig 로 다시 계산하면 노브를 돌린 순간
                // 이미 받은 칸의 스타일·라벨이 소급 변조된다(minor-2).
                slots.add(new TrackSlot(slotNo, row.currency(), row.amount(), row.big(),
                        row.awarded() ? "WON" : "MISSED", row.opponentName()));
                continue;
            }
            String opponent = upcomingCursor < upcomingOpponents.size()
                    ? upcomingOpponents.get(upcomingCursor++)
                    : null;
            slots.add(new TrackSlot(slotNo, config.currency(), config.amountFor(slotNo),
                    config.isBig(slotNo), "PENDING", opponent));
        }

        // 다음 칸 = 소비분 바로 다음. 트랙을 다 썼으면 null 이다("오늘 18칸 모두 사용").
        TrackSlot next = config.within(consumed + 1) ? slots.get(consumed) : null;
        long earned = played.values().stream().filter(SlotRow::awarded).mapToLong(SlotRow::amount).sum();
        long awardedCount = played.values().stream().filter(SlotRow::awarded).count();

        return new Track(day, config.slotsPerDay(), consumed, (int) awardedCount, earned,
                config.currency(), slots, next);
    }

    /**
     * 오늘의 트랙 응답.
     *
     * @param consumed 오늘 소비한 칸 수(= 오늘 친 리그 경기 수). 트랙 상한을 넘길 수 있다.
     * @param awardedCount 그중 실제로 받은 횟수 — 화면 헤더가 말하는 "오늘 n회 받음".
     * @param earned 오늘 받은 총액.
     * @param next 다음에 열릴 칸. 다 썼으면 {@code null}.
     */
    public record Track(String day, int slotsPerDay, int consumed, int awardedCount, long earned,
                        String currency, List<TrackSlot> slots, TrackSlot next) {
    }
}
