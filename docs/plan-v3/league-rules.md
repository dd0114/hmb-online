# 리그 규칙 고증 (AC-F5)

> HMB 온라인 Phase 2 리그 모드가 참조한 **실제 리그 규칙**과, 그 규칙을 서버(`server-java`)에서
> 어떻게 결정론적으로 구현했는지 명시한다. SoT 스펙 = `PRD-v3.md` §F(P2-D10) + `LLD-p2-server.md` §6 +
> `ERD-v2.md`(league_seasons/league_fixtures). 구현 = `online.hmb.league.LeagueService`.

## 1. 대회 형식 — 더블 라운드로빈 (home-and-away)

- **참조**: 잉글랜드 프리미어리그·유럽 주요 정규리그의 표준 포맷 — 모든 팀이 서로 **홈 1경기 + 원정 1경기**를
  치른다(double round-robin, "home and away").
- **HMB**: 10팀(유저 1 + 봇 9). 한 팀당 상대 9팀 × 2경기 = **18 라운드**, 라운드당 5경기(각 팀 1경기).
  - 총 픽스처 = 10팀 × 9상대 = 90경기. 유저 경기 18(라운드마다 1), 봇 vs 봇 72(라운드마다 4).
- **일정 생성 = 서클 메서드(circle method / polygon method)**: 라운드로빈 스케줄링의 표준 알고리즘.
  한 팀을 고정하고 나머지를 회전시켜 각 라운드의 대진을 만든다(`LeagueService.circleMethod`).
  - **1레그(라운드 1–9)**: 단일 라운드로빈. **2레그(라운드 10–18)**: 1레그의 홈/어웨이를 뒤집어 대칭
    보장(각 순서쌍 (home, away)이 시즌 전체에서 정확히 1회 등장).
  - 홈/어웨이 배정은 라운드·대진 위치 패리티로 균형을 맞춰 특정 팀이 홈에만 몰리지 않게 한다.

## 2. 승점제 — 3-1-0 (three points for a win)

- **참조**: 1981년 잉글랜드 도입 후 FIFA가 1994년부터 전 세계 표준으로 채택한 **승리 3점 / 무승부 1점 /
  패배 0점** 제도. 공격 축구 장려가 도입 취지.
- **HMB**: `WIN=3, DRAW=1, LOSS=0` (`LeagueService.WIN_POINTS/DRAW_POINTS`). 순위표는 저장하지 않고
  `league_fixtures`의 PLAYED 경기에서 매번 파생 계산(`computeStandings`).

## 3. 타이브레이커 (동점 시 순위 결정)

승점이 같을 때 다음 순서로 비교한다 — **PRD-v3 P2-D10 확정 순서**:

1. **골득실(goal difference)** = 득점 − 실점. (프리미어리그 1순위 타이브레이커와 동일)
2. **다득점(goals scored / goals for)**. (프리미어리그 2순위)
3. **승자승(head-to-head)** = 동점 팀 간 맞대결에서 획득한 승점.
   - 프리미어리그는 승자승을 쓰지 않지만(플레이오프), **라리가·세리에A 등 다수 유럽 리그는 승자승을
     우선/후순위 타이브레이커로 사용**한다. HMB는 P2-D10에 따라 골득실·다득점 **다음** 최종 타이브레이커로 둔다.
   - **구현 주의**: 승자승은 두 팀 동점(2-way tie)에 대해 정확한 pairwise 비교로 구현했다(맞대결 승점 차).
     3팀 이상 동점의 미니리그 순환(비-전이적) 상황은 PoC 범위에서 pairwise 근사로 처리하며, 완전 동률은
     `teamId` 안정 정렬로 결정론을 보장한다.

## 4. 홈 어드밴티지 (home advantage)

- **참조**: 실제 축구에서 홈팀은 통계적으로 승률·득점이 높다(관중·이동 부담·경기장 친숙도). 시뮬레이션
  리그(예: FM류)는 홈 보정 계수로 이를 반영한다.
- **HMB — 유저 경기**: 엔진 시뮬은 **엔진 home = 픽스처 home_team** 계약을 지킨다. 유저가 어웨이 픽스처면
  유저가 실제로 **away 사이드**로 배치되고(홈 어드밴티지는 상대 봇에게), 픽스처 정산은 엔진 home/away
  스코어를 픽스처 home/away에 직접 매핑한다. 결과(WIN/DRAW/LOSS)·보상·관계 변동은 **유저 관점**으로 계산.
- **HMB — 봇 vs 봇 간이결과**: 유저가 관여하지 않는 4경기/라운드는 **팀 파워 + 홈 보정** 확률 모델로
  결정론 생성한다(§5).

## 5. 봇전 간이결과 모델 (AC-F2)

유저 경기만 풀 AI+엔진 시뮬을 돌리고, 나머지 봇 vs 봇은 **팀 파워 기반 푸아송 근사**로 스코어를 만든다.
전부 시드 결정론(`league_seasons.seed` + 픽스처 id 파생) — DB 저장 스코어와 재계산이 항상 일치(AC-F2 테스트).

- **팀 파워** = 선발 11명 능력치 9종 합의 총합(`teams_json.power`).
- **기대 득점**(`expectedGoals`, 계수는 `application.yml hmb.league.sim.*` — 하드코딩 금지):
  - `homeExpected = base-goals + (homePower − awayPower)/power-divisor + home-advantage`
  - `awayExpected = base-goals + (awayPower − homePower)/power-divisor`
  - `[0.05, max-goals]` 클램프.
  - 기본값: `base-goals=1.10`, `power-divisor=120`, `home-advantage=0.35`, `max-goals=8`.
  - **홈 보정 방향**: 파워가 같으면 `homeExpected(=base+home-advantage) > awayExpected(=base)` — 홈팀 기대
    득점이 항상 더 높다.
- **스코어 샘플** = 각 팀 기대득점을 매개변수로 한 **Knuth 푸아송 샘플**(시드 RNG 결정론), `max-goals` 클램프.

## 6. 시즌 라이프사이클 (AC-F3/F4)

- 상태: `ACTIVE`(진행) → 18R 전 경기 PLAYED → `FINISHED`(CAS 전이).
- **중단·재개**: 순위·일정·진행이 전부 DB(`league_seasons`/`league_fixtures`)에 있어 자연 지원. 유저는
  `next-match`로 다음 SCHEDULED 유저 픽스처를 순서대로 진행한다.
- **순위 보상**(AC-F4): 시즌 FINISHED 시 유저 최종 순위에 따라 `league.v1.json rewards[rank→points]`를
  포인트로 지급. 원장 `reason='league_reward', ref_id=seasonId` — **시즌당 정확히 1회 멱등**.
- **새 시즌**: FINISHED 후 `POST /api/league/start`로 `season_no+1` 재시작(봇팀·일정 새 시드 재생성).

## 7. 참조 요약

| 항목 | 실제 참조 | HMB 구현 |
|---|---|---|
| 형식 | 더블 라운드로빈(home & away) | 10팀 18R, 서클 메서드 + 2레그 스왑 |
| 승점 | 3-1-0 (FIFA 표준, 1994~) | WIN 3 / DRAW 1 / LOSS 0 |
| 타이브레이커 | 골득실→다득점→(리그별)승자승 | 골득실→다득점→승자승(pairwise) |
| 홈 어드밴티지 | 통계적 홈 우세 | 유저=엔진 사이드 반영, 봇전=홈 보정 계수 |
| 봇전 | (시뮬리그 관행) 능력치 기반 확률 | 팀 파워+홈보정 푸아송, 시드 결정론 |
