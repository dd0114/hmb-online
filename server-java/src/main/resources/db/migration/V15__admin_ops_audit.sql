-- #209 무배포 운영(B안) — admin 운영 액션의 감사 원장. additive only(V1~V14 무변경).
--
-- 왜 admin_audit(V5)을 안 쓰나: 그 테이블은 **유저를 대상으로 한** 액션 전용이다
--   (target_user_id NOT NULL REFERENCES users). economy 리로드·설정 교체는 대상이 유저가 아니라
--   서버 설정이라, 거기에 끼워 넣으려면 target 컬럼에 액터 자신을 넣는 식의 거짓말이 필요하다.
--   원장은 "무슨 일이 있었나"의 정본이므로 스키마가 사실과 어긋나면 안 된다.
--
-- 범용으로 열어 둔다(action 문자열 + detail_json): #207 파트 A(어드민 유닛 카탈로그)도 같은
--   테이블에 자기 action 을 append 하면 된다 — 운영 이력이 한 곳에 모이는 편이 조회에 유리하다.
CREATE TABLE admin_ops_audit (
  id            TEXT PRIMARY KEY,                       -- ULID
  actor_user_id TEXT NOT NULL REFERENCES users(id),     -- 액션을 실행한 admin
  action        TEXT NOT NULL,                          -- 'economy_reload' | 'economy_starter_top' | 'economy_override_clear'
  result        TEXT NOT NULL,                          -- 'ok' | 'failed'  (실패도 남긴다 — 시도 자체가 이력이다)
  reason        TEXT,                                   -- 운영자가 남긴 사유(운영 메모)
  detail_json   TEXT,                                   -- {before:…, after:…, error:…} 스냅샷
  created_at    TEXT NOT NULL
);

-- 조회는 항상 "최근에 무슨 일이 있었나" 또는 "이 액션의 이력" 두 방향이다.
CREATE INDEX idx_admin_ops_audit_time   ON admin_ops_audit(created_at DESC);
CREATE INDEX idx_admin_ops_audit_action ON admin_ops_audit(action, created_at DESC);
