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
            "away_season_results",
            // V25 다이스 구매 제거(1) — #247: 소각한 재고를 박제(보상 요구 시 근거·롤백 여유).
            //   user_dice 는 V10 선례대로 **드롭하지 않고** 코드 참조만 끊었다 → 위 목록에 그대로 남는다.
            //   ⚠️ 번호는 V21 로 만들었다가 #245(원정 V21/V22)·#253/#254(V23/V24)와 충돌해 **V25 로
            //   리넘버**했다. 아직 배포되지 않은 마이그레이션이라 리넘버가 안전하다.
            "dice_burned",
            // V26 공지사항(1) — #248: 홈 팝업 공지. 운영자가 만드는 데이터 그 자체라 economy 처럼
            //   발행물+override 2층이 아니라 DB 가 SoT 다(쓰면 곧 다음 조회에 반영).
            //   ⚠️ 번호 이력: V23 → V25 → **V26**. 머지 대기 중에 #245(V21/V22)·#253/#254(V23/V24)·
            //   #247(V25)이 차례로 앞 번호를 가져갔다. 번호를 사람이 기억하지 않도록 결번·중복은
            //   FlywayVersionContinuityTest 가 기계로 막는다(주석에 의존하지 않는다).
            "notices",
            // V30 공지 이미지(1) — #309 W1: 공지 텍스트는 이미 무배포인데 **그림만 웹 배포에**
            //   묶여 있었다. 바이트는 도커 볼륨(SQLite 와 같은 볼륨 = 백업 대상 하나)에, 메타·노출
            //   스위치·감사가 이 표에 산다. ⚠️ 삭제 컬럼이 없다 — 내리기는 active 스위치로만
            //   (hero 확정: 삭제는 오조작이 곧 영구 소실이라 되돌릴 수 없다).
            "notice_assets",
            // V31 유닛 아트 번들(1) — #309 W2: 유닛 **등록**은 이미 무배포였고(#207 파트 A) 남은
            //   배포 의존은 **아트**였다(아틀라스 PNG·매니페스트 3종·player-chars 매핑이 웹 빌드에
            //   구워져 있었다). 리비전을 쌓고 활성 포인터만 옮긴다 — 전부 끄면 구운 폴백으로 롤백.
            //   ⚠️ 활성 최대 하나는 **부분 유니크 인덱스**가 강제한다(코드로만 지키면 동시 활성화
            //   두 건이 "새로고침마다 아트가 바뀌는" 상태를 만든다).
            "char_bundles",
            // V33 우편함(2) — #323: 발송 1건 = mail_campaigns 1행(본문·첨부·대상·만료가 여기 하나에),
            //   유저 × 캠페인 = user_mails 1행(**상태만** 산다). ⚠️ **지급 원장을 새로 만들지 않았다** —
            //   G 는 point_ledger, Z 는 gem_ledger, 카드는 user_players 가 계속 SoT 이고 수령이
            //   `ref_id = user_mails.id` 로 기존 멱등 인덱스에 얹힌다. 우편함이 자기 원장을 가지면
            //   "이 유저의 골드가 왜 늘었나"의 답이 두 곳이 된다.
            "mail_campaigns",
            "user_mails",
            // V36 리그 매판 일일 보상 트랙 — #368: 칸(그날 KST n번째 리그 경기) 하나 = 1행.
            //   **지급 원장을 새로 만들지 않았다** — 돈은 gem_ledger/point_ledger 로 나가고
            //   (reason='league_daily_gem|point', ref_id=match_id) 기존 멱등 인덱스에 얹힌다.
            //   이 표가 사는 이유는 지급이 아니라 **박제**다: 금액·칸수·대량위치가 전부 economy
            //   노브라, 읽을 때 재계산하면 노브를 돌리는 순간 오늘 받은 이력이 소급 변조된다.
            "league_daily_rewards",
            // #383 라이브 계수 오버레이 원장(V37). append-only — 매치가 config_revision_id 로 가리킨다.
            "engine_config_revisions",
            // #405 성장 계수 오버레이 원장(V38). V37 과 동형 — append-only, seq 정렬이 곧 "현재 값".
            "growth_config_revisions"
    );

    /**
     * V37 은 <b>스키마 모양 자체가 결정</b>이다(#383 독립검증 m2). 테이블 이름만 세면 그 결정이
     * 계약에 안 잡힌다 — "현재 리비전 = 마지막으로 삽입된 행"이라는 동작이 PK 종류에 달려 있고,
     * 지운 인덱스는 <b>코드가 의도적으로 기각한 정렬</b>이라 되살아나면 안 된다.
     *
     * <p>동작 계약({@code EngineConfigSnapshotTest.sameMillisecondRevisionsStillOrderByInsertion})이
     * 이미 변이체를 죽이지만, 그건 "정렬이 맞나"를 보고 이건 "그 정렬을 <b>가능하게 하는 구조</b>가
     * 남아 있나"를 본다. 누군가 PK 를 되돌리면 여기서 이름을 짚어 깨진다.
     */
    @Test
    void engineConfigRevisionsKeepsTheOrderingSchemaItDependsOn() {
        String ddl = jdbcClient
                .sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='engine_config_revisions'")
                .query(String.class).single();

        assertThat(ddl.replaceAll("\\s+", " "))
                .as("PK 가 단조 증가 정수여야 한다 — ULID 는 같은 ms 안에서 난수가 순서를 정한다")
                .contains("seq INTEGER PRIMARY KEY AUTOINCREMENT");
        assertThat(ddl.replaceAll("\\s+", " "))
                .as("ULID 는 매치가 가리키는 값이라 여전히 유일해야 한다")
                .contains("id TEXT NOT NULL UNIQUE");

        List<String> indexes = jdbcClient.sql(
                        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='engine_config_revisions' "
                                + "AND name NOT LIKE 'sqlite_%'")
                .query(String.class).list();
        assertThat(indexes)
                .as("멱등 백스톱은 남아 있어야 한다")
                .contains("uq_engine_config_rev_idem");
        assertThat(indexes)
                .as("(created_at, id) 인덱스를 되살리지 마라 — 코드가 기각한 정렬을 스키마가 광고하면 "
                        + "다음 사람이 그걸 근거로 정렬을 되돌린다(m9)")
                .doesNotContain("idx_engine_config_rev_time");
    }

    /**
     * V38 도 <b>스키마 모양 자체가 결정</b>이다 — V37 과 같은 이유로 같은 구조를 골랐으므로
     * (같은 밀리초 동률에서 롤백이 무시되는 것을 막는 {@code seq}) 같은 계약을 건다.
     * 성장 계수는 정산이 근거로 가리키는 값이라 "현재 = 마지막 삽입"이 흔들리면 안 된다.
     */
    @Test
    void growthConfigRevisionsKeepsTheOrderingSchemaItDependsOn() {
        String ddl = jdbcClient
                .sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='growth_config_revisions'")
                .query(String.class).single();

        assertThat(ddl.replaceAll("\\s+", " "))
                .as("PK 가 단조 증가 정수여야 한다 — ULID 는 같은 ms 안에서 난수가 순서를 정한다")
                .contains("seq INTEGER PRIMARY KEY AUTOINCREMENT");
        assertThat(ddl.replaceAll("\\s+", " "))
                .as("리비전 id 는 정산 리포트가 가리키는 값이라 유일해야 한다")
                .contains("id TEXT NOT NULL UNIQUE");
        assertThat(ddl.replaceAll("\\s+", " "))
                .as("사유 없는 이력은 이력이 아니다")
                .contains("reason TEXT NOT NULL");

        List<String> indexes = jdbcClient.sql(
                        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='growth_config_revisions' "
                                + "AND name NOT LIKE 'sqlite_%'")
                .query(String.class).list();
        assertThat(indexes)
                .as("멱등 백스톱(부분 유니크)이 없으면 같은 키 동시 PUT 이 '현재 값'을 경합에 맡긴다")
                .contains("uq_growth_config_rev_idem");
    }

    /**
     * ⚠️ V38 은 <b>{@code user_players} 를 건드리지 않는다</b>. 성장 스키마 변경(소수 상승분 저장·
     * 소급 지급)은 백업·백필과 한 세트여야 해서 W2b 소관이고, 이 웨이브만 적용해도 서버가 그대로
     * 떠야 한다. 그 경계를 문장이 아니라 계약으로 박아 둔다 — 나중에 여기에 컬럼을 몰래 얹으면
     * 백필 없이 배포되는 길이 열린다.
     */
    @Test
    void v38DoesNotTouchUserPlayers() {
        // 주석은 코드가 아니다 — 이 마이그레이션의 주석이 바로 그 경계를 설명하고 있다.
        String migration = readMigration("V38__growth_config_overrides.sql")
                .replaceAll("--[^\n]*", "");
        assertThat(migration.toLowerCase(java.util.Locale.ROOT))
                .as("V38 은 오버레이 원장만 만든다 — user_players 변경은 W2b(백업·백필과 한 세트)")
                .doesNotContain("user_players");
    }

    private static String readMigration(String name) {
        try {
            return java.nio.file.Files.readString(
                    java.nio.file.Path.of("src/main/resources/db/migration", name));
        } catch (java.io.IOException e) {
            throw new IllegalStateException("마이그레이션을 읽지 못했다: " + name, e);
        }
    }

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
