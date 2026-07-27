package online.hmb.auth;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import online.hmb.catalog.EconomyService;
import online.hmb.common.Hashes;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.match.RelationService;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 신규 유저 온보딩 단일 SoT — 어떤 인증 공급자로 가입하든 <b>동일한 결과</b>를 보장한다
 * (users + wallets + 스타터 팩 user_players + 원장 'starter' + 관계 초기화, 전부 같은 트랜잭션).
 *
 * <p>P3 §A(자체 로그인) 도입 시 {@link MockOAuthProvider} 의 신규유저 생성 로직을 여기로 추출했다 —
 * {@link LocalAuthProvider} 가 온보딩을 재구현하지 않도록(중복 구현 금지). 동작은 추출 이전과 동일하다
 * (AC-S1 스타터팩·AC-C4 관계 초기화 테스트로 증명).
 */
@Service
public class UserOnboardingService {

    private static final Logger log = LoggerFactory.getLogger(UserOnboardingService.class);

    /** 원장 사유 — ERD point_ledger.reason 주석의 열거값. */
    public static final String LEDGER_REASON_STARTER = "starter";

    /** gem_ledger 사유 — 가입 젬 지급(#212). 기존 유저 백필(Flyway V14)도 같은 사유·ref 를 쓴다. */
    public static final String LEDGER_REASON_INITIAL_GEMS = "initial_gems";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final EconomyService economyService;
    private final WalletService walletService;
    private final RelationService relationService;
    private final AccountLookup accounts;

    public UserOnboardingService(JdbcClient jdbcClient,
                                 TxRunner txRunner,
                                 EconomyService economyService,
                                 WalletService walletService,
                                 RelationService relationService,
                                 AccountLookup accounts) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.economyService = economyService;
        this.walletService = walletService;
        this.relationService = relationService;
        this.accounts = accounts;
    }

    /**
     * 신규 유저 생성(하나의 트랜잭션). 트랜잭션 안에서 닉네임을 재확인해 동시 가입 경합이면
     * {@link OnboardingResult.AlreadyExists} 를 돌려준다 — <b>여기서 인증 결과를 만들지 않는다</b>.
     *
     * <p><b>이 메서드가 {@link AuthResult} 를 반환하지 않는 이유</b>(구조적 결정): 예전에는 tx 내부
     * 재확인이 기존 유저를 곧바로 {@code AuthResult(isNew=false)} 로 반환했고, 그게 자격 검사를
     * 우회하는 <b>세 번째 출구</b>였다(동시 가입 인터리빙에서 비번 걸린 계정의 세션이 발급됨).
     * 반환 타입을 sealed {@link OnboardingResult} 로 좁혀, 온보딩 계층이 "로그인 성공"을
     * <b>타입상 표현할 수 없게</b> 만들었다. 기존 계정을 인증 결과로 바꾸는 일은
     * {@link CredentialGate} 만 할 수 있고, 호출자는 컴파일러가 두 경우를 모두 다루도록 강제한다.
     *
     * @param password 자체 로그인 비번(평문 목업, P3-D2). 다른 provider 는 {@code null}.
     */
    public OnboardingResult createUser(String nickname, String provider, String password) {
        return txRunner.run(() -> {
            Optional<AccountLookup.Account> raced = accounts.findByNickname(nickname);
            if (raced.isPresent()) {
                return new OnboardingResult.AlreadyExists(raced.get());
            }

            String userId = Ulid.next();
            String now = Instant.now().toString();

            // password 는 평문 목업(P3-D2) — 해시 전환은 백로그. 절대 로깅하지 않는다(AC-A2).
            jdbcClient.sql("""
                            INSERT INTO users(id, nickname, auth_provider, password, created_at)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(userId, nickname, provider, password, now)
                    .update();

            jdbcClient.sql("INSERT INTO wallets(user_id, points) VALUES (?, 0)")
                    .param(userId)
                    .update();

            grantStarterPack(userId, now);

            // AC-C4: 관계 초기화(team_morale + 보유 선수 신뢰도 기본 행) — 스타터 팩 지급 직후 같은 tx.
            relationService.initForUser(userId);

            return new OnboardingResult.Created(userId);
        });
    }

    /**
     * 온보딩 시도 결과. sealed 라 호출자가 두 경우를 모두 처리해야 하고, 어느 쪽도 그 자체로는
     * 인증 결과가 아니다 — 세션으로 가려면 반드시 {@link CredentialGate} 또는 신규 생성 경로를 거친다.
     */
    public sealed interface OnboardingResult {

        /** 이 요청이 실제로 유저를 만들었다(스타터 팩·지갑·관계 포함). */
        record Created(String userId) implements OnboardingResult {
        }

        /** 경합에서 졌다 — 닉네임을 이미 다른 요청이 선점했다(자격 검사는 호출자 관문에서). */
        record AlreadyExists(AccountLookup.Account account) implements OnboardingResult {
        }
    }

    /**
     * 스타터 팩 지급 — 신규 유저 생성 트랜잭션의 일부(같은 tx, 실패 시 전체 롤백).
     * 수치·구성은 economy.v1.json에서만 온다(AC-S5). 원장 ref=userId라 재실행돼도 멱등.
     *
     * <p>#209: 구성이 "고정 14장"에서 <b>기본팩(SILVER/BRONZE) + 최상위 1장</b>으로 바뀌었다.
     * 최상위는 {@code economy.starterTop.pool} 에서 {@link #pickStarterTop} 이 시드 결정론으로 고른다.
     */
    private void grantStarterPack(String userId, String now) {
        Optional<EconomyService.Economy> economyOpt = economyService.get();
        if (economyOpt.isEmpty()) {
            log.warn("economy config unavailable — user {} created WITHOUT starter pack", userId);
            return;
        }
        EconomyService.Economy economy = economyOpt.get();

        for (String playerId : economy.starterPack()) {
            // 최상위와 같은 이유의 방어선(BLK-1) — 기본팩은 **모든 가입이 지나가는 경로**라
            // 여기서 FK 가 터지면 신규 유저가 한 명도 못 들어온다. 한 장을 건너뛰는 편이 낫다.
            if (!playerExists(playerId)) {
                log.warn("starterPack id {} is not in the catalog — skipping it for user {}", playerId, userId);
                continue;
            }
            grantCard(userId, playerId, now);
        }

        for (String topPlayerId : pickStarterTop(userId, economy.starterTop())) {
            // 방어선(#209 B안 독립검증 BL-2): 설정에 카탈로그에 없는 id 가 들어와 있으면 INSERT 가
            // FK 로 터져 **가입 트랜잭션 전체가 죽는다**(신규 유저가 아무도 못 들어온다). 운영 API 가
            // 앞단에서 막지만, 그 앞단을 우회한 파일(수동 편집·구버전)이 있어도 여기서는 최상위 한 장을
            // 조용히 건너뛸 뿐 가입은 성공해야 한다 — 지급 누락이 서비스 중단보다 낫다.
            if (!playerExists(topPlayerId)) {
                log.warn("starterTop id {} is not in the catalog — skipping the top grant for user {}",
                        topPlayerId, userId);
                continue;
            }
            grantCard(userId, topPlayerId, now);
            // 지급 사실을 박제한다 — 후보 목록은 데이터라 나중에 갈아끼워지고(#207), 그러면
            // 같은 userId 를 재계산해도 과거 지급을 복원할 수 없다(연출이 읽는 값이다).
            jdbcClient.sql("""
                            INSERT OR IGNORE INTO starter_grants(user_id, player_id, granted_at)
                            VALUES (?, ?, ?)
                            """)
                    .params(userId, topPlayerId, now)
                    .update();
            log.info("starter top unit granted: user={} player={}", userId, topPlayerId);
        }

        walletService.apply(userId, economy.initialPoints(), LEDGER_REASON_STARTER, userId);
        // #212: 젬 수급원은 가입 지급 + 리그 입상 둘뿐(목업 충전 폐지) — 가입분을 여기서 지급한다.
        // 원장 ref=userId 라 재실행돼도 멱등. 0이면 지급 자체를 건너뛴다(구 economy 파일 호환).
        if (economy.initialGems() > 0) {
            walletService.applyGems(userId, economy.initialGems(), LEDGER_REASON_INITIAL_GEMS, userId);
        }
    }

    private boolean playerExists(String playerId) {
        Long count = jdbcClient.sql("SELECT COUNT(*) FROM players WHERE id = ?")
                .param(playerId).query(Long.class).single();
        return count != null && count > 0;
    }

    private void grantCard(String userId, String playerId, String now) {
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, 1, ?)
                        """)
                .params(userId, playerId, now)
                .update();
    }

    /**
     * 가입 지급의 최상위 유닛 선택 (#209 AC1) — <b>시드 결정론</b>: 같은 userId 면 언제·몇 번
     * 돌려도 같은 결과다({@code Math.random}·시계 의존 0, 재현 가능).
     *
     * <p>시드는 {@code sha256(userId + ":starterTop")} 의 상위 8 hex → pool 크기로 나눈 나머지.
     * userId 는 ULID(생성 시각+엔트로피)라 계정마다 다르고, 해시를 한 번 거치므로 ULID 의
     * 시간 접두사가 만드는 인접 계정 간 쏠림도 흩어진다.
     *
     * <p>{@code count > 1} 이면 pool 을 같은 시드로 회전시켜 중복 없이 앞에서부터 뽑는다.
     * 설정이 없으면(구 economy 파일) 빈 목록 = 기본팩만 지급.
     */
    public static List<String> pickStarterTop(String userId, EconomyService.StarterTop starterTop) {
        if (starterTop == null || starterTop.pool().isEmpty() || starterTop.count() <= 0) {
            return List.of();
        }
        List<String> pool = starterTop.pool();
        int start = (int) Long.remainderUnsigned(
                Long.parseUnsignedLong(Hashes.sha256Hex(userId + ":starterTop").substring(0, 8), 16),
                pool.size());
        int count = Math.min(starterTop.count(), pool.size());
        List<String> picked = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            picked.add(pool.get((start + i) % pool.size()));
        }
        return List.copyOf(picked);
    }
}
