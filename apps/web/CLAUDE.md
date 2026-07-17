# apps/web 모듈 가이드 (도메인 세션용 CLAUDE.md)

이 디렉토리는 **웹 클라이언트(React SPA) 도메인**이다. 이 모듈 세션은 `apps/web/**`만 소유한다.

## 필독 (이 순서로)
1. `docs/plan-v2/PRD-v2.md` §2(유저 여정)·§3.7(AC-W1~W5)
2. `docs/plan-v2/LLD-web.md` (화면·구조·웨이브)
3. `docs/plan-v2/api/openapi.yaml` (서버 계약 SoT — 타입은 openapi-typescript 생성물 사용)
4. 에픽 이슈(web) STATE

## 도메인 경계 (위반 금지)
- 서버·엔진·뷰어 코드 수정 금지. API가 부족하면 server-java 에픽에 이슈 레이즈.
- **경기 캔버스 재생을 자체 구현하지 말 것** — QA 뷰어 소비(R1 이슈)만. R1 전에는 텍스트 타임라인까지만(LLD-web §3). 재발명 실패 사례 있음(#57).

## 규칙
- Playwright E2E(AC-W1 풀 시나리오)가 주 게이트. 시각/연출 판정은 **독립 QA 서브에이전트**로만(자기검수 금지, 루트 §2-2).
- 모바일 우선 반응형. 상태는 TanStack Query, 전역 스토어 도입 금지(PoC).
- 커밋 `[Spider] type(web): ...`.
