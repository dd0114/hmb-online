# packages/server 모듈 가이드 (도메인 세션용 CLAUDE.md)

이 디렉토리는 **TS 서번트 도메인**(ADR-1: ①엔진러너 RPC ②AI실행기)이다. 이 모듈 세션은 `packages/server/**`만 소유한다.
게임 상태·큐·플로우는 **server-java 소유** — 여기서 게임 API를 만들지 말 것(과거 lab 실험 API는 퇴역 대상).

## 필독 (이 순서로)
1. `docs/plan-v2/PRD-v2.md` §3.6 + `docs/plan-v2/LLD-ts-servants.md` (V1 구조·계약·함정) + **Phase 2: `docs/plan-v3/LLD-p2-servants.md`(지시 카탈로그·컨텍스트 확장·AI 예산 — 현행 SoT)**
2. `docs/plan-v2/LLD-server-java.md` §6 (잡 프로토콜 — Java 측 정의가 SoT)
3. 에픽 이슈(ts-servants) STATE

## 도메인 경계 (위반 금지)
- **엔진 코드 수정 금지**(`packages/engine/**` = QA 도메인 #25). 러너에 필요한 엔진 API가 부족하면 QA 에픽에 이슈 레이즈.
- `packages/shared/**` 계약 추가(SimulateRequest 등)는 프리즈 절차 — 관련 에픽 조율 후 최소 추가.
- 러너 시뮬 경로에 Math.random/Date.now 금지(결정론, 루트 §2-5).

## 함정 (실사례 — LLD §5)
- `ANTHROPIC_API_KEY` 있으면 구독이 아니라 종량 과금으로 샌다 → 기동 시 unset 강제 유지.
- 데이터 경로는 절대경로 env만(워크스페이스 상대경로 이중 해석 사고 있음).

## 규칙
- vitest green(`npx vitest run packages/server`)이 게이트. stub 토글로 오프라인 E2E 가능해야 함(AC-T2).
- 커밋 `[Spider] type(servants): ...`.
