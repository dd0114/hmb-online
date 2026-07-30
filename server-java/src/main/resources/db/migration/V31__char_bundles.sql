-- #309 W2 유닛 아트 핫로드 — 아트 번들 리비전. additive only(V1~V30 무변경).
--
-- ⚠️ 번호는 merge 시점에 main 이 배정한다. 결번·중복은 FlywayVersionContinuityTest 가 기계로 막는다.
--
-- **왜 필요한가**: 유닛 **등록**은 이미 무배포다(#207 파트 A — POST /api/admin/units 가 players 에
--    직접 쓰고 admin_locked 로 시드 재임포트를 막는다). 그런데 새 유닛을 등록해도 **아트가 없으면
--    이니셜 폴백**으로 뜬다. 아트는 세 가지가 웹 빌드에 구워져 있다: 아틀라스·카드 PNG /
--    매니페스트 3종 / player-chars 매핑. 셋은 서로를 참조하므로 **하나만 옮기면 어긋난다**.
--
-- **왜 파일 단위가 아니라 번들(zip) 한 덩어리인가**: 매니페스트는 아틀라스의 타일 좌표를 가리키고
--    매핑은 유닛 id 를 가리킨다. 파일별로 올리면 "매니페스트는 새것, PNG 는 옛것"인 중간 상태가
--    실제로 존재하고, 그때 화면은 **좌표가 어긋난 그림**을 그린다(깨진 게 아니라 틀린 그림이라
--    아무도 못 알아챈다). 통짜 업로드는 그 중간 상태를 없앤다.
--
-- **왜 리비전을 쌓고 삭제하지 않나**(W1 D9 와 같은 철학): 새 아트가 잘못됐을 때 **되돌릴 것이
--    있어야** 한다. 롤백 = active 를 옛 리비전으로 옮기거나 전부 끄는 것(끄면 web 이 웹 빌드에
--    구운 폴백으로 돌아간다 = 아트 배포 이전 상태).
CREATE TABLE char_bundles (
  id          TEXT PRIMARY KEY,           -- ULID = 리비전 식별자이자 저장 디렉토리 이름
  file_count  INTEGER NOT NULL,
  byte_size   INTEGER NOT NULL,           -- 해제 후 총 바이트
  manifest_summary TEXT,                  -- 매니페스트에서 뽑은 요약 JSON(운영 화면 표시용)
  note        TEXT,                       -- 운영자 메모(어느 파이프라인 산출물인가)
  active      INTEGER NOT NULL DEFAULT 0, -- 지금 서빙되는 리비전. **최대 하나**(아래 인덱스가 강제)
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,              -- ISO-8601 UTC 초 절삭
  updated_at  TEXT NOT NULL
);

-- ⚠️ **활성 리비전은 최대 하나**를 DB 가 강제한다. 애플리케이션 코드로만 지키면 동시 활성화
--    두 건이 "둘 다 active" 를 만들고, 그러면 서빙이 어느 쪽을 고르는지가 조회 순서에 달린다
--    (= 새로고침마다 아트가 바뀐다). 부분 유니크 인덱스가 그 상태를 **존재 불가능**하게 만든다.
CREATE UNIQUE INDEX idx_char_bundles_active ON char_bundles(active) WHERE active = 1;
CREATE INDEX idx_char_bundles_time ON char_bundles(created_at DESC);
