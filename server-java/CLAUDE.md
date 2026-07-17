# server-java 모듈 가이드 (도메인 세션용 CLAUDE.md)

이 디렉토리는 **권위 게임 서버(Java) 도메인**이다. 이 모듈 세션은 `server-java/**`만 소유한다.

## 필독 (이 순서로)
1. `docs/plan-v2/PRD-v2.md` §3.2~3.5 (요구사항+AC) — 판정 기준
2. `docs/plan-v2/ERD.md` (Flyway V1 그대로) + `docs/plan-v2/LLD-server-java.md` (구현 상세)
3. `docs/plan-v2/api/openapi.yaml` (계약 SoT — 임의 확장 금지, 변경은 web·ts-servants 에픽과 조율)
4. 에픽 이슈(server-java) STATE — 진행 상황 SoT

## 도메인 경계 (위반 금지)
- `packages/engine|shared|server/**`, `apps/web/**`, `data/**` 수정 금지. 필요하면 해당 에픽에 이슈 레이즈(domain-split 원칙).
- 데이터는 `data/players/*.v1.json`을 **읽기만**(부팅 임포트). 수치 하드코딩 금지 — 전부 application.yml 또는 economy.v1.json (AC-S5).
- 서번트(ts-servants)와는 `/internal` 잡 프로토콜 + `/simulate` RPC로만 통신.

## 규칙
- 테스트 먼저(전이표·검증 매트릭스), `./gradlew test` green이 웨이브 완료 조건. JPA 금지(JdbcClient).
- 상태 전이는 CAS(`WHERE state=?`), 보상·원장은 멱등(유니크 인덱스). 트랜잭션 경계는 서비스 메서드.
- 커밋 `[Spider] type(server-java): ...`, gh 계정 dd0114, **gh auth switch 금지**(fleet 규칙).
