# LLD — P4-E2 match-flow-clock (감독시간 + 서버 권위 시계)

> 에픽 **#170** (상위 #168) · 요구 SoT = `docs/plan-v5/PRD-v5.md` W2·W3 / 확정결정 P4-D1·P4-D2.
> owned-glob = `server-java/**` + `packages/server/**` + `apps/web/**`.
> 이 문서는 **W0 산출물** = ①구현 없이 읽고 만들 수 있는 설계 ②**계약 프리즈 승인 대상(§6)** 명시.
> 작성 2026-07-25. 승인 전 구현 착수 금지(계약 델타는 매니저 hmb:main 프리즈 게이트).

---

## 1. 무엇을 바꾸나 (한 문단)

지금 경기는 **클라이언트 재생에 묶여** 있다 — 화면을 안 보면 아무 일도 안 일어나고, 전반 로그가 저장되는 순간
`H1_BREAK`(하프타임)이 되며, 유저가 [후반 시작]을 눌러야 후반이 돈다. 이걸 **서버가 시각의 SoT를 갖는 라이브 경기**로
바꾼다: 킥오프 시각을 서버가 기록하고, 전반은 실시간 약 4분 동안 "진행 중"이며(화면을 안 봐도 서버 시계가 흐른다),
전반이 끝나면 **감독시간 60초**가 열리고(자동 후반 시작 금지), 만료되거나 유저가 제출하면 후반이 시뮬·재생된다.
**엔진은 한 줄도 바뀌지 않는다** — match-log 는 그대로고, 시계는 그 로그를 **언제까지 보여줄지 정하는 게이트**일 뿐이다.

### 불변조건 (깨면 이 에픽은 실패다)
| # | 불변조건 | 지키는 방법 |
|---|---|---|
| I1 | `packages/engine/src` 무변경, 결정론·resume 통짜동일(루트 §2-5) | 이 에픽은 engine glob 밖. 시뮬 입력(seed·selectData·TacticalInput)에 **시각값이 단 하나도 흘러들지 않는다**(§7.6 검사) |
| I2 | match-log 불변 | 로그는 저장 그대로 서빙. 시계는 **클라 재생 상한**만 정한다(§4.3) |
| I3 | 하드코딩 0 | 압축비·전반 실시간 길이·감독 60s·seek 정책 전부 `application.yml`(§5). web 은 서버가 내려준 값만 쓴다(웹에 상수 복제 금지) |
| I4 | 전이 멱등·재현 | 모든 전이는 CAS + **`now` 가 아니라 이전 경계에서 계산한 시각**을 기록(§7.3) → 스위퍼 지연이 결과를 바꾸지 않는다 |
| I5 | 롤백 스위치 | `hmb.match.clock.enabled=false` 면 현행(즉시 하프타임/즉시 종료) 동작으로 되돌아온다(§7.7) |

---

## 2. 상태머신 (AC-W2-3)

### 2.1 현행
```
BRIEFING → GEN1 → H1_BREAK → GEN2 → FINISHED
                     ↑ 유저가 [후반 시작] 눌러야 GEN2
GEN1|GEN2 → FAILED → (retry) → GEN1|GEN2
```
`H1_BREAK` 진입 = 전반 로그 저장 시점. `FINISHED` 진입 = 후반 로그 저장 시점(+보상·리그 정산).

### 2.2 신규 (clock.enabled=true)
```
BRIEFING ──kickoff──▶ GEN1 ──(h1 로그 저장)──▶ FIRST_HALF
                                                  │ 시계: kickoffAt + halfRealMs
                                                  ▼
                                              HALFTIME  ──(deadline 만료 | 유저 제출)──▶ GEN2
                                                  │  감독시간 halftimeMs(60s)              │
                                                  │                                        │ (h2 로그 저장)
                                                  ▼                                        ▼
                                              (프롬프트 승계)                          SECOND_HALF
                                                                                           │ 시계: +halfRealMs
                                                                                           ▼
                                                                                       FINISHED (정산)
GEN1|GEN2 → FAILED → (retry) → GEN1|GEN2
```

| state | 의미 | 진입 시 기록 | 나가는 조건 |
|---|---|---|---|
| `BRIEFING` | 프롬프트 작성 | — | kickoff(유저) |
| `GEN1` | 전반 AI+시뮬 | — | h1 로그 저장(서버) |
| **`FIRST_HALF`** | 전반 **라이브 재생 창** | `kickoff_at=now`, `phase_start_at=now`, `phase_ends_at=now+halfRealMs` | 시계 만료(서버) |
| **`HALFTIME`** | 감독시간(60s) | `phase_start_at=이전 phase_ends_at`, `phase_ends_at=+halftimeMs` (=deadline) | deadline 만료(서버) **또는** `POST /resume`(유저) |
| `GEN2` | 후반 AI+시뮬 | — | h2 로그 저장(서버) |
| **`SECOND_HALF`** | 후반 라이브 재생 창 | `phase_start_at=now`, `phase_ends_at=now+halfRealMs` | 시계 만료(서버) → **정산** |
| `FINISHED` | 종료·결과·보상 | `finished_at` | — |
| `FAILED` | 잡/시뮬 실패 | `fail_reason` | retry |

- **`H1_BREAK` 은 `HALFTIME` 으로 대체**된다(같은 자리, 이름·의미 확장). 이미 배포된 DB 의 `H1_BREAK` 행은
  마이그레이션에서 `HALFTIME` + `phase_ends_at=NULL`(= 무기한, 수동 제출만)로 이관한다(§8.2) — 진행 중 매치가 죽지 않는다.
- **왜 `FIRST_HALF` 진입이 킥오프 요청 시점이 아니라 h1 로그 저장 시점인가**: AI 생성 + 시뮬이 수 초~수 분 걸린다.
  요청 시점을 kickoffAt 으로 삼으면 생성이 끝나기도 전에 재생 창이 소진되어 "열었더니 이미 전반 끝"이 된다.
  **경기가 실제로 볼 수 있게 된 순간 = 킥오프**로 정의한다(AC-W3-3 의 kickoffAt SoT).
- `retry`(FAILED→GEN1/GEN2)로 되돌아온 뒤 다시 라이브에 진입하면 **kickoff_at/phase_* 는 그때 다시 찍힌다**(재생 창을 새로 준다).

### 2.3 액션 허용표 (409 INVALID_STATE 매트릭스 — 기존 `MatchTransitionMatrixTest` 확장)
| 액션 | 허용 state |
|---|---|
| `POST /prompts` phase=`pre` | `BRIEFING` |
| `POST /prompts` phase=`halftime` | **`FIRST_HALF`, `HALFTIME`** ← 전반 보면서 미리 작성(#169 S1 의 "후반 지시" 패널) |
| `POST /kickoff` | `BRIEFING` |
| `POST /halftime`(교체) | **`FIRST_HALF`, `HALFTIME`** ← 미리 짜두고 감독시간에 확정 가능 |
| `POST /resume` | **`HALFTIME`** (FIRST_HALF 에서 누르면 409 — **후반 앞당기기 금지**) |
| `GET /halves/1/log` | `FIRST_HALF`, `HALFTIME`, `GEN2`, `SECOND_HALF`, `FINISHED` |
| `GET /halves/2/log` | **`SECOND_HALF`**, `FINISHED` |
| `GET /result` | `FINISHED` |
| `POST /retry` | `FAILED` |

---

## 3. 왜 서버가 시각의 SoT 인가 (AC-W3-3)

서버는 **"지금 이 매치가 어느 단계이고, 그 단계가 언제 시작해 언제 끝나는가"**만 소유한다. 재생 위치(틱)는
**클라가 그 창 안에서 계산**한다. 이 분리 덕분에:
- 서버는 로그의 틱 수를 알 필요가 없다(엔진 config 가 바뀌어 틱 길이가 달라져도 서버 코드·DB 무변경).
- 두 클라가 같은 시각에 열면 같은 로그·같은 창 → **같은 틱**(AC-W3-1 후단).
- 화면을 아무도 안 봐도 단계는 흐른다(스위퍼, §7.4) → AC-W3-1 전단·AC-W2-1.

---

## 4. 시계 모델

### 4.1 정의
```
halfRealMs   = 한 하프의 실시간 재생 길이(config, 기본 240_000 ≈ 4분)
halftimeMs   = 감독시간(config, 기본 60_000)
phaseStartAt = 현재 단계 시작 시각(서버 Instant, ISO-8601)
phaseEndsAt  = 현재 단계 종료 예정 시각 (= FIRST_HALF/SECOND_HALF: start+halfRealMs, HALFTIME: start+halftimeMs)
serverNow    = 응답 생성 시각(클럭 스큐 보정용)
```

### 4.2 재생 위치 (클라 계산, `packages/shared/src/match-clock.ts` 가 SoT)
```ts
progress   = clamp01((now - phaseStartAt) / (phaseEndsAt - phaseStartAt))   // 라이브 단계에서만
liveTick   = floor(progress * tickCount)      // tickCount = 이 하프 로그의 tickSnapshots 길이
```
- **압축비는 파생값**이다: `compression = tickCount * msPerTick / halfRealMs`. 리얼 config 기준
  (`matchMinutes=90`, `msPerTick=1000` → 총 5400틱, 하프 2700틱) `halfRealMs=240_000` 이면 **11.25×**.
  config 노브는 **`half-real-ms`**(사람이 "전반을 몇 분에 보여줄까"로 생각하는 값)이고, 압축비는 표시용으로만 계산한다.
  이렇게 하면 엔진이 하프 길이를 바꿔도(쇼케이스 config 등) 재생은 **항상 창의 시작·끝에 정확히 맞는다**.
- 라이브가 아닌 단계(`HALFTIME`·`FINISHED`·`clock=null`)에서는 상한이 없다 → `liveTick = tickCount`(전부 자유).

### 4.3 seek 정책 (AC-W3-1)
```ts
allowedTick = liveTick + graceTicks        // graceTicks = ceil(graceMs / msPerTick)
seekTo(t)   = forwardBlocked ? min(t, allowedTick) : t
```
- **뒤로는 자유 스크럽**(다시보기), **앞으로는 라이브 상한까지만**. 상한에 붙으면 재생은 실시간 속도로 따라간다.
- 늦게 접속 = 마운트 시 `liveTick` 으로 **점프 후 재생**(seek-to-now). 되감기는 유저 자유.
- `graceMs`(기본 1500)는 네트워크 지연·클럭 스큐 흡수용. **클럭 스큐 보정**: 클라는 응답의 `serverNow` 와
  자기 `Date.now()` 차이를 offset 으로 잡고 이후 로컬 시계에 더한다(폴링마다 갱신, 지수평활 없이 최신값 사용).
- **스포일러 한계(명시적 비범위)**: 로그 전체가 클라에 내려가므로 앞서보기 차단은 **UI 강제**다. 서버 절단
  (`?upToTick=`)은 뷰어가 로그 증분 로드를 지원해야 해서 이번 범위 밖 — PvP 진입 시 처리(§11 R3).

### 4.4 시각 예시 (halfRealMs=240s, halftimeMs=60s)
```
T+0s    GEN1 완료 → FIRST_HALF (kickoffAt=T)
T+120s  유저 접속 → progress 0.5 → 로그 중간(≈23분)부터 재생 시작
T+240s  스위퍼 → HALFTIME (phaseStart=T+240, deadline=T+300)  ※ 스위퍼가 T+241 에 돌아도 값은 T+240·T+300
T+300s  미제출 → GEN2 (전반 프롬프트 승계) → h2 저장 시 SECOND_HALF
```

---

## 5. Config 노브 (AC-W3-2 — 하드코딩 0)

`server-java/src/main/resources/application.yml`:
```yaml
hmb:
  match:
    clock:
      enabled: true            # false = 롤백 스위치(현행 즉시 전개, §7.7)
      half-real-ms: 240000     # 하프당 실시간 재생 길이(전·후반 동일). 압축비는 여기서 파생.
      halftime-ms: 60000       # 감독시간(P4-D2 = 60초)
      auto-resume-on-expiry: true   # 만료 시 후반 자동 시작(false 면 HALFTIME 유지 = 수동 대기)
      sweep-interval-ms: 1000  # 시계 스위퍼 주기(잡 스위퍼 10s 와 별도 — 초 단위 경계라 촘촘히)
      seek:
        forward-blocked: true  # 라이브 앞서가기 금지
        grace-ms: 1500         # 지연·스큐 허용 오차
```
- web 은 **자체 상수를 두지 않는다** — `MatchDetail.clock` 이 내려주는 `halfRealMs`·`halftimeMs`·`seek` 를 그대로 쓴다.
  (서버에서 값을 바꾸면 재배포 없이 웹 동작이 따라온다 = 튜닝 원칙.)
- 데모/E2E 는 env 오버라이드로 압축: `HMB_MATCH_CLOCK_HALFREALMS=6000`, `HMB_MATCH_CLOCK_HALFTIMEMS=3000`.

---

## 6. 계약 델타 — **프리즈 승인 대상** (매니저 게이트)

> 프리즈 표면은 두 곳이다: **①`docs/plan-v2/api/openapi.yaml`**(web·서버 계약 SoT) **②`packages/shared/**`**.
> 아래 전부 **additive**(기존 필드 삭제·의미변경 0). `MatchState` enum 확장만 유일한 "값 추가"다.

### 6.1 openapi.yaml (Δ1~Δ4)

**Δ1. `MatchState` enum 확장**
```yaml
MatchState:
  enum: [BRIEFING, GEN1, FIRST_HALF, HALFTIME, SECOND_HALF, GEN2, FINISHED, FAILED, H1_BREAK]
  description: |
    P4-E2(#170): FIRST_HALF/SECOND_HALF(라이브 재생 창) + HALFTIME(감독시간) 추가.
    H1_BREAK 은 **레거시 전용**(P4 이전 배포본의 진행 중 매치) — 신규 매치는 절대 이 값이 되지 않는다.
```

**Δ2. `MatchDetail.clock` (nullable, 신규 오브젝트)**
```yaml
MatchClock:
  type: object
  description: 서버 권위 시계(P4-D1). 라이브 단계가 아니거나 clock.enabled=false 면 MatchDetail.clock=null.
  required: [phase, serverNow, halfRealMs, halftimeMs, seekForwardBlocked, seekGraceMs]
  properties:
    phase:        { type: string, enum: [FIRST_HALF, HALFTIME, SECOND_HALF] }  # state 파생(SoT=state)
    kickoffAt:    { type: [string, "null"], format: date-time }   # 전반 라이브 진입 시각(AC-W3-3)
    phaseStartAt: { type: [string, "null"], format: date-time }
    phaseEndsAt:  { type: [string, "null"], format: date-time }   # HALFTIME 이면 감독시간 deadline
    serverNow:    { type: string, format: date-time }             # 클럭 스큐 보정 기준
    halfRealMs:   { type: integer }
    halftimeMs:   { type: integer }
    seekForwardBlocked: { type: boolean }
    seekGraceMs:  { type: integer }
MatchDetail:
  properties:
    clock: { $ref: "#/components/schemas/MatchClock", nullable: true }   # 신규(선택)
```

**Δ3. 액션 허용 상태 문서화** — §2.3 표대로 `/prompts`(halftime)·`/halftime`·`/resume`·`/halves/{half}/log` 의
summary/409 설명 갱신. **엔드포인트 신설 0, 요청/응답 스키마 변경 0.**

**Δ4. `/resume` 설명** — "HALFTIME → GEN2. 감독시간 만료 시 **서버가 동일 전이를 자동 수행**(전반 프롬프트 승계)".

### 6.2 `packages/shared` (Δ5, 신규 파일 1개)

**Δ5. `packages/shared/src/match-clock.ts`** — 재생 위치 매핑의 **단일 SoT**(web + 향후 QA 뷰어가 같은 함수를 쓴다).
```ts
export const MatchClock = z.object({ phase, kickoffAt, phaseStartAt, phaseEndsAt,
                                     serverNow, halfRealMs, halftimeMs,
                                     seekForwardBlocked, seekGraceMs });
/** 라이브 상한 틱 — 시각→틱 매핑의 유일한 구현(§4.2). 라이브 단계가 아니면 tickCount(상한 없음). */
export function liveTick(clock: MatchClock | null, nowMs: number, tickCount: number): number;
/** seek 클램프(§4.3). forwardBlocked=false 면 원값 통과. */
export function clampSeek(target: number, live: number, clock: MatchClock | null, msPerTick: number): number;
/** 서버-클라 시각 오프셋(serverNow − clientNow). 폴링마다 갱신. */
export function clockOffsetMs(clock: MatchClock, clientNowMs: number): number;
/** 이 하프에 시계가 걸리나 — 지나간 하프는 게이트하지 않는다(§4.3 "뒤는 자유"의 하프 단위 판정). */
export function liveClockForHalf(clock: MatchClock | null, half: 1 | 2): MatchClock | null;
/** 현재 단계 잔여 ms — 감독시간 카운트다운(§9 SecondHalfBriefPanel/HalftimePanel). */
export function phaseRemainingMs(clock: MatchClock | null, nowMs: number): number | null;
/** 압축비(파생값, §4.2) — 뷰어 setSpeed 기준. */
export function compressionOf(clock: MatchClock | null, tickCount: number, msPerTick: number): number | null;
```
- `index.ts` 에 `export * from "./match-clock.js"` 추가.
- **왜 shared 인가**: web 과 QA 뷰어가 같은 매핑을 써야 "게임화면 = QA화면"(P4-D3)이 유지된다. 선례 =
  `team-input-job.ts`(엔진 계약이 아닌 잡 프로토콜도 shared 에 있음).
- **Java 는 이 파일을 import 하지 않는다** — 서버는 단계 창(시각)만 계산하므로 틱 매핑 코드가 필요 없다(§3).
  즉 이중 구현(drift) 지점이 생기지 않는다.

### 6.3 프리즈 요청 요약 (매니저가 승인/반려할 항목)
| Δ | 표면 | 성격 | 영향받는 모듈 |
|---|---|---|---|
| Δ1 | openapi `MatchState` | enum **값 추가**(파괴적 아님, 미지값은 web 이 unknown 패널로 흡수) | web, server-java |
| Δ2 | openapi `MatchDetail.clock` | additive 오브젝트 | web, server-java |
| Δ3/Δ4 | openapi 설명·허용상태 | 문서 | — |
| Δ5 | `packages/shared/src/match-clock.ts` + index export | 신규 파일(기존 스키마 무변경) | web, (향후 dev-viewer) |
- **servants(`packages/server/**`) 영향 0** — 확인 완료(상태명 참조 grep 0건, simulate RPC 계약 무변경).
- **engine 영향 0** — I1.

---

## 7. server-java 구현

### 7.1 새 컴포넌트
| 클래스 | 책임 |
|---|---|
| `match/MatchClockProperties` | `hmb.match.clock.*` 바인딩(@ConfigurationProperties) — 값 접근 단일 지점 |
| `match/MatchClockService` | ①`clockOf(MatchRow)` → `MatchClock` DTO ②`advanceDue(matchId)` = **만료 전이 1회 시도(멱등)** ③순수 판정 `dueTarget(state, phaseEndsAt, now)` |
| `match/MatchClockSweeper` | `@Scheduled(fixedDelayString="${hmb.match.clock.sweep-interval-ms}")` → 만료 후보 매치 조회 → 각각 `advanceDue` |
| (수정) `MatchOrchestrator` | h1 저장 시 `GEN1→FIRST_HALF`(+시각), h2 저장 시 `GEN2→SECOND_HALF`(+시각·h2 스코어 보관), 정산은 `SECOND_HALF→FINISHED` 로 이동 |
| (수정) `MatchService` | 상태 상수·허용표·`toDetail` 에 clock 부착·`resumeCas(HALFTIME→GEN2)` |
| (수정) `MatchController` | 변경 없음(전이 규칙은 서비스가 소유). GET 경로에서 `advanceDue` 지연 평가 호출만 추가 |

### 7.2 전이 구현 (전부 CAS)
```java
// GEN1 → FIRST_HALF  (h1 로그 저장 트랜잭션 안)
UPDATE matches SET state='FIRST_HALF', score_h1_home=?, score_h1_away=?, engine_version=?,
       kickoff_at=:now, phase_start_at=:now, phase_ends_at=:now+halfRealMs
 WHERE id=? AND state='GEN1'

// FIRST_HALF → HALFTIME  (시계 만료 — now 가 아니라 경계값을 쓴다: I4)
UPDATE matches SET state='HALFTIME', phase_start_at=phase_ends_at,
       phase_ends_at=datetime(phase_ends_at + halftimeMs)
 WHERE id=? AND state='FIRST_HALF' AND phase_ends_at <= :now

// HALFTIME → GEN2  (만료 자동 or 유저 제출 — 같은 CAS, 호출자만 다름)
UPDATE matches SET state='GEN2', phase_start_at=NULL, phase_ends_at=NULL
 WHERE id=? AND state='HALFTIME' [AND phase_ends_at <= :now]   // 대괄호=만료 경로만

// GEN2 → SECOND_HALF (h2 로그 저장 트랜잭션 안)
UPDATE matches SET state='SECOND_HALF', score_h2_home=?, score_h2_away=?,
       phase_start_at=:now, phase_ends_at=:now+halfRealMs
 WHERE id=? AND state='GEN2'

// SECOND_HALF → FINISHED (시계 만료) — 여기서 정산(스코어 합산·result·보상·리그·관계)
UPDATE matches SET state='FINISHED', score_home=?, score_away=?, result=?, finished_at=:now
 WHERE id=? AND state='SECOND_HALF' AND phase_ends_at <= :now
```
- **정산(`finishMatch`)이 `SECOND_HALF→FINISHED` 로 이동**하는 게 이번 변경의 유일한 부작용 이동이다.
  보상·리그 정산·관계 갱신은 지금도 CAS 성공(1행)일 때만 실행되므로 **멱등성은 그대로**다.
- h2 스코어는 새 컬럼 `score_h2_home/away` 에 보관(합산은 정산 시). **`MatchDetail` 에는 노출하지 않는다**
  (후반 재생 중 최종 스코어 스포일러 금지).

### 7.3 멱등·재현 (AC-W2-3)
- 만료 전이는 **판정도 기록도 `phase_ends_at` 기준**이다. 스위퍼가 1초 늦게 돌든 서버가 5분 뒤 재기동하든
  `HALFTIME.phase_start_at` 은 항상 `kickoffAt + halfRealMs` 다 → **경계가 누적 오차 없이 재현**된다.
- 동시 호출(스위퍼 ×N + 지연평가 GET ×M)은 CAS 로 정확히 1회만 성공. 나머지는 no-op.
- `advanceDue` 는 **루프**다: 서버가 오래 죽어 있었으면 FIRST_HALF→HALFTIME→(만료)GEN2 까지 한 호출에서
  연쇄 전이한다(최대 반복 = 상태 수, 무한루프 가드 포함). GEN2 진입 시 `orchestrator.enqueueHalf(2)` 호출.

### 7.4 누가 시계를 돌리나 (이중화)
1. **스위퍼(주)** — `@Scheduled` 1초. `SELECT id FROM matches WHERE state IN ('FIRST_HALF','HALFTIME','SECOND_HALF') AND phase_ends_at <= now` → 각 `advanceDue`. (인덱스 `idx_matches_clock(state, phase_ends_at)`)
2. **지연 평가(보조)** — `GET /api/matches/{id}` · `GET /halves/{half}/log` 진입 시 해당 매치만 `advanceDue`.
   스위퍼가 죽어도 **보고 있는 유저의 화면은 정확**하고, 스위퍼는 **안 보는 매치도 진행**시킨다.

### 7.5 감독시간 = 전반 프롬프트 승계 (AC-W2-2 후단)
만료 경로는 **추가 코드가 필요 없다**. `MatchOrchestrator.resolveSide(half=2)` 가 이미:
`h1 인풋 있음 + 교체 없음 + 하프타임 프롬프트 없음` → `insertMaterialized(h1 인풋 seed 교체)` = **AI 콜 0으로 전반 인풋 승계**.
하프타임 프롬프트가 있으면 B 패치 잡(`team-input-patch`, base=h1 인풋)으로 반영된다(라이브 AI 재호출 = §7 하프타임 개입 지점).
→ **이 LLD 는 승계를 "구현"하지 않고 계약으로 박제**한다(테스트 T-W2-4).

### 7.6 결정론 가드 (I1 검사 항목)
- `simulateAndStore` 로 들어가는 값(halfSeed·selectData·homeInput·awayInput·resumeState)에 `kickoff_at`/`phase_*` 가
  **포함되지 않음**을 테스트로 박제(T-W2-5: 같은 매치를 시계 없이/있게 두 번 돌려 `last_hash` 동일).
- 엔진 골든/`npm test` 는 이 에픽에서 손대지 않는다(변경 자체가 없어야 정상).

### 7.7 롤백 스위치 (`clock.enabled=false`)
- `GEN1 → HALFTIME`(phase_ends_at=NULL) 즉시, `GEN2 → FINISHED`(정산) 즉시 = **현행 동작과 동일**(상태명만 `H1_BREAK`→`HALFTIME`).
- `MatchDetail.clock = null` → web 은 카운트다운·seek 상한 없이 현행처럼 동작.
- 스위퍼는 `phase_ends_at IS NULL` 행을 절대 건드리지 않는다.

---

## 8. DB 델타 (V8 마이그레이션 — server-java 내부, 프리즈 대상 아님)

### 8.1 컬럼
```sql
-- matches
kickoff_at      TEXT      -- 전반 라이브 진입 시각(ISO)
phase_start_at  TEXT      -- 현재 단계 시작
phase_ends_at   TEXT      -- 현재 단계 종료 예정(= HALFTIME 이면 감독시간 deadline). NULL = 시계 미적용
score_h2_home   INTEGER   -- 후반 스코어(정산 전 보관, 응답 비노출)
score_h2_away   INTEGER
CREATE INDEX idx_matches_clock ON matches(state, phase_ends_at);
```

### 8.2 state CHECK 재구축 + 레거시 이관
SQLite 는 CHECK 제약을 ALTER 로 못 바꾼다 → 표준 12-step(새 테이블 생성 → INSERT SELECT → DROP → RENAME → 인덱스 재생성).
```sql
CHECK (state IN ('BRIEFING','GEN1','FIRST_HALF','HALFTIME','SECOND_HALF','GEN2','FINISHED','FAILED','H1_BREAK'))
UPDATE matches SET state='HALFTIME' WHERE state='H1_BREAK';  -- 진행 중 매치 구제(phase_ends_at=NULL → 수동 제출)
```
- `H1_BREAK` 을 CHECK 에 남기는 이유: 마이그레이션 도중 실패/부분 롤백 대비 + 과거 데이터 감사. **쓰기 경로는 절대 만들지 않는다.**
- **FK 주의**: `matches` 를 참조하는 자식 테이블(`match_prompts`·`match_halves`·`ai_jobs`)이 있다.
  V7(trade_slots)은 자식이 없어 단순 재작성이었지만 여기는 다르다. Flyway 가 마이그레이션을 트랜잭션으로
  감싸므로 **`PRAGMA foreign_keys` 는 트랜잭션 안에서 무효**(no-op)다 → **`PRAGMA defer_foreign_keys=ON`**
  으로 FK 검사를 커밋 시점까지 미루고 DROP→RENAME 을 수행한다(커밋 시 새 `matches` 로 해소).
  인덱스(`idx_matches_user`)도 재생성한다. 검증 = T-M-2 + 마이그레이션 후 `PRAGMA foreign_key_check` 0행.

---

## 9. apps/web 구현

> ⚠️ **E1(#169, game-screen) 과 파일이 겹친다** — `src/match/stage/**`, `match-logic.ts`, `MatchViewer.tsx`.
> E1 이 S1 에서 `SecondHalfBriefPanel`(deadlineAt/draft props)·`stage-state.ts` 에 **W2 계약 자리를 이미 비워뒀다**.
> 그 자리에 배선만 하고 **레이아웃 구조는 건드리지 않는다**(§11 R1 조율 항목).

| 대상 | 변경 |
|---|---|
| `api/schema.d.ts` | openapi 재생성(Δ1·Δ2 반영) |
| `api/hooks.ts` | `shouldPoll` 확장 → `GEN1|GEN2` + **`FIRST_HALF|HALFTIME|SECOND_HALF`**(라이브 1s, 생성 3s). `useHalfLog` 는 half 2 를 SECOND_HALF 부터 허용 |
| `match/match-logic.ts` | `panelForState`: FIRST_HALF/SECOND_HALF → `stage`, HALFTIME → `halftime`, FINISHED → `result` |
| `match/stage/stage-state.ts` | `halfForState`: SECOND_HALF/FINISHED → 2. `statePanelFor`: HALFTIME → `halftime` |
| `match/stage/SecondHalfBriefPanel.tsx` | 스텁 해제 — `deadlineAt` 카운트다운 + 초안 저장(phase=halftime 프롬프트, FIRST_HALF 부터 제출 가능) + **프리셋 로드**(`briefing-preset-logic` 재사용) |
| `match/HalftimePanel.tsx` | 남은 시간 표시 + 만료 시 자동 잠금(제출 버튼 비활성 + "감독시간 종료 — 전반 지시로 진행합니다") |
| `match/MatchViewer.tsx` | **라이브 게이트**: 마운트 시 `liveTick` 으로 seek → 재생. 폴링마다 상한 갱신, 상한 초과 시 `jumpToTick(liveTick)` 으로 되돌림. 스크럽 UI 는 `clampSeek` 통과값만 코어에 전달 |
| `match/stage/ScoreBar.tsx` | HALFTIME 카운트다운 뱃지(초 단위) |
| `match/GenWaitPanel.tsx` | GEN2 문구를 "후반 준비 중"으로(무대 셸 안에서도 표시되게 stage 경로 연결) |

**라이브 재생 구현 노트**: `viewer-core` 는 로그를 통째로 로드해 자체 프레임 루프로 재생한다.
상한 강제는 **호스트(web)가 주기적으로(≈250ms) `hooks.cur().tick` 을 읽어 `allowedTick` 초과 시 되돌리는** 방식으로
구현한다 — **viewer-core 수정 0**(E1 소유 코어라 건드리지 않는다). 재생 속도는 `setSpeed` 로 압축비에 맞춘다:
`speed = compression`(=`tickCount*msPerTick/halfRealMs`)이면 상한에 자연스럽게 붙어 되돌림이 거의 발생하지 않는다.

---

## 10. 테스트 계획 (E2E-TDD — 구현 전에 먼저 박제)

### server-java (`./gradlew test --rerun-tasks`, 고정 `Clock` 주입)
| ID | 내용 | AC |
|---|---|---|
| T-W3-1 | h1 저장 → `FIRST_HALF`, `kickoff_at`·`phase_ends_at=+halfRealMs` 기록 | W3-3 |
| T-W3-2 | `now < phase_ends_at` 이면 `advanceDue` no-op / `>=` 면 HALFTIME, **HALFTIME.phase_start_at == 이전 phase_ends_at**(스위퍼 지연 무관) | W3-2, W2-3 |
| T-W3-3 | `advanceDue` ×3 연속 호출 → 전이 1회만(멱등), 상태·시각 동일 | W2-3 |
| T-W3-4 | 서버 정지 시뮬(clock 을 +10분 점프) → 한 호출로 FIRST_HALF→HALFTIME→GEN2 연쇄 + `enqueueHalf(2)` 1회 | W2-1 |
| T-W3-5 | `clock.enabled=false` → GEN1 후 즉시 HALFTIME(ends=NULL), GEN2 후 즉시 FINISHED+보상 | 롤백 |
| T-W2-1 | `FIRST_HALF` 에서 `POST /resume` → **409**(후반 앞당기기 금지) | W2-1 |
| T-W2-2 | `HALFTIME` 에서 `POST /resume` → GEN2(즉시), deadline 잔여와 무관 | W2-1 |
| T-W2-3 | deadline 만료 → 자동 GEN2, 이후 유저 `/resume` 은 409 | W2-1 |
| T-W2-4 | 하프타임 프롬프트 **미제출** 만료 → h2 인풋 == h1 인풋(seed 만 상이) = **AI 콜 0 승계** / 제출 시 patch 잡 생성 | W2-2 |
| T-W2-5 | 시계 on/off 두 경로의 `match_halves.last_hash` 동일 = 시각이 시뮬에 안 샘 | W2-3, I1 |
| T-W2-6 | 전이 매트릭스 확장(§2.3 전 조합 409 검증) | W2-3 |
| T-M-1 | 정산 이동 회귀: 보상·리그 정산·관계는 `SECOND_HALF→FINISHED` 에서 **정확히 1회** | 무회귀 |
| T-M-2 | V8 마이그레이션: 기존 `H1_BREAK` 행 → `HALFTIME`+ends NULL, 이후 수동 resume 정상 | 무회귀 |

### shared (`npx vitest run packages/shared`)
| ID | 내용 |
|---|---|
| T-S-1 | `liveTick`: progress 0/0.5/1 경계, 음수 경과(스큐)·초과 경과 클램프 |
| T-S-2 | `clampSeek`: 뒤로 자유 / 앞으로 상한+grace / `forwardBlocked=false` 통과 |
| T-S-3 | `clock=null` → 상한 없음(tickCount) |

### web (vitest 순수로직 + Playwright 목킹 — `web-e2e-live-specs-hit-demo` 메모리 준수: 스펙 지정·전면 목킹)
| ID | 내용 | AC |
|---|---|---|
| T-E2E-1 | `FIRST_HALF` + `phaseStartAt=now-120s`(목) → 뷰어가 **중간 틱부터** 시작(0 아님) | W3-1 |
| T-E2E-2 | 같은 목 응답을 두 컨텍스트에서 열면 시작 틱 동일(±grace) | W3-1 |
| T-E2E-3 | 스크럽으로 앞서가기 시도 → 상한으로 되돌아옴 / 되감기는 유지 | W3-1 |
| T-E2E-4 | `HALFTIME` 목(deadline=now+60s) → 카운트다운 표시, 0 도달 시 입력 잠금 | W2-1 |
| T-E2E-5 | 후반 지시 초안 작성(FIRST_HALF) → 제출 → 하프타임 패널에 반영 | W2-2 |

**시각 판정**(무대 재생이 실제로 경과 시점부터 도는가)은 **자기검수 금지** — `independent-qa` 서브에이전트로 별도 판정(루트 §2-2).

---

## 11. 리스크 · 조율 필요 (매니저 판단 요청)

| # | 항목 | 제안 |
|---|---|---|
| **R1** | **`apps/web` 글로벌 충돌** — E1(#169) 과 owned-glob 이 겹친다(PRD §3 표 기준 둘 다 apps/web) | E1 이 만든 **레이아웃/셸 구조는 불변**으로 두고 E2 는 **배선만**(§9 표 파일 한정). 머지 순서는 매니저 직렬화. 충돌 위험 파일 = `stage/stage-state.ts`, `match-logic.ts`, `MatchViewer.tsx` |
| **R2** | 정산 시점이 h2 시뮬 직후 → **후반 재생 종료 후(+4분)** 로 이동. 보상 지급이 늦어진다 | 의도된 변경(라이브 경기 = 끝나야 결과). 유저가 창을 닫아도 스위퍼가 정산하므로 유실 없음. 반대면 "즉시 정산 + FINISHED 만 늦추기"로 변경 가능(설계상 분리 가능) |
| **R3** | 앞서보기 차단이 **클라 강제**(로그 전체 전송) | Phase 4 범위 밖으로 명시. PvP 진입 시 `?upToTick=` 절단 + 증분 로드로 승격 |
| **R4** | 라이브 폴링 1s × 동시 유저 | 지금은 단일 테스터 규모라 무시 가능. 필요 시 `clock` 전용 경량 엔드포인트로 분리(계약 추가) |
| **R5** | 배포본(hmb-online.pages.dev)에 진행 중 매치가 있으면 V8 중 `H1_BREAK` 이관 | §8.2 로 처리. 배포는 백엔드 재기동 필요 → `docs/deploy-log.md` 기록(P4-D5) |

## 12. 웨이브 계획

| 웨이브 | 범위 | 게이트 |
|---|---|---|
| **W0**(현재) | 이 문서 + 계약 델타(§6) | **매니저 프리즈 승인** |
| W1 | shared Δ5 + openapi Δ1~Δ4 + 타입 재생성 | implementer → verifier |
| W2 | server-java: V8, ClockProperties/Service/Sweeper, 전이·정산 이동, 허용표 (T-W3-*, T-W2-*, T-M-*) | verifier PASS |
| W3 | apps/web: clock 소비·seek-to-now·감독시간 UI·프리셋 (T-E2E-*) | verifier PASS + independent-qa 시각 판정 |
| W4 | 통합 스모크(3프로세스: java+runner+web, 압축 config 로 전반 6s) + #170 STATE 갱신 | 매니저 머지 |

- 커밋 브랜치 `p4-flow-clock/base`, 메시지 `[Spider] type(server-java|web|shared): ...`.
- 진행·발견은 **#170 코멘트에 append**(SoT).
