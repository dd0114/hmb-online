-- #309 W1 공지 이미지 업로드 — 무배포 운영. additive only(V1~V29 무변경).
--
-- ⚠️ 번호는 merge 시점에 main 이 배정한다(V26 주석의 이력 참조). 결번·중복은
--    FlywayVersionContinuityTest 가 기계로 막는다 — 사람이 기억하지 않는다.
--    이미 라이브 DB 에 적용된 번호는 절대 바꾸지 마라(체크섬·이력이 깨진다).
--
-- **왜 파일시스템만으로 부족한가**: 바이트는 도커 볼륨에 두지만(SQLite 와 같은 볼륨이라
--    백업 대상이 하나다), 파일만 있으면 "누가 언제 무엇을 올렸나"와 "지금 노출 중인가"가
--    어디에도 없다. 목록·감사·노출 스위치가 이 표에 산다.
--
-- **왜 삭제 컬럼이 없나** (hero 확정 2026-07-30 — "삭제 없애, 비활성화하면 되잖아"):
--    자산을 내리는 행위는 **되돌릴 수 있어야** 한다. 삭제는 오조작이 곧 영구 소실이고,
--    그 그림을 참조하던 공지를 되살릴 방법이 없다. active=0 이면 서빙이 404 이고, 다시 켜면
--    같은 바이트가 그대로 돌아온다 — 행도 파일도 사라지지 않는다.
--    공지 자체의 노출 스위치(V26 notices.active)와 **같은 어휘**라 운영자가 새 개념을 배우지 않는다.
CREATE TABLE notice_assets (
  id            TEXT PRIMARY KEY,           -- ULID. **서빙 경로의 유일한 식별자**이자 저장 파일명의 뿌리
  stored_name   TEXT NOT NULL,              -- {id}.{ext} — 확장자는 **탐지된 타입**에서 파생한다
  original_name TEXT,                       -- 운영자가 올린 이름. 표시 전용 — 경로에 쓰지 않는다
  content_type  TEXT NOT NULL,              -- 화이트리스트로 확정한 값(클라가 신고한 값이 아니다)
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,              -- 기록만. 중복 제거는 하지 않는다(아래)
  active        INTEGER NOT NULL DEFAULT 1, -- 노출 스위치. 0 = 서빙 404(되돌릴 수 있다)
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,              -- ISO-8601 UTC 초 절삭(Notices.normalizeInstant 규약)
  updated_at    TEXT NOT NULL
);

-- 설계 근거 2가지(docs/plan-v5/ops-content.md §1):
--  1) **저장 파일명이 업로드 이름과 무관하다**(stored_name = {id}.{ext}). 경로 탈출(`../../`)을
--     차단 규칙으로 막는 게 아니라 **사용자 입력이 경로에 도달하지 않게** 만든다. 원본 이름은
--     운영자가 목록에서 자기 파일을 알아보라고 남기는 표시값일 뿐이다.
--  2) **sha256 은 기록만 하고 dedupe 하지 않는다.** 같은 그림을 두 번 올리면 자산이 둘이다.
--     공유 blob 을 만들면 "하나를 껐는데 다른 공지 그림이 같이 사라진다"가 되고, 아껴지는 용량은
--     공지 이미지 규모에서 무의미하다. 해시는 사후 조사(같은 파일이 몇 번 올라왔나)용이다.
CREATE INDEX idx_notice_assets_live ON notice_assets(active, created_at DESC);
