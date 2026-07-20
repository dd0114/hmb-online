-- Phase 3 §A 자체 로그인(PRD-v4 P3-D2). additive only — V1~V3 는 손대지 않는다(체크섬 불변).
--
-- users.password: 자체 로그인(auth_provider='local') 계정의 비밀번호.
--   ⚠️ 평문(plaintext) 저장이다. 내부 테스터 배포용 **목업**이며 P3-D2 로 명시 승인된 임시 상태다.
--   실서비스 전 해시(예: BCrypt/Argon2) 전환은 **백로그** — 전환 시에도 이 컬럼을 재사용하고
--   값 포맷만 바꾸면 되도록 TEXT 로 둔다(마이그레이션 = 재가입 또는 최초 로그인 시 재해시).
--   NULL = 비번 없는 계정(guest / mock:google / mock:apple) → local 로그인 불가.
-- 로그인 id 는 기존 users.nickname(UNIQUE)을 그대로 쓴다 — 신규 식별자 컬럼을 만들지 않는다.
ALTER TABLE users ADD COLUMN password TEXT;
