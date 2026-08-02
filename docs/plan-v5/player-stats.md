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

> **왜 재구성이 필요한가**: `pass` 이벤트의 `playerId` 는 **패서가 아니라 리시버**다(`chain.ts:922` 가
> 명시). 실패한 패스 중 `fail_out` 은 **이벤트를 아예 안 남긴다**. 그래서 "선수 X 의 패스 성공률"은
> 이벤트만으로는 원리적으로 안 나온다.
>
> **재구성 = 소유 체인**: 매 틱 `ballOwner` 로 소유 구간을 만들고, 구간이 끊기는 틱의 소유자를 **행위자**로,
> 다음 이벤트(`pass`=성공 / `interception`=차단 / 상대 `kickoff:throw_in`=아웃)를 **결과**로 읽는다.
> 이 체인 하나에서 패스·터치·캐리·어시스트(골 직전 성공 패스의 패서)·키패스(리시버가 다음에 슛)가 전부 파생된다.
> 정확도 리스크 = `ownerSideOf` 최근접 휴리스틱(중복 id 하프 ~38%). **이 한 곳에만 오차가 몰린다.**

### T3 — 지금은 불가 (엔진/스키마 레이즈 필요, **이 에픽에서 구현 금지**)

크로스 · 블록 · 드리블 성공/시도 분리 · 피파울(피해자 id 미기록) · 듀얼 시도(승자만 기록) · 공중볼 시도 · GK 실점 귀속

→ **#403 에서 만들지 않는다.** UI 는 T1+T2 로만 채우고, T3 은 아래 레이즈로 넘긴다.

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

## 5. STATE

- W0 분석 = 이 문서. 화면 구성 목업 = `docs/plan-v5/mock/player-stats/index.html`.
- **다음 = hero 목업 게이트**(이 세션에서 직접). 승인 후 module-implementer 로 W1~ 착수.
</content>
