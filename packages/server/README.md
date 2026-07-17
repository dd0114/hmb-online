# @hmb/server

권위(authoritative) 서버 + **AI 워커 시스템**(에픽 #32). 흐름:
**감독 자연어 → (AI executor) TacticalInput → 결정론 엔진 실행 → MatchLog** (PRD 방식1).

AI 는 **큐 프로토콜 뒤**에 있다 — 서버/파이프라인은 어떤 AI 가 도는지 모른다(에픽 #32 §1, ADR-1).
Phase 1 은 이 TS 서버가 게임흐름+큐+워커를 겸하고, S5(#11)에서 Java 게임서버가 큐를 인수한다.

## 구조
```
POST /tactical ─▶ AiService(결과캐시 확인 → 미스면 enqueue) ─▶ FileJobQueue(내구·멱등)
                                                                 │ 폴링
   200(경기요약) ◀─ runMatch(결정론) ◀─ 결과 ◀─ AiWorker ── executor ──┐
                                                └ 검증 게이트(kinds.ts, executor 무관)  ├ stub (오프라인·CI)
                                                                              └ claude-code (정액제 구독 CLI)
```
- `src/ai/protocol.ts` — 잡 프로토콜(AiJob/AiJobResult + promptHash 멱등키).
- `src/ai/queue.ts` — `JobQueue` 인터페이스 + `FileJobQueue`(v1; S5 에서 Java 잡 API 로 교체).
- `src/ai/cache.ts` — L1 결과캐시(같은 지시 = AI 스킵 + 리플레이 재현 저장소).
- `src/ai/kinds.ts` — kind 레지스트리(coach: 컨텍스트·JSON 스키마·프롬프트·검증 게이트).
- `src/ai/executor.ts` + `executors/` — AI 실행 추상화. `stub`(결정론) · `claude-code`(구독 CLI).
- `src/ai/worker.ts` — 폴링 워커(검증 실패 시 피드백 1회 재시도, 크래시 복구).
- `src/coach.ts` — coach 도메인(프롬프트·JSON 스키마·검증 게이트). `src/pipeline.ts` — 결정론 시뮬.
- `src/index.ts` — 게임서버(`/`=대시보드, `/health`, `/tactical`, `/jobs/:id`, `/metrics`, `/compare-report`, `/replay/:id`, `/fallback-demo`). `src/worker-main.ts` — 상주 워커.
- `src/ai/metrics.ts` — 캐시 계측(W3 AC1): L1 결과캐시 히트율 + L2 프롬프트캐시(cacheRead) 집계. `GET /metrics` 리포트.
- `src/replay.ts` — 리플레이 계약(W3 AC5): L1 저장 input → 같은 seed 재실행 = 동일 MatchLog 지문.
- `src/ai/compare.ts` + `src/compare-main.ts` — 모델 비교(W3 AC2): directive 세트 × 모델 → 검증통과율·방향정합·대비폭.
- `public/dashboard.html` — W3 운영 대시보드(뷰 레이어): 파이프라인·캐시·리플레이·폴백·모델비교를 브라우저로 육안 검증. `GET /`.

## claude-code executor (정액제, 에픽 #32 옵션 D)
잡 1건 = `claude -p --output-format json --model <AI_MODEL> --json-schema <스키마>` subprocess 1회.
- **인증 = 구독 로그인**: `ANTHROPIC_API_KEY` 를 **설정하지 말 것**(설정하면 메터드 과금으로 샘). 미설정 시
  로컬 `claude` 로그인(키체인)으로 정액제 과금. 워커 기동 시 self-check 로그.
- Agent SDK 미사용(zod v4 peer 충돌 회피, 프리즈 shared 무변경). 구조화 출력은 CLI 네이티브 `--json-schema`.

## 로컬 실행
```bash
nvm use                                   # 20.19.6
npm install
# (A) 오프라인 — stub executor(키/로그인 0):
npm run dev  -w @hmb/server               # :8787, 인라인 stub 워커
curl -s -XPOST localhost:8787/tactical -d '{"directive":"풀백 오버랩·와이드","seed":"4815162342"}'
#  → 200 {finalScore,events,ticks}  (같은 지시 재요청 시 cached:true)

# (B) 정액제 — claude-code executor(사전 `claude` 로그인, 키 unset):
AI_EXECUTOR=claude-code AI_INLINE_WORKER=1 npm run dev -w @hmb/server
#  또는 서버(웹)와 워커(상주)를 분리:
AI_EXECUTOR=claude-code npm run worker -w @hmb/server   # 상주 워커
npm run dev -w @hmb/server                              # 게임서버(같은 AI_DATA_DIR)
```

## env
| env | 기본 | 의미 |
|---|---|---|
| `AI_EXECUTOR` | `stub` | `claude-code` 로 전환(정액제 구독 CLI) |
| `AI_MODEL` | `sonnet` | 서브에이전트 모델 스왑(별칭 `sonnet`/`haiku`/`opus` 또는 풀ID) |
| `AI_JOB_TIMEOUT_MS` | `120000` | claude 잡당 강제 타임아웃 |
| `AI_INLINE_WORKER` | stub=`1`, claude-code=`0` | 서버 프로세스 안에서 워커 폴링 |
| `AI_DATA_DIR` | `<pkg>/.data` | 큐·캐시 저장 위치(서버·워커가 공유) |
| `AI_WAIT_MS` | `30000` | `/tactical` long-poll 대기(초과 시 202 + jobId) |
| `AI_POLL_MS` | `1000` | 상주 워커 폴링 간격 |
| `AI_FALLBACK_EXECUTOR` | (없음) | 캡/장애 시 무중단 스위치할 폴백 executor(예: `stub`). primary 가 `CAP`/`TIMEOUT` 로 죽으면 자동 위임 |
| `AI_MAX_RETRIES` | `2` | 일시장애(`CAP`/`TIMEOUT`) 지수 백오프 재시도 횟수(`0`=끔) |
| `AI_RETRY_BASE_MS` | `500` | 재시도 첫 백오프(이후 2배씩, 상한 30s) |
| `PORT` | `8787` | 게임서버 포트 |

### 캡/장애 대응 (W3 AC4)
구독 캡·일시장애는 executor 데코레이터로 무중단 흡수한다(`src/ai/executors/resilience.ts`):
- **백오프 재시도** — `CAP`/`TIMEOUT` 은 `AI_MAX_RETRIES` 회 지수 백오프. `AUTH`/`OUTPUT`/`VALIDATE`(영구) 는 즉시 실패.
- **폴백 스위치** — `AI_FALLBACK_EXECUTOR=stub`(또는 예비 메터드 API) 지정 시 primary 캡/타임아웃에 자동 위임. 결과 `meta.executor` 에 `claude-code:sonnet→stub` 로 기록.
- **무중단 근거** — 잡은 큐(내구·멱등)에 남으므로, 운영자가 env 만 바꿔 워커를 재기동해도 큐가 그대로 소진된다(게임서버 다운타임 0).

### 계측 (W3 AC1)
`GET /metrics` → `{ cache: { l1:{hits,misses,hitRate}, l2:{cacheReadTokens,promptCacheHitRate,costUSD,…} }, summary }`.
L1 = 결과캐시(같은 지시 = AI 스킵) 히트율 · L2 = 프롬프트 캐시(claude-code usage 봉투의 `cache_read_input_tokens`) 집계.

## 테스트
```bash
npx vitest run packages/server        # 로그인/키 0 — stub·큐·게이트·executor(러너 주입)·재시도
AI_LIVE=1 npx vitest run packages/server/src/ai/live.test.ts   # AC6 라이브(구독 로그인 필요)
```
실패 분류(결과 error 접두어): `AUTH:` 로그인 · `CAP:` 레이트리밋/캡 · `OUTPUT:` 구조화 실패 · `VALIDATE:` 게이트 거부(재시도 후) · `TIMEOUT:`.

## W3 운영 대시보드 (뷰 레이어 — 육안 검증)
서버를 띄우고 브라우저로 `http://localhost:8787/` 접속 → 한 화면에서 W3 전 기능을 눌러 검증:
```bash
npm run dev -w @hmb/server        # stub(오프라인) — 로그인/키 0
# 브라우저에서: 전술 파이프라인 실행 → 재실행(L1 캐시 히트) → 리플레이 검증(✅ 동일 해시)
#              → 폴백 데모(CAP→stub 무중단) → 캐시 계측 게이지 → 모델 비교 표
```

## 모델 비교 (AC2)
```bash
AI_COMPARE_MODELS=stub-A,stub-B npm run compare -w @hmb/server          # 오프라인(구조·지표 확인)
AI_EXECUTOR=claude-code AI_COMPARE_MODELS=sonnet,haiku npm run compare -w @hmb/server  # 라이브(구독 로그인)
# → <AI_DATA_DIR>/compare-report.json (대시보드 GET /compare-report 가 렌더). 지표: 검증통과율·방향정합·대비폭.
```

## Docker (버전핀 이미지 — AC3)
```bash
docker build -f packages/server/Dockerfile -t hmb-server:0.0.1 .        # node 20.19.6 + lockfile + claude CLI 2.1.208 핀
docker run -p 8787:8787 hmb-server:0.0.1                                # stub 서버 + /health HEALTHCHECK
# claude-code 워커(정액제): 구독 로그인을 볼륨으로 주입(API 키 넣지 말 것 — 메터드로 샘). Dockerfile 인증 섹션 참고.
docker run -it -v hmb-claude-auth:/home/node/.claude hmb-server:0.0.1 claude /login   # 1회 로그인
docker run -e AI_EXECUTOR=claude-code -v hmb-claude-auth:/home/node/.claude hmb-server:0.0.1 npm run worker -w @hmb/server
```

## 소유 경계 (병렬 개발)
- **서버 트랙**: `packages/server/**`, `Dockerfile`. **엔진 QA 트랙**: `packages/engine/**`. 서로 안 밟음.
- 공유 계약 `packages/shared/**` 변경은 두 트랙 조율(프리즈) — 에픽 #32 §3.
