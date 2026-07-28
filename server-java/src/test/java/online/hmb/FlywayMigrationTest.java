package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import jakarta.annotation.Resource;

/** Flyway V1__init.sql + V2__phase2.sql이 ERD DDL 그대로 깨끗하게 적용되는지(24개 테이블) 검증. */
@SpringBootTest
class FlywayMigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    private static final List<String> EXPECTED_TABLES = List.of(
            // V1 (17)
            "players", "users", "sessions", "wallets", "point_ledger", "user_players",
            "decks", "deck_slots", "prompt_presets", "gacha_pulls", "gacha_results",
            "bots", "matches", "match_prompts", "match_halves", "ai_jobs", "meta_kv",
            // V2 phase2 (7)
            "team_presets", "player_relations", "team_morale",
            "trade_slots", "trade_log", "league_seasons", "league_fixtures",
            // V5 p3 admin (1) — V4 는 컬럼 추가만이라 테이블 목록 불변
            "admin_audit",
            // V8 growth (1) — #179 성장 정산 멱등. V6/V7 은 컬럼·인덱스 추가만이라 테이블 목록 불변
            "growth_applied",
            // V9 메이플 피벗(3) — #179 V2: 잠재능력·다이스 인벤·다이스 롤 감사로그
            "card_potentials", "user_dice", "dice_rolls",
            // V10 재화 이원화(1) — V2.2: 젬 원장(point_ledger 동형). wallets.gems 는 컬럼 추가라 목록 불변
            "gem_ledger",
            // V14 어드민 유닛 카탈로그(1) — #207: 카탈로그 변경 이력 원장.
            // players.active/admin_locked 는 컬럼 추가라 목록 불변.
            "admin_catalog_audit",
            // V16 경제 정돈(1) — #212: 지갑 리스케일/젬 백필을 1회로 가두는 마커(데이터 테이블 아님)
            "economy_rescale_v16",
            // V17 스타터 개편(1) — #209: 가입 시 지급한 최상위 유닛 박제(연출이 읽는다).
            //   users.tutorial_done 은 컬럼 추가라 목록 불변
            "starter_grants",
            // V18 무배포 운영(1) — #209 B안: admin 운영 액션 감사 원장(성공·실패 모두)
            "admin_ops_audit",
            // V20 덱 저장 선실행(1) — #215 W2: 유저당 유효 prewarm A 원장(잡 id 는 내용 해시라
            //   유저 간 공유되므로 "누가 무엇을 기다리는가"를 잡 테이블이 알 수 없다).
            //   V19 는 #217(매치 잠금) 소유 — 번호만 앞서고 이 목록엔 그쪽이 등록한다.
            "deck_prewarm",
            // V21 원정(4) — #245: 실유저 팀을 상대로 하는 비동기 대전과 그 기록.
            //   away_challenges = "이 매치의 상대가 누구의 팀이었나"(matches.user_id 는 공격자다)
            //   away_reports    = 피원정 기록(수비자 관점) + 미확인 상태(seen_at) = 로비 팝업의 SoT
            //   user_ratings/rating_ledger = wallets.points 와 **다른 축**(소비되는 재화로는 실력을
            //     말할 수 없다). 초기 0, 하한 없음 — CHECK(>=0) 이 없는 것이 wallets 와의 차이다.
            "away_challenges",
            "away_reports",
            "user_ratings",
            "rating_ledger",
            // V22 원정 v2(4) — #245 hero 3차: 2택 제시·연승·주간 시즌.
            //   away_offers = "서버가 방금 무엇을 제시했나"(이게 없으면 2택이 곧 지목이 된다)
            //   away_streaks = 연승(승 +1 · 패 0 · 무 유지)
            //   away_seasons/away_season_results = 주간 시즌과 마감 스냅샷. 레이팅을 0 으로 되돌리는
            //     순간 그 시즌 결과는 어디에도 없으므로, 스냅샷이 보상 지급의 유일한 근거다.
            "away_offers",
            "away_streaks",
            "away_seasons",
            "away_season_results"
    );

    @Test
    void migrationCreatesAllErdTables() {
        List<String> tables = jdbcClient.sql(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
                                + "AND name NOT LIKE 'flyway_%'")
                .query(String.class)
                .list();

        assertThat(tables).containsExactlyInAnyOrderElementsOf(EXPECTED_TABLES);
    }

    @Test
    void foreignKeysAndWalPragmasAreEnabled() {
        Integer fkEnabled = jdbcClient.sql("PRAGMA foreign_keys").query(Integer.class).single();
        String journalMode = jdbcClient.sql("PRAGMA journal_mode").query(String.class).single();

        assertThat(fkEnabled).isEqualTo(1);
        assertThat(journalMode).isEqualToIgnoringCase("wal");
    }
}
