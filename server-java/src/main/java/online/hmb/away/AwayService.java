package online.hmb.away;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.Hashes;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.growth.GrowthService;
import online.hmb.match.MatchService;
import online.hmb.match.PromptContextBuilder;
import online.hmb.meta.DeckService;
import online.hmb.meta.DeckSnapshot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 원정(#245) — <b>실유저 팀을 상대로 하는 비동기 대전</b>과 그 피침공 기록.
 *
 * <p><b>왜 이렇게 붙는가</b>(W1 실사 결론): 이 서버에는 "한 유저의 팀이 남의 상대가 되는" 경로가
 * 애초에 없었다 — {@code matches.bot_id} 는 {@code bots} FK 이고 bots 의 출처는 시드 3종과 리그가
 * 생성한 봇팀뿐이다. 그래서 새 대전 파이프라인을 만드는 대신 <b>리그가 이미 쓰는 패턴</b>을 그대로
 * 쓴다: 리그가 생성 팀을 bots 행으로 구워 물리듯, 원정은 <b>수비자의 덱 스냅샷</b>을 bots 행으로
 * 굽는다. 덕분에 매치 생성·AI 잡·시뮬·정산 파이프라인은 한 줄도 바뀌지 않는다.
 *
 * <p>공짜로 따라오는 것 하나: {@code PromptContextBuilder.buildBotContext} 는 봇 덱 JSON 의
 * {@code promptText} 를 이미 읽는다 → <b>수비자가 써둔 선수별 지시가 그대로 상대의 AI 인풋</b>이
 * 된다. 이 게임의 핵심(선수별 자연어 프롬프트)이 원정에서도 살아 있는 이유다.
 *
 * <p><b>고스트는 덱 해시로 박제한다</b>(bot id = {@code GHOST_<userId>_<deckHash12>}). 덱이 바뀌면
 * 같은 행을 덮는 게 아니라 <b>새 행</b>이 생긴다 — 시뮬은 매 하프 시작 시 봇 덱을 다시 읽으므로,
 * 덮어썼다면 진행 중인 매치의 상대가 전·후반 사이에 바뀌고 재생·재현이 깨진다.
 */
@Service
public class AwayService {

    private static final Logger log = LoggerFactory.getLogger(AwayService.class);

    /** 원정 매치의 상대는 항상 이 접두를 가진 bots 행이다(시드 봇·리그 봇팀과 구분). */
    private static final String GHOST_PREFIX = "GHOST_";

    static final String REASON_ATTACK = "away_attack";
    static final String REASON_DEFENSE = "away_defense";

    private final JdbcClient jdbcClient;
    private final MatchService matchService;
    private final DeckService deckService;
    private final DeckSnapshot deckSnapshot;
    private final RatingService ratingService;
    private final GrowthService growthService;
    private final PromptContextBuilder contextBuilder;
    private final ObjectMapper objectMapper;
    private final TxRunner txRunner;
    private final SecureRandom secureRandom = new SecureRandom();

    private final int ratingWin;
    private final int ratingDraw;
    private final int ratingLoss;
    private final int reportListLimit;
    private final AwaySeasonService seasonService;
    private final online.hmb.meta.WalletService walletService;
    private final online.hmb.catalog.EconomyService economyService;
    private final int candidateCount;
    private final int ratingBand;
    private final int offerTtlSec;
    private final int dailyLimit;
    private final java.time.Clock clock;
    private final int streakBonusPerWin;
    private final int streakMaxBonus;
    private final String rewardMode;
    private final boolean defenderRewardOnLoss;
    private final int revengeAttemptsMax;
    private final int revengeQueueSize;
    /** 상대 후보 자격(#296) — 한 판이라도 끝낸 유저만 고스트로 선다. */
    private final online.hmb.eligibility.EligibilityService eligibility;

    public AwayService(JdbcClient jdbcClient,
                       MatchService matchService,
                       DeckService deckService,
                       DeckSnapshot deckSnapshot,
                       RatingService ratingService,
                       GrowthService growthService,
                       PromptContextBuilder contextBuilder,
                       ObjectMapper objectMapper,
                       TxRunner txRunner,
                       @Value("${hmb.away.rating.win}") int ratingWin,
                       @Value("${hmb.away.rating.draw}") int ratingDraw,
                       @Value("${hmb.away.rating.loss}") int ratingLoss,
                       AwaySeasonService seasonService,
                       online.hmb.meta.WalletService walletService,
                       online.hmb.catalog.EconomyService economyService,
                       @Value("${hmb.away.report-list-limit}") int reportListLimit,
                       @Value("${hmb.away.match.candidate-count}") int candidateCount,
                       @Value("${hmb.away.match.rating-band}") int ratingBand,
                       @Value("${hmb.away.match.offer-ttl-sec}") int offerTtlSec,
                       @Value("${hmb.away.match.daily-limit}") int dailyLimit,
                       java.time.Clock clock,
                       @Value("${hmb.away.streak.bonus-per-win}") int streakBonusPerWin,
                       @Value("${hmb.away.streak.max-bonus}") int streakMaxBonus,
                       @Value("${hmb.away.reward.mode}") String rewardMode,
                       @Value("${hmb.away.reward.defender-on-loss}") boolean defenderRewardOnLoss,
                       @Value("${hmb.away.revenge.attempts-max}") int revengeAttemptsMax,
                       @Value("${hmb.away.revenge.queue-size}") int revengeQueueSize,
                       online.hmb.eligibility.EligibilityService eligibility) {
        this.eligibility = eligibility;
        this.jdbcClient = jdbcClient;
        this.matchService = matchService;
        this.deckService = deckService;
        this.deckSnapshot = deckSnapshot;
        this.ratingService = ratingService;
        this.growthService = growthService;
        this.contextBuilder = contextBuilder;
        this.objectMapper = objectMapper;
        this.txRunner = txRunner;
        this.ratingWin = ratingWin;
        this.ratingDraw = ratingDraw;
        this.ratingLoss = ratingLoss;
        this.reportListLimit = reportListLimit;
        this.seasonService = seasonService;
        this.walletService = walletService;
        this.economyService = economyService;
        this.candidateCount = candidateCount;
        this.ratingBand = ratingBand;
        this.offerTtlSec = offerTtlSec;
        this.dailyLimit = dailyLimit;
        this.clock = clock;
        this.streakBonusPerWin = streakBonusPerWin;
        this.streakMaxBonus = streakMaxBonus;
        this.rewardMode = rewardMode;
        this.defenderRewardOnLoss = defenderRewardOnLoss;
        this.revengeAttemptsMax = revengeAttemptsMax;
        this.revengeQueueSize = revengeQueueSize;
    }

    // ── 원정 출발 ───────────────────────────────────────────────────────────

    /**
     * 원정 매치 생성. {@code defenderId} 가 null 이면 활성 덱을 가진 다른 유저 중 무작위.
     *
     * <p><b>상대가 없으면 매치를 만들지 않는다</b>(404 NO_OPPONENT). 봇으로 조용히 대체하면
     * "원정 갔는데 사실 봇"이 되고, 피원정이 발생하지 않으니 요구 1·3(리포트·부재중 집계)이
     * 영원히 빈 화면이 된다. 조용한 폴백은 기능을 없애는 것과 같다.
     */
    /**
     * 오늘(KST) 남은 원정 횟수. {@code daily-limit: 0} 이면 제한 없음을 뜻하는 {@code -1}.
     *
     * <p>왜 화면에 먼저 주나: 눌렀는데 거부되는 건 나쁜 UX 다. 남은 횟수를 후보 응답에 실어 보내
     * 화면이 미리 말하게 한다.
     */
    public int remainingToday(String userId) {
        if (dailyLimit <= 0) {
            return -1;
        }
        return Math.max(0, dailyLimit - usedToday(userId));
    }

    /**
     * 오늘 만든 원정 수 — 날짜 경계는 <b>KST 자정</b>(`ConditionService.dateOf` 와 같은 기준).
     * 컨디션 갱신과 다른 기준을 쓰면 "어제 것"의 의미가 화면마다 달라진다.
     */
    private int usedToday(String userId) {
        // ⚠️ **날짜 문자열로 비교하지 마라.** matches.created_at 은 UTC 인스턴트(`...T05:00:00Z`)이고
        // 오늘은 KST 기준이다 — 'yyyy-MM-dd' 와 문자열 비교하면 KST 자정이 아니라 **UTC 자정**이
        // 경계가 되어 한국 시간 오전 0~9시의 원정이 어제로 세어진다. 존을 살려 **인스턴트**로 계산한다.
        // (이 세션에서 같은 종류의 시각-문자열 버그를 두 번 잡혔다. 세 번은 안 된다.)
        String since = java.time.LocalDate.now(clock)
                .atStartOfDay(clock.getZone())
                .toInstant()
                .toString();
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM matches
                        WHERE user_id = ? AND mode = 'away' AND created_at >= ?
                        """)
                .params(userId, since)
                .query(Integer.class)
                .single();
    }

    private void assertUnderDailyLimit(String attackerId) {
        if (dailyLimit <= 0) {
            return;   // 무제한 — 롤백 스위치
        }
        int used = usedToday(attackerId);
        if (used >= dailyLimit) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "AWAY_DAILY_LIMIT",
                    "오늘의 원정 횟수를 다 썼습니다 (" + used + "/" + dailyLimit + ") — 내일 다시 가능합니다",
                    java.util.Map.of("used", used, "limit", dailyLimit));
        }
    }

    public MatchService.MatchRow start(String attackerId, String defenderId) {
        assertUnderDailyLimit(attackerId);
        // ⚠️ **내 덱을 먼저, 루프 밖에서 검증한다**(독립검증 4R blocker). 이걸 루프 안에 두면
        // 공격자 자기 덱 오류(트레이드로 넘긴 선수가 deck_slots 에 남음·활성 덱 없음)가 후보마다
        // 똑같이 터지고, 루프가 그걸 전부 삼켜 **404 NO_OPPONENT** 으로 뒤집힌다 — 덱이 문제인데
        // "상대가 없다"고 말하는, 유저가 할 수 있는 게 0인 막다른 토스트다(#217 이 금지한 형태).
        // 게다가 그 실패 1회가 **후보 수만큼 고스트 INSERT** 를 남긴다(실측 14행/1회, 회수 경로 없음).
        DeckService.DeckResponse myDeck = deckService.requireActiveDeck(attackerId);
        deckService.validate(attackerId, new DeckService.DeckUpdateRequest(myDeck.formation(), myDeck.slots()));

        if (defenderId != null) {
            if (defenderId.equals(attackerId)) {
                throw ApiException.validation("자기 자신에게 원정을 갈 수 없습니다");
            }
            // hero E2: 고르는 건 되지만 **제시된 것 중에서만**. 이 한 줄이 "2택"과 "지목"을 가른다.
            assertOffered(attackerId, defenderId);
            MatchService.MatchRow row = startAgainst(attackerId, defenderId);
            // ⚠️ **제시는 소모된다**(MAJ-7) — 남겨두면 한 목록으로 TTL 동안 같은 상대를 반복 수락할 수
            // 있고, 승패로 레이팅이 벌어져 밴드를 벗어나도 계속 고를 수 있다(밴드 방어의 두 번째 입구).
            // 단 **매치가 실제로 만들어진 뒤**에 지운다 — 먼저 지우면 그 뒤 단계가 실패했을 때
            // (상대 덱이 방금 깨졌다든지) 유저가 다른 후보를 고를 길까지 사라진다(MIN-5).
            consumeOffer(attackerId);
            return row;
        }
        // ⚠️ 이 경로도 **밴드를 쓴다**(독립검증 MAJ-1). 예전엔 여기만 전체 풀에서 뽑아서, 바디 없이
        // POST 하면 레이팅 10만짜리 상대가 걸렸다 — 밴드 매칭이 담합 방어의 근거인데 그 근거에
        // 우회로가 있었다. 후보 선정은 한 곳(offerCandidates 와 같은 밴드 확장)만 쓴다.
        List<Candidate> pool = new ArrayList<>(bandPool(attackerId));
        if (pool.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT", "원정 갈 상대가 아직 없습니다");
        }
        java.util.Collections.shuffle(pool, secureRandom);
        String chosen = null;
        String ghostBotId = null;
        ApiException last = null;
        for (Candidate candidate : pool) {
            try {
                ghostBotId = bakeGhost(candidate.userId(), candidate.nickname());
                chosen = candidate.userId();
                break;
            } catch (ApiException e) {
                log.warn("away opponent candidate {} unusable ({}) — trying next",
                        candidate.userId(), e.getMessage());
                last = e;
            }
        }
        if (chosen == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT",
                    "원정 갈 상대가 아직 없습니다"
                            + (last == null ? "" : " (마지막 후보 사유: " + last.getMessage() + ")"));
        }
        return matchService.createAwayMatch(attackerId, ghostBotId, chosen);
    }

    /** 밴드 안 후보 — 부족하면 단계적으로 넓히고, 그래도 없으면 전체. 선정 로직의 유일한 출처. */
    private List<Candidate> bandPool(String attackerId) {
        int myRating = ratingService.rating(attackerId);
        List<Candidate> pool = List.of();
        for (int widen = 1; widen <= 4 && pool.size() < candidateCount; widen++) {
            pool = candidatesInBand(attackerId, myRating, (long) ratingBand * widen);
        }
        if (pool.isEmpty()) {
            pool = candidatesInBand(attackerId, myRating, Long.MAX_VALUE / 4);
        }
        return pool;
    }

    private void consumeOffer(String attackerId) {
        jdbcClient.sql("DELETE FROM away_offers WHERE user_id = ?").param(attackerId).update();
    }

    private String nicknameOf(String userId) {
        return jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(userId).query(String.class).optional()
                .orElseThrow(() -> ApiException.notFound("상대를 찾을 수 없습니다"));
    }

    private MatchService.MatchRow startAgainst(String attackerId, String defenderId) {
        return matchService.createAwayMatch(attackerId,
                bakeGhost(defenderId, nicknameOf(defenderId)), defenderId);
    }

    public record Candidate(String userId, String nickname, int rating) {
    }

    /**
     * 상대 후보 제시(hero E2/E3) — <b>레이팅이 비슷한 사람 중 무작위 N명</b>을 뽑아 보여주고,
     * 그 목록을 서버가 기억한다.
     *
     * <p>왜 기억하나: 클라가 보낸 id 를 그대로 믿으면 그건 <b>지목 원정</b>이고, 부계정을 반복 지목해
     * 레이팅을 무한 생성하는 경로가 열린다(4R MAJ-4 가 막은 그것). "2명 중 택1"은 제시가 서버 것일 때만
     * 성립한다. 유저당 1행이라 새로 뽑으면 이전 제시는 무효 — 리롤로 후보를 쌓지 못한다.
     *
     * <p>밴드는 <b>단계적으로 넓힌다</b>: 오픈베타처럼 인원이 적을 때 밴드만 고집하면 "상대 없음"이
     * 되는데, 그건 매칭 실패보다 나쁘다.
     */
    public List<Candidate> offerCandidates(String attackerId) {
        List<Candidate> pool = new ArrayList<>(bandPool(attackerId));
        if (pool.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT", "원정 갈 상대가 아직 없습니다");
        }
        java.util.Collections.shuffle(pool, secureRandom);
        // ⚠️ **세울 수 있는 팀만 제시한다**(독립검증 MAJ-8). 덱이 깨진 상대를 제시하면 유저가 그걸
        // 고르는 순간 "선발이 11명이 아닙니다"가 뜨는데, 화면은 그걸 **자기 덱 오류**로 그린다.
        // 2택은 폴백이 없으므로(고른 건 그 사람이다) 거르는 건 여기서 해야 한다.
        List<Candidate> offered = new ArrayList<>();
        for (Candidate c : pool) {
            if (offered.size() >= candidateCount) {
                break;
            }
            if (deckIsPlayable(c.userId())) {
                offered.add(c);
            }
        }
        if (offered.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT", "원정 갈 상대가 아직 없습니다");
        }

        List<String> ids = offered.stream().map(Candidate::userId).toList();
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, toJson(ids), Instant.now().toString())
                .update();
        return List.copyOf(offered);
    }

    /** 지금 상대로 세울 수 있는 덱인가(검증만, 굽지 않는다). */
    private boolean deckIsPlayable(String userId) {
        try {
            DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
            deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * ⚠️ <b>자격 조건이 여기 있는 이유</b>(#296): 후보 조건이 "활성 덱 보유"뿐이었는데 덱은
     * <b>온보딩이 자동 지급</b>한다 — 즉 사실상 "가입했음"이라 가입만 한 계정이 전부 상대로 섰다
     * (라이브 후보 40명 중 실플레이 흔적은 9명, #288). 한 판이라도 끝낸 유저만 고스트로 세운다.
     *
     * <p>이 메서드가 {@code bandPool} 의 <b>모든</b> 경로(밴드 ×1~×4 확장 + 전체 폴백)가 지나는
     * 유일한 지점이다. 그래서 필터를 여기 하나에만 걸어도 폴백이 우회로가 되지 않는다 — 반대로
     * 호출부마다 걸었다면 폴백만 빠뜨렸을 것이다(MAJ-1 이 잡았던 것과 같은 형태의 구멍).
     * 자격이 꺼져 있으면 임계가 0 이라 조건이 항상 참이 된다(분기 없음).
     */
    private List<Candidate> candidatesInBand(String attackerId, int myRating, long band) {
        return jdbcClient.sql("""
                        SELECT u.id AS id, u.nickname AS nickname,
                               COALESCE(r.rating, 0) AS rating
                        FROM users u
                        JOIN decks d ON d.user_id = u.id AND d.is_active = 1
                        LEFT JOIN user_ratings r ON r.user_id = u.id
                        WHERE u.id <> ? AND ABS(COALESCE(r.rating, 0) - ?) <= ?
                          AND (SELECT COUNT(*) FROM matches m
                                WHERE m.user_id = u.id AND m.result IS NOT NULL) >= ?
                        ORDER BY u.id
                        """)
                .params(attackerId, myRating, band, eligibility.threshold())
                .query((rs, n) -> new Candidate(rs.getString("id"), rs.getString("nickname"),
                        rs.getInt("rating")))
                .list();
    }

    private String toJson(List<String> ids) {
        try {
            return objectMapper.writeValueAsString(ids);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 방금 제시한 후보인가 — 아니면 지목이다(거부). TTL 을 넘긴 제시도 무효. */
    private void assertOffered(String attackerId, String defenderId) {
        record Offer(String candidates, String createdAt) {
        }
        Offer offer = jdbcClient.sql("SELECT candidates, created_at FROM away_offers WHERE user_id = ?")
                .param(attackerId)
                .query((rs, n) -> new Offer(rs.getString("candidates"), rs.getString("created_at")))
                .optional()
                .orElseThrow(() -> ApiException.validation("먼저 상대 목록을 받아야 합니다"));
        if (Instant.parse(offer.createdAt()).plusSeconds(offerTtlSec).isBefore(Instant.now())) {
            throw ApiException.validation("상대 목록이 만료됐습니다 — 다시 불러 주세요");
        }
        try {
            JsonNode arr = objectMapper.readTree(offer.candidates());
            for (JsonNode id : arr) {
                if (defenderId.equals(id.asText())) {
                    return;   // 소모는 매치가 실제로 만들어진 뒤에 한다(아래 consumeOffer)
                }
            }
        } catch (Exception e) {
            throw ApiException.validation("상대 목록을 읽을 수 없습니다 — 다시 불러 주세요");
        }
        // 제시하지 않은 상대다 = 지목 시도.
        throw ApiException.validation("제시된 상대 중에서만 고를 수 있습니다");
    }

    /**
     * 수비자의 현재 덱을 고스트 bots 행으로 굽는다(이미 있으면 그대로 쓴다 — id 가 덱 해시라
     * 같은 덱이면 같은 행이다).
     *
     * <p>스냅샷 직렬화는 {@link DeckSnapshot} <b>한 곳</b>을 쓴다(#215 계약) — 매치 스냅샷과 같은
     * 바이트여야 A(베이스) 캐시가 맞는다.
     */
    private String bakeGhost(String defenderId, String nickname) {
        DeckService.DeckResponse deck = deckService.getActiveDeck(defenderId);
        // 상대로 세우기 전에 규칙 검증 — 깨진 덱(선발 부족 등)으로 시뮬을 태우면 매치가 GEN 에서 죽는다.
        deckService.validate(defenderId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));
        // 팀 전술은 덱이 아니라 브리핑에서 정해지는 값이라(수비자는 브리핑에 없다) null 이다.
        String json = withFrozenAttributes(defenderId, deckSnapshot.json(deck, null));
        String botId = GHOST_PREFIX + defenderId + "_" + Hashes.sha256Hex(json).substring(0, 12);

        // kind='away' (#252): 이 행은 **연습 매칭 풀이 아니다**. 기본값 'seed' 로 두면 실유저 고스트가
        // 연습 랜덤 상대로 뽑히고, 그건 리그 봇팀이 연습 풀을 오염시킨 것(BL-1)과 똑같은 결함이다 —
        // 게다가 고스트는 성장 스탯이 박힌 실유저 덱이라 난이도 설계 밖에 있다.
        jdbcClient.sql("""
                        INSERT INTO bots(id, name, persona, analysis_text, deck_json, kind)
                        VALUES (?, ?, ?, ?, ?, 'away')
                        ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = 'away'
                        """)
                .params(botId, nickname, "",
                        nickname + " 감독의 실제 팀입니다. 선수별 지시가 그대로 적용됩니다.", json)
                .update();
        // ⚠️ 갱신하는 것은 name(닉네임 변경 반영)뿐이다. deck_json 을 덮으면 이 행을 쓰고 있는
        //    진행 중 매치의 상대가 하프 사이에 바뀐다 — id 가 내용 해시인 이유가 이것이다.
        return botId;
    }

    /**
     * 고스트 덱에 <b>수비자의 성장·강화 유효스탯을 박아 넣는다</b>(#245 MAJ-3).
     *
     * <p>왜: 봇 로스터는 {@code players} 카탈로그 원본 능력치로 선다(MatchOrchestrator.teamRoster 의
     * {@code growthUserId=null}). 그대로 두면 "상대는 실유저 팀"이라면서 <b>그 유저가 키운 스탯이 빠진
     * 약화판</b>이 서고, 그 결과로 수비자가 −10 을 먹는다. 레이팅이 경쟁 축인 이상 이건 계산이 틀린 것이다.
     *
     * <p>왜 <b>박아서 얼리나</b>(시뮬 시점에 조회하지 않고): 수비자는 이 매치에 대해 잠기지 않는다
     * (#217 의 growth 잠금은 <b>자기</b> 매치에만 걸린다). 시뮬 때 현재 스탯을 읽으면 수비자가 전·후반
     * 사이에 강화해 후반 스탯만 올릴 수 있고 — #217 이 잠금으로 막는 바로 그 버그다 — 재생·재현도
     * 깨진다. 값이 덱 JSON 에 들어가면 <b>해시가 그 값까지 덮으므로</b> 강화는 "다음 고스트"를 만들 뿐
     * 진행 중인 매치를 건드리지 못한다(공격자 스냅샷과 같은 규율).
     */
    private String withFrozenAttributes(String defenderId, String snapshotJson) {
        try {
            ObjectNode root = (ObjectNode) objectMapper.readTree(snapshotJson);
            for (String group : List.of("starters", "bench")) {
                for (JsonNode slot : root.path(group)) {
                    if (!slot.isObject() || !slot.path("playerId").isTextual()) {
                        continue;
                    }
                    String playerId = slot.path("playerId").asText();
                    Map<String, Object> base = contextBuilder.catalogAttributes(playerId);
                    if (base == null) {
                        continue;   // 카탈로그에 없는 선수 — 시뮬이 어차피 거른다
                    }
                    ((ObjectNode) slot).set("attributes", objectMapper.valueToTree(
                            growthService.effectiveAttributes(defenderId, playerId, base)));
                }
            }
            return root.toString();
        } catch (Exception e) {
            // 유효스탯을 못 실어도 원정 자체를 막지는 않는다(원본 능력치로 선다) — 다만 조용히 넘어가지
            // 않는다. 이 경고가 잦으면 수비자가 계속 약체로 서고 있다는 뜻이다.
            log.warn("ghost effective attributes unavailable for {} — falling back to catalog stats",
                    defenderId, e);
            return snapshotJson;
        }
    }

    /** 이 매치에서 원정을 당한 쪽(있으면). 시뮬이 고스트 로스터를 조립할 때 쓴다. */
    public java.util.Optional<String> defenderOf(String matchId) {
        return findChallenge(matchId).map(Challenge::defenderId);
    }

    // ── 정산 (FINISHED CAS 통과 후 1회) ─────────────────────────────────────

    /**
     * 원정 결과를 수비자 리포트 + 양쪽 레이팅으로 정산한다(hero Q3: 공격자·수비자 <b>둘 다</b> ±10).
     *
     * <p>멱등: 리포트는 {@code away_reports.match_id} UNIQUE, 레이팅은 원장 유니크가 막는다.
     * 호출자({@code MatchOrchestrator.finishMatch})가 이미 FINISHED CAS 를 통과한 경로지만,
     * 정산 재시도·경합에서도 두 번 반영되지 않아야 한다.
     *
     * @param attackerGoals 공격자(=매치 소유자) 득점 · @param defenderGoals 수비자 득점
     */
    public void settle(String matchId, String attackerId, String attackerResult,
                       int attackerGoals, int defenderGoals) {
        settle(matchId, attackerId, attackerResult, attackerGoals, defenderGoals, false);
    }

    /**
     * @param forfeit 몰수인가(상대가 브리핑에서 무름). <b>경기가 열리지도 않은 것</b>이므로 세 가지를
     *     함께 가른다 — ①수비자 재화 지급 없음 ②연승에 반영 안 함 ③시즌 참가로 세지 않음.
     *     그러지 않으면 두 계정이 서로 만들고 무르기만 해도 <b>시뮬 0회·AI 0회로</b> 주간 순위 보상
     *     (1위 30k + 2위 20k)을 가져가고, 레이팅은 서로 상쇄돼 밴드 매칭 방어도 걸리지 않는다.
     *     <b>레이팅 ±10 은 그대로</b> 준다 — 그게 무르는 쪽에 대한 벌칙이고 hero D1 이다.
     */
    public void settle(String matchId, String attackerId, String attackerResult,
                       int attackerGoals, int defenderGoals, boolean forfeit) {
        Challenge challenge = findChallenge(matchId).orElse(null);
        if (challenge == null) {
            // mode='away' 인데 도전장이 없다 = 데이터 사고. 조용히 넘어가면 수비자는 영영 모른다.
            log.warn("away match {} has no challenge row — report/rating skipped", matchId);
            return;
        }
        String defenderResult = mirror(attackerResult);
        int attackerDelta = deltaFor(attackerResult);
        int defenderDelta = deltaFor(defenderResult);
        String attackerName = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(attackerId).query(String.class).optional().orElse("상대");

        txRunner.run(() -> {
            // ⚠️ 연승 보너스를 **리포트 INSERT 전에** 계산한다. 예전엔 기본 ±10 만 박제하고 실제로는
            // 보너스를 더해 적용해서, 리포트가 "적용값을 박제한다"는 자기 선언을 **처음부터** 어겼다
            // (팝업의 레이팅 합계도 같이 틀렸다 — 독립검증 MAJ-3).
            // ⚠️ 보너스는 **미리 계산만** 하고 연승 갱신은 멱등 게이트 뒤에서 한다. 예전엔 여기서
            // 바로 갱신해서 같은 매치를 재정산하면 연승이 1→4 로 부풀었다(리포트·원장은 멱등인데
            // 연승만 샜다 — 독립검증 major-1). txRunner 안의 return 은 앞선 UPDATE 를 되돌리지 않는다.
            // 연승은 **내가 친 경기**에만 걸린다(hero 확정). 방어는 내가 고른 플레이가 아니므로
            // 연승을 올리지도, **깨지도** 않는다 — 자는 사이 남이 쳐서 내 연승이 끊기면 그건 내가
            // 어쩔 수 없는 이유로 잃는 것이다. 그래서 보너스도 공격자에게만 붙는다.
            // 몰수는 열리지도 않은 경기라 공격자 쪽도 연승에서 뺀다(보너스 파밍 방지).
            int attackerBonus = forfeit ? 0 : peekStreakBonus(attackerId, attackerResult);
            int defenderBonus = 0;
            int attackerApplied = attackerDelta + attackerBonus;
            int defenderApplied = defenderDelta + defenderBonus;
            // ⚠️ **복수로 얻은 리포트는 다시 복수 대상이 되지 않는다**(hero 확정, #319). 내가 갚아서
            // 이기면 상대 쪽에 이 행이 생기는데, 표식이 없으면 그게 그의 복수 큐에 들어가 둘이
            // 무한히 주고받는 핑퐁이 열린다. 판정에 쓸 사실이므로 파생하지 않고 여기서 박는다.
            int fromRevenge = challenge.revengeReportId() != null ? 1 : 0;
            int inserted = jdbcClient.sql("""
                            INSERT OR IGNORE INTO away_reports(
                                id, match_id, defender_id, attacker_id, attacker_name,
                                goals_for, goals_against, result, rating_delta, created_at, forfeit,
                                from_revenge)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """)
                    .params(Ulid.next(), matchId, challenge.defenderId(), attackerId, attackerName,
                            defenderGoals, attackerGoals, defenderResult, defenderApplied,
                            Instant.now().toString(), forfeit ? 1 : 0, fromRevenge)
                    .update();
            if (inserted == 0) {
                return; // 이미 정산됨 — 연승도 복수 소모도 건드리지 않는다
            }
            // ⚠️ 복수 소모도 **멱등 게이트 뒤**다. 앞에 두면 같은 매치 재정산이 시도 횟수를 깎아
            // 유저가 치지도 않은 판을 잃는다(연승이 정확히 그 형태로 부풀었던 자리 — #245 major-1).
            if (challenge.revengeReportId() != null) {
                consumeRevenge(challenge.revengeReportId(), attackerResult);
            }
            if (!forfeit) {
                commitStreak(attackerId, attackerResult);   // 수비자는 건드리지 않는다(위 참조)
            }
            if (attackerApplied != 0) {
                ratingService.apply(attackerId, attackerApplied, REASON_ATTACK, matchId);
            }
            if (defenderApplied != 0) {
                ratingService.apply(challenge.defenderId(), defenderApplied, REASON_DEFENSE, matchId);
            }
            // 수비자 보상(hero E7) — "덱 세팅 잘해두면 돈이 들어오고, 지면 남 좋은 일만".
            // 공격자 보상은 매치 정산(MatchOrchestrator)이 이미 준다 — 여기서 또 주면 이중 지급이다.
            if (!forfeit) {
                payDefenderReward(challenge.defenderId(), defenderResult, matchId);
            }
        });
    }

    /**
     * 연승 갱신 + 이번 판 보너스(hero E4). 승리면 +1, 패배면 0 으로 끊고, <b>무승부는 유지</b>한다 —
     * 비긴 걸로 연승이 깨지면 방어 성공이 손해가 된다.
     *
     * @return 이번 판에 얹을 추가 레이팅(2연승부터, 상한 있음). 승리가 아니면 0.
     */
    private int peekStreakBonus(String userId, String result) {
        if (!"WIN".equals(result)) {
            return 0;   // 승리에만 붙는다(패=끊김, 무=유지)
        }
        int next = streakOf(userId) + 1;
        return Math.min(Math.max(next - 1, 0) * streakBonusPerWin, streakMaxBonus);
    }

    /**
     * 연승 갱신 — 승 +1 · 패 0 으로 끊김 · <b>무승부는 유지</b>.
     *
     * <p><b>공격자에게만</b> 부른다(hero 확정): 연승은 "내가 친 경기"의 기록이다. 방어는 내가 고른
     * 플레이가 아니므로 방어 성공이 연승을 올리지도, <b>방어 실패가 연승을 깨지도</b> 않는다 —
     * 자는 사이 남이 쳐서 내 연승이 끊기면 그건 내가 어쩔 수 없는 이유로 잃는 것이다.
     *
     * <p>정산이 실제로 새로 기록됐을 때만 부른다(멱등).
     */
    private void commitStreak(String userId, String result) {
        String now = Instant.now().toString();
        if ("LOSS".equals(result)) {
            jdbcClient.sql("""
                            INSERT INTO away_streaks(user_id, streak, best_streak, updated_at)
                            VALUES (?, 0, 0, ?)
                            ON CONFLICT(user_id) DO UPDATE SET streak = 0, updated_at = excluded.updated_at
                            """)
                    .params(userId, now)
                    .update();
            return;
        }
        if (!"WIN".equals(result)) {
            return;   // 무승부 — 유지
        }
        jdbcClient.sql("""
                        INSERT INTO away_streaks(user_id, streak, best_streak, updated_at)
                        VALUES (?, 1, 1, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          streak = away_streaks.streak + 1,
                          best_streak = MAX(away_streaks.best_streak, away_streaks.streak + 1),
                          updated_at = excluded.updated_at
                        """)
                .params(userId, now)
                .update();
    }

    /**
     * 수비자 보상(hero E6/E7): 금액 곡선은 <b>리그 한 판과 같게</b>({@code hmb.away.reward.mode}).
     * 패배는 기본 0 — hero 의 "지면 남 좋은 일만 하는 구조" 를 그대로 옮긴 것이다.
     *
     * <p>값 자체는 data 발행물(economy)이 소유한다. economy 에 away 키를 새로 만들지 않는 이유는
     * {@code data/**} 가 이 모듈 소유가 아니고, "리그와 같게"라는 지시는 값 복제가 아니라 <b>참조</b>로
     * 표현하는 게 정확하기 때문이다(값이 바뀌면 같이 따라간다).
     */
    private void payDefenderReward(String defenderId, String defenderResult, String matchId) {
        if ("LOSS".equals(defenderResult) && !defenderRewardOnLoss) {
            return;
        }
        economyService.get().ifPresentOrElse(economy -> {
            int amount = economy.rewards().forMode(rewardMode).by(defenderResult);
            if (amount != 0) {
                walletService.apply(defenderId, amount, "away_defense_reward", matchId);
            }
        }, () -> log.warn("economy unavailable — away defender reward skipped (match={})", matchId));
    }

    private int deltaFor(String result) {
        return switch (result) {
            case "WIN" -> ratingWin;
            case "LOSS" -> ratingLoss;
            default -> ratingDraw;
        };
    }

    private static String mirror(String result) {
        return switch (result) {
            case "WIN" -> "LOSS";
            case "LOSS" -> "WIN";
            default -> "DRAW";
        };
    }

    /** revengeReportId: 이 매치가 어느 피침공 기록의 복수인가(#319, 일반 원정이면 null). */
    record Challenge(String matchId, String defenderId, String ghostBotId, String revengeReportId) {
    }

    private java.util.Optional<Challenge> findChallenge(String matchId) {
        return jdbcClient.sql("SELECT match_id, defender_id, ghost_bot_id, revenge_report_id "
                        + "FROM away_challenges WHERE match_id = ?")
                .param(matchId)
                .query((rs, n) -> new Challenge(rs.getString("match_id"), rs.getString("defender_id"),
                        rs.getString("ghost_bot_id"), rs.getString("revenge_report_id")))
                .optional();
    }

    // ── 리포트 조회 / 확인 ──────────────────────────────────────────────────

    /** attackerId 는 집계 전용(닉 변경에도 "몇 팀"이 흔들리지 않게) — 화면은 attackerName 을 쓴다. */
    public record Report(String id, String matchId, String attackerId, String attackerName,
                         int goalsFor, int goalsAgainst, String result, int ratingDelta,
                         String createdAt, boolean seen) {
    }

    /**
     * 부재중 요약(요구 3). <b>서버가 계산해서 준다</b> — 클라가 같은 집계를 다시 구현하면 규칙이
     * 바뀔 때 조용히 어긋난다(#217 에서 확인된 원칙).
     *
     * @param opponents 서로 다른 상대 팀 수("몇 팀과 붙었나")
     */
    public record Summary(int matches, int opponents, int wins, int draws, int losses,
                          int goalsFor, int goalsAgainst, int ratingDelta) {
    }

    public record ReportsResponse(List<Report> reports, Summary summary, int rating, int unseen) {
    }

    /**
     * @param status {@code "unseen"}(기본, 팝업 대상) 또는 {@code "all"}(전적 화면).
     *     요약은 <b>목록과 같은 범위</b>로 계산한다 — 화면의 리스트와 헤드라인이 어긋나면 안 된다.
     */
    public ReportsResponse reports(String userId, String status) {
        boolean unseenOnly = !"all".equalsIgnoreCase(status);
        List<Report> rows = jdbcClient.sql("""
                        SELECT id, match_id, attacker_id, attacker_name, goals_for, goals_against,
                               result, rating_delta, created_at, seen_at
                        FROM away_reports
                        WHERE defender_id = ? AND (? = 0 OR seen_at IS NULL)
                        ORDER BY created_at DESC
                        LIMIT ?
                        """)
                .params(userId, unseenOnly ? 1 : 0, reportListLimit)
                .query((rs, n) -> new Report(rs.getString("id"), rs.getString("match_id"),
                        rs.getString("attacker_id"), rs.getString("attacker_name"),
                        rs.getInt("goals_for"), rs.getInt("goals_against"), rs.getString("result"),
                        rs.getInt("rating_delta"), rs.getString("created_at"),
                        rs.getString("seen_at") != null))
                .list();
        return new ReportsResponse(rows, summarize(rows), ratingService.rating(userId),
                (int) unseenCount(userId));
    }

    private Summary summarize(List<Report> rows) {
        Set<String> opponents = new LinkedHashSet<>();
        int wins = 0;
        int draws = 0;
        int losses = 0;
        int goalsFor = 0;
        int goalsAgainst = 0;
        int ratingDelta = 0;
        for (Report r : rows) {
            // ⚠️ 닉네임이 아니라 id 로 센다 — 상대가 닉을 바꾸면 같은 사람이 "2팀"이 된다(5R MIN-7).
            opponents.add(r.attackerId());
            switch (r.result()) {
                case "WIN" -> wins++;
                case "LOSS" -> losses++;
                default -> draws++;
            }
            goalsFor += r.goalsFor();
            goalsAgainst += r.goalsAgainst();
            ratingDelta += r.ratingDelta();
        }
        return new Summary(rows.size(), opponents.size(), wins, draws, losses,
                goalsFor, goalsAgainst, ratingDelta);
    }

    /** 현재 연승(표시용). 행이 없으면 0. */
    public int streakOf(String userId) {
        return jdbcClient.sql("SELECT streak FROM away_streaks WHERE user_id = ?")
                .param(userId).query(Integer.class).optional().orElse(0);
    }

    public long unseenCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND seen_at IS NULL")
                .param(userId)
                .query(Long.class)
                .single();
    }

    /**
     * 확인 처리(팝업 [확인]). {@code ids} 가 비면 미확인 전부.
     *
     * <p>멱등: {@code seen_at IS NULL} 조건이 갱신 대상을 좁히므로 두 탭이 동시에 확인해도 한 번만
     * 처리되고, 두 번째 호출은 <b>실패가 아니라 0건</b>이다(에러로 만들면 화면이 이유 없이 붉어진다).
     */
    public int ack(String userId, List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            return jdbcClient.sql("""
                            UPDATE away_reports SET seen_at = ?
                            WHERE defender_id = ? AND seen_at IS NULL
                            """)
                    .params(Instant.now().toString(), userId)
                    .update();
        }
        if (ids.size() > reportListLimit) {
            // 클라가 보낼 수 있는 목록은 화면에 그린 것뿐이다(= 최대 한 창). 그보다 길면 요청이
            // 잘못된 것이지 수행할 일이 아니다 — 상한이 없으면 길이만큼 UPDATE 가 그대로 실행된다.
            throw ApiException.validation("한 번에 확인할 수 있는 리포트 수를 넘었습니다");
        }
        int acked = 0;
        String now = Instant.now().toString();
        for (String id : new ArrayList<>(ids)) {
            acked += jdbcClient.sql("""
                            UPDATE away_reports SET seen_at = ?
                            WHERE id = ? AND defender_id = ? AND seen_at IS NULL
                            """)
                    .params(now, id, userId)
                    .update();
        }
        return acked;
    }


    // ── 복수 큐 (#286 W4 · #319) ────────────────────────────────────────────

    /**
     * ⚠️ <b>복수는 V22 가 일부러 닫아 둔 문을 다시 여는 기능이다</b>(설계 §4.1). {@code away_offers}
     * 주석이 지목 원정을 어뷰징 경로로 명시하며 닫았다 — 클라가 고른 id 를 믿으면 부계정을 반복
     * 지목해 레이팅을 무한 생성할 수 있다(독립검증 4R MAJ-4). 복수는 그 문을 세 조건으로 좁혀 연다:
     *
     * <ol>
     *   <li><b>그가 실제로 나를 쳤다</b>는 원장 행이 있을 때만(=이 큐에 있는 기록만)</li>
     *   <li>기록당 <b>{@code attempts-max}회</b></li>
     *   <li>기록은 <b>최근 {@code queue-size}건</b>만 산다</li>
     * </ol>
     *
     * <p>세 조건 모두 <b>POST 경로에서도</b> 검사한다({@link #startRevenge}). 이 목록은 안내이지
     * 방어가 아니다 — 클라가 버튼을 숨기는 것과 서버가 거부하는 것은 다른 층이다.
     */
    public record RevengeOpponent(String userId, String nickname, int rating) {
    }

    /**
     * @param theirScore 그때 <b>공격자</b>의 득점 · @param myScore 그때 <b>내(수비자)</b> 득점.
     *     화면이 수비자 관점으로 그리므로 여기서 배치해서 보낸다 — 클라가 뒤집으면 유저는 자기가
     *     이긴 경기를 진 것으로 읽는다.
     * @param defenceResult 내가 막았나(WIN|DRAW|LOSS). <b>WIN 이면 복수 대상이 아니다</b>(hero 확정 ④).
     */
    public record RevengeEntry(String reportId, RevengeOpponent opponent, String attackedAt,
                               int theirScore, int myScore, String defenceResult, int ratingDelta,
                               int attemptsUsed, int attemptsMax, boolean forfeit, String state) {
    }

    /** remainingToday 는 <b>일반 원정과 같은 한도</b>다(hero Q3-② — 복수 판도 오늘 횟수를 먹는다). */
    public record RevengeResponse(List<RevengeEntry> entries, int remainingToday) {
    }

    public RevengeResponse revengeQueue(String userId) {
        return new RevengeResponse(revengeWindow(userId, false), remainingToday(userId));
    }

    /**
     * 복수 창 = 내가 수비자인 <b>최근 {@code queue-size}건</b>(설계 §4.1 조건 ③ — 자물쇠의 일부).
     *
     * <p>⚠️ <b>창을 먼저 자르고, 표시에서 뺄 것을 그 다음에 뺀다</b>(독립검증 MAJ-1). 순서를 뒤집어
     * {@code AVENGED} 를 제외한 뒤 LIMIT 을 걸면 <b>갚을 때마다 슬롯이 하나 비어</b> 더 오래된 기록이
     * 되살아난다 — 부계정이 20번 쳐 뒀다면 5개가 아니라 20개 전부가 순차적으로 지목 대상이 되고,
     * 그러면 "최근 5건"은 창이 아니라 필터일 뿐이다(= 좁혀서 연 문이 다시 넓어진다).
     * 실측으로 잡혔다: 최신 1건을 갚으니 창 밖이던 가장 오래된 기록이 410 → 201 로 되살아났다.
     *
     * <p>{@code from_revenge = 1}(복수가 만든 기록)만은 <b>창을 세기 전에</b> 거른다 — 그건 애초에
     * 침공 기록이 아니라 내 복수의 결과다. 슬롯을 먹게 두면 핑퐁 한 번에 진짜 침공이 밀려난다.
     *
     * <p>방어 성공·소진 기록은 창 안에 <b>남는다</b>(회색으로 잠긴 채) — 없어지면 유저는 자기가
     * 막아낸 사실도, 두 번 다 진 사실도 화면에서 확인할 수 없다.
     *
     * @param includeAvenged 창 자체(POST 의 조건 ③ 검사)면 true, 화면 목록이면 false(§4.2 소멸).
     */
    private List<RevengeEntry> revengeWindow(String userId, boolean includeAvenged) {
        return jdbcClient.sql("""
                        SELECT r.id AS id, r.attacker_id AS attacker_id, r.attacker_name AS attacker_name,
                               r.created_at AS created_at, r.goals_for AS goals_for,
                               r.goals_against AS goals_against, r.result AS result,
                               r.rating_delta AS rating_delta, r.revenge_attempts AS attempts,
                               r.revenge_state AS state, r.forfeit AS forfeit,
                               COALESCE(u.nickname, r.attacker_name) AS opp_nickname,
                               COALESCE(ur.rating, 0) AS opp_rating
                        FROM away_reports r
                        LEFT JOIN users u ON u.id = r.attacker_id
                        LEFT JOIN user_ratings ur ON ur.user_id = r.attacker_id
                        WHERE r.defender_id = ? AND r.from_revenge = 0
                        ORDER BY r.created_at DESC, r.id DESC
                        LIMIT ?
                        """)
                .params(userId, revengeQueueSize)
                .query((rs, n) -> new RevengeEntry(
                        rs.getString("id"),
                        new RevengeOpponent(rs.getString("attacker_id"), rs.getString("opp_nickname"),
                                rs.getInt("opp_rating")),
                        rs.getString("created_at"),
                        rs.getInt("goals_against"),   // 공격자 득점
                        rs.getInt("goals_for"),       // 내 득점
                        rs.getString("result"),
                        rs.getInt("rating_delta"),
                        rs.getInt("attempts"), revengeAttemptsMax,
                        rs.getInt("forfeit") == 1,
                        stateOf(rs.getString("state"), rs.getInt("attempts"))))
                .list()
                .stream()
                .filter(e -> includeAvenged || !"AVENGED".equals(e.state()))
                .toList();
    }

    /**
     * 저장된 상태가 정본이되, <b>시도 수가 상한에 닿으면 소진</b>으로 본다. 둘을 같이 보는 이유는
     * {@code attempts-max} 가 config 라서다 — 상한을 낮추면 이미 그만큼 도전한 기록은 즉시 잠겨야 하고,
     * 올리면 다시 열려야 한다. 저장값만 믿으면 그 조정이 과거 기록에 반영되지 않는다.
     */
    private String stateOf(String stored, int attempts) {
        if ("AVENGED".equals(stored)) {
            return "AVENGED";
        }
        return attempts >= revengeAttemptsMax ? "EXHAUSTED" : "AVAILABLE";
    }

    private record ReportRow(String id, String defenderId, String attackerId, String result,
                             int attempts, String state, int fromRevenge) {
    }

    /**
     * 복수 매치 생성 — <b>자물쇠는 전부 여기 있다</b>. 순서가 곧 유저가 받는 문장이라, 영구적인
     * 이유(내 기록이 아니다 · 막아냈다 · 이미 갚았다 · 소진)를 <b>일시적인 이유</b>(오늘 횟수)보다
     * 먼저 말한다 — 거꾸로면 유저는 내일 다시 와서 같은 벽을 만난다.
     *
     * <p>⚠️ 없는 {@code reportId} 도 <b>403 REVENGE_NOT_OWNED</b> 다. 404 로 가르면 "그 id 는 실재한다"가
     * 새어 나가고, 이 엔드포인트는 남의 원장 행을 가리키는 자리라 그 정보를 흘릴 이유가 없다.
     */
    public MatchService.MatchRow startRevenge(String userId, String reportId) {
        ReportRow report = jdbcClient.sql("""
                        SELECT id, defender_id, attacker_id, result, revenge_attempts, revenge_state,
                               from_revenge
                        FROM away_reports WHERE id = ?
                        """)
                .param(reportId)
                .query((rs, n) -> new ReportRow(rs.getString("id"), rs.getString("defender_id"),
                        rs.getString("attacker_id"), rs.getString("result"),
                        rs.getInt("revenge_attempts"), rs.getString("revenge_state"),
                        rs.getInt("from_revenge")))
                .optional()
                .orElse(null);
        if (report == null || !userId.equals(report.defenderId())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "REVENGE_NOT_OWNED",
                    "나를 상대로 한 원정 기록이 아닙니다");
        }
        // hero 확정 ④ — 막아낸 침공은 갚을 것이 애초에 없다. 열어 두면 **이미 이긴 상대에게**
        // 지목 원정이 2판 더 생긴다(= §4.1 이 좁혀서 연 문을 그보다 넓게 여는 것).
        if ("WIN".equals(report.result())) {
            throw new ApiException(HttpStatus.CONFLICT, "REVENGE_DEFENDED",
                    "막아낸 경기입니다 — 갚을 것이 없습니다");
        }
        if (report.fromRevenge() == 1) {
            throw new ApiException(HttpStatus.CONFLICT, "REVENGE_CHAINED",
                    "복수 경기의 결과에는 다시 복수할 수 없습니다");
        }
        if ("AVENGED".equals(report.state())) {
            throw new ApiException(HttpStatus.GONE, "REVENGE_AVENGED", "이미 복수한 상대입니다");
        }
        if (report.attempts() >= revengeAttemptsMax) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "REVENGE_EXHAUSTED",
                    "이 기록에는 더 도전할 수 없습니다 (" + revengeAttemptsMax + "회 소진)",
                    java.util.Map.of("attemptsUsed", report.attempts(), "attemptsMax", revengeAttemptsMax));
        }
        // ⚠️ **창 검사가 세 번째 자물쇠다**(§4.1 조건 ③). 목록에서 밀려난 기록을 클라가 그대로 POST
        // 하면 "최근 5건" 이 표시 상한으로 전락하고, 오래 전 부계정 침공까지 되살려 지목할 수 있다.
        if (revengeWindow(userId, true).stream().noneMatch(e -> e.reportId().equals(reportId))) {
            throw new ApiException(HttpStatus.GONE, "REVENGE_EXPIRED",
                    "복수 목록에서 밀려난 기록입니다");
        }
        // ⚠️ 자기 자신 지목 차단(독립검증 MIN-1). 정상 경로로는 attacker=defender 인 원장 행이
        // 생기지 않지만, 생기는 순간 자기와 붙어 +10/−10 이 **순증**(공격자 보너스만큼)이 된다.
        // 일반 원정(start)에는 이미 있는 가드다 — 새 문에만 없으면 그 문이 우회로가 된다.
        if (userId.equals(report.attackerId())) {
            throw ApiException.validation("자기 자신에게 원정을 갈 수 없습니다");
        }
        assertUnderDailyLimit(userId);

        // 내 덱을 **먼저** 본다(일반 원정과 같은 이유 — 4R blocker). 여긴 후보 루프가 없어 삼킬 것도
        // 없지만, 순서가 다르면 덱 오류가 고스트 굽기 실패로 먼저 터져 남의 문제처럼 보인다.
        DeckService.DeckResponse myDeck = deckService.requireActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(myDeck.formation(), myDeck.slots()));

        String ghostBotId;
        try {
            ghostBotId = bakeGhost(report.attackerId(), nicknameOf(report.attackerId()));
        } catch (ApiException e) {
            // ⚠️ 복수는 **폴백이 없다**(상대는 그 사람으로 정해져 있다). 상대 덱이 지금 깨져 있으면
            // 그 사유가 그대로 올라가 "선발이 11명이 아닙니다"가 뜨는데, 화면은 그걸 **내 덱 오류**로
            // 그린다(일반 원정이 offerCandidates 에서 미리 거르는 것과 같은 함정 — MAJ-8).
            log.warn("revenge target {} unusable ({})", report.attackerId(), e.getMessage());
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT",
                    "상대의 팀을 지금 세울 수 없습니다 — 잠시 후 다시 시도해 주세요");
        }
        // ⚠️ **시도는 여기서 원자적으로 예약한다**(독립검증 BL-1). 앞의 검사들은 전부 read-then-act
        // 라, 같은 reportId 로 동시에 6번 POST 하면 **6판이 전부 생성됐다**(실측) — "기록당 2회"가
        // 통째로 뚫린 것이다. 이 문은 §4.1 이 좁혀서 여는 문이라(내가 상대를 고르는 유일한 경로)
        // 경합 한 번이 곧 약한 부계정 상대로 1버스트 N판이 된다.
        //
        // 조건부 UPDATE 의 갱신 행 수가 곧 티켓이다: 0행 = 다른 요청이 이미 마지막 시도를 가져갔다.
        // ⚠️ 무승부는 횟수를 쓰지 않으므로(hero 확정 Q3-①) **정산에서 환불**한다 — 예약을 미루면
        // 원자성이 사라지고, 예약을 안 하면 자물쇠가 없다. "먼저 잠그고 무승부면 돌려준다"가 두
        // 규칙을 다 지키는 유일한 순서다.
        int reserved = jdbcClient.sql("""
                        UPDATE away_reports
                           SET revenge_attempts = revenge_attempts + 1,
                               revenge_state = CASE WHEN revenge_attempts + 1 >= ? THEN 'EXHAUSTED'
                                                    ELSE revenge_state END
                         WHERE id = ? AND revenge_attempts < ? AND revenge_state <> 'AVENGED'
                        """)
                .params(revengeAttemptsMax, reportId, revengeAttemptsMax)
                .update();
        if (reserved == 0) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "REVENGE_EXHAUSTED",
                    "이 기록에는 더 도전할 수 없습니다 (" + revengeAttemptsMax + "회 소진)",
                    java.util.Map.of("attemptsUsed", revengeAttemptsMax, "attemptsMax", revengeAttemptsMax));
        }
        try {
            return matchService.createAwayMatch(userId, ghostBotId, report.attackerId(), reportId);
        } catch (RuntimeException e) {
            // 매치를 못 만들었으면 시도를 먹지 않는다 — 예약은 자물쇠지 벌칙이 아니다.
            refundRevenge(reportId);
            throw e;
        }
    }

    /** 예약 되돌리기 — 매치 생성 실패 · 무승부 정산. 0 아래로 내려가지 않는다. */
    private void refundRevenge(String reportId) {
        jdbcClient.sql("""
                        UPDATE away_reports
                           SET revenge_attempts = MAX(revenge_attempts - 1, 0),
                               revenge_state = CASE WHEN revenge_state = 'EXHAUSTED' THEN 'AVAILABLE'
                                                    ELSE revenge_state END
                         WHERE id = ? AND revenge_state <> 'AVENGED'
                        """)
                .param(reportId)
                .update();
    }

    /**
     * 복수 결과 반영(hero 확정): <b>승 = 완료 · 패 = 시도 1 소모 · 무 = 횟수를 쓰지 않는다</b>.
     *
     * <p>무승부가 횟수를 안 쓰면 "비기는 한 무한 재도전"이 열리지만, 판수 규칙이 일일 원정 횟수를
     * 먹으므로 하루 총량은 그대로 묶인다 — 그게 안전장치라는 것을 알고 채택한 규칙이다(설계 §4.3).
     *
     * <p>몰수(공격자가 브리핑에서 무름)는 {@code attackerResult=LOSS} 로 들어오므로 <b>시도를
     * 소모한다</b>. 만들고 무르기를 반복해 판정을 피하는 경로를 열지 않는다.
     */
    private void consumeRevenge(String reportId, String attackerResult) {
        if ("WIN".equals(attackerResult)) {
            jdbcClient.sql("UPDATE away_reports SET revenge_state = 'AVENGED' WHERE id = ?")
                    .param(reportId)
                    .update();
            return;
        }
        if ("DRAW".equals(attackerResult)) {
            refundRevenge(reportId);   // hero 확정 Q3-① — 승부가 안 났으니 횟수를 쓰지 않는다
        }
        // 패배: 시도는 **생성 시점에 이미 예약**됐다(BL-1). 여기서 또 깎으면 두 번 먹는다.
        //
        // ⚠️ 그래서 정산에 도달하지 못한 매치(킥오프 이후 포기·스톨 스윕 — 독립검증 MIN-6)도
        // 시도가 소모된 채로 남는다. 그게 옳은 방향이다: 반대로 "정산 때만 깎는다"면 무르기를
        // 반복해 시도를 안 쓰고 상대를 계속 지목할 수 있다(= 자물쇠가 없는 것과 같다).
    }

    // ── 원정 랭킹보드 (#286 W4 · #319) ──────────────────────────────────────

    public record RankEntry(int rank, String userId, String nickname, int rating, int streak,
                            boolean isMe) {
    }

    /** rank 가 null = <b>아직 순위에 오르지 않았다</b>(이번 시즌 원정 0판). 0위로 채우지 않는다. */
    public record MyRank(Integer rank, String userId, String nickname, int rating, int streak,
                         boolean isMe, int total) {
    }

    public record RankingsResponse(int seasonNo, List<RankEntry> entries, MyRank me) {
    }

    /**
     * 원정 레이팅 랭킹보드 — <b>시즌 마감 스냅샷과 같은 함수를 지난다</b>
     * ({@link AwaySeasonService#standings}).
     *
     * <p>왜 {@code user_ratings}(창 없는 누적)로 매기지 않나: 참가는 시즌 창으로 자르는데 순위만
     * 누적으로 매기면 두 축이 어긋난다 — 실측에서 <b>3패한 유저가 1위, 3승한 유저가 2위</b>가 나왔다
     * (독립검증 MAJ-1, 밀린 시즌 + 앞 시즌 리셋 조합). 라이브 보드가 마감과 다른 표를 그리면
     * "1등이었는데 보상은 3등"이 되므로, 이 보드는 정의상 <b>지금 마감하면 나올 표</b>다.
     */
    public RankingsResponse rankings(String userId, int limit) {
        AwaySeasonService.Season season = seasonService.current();
        List<AwaySeasonService.SeasonStanding> all =
                seasonService.standings(season.startedAt(), season.endsAt());
        int effectiveLimit = limit <= 0 ? 20 : Math.min(limit, 100);

        List<RankEntry> entries = new ArrayList<>();
        MyRank me = null;
        for (int i = 0; i < all.size(); i++) {
            AwaySeasonService.SeasonStanding st = all.get(i);
            boolean isMe = st.userId().equals(userId);
            if (entries.size() < effectiveLimit) {
                entries.add(new RankEntry(i + 1, st.userId(), st.nickname(), st.rating(),
                        st.streak(), isMe));
            }
            if (isMe) {
                me = new MyRank(i + 1, st.userId(), st.nickname(), st.rating(), st.streak(),
                        true, all.size());
            }
        }
        if (me == null) {
            // ⚠️ 참가자가 아니어도 **404 를 내지 않는다**(#296 과 같은 규율). 신규 유저가 원정 탭을
            // 여는 순간 에러 토스트를 보게 되고, "자격이 없는 것"과 "유저가 없는 것"은 다르다.
            me = new MyRank(null, userId, nicknameOf(userId),
                    seasonService.seasonRatingOf(userId, season.startedAt(), season.endsAt()),
                    streakOf(userId), true, all.size());
        }
        return new RankingsResponse(season.seasonNo(), entries, me);
    }

}
