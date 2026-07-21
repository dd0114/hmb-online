-- Phase 3 §C admin 페이지(PRD-v4 P3-D4). additive only — V1~V4 는 손대지 않는다(체크섬 불변).
--
-- users.is_admin: admin 권한 플래그. P3-D4 = "env 하드코딩 자격 또는 특정 계정 플래그" 중
--   **계정 플래그** 방식을 택했다(둘을 겸함: 어느 계정이 admin 인가는 env 가 정하고, 런타임
--   판정은 이 컬럼 하나로 한다). DEFAULT 0 = **기본 안전** — 마이그레이션만으로는 admin 이
--   단 한 명도 생기지 않는다. 부여는 오직 부팅 시 AdminBootstrap 이 env 를 보고 수행한다.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- admin_audit: admin 액션 감사 로그(AC-C1 "감사 로그").
--   point_ledger 는 "지갑이 왜 변했나"의 SoT 이고, 이 테이블은 "누가 그 변경을 지시했나"의 SoT 다.
--   원장에는 actor 개념이 없으므로(유저 본인 관점 기록) 분리한다. 둘은 같은 트랜잭션에서 쓰인다.
CREATE TABLE admin_audit (
  id             TEXT PRIMARY KEY,                        -- ULID
  actor_user_id  TEXT NOT NULL REFERENCES users(id),      -- 액션을 실행한 admin
  target_user_id TEXT NOT NULL REFERENCES users(id),      -- 대상 유저
  action         TEXT NOT NULL,                           -- 'points_grant'
  delta          INTEGER,                                 -- 포인트 변화량(+지급/-차감). 비-포인트 액션은 NULL
  reason         TEXT,                                    -- admin 이 남긴 사유(운영 메모)
  idem_key       TEXT,                                    -- 멱등키(= point_ledger.ref_id 와 동일 값)
  created_at     TEXT NOT NULL
);

-- 조회용: "이 유저에게 무슨 일이 있었나" / "이 admin 이 뭘 했나" 두 방향 모두 최신순.
CREATE INDEX idx_admin_audit_target ON admin_audit(target_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_actor  ON admin_audit(actor_user_id, created_at DESC);

-- 멱등 백스톱(defense-in-depth): 지급 멱등의 1차 권위는 uq_ledger_reason_ref(원장)다.
-- 원장과 감사가 어긋나는 상태(원장은 막혔는데 감사는 또 쓰인다 / 그 반대)를 DB 레벨에서
-- **불가능**하게 만든다 — 어긋나면 UNIQUE 위반으로 터져 트랜잭션이 롤백된다(fail-closed).
CREATE UNIQUE INDEX uq_admin_audit_idem ON admin_audit(action, idem_key)
  WHERE idem_key IS NOT NULL;
