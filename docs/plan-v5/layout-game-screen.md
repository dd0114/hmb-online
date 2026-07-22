# 게임화면(관전) 레이아웃 안 — 경기장면 고정 + 정보 토글 + 뷰어 SoT 수렴

> P4-E1(#169) W1 산출물 2/2. 짝 문서 = [`research-spectator-ux.md`](./research-spectator-ux.md)(외부 리서치 R1~R6).
> 대상 = P4-D4(경기장면 고정+정보 토글) · P4-D3(게임화면 렌더코어 = SoT, QA 뷰어는 부분집합 소비).
> **이 문서는 설계안이다. 구현은 hero 시각 리뷰 PASS 후.**
>
> 상태: 🟢 **S1 구현 완료(hero 리뷰 PASS 후)** — 결정 결과와 구현 기록은 §9. §8 은 리뷰 당시의 결정 요청(이력).

---

## 1. 지금 무엇이 문제인가 (현 코드 분석)

### 1.1 화면 조립 경로

```
App.tsx  /match/:id
└ MatchPage.tsx            Layout(nav=false) > <main padding:16>   ← 여기부터 그냥 세로 스택
  ├ header: ← 로비 / 상태제목 / 리그뱃지 / 상태태그
  ├ panel="halftime"  → div.halftimeWrap (column, gap 14)
  │   ├ p.h1Score        "전반 스코어 2 : 1"
  │   ├ MatchViewer(half=1)        ← 경기장면
  │   └ HalftimePanel              ← 교체 UI + 프롬프트 폼 (220줄)
  └ panel="result"    → ResultPage
      ├ MatchViewer(half=2)        ← 경기장면
      ├ section.resultCard         (승패뱃지·최종스코어·보상)
      ├ section.statsCard          (팀스탯 3열 <table>)
      └ button "로비로"
```

`MatchViewer` 내부:

```
section.viewer (border/padding 12)
├ div.modeTabs        [🎬 시각 재생] [📝 타임라인]      ← 무대 위 40px 소비
└ VisualPlayback
  ├ iframe.stage      height: min(72vh, 600px)        ← 무대. 내부에 또 스크롤
  └ PlaybackControls  하이라이트 on/off (+admin 모드)
```

### 1.2 문제 목록 (리서치 R1~R6 대비)

| # | 현상 | 코드 근거 | 위반 |
|---|---|---|---|
| P1 | 경기장면이 **페이지 스크롤 안**에 있어 스크롤하면 화면 밖으로 나감 | `Layout.module.css .main{flex:1;padding:16}` + `MatchPage.module.css .halftimeWrap{flex-direction:column}` | R1·R2 |
| P2 | **이중 스크롤**: 바깥 페이지 + iframe 내부(뷰어 문서가 스코어보드/캔버스/컨트롤2행/HUD/티커/상태줄을 세로로 쌓음) | `MatchViewer.module.css .stage{height:min(72vh,600px)}` + dev-viewer `index.html` body 구조 | R1 |
| P3 | **통계·로그를 호스트가 못 켠다.** 둘 다 iframe 내부 DOM(`#hud`,`#ticker`)이고, 브리지가 노출하는 명령은 `cmd:'highlight'` **단 하나**뿐 — 통계/로그 제어 수단이 **아예 없다**(있어도 버튼 click 시뮬레이션 방식) | `build-viewer.mjs` `handleControl()` = highlight 전용, `setChrome` 은 `.controls/#status/h1` 만 숨김 | R3·R4 |
| P4 | 통계가 켜져도 **iframe 내부 아래쪽**이라 스크롤해야 보임 → 경기와 동시 관측 불가 | 같은 문서 세로 스택 | R2·R4 |
| P5 | 팀스탯이 **3열 표**(결과 화면 전용 형태). 라이브 패널로 쓰기엔 세로 과다·스캔 느림 | `ResultPage.tsx statsCard <table>` | R5 |
| P6 | 뷰 컨트롤(Auto/Fix·배속)이 **디버그 컨트롤 행**에 있고 플레이 모드에선 CSS 로 통째로 숨겨짐 → 관객은 카메라를 못 고름 | `build-viewer.mjs CHROME_PLAY_CLASS` 가 `.controls` 전체 `display:none` | R6 |
| P7 | 모드탭(시각/타임라인)이 무대 위 상시 40px + 테두리/패딩 12px×2 → 390px 폰에서 무대 손실 | `MatchViewer.module.css .modeTabs/.viewer` | R1 |
| P8 | 데스크탑에서 매치 화면 폭이 **480px**(비-nav 컨테이너)로 묶여 무대가 작다 | `index.css .app-container{max-width:480px}` | — |

> P3 가 핵심이다. **D4(정보 토글)는 D3(뷰어 SoT 수렴) 없이는 반쪽짜리**다 — 패널이 남의 문서 안에 있으면
> 호스트가 켜고 끌 수 없다. 그래서 #169 가 두 결정을 한 웨이브로 묶은 것이 옳다.

---

## 2. 레이아웃 안 — 3영역 고정 셸

### 2.1 골격 (모바일 390×844 기준)

```
┌────────────────────────────────────────┐  0
│ ←  내 팀   2 : 1   뮌헨봇    67'  ●LIVE│  56px   [A] 스코어바 (고정)
├────────────────────────────────────────┤
│                                        │
│      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒        │
│      ▒  ·  ·   ●    ·   ·  ·  ▒       │
│      ▒     ·  ⚽ ·      ·     ▒       │  flex:1  [B] 무대 STAGE
│      ▒  ·      ·   ·  ·    ·  ▒       │         (스크롤 없음, aspect-fit)
│      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒        │
│                                        │
│  ⚡ 슛! 손흥민                  [🎥Auto]│   ← 자막 오버레이 / 뷰 컨트롤(모서리)
├────────────────────────────────────────┤
│  📊 통계    📜 로그    📝 후반지시   ⏸ │  64px   [C] 토글바 (고정)
└────────────────────────────────────────┘  844
```

- **페이지 스크롤 0.** 루트 = `height:100svh; display:grid; grid-template-rows:auto 1fr auto; overflow:hidden`.
  (`svh` 근거 = 리서치 §5 — `dvh` 는 툴바 변화마다 캔버스 리사이즈를 연쇄시킨다.)
- **[B] 무대**는 남는 공간을 전부 먹고, 캔버스는 그 박스에 **letterbox-fit**(현 뷰어의 `baseScale` 규칙 그대로).
- **기본 상태 = 토글 전부 off** → 무대만(R3).

### 2.2 통계 on (Standard sheet — 무대는 줄어들 뿐 사라지지 않음)

```
┌────────────────────────────────────────┐
│ ←  내 팀   2 : 1   뮌헨봇    67'  ●LIVE│  [A]
├────────────────────────────────────────┤
│      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒          │
│      ▒   ·  ●   ⚽   ·   ·  ▒         │  [B] 무대 (축소·재fit, 계속 보임)
│      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒          │
├────────────────────────────────────────┤
│ ┃ 📊 통계 ┃  📜 로그                   │  [D] 정보 시트 (탭 = 켜진 토글만)
│                                        │
│      58%  ▓▓▓▓▓▓▓▓▓░░░░░░  42%   점유율│  ← 좌/우 대칭 막대 (R5)
│    7 (3)  ▓▓▓▓▓▓░░░░░░░░░  5 (1) 슛(유효)│
│      81%  ▓▓▓▓▓▓▓▓░░░░░░░  76%  패스성공│
│        4  ▓▓▓▓▓░░░░░░░░░░      6  파울 │
│                                        │
│   모멘텀  ◀━━━━━━━━━━┃━━━━━▶            │
├────────────────────────────────────────┤
│  📊● 통계   📜 로그   📝 후반지시    ⏸ │  [C]
└────────────────────────────────────────┘
```

### 2.3 로그 on / 둘 다 on (세로로 쌓지 않고 **탭 전환** — R4)

```
├────────────────────────────────────────┤
│   📊 통계  ┃ 📜 로그 ┃                  │  ← 둘 다 켜지면 탭이 2개 생김.
│                                        │     시트 높이는 그대로(무대 보호)
│  67' ⚽ 골! 손흥민            (xG 0.34) │
│  66' 🎯 유효슛 이강인                   │
│  64' 🟨 경고 뮌헨봇 DF                  │
│  61' 🔁 인터셉트 김민재                 │
│  59' ⛳ 코너 · 홈                       │   ← 자동 스크롤(최신 하단), 내부 스크롤만
├────────────────────────────────────────┤
```

### 2.4 후반 사전입력 on (Expanding → 입력 시 Modal 승격, W2/#170 연동 자리)

```
├────────────────────────────────────────┤
│      ▒▒▒▒ 무대 (계속 재생) ▒▒▒▒         │
├────────────────────────────────────────┤
│  📝 후반 지시 (미리 작성)      ⏱ --:--  │ ← W2 전: 카운트다운 자리만(비활성 표시)
│  ┌────────────────────────────────────┐ │    W2 후: 하프타임 60초 카운트다운 바인딩
│  │ 팀 지시…                            │ │
│  └────────────────────────────────────┘ │
│  선수별 ▸ (접힘)              [임시저장]│ ← 제출은 하프타임에. 미작성=전반 승계(D2)
├────────────────────────────────────────┤
```

> **W2 계약 자리(정의만, 이번 웨이브 구현 X)**
> `<SecondHalfBriefPanel deadlineAt?: string | null; phase: MatchPhase; draft; onDraft; onSubmit? />`
> — 이번 웨이브는 **비활성 스텁**으로 자리·크기만 확정하고, `deadlineAt`/`phase`는 E2(#170)가 채운다.

### 2.5 데스크탑 (≥1024px) — 시트 대신 우측 도크

```
┌───────────────────────────────────────────────────────────────┐
│ ←  내 팀   2 : 1   뮌헨봇                    67'   ●LIVE      │ [A]
├──────────────────────────────────────────┬────────────────────┤
│                                          │ 📊 통계            │
│        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       │  58% ▓▓▓▓░░ 42%    │
│        ▒      ·   ⚽  ·      ·  ▒        │  7(3) ▓▓▓░░ 5(1)   │ [D] 도크 360px
│        ▒   ·        ·     ·     ▒        │────────────────────│  (여러 패널 동시)
│        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       │ 📜 로그            │
│                                          │  67' ⚽ 골! 손흥민 │
│   ⚡ 슛!                        [🎥Auto] │  66' 🎯 유효슛…    │
├──────────────────────────────────────────┴────────────────────┤
│  📊 통계   📜 로그   📝 후반지시                          ⏸ 4x│ [C]
└───────────────────────────────────────────────────────────────┘
```

- 데스크탑에서만 **`.app-container` max-width 확장**(P8): 매치 라우트 전용 modifier `--stage`(1120px).
- 도크가 열려도 무대는 남는 폭에 **재fit**(캔버스 aspect 유지) — 잘리지 않는다.

### 2.6 상태별 화면 (W2/W3 이후 포함)

| 매치 phase | [A] | [B] 무대 | [C] 토글바 | [D] |
|---|---|---|---|---|
| BRIEFING / GEN1 | 팀명·"준비 중" | 대기 아트/피치 정지 | 비활성 | — |
| FIRST_HALF (라이브) | 스코어+서버시계 `67'` + ●LIVE | 재생 | 통계·로그·**후반지시** | 유저 선택 |
| HALFTIME (감독시간, W2) | 전반 스코어 + **⏱ 60s** | 전반 마지막 장면 정지 | 후반지시 **자동 펼침** | 지시 패널 |
| SECOND_HALF | 상동 | 재생 | 통계·로그 | 유저 선택 |
| FINISHED | 최종 스코어 + 승/무/패 | 후반 재생(다시보기) | 통계·로그 | **결과 카드**가 시트 첫 탭 |

> `ResultPage` 의 결과카드·팀스탯·[로비로]는 **별도 페이지가 아니라 FINISHED 상태의 시트 탭**으로 흡수한다
> (무대가 계속 살아있는 채로 결과를 본다 = R2). 현행 세로 스택은 제거.

---

## 3. 토글 규칙 (AC W1-1 "3토글 독립")

- 3토글은 **서로 독립**(`stats`, `log`, `brief` 각각 boolean). 동시 on 허용.
- **모바일**: 켜진 토글이 시트의 탭이 된다. 활성 탭 1개만 렌더(높이 고정 = 무대 보호). 0개면 시트 자체가 없다.
- **데스크탑**: 켜진 패널이 도크에 세로로 함께 붙는다(탭 없음).
- **기억**: 토글 상태·뷰 모드(Auto/Fix)는 `localStorage`(R6, Top Eleven 선례). 키 = `hmb.stage.*`.
- **접근성**: 토글은 `role="switch" aria-checked`, 시트 탭은 `role="tablist"`. 무대는 `aria-live="polite"`로
  주요 이벤트 자막을 읽어준다(골/카드만 — 소음 방지).

---

## 4. 뷰어 SoT 수렴 (D3) — 구조와 단계

### 4.1 지금 (QA 뷰어가 SoT, web 은 문자열 후처리로 소비)

```
 packages/engine/dev-viewer/index.html   ← 985줄. 렌더+카메라+FX+HUD+티커+컨트롤이 전부 인라인 = SoT
        │  build-standalone.mjs   (match-log 인라인 + playback/stats 인라인)
        ▼
   viewer-standalone.html
        │  apps/web/scripts/build-viewer.mjs
        │    · __LOG__ 스크립트 제거
        │    · 브리지 <script> 주입 (fetch 가로채기 · 크롬 숨김 CSS · 버튼 click 시뮬 · MutationObserver 역미러)
        │    · 선수 draw 블록 **문자열 needle 치환**(스킨 #145) — 원본 바뀌면 throw
        ▼
 apps/web/public/viewer-embed.html  (~2MB, gitignore 생성물)
        ▲ iframe + postMessage(loadMatchLog / setViewerChrome / viewerControl)
 apps/web/src/match/MatchViewer.tsx (+ viewer-bridge.ts 155줄, viewer-skins.ts, playback-controls.ts)
```

**부채**: 렌더 코어를 건드릴 때마다 needle 이 깨지고(빌드 throw), 제어는 DOM 클릭 시뮬레이션이며,
호스트는 뷰어 내부 상태를 `MutationObserver` + 300ms 폴링으로 되읽는다. 정보 패널은 남의 문서 안이라 못 켠다(P3).

### 4.2 목표 (렌더 코어 = SoT, QA 뷰어는 부분집합 소비)

```
                       ┌──────────────────────────────────────────┐
                       │  viewer core  (순수 ESM, DOM/프레임워크 0) │  ← SoT (게임화면 세션 소유)
                       │  · playback.mjs   보간·시퀀스 (기존, 테스트됨)│
                       │  · stats.mjs      라이브 통계   (기존, 테스트됨)│
                       │  · render.mjs     draw/camera/FX  (index.html 에서 추출)│
                       │  · log-lines.mjs  티커 projection (추출)   │
                       │  · viewer.mjs     mount(canvas, log) →     │
                       │                   {seek,play,pause,on(ev)} │
                       └───────┬──────────────────────────┬─────────┘
             import (직접)     │                          │   import (부분집합)
                       ┌───────▼──────────┐      ┌────────▼───────────────────┐
                       │ apps/web         │      │ dev-viewer/index.html      │
                       │ match/stage/*    │      │ = QA 셸                    │
                       │ · React 가 canvas│      │ · 디버그 컨트롤 2행         │
                       │   마운트          │      │ · scrub/점프/파일입력       │
                       │ · 통계·로그 패널  │      │ · window.__viewer 훅        │
                       │   = 호스트 소유   │      │ (렌더 코드 **중복 0**)      │
                       └──────────────────┘      └────────────────────────────┘
                          iframe 없음                 e2e 17 spec / 58 test 무회귀
```

- **중복 렌더 제거**의 정의(AC W1-2 검증 가능 형태): `dev-viewer/index.html` 안에 `ctx.` (canvas 2D 컨텍스트)
  호출이 **0건**이고, 캔버스를 그리는 코드가 core 한 곳에만 존재.
- **QA 계약 보존**: `window.__viewer.{ready,events,seek,play,pause,cur,captions,render,renderAt,idxOfTick,
  showSituationAt,autoPace,fx,surgeTicks,cardMarks,trailAt,liveStats,screenGeom}` + 티커 DOM 클래스
  (`.ev-*`, `.tier-*`, `#ticker > div[data-tick]`) + `#statsBtn/#hudGrid` — 전부 QA 셸이 계속 제공한다.
  (e2e 17 spec · 58 test 가 이 표면에 물려 있음 — 확인 완료.)

### 4.3 단계 (각 단계가 독립적으로 배포·검증 가능)

| 단계 | 내용 | 얻는 것 | 위험 |
|---|---|---|---|
| **S1 셸** | 고정 3영역 레이아웃 + **호스트 소유 패널**. 통계 = 기존 `stats.mjs` 를 web 이 직접 import, 로그 = 새 순수 projection. iframe 은 **캔버스만** 남기고 내부 `#scoreboard/#hud/#ticker` 를 크롬 CSS 로 숨김 | **AC W1-1 달성**(고정·3토글·기본 무대만). 시각 변화가 hero 에게 바로 보임 | 낮음. iframe 계약 무변경, 브리지 CSS 한 줄 확장(BRIDGE_VERSION+1) |
| **S2 코어 추출** | `index.html` 인라인 JS → core 모듈 분리. QA 셸은 core 소비. `build-standalone`/`build-viewer` 는 그대로 동작 | 중복 제거의 **전제**. e2e 가 안전망 | 중간. 985줄 분해 — e2e 58 test 가 회귀 검출 |
| **S3 iframe 제거** | web 이 core 를 직접 마운트. 브리지·needle 치환·MutationObserver·`viewer-embed.html` 아티팩트·`ensure-viewer` 삭제 | **AC W1-2 완성**. 빌드 파이프라인 대폭 축소, 스킨(#145)이 문자열 치환 아닌 정식 옵션으로 | 중간. 스킨/컨트롤모드(#148) 재구현 필요 |

> **왜 S1 을 먼저 하나**: 통계·로그는 `(log, tick)` 의 **순수 함수**다(`stats.mjs` 는 이미 순수·테스트됨).
> 즉 캔버스를 옮기지 않고도 패널만 먼저 호스트가 가져올 수 있다 → D4 의 시각적 성과를 **가장 싼 값에** 확보하고,
> hero 리뷰 피드백을 S2/S3(비싼 리팩터) **전에** 받는다.
> S1 에서 버려지는 코드는 브리지 CSS 몇 줄뿐이고, 레이아웃·패널·토글은 전부 최종 형태로 남는다.

---

## 5. 파일 단위 변경 계획 (diff 관점)

| 경로 | S1 | S2 | S3 |
|---|---|---|---|
| `apps/web/src/match/MatchPage.tsx` | **재작성** — Layout 대신 `<StageShell>` 3영역 | — | — |
| `apps/web/src/match/stage/StageShell.tsx` (신규) | 그리드 셸·토글 상태·localStorage | — | 캔버스 직접 마운트 |
| `apps/web/src/match/stage/ScoreBar.tsx` (신규) | 스코어·시계·phase 뱃지 (호스트 소유) | — | W3 서버시계 소비 |
| `apps/web/src/match/stage/StatsPanel.tsx` (신규) | 대칭 막대(R5). 데이터 = `stats.mjs` | — | core 이벤트 구독 |
| `apps/web/src/match/stage/LogPanel.tsx` (신규) | 티커 projection 소비 | projection 을 core 로 이동 | — |
| `apps/web/src/match/stage/SecondHalfBriefPanel.tsx` (신규) | **비활성 스텁**(자리·계약) | — | E2(#170) 배선 |
| `apps/web/src/match/MatchViewer.tsx` | 모드탭 제거 → 무대 전용으로 축소 | — | iframe → canvas |
| `apps/web/src/match/ResultPage.tsx` | 결과카드/스탯 → 시트 탭으로 이관, 페이지 해체 | — | — |
| `apps/web/src/match/viewer-bridge.ts` | 크롬 옵션 확장 | — | **삭제** |
| `apps/web/src/match/viewer-skins.ts` | — | — | core 스킨 옵션으로 이동 |
| `apps/web/scripts/build-viewer.mjs` · `ensure-viewer.mjs` | BRIDGE_VERSION+1 | — | **삭제** |
| `apps/web/src/index.css` | `.app-container--stage`(데스크탑 1120) | — | — |
| `packages/engine/dev-viewer/index.html` | 무변경 | **분해** → QA 셸 | — |
| `packages/engine/dev-viewer/core/*` (신규 or `packages/viewer-core/`) | — | 렌더 코어 | — |
| `packages/engine/dev-viewer/e2e/**` | 무변경(무회귀 게이트) | 무변경 | 무변경 |

**엔진(`packages/engine/src/**`) 은 손대지 않는다** — 결정론 계약·골든 스냅샷 무영향(§2-5). 이 웨이브는 순수 표현 계층이다.

---

## 6. 테스트 먼저 (§2-3 E2E-TDD) — 구현 전에 박을 계약

구현 착수 시 **아래를 먼저 작성(실패 확인)하고** 통과시키며 구현한다.

**apps/web `e2e/match-stage.spec.ts`** (목킹 하니스 = 기존 `/api` route 목킹, 오리진 앵커 글롭 주의)
1. `AC-W1-1a` 390×844 에서 `document.body.scrollHeight <= clientHeight` (**세로 스크롤 0**), `scrollWidth <= 390`(가로 오버플로 0).
2. `AC-W1-1b` 1280×800 에서도 세로 스크롤 0 + 무대 bounding box 가 뷰포트 내부.
3. `AC-W1-1c` **기본 = 패널 0개** (`[data-testid=stage-sheet]` 부재).
4. `AC-W1-1d` 토글 3개 **독립**: 각각 on/off 시 자기 패널만 나타나고/사라짐, 다른 토글 상태 불변.
5. `AC-W1-1e` **어떤 조합에서도 무대 캔버스가 보인다**(R2): 3개 다 켠 상태에서 캔버스 box 높이 > 0 & 뷰포트 내부.
6. `AC-W1-1f` 토글 상태가 리로드 후 유지(localStorage).

**단위**: 로그 projection 순수 테스트(이벤트 → 라인/티어/라벨), 통계 패널 파생(`stats.mjs` 재사용 검증).

**무회귀**: `npx playwright test`(dev-viewer 17 spec · 58 test) — S2/S3 의 주 안전망. `npm test`(engine/shared) 는 무영향이어야 정상.

**실화면**: `/visual-capture-qa` 스킬로 **before/after 캡처**(390×844 · 1280×800, 토글 조합별). 좌표 추론 금지.

**판정**: 마지막은 `module-verifier` + 독립 QA(§2-2) → 그 다음 hero 시각 리뷰.

---

## 7. 리스크

| 리스크 | 대응 |
|---|---|
| 무대 축소 시 캔버스가 매 프레임 리사이즈 → 성능 저하 | 리사이즈는 `ResizeObserver` 디바운스 + 캔버스 backing size 는 계단식(dpr 고정). `svh` 채택으로 툴바 변화 연쇄 차단(리서치 §5) |
| S2 분해 중 e2e 계약 파손 | e2e 를 **먼저** 돌려 baseline 고정 → 분해는 순수 이동만(로직 수정 금지), 커밋 단위 작게 |
| 스킨(#145)·컨트롤모드(#148) 회귀 | S3 에서 core 의 정식 옵션(`mount(canvas,{skins,chrome})`)으로 이관하고 기존 캡처와 A/B |
| W2/W3(#170) 와 시계·phase 계약 충돌 | 무대는 시계의 **소비자**. `phase`/`kickoffAt` 은 E2 가 소유. E1 은 props 로만 받는다(§2.6 표가 그 계약) |
| 결과 화면 해체가 기존 web e2e 를 깸 | 기존 `result-page` testid 를 시트 탭 안에서 **유지**(선택자 보존) |

---

## 8. hero 결정이 필요한 3건 (리뷰 게이트)

1. **코어의 물리적 위치 (owned-glob 문제)**
   - (a) **권장** `packages/viewer-core/` 신규 패키지 — web·QA 가 대칭 소비, 의존 역전 없음. **단, 내 owned-glob 확장 필요**(현재 `apps/web/**` + `packages/engine/dev-viewer/**`).
   - (b) `packages/engine/dev-viewer/core/` — 글로브 안이라 즉시 가능하나, "게임화면이 SoT"라는 D3 문구와 위치가 어긋나 보임(소유는 게임화면 세션).
2. **단계 범위** — S1 만 먼저 리뷰받고 S2/S3 를 후속 웨이브로 뺄지, S1~S3 를 한 웨이브로 갈지.
   (권장: **S1 구현 → hero 리뷰 → S2/S3**. 비싼 리팩터 전에 화면 방향을 확정.)
3. **결과 화면 해체** — FINISHED 를 별도 페이지가 아니라 "무대 + 결과 탭"으로 흡수하는 안(§2.6)을 승인할지.
   (거부 시 대안: FINISHED 만 현행 스크롤 페이지 유지.)

부가 확인 요청: `docs/plan-v5/PRD-v5.md` 가 **아직 리포에 없다**(main·현 브랜치 모두). 이번 안은 **#168/#169 본문의
D1~D5·AC** 를 SoT 로 삼아 작성했다. PRD-v5 가 따로 있으면 대조가 필요하다.

---

## 9. S1 구현 기록 (2026-07-22, #169)

hero 리뷰 PASS. 결정: **범위 = S1 먼저**, **코어 위치 = `packages/viewer-core/` 신규 패키지**(owned-glob 확장 승인),
**결과 화면 = "무대 + 결과 탭" 흡수 승인**(§8-3). S2(코어 추출)·S3(iframe 제거)는 후속 웨이브.

### 9.1 실제로 만든 것

| 경로 | 내용 |
|---|---|
| `packages/viewer-core/` | **P4-D3 SoT 표면 개설.** `log-lines.ts`(게임로그 투영 — 라벨·중요도·스코어, 순수·8테스트) + `stats.ts`(dev-viewer 검증 모듈에 타입을 입힌 표면, S2 에서 구현 흡수) + `index.ts` |
| `apps/web/src/match/stage/` | `StageShell`(3영역 고정 셸) · `ScoreBar` · `StatsPanel` · `LogPanel` · `SecondHalfBriefPanel`(비활성 스텁) · `ResultPanel`(구 ResultPage 흡수) · `stage-state.ts`(순수 상태, 9테스트) |
| `MatchViewer` | `variant="stage"` 추가 — 모드탭·카드 테두리 없이 무대를 채우고 컨트롤은 모서리 오버레이. `onTick` 으로 플레이헤드 미러링 |
| `MatchPage` | 관전 상태(하프타임·종료)만 셸로 분기. BRIEFING/GEN* 은 기존 페이지 유지(W2 가 흐름 개편 시 흡수) |
| `build-viewer.mjs` | 브리지 v5→**v6**: 플레이 크롬이 `#scoreboard·#hud·#ticker` 도 숨김(호스트가 소유) + 무대 letterbox-fit CSS + `viewerState.tick` 미러링 |
| `ResultPage.tsx` | **삭제**(ResultPanel 로 흡수, testid 전부 보존) |

### 9.2 설계안과 달라진 점 (실행하며 확정)

1. **ResizeObserver 불필요.** 무대 fit 은 전부 CSS 로 된다 — 셸이 `aspect-ratio: 1050/680` 으로 무대 박스를
   잡고, iframe 안에서는 `canvas{width:auto;height:auto;max-width:100%;max-height:100vh}` 가 letterbox-fit 한다.
   JS 리사이즈 경로가 없으니 리플로우 연쇄도, jsdom 폴리필도 필요 없다.
2. **시트 높이는 고정값이 아니라 "무대가 비율만큼 먹고 나머지 전부".** 처음엔 compact/tall 고정 높이를
   뒀는데, 실캡처에서 무대 위아래에 **빈 띠(letterbox)** 가 크게 남았다 → 무대를 비율로 잡고 시트를 `1fr` 로
   바꿔 해소(`sheetSize()` 제거). 결정 근거 = 캡처, 좌표 추론 아님.
3. **"상태 패널" 개념 도입**(설계안엔 없던 구분). 하프타임 감독 패널·종료 결과 패널은 *유저 토글*이 아니라
   **매치 상태가 소유**하고 자동으로 열린다. 3토글(통계·로그·후반지시)은 그때도 기본 off — 그래서
   AC-W1-1 "기본은 경기장면만"과 기존 하프타임 플로우(교체·후반 시작)가 동시에 성립한다.
4. **컨트롤 오버레이 축소.** 첫 캡처에서 "하이라이트" 알약이 골문 앞을 덮어 폰트/패딩을 줄이고 투명도를 넣었다.
5. **`.app-container--stage`(데스크탑 1120px) 불필요.** 셸이 `position:fixed; inset:0` 이라 앱 컨테이너를
   아예 거치지 않는다 — 데스크탑에서 무대가 화면 폭을 그대로 쓴다(P8 은 컨테이너 확장이 아니라 우회로 해결).
6. **데스크탑 도크도 탭 방식.** 설계안은 "도크엔 패널을 세로로 나란히"였으나, 같은 시트 컴포넌트를 재사용해
   탭으로 통일했다(코드 1벌·동작 일관). 세로 병렬은 필요해지면 후속으로 — 지금은 과설계다.

### 9.3 게이트 결과

- `npm test`(루트) **1124 passed** — 엔진 결정론 desync 0 ×80회 유지(엔진 무변경, §2-5).
- dev-viewer e2e **58/58 passed**(17 spec) — AC-W1-2 "기존 계약 무회귀".
- web e2e: 신규 `match-stage.spec.ts` **8/8**(AC-W1-1a~f) + `matchui-controls-mock.spec.ts` 5/5 + `p3-char-skin` 4/4.
- 단위: viewer-core 8 + stage-state 9 + stats-rows 4, web 802 passed(+viewer-core 는 루트에서 실행).
- 실화면 캡처(before/after, 390×844 · 1280×800) = `apps/web/.stage-capture/`(gitignore).

### 9.4 의도적 계약 변경 (기존 테스트 수정)

- `matchui-controls-mock.spec.ts`: 플레이 모드 `scoreboard: true → false`. 스코어는 사라진 게 아니라
  **호스트 스코어바로 이전**(중복 제거) — 같은 테스트에 `stage-scorebar` 가시성 단언을 추가했다.
- `viewer-embed-bridge.test.ts`: 크롬 CSS 계약을 새 규칙(정보 UI 숨김 + 무대 fit)으로 갱신. 숨김 규칙에
  `#wrap`/`canvas` 가 섞여 들어가지 않는지 검사하는 가드를 추가했다(무대가 통째로 사라지는 사고 방지).

### 9.5 곁다리 수정

`packages/engine/dev-viewer/e2e/global-setup.ts` 의 `repoRoot` 가 3단계(`packages/`)를 가리켜, **fixture 생성물이
없는 새 워크트리에서 dev-viewer e2e 가 부팅부터 실패**했다(`No test files found`). 4단계로 수정 — 잠복 버그였다
(생성물이 이미 있으면 이 경로를 안 탄다).

### 9.6 남은 판단거리 (hero 확인용)

- **게임 로그 라벨이 영어**("Kick-off", "Shot · saved 🧤"). QA 뷰어 티커 문구를 그대로 승계한 결과인데,
  게임 화면의 나머지는 한국어다. 한글화하려면 viewer-core 에 라벨 로케일을 두는 게 맞다(QA 는 영어 유지).
- 하프타임 스코어바가 **재생 스코어(0:0에서 시작)** 와 **전반 최종(2:1)** 을 같이 보여준다. 라이브 관전의
  정직한 표기지만 "왜 0:0?" 이 될 수 있다 — 라벨 보강 여지.

### 9.7 독립 검증(module-verifier) 결과와 후속 수정

1차 판정 **FAIL** — blocker 1건. 검증자가 게이트를 전부 재현하고 수치를 재계산했으며, 런타임에서
`position:fixed`/`overflow:hidden` 을 제거해 e2e 가 실제로 회귀를 잡는지(자기충족 아닌지)까지 공격했다.

| 등급 | 발견 | 조치 |
|---|---|---|
| 🔴 blocker | **통계 "슛"이 정확히 2배.** `shots + onTarget + offTarget` 으로 합산했는데 `onTarget`/`offTarget` 은 `shots` 의 **분할**이다(실측: home 9 = 8+1, away 14 = 10+4). QA 뷰어 HUD 와 수치가 갈라졌다 — `viewer-core/stats.ts` 헤더가 경고한 실패 모드 그대로 | `statRows()` 를 순수 모듈로 분리하고 `t.shots` 를 그대로 쓰도록 수정. **대조 테스트 추가**(`stats-rows.test.ts` — 실제 match-log 로 QA HUD 정의와 동치 + `onTarget+offTarget===shots` 계약 확인). 설계 §6 이 요구했는데 빠뜨렸던 테스트다 |
| 🟠 major | **FINISHED 스코어바가 `0 : 0`** 인데 같은 화면 결과 탭은 `3 : 2` — 재생 플레이헤드 스코어가 확정 스코어를 이겼다("보이는 것 vs 데이터" 인지 갭) | 확정 스코어 우선으로 변경(FINISHED=최종, H1_BREAK=전반). 재생 진행은 옆 시계가 보여준다. 하프타임의 `h1-score` 중복 표기도 함께 해소 |
| 🟡 minor-6 | 리그 뱃지(`match-league-badge`) 소실 — 리그 매치 라운드 표시가 사라짐 | 스코어바에 복원(`leagueRound` 를 MatchPage → StageShell → ScoreBar 로 전달) |
| 🟡 minor-2 | e2e 가 컨테이너(`stage-canvas`)만 재서 **iframe 이 죽어도 통과** | iframe 안 `canvas#pitch` 의 실제 렌더 크기를 재는 단언 추가(모바일 e·데스크탑 b) |
| 🟡 minor-1 | "기본은 경기장면만"이 토글 패널 부재만 검사 | 탭 줄(`tablist`) 부재 단언 추가 + 도달 조건을 주석으로 명시(시트 자체가 없는 화면은 W3 라이브 상태에서 도달) |
| 🟡 minor-5 | `MatchViewer variant="page"` 가 호출자 0(사문화) | **제거** — 모드탭 UI·전용 CSS 삭제. 무대가 유일한 렌더 형태고 폴백만 타임라인 |
| 🟡 minor-8 | 문서 테스트 수 드리프트 | §9.3 수치 정정 |

**검증자가 못 잡은 것(내가 추가로 찾음)**: `e2e/w3-viewer-smoke.spec.ts`(라이브 스펙, 목킹 실행 불가라 검증
범위 밖)가 `viewer-tab-visual-half*`의 `aria-selected` 를 단언한다 — 모드탭 제거로 깨진다. 같은 의도의
`viewer-visual-half*` 가시성 단언으로 교체했다.

**남긴 것(non-blocker, 기록)**: minor-3(가로 폰 구간 여백) · minor-4(`viewer-core` 가 alias 2벌 + dev-viewer
상대경로 탈출에 의존 — S2 에서 해소되는 구조적 임시성) · minor-7(브리지 CSS 리터럴 비교는 change-detector
성격) · minor-9(로그 라벨 영어, §9.6).

### 9.8 재검증 결과 — **PASS** (2차)

검증자가 게이트를 전부 재현하고, 1차 blocker 지점(tick=482, 같은 화면)에서 수치를 독립 재계산했다:
홈 `4 (2) → 2 (2)`, 원정 `14 (5) → 7 (5)` — 진실값과 일치. 새 가드 테스트는 **뮤테이션 공격**으로
검증됐다(버그를 되살린 mutant 를 주입하니 합성·실로그 케이스가 둘 다 실패). FINISHED 스코어 모순도
실화면에서 해소 확인(`3 : 2` 일치). testid 계약·라이브 스펙 교체·폴백 경로 전부 무회귀.

**PASS 후 추가로 처리한 것**(검증자가 후속 이슈로 권고한 선재 결함):
`match-logic.ts deriveTeamStats` 가 `shot` 이벤트를 **결과 마커까지 전부** 세고 있어(데모 홈 13),
같은 화면의 `결과` 탭과 `통계` 탭이 13 vs 9 로 갈렸다. 새 화면이 두 값을 나란히 놓기 때문에 그대로
두면 방금 고친 것과 **같은 종류의 모순**이 화면에 남는다 → 엔진 SoT 정의(`saved`/`off_target` 제외)로
통일하고 회귀 테스트를 추가했다. 기존 픽스처는 detail 없는 슛이라 무영향(테스트 그대로 통과).
자잘한 것 2건도 함께: 죽은 CSS(`.halftimeWrap/.h1Score`) 제거, 확정 스코어가 비었을 때 `0 : 0` 대신 `- : -`.
