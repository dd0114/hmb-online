# 선수 기록·정보 (에픽 #403) — W0 분석

> 요구 = hero 메가에픽 요구 1 · 1-2. SoT = GitHub #403. 세션 = hmb:pstat(spider9).
> 이 문서는 **W0 산출(현황 분석 + 지표 선정 + 경계 선언)**. 화면 구성은 `mock/player-stats/index.html`.

---

## 0. 요구 요약

| # | 요구 | 지금 상태 |
|---|---|---|
| A | 경기중 **진행분까지만** 선수별 기록 | 없음 (팀 스탯만 `StatsPanel`) |
| B | 경기중 **상대 선수** 기록도 | 없음 |
| C | 종료 후 **양팀 개인 성적** | 없음 (성장 XP만 `GrowthReportSection`) |
| D | **과거 경기**도 동일하게 | 화면 동선은 이미 있음(`/me` 로그 → `/match/:id` FINISHED) — 내용이 없음 |
| E | 경기중 **선수 터치** → 현재 경기 정보 + 스탯 탭 진입 버튼 | 피치에 클릭 핸들러 자체가 **0건** |
| F | 선수 상세 = **스탯 + 성장(승급)** — 경기중에도, 상대도 | `CardGrowthDetail`(보유 카드 전용) 존재, 경기중엔 열지 않음(`useNavLocked`) |
| G | **원정·랭킹보드에서 타 유저** → 선수단 + 각 선수 정보 | **서버 API 자체가 없음** |

---

## 1. 데이터 현황 — 무엇이 이미 있나

### 1-1. 와이어 계약 (`packages/shared/src/match-log.ts`)

```
MatchEvent = { tick, minute, type, team?, playerId?, xg?, detail? }   // :56-65 — 필드는 이게 전부
TickSnapshot = { tick, minute, ball, ballOwner, players[{playerId,team,pos}], hash }  // :21-28
```

- **이벤트는 `team` 을 항상 같이 싣는다** → `(team, playerId)` 가 per-player 키로 성립한다.
  #231(양팀 동명 선수) 이슈는 이벤트에는 없다. **단 `TickSnapshot.ballOwner` 는 맨 id** 라
  스냅샷 기반 지표는 `ownerSideOf`(최근접 휴리스틱, `viewer-core/src/owner-side.mjs`)를 통과해야 한다.
  라이브 하프의 **약 38%가 중복 id 를 갖는다**(해당 파일 주석) — 정확도 리스크의 유일한 출처.
- **스냅샷은 매 틱 전원 좌표**를 담고 서버에 **원본 그대로 보관**된다(`match_halves.match_log_json`).
  → 뛴거리·히트맵·출전시간·터치·소유 체인이 **엔진 수정 없이** 나온다.
- 퇴장 선수는 이후 스냅샷에서 **사라진다** → 출전시간 계산이 정확하다.

### 1-2. 이미 있는 집계 (전부 **팀 단위**)

| 위치 | 함수 | 성질 |
|---|---|---|
| `packages/viewer-core/src/stats.ts` | `liveEventStats(events, uptoTick)` | **증분** — `e.tick > uptoTick` 컷. 라이브 경로의 원형 |
| " | `computeCumulativePossession/possessionPct/momentum` | 스냅샷 기반 누적 |
| `packages/engine/dev-viewer/match-stats.ts` | `computeMatchStats(log, gkIds)` | 통짜(로그 전량). **내부에서 이미 `${team}:${playerId}` 로 거리·spread 를 계산했다가 팀 평균으로 뭉갠다**(:227-306) |
| `apps/web/src/match/match-logic.ts` | `deriveTeamStats(events)` | 3번째 사본(더 거침) |
| server-java `MatchService.result()` | 이벤트 walk | `playerStats: List<Map>` 를 **이미 만든다** — shot/goal/pass/save 4종, **팀 구분 없음** |

⚠️ `stats.ts` 헤더가 **4번째 사본 금지**를 명시한다. 우리가 만드는 것은 사본이 아니라 **새 축(선수)** 이지만,
팀 합계는 반드시 기존 함수를 재사용한다(선수 합 ≠ 팀 합이 되면 그 자리에서 신뢰를 잃는다).

### 1-3. 서버 현황

- **보존**: `match_halves(match_id, half, match_log_json, select_data_json, ...)` — 전량 영구 보관.
  **pruning/TTL/size cap 이 코드 어디에도 없다**(`DELETE FROM match*` 0건). 참고 크기 = 하프당 약 **0.6 MB**,
  경기당 **~1.1 MB**. → "과거 경기 개인 기록"은 **데이터가 이미 다 있다**. 조회만 만들면 된다.
- **조회**: `GET /api/matches/{id}/halves/{half}/log` 가 **하프 로그 원문**을 준다(소유자 + 피원정 수비자).
  `GET /api/matches/{id}/result` 가 `teamStats`/`playerStats`(오픈 스키마, "상세는 W3 에서 확정") 를 준다.
  과거 목록 = `GET /api/logs/matches`.
- **타 유저**: 랭킹/원정/리그 어디에도 `{userId, nickname, rating/points}` 이상은 안 나간다.
  스쿼드 비슷한 노출은 **경기중 `MatchDetail.opponent.deck[] = {name, position, grade, hasPrompt}`** 하나뿐.
  **프롬프트는 비공개 자산**(`deck_slots.prompt_text`, `decks.team_prompt`) — 정책은 `hasPrompt: boolean` 까지만.
  타인 조회는 **allow-list 응답 + 비소유는 403 아니라 404** 관례를 따라야 한다(`MatchService.toDetailFor`).

---

## 2. 지표 선정 — 실제 축구에서 보는 것 ∩ 우리가 낼 수 있는 것

기준 = Opta/Sofascore/FotMob 의 경기 선수 스탯 표준 집합. 벤치마크 수치는 `research/football-stats.md`(팀 단위).

### T1 — 이벤트만으로 즉시, 정확 (엔진 무접촉)

골 · 슈팅(시도) · xG · 태클(성공) · 인터셉트 · 클리어런스 · 파울(가해) · 경고/퇴장 · 오프사이드 · 선방(GK)

⚠️ 구현 함정 3개: ①`shot` 은 **발사 + 결과 마커 2회** 발생하고 결과 마커엔 playerId 가 없다 →
`isShotAttempt` 가드 + 결과 마커를 직전 발사에 페어링해야 유효슛이 선수에게 붙는다.
②2번째 옐로는 `yellow` 와 `red` 를 **둘 다** 쏜다(순진하게 세면 카드 2장).
③`clearance` 는 shared enum 에 있는데 **어떤 집계기도 세지 않는다**(경기당 ~32건이 통째로 유실 중).

### T2 — 스냅샷 소유 체인 재구성으로 가능 (엔진 무접촉, 휴리스틱 1곳)

뛴거리 · 출전시간 · 터치 · 캐리(드리블 구간) · **패스 시도/성공/성공률** · 키패스 · 어시스트 · 롱볼 · 볼 뺏김 · 히트맵
· **GK 실점**(아래 정정 참조 — `goal` 의 실점 팀 + 그 틱 스냅샷의 GK 재석 교차참조)

> **왜 재구성이 필요한가**: `pass` 이벤트의 `playerId` 는 **패서가 아니라 리시버**다(`chain.ts:922` 가
> 명시). 실패한 패스 중 `fail_out` 은 **이벤트를 아예 안 남긴다**. 그래서 "선수 X 의 패스 성공률"은
> 이벤트만으로는 원리적으로 안 나온다.
>
> **재구성 = 소유 체인**: 매 틱 `ballOwner` 로 소유 구간을 만들고, 구간이 끊기는 틱의 소유자를 **행위자**로,
> 다음 이벤트(`pass`=성공 / `interception`=차단 / 상대 `kickoff:throw_in`=아웃)를 **결과**로 읽는다.
> 이 체인 하나에서 패스·터치·캐리·어시스트(골 직전 성공 패스의 패서)·키패스(리시버가 다음에 슛)가 전부 파생된다.
> 정확도 리스크 = `ownerSideOf` 최근접 휴리스틱(중복 id 하프 ~38%). **이 한 곳에만 오차가 몰린다.**

### T3 — 지금은 불가 (엔진/스키마 레이즈 필요, **이 에픽에서 구현 금지**)

크로스 · 블록 · 드리블 성공/시도 분리 · 피파울(피해자 id 미기록) · 듀얼 시도(승자만 기록) · 공중볼 시도

→ **#403 에서 만들지 않는다.** UI 는 T1+T2 로만 채우고, T3 은 아래 레이즈로 넘긴다.

> **정정 (2026-08-02, W1 독립 검증 MAJ-2)** — 이 목록에 **"GK 실점 귀속"이 잘못 들어가 있었다.**
> W0 원자료의 판정은 `NO` 가 아니라 **`PARTIAL`**(*"`goal` 이벤트가 실점한 **팀**을 주므로, 그 팀의
> GK 를 스냅샷 재석으로 교차참조하면 도출된다"*)이었는데 문서로 옮기며 T3 으로 분류했다.
> 구현은 정확히 그 방식(스냅샷 GK 재석 기반, **추측 없음**)이라 **T2 가 맞다** — 위 T2 목록으로 읽어라.
> 이 정정이 필요한 이유: 분류가 틀린 채로 두면 다음 사람이 **정상 동작하는 지표를 "스펙 위반"으로 삭제**한다.
> (실제로 독립 검증이 그 근거로 major 를 냈다.) 대신 이 항목은 **평점에 `−0.30/실점` 으로 들어가므로
> hero 평점 게이트의 명시 대상**이다 — §5 참조.

### 레이즈 (QA #25 / E4 엔진 트랙 — 이 세션은 요청만 한다)

| 요청 | 근거 | 효과 |
|---|---|---|
| `pass`/`interception` 에 **행위자(패서) id + side** 추가 | 지금은 리시버만 실려 per-player 패스 지표가 원리적으로 불가 | T2 재구성 전체가 **휴리스틱 없이** 정확해진다 |
| `fail_out` 패스도 이벤트 발생 | 실패 패스가 이벤트를 안 남겨 시도 수가 안 맞음 | 패스 시도/성공률이 정합 |
| `foul` 에 피해자 id | 피파울이 원리적으로 불가 | T3 1건 해소 |

⚠️ **UI 는 어느 쪽이든 동일하다.** 집계 모듈 안쪽 seam 하나만 갈아끼우면 되도록 짠다 —
레이즈가 언제 반영되든 화면·계약은 안 바뀐다. (그래서 레이즈를 기다리지 않고 진행한다.)

---

## 3. 아키텍처 결정 (엔지니어링 — hero 게이트 아님, 기록만)

| 결정 | 선택 | 이유 |
|---|---|---|
| 집계 위치 | **클라(TS)** — 내 경기(라이브·종료·과거) 전부 | 하프 로그가 이미 클라에 통째로 와 있다(재생용). 서버 변경 0으로 A~D·F 가 성립 |
| 라이브 컷 | `liveEventStats` 와 **같은 축**(`tick ≤ upto`) | 스포일러 게이트(#233/#238) 단일 출처 유지. 재생 위치를 넘는 기록을 보이면 안 된다 |
| 서버 변경 | **타 유저 선수단(G) 에만** 신규 조회 API | 타인 로그를 통째로 내려보내는 건 사생활·대역폭 양쪽에서 틀렸다 |
| 팀 합계 | 기존 `liveEventStats`/`deriveTeamStats` 재사용 | 선수 합과 팀 합이 어긋나는 순간 신뢰를 잃는다 |
| 모듈 | `apps/web/src/match/player-stats.ts` (신규, 단위테스트 동반) | `viewer-core` 수정은 경계 밖(승인 필요). 필요해지면 그때 이관 레이즈 |

---

## 4. 파일/라우트 경계 선언 (main 의 머지 순서 배정용)

**이 에픽이 만지는 곳**

- 🔴 정면 충돌 위험: `match/stage/stage-state.ts` · `match/stage/StageShell.tsx(+css)` · `match/stage/ResultPanel.tsx` · `match/VisualPlayback.tsx` · `match/MatchViewer.tsx`
- 🟠 `codex/CardGrowthDetail.tsx` · `api/hooks*.ts` · `common/RankingBoard.tsx` · `away/AwayPage.tsx`
- 🟡 `match/GrowthReportSection.tsx` · `match/viewer-skins.ts` · `codex/CodexPage.tsx`
- 신규: `match/player-stats.ts` · `match/PlayerStatsPanel.tsx` · `match/PlayerDetailModal.tsx` · `common/UserSquadModal.tsx`
- server-java: 타 유저 선수단 조회 API 1개 (신규 컨트롤러/서비스, 마이그레이션 없음)

**충돌 상대**

| 에픽 | 겹치는 곳 | 조정 필요 |
|---|---|---|
| **#406 경기 화면 UX** | `StageShell`·`stage-state`·`VisualPlayback`·`MatchViewer`. **"선수 하이라이트" = 이 에픽의 "선수 탭"과 같은 히트테스트 표면** | **필수** — 히트테스트를 누가 만들지 main 이 배정. 두 번 구현하면 안 된다 |
| **#405 성장·보상 개편** | `CardGrowthDetail`·`GrowthReportSection`·`ResultPanel`·`api/growth.ts` 형상 | 선수 상세의 **성장 영역은 자리만** 잡고 값 배선은 #405 인터페이스 확정 후(이슈 #403 기술노트 그대로) |
| #408 데일리 미션 | `away/**` 경미 | 없음 |

⚠️ web **배포 동결 중**(#389/#401) — 머지는 되지만 배포 발차는 main 판단.

---

## 5. 평점(rating) — hero 게이트 대상

결정 ①(hero 승인, 조건부): **"첫 산식은 hero 가 한 번 본다."** 계수 SoT = `match/player-stats.ts` 의
`RATING_WEIGHTS` **한 곳**(하드코딩 산재 금지 — hero 가 이 표를 보고 조정한다).

hero 에게 제시한 판단 지점 3가지(2026-08-02):
1. **골 +1.00 의 크기** — 쇼케이스 로그에서 상위 2명이 상한 10.0 에 붙었다.
2. **관여 없는 선수가 전부 기본 6.0 바닥** — "무난히 90분"에 대한 가점이 없다(실축 앱은 6.5~7.0 이 기본).
3. **GK 가 낮게 깔린다** — 선방 `+0.30` 과 실점 `−0.30` 이 상쇄된다.
   ⚠️ 이 항목이 위 §2 정정의 `goalsConceded` 다. GK 축을 선방률로 재설계하면 **이 값이 입력**이 된다.

⚠️ 독립 검증 실측(m4): 평점 포화의 실제 원인은 **골이 아니라 수비 볼륨**이다 — 라이브 하프에서
`태클 12 + 가로챔 17`(= +4.71)로 **무득점 MOTM** 이 나왔다. 실축 계수를 엔진 볼륨에 그대로 걸어서다.
계수를 조정할 때 골 쪽만 보면 이 축을 놓친다.

## 6. STATE

- W0 분석 = 이 문서. 화면 구성 목업 = `docs/plan-v5/mock/player-stats/index.html`(hero 승인 완료).
- W1 = 집계 모듈 구현 완료 → 독립 검증 **FAIL(blocker 2, 전부 계약 공허)** → 수정 지시 반영 중.
  ⚠️ **구현 자체는 검증의 모든 공격을 통과했다**(교차검증 mismatch 0 · 슛 페어링 정확 · 합산 정확 ·
  히트맵 값 정확 · 결정론 bit-identical). 막힌 것은 **테스트가 못 잡는 자리**다.
- W2 = 선수 탭(A) + 피치 히트테스트(B) · W3 = 선수 상세 모달(+`AttributeLayers` 추출) — 둘 다 착지.
- **W4 = 종료 후 개인 성적 · 과거 경기 (요구 C·D)** — 아래 §7.
- 다음 = W5 타 유저 선수단(서버 API 선행, #431).

---

## 7. W4 — 종료 후 개인 성적 · 과거 경기 (요구 C·D)

**새로 만든 것은 자리와 문구뿐이다.** 요구 C·D 를 위해 필요한 것의 대부분은 이미 돌고 있었다 —
착수 전 실측으로 확인한 사실들:

| 사실 | 근거 |
|---|---|
| 선수 탭은 `FINISHED` 에서도 이미 뜬다 | `stage-state.tabsFor` — `players` 에 상태 조건이 없다 |
| 종료 상태면 훅이 **양 하프를 합친다** | `usePlayerStats` → `combinePlayerStats` |
| 종료 상태의 창은 `settled`(상한·캡션 없음) | `player-stats-view.statsWindow` |
| **MOTM 은 이미 계산돼 있었다** | `player-stats.pickMotm` — 합산 결과에도 채워진다 |
| 과거 경기는 **이미 같은 화면으로 들어간다** | `LogsPage` → `/match/:id` → `statePanelFor("FINISHED") = "result"` |
| 서버 `result.playerStats` 를 읽는 web 코드는 **0곳** | 집계는 클라가 한다(§3) — 서버 필드는 손대지 않았다 |

### 착지한 것

1. **결과 탭 개인 성적 섹션**(`stage/ResultPanel` 안 `ResultPlayersSection`) — MOTM 한 줄 → 팀
   세그먼트 → 표. **자리 = 팀 스탯 뒤 · 성장 리포트 앞**(목업 ⑤ **본문**이 그렇게 못 박았다.
   그림은 MOTM 을 스코어 밑에 그렸지만 본문이 결정이고, 그 자리라야 #355 의 세로 예산 계약
   *"결과 카드 아래 팀 스탯의 **시작**이 보인다"* 가 재는 대상이 안 바뀐다).
2. **표·세그먼트 공용 추출** — `match/PlayerStatsTable.tsx`(`PlayerStatsTable` + `PlayerTeamSegments`).
   선수 탭과 결과 탭이 같은 컴포넌트를 쓰고 **`data-testid` 는 `players-*` 그대로**다 —
   같은 selector 로 두 화면을 재는 것이 "같은 것"이라는 증거다(W3 `AttributeLayers` 선례).
3. **MOTM 게이트 단일화** — `player-stats-view.motmKeyFor(result, window)`. 창이 `settled` 일 때만
   MOTM 이 있다. 결과 탭은 `FINISHED` 전용이라 **그 화면에서는 항상 참**이므로, 인라인으로 적으면
   게이트 없는 형태로 조용히 굳는다(그 변이를 죽이는 것은 라이브 케이스 계약뿐이다).
4. **집계 게이트 함수화** — `stage-state.needsPlayerStats(tab)`. 인라인 `activeTab === "players"` 였을
   때는 조건 자체에 계약이 없었다(W2 MAJ-1 이 그 자리였다). 이제 **탭 전수** 계약이 붙는다.
5. **정직한 빈 상태** — `usePlayerStats.logMissing`(404). 서버는 `match_halves` 행이 없으면 404 를
   주고(`MatchService.halfLogJson`) 목록은 그런 매치를 `hasHalves:false` 로 이미 구분한다 =
   **정상적으로 존재하는 상태**다. "불러오지 못했습니다"로 덮으면 영영 안 될 것을 다시 시도하게 되고,
   반대로 진짜 오류를 "기록 없음"으로 덮으면 있는 기록을 없다고 말한다. 두 축을 나눠 내보낸다.
6. **과거 경기 목록 뱃지** `▶ 재생` → **`▶ 기록`**(목업 ⑥). `data-testid` 는 **안 바꿨다**.
7. **요구 D 를 계약으로 박았다** — 목업 ⑥ 의 *"새 화면 없이 이미 된다"* 는 주장은 그때까지 아무도
   화면에서 확인한 적이 없었다. `e2e/p403-result-players.spec.ts` ⑥ 이 목록 → 행 → 종료 화면 →
   개인 성적 → 선수 상세까지 실제로 지나간다.

### 이 웨이브가 **안 한 것**과 그 이유

- **목업 ⑤ 의 "교체 투입 N명 더보기 ▾"(접기)** — 안 넣었다. ①`p348-desktop-viewport` ⑥ 을 실측으로
  확인한 결과 이 섹션은 팀 스탯 **뒤**라 그 계약(팀 스탯 시작 노출)을 밀지 않고 CTA 는 스크롤 밖
  고정층이라 행 수와 무관하다 = **세로 예산상 접을 이유가 없다** ②무엇보다 **"교체 투입"이라는 축이
  집계에 없다** — 만들려면 킥오프 스냅샷 부재로 추론해야 하고, 그건 W1 이 안 만든 지표를 화면이
  지어내는 것이다(T3 금지와 같은 부류). 넣고 싶어지면 집계에 필드를 먼저 만든다.
- **정렬 컨트롤** — 결과 탭에 안 넣었다(요약 성격 + 세로 예산). 축을 바꿔 보는 자리는 `선수` 탭이다.
- **결과 탭 행 → 상세 모달** — 안 걸었다. 모달은 셸이 소유하고 이 패널은 거기 닿지 않아서, 핸들러만
  넘기면 눌리는데 아무 일도 안 일어나는 **죽은 손잡이**가 된다.

### 남은 것 (W4 밖)

- ⚠️ **평점 포화가 화면에서 눈에 보인다** — 실측 표본에서 **양 팀에 10.0 이 여럿**이고 MOTM 이
  `골 0 · 슛 0 · 수비 28` 인 DF 다. §5 의 hero 게이트 항목(m4: *"포화의 원인은 골이 아니라 수비
  볼륨"*)이 화면으로 확인된 것이고, 계수는 이 웨이브 소관이 아니다. W4 계약도 그래서 "MOTM 은
  이 사람"이 아니라 **"MOTM 은 표시 최고점이고 실제 표에 있는 행"** 으로 걸었다(동점을 하나로
  단정하면 계수를 고치는 날 엉뚱하게 red 가 난다).
</content>
