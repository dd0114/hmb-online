-- #252 상대 밸런스 + 리그 승급 난이도 곡선.
-- 설계·실측 근거 = docs/plan-v5/opponent-balance.md.
--
-- 번호 배정: main 이 **V28** 로 확정(#251 머지로 V25~V27 이 점유됨 — dice_purchase_removed ·
-- notices · away_forfeit_isolation). 브랜치가 번호를 선점하지 않는다는 규칙에 따라 임시 V25 로
-- 작업한 뒤 머지 조율 시점에 리넘버했다. 내용은 무변경이고 이 파일에 번호 의존 로직은 없다.
--
-- 전부 **additive 컬럼 + 기본값**이라 되돌리기가 값 하나다(코드 리버트 불필요) — 롤백표는 이슈 #252.

-- ── 유저 디비전 ─────────────────────────────────────────────────────────────
-- 난이도의 SoT. 봇 강도는 **디비전만의 함수**다(유저 로스터를 보지 않는다 = 고무줄 밴딩 없음).
-- 카드를 모아 강해진 만큼 아래 디비전이 실제로 쉬워져야 진행감이 생기고, 못 따라가면 강등이 안전판이다.
-- 기본값 10 = 입문(가장 쉬움). 기존 유저도 이 값으로 시작한다 — 라이브 완주자가 0명이라
-- 소급할 승급 이력이 없다(2026-07-29 스냅샷: 리그 유저 5명 전원 season_no=1·ACTIVE).
ALTER TABLE users ADD COLUMN division INTEGER NOT NULL DEFAULT 10;

-- ── 시즌에 디비전 박제 ──────────────────────────────────────────────────────
-- 왜 users.division 을 그때그때 읽지 않고 시즌에 박아두나: 시즌 도중 승급/강등이 일어나면
-- 이미 치른 라운드와 남은 라운드의 상대 강도가 달라져 순위표가 뜻을 잃는다. 시즌은 시작할 때
-- 정해진 난이도로 끝까지 간다.
ALTER TABLE league_seasons ADD COLUMN division INTEGER NOT NULL DEFAULT 10;

-- ── 봇 행 분류 + 강도 배율 ──────────────────────────────────────────────────
-- kind: 'seed' = bots.v*.json 에서 임포트한 연습 상대 / 'league' = 시즌 생성이 만든 리그 봇팀.
--
-- 이 컬럼이 없어서 생긴 실제 결함(#252 BL-1): LeagueService.insertBotRows 가 리그 봇 9팀을 같은
-- bots 표에 넣고 BotService.pickRandom 은 표 **전체**에서 뽑았다. 라이브에서 이미 리그팀 45행 :
-- 시드봇 3행 이라 "설계된 입문 상대"가 뽑힐 확률이 6.25% 였고, 시즌마다 9행씩 늘어 0으로 수렴한다.
-- 기본값 'seed' 는 안전한 쪽이 아니라 **기존 행의 사실**에 맞춘 것이 아니므로 아래에서 즉시 교정한다.
ALTER TABLE bots ADD COLUMN kind TEXT NOT NULL DEFAULT 'seed';

-- 봇 능력치 배율(1.00 = 미적용). 디비전 등급 슬롯만으로는 하한(전원 BRONZE)을 못 넘는 입문 구간에서만
-- 쓴다. MatchOrchestrator 가 SelectData 를 만들 때 곱하고, 화면에 뜨는 팀 파워도 같은 값을 반영한다
-- (표시 = 실제). 리그 봇팀은 시즌 생성 시 그 디비전의 값이 실린다.
ALTER TABLE bots ADD COLUMN strength_mul REAL NOT NULL DEFAULT 1.0;

-- 기존 리그 봇팀 행 교정: league_fixtures 가 참조하는 팀이 곧 리그팀이다(구 데이터엔 다른 표식이 없다).
UPDATE bots SET kind = 'league'
WHERE id IN (SELECT DISTINCT home_team FROM league_fixtures WHERE home_team <> 'USER')
   OR id IN (SELECT DISTINCT away_team FROM league_fixtures WHERE away_team <> 'USER');

-- 원정(#245) 고스트 행도 연습 풀이 아니다. AwayService.bakeGhost 가 만드는 id 는 'GHOST_' 접두다.
-- 이걸 빠뜨리면 실유저 덱(성장 스탯 박힌)이 연습 랜덤 상대로 뽑힌다 — BL-1 과 같은 결함의 다른 문.
UPDATE bots SET kind = 'away' WHERE id LIKE 'GHOST\_%' ESCAPE '\';

-- ── 진행 중 시즌 일회성 완화 (#252 Q3 = "즉시 적용") ────────────────────────
-- 진행 중 ACTIVE 시즌의 봇팀은 **구 사다리로 이미 생성**돼 로스터가 박제돼 있다(XI 파워 ~6861 =
-- "전원 GOLD" 급). 로스터를 다시 뽑으면 이미 치른 라운드의 상대가 사후에 바뀌어 순위표가 거짓이 된다.
-- 그래서 로스터는 그대로 두고 **배율만** 걸어 남은 라운드를 완화한다.
--
-- 값 0.85 의 근거(opponent-balance.md §3.2 실측 곡선): 6861 × 0.85 ≈ 5832 ≈ 디비전 4 대역 →
-- 신규 유저 기준 승률 ~34.6% → ~44%. D10(4663)까지 내리려면 배율 0.68 이 필요한데, 그러면 로스터에
-- 박힌 LEGEND/DIA 카드의 능력치가 눈에 띄게 망가져 보인다(간판 선수 너프). 완화 폭과 표시 위화감의
-- 절충점이다. **새 시즌부터는 배율 없이 등급 사다리가 정상 동작**한다.
UPDATE bots SET strength_mul = 0.85
WHERE kind = 'league'
  AND id IN (
    SELECT f.home_team FROM league_fixtures f
      JOIN league_seasons s ON s.id = f.season_id AND s.state = 'ACTIVE'
    UNION
    SELECT f.away_team FROM league_fixtures f
      JOIN league_seasons s ON s.id = f.season_id AND s.state = 'ACTIVE'
  );
