package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import online.hmb.common.Ulid;
import online.hmb.mission.MissionService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 롤백 스위치 (#408 §9) — <b>{@code hmb.mission.daily.count: 0} 이면 새 미션이 생기지 않는다.</b>
 *
 * <p>설계 문서 §9 는 "카탈로그 config 를 비우면"이라고 적었지만, YAML 리스트는 env·property 하나로
 * 비울 수 없다 = 그 방식으로는 <b>재배포 없이 되돌릴 수 없다</b>(그러면 롤백 수단이 아니다).
 * 그래서 실제 스위치는 {@code HMB_MISSION_DAILY_COUNT=0} 이고, 카탈로그가 비어도 같은 결과다.
 *
 * <p>⚠️ <b>금액을 0 으로 내리는 방식은 쓰지 않는다</b> — 미션은 뜨는데 보상이 0 이면 유저는 그것을
 * 고장으로 읽는다(§9). 끄면 화면에서 사라지는 것이 정답이고, 그 사실을 여기서 박제한다.
 *
 * <p>그리고 <b>끈 뒤에도 이미 달성한 미수령 보상은 그대로 받을 수 있어야 한다</b>(§6.3) — 끄기가
 * 유저의 지갑을 소급으로 뺏으면 그건 롤백이 아니라 사고다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT,
        properties = "hmb.mission.daily.count=0")
class MissionRollbackOffTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private MissionService missionService;

    @Test
    void switchingTheFeatureOffStopsCreatingMissionsAndStopsProgressing() {
        login("mis_off");
        String uid = userIdOf("mis_off");

        assertThat(missionService.daily(uid).missions())
                .as("끄면 화면이 섹션을 통째로 안 그린다 — 빈 미션이 아니라 없는 미션이다").isEmpty();

        missionService.settle(Ulid.next(), uid, "WIN", 3, 0, true, java.time.Instant.now());
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_missions WHERE user_id = ?")
                .param(uid).query(Long.class).single()).isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_mission_progress").query(Long.class).single())
                .isZero();
    }

    /** 끈 뒤에도 이미 달성한 미수령 보상은 남아 있고, 받을 수 있다(§6.3 — 끄기가 지갑을 뺏지 않는다). */
    @Test
    void alreadyEarnedRewardsStayClaimableAfterTheSwitchIsOff() {
        login("mis_off_claim");
        String uid = userIdOf("mis_off_claim");
        String id = Ulid.next();
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT INTO daily_missions(id, user_id, day, slot_no, mission_id, title, tier,
                                rule, currency, amount, target, progress, completed_at, created_at)
                        VALUES (?, ?, '2026-08-01', 1, 'away_win_1', '원정에서 1승', 'EASY', 'WIN',
                                'GEM', 100, 1, 1, ?, ?)
                        """)
                .params(id, uid, now, now)
                .update();

        long before = jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?")
                .param(uid).query(Long.class).single();
        assertThat(missionService.daily(uid).claimableCount()).isEqualTo(1);
        assertThat(missionService.claim(uid, id).claimed().amount()).isEqualTo(100);
        assertThat(jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?")
                .param(uid).query(Long.class).single()).isEqualTo(before + 100);
    }
}
