# #492 Research — 비즈니스 이벤트 + /event-board

조사일 2026-08-10 · 브랜치 `feat/492-event-board` · read-only 조사(코드 무변경)

## A. 결정적 사실 (설계를 가르는 것들)

### A1. ⚠️ 이 리포에는 `@Transactional` 이 **하나도 없다** — 트랜잭션은 `TxRunner` 로 명시적이다
`common/TxRunner.java:14` = `TransactionTemplate`, **PROPAGATION_REQUIRED**.
→ `txRunner.run(...)` 람다 **안**에 이벤트 INSERT 를 넣으면 바깥 트랜잭션과 **같이 롤백**된다.
→ 게다가 SQLite 는 실패한 statement 가 트랜잭션을 오염시킬 수 있다. **try/catch 로 삼켜도 안전하지 않다.**

**따라서 "best effort" 는 try/catch 만으로 성립하지 않는다.** 훅은 다음 둘 중 하나여야 한다:
- (a) **비트랜잭션 경계**(컨트롤러 / 서비스의 tx 바깥 구간)에 건다 — 대부분 여기서 해결된다
- (b) tx 안에서만 값을 알 수 있으면 **커밋 후**에 쓴다 (`settleFinishedIfDue` 가 `txRunner.run` 에서 리턴한 뒤)

`TransactionSynchronizationManager` 는 이 코드베이스에서 아직 안 쓴다 → (a)/(b) 로 푼다.

### A2. `/api/admin/**` 게이트는 이미 완비 — 새 라우트는 **자동으로** 보호된다
- `auth/WebMvcConfig.java:37-80` — `AuthInterceptor`(order 0, `/api/**`) → `AdminInterceptor`(order 10, `/api/admin/**`)
- `admin/AdminInterceptor.java:36-55` — userId 없음 → **401 UNAUTHORIZED** / `!adminAccess.isAdmin` → **403 FORBIDDEN**
- `admin/AdminAccess.java:38-49` — `SELECT is_admin FROM users WHERE id=?`, 행 없음 → false (fail-closed)
- 인증 = `Authorization: Bearer <token>` (쿠키·admin 전용 헤더 없음)
- 에러 바디 = `common/ApiError` `{code, message, detail?}`

⚠️ **새 admin 컨트롤러를 만들면 같이 해야 하는 것 3가지** (안 하면 테스트가 red 이거나 정보가 샌다):
1. `admin/AdminErrorHandler.java:41-43` 의 `@RestControllerAdvice(assignableTypes = {...})` 에 **새 컨트롤러 클래스 추가** — 안 하면 `?limit=abc` 같은 요청이 전역 핸들러로 떨어져 `ex.getMessage()` 가 노출된다
2. `admin/AdminRouteGuard.java:94-132` 의 `ADMIN_ONLY_BEANS` 에 **새 admin 전용 서비스 빈 추가** — `AdminGateTest.everyAdminPackageServiceIsSeededIntoTheGuard` 가 강제한다
3. `src/test/java/online/hmb/FlywayMigrationTest.java:51` 의 **테이블 인벤토리에 새 테이블 추가**

🟢 **비admin 403 은 새로 안 짜도 된다** — `AdminGateTest.nonAdminTokenGetsForbiddenOnEveryAdminRoute` 가
`RequestMappingHandlerMapping` 을 반사로 훑어 `/api/admin/` 로 시작하는 **모든** 라우트를 자동 커버한다.
(미인증 401 도 동일: `unauthenticatedGetsUnauthorizedOnEveryAdminRoute`)

### A3. 프론트 admin 게이트도 이미 완비 — `/event-board` 는 `/admin` 패턴 복제
- 라우트 선언 **한 곳**: `apps/web/src/App.tsx:86-234`. 기존 admin 라우트는 `/admin` **하나뿐**이고
  users/units/economy/notices/chars/mails 는 전부 그 페이지 안의 **탭**이다(`admin/AdminPage.tsx:27`).
- 게이트 = `<RequireAuth><RequireAdmin>…</RequireAdmin></RequireAuth>` (`App.tsx:209-218`)
- `admin/admin-logic.ts:32-37` `adminGuardDecision()` 순서가 계약: 토큰없음→login / 로딩→loading / 에러→lobby / `isAdmin===true`→allow
- `admin/RequireAdmin.tsx:14-35` — 비admin ⇒ `<Navigate to="/home" replace/>`, `/api/me` 인플라이트 중엔 `admin-guard-pending` (admin 화면 flash 방지)
- **서버 권위 2층**: `AdminPage.tsx:73-80` — admin 쿼리가 403 나면 `admin-forbidden` 배너 → 1800ms 후 `/home`
- 내비 노출 = `admin/admin-flag.ts` + `common/AppNav.tsx:43,81` (비admin 은 DOM 에 아예 없음)
- ⚠️ `common/match-lock.ts:32-41` `LOCKED_ROUTES` — `/admin` 은 **의도적으로 미포함**. `/event-board` 도 동일하게 둔다.

### A4. 페이지 템플릿 · 재사용 자산 (재발명 금지)
| 필요 | 이미 있는 것 |
|---|---|
| 필터 + 테이블 + 카운트 페이저 | `admin/AdminUnitsSection.tsx:239-297`(필터), `:397-416`(`{offset+1}–{offset+items.length} / {total}` 페이저) |
| **이벤트 스트림형 표** (시각/액션/결과/사유/운영자) | `admin/EconomyOpsPanel.tsx:208-240` — 가장 가까운 원형 |
| 시각 포맷 | `admin/admin-logic.ts:99-105` `formatStamp(iso)` (파싱 실패 시 원문 반환 — 행이 안 깨진다) |
| 필터 → 쿼리스트링 **순수함수 + 단위테스트** | `logs/logs-logic.ts:75-81` `matchLogQuery()` ← 이 분리 방식을 따른다 |
| 배열 가드 | `logs/LogsPage.tsx:53-57` `asList<T>()` — **필수**. 구서버가 200 `{}` 를 주면 흰 화면 |
| 스타일 | CSS Modules (`AdminPage.module.css` 의 `.section .search .table .tableScroll .muted .badge …`), tailwind 아님 |

### A5. 서버 read API 원형
- 가장 가까움: `GET /api/admin/units/audit` — `AdminCatalogController.java:60-70` + `AdminCatalogService.java:199-244`
  다중 필터(`playerId,actor,action,from,to,limit,offset`) · 동적 `WHERE 1=1` + `List<Object> params` ·
  잘못된 `action` → `ApiException.validation` 400 · `created_at` **ISO 문자열 비교** ·
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?` · 응답 `AuditPage(items,total,limit,offset)`
- 페이지 크기는 상수가 아니라 **config**: `application.yml:118-124` (`page-size-default: 50` / `page-size-max: 200`)
- ⚠️ **목록+요약을 한 응답에 주는 admin 선례는 없다.** 가장 가까운 "서버가 요약을 만든다" 선례는
  `GET /api/me/away-reports` → `{reports[], summary{…}}`
- ⚠️ `admin_ops_audit` 조회 SQL 이 **4개 서비스에 복붙**돼 있다(공용 리포지토리 없음) — 새 테이블은 그 실수를 반복하지 않는다

### A6. 영속 · 마이그레이션 규약
- JPA 없음. Spring **`JdbcClient`** + `org.xerial:sqlite-jdbc`. `SELECT *` 금지, 명시 컬럼 + 수동 `(rs,n) -> record` 매퍼
- 최신 마이그레이션 = **`V41__player_short_name.sql`** → 다음은 **V42**. `FlywayVersionContinuityTest` 가 번호 공백을 금지(예외목록 없음)
- 시각은 전부 **TEXT ISO-8601 UTC** (`Instant.now().toString()`). epoch millis 없음
- id = ULID `TEXT PRIMARY KEY` (`common/Ulid.next()`)
- 스키마 템플릿 = `V18__admin_ops_audit.sql` (범용 `action TEXT` + `detail_json TEXT` + `created_at TEXT` +
  `idx_*_time(created_at DESC)` + `idx_*_action(action, created_at DESC)`)
- 베스트에포트 쓰기 선례 = `rewards/RewardBundleService.java:74-97` (`INSERT OR IGNORE` + `catch(RuntimeException) → log.warn`)
- 패키지 = `online.hmb.*` 평면 피처 패키지. 새 `online.hmb.events` 는 `logs`(읽기전용 이력)·`rewards` 옆이 자연스럽다
- 주입 = 생성자 주입만(필드 `@Autowired` 0)

### A7. 테스트 · 게이트
- 서버: `@SpringBootTest(webEnvironment=RANDOM_PORT)` **실 HTTP만** (MockMvc 없음). `ApiTestBase.login()/bearer()`,
  admin 은 `@DynamicPropertySource` 로 `hmb.admin.nickname/password` 고정 후 `/api/auth/login`
- 서버 게이트: `cd server-java && ./gradlew test --rerun-tasks` (memory: `--rerun-tasks` 없으면 UP-TO-DATE 거짓 green)
- web 게이트: `cd apps/web && npm run build` (memory: 루트 typecheck 는 web 타입을 안 본다)
- web e2e: **전체 실행 금지**(`league-season`·`match-flow`·`w3-viewer-smoke` 가 :8080 데모에 붙는다).
  안전 패턴 = `cd apps/web && CI=1 WEB_E2E_PORT=5312 npx playwright test e2e/<spec>.spec.ts`
- ⚠️ **/api 모킹은 glob 금지, pathname 술어**(`p3-admin-mock.spec.ts:10-11`) — `**/api/**` 는 vite 소스
  `/src/api/*.ts` 까지 잡아 흰 화면. 그리고 **나중에 등록한 route 가 이긴다** → catch-all 을 먼저 등록
- 복제할 스펙 = `apps/web/e2e/p3-admin-mock.spec.ts` (295줄, 비admin/미로그인/렌더·필터·오버플로/서버403 4케이스 완비)

## B. 훅 지점 (file:line — hero 가 나열한 7종)

| # | 행동 | 훅 (권장 = 비tx 경계) | 그 자리에서 아는 속성 |
|---|---|---|---|
| 1 | 신규가입 | `auth/UserOnboardingService.java:71 createUser` 는 **전체가 tx** → 호출부에 건다: `auth/LocalAuthProvider.java:77 register`(비tx) · `auth/MockOAuthProvider.java:42 authenticate`(`Created` 분기 :67) | userId, nickname, provider(local/oauth-mock), createdAt |
| 2a | 매치 시작 | `match/MatchService.java:255 createMatch`(practice) · `:299 createLeagueMatch` · `:349 createAwayMatch` — 셋 다 INSERT 만 tx 이고 **메서드 자체는 비tx**. 컨트롤러 = `match/MatchController.java:45` · `away/AwayController.java:58` · `league/LeagueController.java:78` | matchId, **mode**(practice/league/away), botId, seed, deck slot 수, leagueFixtureId, defenderId |
| 2b | 킥오프 | `match/MatchService.java:986 kickoffCas` — **비tx**, CAS 라 정확히 1회 | userId, matchId |
| 2c | 매치 종료 | `match/MatchOrchestrator.java:773 finishMatch` — **tx 안**(CAS 로 exactly-once). ⇒ 훅은 `:751 settleFinishedIfDue` 의 `txRunner.run(...)` 이 **true 로 리턴한 뒤**(커밋 후) | matchId, mode(`modeOf` :138, 레거시 NULL→practice), result(WIN/LOSS/DRAW :781), userGoals/oppGoals(:778-779), leagueFixtureId, 지급 포인트(:845) |
| 3 | 덱 구성 | `meta/DeckService.java:89 replaceDeck`(validate 는 비tx, INSERT 만 tx) · 컨트롤러 `meta/DeckController.java:52 putDeck`(비tx) · 프리셋 적용 `meta/TeamPresetService.java:132 apply`(**비tx**, 내부에서 replaceDeck 호출) | deckId, formation, slots().size(), teamPrompt 유무, 신규/수정 분기(:104), preset slot 번호 |
| 4 | 뽑기 | `shop/GachaService.java:74 pull` 은 **전체가 tx** → 컨트롤러 `shop/ShopController.java:32 gacha`(비tx). 응답에 results + wallet | kind(single/ten), cost, count, currency(POINT/GEM), 뽑힌 등급들, 잔액 |
| 5 | 원정 | `away/AwayService.java:203 start`(**비tx**) · `:907 startRevenge` · 컨트롤러 `away/AwayController.java:58,111`. 정산 `:504 settle` 은 finishMatch tx 안 | attackerId, defenderId, ghostBotId, 일일사용/한도(:196), rating, revenge reportId |
| 6 | 리그 | 시즌 시작 `league/LeagueService.java:232 startSeason`(**전체 tx**, 재진입 분기 :235 는 기존시즌 반환 → 이벤트 금지) → 컨트롤러 `league/LeagueController.java:40 start`(비tx). 경기 `:284 nextMatch`(전체 tx, 재사용 분기 :300) → 컨트롤러 `:78` | seasonId, seasonNo, seed, **division**(:906 divisionOf), fixtureId, round, botTeamId, matchId |
| 7 | 연습모드 | **별도 서브시스템 없음** — `mode='practice'` 인 매치다(`MatchService.java:283` 리터럴). ⇒ 2a/2c 가 그대로 커버 | mode='practice' |

부수 발견: `POST /api/me/tutorial-complete`(`OnboardingService`, 멱등) 가 **덱 지급 시점**이자 온보딩 퍼널 완료 지점.

## C. 미해결 질문 / 리스크

1. **openapi.yaml 갱신 불가** — `docs/**` 는 server-java·apps/web 어느 owned-glob 에도 없다.
   기존에도 `/api/growth/*`·`/api/away/*` 가 미문서 상태로 남아 있다(선례).
   → 잠정 계약 SoT = 이 이슈 + 양쪽 CLAUDE.md, docs 편입은 매니저 경유 요청.
2. **배포 게이트** — memory `web-deploy-freeze-unopened-chars`: 미오픈 캐릭터가 main 에 있으면 Pages 배포가 곧 유출.
   완료기준 ①(배포 + hero 실확인)은 **hero/매니저 확인 후에만** 발차.
3. **`admin_ops_audit` 조회 SQL 4중 복붙** — 새 테이블에서 반복하지 않는다(단일 서비스가 소유).
4. **성능 근거를 어떻게 잴 것인가** — 완료기준 ③. 매치 경로에 붙는 것은 시작 1행 + 종료 1행(커밋 후)뿐이라
   구조적으로 tx 밖 단일 INSERT 다. 계약은 "훅이 tx 안에 없다"(구조) + 실측 지연(수치) 두 층으로 건다.
