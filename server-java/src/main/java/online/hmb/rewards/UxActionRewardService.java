package online.hmb.rewards;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import online.hmb.common.Ulid;
import online.hmb.mail.MailAttachments;
import online.hmb.notice.Notices;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * #493 W3 — 행동 보상: 첫 행동 5종에 각 GEM 300 을 <b>우편으로</b> 지급한다 (hero 확정, 전액 통일).
 *
 * <p>①튜토리얼 완주 ②첫 경기 결과 열람(보상 봉투 ack) ③첫 덱 저장 ④첫 뽑기 ⑤첫 트레이드 등록.
 *
 * <p><b>왜 우편인가</b>: 이슈 본문 확정("지급은 기존 보상/우편 경로 재사용"). 우편함이 이미
 * 뱃지·[받기]·멱등 수령(지갑 원장 {@code ref_id = user_mails.id})·이력을 전부 갖고 있다 —
 * 지갑을 직접 만지면 "왜 늘었나"의 답이 두 곳이 되고 수령 연출을 새로 만들어야 한다.
 *
 * <p><b>멱등 구조 — 새 테이블이 없다</b> (V33 머리말 "지급 테이블을 새로 만들지 않는가" 준수):
 * <ul>
 *   <li>행동당 <b>공유 캠페인 1행</b>(고정 id {@code uxa_*} · 유니크 {@code idem_key}) —
 *       {@code INSERT OR IGNORE} 라 몇 번을 시도해도 한 행.</li>
 *   <li>유저별 1회 축 = {@code uq_user_mails_user_campaign(user_id, campaign_id)} —
 *       "팬아웃이 두 번 돌아도 두 통은 구조적으로 불가능"이 그대로 이 보상의 멱등이다.</li>
 * </ul>
 *
 * <p><b>호출 규약</b>: 자체 tx 를 열지 않는다 — 훅 5지점 전부 호출자 tx 안에서 부른다.
 * trade 의 busy-retry 가 tx 전체를 재실행해도 {@code INSERT OR IGNORE} 라 안전하다.
 * 보상 실패가 본 동작(뽑기·트레이드…)을 죽이면 안 되므로 호출부는 반환값만 로그에 쓴다.
 *
 * <p><b>금액 조정 포인트</b>: {@code hmb.reward.ux-action-gems}(기본 300). ⚠️ 금액은 캠페인
 * 생성 시점에 {@code payload_json} 으로 <b>박제</b>된다 — 이후 프로퍼티를 바꿔도 이미 만들어진
 * 캠페인의 미수령분은 옛 금액이다(운영 변경은 캠페인 행 수정 또는 새 액션 버전으로).
 */
@Service
public class UxActionRewardService {

    private static final Logger log = LoggerFactory.getLogger(UxActionRewardService.class);

    /** 행동 6종 — 캠페인 id·제목·본문이 여기서만 정의된다(화면은 우편 내용을 그대로 그린다). */
    public enum UxAction {
        TUTORIAL_DONE("uxa_tutorial_done", "튜토리얼 완주 보상",
                "감독 취임을 축하합니다! 기본기를 전부 익히셨네요. 첫 걸음 보상을 받아 주세요."),
        FIRST_RESULT_VIEW("uxa_first_result", "첫 경기 결과 확인 보상",
                "첫 경기의 결과를 확인하셨습니다. 결과 화면의 성장 리포트와 보상도 잊지 마세요."),
        FIRST_DECK_SAVE("uxa_first_deck", "첫 스쿼드 저장 보상",
                "나만의 스쿼드를 저장하셨습니다. 선수별 지시로 팀 색깔을 만들어 보세요."),
        FIRST_GACHA("uxa_first_gacha", "첫 뽑기 보상",
                "첫 영입을 축하합니다! 더 강한 선수로 스쿼드를 넓혀 보세요."),
        FIRST_TRADE("uxa_first_trade", "첫 트레이드 보상",
                "첫 트레이드를 걸었습니다. 안 쓰는 선수가 새 전력이 되어 돌아옵니다."),
        /** #493 W6-v3 (리플랜 v2 hero 승인 — 6종 × 300): 첫 강화(잠재 다이스) 완료. */
        FIRST_ENHANCE("uxa_first_enhance", "첫 강화 보상",
                "선수를 처음으로 강화하셨습니다. 잠재능력은 다시 굴릴수록 좋아집니다.");

        final String campaignId;
        final String title;
        final String body;

        UxAction(String campaignId, String title, String body) {
            this.campaignId = campaignId;
            this.title = title;
            this.body = body;
        }
    }

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final long gems;

    public UxActionRewardService(JdbcClient jdbcClient, ObjectMapper objectMapper, Clock clock,
                                 @Value("${hmb.reward.ux-action-gems:300}") long gems) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.gems = gems;
    }

    /**
     * 이 유저가 이 행동 보상을 아직 못 받았으면 우편 1통을 만든다. <b>호출자 tx 안에서 부를 것.</b>
     *
     * @return 이번 호출이 실제로 우편을 만들었는가(로그·연출 판단용 — 멱등이라 false 가 정상 경로다)
     */
    public boolean grantOnce(String userId, UxAction action) {
        String now = Notices.now(clock);
        // 공유 캠페인 확보 — 첫 트리거가 만든다. created_by 는 FK(users.id)라 시스템 계정이 없어
        // 트리거한 유저를 적는다(reason 이 시스템 발송임을 말한다). 만료 없음(hero: 행동 보상).
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO mail_campaigns(id, audience, title, body, payload_json,
                                                             has_attachments, expires_at, revoked_at,
                                                             target_count, reason, idem_key, request_hash,
                                                             created_by, created_at)
                        VALUES (?, 'USERS', ?, ?, ?, 1, NULL, NULL, 0, ?, ?, ?, ?, ?)
                        """)
                .params(action.campaignId, action.title, action.body, payloadJson(),
                        "#493 행동 보상(시스템 자동 발송)", "ux:" + action.name(),
                        "ux:" + action.name(), userId, now)
                .update();

        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_mails(id, user_id, campaign_id, expires_at,
                                                         read_at, claimed_at, created_at)
                        VALUES (?, ?, ?, NULL, NULL, NULL, ?)
                        """)
                .params(Ulid.next(), userId, action.campaignId, now)
                .update();
        if (inserted == 1) {
            // 지급 수를 캠페인에 반영 — admin 캠페인 뷰의 target_count 가 "지금까지 지급된 수"가 된다.
            jdbcClient.sql("UPDATE mail_campaigns SET target_count = target_count + 1 WHERE id = ?")
                    .param(action.campaignId)
                    .update();
            log.info("ux action reward granted: user={} action={} gems={}", userId, action, gems);
            return true;
        }
        return false;
    }

    private String payloadJson() {
        try {
            return objectMapper.writeValueAsString(new MailAttachments(0, gems, java.util.List.of()));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("ux action reward payload serialization failed", e);
        }
    }
}
