package online.hmb.admin;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * <b>부팅 시 구조 검사</b> — "게이트를 지나지 않는 admin 엔드포인트"가 존재할 수 없게 만드는 마지막 조각.
 *
 * <p>{@link AdminInterceptor} 는 경로 패턴 {@code /api/admin/**} 에 걸려 있다. 따라서 그 접두사
 * <b>안</b>의 핸들러는 몇 개가 되든 자동으로 게이트를 지난다(열거하지 않으므로 빠뜨릴 수 없다).
 * 남는 구멍은 하나뿐 — <b>admin 기능을 그 접두사 밖에 매핑하는 것</b>. 이 러너가 그걸 막는다.
 *
 * <p><b>판정 기준이 "패키지"가 아니라 "의존성"인 이유(검증자 M10 에서 실제로 뚫렸다)</b>:
 * 이전 구현은 {@code online.hmb.admin} 패키지의 핸들러만 검사했다. 그래서 검증자가
 * {@code online.hmb.meta} 에 {@code @GetMapping("/api/ops/roster")} 를 만들고 그 안에서
 * {@link AdminUserQueryService} 를 호출하자 <b>부팅도 성공하고 전 테스트도 green 인데</b>
 * 일반 유저 토큰으로 전체 유저 명단이 200 으로 새어 나왔다. 패키지 규약은 <b>다음 사람이 모르면 깨진다</b> —
 * 규약 준수를 전제로 한 "구조적 보장"은 보장이 아니다.
 *
 * <p>그래서 기준을 뒤집었다: <b>admin 전용 서비스 빈에 (전이적으로) 의존하는 핸들러는 어느 패키지에
 * 있든 반드시 {@code /api/admin/} 접두사 안에 있어야 한다</b>. 이제 "admin 데이터를 만지는 것"이
 * 곧 판정 근거이므로, 컨트롤러를 어디에 두든 admin 기능을 게이트 밖으로 낼 수 없다. 위반하면 부팅이 죽는다.
 *
 * <p>판정은 <b>두 시드의 합집합</b>에서 출발해 전이 확장한다:
 * <ol>
 *   <li><b>런타임 의존 그래프</b>({@code getDependentBeans}) — 구상 타입 주입은 래퍼를 몇 겹 씌워도 잡힌다.</li>
 *   <li><b>정적 타입 스캔</b> — 생성자·필드·메서드 파라미터의 <b>제네릭 인자까지</b> 펼쳐 admin 타입 참조를 찾는다.
 *       {@code ObjectProvider<AdminUserQueryService>} 처럼 <b>지연 조회 주입은 의존 그래프에 엣지를 남기지
 *       않아</b> ①만으로는 통과했다(검증자 M15 가 이걸로 뚫었다 — 부팅 성공 + 전 테스트 green 인데
 *       일반 토큰으로 전체 유저 명단 200). {@code ObjectProvider} 는 스프링 표준 DI 관용구지
 *       우회 꼼수가 아니므로 반드시 덮어야 한다.</li>
 * </ol>
 *
 * <p><b>실제 사정거리(과장도 누락도 없이)</b>
 * <p><b>잡는다</b>: 구상 타입 직접 주입 / 구상 래퍼 N겹 / {@code ObjectProvider}·{@code ObjectFactory}·
 * {@code Optional}·{@code List}·{@code Map} 등 <b>선언부에 타입이 드러나는</b> 모든 주입 형태 —
 * 어느 패키지에 있든.
 *
 * <p><b>못 잡는다</b>(원리적 한계, 이슈로 관리):
 * <ul>
 *   <li><b>런타임 조회</b> — {@code ctx.getBean(AdminUserQueryService.class)},
 *       {@code beanFactory.getBean(...)}. 선언부에 admin 타입이 <b>안 나타나므로</b> 정적으로도
 *       의존 그래프로도 근거가 없다. 이걸 잡으려면 바이트코드 분석이 필요하다.</li>
 *   <li>admin 서비스를 쓰지 않고 {@code JdbcClient} 로 <b>직접 같은 SQL</b>을 짜 넣는 핸들러.
 *       "admin 기능"이라는 표식이 코드 어디에도 없어 정적 판정 근거가 없다
 *       ({@code AdminAccessSingleDecisionPointTest} 의 {@code is_admin} 소스 스캔이 <b>부분적으로만</b>
 *       보완한다 — {@code users}/{@code wallets} 를 그냥 SELECT 하는 핸들러는 거기서도 안 걸린다).</li>
 *   <li>정적 유틸이나 {@code new} 직접 생성으로 빈 그래프를 우회한 호출.</li>
 * </ul>
 * 즉 이 가드가 보장하는 것은 "<b>선언부에 드러나는 admin 빈 의존</b>은 게이트 밖으로 나갈 수 없다"이지,
 * "어떤 방법으로도 유저 데이터가 새지 않는다"가 아니다. 후자는 사정거리 밖이며
 * 코드리뷰·PRD-v4 §H 오픈 체크리스트가 담당할 영역이다.
 */
@Component
@org.springframework.core.annotation.Order(200)  // 마지막 — 라우팅이 모두 확정된 뒤 구조 검사.
public class AdminRouteGuard implements ApplicationRunner {

    /** 이 패키지 안의 핸들러는 (의존성과 무관하게) 반드시 admin 접두사 아래 있어야 한다. */
    static final String ADMIN_PACKAGE = AdminRouteGuard.class.getPackageName();

    /** 정적 스캔 대상 — 우리 코드만 본다(스프링/서드파티 빈까지 리플렉션하면 느리고 무의미하다). */
    private static final String APP_PACKAGE = "online.hmb";

    /**
     * <b>admin 전용 빈</b> — 이걸 (전이적으로) 주입받는 핸들러는 게이트 안에 있어야 한다.
     * admin 데이터/상태를 다루는 서비스를 새로 만들면 여기에 추가한다.
     *
     * <p><b>{@link AdminAccess} 가 여기 없는 이유</b>: {@code MeController} 가 게이트 밖
     * ({@code /api/me})에서 정당하게 쓰기 때문이다(web 의 /admin 메뉴 표시 힌트). 여기에 넣으면
     * {@code MeController} 가 위반으로 잡혀 부팅이 죽는다.
     *
     * <p>다만 위험도를 낮게 적으면 안 된다 — {@code AdminAccess.isAdmin(String userId)} 는
     * <b>임의 userId</b> 를 받으므로 "표시용 boolean"이 아니라 <b>임의 계정에 대한 admin 여부 오라클</b>이다
     * (검증자가 일반 토큰으로 {@code ?userId=<admin id>} → {@code true} 를 실측했다). 비번이 평문이고
     * 레이트리밋이 없는 현 상태에서 "누가 admin 인가"는 공격 표적을 특정해 준다.
     * 그래서 제외의 근거는 "안전해서"가 아니라 <b>호출처가
     * {@code AdminAccessSingleDecisionPointTest} 로 3개 파일에 고정돼 있어서</b>다 — 그 소스 스캔이
     * 실제로 우회 시도(M16)를 잡아냈다. 목록·잔액을 쥔 아래 두 빈과 달리 이 빈은 그 방식으로 관리한다.
     */
    private static final List<Class<?>> ADMIN_ONLY_BEANS = List.of(
            AdminUserQueryService.class,
            AdminPointsService.class,
            // #207: 유닛 카탈로그를 **쓰는** 서비스. 이게 게이트 밖에서 호출 가능해지면 일반 유저가
            // 카탈로그를 고칠 수 있다(가챠 풀·등급·스탯이 곧 게임 경제다). 읽기 전용
            // CatalogController(/api/players)는 이 빈에 의존하지 않으므로 영향이 없다.
            AdminCatalogService.class,
            // #209 B안. 이 목록에 빠지면 가드가 그 서비스를 "admin 데이터"로 보지 않아, 게이트 밖
            // (/api/ops/… 등)에 매핑해도 부팅이 통과한다 — 독립검증이 실제로 그 구멍을 뚫었다.
            // ⚠️ admin 상태를 다루는 서비스를 새로 만들면 반드시 여기에 추가한다
            //    (AdminGateTest.everyAdminPackageServiceIsSeededIntoTheGuard 가 누락을 잡는다).
            AdminEconomyService.class,
            // #248 공지 운영. 게이트 밖으로 나가면 아무나 전 유저에게 뜨는 팝업을 쓸 수 있다
            // (본문이 링크·이미지를 허용하므로 배포 표면이기도 하다). 읽기 전용 NoticeController
            // (/api/notices/active)는 이 빈이 아니라 NoticeService 에 의존하므로 영향이 없다.
            AdminNoticeService.class,
            // #309 공지 이미지 업로드. 게이트 밖으로 나가면 **아무나 우리 볼륨에 파일을 쓸 수 있다** —
            // 공지보다 위험도가 높다(디스크 소진 + 우리 도메인에서 서빙되는 임의 바이트).
            // 공개 서빙(GET /api/notices/assets/{id})은 NoticeAssetService/Storage 에만 의존하므로
            // 영향이 없다 — 그 방향(admin → notice)을 유지하는 것이 그 구조의 전부다.
            AdminNoticeAssetService.class,
            // #309 W2 아트 번들. 게이트 밖으로 나가면 아무나 **우리 도메인에서 서빙되는 파일 트리를
            // 통째로 갈아끼울 수** 있다(zip 해제 = 임의 경로 쓰기 시도의 입구이기도 하다).
            // 공개 서빙(GET /api/chars/**)은 CharBundleService/Storage 에만 의존하므로 영향이 없다.
            AdminCharBundleService.class,
            // #323 우편함 발송. 게이트 밖으로 나가면 **아무나 자기에게 보상을 발행할 수 있다** —
            // 이 목록에서 가장 직접적인 경제 표면이다(G·Z·카드가 한 요청에 나간다).
            // 유저 쪽 수령(MailService, /api/mails)은 이 빈에 의존하지 않으므로 영향이 없다.
            AdminMailService.class,
            // #383 계수 무배포 운영. 게이트 밖으로 나가면 **아무나 매치 엔진의 계수를 바꿀 수 있다** —
            // 경제 표면은 아니지만 게임 자체의 규칙이고, 검증 게이트를 통과한 값이라도 밸런스를
            // 임의로 흔든다. 진행 중 매치는 스냅샷이 막지만 **이후 생성되는 모든 매치**가 영향을 받는다.
            // 조회 전용 경로가 따로 없다(유저가 볼 값이 아니다) — 전부 이 빈 뒤에 있다.
            AdminEngineConfigService.class);

    private final RequestMappingHandlerMapping handlerMapping;
    private final ConfigurableApplicationContext context;

    public AdminRouteGuard(RequestMappingHandlerMapping handlerMapping, ConfigurableApplicationContext context) {
        this.handlerMapping = handlerMapping;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) {
        List<String> violations = findUngatedAdminRoutes();
        if (!violations.isEmpty()) {
            throw new IllegalStateException(
                    "admin 핸들러가 게이트 경로(" + AdminInterceptor.ADMIN_PATH_PATTERN + ") 밖에 매핑됐다 — "
                            + "AdminInterceptor 를 지나지 않는 admin API 가 된다. 위반: " + violations);
        }
    }

    /** 테스트에서도 같은 판정을 재사용할 수 있게 분리. */
    public List<String> findUngatedAdminRoutes() {
        Set<String> adminTainted = beansDependingOnAdminServices();
        List<String> violations = new ArrayList<>();

        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry : handlerMapping.getHandlerMethods().entrySet()) {
            HandlerMethod method = entry.getValue();
            boolean byPackage = inAdminPackage(method);
            boolean byDependency = dependsOnAdminBean(method, adminTainted);
            if (!byPackage && !byDependency) {
                continue;
            }
            for (String pattern : patternsOf(entry.getKey())) {
                if (!pattern.startsWith(AdminInterceptor.ADMIN_PATH_PREFIX)) {
                    violations.add(method.getBeanType().getSimpleName() + "#" + method.getMethod().getName()
                            + " -> " + pattern
                            + " (사유: " + (byDependency ? "admin 전용 서비스 빈에 의존" : "admin 패키지 소속") + ")");
                }
            }
        }
        return violations;
    }

    private boolean inAdminPackage(HandlerMethod method) {
        String pkg = method.getBeanType().getPackageName();
        return pkg.equals(ADMIN_PACKAGE) || pkg.startsWith(ADMIN_PACKAGE + ".");
    }

    private boolean dependsOnAdminBean(HandlerMethod method, Set<String> adminTainted) {
        for (String name : context.getBeanFactory().getBeanNamesForType(method.getBeanType())) {
            if (adminTainted.contains(name)) {
                return true;
            }
        }
        return false;
    }

    /**
     * admin 전용 빈에 <b>전이적으로</b> 의존하는 모든 빈 이름. 스프링이 오토와이어링 때 기록한
     * 의존 그래프({@code getDependentBeans})를 역방향으로 훑는다 — 컨트롤러가 래퍼를 한 겹 씌워도 잡힌다.
     *
     * <p>public 인 이유: 테스트가 "의존성 기준이 실제로 살아 있는가"를 직접 단정할 수 있어야 한다
     * (패키지 기준만 남고 의존성 기준이 죽어도 출하 코드에서는 증상이 안 보인다).
     */
    public Set<String> beansDependingOnAdminServices() {
        ConfigurableListableBeanFactory beanFactory = context.getBeanFactory();
        Set<String> tainted = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>();

        // ── 시드 ① 런타임 의존 그래프: admin 빈 자신 ──
        for (Class<?> adminBean : ADMIN_ONLY_BEANS) {
            for (String name : beanFactory.getBeanNamesForType(adminBean)) {
                if (tainted.add(name)) {
                    queue.add(name);
                }
            }
        }

        // ── 시드 ② 정적 타입 스캔: 선언부가 admin 타입을 참조하는 빈 ──
        // 왜 필요한가(검증자 M15): ObjectProvider<AdminUserQueryService> 같은 **지연 조회 주입**은
        // getDependentBeans 그래프에 **엣지를 남기지 않는다**. 그래서 시드 ①만으로는 admin 서비스를
        // 실제로 호출하는 컨트롤러가 오염 집합에 안 들어와, 게이트 밖 라우트가 부팅을 통과했다.
        // ObjectProvider 는 스프링 표준 DI 관용구지 우회 꼼수가 아니므로 반드시 덮어야 한다.
        // 생성자·필드·메서드 파라미터의 **제네릭 타입 인자까지** 펼쳐 보므로
        // ObjectProvider/ObjectFactory/Optional/List/Map 등 어떤 래퍼로 감싸도 걸린다.
        for (String name : beanFactory.getBeanDefinitionNames()) {
            Class<?> type;
            try {
                type = beanFactory.getType(name);
            } catch (RuntimeException e) {
                continue; // 해석 불가한 정의는 건너뛴다(가드가 부팅을 막는 부작용을 만들지 않는다)
            }
            if (type == null || !type.getName().startsWith(APP_PACKAGE)) {
                continue;
            }
            if (declaresAdminType(type) && tainted.add(name)) {
                queue.add(name);
            }
        }

        // ── 전이 확장: 위 시드에 (구상) 의존하는 모든 빈 ──
        while (!queue.isEmpty()) {
            for (String dependent : beanFactory.getDependentBeans(queue.poll())) {
                if (tainted.add(dependent)) {
                    queue.add(dependent);
                }
            }
        }
        return tainted;
    }

    /** 이 클래스의 선언부(생성자·필드·메서드 파라미터)가 admin 전용 타입을 참조하는가. */
    private boolean declaresAdminType(Class<?> type) {
        Set<Class<?>> referenced = new HashSet<>();
        try {
            for (java.lang.reflect.Constructor<?> ctor : type.getDeclaredConstructors()) {
                for (java.lang.reflect.Type t : ctor.getGenericParameterTypes()) {
                    collectTypes(t, referenced, new HashSet<>());
                }
            }
            for (java.lang.reflect.Field field : type.getDeclaredFields()) {
                collectTypes(field.getGenericType(), referenced, new HashSet<>());
            }
            for (java.lang.reflect.Method method : type.getDeclaredMethods()) {
                for (java.lang.reflect.Type t : method.getGenericParameterTypes()) {
                    collectTypes(t, referenced, new HashSet<>());
                }
            }
        } catch (NoClassDefFoundError | RuntimeException e) {
            return false; // 리플렉션 실패가 부팅을 막지 않게
        }
        for (Class<?> ref : referenced) {
            for (Class<?> adminBean : ADMIN_ONLY_BEANS) {
                if (adminBean.isAssignableFrom(ref)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 제네릭 타입 트리를 평탄화 — {@code ObjectProvider<AdminPointsService>} 의 인자까지 꺼낸다. */
    private void collectTypes(java.lang.reflect.Type type, Set<Class<?>> out, Set<java.lang.reflect.Type> seen) {
        if (type == null || !seen.add(type)) {
            return;
        }
        if (type instanceof Class<?> c) {
            out.add(c);
        } else if (type instanceof java.lang.reflect.ParameterizedType pt) {
            collectTypes(pt.getRawType(), out, seen);
            for (java.lang.reflect.Type arg : pt.getActualTypeArguments()) {
                collectTypes(arg, out, seen);
            }
        } else if (type instanceof java.lang.reflect.GenericArrayType gat) {
            collectTypes(gat.getGenericComponentType(), out, seen);
        } else if (type instanceof java.lang.reflect.WildcardType wt) {
            for (java.lang.reflect.Type b : wt.getUpperBounds()) {
                collectTypes(b, out, seen);
            }
            for (java.lang.reflect.Type b : wt.getLowerBounds()) {
                collectTypes(b, out, seen);
            }
        }
    }

    private Set<String> patternsOf(RequestMappingInfo info) {
        Set<String> patterns = new TreeSet<>();
        if (info.getPathPatternsCondition() != null) {
            info.getPathPatternsCondition().getPatterns()
                    .forEach(p -> patterns.add(p.getPatternString()));
        }
        if (info.getPatternsCondition() != null) {
            patterns.addAll(info.getPatternsCondition().getPatterns());
        }
        return patterns;
    }
}
