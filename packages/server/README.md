# @hmb/server — TS 서번트 2개 (ADR-1)

Java 게임서버(server-java) 밑에서 도는 **무상태 TS 서번트 프로세스 2개**.
게임 상태·큐·플로우·멱등(L1)은 전부 **Java 소유** — 여기는 잡을 받아 실행만 한다.

| 서번트 | 엔트리 | 역할 |
|---|---|---|
| ① 엔진러너 | `npm run runner` (`src/runner/runner-main.ts`, :8790) | `POST /simulate`(half 1/2, resume) + `GET /health` — 결정론 엔진 RPC |
| ② AI실행기 | `npm run executor` (`src/executor/executor-main.ts`) | Java `/internal/ai-jobs` 폴링 → 프롬프트 빌드 → AI 실행 → 검증 → complete |

**계약(SoT)**: `docs/plan-v2/LLD-ts-servants.md`(구조·계약·함정) · `docs/plan-v2/api/openapi.yaml`
(`/internal/ai-jobs`, `AiJobContext`/`AiJobCompleteRequest`) · zod 스키마는 `packages/shared`
(`SimulateRequest/Response`, `TeamInputJobContext`, `TacticalInput`).

## 구조

```
서번트① runner   :8790  POST /simulate {seed,selectData,homeInput,awayInput,half,resumeState?}
                        → {matchLog, resumeState?, lastHash}   · GET /health → {engineVersion}
서번트② executor  ──poll──▶ Java POST /internal/ai-jobs/poll {workerId,waitMs} (X-Servant-Token)
                  ◀─204/잡─┘   잡(context=TeamInputJobContext, kind='team-input')
                  프롬프트(prompt/coach.ts: 로스터 능력치·팀 지시·선수별 지시·half2 prevSummary)
                  → executor(stub | claude-code CLI, resilience 재시도/폴백, usage 계측)
                  → 검증 게이트(TacticalInput zod + 11명 + 로스터 id 정합 + clamp, 실패 시 feedback 1회 재시도)
                  → Java POST /internal/ai-jobs/{id}/complete {ok:true,output,usage} | {ok:false,error}
```

- `src/runner/` — `runner-main.ts`(HTTP) · `simulate.ts`(순수 로직: half1/half2 resume/교체 폴백).
- `src/executor/` — `executor-main.ts`(폴링 루프+엔트리) · `java-client.ts`(poll/complete) ·
  `executor.ts`(실행 추상화) · `kinds.ts`(team-input 레지스트리) · `metrics.ts`(usage 계측) ·
  `executors/`(`stub` 결정론·오프라인 / `claude-code` 정액제 구독 CLI / `resilience` 재시도·폴백).
- `src/prompt/coach.ts` — 프롬프트 빌더 + 검증 게이트(executor 무관 공통).
- `scripts/generate-runner-fixtures.ts` — server-java WireMock 용 fixture 발행(`npm run fixtures:runner`,
  단축 매치 샘플 — `docs/plan-v2/fixtures/README.md`).

## 실행

```bash
nvm use && npm install                       # node 20.19.6

npm run runner   -w @hmb/server              # 서번트① :8790 (RUNNER_PORT 로 변경)
curl -s localhost:8790/health                #  → {"engineVersion":"engine@0.9.0"}

# 서번트② — 오프라인(stub, 키/로그인 0):
JAVA_URL=http://localhost:8080 SERVANT_TOKEN=... AI_EXECUTOR=stub npm run executor -w @hmb/server
# 서번트② — 정액제(claude-code, 사전 `claude` 로그인):
JAVA_URL=http://localhost:8080 SERVANT_TOKEN=... AI_EXECUTOR=claude-code npm run executor -w @hmb/server
```

## claude-code executor (정액제 구독)

잡 1건 = `claude -p --output-format json --model <AI_MODEL> --json-schema <스키마>` subprocess 1회.
- **인증 = 구독 로그인**: 사전에 로컬 `claude` 로그인. `ANTHROPIC_API_KEY` 는 **설정하지 말 것**
  (설정 시 메터드 종량 과금으로 샘) — 실행기 기동 시 **감지하면 강제 unset** 후 경고 로그.
- Agent SDK 미사용(zod v4 peer 충돌 회피). 구조화 출력은 CLI 네이티브 `--json-schema`.

## env

| env | 기본 | 프로세스 | 의미 |
|---|---|---|---|
| `RUNNER_PORT` | `8790` | runner | 엔진러너 HTTP 포트 |
| `JAVA_URL` | `http://localhost:8080` | executor | Java 게임서버 베이스 URL |
| `SERVANT_TOKEN` | (없음 — 경고) | executor | `/internal/**` 고정 shared secret(`X-Servant-Token`) |
| `AI_WORKER_ID` | `ts-executor-<pid>` | executor | poll body 의 workerId |
| `AI_POLL_WAIT_MS` | `25000` | executor | long-poll waitMs — [1000, 25000] 로 클램프(openapi 상한) |
| `AI_EXECUTOR` | `stub` | executor | `stub`(오프라인 결정론) \| `claude-code`(구독 CLI) |
| `AI_MODEL` | `sonnet` | executor | 모델 스왑(별칭 `sonnet`/`haiku`/`opus` 또는 풀ID) |
| `AI_FALLBACK_EXECUTOR` | (없음) | executor | primary 가 CAP/TIMEOUT 시 무중단 폴백(예: `stub`) |
| `AI_MAX_RETRIES` | `2` | executor | CAP/TIMEOUT 지수 백오프 재시도 횟수(0=끔) |
| `AI_RETRY_BASE_MS` | `500` | executor | 첫 백오프(이후 2배씩, 상한 30s) |
| `AI_JOB_TIMEOUT_MS` | `120000` | executor | claude 잡당 강제 타임아웃 |

## 테스트

```bash
npx vitest run packages/server    # 로그인/키/실 Java 0 — 러너 결정론(AC-T1)·가짜 Java 큐 E2E(AC-T2)·
                                  # executor(러너 주입)·resilience·metrics·프롬프트/게이트
npm run typecheck -w @hmb/server
```

실패 분류(complete error 접두어): `AUTH:` 로그인 · `CAP:` 레이트리밋/캡 · `OUTPUT:` 구조화 실패 ·
`VALIDATE:` 게이트 거부(feedback 재시도 후) · `TIMEOUT:`. 라이브 스모크(AC-T3)는 통합 게이트에서 1회.

## 소유 경계 (병렬 개발)

- **이 도메인**: `packages/server/**`. **엔진 QA**: `packages/engine/**`(수정 금지 — 부족하면 QA 에픽 레이즈).
- **게임 API·큐·상태**: `server-java/**` 소유 — 여기서 게임 API 를 만들지 않는다.
- 공유 계약 `packages/shared/**` 변경은 프리즈 절차(에픽 조율 후 최소 추가).
