package online.hmb.tutorial;

import java.util.List;
import online.hmb.coupon.CouponService;
import online.hmb.growth.GrowthService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * #493 W6-v3 — 신규 유저의 <b>튜토리얼 재료</b> 지급.
 *
 * <p>hero verbatim: <i>"성장탭들어가면 무조건 한명 강화, 승급시켜야돼. 스타터팩에 고정으로한명
 * 무조건주고 걔는 두개주고 첫강화비용도 공짜로해서 강화경험하게해야돼."</i>
 *
 * <p>튜토리얼이 <b>성립하려면</b> 신규 유저의 계정에 다음 넷이 있어야 한다:
 * <ol>
 *   <li><b>승급 재료</b> — 같은 카드의 여분 중복. 필요 수는 상수가 아니라
 *       {@code GrowthTuning.star.copies[2]} 에서 파생한다(현재 2장 ⇒ 원본 포함 <b>3장</b>).
 *       ⚠️ hero 원문은 "두개"인데, 그건 <b>재료가 되게 하라</b>는 뜻이고 현행 계수에서 재료는
 *       "여분 2장"이다 — 2장만 주면 승급 버튼이 {@code INSUFFICIENT_MATERIALS} 로 막혀
 *       "무조건 승급시킨다"가 불가능해진다(Decision log).</li>
 *   <li><b>강화 1회분 경험치</b> — "강화"의 실체는 3지선다 선택권이므로 정확히 1레벨분을 채운다.</li>
 *   <li><b>첫 강화 무료 쿠폰</b>(잠재 다이스 골드 비용) · <b>트레이드 단축 무료 쿠폰</b>.</li>
 *   <li><b>첫 트레이드 등급 확정 티켓</b>.</li>
 * </ol>
 *
 * <p><b>기존 유저에게는 소급 지급하지 않는다</b> — 이 서비스는 가입 트랜잭션에서만 불린다.
 * 이미 스타터를 받은 계정은 여기 오지 않으므로 하위호환이 <b>구조적으로</b> 보장된다(마이그레이션
 * 백필도 두지 않았다: 소급 지급은 "튜토리얼을 이미 지난 사람에게 공짜 재화를 뿌리는" 일이다).
 *
 * <p><b>지급 실패가 가입을 죽이면 안 된다</b> — 카탈로그에 카드가 없거나(구 발행물) 계수가 없으면
 * 경고만 남기고 넘어간다. #209 가 {@code starterTop} 에서 세운 것과 같은 규율이다
 * (지급 누락 ≪ 서비스 중단).
 */
@Service
public class TutorialStarterService {

    private static final Logger log = LoggerFactory.getLogger(TutorialStarterService.class);

    /** 승급 체험의 목표 성 — 1★ 카드가 올라갈 다음 단계. 잠재능력(=강화)도 여기서 해금된다. */
    private static final int TARGET_STAR = 2;

    private final JdbcClient jdbcClient;
    private final CouponService couponService;
    private final GrowthService growthService;
    private final boolean enabled;
    private final String cardId;
    private final int xpLevels;

    public TutorialStarterService(JdbcClient jdbcClient,
                                  CouponService couponService,
                                  GrowthService growthService,
                                  @Value("${hmb.tutorial.starter.enabled}") boolean enabled,
                                  @Value("${hmb.tutorial.starter.card-id}") String cardId,
                                  @Value("${hmb.tutorial.starter.xp-levels}") int xpLevels) {
        this.jdbcClient = jdbcClient;
        this.couponService = couponService;
        this.growthService = growthService;
        this.enabled = enabled;
        this.cardId = cardId;
        this.xpLevels = xpLevels;
    }

    /**
     * 고정 튜토리얼 카드 id (#493 W9) — {@code GET /api/config} 의 {@code tutorial.starterCardId}.
     *
     * <p><b>지급 로직이 쓰는 그 값을 그대로</b> 내보낸다(이 필드 하나가 SoT). web 은 이 값이 없어서
     * "대기 중인 3지선다의 주인"으로 <b>추론</b>하고 있었는데, 그 추론은 유저가 다른 카드로 경기를
     * 치르거나 선택권을 이미 써 버리면 어긋난다(apps/web {@code onrail-api.ts} 머리말). 서버가
     * 이미 아는 값이므로 알려 준다 — 컨트롤러가 프로퍼티를 따로 읽으면 그 순간 출처가 둘이 된다.
     *
     * <p><b>지급이 꺼진 배포({@code enabled=false})에서는 null</b> — 그 배포엔 고정 카드가 <b>없다</b>.
     * 설정값을 그대로 흘리면 클라가 유저가 갖고 있지도 않은 카드로 온레일 가이드를 걸고, 그건
     * "모른다"보다 나쁜 거짓말이다. null 이면 web 은 종전의 "못 찾음" 경로를 그대로 탄다.
     */
    public String starterCardId() {
        return enabled ? cardId : null;
    }

    /**
     * 가입 트랜잭션 안에서 호출한다(스타터 팩 지급 <b>직후</b> — 기본 카드가 이미 들어와 있어야
     * 중복을 얹을 수 있다).
     */
    public void grant(String userId, String now) {
        if (!enabled) {
            return;
        }
        grantCoupons(userId);
        grantEnhanceMaterials(userId, now);
    }

    /** 쿠폰 3종 — 지급 멱등은 {@code (user, type, grant_key)} 유니크가 보장한다. */
    private void grantCoupons(String userId) {
        for (CouponService.CouponType type : List.of(
                CouponService.CouponType.FREE_ENHANCE,
                CouponService.CouponType.FREE_TRADE_RUSH,
                CouponService.CouponType.FIRST_TRADE_EPIC)) {
            couponService.grant(userId, type, CouponService.GRANT_KEY_STARTER);
        }
    }

    /** 고정 카드 = 원본 1 + 승급 재료(계수 파생) · 그 카드에 강화 1회분 경험치. */
    private void grantEnhanceMaterials(String userId, String now) {
        if (!playerExists(cardId)) {
            log.warn("tutorial card {} is not in the catalog — skipping tutorial materials for user {}",
                    cardId, userId);
            return;
        }
        int spare = growthService.copiesForStar(TARGET_STAR);
        if (spare <= 0 || spare == Integer.MAX_VALUE) {
            log.warn("star copies for {}★ unavailable — skipping tutorial copies for user {}",
                    TARGET_STAR, userId);
            return;
        }
        int total = 1 + spare;
        // 기본팩이 이미 한 장 줬을 수도, 아닐 수도 있다(구성은 데이터다) — 그래서 "몇 장을 더할까"가
        // 아니라 **최종 보유량을 목표치로 맞춘다**. 이미 더 많으면 줄이지 않는다.
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, ?, ?)
                        """)
                .params(userId, cardId, total, now)
                .update();
        if (inserted != 1) {
            jdbcClient.sql("""
                            UPDATE user_players SET count = ?
                            WHERE user_id = ? AND player_id = ? AND count < ?
                            """)
                    .params(total, userId, cardId, total)
                    .update();
        }

        int levels = growthService.grantTutorialLevels(userId, cardId, xpLevels);
        log.info("tutorial materials granted: user={} card={} copies={} levels={}",
                userId, cardId, total, levels);
    }

    private boolean playerExists(String playerId) {
        Long count = jdbcClient.sql("SELECT COUNT(*) FROM players WHERE id = ?")
                .param(playerId).query(Long.class).single();
        return count != null && count > 0;
    }
}
