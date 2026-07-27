-- #215 W2 — 덱 저장 시 AI 인풋(A 베이스) 선실행 원장.
--
-- 왜 원장이 따로 필요한가: A 잡(ai_jobs, match_id IS NULL)의 id 는 **덱 내용 해시**라 같은 덱을 가진
-- 여러 유저가 한 행을 공유한다. 그래서 잡 테이블만 봐서는 "이 유저가 지금 기다리는 A 가 무엇인지",
-- "이 A 를 아직 누가 쓰는지"를 알 수 없다. 이 표가 그 대응을 소유한다 —
--   ① 유저당 유효 prewarm 정확히 1행(PK) = 저장을 연타해도 AI 콜이 저장 횟수만큼 늘지 않는다(예산 가드 P2-D8)
--   ② 재저장 시 직전 잡 회수 여부의 판단 근거(다른 유저가 같은 base_id 를 참조하면 건드리지 않는다)
--
-- 회수 대상은 "아무도 안 물었고(queued·attempts=0) 아무도 안 쓰는" 잡뿐이다. done 은 캐시 자산이라 남긴다
-- (#193 supersede 가 done 을 지우지 않는 것과 같은 이유 — 지시를 되돌리면 그 결과를 다시 써야 한다).
CREATE TABLE deck_prewarm (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  base_id    TEXT NOT NULL,          -- ai_jobs.id (= A 캐시 키, sha256(baseContextKeyMaterial)[:32])
  updated_at TEXT NOT NULL
);

-- 회수 판정("이 base 를 나 말고 참조하는 유저가 있나")이 매 저장마다 도는 조회다.
CREATE INDEX idx_deck_prewarm_base ON deck_prewarm(base_id);
