-- #248 공지사항 — 홈 팝업(닫기·24h) + admin CRUD·감사이력. additive only(V1~V25 무변경).
--
-- ⚠️ **번호 이력**: V23 → V25 → **V26**. 처음 V23 으로 만든 뒤 머지를 기다리는 동안
--    #245(원정 V21/V22) · #253/#254(V23/V24) · #247(V25)이 차례로 앞 번호를 가져갔다. 번호를 사람이 기억하지 않도록 결번·중복은
--    `FlywayVersionContinuityTest` 가 기계로 막는다(그게 없었으면 결번인 채 배포돼 나중에 그
--    번호를 들고 오는 브랜치가 머지될 때 부팅이 죽었다 — 독립검증 MJ-4).
--    ⚠️ 이미 라이브 DB 에 적용된 번호는 절대 바꾸지 마라(체크섬·이력이 깨진다).
--
-- **왜 economy(#209) 처럼 파일 override 가 아니라 DB 테이블인가**: economy 는 값이 배포 발행물의
--    파생이라 "원본 + override" 2층이 필요했다. 공지는 발행물이 없다 — 운영자가 만드는 데이터 그
--    자체다. 그래서 DB 에 직접 쓰고, 쓰는 즉시 다음 조회에 반영된다(리로드 엔드포인트 없음).
CREATE TABLE notices (
  id          TEXT PRIMARY KEY,                    -- ULID
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,                       -- 마크다운 부분집합(렌더 살균은 web 소관, #248 Q7)
  starts_at   TEXT,                                -- NULL = 즉시 시작
  ends_at     TEXT,                                -- NULL = 무기한
  active      INTEGER NOT NULL DEFAULT 1,          -- 운영 스위치(기간과 별개 축)
  priority    INTEGER NOT NULL DEFAULT 0,          -- 다건 정렬(클수록 앞)
  revision    INTEGER NOT NULL DEFAULT 1,          -- 내용(제목/본문)이 바뀔 때만 +1
  deleted_at  TEXT,                                -- soft delete(이력 보존 — hard delete 없음)
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 설계 근거 3가지(이슈 #248 §1):
--  1) active(스위치)와 기간을 **분리**한다. 하나로 합치면 "예약해 뒀지만 지금은 내려두고 싶다"가
--     표현 불가능하고, 급히 내릴 때 운영자가 ends_at 을 과거로 조작하게 된다(원장이 거짓말이 된다).
--  2) revision 이 "내용을 고치면 다시 보인다"의 열쇠다. 클라 억제 키가 id 뿐이면 오탈자를 고쳐도
--     24시간 억제한 유저는 못 본다. 반대로 updated_at 을 키로 쓰면 노출 토글·우선순위 조정 같은
--     **내용 무관 변경에도 전원 재표시**가 된다 → 제목·본문이 실제로 바뀔 때만 +1.
--  3) 활성 판정은 **서버가** 한다. 클라가 startsAt <= now <= endsAt 를 계산하면 기기 시계·타임존이
--     진실이 되고(폰 시계가 하루 빠른 유저에게 점검 공지가 안 뜬다), 규칙이 바뀔 때 조용히 어긋난다.
--
-- ⚠️ 시각 컬럼은 **초 단위로 절삭된 ISO-8601 UTC**(`yyyy-MM-ddTHH:mm:ssZ`, 고정 20자)로만 쓴다.
--    SQLite 에는 시각 타입이 없어 비교가 문자열 사전순인데, 소수초가 섞이면
--    "…:00.123Z" < "…:00Z" 가 되어 같은 초 안에서 순서가 뒤집힌다. 정규화는 Notices.normalizeInstant.
CREATE INDEX idx_notices_window ON notices(active, deleted_at, starts_at, ends_at);
