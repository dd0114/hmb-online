package online.hmb.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Map;
import java.util.function.Supplier;
import online.hmb.common.Ulid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * <b>비즈니스 이벤트 기록기</b>(#492) — "계측은 절대 게임을 방해하지 않는다"를 <b>구조로</b> 보장한다.
 *
 * <h3>⚠️ 이 리포에서 try/catch 는 "best effort" 를 만들지 못한다</h3>
 * 이 코드베이스엔 {@code @Transactional} 이 하나도 없고 트랜잭션은
 * {@link online.hmb.common.TxRunner}(TransactionTemplate, <b>PROPAGATION_REQUIRED</b>)로 명시적이다.
 * {@code txRunner.run(...)} 람다 <b>안</b>에서 INSERT 가 실패하면 그 예외를 여기서 삼켜도
 * <b>바깥 트랜잭션이 같이 롤백</b>되고, SQLite 는 실패한 statement 가 트랜잭션을 오염시킬 수 있다.
 * 즉 <b>본 동작이 깨진다</b>.
 *
 * <p>그래서 무영향은 세 층으로 건다:
 * <ol>
 *   <li><b>훅 위치</b>(1차·구조) — 모든 호출부는 비-tx 경계다. 매치 종료만 값이 tx 안에서 정해지므로
 *       {@code MatchOrchestrator.settleFinishedIfDue} 의 <b>커밋 후</b>에 부른다.
 *       계약 = {@code BusinessEventHookPlacementTest}(소스 스캔).</li>
 *   <li><b>런타임 게이트</b>(2차·이 클래스) — 그래도 트랜잭션 안에서 불리면 <b>쓰지 않고 경고만</b>
 *       한다({@link #record}). 잘못 배치된 훅이 조용히 게임을 깨뜨리는 대신 <b>이벤트가 비는 것</b>으로
 *       드러나고, 그건 AC2 의 건수 단언이 잡는다. 소스 스캔이 잡지 못하는 형태(런타임 호출 체인이
 *       tx 안으로 들어가는 경우)의 마지막 방어선이다.</li>
 *   <li><b>예외 봉인</b>(3차) — {@link #record}·{@link #probe} 는 {@code RuntimeException} 을 전부
 *       삼키고 {@code log.warn} 만 한다(선례: {@code RewardBundleService}). <b>props 를 만드는 것도</b>
 *       봉인 안이다 — 그래서 인자가 {@link Supplier} 다(호출부에서 값 하나 조회하다 던지면 그것만으로
 *       본 동작이 깨진다).</li>
 * </ol>
 *
 * <p><b>롤백 스위치</b> = {@code hmb.events.enabled: false}. 코드 변경 없이 계측 전체를 끈다
 * (그 상태에서 {@link #probe} 는 조회조차 하지 않는다 = 오버헤드 0).
 */
@Component
public class BusinessEventRecorder {

    private static final Logger log = LoggerFactory.getLogger(BusinessEventRecorder.class);

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final boolean enabled;

    public BusinessEventRecorder(JdbcClient jdbcClient,
                                 ObjectMapper objectMapper,
                                 @Value("${hmb.events.enabled:true}") boolean enabled) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.enabled = enabled;
    }

    public boolean enabled() {
        return enabled;
    }

    /**
     * 이벤트 1행 append. <b>절대 예외를 던지지 않는다</b> — 호출부는 반환값도 보지 않는다.
     *
     * @param props 지연 생성(이 람다 안에서 던져도 본 동작은 무사하다). null 이면 props_json = NULL.
     */
    public void record(String event, String userId, Supplier<Map<String, Object>> props) {
        if (!enabled || event == null || userId == null) {
            return;
        }
        try {
            // 2차 방어(위 클래스 주석): 트랜잭션 안이면 **쓰지 않는다**. 여기서 INSERT 하면 실패 시
            // 바깥 tx 가 같이 롤백된다 = 계측이 게임을 깨뜨린다. 훅이 잘못 놓였다는 신호이므로
            // 삼키지 말고 warn 으로 올린다(빈 이벤트는 AC2 의 건수 단언이 잡는다).
            if (TransactionSynchronizationManager.isActualTransactionActive()) {
                log.warn("business event '{}' 를 트랜잭션 안에서 기록하려 했다 — 건너뛴다(훅을 비-tx 경계로 "
                        + "옮겨야 한다: #492 무영향 규칙)", event);
                return;
            }
            String json = props == null ? null : toJson(props.get());
            jdbcClient.sql("""
                            INSERT INTO business_events(id, event, user_id, occurred_at, props_json)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(Ulid.next(), event, userId, Instant.now().toString(), json)
                    .update();
        } catch (RuntimeException e) {
            // 계측은 표시용이다 — 실패가 가입·저장·뽑기·정산을 되돌리면 안 된다.
            log.warn("business event 기록 실패 event={} user={}: {}", event, userId, e.toString());
        }
    }

    /** props 가 이미 값으로 있는 경우의 편의 오버로드. */
    public void record(String event, String userId, Map<String, Object> props) {
        record(event, userId, () -> props);
    }

    /**
     * <b>유저당 1행만</b> 남기는 append (#496). 멱등 엔드포인트의 재호출이 스트림을 도배하지 않게 한다.
     *
     * <p>대상은 <b>"한 번뿐인 사건"</b>이다 — {@code tutorial_complete} 처럼 엔드포인트가 멱등이라
     * 몇 번을 불러도 같은 사실을 말하는 것. 반복이 의미를 갖는 이벤트({@code deck_save}·
     * {@code gacha_pull}·{@code match_*})에 쓰면 <b>기록이 사라진다</b>.
     *
     * <h3>왜 게이트를 스트림 쪽에 두나 (플래그가 아니라)</h3>
     * "{@code users.tutorial_done} 이 0 → 1 로 바뀌는 순간에만 기록"으로도 재호출은 막힌다. 그러나
     * {@link #record} 는 예외를 전부 삼키는 best-effort 라 <b>첫 기록이 실패하는 경로가 실재</b>하고,
     * 그때 플래그는 이미 1 이라 <b>영영 기록되지 않는다</b> — 퍼널이 그 유저를 "튜토리얼 미도달"로
     * 오독하게 되고, 하필 그게 이 계측의 1급 지표다. 결과물(스트림)을 보면 <b>자가 치유</b>한다:
     * 행이 없으면 다음 호출이 남긴다.
     *
     * <p><b>실패는 fail-open</b> — 중복 검사 쿼리가 던지면 {@link #probe} 가 {@code false} 를 돌려
     * 그냥 기록한다. 잡음 제거는 부가 목적이고 <b>이벤트를 잃지 않는 것</b>이 본 목적이다.
     * 계측이 꺼져 있으면({@code hmb.events.enabled=false}) 이 조회조차 돌지 않는다(probe 의 성질).
     *
     * <p>⚠️ 경합(같은 유저의 동시 요청 2건)에서는 2행이 날 수 있다 — 검사와 INSERT 가 원자적이지
     * 않다. 유니크 인덱스로 막지 <b>않는다</b>: 그건 INSERT 를 실패시키는데 이 표는 "기록 실패가
     * 본 동작을 깨지 않는다"를 위해 CHECK·FK 도 일부러 안 건 append-only 표다(V42). 목적이
     * 정합성이 아니라 <b>가독성</b>이라 드문 중복 1행은 수용한다.
     */
    public void recordOnce(String event, String userId, Supplier<Map<String, Object>> props) {
        if (!enabled || event == null || userId == null) {
            return;
        }
        boolean already = probe(() -> Boolean.TRUE.equals(
                jdbcClient.sql("SELECT EXISTS(SELECT 1 FROM business_events WHERE event = ? AND user_id = ?)")
                        .params(event, userId)
                        .query(Boolean.class)
                        .single()), false);
        if (already) {
            return;
        }
        record(event, userId, props);
    }

    /**
     * <b>계측 전용 사전 조회</b>. 이벤트 props 중에는 본 동작 <b>전</b>에만 알 수 있는 것이 있다
     * (덱이 새로 생겼나 · 리그 시즌이 새로 생겼나). 그 조회를 호출부에서 맨몸으로 하면
     * <b>계측 때문에 본 동작이 실패</b>할 수 있다 — 그래서 여기로 감싼다.
     *
     * @return 조회 성공값, 실패하거나 계측이 꺼져 있으면 {@code fallback}
     */
    public <T> T probe(Supplier<T> read, T fallback) {
        if (!enabled) {
            return fallback;   // 롤백 스위치가 꺼져 있으면 추가 쿼리도 돌지 않는다
        }
        try {
            return read.get();
        } catch (RuntimeException e) {
            log.warn("business event 사전 조회 실패 — 기본값 사용: {}", e.toString());
            return fallback;
        }
    }

    /**
     * 직렬화 실패로 이벤트를 통째로 버리지 않는다 — "무슨 일이 있었나"가 속성보다 중요하다.
     *
     * <p>⚠️ 그렇다고 <b>속성 전부를 버려서도 안 된다</b>(AC7 패널 5R 엣지케이스 렌즈). 퍼널은
     * {@code match_start} 의 {@code props.mode} 로 practice/league/away 를 가르므로, props 를 통째로
     * NULL 로 낮추면 <b>그 유저가 그 모드를 안 해본 것처럼 보인다</b> — 하필 hero 의 1급 지표가
     * 거짓이 되는 방향이다. 그래서 한 번 더 시도한다: <b>스칼라만 남겨</b> 재직렬화한다.
     * 퍼널·필터가 읽는 값(mode·matchId·result…)은 전부 스칼라라, 이상한 값 하나가 섞여도
     * <b>판독에 쓰이는 속성은 살아남는다</b>.
     */
    private String toJson(Map<String, Object> props) {
        if (props == null || props.isEmpty()) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(props);
        } catch (Exception e) {
            log.warn("business event props 직렬화 실패 — 스칼라만 남겨 재시도: {}", e.toString());
            return scalarFallback(props);
        }
    }

    /** 1차 직렬화가 실패했을 때의 축소 시도. 이것마저 실패하면 그때 속성을 포기한다. */
    private String scalarFallback(Map<String, Object> props) {
        Map<String, Object> safe = new java.util.LinkedHashMap<>();
        props.forEach((k, v) -> {
            if (v == null || v instanceof String || v instanceof Number || v instanceof Boolean) {
                safe.put(k, v);
            }
        });
        if (safe.isEmpty()) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(safe);
        } catch (Exception e) {
            log.warn("business event props 축소 직렬화도 실패 — 속성 없이 기록: {}", e.toString());
            return null;
        }
    }
}
