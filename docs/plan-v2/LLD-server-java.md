# LLD — server-java (Spring Boot 권위 서버)

> 에픽: server-java · owned-glob `server-java/**` (+ `docs/plan-v2/api/openapi.yaml` 산출).
> 이 문서 + `ERD.md` + OpenAPI만 보고 구현 가능해야 한다. 요구사항·AC는 `PRD-v2.md` §3.2~3.5.

## 1. 기술 스택·프로젝트 구조

- Java 21(LTS, virtual threads 사용) + Spring Boot 3.x + Gradle(Kotlin DSL) + SQLite(`org.xerial:sqlite-jdbc`) + Flyway + Spring JDBC(`JdbcClient`) — **JPA 금지**(SQLite 방언 리스크·PoC 과함). springdoc-openapi로 스펙 서빙하되, **계약 SoT는 수기 `docs/plan-v2/api/openapi.yaml`**(구현이 스펙을 따른다. 드리프트는 계약 테스트로 검출).
- 포트 8080. DB 파일 `server-java/.data/hmb.db`(gitignore). WAL, foreign_keys=ON, busy_timeout=5000.

```
server-java/
  build.gradle.kts  settings.gradle.kts  gradlew*
  src/main/resources/application.yml            # 모든 튜닝값(§2) — 하드코딩 금지(AC-S5)
  src/main/resources/db/migration/V1__init.sql  # ERD.md DDL 그대로
  src/main/java/online/hmb/
    Application.java
    common/    ApiError.java  Ulid.java  Json.java(Jackson 설정)  TxRunner.java
    auth/      AuthProvider.java  MockAuthProvider.java  AuthController.java  SessionService.java  AuthInterceptor.java
    catalog/   PlayerCatalogService.java(시드 임포트+조회)  CatalogController.java
    meta/      DeckService.java  DeckController.java  PresetController.java  WalletService.java(원장+잔액, 멱등)
    shop/      GachaService.java  ShopController.java
    match/     MatchService.java(상태머신)  MatchController.java  BotService.java
               MatchOrchestrator.java(잡 완료→시뮬 트리거)  PromptContextBuilder.java
    jobs/      AiJobQueue.java  InternalJobController.java  JobLeaseSweeper.java(@Scheduled)
    engine/    EngineRunnerClient.java(ts-servants /simulate HTTP 클라)
  src/test/java/...                              # §8
```

## 2. application.yml (전부 여기서 — 코드 하드코딩 금지)

```yaml
hmb:
  data:
    players-file: ../data/players/players.v1.json     # 부팅 임포트(버전 upsert, meta_kv 기록)
    economy-file: ../data/players/economy.v1.json     # 확률표·경제 수치 로딩
    bots-file:    ../data/players/bots.v1.json
  auth:
    session-ttl-hours: 720
  deck:
    bench-max: 7
    player-prompt-max-chars: 500
  match:
    prompt-timer-sec: 180          # 표시용 (D5)
    enforce-prompt-timer: false    # 강제 전환 플래그
    halftime-subs-max: 3
    ai-job-timeout-sec: 240        # GEN 상태에서 이걸 넘으면 FAILED
    lease-sec: 120                 # ai_jobs 가시성 타임아웃
    max-attempts: 3
  servant:
    engine-runner-url: http://localhost:8790
    internal-token: change-me      # /internal/* shared secret (AC-Q3)
```

경제 수치(초기 3000·뽑기 300/3000·보상 500/200/100·확률표·스타터 팩 구성)는 **economy.v1.json**(data 도메인 산출물)에서 로딩 — yml에 중복 정의 금지.

## 3. 인증·공통 규약

- `POST /api/auth/login {nickname}`: 닉네임 정규식 `^[\p{L}\p{N}_-]{2,16}$`. 신규 → users+wallets+스타터 팩(user_players 14명, 원장 `starter` +3000) 트랜잭션 1개. 응답 `{token, user:{id,nickname}, isNew}`.
- `AuthProvider` 인터페이스: `AuthResult authenticate(LoginRequest)` — Mock 구현만. OAuth 구현체 추가 지점 javadoc으로 명시(교체 시 컨트롤러 불변).
- 이후 모든 `/api/*`는 `Authorization: Bearer <token>`(AuthInterceptor, sessions 조회). `/internal/*`는 `X-Servant-Token` 검사.
- 에러 규약(전 엔드포인트 공통): `{"code":"DECK_INVALID","message":"선발이 11명이 아닙니다","detail":{...}}` + 적정 HTTP status. code 목록은 OpenAPI components에 열거.
- ULID 생성 유틸(시간순 정렬 PK). Jackson: snake 금지, camelCase 고정(웹·서번트와 동일).

## 4. 메타 API (LLD 수준 요약 — 필드 상세는 OpenAPI)

| 엔드포인트 | 동작 |
|---|---|
| `GET /api/me` | user + wallet.points + records{wins,draws,losses}(matches 파생) |
| `GET /api/players` | 카탈로그 110명 + `owned`, `ownedCount` 병합(도감·덱 화면 공용) |
| `GET /api/deck` | 활성 덱 + 슬롯 + 선수별 프롬프트 |
| `PUT /api/deck` | 전체 교체(부분수정 없음). 검증: 보유 여부·starter=11·GK≥1(starter 중)·bench≤7·중복 금지·prompt 길이. 위반 → 400 `DECK_INVALID` |
| `GET/POST/DELETE /api/presets` | 프리셋 CRUD(수정=삭제+생성으로 단순화). 덱 적용은 웹이 prompt_text 복사(AC-S4) |
| `POST /api/shop/gacha {kind}` | §4.1 |
| `GET /api/me/matches` | 전적 리스트(최근 20: 상대·스코어·결과·일시) |
| `GET /api/modes` | `[{id:'single',available:true},{id:'multi',available:false,label:'준비중'}]` |

### 4.1 뽑기 (GachaService)

1. 비용 차감(잔액 부족 → 400 `INSUFFICIENT_POINTS`, 트랜잭션 롤백) → 원장 기록(ref=pullId).
2. `seed = SecureRandom 128bit hex` 저장. 추첨은 `SplittableRandom(seedHash)` 결정론: k회(1 또는 11) 등급 롤 → 등급 내 균등 선수 롤.
3. 10연: 11롤 후 골드↑ 없으면 마지막 롤을 골드↑ 재롤(pity, economy.v1 `tenPityMinGrade`).
4. user_players upsert(count+1) → 응답 `{results:[{player, isNew}], wallet}`.

## 5. 매치플로우 (핵심)

### 5.1 상태·전이표

| state | 진입 조건 | 허용 액션(그 외 409 `INVALID_STATE`) |
|---|---|---|
| `BRIEFING` | POST /api/matches (봇 매칭+덱 스냅샷+시드 생성) | GET, POST prompts(phase=pre), POST kickoff |
| `GEN1` | kickoff — 양팀 half1 잡 enqueue | GET (폴링) |
| `H1_BREAK` | 양팀 잡 done → 엔진러너 half1 시뮬 성공, halves(1) 저장 | GET, GET halves/1/log, POST prompts(phase=halftime), POST halftime(subs), POST resume |
| `GEN2` | resume — half2 잡 enqueue(전반 요약 컨텍스트 포함) | GET |
| `FINISHED` | half2 시뮬 성공 → 스코어 합산·result·보상·finished_at | GET, GET halves/*/log, GET result |
| `FAILED` | GEN* 타임아웃/attempts 초과/시뮬 오류(fail_reason) | GET, POST retry(실패 지점 재큐잉) |

- 전이는 `MatchService` 단일 진입점에서 `UPDATE matches SET state=? WHERE id=? AND state=?`(CAS)로 — 동시 요청 안전.
- `POST /api/matches`: 활성 덱 유효성 재검증(AC-S2 규칙) 후 스냅샷. body `{botId?}` 없으면 랜덤 봇.
- 상대 분석: BRIEFING의 GET 응답에 `opponent: {name, analysisText, deck:[{name,position,grade}×11]}` — 봇 선수별 프롬프트 유무도 표시(`hasPrompt`).

### 5.2 AI 잡 오케스트레이션 (MatchOrchestrator)

- kickoff/resume 시 양팀 잡 생성: `context_json`(스키마는 LLD-ts-servants §3과 동일 계약):
  `{kind:'team-input', matchId, side, half, seed:halfSeed(side별 파생), formation, roster:[11명 {playerId,name,position,attributes,slotIndex}], teamPrompt, playerPrompts:{playerId:text}, prevSummary?}`
  - 유저팀: match_prompts(pre 또는 pre+halftime 병합 — halftime 입력이 있으면 우선) + 덱 사전 프롬프트.
  - 봇팀: bots.persona + deck_json의 선수 프롬프트. half2도 동일 페르소나(+prevSummary).
  - `prevSummary`(half2만): `{scoreHome, scoreAway, shots, possessionHint}` — match_halves(1) 로그에서 산출.
- `id = sha256(canonicalJson(context))[0:32]` — 멱등. 이미 done이면 enqueue 생략하고 즉시 진행(L1 재사용, AC-Q2).
- 잡 2개 모두 done → `EngineRunnerClient.simulate(half)` 호출 → match_halves 저장 → 상태 전이. 오케스트레이션 트리거는 **잡 complete 콜백 시점**(InternalJobController가 MatchOrchestrator.onJobDone 호출) + JobLeaseSweeper가 타임아웃 감시.
- half2 시뮬 입력의 SelectData는 **교체 반영 로스터**(§5.4).

### 5.3 시뮬 호출 (EngineRunnerClient)

`POST {engine-runner-url}/simulate` body:
`{seed, selectData, homeInput, awayInput, half, resumeState?}` → `{matchLog, resumeState?, lastHash}`.
타임아웃 30s, 실패 1회 재시도 후 FAILED. 응답 matchLog는 저장 전 크기만 검사(스키마 검증은 러너 책임 — TS zod).

### 5.4 하프타임 교체 (D9 — 엔진 R2 전 fallback)

- `POST /api/matches/{id}/halftime {substitutions:[{out,in}]}`: 검증 — ≤3(config)·out∈전반 선발·in∈벤치·교체 후 GK≥1. 저장만(subs_json), 전이 없음(resume에서 반영).
- half2 SelectData = half1 로스터에서 out→in 치환(슬롯 승계).
- **교체 없음** → 러너에 `resumeState` 전달(엔진 resume 승계 — 현행 지원).
- **교체 있음** → `resumeState` 생략 = half2 독립 시뮬(스코어는 서버가 합산). 연속성 손실은 PoC 허용. 엔진이 로스터 교체 resume(R2)을 지원하면 이 분기 제거 — 코드에 `// R2(#이슈번호) 지원 시 통합` 주석.

### 5.5 종료 처리 (멱등 — AC-M6)

FINISHED 전이 트랜잭션 안에서: 스코어 합산 → result 판정 → 원장 `reward_win|draw|loss`(ref=matchId, 유니크 인덱스가 중복 차단) → wallets 반영. `GET /result`는 읽기 전용.

## 6. AI 잡 큐 API (`/internal`, 서번트 전용)

| 엔드포인트 | 동작 |
|---|---|
| `POST /internal/ai-jobs/poll {workerId, waitMs≤25000}` | long-poll: queued 잡 1개 lease(status=leased, lease_until=now+lease-sec, attempts+1) 후 반환. 없으면 waitMs까지 1s 간격 재조회 후 204. virtual thread라 블로킹 OK |
| `POST /internal/ai-jobs/{id}/complete` | body `{ok:true, output:TacticalInput, usage}` → done / `{ok:false, error}` → attempts<max면 queued로 복귀, 아니면 failed(+매치 FAILED 전파). 완료 시 MatchOrchestrator.onJobDone |
| `GET /internal/health` | 큐 깊이·lease 중 개수 (운영 확인용) |

JobLeaseSweeper(@Scheduled 10s): lease_until 경과 → queued 복귀. ai-job-timeout-sec 경과한 GEN* 매치 → FAILED.

## 7. 웨이브 (에픽 server-java 서브이슈 단위)

- **W0 스캐폴드**: Gradle+Boot+Flyway V1(ERD 그대로)+시드 임포트+AuthInterceptor 골격+`openapi.yaml` 작성(전 엔드포인트) — *web·ts-servants가 이 스펙으로 병렬 착수 가능해지는 게 완료 조건*.
- **W1 auth+메타**: §3·§4(뽑기 제외) + AC-S1~S5 테스트.
- **W2 상점·도감**: §4.1 + AC-S6~S8.
- **W3 매치플로우**: §5 상태머신 전체 — 잡큐는 in-memory stub 실행기(테스트용 서번트 시뮬레이터)로 AC-M1~M7.
- **W4 서번트 연동**: §6 + 실제 ts-servants와 통합(AC-Q1~Q3, AC-M2를 실 프로세스 조합으로 재실행).

## 8. 테스트 전략

- 단위: 서비스 레이어(JUnit5) — 임시 SQLite 파일 per test class. 뽑기 결정론(같은 seed→같은 결과)·덱 검증 매트릭스·원장 멱등.
- 상태머신: 전이표 전수(허용/거부 매트릭스 = AC-M1). 잡 실행기는 test fixture(가짜 서번트가 즉시 complete 콜백).
- E2E(AC-M2): `@SpringBootTest(webEnvironment=RANDOM_PORT)` — 로그인→덱→매치→FINISHED 풀 시나리오. 엔진러너는 WireMock(고정 MatchLog fixture — ts-servants가 생성해 `docs/plan-v2/fixtures/`에 발행) 또는 실 러너 프로세스(W4).
- 계약: springdoc 생성 스펙 ↔ 수기 openapi.yaml diff 검사(드리프트 검출).
- 실행: `./gradlew test`. CI 없음(로컬 게이트) — 루트 `npm test`와 별개, 에픽 완료 조건에 명시.
