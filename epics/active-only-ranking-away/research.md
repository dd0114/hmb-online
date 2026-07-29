# R — Research: 랭킹·원정 "게임 한 판 한 유저만" 자격 필터

**에픽 slug**: `active-only-ranking-away` · **transport**: github `dd0114/hmb-online` · **작성**: 2026-07-29, 세션 `hmb:awaypts`
**배경 원장**: 이슈 #288(라이브 운영 조치 — 허수 148계정 −1000 차감, 현현·홍수몬 복구)

---

## Facts — 현재 코드 상태

### F1. 랭킹은 가입 계정 전량을 노출한다 (필터 0)
`server-java/src/main/java/online/hmb/ranking/RankingService.java:rankedUsers()`
```sql
FROM users u LEFT JOIN matches m ON m.user_id = u.id GROUP BY u.id, u.nickname
```
- `WHERE` 절 없음 → **가입만 한 계정도 전부 리더보드에 실린다**.
- 정렬: `rating desc → wins desc → winRate desc → nickname asc`, 순위 = 행번호.
- 기본 limit 20 / 최대 100 (`LEADERBOARD_DEFAULT`, `LEADERBOARD_MAX`).

### F2. ⚠️ `me` 조회가 404 로 깨진다 — 필터를 넣으면 반드시 같이 고쳐야 한다
같은 파일 `getRankings()`:
```java
RankingEntry me = ranked.stream().filter(e -> e.userId().equals(userId)).findFirst()
        .orElseThrow(() -> ApiException.notFound("유저를 찾을 수 없습니다"));
```
- `me` 를 **필터된 목록에서** 찾는다 → 자격 없는 유저가 `GET /api/rankings` 를 부르면 **404**.
- 화면 영향: `apps/web/src/logs/LogsPage.tsx:RankingsTab` 이 `isError` → `<ErrorToast message="랭킹을 불러오지 못했습니다" />`. 즉 **신규 유저가 랭킹 탭을 열면 에러 토스트**를 본다. 이건 필터의 부작용이 아니라 **필터 도입이 만드는 신규 결함**이다.
- 다행히 web 은 "me 가 리더보드에 없는 경우"를 이미 처리한다 — `data.me && !leaderboard.some(...)` → 별도 `(나)` 행(`data-testid="lb-me"`). 즉 **me 를 자격 없음 상태로라도 내려주면 표시 경로는 이미 있다.**

### F3. 원정 상대 후보 = 활성 덱 보유자 전원. 덱은 활동 증거가 아니다
`server-java/src/main/java/online/hmb/away/AwayService.java:candidatesInBand()`
```sql
FROM users u JOIN decks d ON d.user_id = u.id AND d.is_active = 1
LEFT JOIN user_ratings r ON r.user_id = u.id
WHERE u.id <> ? AND ABS(COALESCE(r.rating,0) - ?) <= ?
```
- **덱은 가입 시 자동 지급**(스타터 15장). 라이브 실측: 활성 덱 40명 중 카드가 15장 초과(=실제로 뽑기/성장한) 계정은 9명뿐.
- `bandPool()` 이 밴드를 `±50 → ×2 → ×3 → ×4(±200)` 로 넓히고, 그래도 비면 **전체**로 폴백.
- `bandPool()` 은 `offerCandidates()`(2택 제시)와 `start(defenderId=null)`(무지정) **양쪽이 쓰는 유일한 출처** → 여기 한 곳만 고치면 두 진입점에 모두 적용된다. (MAJ-1 회귀 방지 주석이 이미 그 단일화를 지키고 있다.)
- `offerCandidates()` 에 이미 `deckIsPlayable(c.userId())` 후보 필터가 있다 → **자격 필터를 넣을 자연스러운 자리가 이미 존재**.

### F4. 공격자 쪽 자격은 "활성 덱 유효 + 일일 한도"뿐
`AwayService.start()`: `assertUnderDailyLimit()` → `deckService.getActiveDeck/validate`(루프 밖, #217 blocker 회귀 방지) → 후보 선정.
- **경기 이력을 요구하지 않는다.** 가입 직후 바로 원정 가능.

### F5. config 위치
`server-java/src/main/resources/application.yml` `hmb.away.match.*` (rating-band 50 · candidate-count 2 · offer-ttl-sec 600 · daily-limit 10). 랭킹 쪽은 현재 config 키 없음(상수 `LEADERBOARD_DEFAULT/MAX` 하드코딩).

### F6. 기존 테스트
- `server-java/src/test/java/online/hmb/RankingApiTest.java` — **클래스 단위 DB 공유**(메서드 간 유저 누적)라 절대 순위 대신 **상대 순위·전역 정렬 불변식**으로 검증한다. 새 테스트도 이 방식을 따라야 한다.
- `AwayRaidTest` · `AwayV2Test` · `AwayLoopFailurePropagationTest`.

---

## Facts — 라이브 실데이터로 잰 필터 효과 (160계정)

| 자격 기준 | 통과 인원 |
|---|---:|
| 경기 1판 이상(전체) | **23** |
| 완료 경기(`result IS NOT NULL`) 1판 이상 | **23** (동일 — 진행 중 매치만 가진 계정 0) |
| 연습 1판+ | 18 · 리그 4 · 원정 2 |

### ⚠️ RISK-1 (가장 중요) — 필터만으로는 허수가 안 걸러진다
"경기 1판 이상" 통과 23명 중 **13명이 개발/배포·허수 계정**이다:
`eee · afasdf · d201b29310 · v802p19738 · v8probe4605 · fullplay · v801p15243 · v7probe25 · pw3426 · ev28599 · ev24352 · v803p9347 · d2p1434`
→ **우리 스모크는 거의 항상 경기를 한 판 돌리기 때문**에 자격 기준을 통과한다.

**따라서 hero 가 물었던 "−1000 차감을 되돌릴지"의 답이 데이터로 나온다 — 되돌리면 안 된다.**
되돌리는 순간 위 13개가 랭킹에 다시 올라오고 원정 밴드 안으로 복귀한다. 필터는 **미래의 신규 허수**를 막고, 차감은 **이미 쌓인 과거 허수**를 눌러둔다 — 둘은 대체재가 아니라 보완재다.

### RISK-2 — 실유저 1명이 랭킹·원정에서 빠진다
`ㄱㅅㅇ`(카드 36장·뽑기 2회, **경기 0판**) — 실플레이 유저인데 아직 경기를 안 해서 자격 미달.
원정 상대 후보 풀: 현재 11명 → 필터 후 **10명**. (`현현`·`홍수몬` 도 경기 0이라 원정 풀에서 빠지지만 이들은 덱만 있는 계정.)

### RISK-3 — 오픈베타 풀 두께
후보 풀이 얇아지면 `NO_OPPONENT` 이 늘 수 있다. 다만 `bandPool()` 의 단계적 확장 + 전체 폴백이 있어 후보 2명(`candidate-count`)은 확보된다. 자격 필터를 **폴백 경로에도 적용할지**가 설계 포인트 — 적용하지 않으면 폴백이 필터의 우회로가 된다(F3 의 MAJ-1 과 같은 종류의 구멍).

---

## Open Questions — 설계에서 정해 hero 컨펌 받을 것

| # | 질문 | 후보 |
|---|---|---|
| Q1 | "경기 1판"의 정의 | (a) `matches` 행 존재 (b) `result IS NOT NULL` 완료분만 — 라이브에선 둘이 동일(23명)이나, 중도 이탈/ABANDONED 를 자격으로 칠지가 갈린다 |
| Q2 | 어떤 모드를 세나 | 연습 포함 전부 / 리그·원정만(연습은 봇전) — 라이브 18명이 연습만 |
| Q3 | 자격 없는 유저의 `me` 처리 (F2) | rank=null + `eligible:false` 필드 추가 후 web 이 "경기 1판 하면 랭킹에 등록됩니다" 안내 / rank=0 / 404 유지(불가) |
| Q4 | 공격자 자격도 요구할까 (F4) | 요구(내가 한 판도 안 했으면 원정 불가) / 방어자 풀만 필터 |
| Q5 | 밴드 전체 폴백에도 필터 적용? (RISK-3) | 적용(권장 — 우회로 차단) / 미적용 |
| Q6 | 기존 −1000 차감 146계정 | **유지**(RISK-1 근거) / 되돌림 |

## Relevant paths
- `server-java/src/main/java/online/hmb/ranking/RankingService.java` (rankedUsers, getRankings, RankingEntry)
- `server-java/src/main/java/online/hmb/away/AwayService.java` (candidatesInBand, bandPool, offerCandidates, start)
- `server-java/src/main/resources/application.yml` (`hmb.away.match.*`, 신규 자격 키)
- `server-java/src/test/java/online/hmb/{RankingApiTest,AwayRaidTest,AwayV2Test}.java`
- `apps/web/src/logs/LogsPage.tsx` (RankingsTab·Leaderboard — me 표시 경로 존재)
- `docs/plan-v2/api/openapi.yaml` (RankingEntry 계약 — 필드 추가 시 갱신)

## 게이트 메모
- server-java 테스트는 **`--rerun-tasks` 필수**(UP-TO-DATE 거짓 green), 절대경로로 실행.
- web 변경이 생기면 `apps/web` **build 가 유일한 타입 게이트**(루트 typecheck 는 web 을 안 본다).
