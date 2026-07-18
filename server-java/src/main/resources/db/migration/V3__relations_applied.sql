-- W1 (에픽 #94): 관계/사기 멱등 적용 플래그.
-- LLD-p2-server §4: "FINISHED 트랜잭션에서 멱등 적용(ref=matchId 가드 — 관계 변동 이력 테이블 없이
-- matches 처리 플래그로)". ERD-v2 DDL(V2)에는 없던 플래그를 별도 마이그레이션으로 추가한다
-- (적용된 V2 체크섬 불변 유지 + Flyway 관행). 0=미적용, 1=적용.
ALTER TABLE matches ADD COLUMN relations_applied INTEGER NOT NULL DEFAULT 0;
