# LLD — ts-servants (packages/server 재편: 엔진러너 + AI실행기)

> 에픽: ts-servants · owned-glob `packages/server/**` (+ `packages/shared/**` 계약 추가는 프리즈 절차).
> ADR-1 그대로: TS는 **①무상태 엔진러너 RPC ②AI실행기** 2개 서번트만. 게임 상태·큐는 Java 소유.
> 기존 W1~W3 자산(executor 추상화·claude CLI·metrics·resilience·cache 의미론)은 **재사용**, 파일 큐·자체 HTTP 게임 API(`/match` 등 lab 실험)는 **퇴역**.

## 1. 재편 후 구조

```
packages/server/src/
  runner/    runner-main.ts(HTTP :8790)  simulate.ts(half1/2, resume)  # 서번트①
  executor/  executor-main.ts(Java 폴러)  java-client.ts(poll/complete)  # 서번트②
             executors/{stub,claude-code,resilience}.ts  metrics.ts     # 기존 재사용(이동)
  prompt/    coach.ts(빌더 — playerPrompts·prevSummary 반영)             # 기존 확장
  기존 파일 중: queue.ts·cache.ts·service.ts·worker.ts·index.ts(HTTP)·lab 관련 → 삭제(퇴역)
  유지 테스트: metrics/resilience/replay(러너 경유로 재작성)/coach
```

실행: `npm run runner` / `npm run executor` (환경변수 `JAVA_URL=http://localhost:8080`, `SERVANT_TOKEN`, `AI_EXECUTOR=stub|claude-code`, `AI_MODEL`, `AI_FALLBACK_EXECUTOR`).

## 2. 서번트① 엔진러너 (무상태 RPC)

- `POST /simulate` — zod 계약을 **shared에 추가**(`SimulateRequest/SimulateResponse`, 프리즈 절차로):

```ts
SimulateRequest  = { seed: string, selectData: SelectData, homeInput: TacticalInput,
                     awayInput: TacticalInput, half: 1|2, resumeState?: unknown }
SimulateResponse = { matchLog: MatchLog, resumeState?: unknown, lastHash: string }
```

- half=1: 엔진 하프타임 분할 실행 → 전반 MatchLog + resumeState 반환. half=2 + resumeState: 승계 재개. half=2 단독(교체 시 Java가 resumeState 생략): 독립 시뮬(LLD-server-java §5.4).
- 엔진은 `@hmb/engine` 소스 의존(현행 소비 방식 — #57 결론 나오면 버전 핀으로 갱신). **엔진 코드 수정 금지**(QA 도메인). resume 분할 API가 러너에서 부족하면 → QA에 이슈 레이즈(경계 원칙).
- 무상태: 요청 밖 저장 0. 같은 요청 → 같은 응답(결정론) — 계약 테스트로 박제(AC-T1).
- `GET /health` = `{engineVersion}`.

## 3. 서번트② AI실행기 (Java 폴러)

- 루프: `POST {JAVA_URL}/internal/ai-jobs/poll {workerId, waitMs:25000}` → 204면 재폴, 잡이면 실행 → `POST .../{id}/complete`.
- 잡 컨텍스트(Java와 계약 — shared `TeamInputJobContext`로 zod 정의):
  `{kind:'team-input', matchId, side, half, seed, formation, roster[11], teamPrompt, playerPrompts, prevSummary?}`
- 실행 = 기존 executor 추상화: 프롬프트 빌드(coach.ts — roster 능력치·포지션, 팀 지시문, **선수별 개인 지시**, half2면 prevSummary 문맥) → `claude -p --output-format json --json-schema`(TacticalInput 강제) 또는 stub(시드 결정 파라미터). resilience(재시도·폴백)·metrics(usage → complete body에 포함) 그대로.
- 검증: 응답을 zod TacticalInput parse + clamp 후 complete. parse 실패 → `{ok:false}`.
- 종료 신호(SIGTERM) 시 진행 중 잡은 완료 후 종료(lease가 어차피 재배포 보장).

## 4. 웨이브·AC 매핑

- **W0 러너**: §2 + AC-T1 + Java용 MatchLog fixture 발행(`docs/plan-v2/fixtures/matchlog-h1.json` 등 — server-java WireMock 테스트 입력).
- **W1 실행기**: §3 + 파일큐 퇴역 + AC-T2(로컬 Java 없이 가짜 Java 서버 fixture로도 테스트) + AC-T4(기존 스위트 green).
- 라이브 스모크(AC-T3)는 통합 게이트에서 1회(구독 CLI 로그인 세션 필요 — 기존 W2 방식).

## 5. 주의(이 도메인의 함정 — 실사례)

- `ANTHROPIC_API_KEY`가 환경에 있으면 claude CLI가 종량 과금으로 샌다 — 실행기 기동 시 **unset 강제**(기존 W2 코드 유지).
- npm workspace에서 상대경로 데이터 디렉토리는 패키지 기준으로 풀린다 — 절대경로 env만 사용.
- 엔진 결정론 규칙(§2-5)은 러너에도 적용: 러너 코드에 Math.random/Date.now 금지(폴러·로그는 예외 허용, 시뮬 경로만 금지).
