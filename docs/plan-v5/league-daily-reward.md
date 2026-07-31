# 리그 매판 보상 트랙 + 승급/강등 컷 — 설계 (#368)

> hero 확정 스펙(2026-07-31)을 구현 설계로 옮긴 문서. 스펙 자체는 이슈 #368 본문이 SoT.
> 이 문서는 **어떻게 만들었나**(모델·저장·경로·계약)를 담는다.

## ⚠️ hero 세션 확정 (2026-07-31, W1 게이트) — 초기안에서 두 가지가 바뀌었다

1. **보상 구조 = 얹는다.** 기존 리그 경기 보상(#212 `rewards.byMode.league` — 승 5,000 G ·
   무 2,000 G · 패 1,000 G)은 **그대로 두고** 그 위에 트랙 다이아가 붙는다. 트랙은 "리그 보상"이
   아니라 **다이아 수급의 새 축**이다. (대체안 = 트랙이 리그 보상을 대신하고 무·패는 0 — 기각.)
2. **골드 사이클 제거.** 초기 확정 ②의 *"18판 소진 후 같은 리듬으로 골드 300/3,000 무한반복"* 을
   hero 가 철회했다. **하루 트랙은 다이아 18칸으로 끝**이고, 19번째부터는 자정까지 트랙 보상이 없다
   (경기 자체와 경기 보상은 그대로 굴러간다).
   ⇒ 그래서 아래 설계에 **통화 단계(cycleNo)·골드 금액이 없다**. `LeagueDailyReward` 는 통화를 노브로
   갖지만 **하루 한 트랙만** 표현한다 — 사이클을 되살리려면 통화를 바꾸는 게 아니라 축을 새로 설계해야 한다.
3. **화면 = 시안 A(배틀패스 레일).** 보상 칸이 위, **상대팀 마크가 아래**, 진행선이 칸을 관통하고
   다음 칸에 `지금` 깃발. 칸에 상대가 붙어 트랙이 곧 "오늘의 일정"이 된다. 헤더 요약은
   **오늘 받은 횟수**. 18칸을 한 줄에 담지 않고 **가로 스크롤**한다(hero 지시).
   ⚠️ **클럽 엠블럼 아트가 리포에 0개**라 마크는 팀 이름 해시로 만드는 **생성 크레스트**다
   (`common/TeamCrest.tsx`). 실아트가 발행되면 그 컴포넌트 안만 갈아끼운다.

---

## 0. 요약 — 다섯 축 중 하나는 이미 되어 있다

| 축 | 상태 | 내용 |
|---|---|---|
| 1. 서버 슬롯 상태 | **신규** | `league_daily_rewards`(V36) + `LeagueDailyRewardService` + KST 일 경계 |
| 2. 승급/강등 컷 | **✅ 이미 확정값** | `promote-rank-max: 2` · `relegate-rank-min: 9` 가 **이미** application.yml 에 있다(#252). 클램프도 있다 → **코드 변경 0**, 계약만 |
| 3. web 보상 트랙 | 신규 | 리그 화면 트랙 + 결과 화면 획득 표시 |
| 4. 경제 가드 | 신규 | economy `league.dailyReward` 노브 + 폴백 + 다시드 스윕 |
| 5. 정합 | 확인 | 오토모드·프리제너레이션·시즌보상(#251)·원정/연습 |

### ⚠️ 축 2 는 "하기로 한 일"이 아니라 "이미 그런 일"이다

```yaml
# server-java/src/main/resources/application.yml (현재 main)
    division:
      promote-rank-max: 2          # 최종 1~2위 = 승급(level-1)
      relegate-rank-min: 9         # 최종 9~10위 = 강등(level+1). 3~8위는 유지
```

hero 확정 "1~2등 승급 · 9~10등 강등 · 3~8등 잔류 · 사다리 끝 클램프 유지"와 **글자 그대로 같다**.
`nextDivision` 의 클램프와 `effectivePromoteCut`/`effectiveRelegateCut`(컷을 null 로 잘라 보내기)도
#252 BL-1 에서 이미 들어갔다. ⇒ 이 축에서 할 일은 **바꾸는 것이 아니라, 지금 값이 hero 확정과
같다는 것을 계약으로 못 박는 것**이다(다음에 누가 튜닝하면 계약이 먼저 깨져 이 결정을 다시 보게 된다).

---

## 1. 슬롯 모델

### 정의

- **슬롯 = 그날(KST) 치른 리그 경기의 순번.** 승·무·패와 무관하게 **소비**된다.
- 하루의 n번째 리그 경기 → 절대 슬롯 번호 `n`(1-based, KST 자정에 1로 리셋).
- 트랙 길이 `slotsPerDay = 18`. **19번째부터는 트랙 밖**이다(금액 0, 자정까지 그대로).
- **대량 칸** `bigSlots = [9, 18]`. 그 외는 소량.
- 재화 = 다이아(GEM/Z) 하나. 금액(economy 노브, 아래 §4): 소량 **30 Z** · 대량 **300 Z**.
- **지급은 승리(WIN)에만.** 무승부·패배는 **슬롯만 소비되고 그 슬롯 보상은 소멸**(hero 확정 ①).
  - ⚠️ 무승부를 승리에 붙이지 않는다 — 확정 문구가 *"승리 시에만 수령"* 이다. 무승부는 승리가 아니다.

### 하루 상한 (참고)

전승 시 **1,080 Z**(16×30 + 2×300). 리그 시즌은 18라운드(10팀 더블 라운드로빈)라
**한 시즌 = 정확히 하루치 트랙 한 판**이다.

실측(다시드 경제 스윕, `LeagueDailyRewardEconomyProbeTest`, 승률대별 500시드):

| 승률 | p50 | 평균 | p90 | 최대 | 30일 평균 |
|---|---|---|---|---|---|
| 30% | 330 | 326 | 660 | 870 | 9,783 |
| 45% | 480 | 487 | 840 | 960 | 14,598 |
| 60% | 630 | 656 | 930 | 1,020 | 19,669 |
| 75% | 900 | 814 | 1,020 | 1,080 | 24,417 |
| 90% | 1,020 | 976 | 1,080 | 1,080 | 29,290 |
| 100% | 1,080 | 1,080 | 1,080 | 1,080 | 32,400 |

**서열 가드**: 하루 전승(1,080 Z)이 시즌 완주 최저 보상(3,000 Z, #251)의 **0.36배**다 —
매판 보상이 시즌 보상을 무의미하게 만들지 않는다. 이 서열이 깨지는 노브 조정은 의도한 것이어야 하고,
그때 `dailyTrackCeilingStaysUnderSeasonCompletionReward` 가 먼저 깨진다.

---

## 2. 저장 — 왜 파생이 아니라 테이블인가

슬롯 번호만 놓고 보면 `matches` 에서 파생할 수 있다(오늘 FINISHED 리그 매치 수). 그럼에도
**행을 박제한다.** 근거는 `starter_grants`(#209)와 같다:

> 금액·주기·큰슬롯 위치가 **전부 config 노브**다. 읽을 때마다 다시 계산하면 운영이 노브를 돌리는
> 순간 **오늘 이미 받은 보상의 이력이 소급 변조**된다("아까 300 받았는데 화면엔 30").
> 지급 사실은 계산으로 만들지 않는다.

부수 효과로 **"보상이 얼마짜리 슬롯이었나"가 승패와 무관하게 남는다** — 소멸한 슬롯도 얼마를
날렸는지 화면이 말할 수 있다(트랙 UI 의 절반이 이것이다).

### V36__league_daily_reward.sql

```sql
CREATE TABLE league_daily_rewards (
  match_id   TEXT PRIMARY KEY,                       -- 멱등 축 ①: 매치당 한 행
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,                          -- 'yyyy-MM-dd' (KST)
  slot_no    INTEGER NOT NULL,                       -- 그날 절대 순번 1..N
  currency   TEXT NOT NULL,                          -- 'GEM' | 'POINT'
  amount     INTEGER NOT NULL,                       -- 그 슬롯의 값(승패 무관 — 소멸분도 얼마였는지 남는다)
  result     TEXT NOT NULL,                          -- 'WIN' | 'DRAW' | 'LOSS'
  awarded    INTEGER NOT NULL,                       -- 1 = 실지급, 0 = 소멸
  opponent_name TEXT,                                -- 그때 붙은 상대 팀명(표시용 스냅샷)
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX uq_league_daily_slot ON league_daily_rewards(user_id, day, slot_no);
CREATE INDEX idx_league_daily_user_day  ON league_daily_rewards(user_id, day);
```

**멱등은 두 층**(#251·#245 규율 그대로):
1. `match_id` PK — 같은 매치가 두 번 정산돼도 두 번째 INSERT 가 무시된다.
2. 원장 유니크 `(user_id, reason, ref_id)` — `walletService.apply*` 가 이미 보장. 1층이 뚫려도 돈은 안 샌다.

`uq_league_daily_slot` 은 **한 슬롯이 두 매치에 팔리는 것**을 막는다(1층은 매치 축, 이건 슬롯 축).

---

## 3. 지급 경로 — 기존 정산 자리에 선다

`MatchOrchestrator.finishMatch` 의 **FINISHED CAS 통과 이후**, 리그 픽스처 정산 바로 옆.
#245 원정 정산·#179 성장 정산과 **같은 자리·같은 규율**이다(CAS 통과 후 1회, 내부 멱등).

```java
// #368: 리그 매판 일일 보상 슬롯. 리그 픽스처 정산과 같은 자리 — FINISHED CAS 통과 후 1회.
if ("league".equals(match.mode()) && match.leagueFixtureId() != null) {
    leagueService.settleUserFixture(match.leagueFixtureId(), totalHome, totalAway);
    leagueDailyRewardService.settle(match.id(), match.userId(), result, finishedAt);
}
```

실제 시그니처는 `settle(matchId, userId, result, finishedAt)` 이고 종료 시각은 `clockService.now()` 다.
`LeagueDailyRewardService.settle`:

1. `day = conditionService.dateOf(finishedAt)` — **종료 시각 앵커**
   - ⚠️ **생성 시각이 아니다.** 슬롯은 "그날 몇 번째로 **친** 판"이고, 유저가 화면에서 보는 시각도
     결과 시각이다. 생성 시각으로 앵커하면 23:58 에 시작해 00:03 에 끝난 경기가 **어제 슬롯**을
     먹고, 유저는 오늘 트랙에서 그 판이 사라진 걸 본다.
   - 존 기준은 `ConditionService.dateOf`(Clock 존 = KST) — #245 가 *"세션에서 같은 종류의
     시각-문자열 버그를 두 번 잡혔다"* 고 적어 둔 그 함수. **문자열 비교로 날짜를 만들지 않는다.**
2. `slotNo = COALESCE(MAX(slot_no), 0) + 1 WHERE user_id=? AND day=?`
3. `slotNo` → `currency`·`amount` 를 economy 노브에서 결정(트랙 밖이면 금액 0, §4)
4. `INSERT OR IGNORE` → **0 행이면 이미 정산됨, 즉시 종료**(멱등)
5. `result == "WIN"` 이면 지급, 아니면 `awarded = 0` 으로 남기고 끝
   - GEM → `walletService.applyGems(userId, amount, "league_daily_gem", matchId)`
   - POINT → `walletService.apply(userId, amount, "league_daily_point", matchId)`
     (통화는 노브라 분기를 남겨 뒀다. 지금 발행값은 GEM 뿐이다.)
   - **기존 지갑·원장 경로 재사용**(재발명 금지, 이슈 요구사항 ①)
   - 상대 팀명은 정산 시점에 `bots.name` 을 읽어 **박제**한다 — 봇 행은 시즌마다 새로 생기므로
     나중에 조인해 만들면 지난 트랙의 상대가 조용히 바뀌거나 사라진다.

### 동시성

유저당 진행 중 매치는 최대 하나(`MatchLockService`, #217)라 같은 유저의 두 리그 매치가
동시에 FINISHED 가 되는 경로가 없다. 그래도 슬롯 유니크 인덱스를 두는 이유는 **미래의 경합**
(대량 정산 배치·재정산 도구)이 조용히 슬롯을 겹쳐 팔지 못하게 하기 위해서다.

---

## 4. economy 노브 (무배포 튜닝)

`economy.v3.json` 의 `league` 블록에 **추가**(#251 이 `gemReward` 를 같은 자리에 넣은 선례):

```json
"league": {
  "rewardsFile": "league.v1.json",
  "rewardsRef": "rewards",
  "gemReward": { "completion": 3000, "rankBonus": { "1": 6000, "2": 3000, "3": 1000 } },
  "dailyReward": {
    "slotsPerDay": 18,
    "bigSlots": [9, 18],
    "currency": "GEM",
    "small": 30,
    "big": 300
  }
}
```

- **폴백 상수** `EconomyService.DEFAULT_LEAGUE_DAILY_REWARD` 를 같이 둔다 — 이유는 #251 이 적어 둔
  **override 트랩**과 같다: 운영 override 는 무배포로 얹힌 **구 스냅샷**이라 새 필드가 없다.
  "모르면 0원"이면 **override 가 깔린 라이브에서만** 보상이 조용히 사라진다(테스트 환경에선 안 보인다).
  소비는 항상 값을 돌려주는 접근자 `economyService.leagueDailyReward()` 로만.
- ⚠️ **`bigSlots` 는 통짜 교체다**(`rankBonus` 와 같은 성질). `[9]` 만 적으면 18번 대량은 **사라진다**.
- ⚠️ **테스트 픽스처(`fixtures/economy.v1.json`)의 금액은 발행물과 일부러 다르게 둔다** —
  **6칸 · 3·6 대량 · 7 / 70**. 같게 두면 "config 를 무시하고 상수를 쓰는" 변이체가 전 스위트를
  통과한다(#251 독립검증 MAJOR-1 이 실제로 그랬다). 발행값 검증은 별도 테스트가 따로 한다.
- ⚠️ **`TestDbSupport.registerTempDb` 가 모든 테스트에 이 픽스처를 물린다.** 그래서 경제 스윕이
  `economyService` 로 재면 실경제가 아니라 6칸 곡선을 잰다(초판이 실제로 그랬고 "시즌 보상의 0.02배"
  라는 무의미한 리포트가 나왔다). **경제 판정은 발행 파일을 직접 읽는다.**

---

## 5. 조회 계약 — 서버가 트랙을 통째로 그려 준다

### `GET /api/league` 에 additive 최상위 블록

시즌 DTO **밖**이다. 슬롯은 시즌이 아니라 **하루**에 매인다 — 시즌이 없어도 존재하고, 시즌 경계를
넘어 이어진다. 시즌 안에 넣으면 "시즌 없는 유저의 오늘"을 표현할 자리가 없다.

```jsonc
{
  "season": { … },                       // 기존 그대로
  "dailyReward": {                       // ← additive (구 클라는 무시)
    "day": "2026-07-31",
    "slotsPerDay": 18,
    "consumed": 2,                       // 오늘 친 리그 경기 수(트랙 상한을 넘을 수 있다)
    "awardedCount": 1,                   // 헤더의 "오늘 n회 받음"
    "earned": 30,
    "currency": "GEM",
    "slots": [                           // **18칸 통째로**
      { "slotNo": 1, "currency": "GEM", "amount": 30,  "big": false, "state": "WON",     "opponentName": "Ironclad FC" },
      { "slotNo": 2, "currency": "GEM", "amount": 30,  "big": false, "state": "MISSED",  "opponentName": "Shadow Wolves" },
      { "slotNo": 3, "currency": "GEM", "amount": 30,  "big": false, "state": "PENDING", "opponentName": "Azure Sentinels" },
      …
      { "slotNo": 9, "currency": "GEM", "amount": 300, "big": true,  "state": "PENDING", "opponentName": null }
    ],
    "next": { "slotNo": 3, … }           // 다 썼으면 **null**
  }
}
```

`state` = `WON`(승리 수령) · `MISSED`(소멸) · `PENDING`(아직 안 침).
`big` 도 **서버가 준 사실**이다 — 클라가 `slotNo % 9` 로 만들면 노브를 돌린 순간 화면이 거짓말한다.
`opponentName` = 지난 칸은 실제로 붙었던 팀(박제), 남은 칸은 **시즌 잔여 일정**의 팀. 없을 수 있다
(시즌이 없거나 일정이 트랙보다 짧으면 **정상** — 화면은 마크 없이 보상만 그린다).

**왜 서버가 18칸을 다 주나** — #262 가 컷에서 배운 것과 같은 규율이다:

> **주기·큰슬롯 위치·통화 전환 지점을 클라에 적지 마라.** 전부 config 노브라 바뀐다.
> 복제하면 "9번째가 대박"이라고 칠해 놓고 실제로는 아무 일도 안 일어나는 화면이 된다.

클라가 하는 계산은 **0**이다. 받은 배열을 그리기만 한다.

### `GET /api/matches/{id}/result` 에 additive 필드

```jsonc
{ …, "dailyReward": { "slotNo": 3, "currency": "GEM", "amount": 30, "result": "WIN", "awarded": true,
                      "opponentName": "Shadow Wolves" } }
```

⚠️ **기존 `pointsAwarded` 를 재사용하면 안 된다.** 그건 `reason LIKE 'reward_%'` 합계라
① 다이아 사이클에서는 항상 0이고 ② 통화를 말하지 못한다. 재화와 금액은 항상 같이 온다(#232).

---

## 6. web — 보상 트랙

### 리그 화면(`LeaguePage`) — 배틀패스 레일 (시안 A)

`DailyRewardTrack.tsx` + `TeamCrest.tsx`. 보상 칸이 위, **상대팀 마크가 아래**, 진행선이 칸을 관통.

```
오늘의 보상 [진행 중]                     오늘 5회 받음 · 240 Z
        ┌──┐  ┌──┐  ┌──┐ [지금]        ┌────┐
   ─────│30│──│30│──│30│───────────────│300 │──────
        └──┘  └──┘  └──┘               └────┘
         ✓     ✗     ▶                   ★
        [IF]  [SW]  [AS]                 [CV]      ← 상대팀 마크
         6     7     8                     9
7 / 18                              다음 ▶ 30 Z
```

- 다음 칸이 **화면 안에 들어오도록** 마운트 시 레일을 민다. `scrollIntoView` 는 쓰지 않는다 —
  문서 전체를 스크롤해 리그 화면이 통째로 튄다. `rail.scrollLeft` 로 레일 안에서만 움직인다.
- 카드에 `overflow: hidden` — 없으면 18칸이 문서를 밀어 390px 에서 화면 전체가 가로 스크롤한다.
- 칸 자리(`.rewardSlot`)는 **높이 고정**이다. 대량 칸(58px)과 보통 칸(44px)이 섞이면 아래 마크 줄이
  어긋난다 — 목업에서 실제로 어긋났고 **캡처로만 보였다**.
- 색 단일 채널 금지(#262 규율) — 글리프(✓/✗/▶/★) + `aria-label`(칸 번호·대량·상대·상태)을 같이 단다.
- 금액은 `<Amount code={slot.currency} value={slot.amount} />` 로만(#232). `Z`·`G` 를 코드에 적지 않는다.
- **구 서버 폴백**: `dailyReward` 가 없으면 트랙 카드를 **통째로 안 그린다**(#286 W5 규율 —
  스켈레톤·에러를 띄우면 "아직 없는 기능"이 "고장 난 화면"이 된다).
- **소진 상태에서도 카드를 지우지 않는다** — 다 채운 트랙 + "오늘 완료" + "자정에 초기화". 지우면
  "보상이 왜 안 들어왔지"가 된다.

### 결과 화면(`ResultPanel`)

```
경기 보상    + 5,000 G
오늘의 보상  3번째 칸 + 30 Z          ← 승리
오늘의 보상  9번째 칸 300 Z 소멸       ← 무/패 (취소선)
오늘의 보상  오늘 칸을 모두 썼습니다     ← 소진 후
```

**소멸도 보여준다.** 안 보여주면 유저는 칸이 소비된 줄 모르고, 다음 판에서 트랙이 한 칸 앞서 있는
이유를 알 방법이 없다 — 대량 칸을 날린 경우가 특히 그렇다. **소진 후에도 줄은 남긴다.**

## 7. 정합 (축 5)

| 경로 | 판정 |
|---|---|
| **오토모드**(#249 연속 경기) | `finishMatch` 를 **똑같이** 지나간다(감독시간만 0초). 칸이 연속 소비될 뿐 특례 없음 |
| **프리제너레이션**(#193 선행 생성) | 보상은 FINISHED 시점에 확정 — 생성 시점과 무관 |
| **시즌 종료 보상**(#251) | **별개 축, 공존.** 원장 reason 이 다르고(`league_gem_reward` vs `league_daily_gem`) ref 도 다르다(seasonId vs matchId) |
| **원정 · 연습** | 슬롯 **소비 0**(리그 모드만). 원정이 리그 곡선을 참조하는 것(#245 E6)과 무관한 축 |
| **포기(ABANDONED)** | FINISHED 가 아니라 정산 경로에 도달하지 않는다 = 슬롯 소비 0 |
| **몰수(0:0 비무승부)** | 결과가 LOSS 면 슬롯 소비 + 소멸. 정상 |

---

## 8. 계약 (E2E-TDD — 구현 전에 박는다)

### server-java

| 계약 | 무엇을 죽이나 |
|---|---|
| `slotAdvancesOnLossAndRewardVanishes` | 패배가 슬롯을 소비하지 않는 변이(= 유저가 이길 때까지 9번 슬롯을 지킨다) |
| `ninthAndEighteenthAreBigOthersSmall` | 대량 슬롯 위치를 상수로 박은 변이 |
| `nineteenthSlotSwitchesToPointCurrency` | 통화 전환을 18이 아닌 값·다른 조건으로 박은 변이 |
| `dayBoundaryIsKstMidnightNotUtc` | UTC 자정 경계 변이(#245 가 두 번 당한 그 버그) |
| `settleIsIdempotentAcrossReentry` | CAS/원장 중복 지급 |
| `amountsComeFromEconomyConfigNotConstants` | **픽스처 금액을 발행물과 다르게** 두고 관측 — config 무시 변이 |
| `dailyRewardFallsBackWhenOverrideLacksBlock` | override 트랩(구 스냅샷) |
| `promotionAndRelegationCutsMatchHeroConfirmedSpec` (축 2) | 컷 값이 hero 확정(2 / 9)에서 조용히 드리프트 |
| `finishingARealLeagueMatchConsumesASlotThroughTheWholeFlow` | **훅 제거** — 서비스 단위 계약만 있으면 아무도 안 부르는 상태가 전부 통과한다 |
| `LeagueDailyRewardEconomyProbeTest` (축 4) | 다시드 경제 스윕 + 서열 가드(트랙 상한 ≤ 시즌 완주 최저) |

**변이체 검증 6/6 사망 확인**(구현 되돌리기로 실측):

| 변이 | 죽인 계약 |
|---|---|
| 패배는 칸을 안 쓴다 | `everyLeagueMatchConsumesASlot…` · `trackCarriesEverySlot…` |
| 날짜를 UTC 로(존 무시) | `dayBoundaryIsKstMidnightNotUtcMidnight` |
| 금액을 상수 30/300 으로 | 4건(픽스처 6칸/7·70 이 발행값과 다르기 때문에 죽는다) |
| `finishMatch` 훅 제거 | `finishingARealLeagueMatch…`(**이것 하나뿐**) |
| 트랙 상한 무시(무한 지급) | `trackEndsAfterSlotsPerDay…` |
| 승급 컷 2→3 | `promotionAndRelegationCuts…` |

### web

| 계약 | 무엇을 죽이나 |
|---|---|
| `daily-reward-logic.test.ts` (17건) | 클라가 대량 위치·금액·다음 칸·소진을 **다시 계산**하는 변이(서버가 "2번이 대량"이라 하면 화면도 그래야 한다) + 응답 형태 방어(`{}`·배열·깨진 칸) |
| `e2e/p368-daily-reward.spec.ts` (9건, 목킹) | 트랙 렌더·**마크가 보상 아래**(좌표 실측)·18칸 문서 넘침 0·다음 칸 가시성·서버 값 추종·소진·구 서버 폴백·결과 화면 4경우 |

---

## 8.5 독립검증 결과 (module-verifier, 별도 컨텍스트)

**PASS — blocker 0 · major 0 · minor 4 · 변이체 8/8 사망.** 검증자가 스크래치패드 복제본에 변이를
직접 주입해 ①금액이 config 에서 오는가 ②훅 제거가 잡히는가 ③web 이 규칙을 복제하고 있지 않은가를
전부 실증했다. (⚠️ 검증자의 1차 변이 시도는 **baseline 자체가 FAILED** 였다 — 복제본에
`docs/plan-v2/fixtures` 가 없어 `FakeEngineRunner` 가 죽었다. 그대로 믿었으면 "전부 죽는다"고
잘못 보고했을 것이다. **baseline green 을 먼저 세우고 재측정**했다.)

minor 4건은 **전부 수정**했다:

| # | 발견 | 수정 |
|---|---|---|
| 1 | **수령 칸의 금액을 진행선이 관통해 "취소선"으로 읽힌다.** `.won/.missed .reward` 가 배경을 반투명 rgba 로 **통째 교체**해 뒤의 `.line` 이 비쳤다. 하필 그게 이 화면이 "소멸"을 말할 때 쓰는 언어와 같아 **받은 보상이 취소된 것처럼** 보였다 | 틴트를 **불투명 베이스 위에 합성**(`linear-gradient(tint,tint), #0d1016`). `.missed` 의 `opacity: .55` 도 제거 — 요소 전체가 반투명해지면 같은 증상이다 |
| 2 | **지난 칸의 `big` 만 현재 config 로 재계산됐다** — `amount` 는 박제인데 `big` 은 아니라서, `bigSlots` 를 옮기면 같은 행이 "300 Z 받았는데 소량 스타일"이 된다(돈은 맞고 표시만 거짓말) | `big` 컬럼을 V36 에 추가해 **정산 시점에 박제**. `trackOf` 의 지난 칸은 행을 읽는다. 계약 `pastSlotsReportTheBigFlagThatWasStamped` |
| 3 | **`INSERT OR IGNORE` 가 두 유니크 제약을 구분하지 못하고 침묵**했다 — match_id PK 충돌(정상 멱등)과 슬롯 유니크 충돌(승리한 유저가 보상도 행도 못 받음)이 같은 `0` 이었다 | 슬롯 축 충돌만 `log.warn`. 도달성은 낮지만(유저당 활성 매치 1 + SQLite 단일 writer) 조용하면 원인을 영영 모른다 |
| 4 | **경제 스윕의 한 테스트가 자기 헬퍼의 항진명제** — 이름은 "지급은 승리에만"인데 프로덕션 코드를 한 줄도 안 탄다 | `sweepSimulatorYieldsZeroWhenNoMatchIsWon` 으로 개명 + 진짜 계약이 어디인지 javadoc 에 명시. 쓰지도 않던 `@SpringBootTest` 컨텍스트 제거 |

**informational(수정 안 함, 근거)**: `settle` 의 `created_at` 이 주입 Clock 이 아니라 `Instant.now()`
— `day` 는 Clock 파생이라 무해하고 `LeagueService` 등 기존 코드와 같은 관행이다. /
`MatchService.result` 의 `slotOfMatch` 가 userId 로 스코프되지 않는다 — 비소유자 경로는 원정 수비자
(`awayViewAccess.canWatch`)뿐이고 원정 매치엔 칸 행이 없어 현재는 안전하다. **`canWatch` 를 넓히면
그 줄을 같이 봐라.**

---

## 9. 남은 것 · 되돌리기

- **롤백**: economy override 에 `league.dailyReward.slotsPerDay: 0` 을 얹으면… **안 된다**(파서가
  `>= 1` 만 받고 아니면 기본값으로 되돌린다). 트랙을 끄려면 `small`/`big` 을 0 으로 내린다 —
  칸은 계속 소비되지만 지급이 0 이다. 코드 롤백은 `finishMatch` 의 한 줄 + web 의 렌더 한 줄이다.
- **트랙이 다시 열릴 여지**: hero 가 골드 사이클을 철회했으므로 "18칸 이후"는 **의도적으로 비어 있다**.
  다시 열려면 통화 노브를 돌리는 게 아니라 축을 새로 설계해야 한다(§0 ⚠️ 참조).
- **마크 실아트**: 클럽 엠블럼이 발행되면 `common/TeamCrest.tsx` 안만 갈아끼운다. 지금 `<img>` 자리를
  비워 두지 않은 이유는 그때 매핑 규칙을 같이 정해야 하고, 미리 넣으면 쓰지 않는 분기가 낡기 때문이다.
