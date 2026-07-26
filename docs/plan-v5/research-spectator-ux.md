# 관전 화면 UX 리서치 — 다른 게임/앱은 "경기장면"을 어떻게 고정하나

> P4-E1(#169) W1 산출물 1/2. 짝 문서 = [`layout-game-screen.md`](./layout-game-screen.md)(우리 레이아웃 안).
> 목적: "경기장면이 스크롤 안에 있어 번잡하다"는 문제를, 다른 제품들이 **이미 어떻게 푸는지**로 근거화한다.
> 범위 = 축구 매니저 게임 · 스포츠 라이브 앱 · e스포츠 관전 클라이언트 · 모바일 웹 뷰포트 실무.
>
> 조사일 2026-07-22. 모든 주장에 출처 링크. 우리 화면에 적용할 결론만 §6 에 압축.

---

## 1. 왜 리서치부터인가

우리 문제는 "예쁘게 만들기"가 아니라 **정보 위계**다. 지금 `/match/:id` 는 경기 캔버스(iframe)와
스코어·하프타임 폼·팀스탯 표가 **같은 세로 스크롤 흐름에 나란히** 쌓인다. 그래서

- 경기장면이 스크롤 위치에 따라 화면 밖으로 나간다(관전 중인데 대상이 사라짐),
- 바깥 페이지 스크롤 + iframe 내부 스크롤이 **이중**으로 존재하고,
- 통계/로그를 보려면 경기를 시야에서 잃는다.

관전 UX 를 진지하게 만든 제품들은 예외 없이 **"경기장면 = 절대 안 움직이는 무대(stage), 나머지 정보 =
무대 위/옆에 붙었다 떨어지는 레이어"** 라는 같은 결론에 도달해 있다. 아래가 그 근거다.

---

## 2. 축구 매니저 게임 — 무대 고정 + 정보 토글

### 2.1 Football Manager (데스크탑/콘솔)

- 매치 화면에서 **좌상단 대회 아이콘 클릭 = 매치 스탯/주요 이벤트 패널 접기·펴기**, **우하단 태블릿 아이콘
  클릭 = 터치라인 태블릿 정보 접기·펴기**. 즉 정보 패널은 전부 **토글**이고, 기본은 접힌 상태로
  경기 화면 면적을 최대화한다. ([FM24 매뉴얼 — The User Interface](https://community.sports-interactive.com/sigames-manual/football-manager-2024/the-user-interface-r4951/))
- FM 의 화면 구성 개념 자체가 "메뉴·타이틀·네비를 제외한 **panel** 안에 여러 sub-panel" — 즉 **한 개의
  고정 프레임 + 교체 가능한 내부 위젯**이다. 위젯(선수 목록·상대 정보·순위표)은 켜고 끌 수 있다. (같은 문서)

> **시사점**: 토글 대상은 "화면 전환"이 아니라 "무대 위 위젯". 토글해도 경기 화면 자체는 사라지지 않는다.

### 2.2 Football Manager 26 — 매치데이 개편

- 하이라이트 **사이사이**에 뜨는 **Match Overview** 화면에 **클래식 2D 피치 뷰가 임베드**되고, 그 옆에
  **expandable data cards**(펼칠 수 있는 데이터 카드)로 백룸 인사이트·리그 정보가 붙는다. 설계 원칙이
  명시적으로 *"모든 것을 동시에 보여주는 대신 필요한 만큼 깊이를 펼치게 한다(layer, toggle depth as needed)"*.
  ([FM26 — Where Storytelling Evolves](https://www.footballmanager.com/fm26/features/where-storytelling-evolves-fm26s-match-day-experience))
- 주의를 요하는 사건(부상 등)은 **팝업 오버레이**로 경기 위에 올라온다 — 화면을 갈아끼우지 않는다.
  ([FM Mobile 26 매뉴얼 — Match Day](https://community.sports-interactive.com/sigames-manual/football-manager-mobile-2026/match-day-r5263/))
- 하이라이트 빈도를 경기 상황에 맞춰 조절(Dynamic Highlight Mode) — 접전이면 많이, 승부가 갈리면 적게.
  (같은 FM26 문서)

> **시사점 2가지**: ① 2D 피치는 "메인 무대"로 임베드되고 정보는 **펼침 카드**로 붙는다.
> ② 우리 뷰어의 하이라이트 자동페이싱(autoPace)은 FM26 과 같은 방향의 기능 — 유지 가치가 있다.

### 2.3 Football Manager Mobile — 스탯 패널 구성

- 피치를 **수비/미들/공격 3구역**으로 나눠 각 팀이 어느 구역에서 시간을 보냈는지 **막대**로 보여주고,
  Home/Away Stats 패널이 패스 성공·태클 성공 등 실시간 수치를 담당한다.
  ([FM Mobile 2023 매뉴얼 — Matchday](https://community.sports-interactive.com/sigames-manual/football-manager-mobile-2023/matchday-r4945/))

> **시사점**: 모바일에서 통계는 **표가 아니라 좌/우 대칭 막대**다. 숫자 표는 세로를 많이 먹고 스캔이 느리다.
> (우리 `ResultPage` 팀스탯은 지금 3열 `<table>` — 라이브 패널로는 부적합.)

### 2.4 Top Eleven (모바일 축구 매니저, 라이브 관전)

- 라이브 매치에서 **화면 우측 버튼으로 2D/3D 전환**, **카메라 앵글 4종을 실시간 전환**하고 **마지막 선택이
  다음 경기에 저장**된다. ([Nordeus Help — 2D/3D 전환](https://nordeus.helpshift.com/hc/en/3-top-eleven-be-a-soccer-manager/faq/1128-can-i-switch-between-2d-and-3d-matches/),
  [Top Eleven 3D 공지](https://forum.topeleven.com/top-eleven-general-discussion/84304-%5Bofficial%5D-top-eleven-3d-whats-new-march-27th.html))
- 선수 위에 **플레이스타일 아이콘**을 띄워 "왜 저렇게 움직이는지"를 무대 위에서 바로 읽게 한다. (같은 공지)

> **시사점**: 뷰 관련 컨트롤(카메라/줌/2D)은 **무대 가장자리의 작은 버튼**이고 **선택이 기억**된다.
> 우리 `#114 Auto/Fix 뷰 모드`가 정확히 이 자리 — 지금은 iframe 내부 디버그 컨트롤 행에 묻혀 있다.
> 또 "선수 위 아이콘"은 우리 프롬프트 게임성(선수별 지시가 실제로 반영됐는지)을 보여줄 자리로 유망하다(백로그).

---

## 3. e스포츠 관전 클라이언트 — 오버레이는 커스터마이즈된다

- Dota 2 관전 오버레이는 **요소별 크기·위치·표시여부를 관전자가 직접 조절**한다. 원칙은
  *"시각적 방해 없이 핵심 정보만"*. ([LHM.gg — Dota 2 Ultra HUD](https://lhm.gg/features/ultra-hud/dota-2))
- LoL 관전 오버레이는 경기 진행을 읽히게 하는 **분석 레이어**(골드 차이 추이·타임라인)를 얹고,
  드래프트/스코어보드/서머리 같은 **별도 화면**은 경기 장면과 분리된 시점에만 띄운다.
  ([LHM.gg — Ultra LoL HUD](https://lhm.gg/features/ultra-hud/league-of-legends))
- MOBA 는 플레이어 UI 와 관전자 UI 가 **같은 HUD 문법**을 쓴다 — 화면 가장자리에 팀 상태, 가운데는 항상 경기.
  (같은 문서)

> **시사점**: "정보 on/off 를 유저가 고른다"는 건 사치 기능이 아니라 **관전 UI 의 기본 계약**이다.
> 우리 3토글(통계·로그·후반지시)은 이 계약의 최소 구현이다.

---

## 4. 라이브 스코어 앱 — 모바일에서의 정보 스택

- FotMob 은 상단 탭(Today/…)에 초록 인디케이터로 현재 위치를 표시하고, 매치 상세에서 점유율·유효슛 등
  핵심 지표를 먼저 보여준 뒤 상세로 내려가는 **얕은 계층 + 빠른 스캔** 구조다.
  ([Design Critique: FotMob — Pratt IXD](https://ixd.prattsi.org/2021/09/design-critique-fotmob-android-app/),
  [FotMob 앱 리뷰](https://www.perfectiongeeks.com/blogs/fotmob-app-review))

> **시사점**: 라이브 화면의 정보는 **탭으로 갈아끼우는 것**이지 세로로 무한히 쌓는 것이 아니다.
> 우리가 통계·로그를 동시에 켰을 때도 **한 시트 안 세그먼트 탭**이 정답에 가깝다(§6-4).

---

## 5. 모바일 웹 실무 — "고정 무대"를 실제로 만드는 법

전부 이번 구현의 직접 근거다.

- `100vh` 는 모바일에서 **가장 큰 뷰포트**(주소창이 접힌 상태)를 가리켜, 주소창이 펼쳐진 초기 상태에서는
  콘텐츠가 브라우저 크롬 뒤로 잘린다 — 풀하이트 레이아웃이 깨지는 고전적 원인.
  ([When 100vh Lies](https://blog.openreplay.com/fix-100vh-mobile-viewport/),
  [New Viewport Units — ishadeed](https://ishadeed.com/article/new-viewport-units/))
- 대안 = `svh`(주소창 펼침 기준, 가장 작은 뷰포트) / `lvh`(접힘 기준) / `dvh`(현재 상태에 따라 동적).
  **2023년 이후 전 브라우저 지원**, 폴백 없이 사용 가능.
  ([CSS Viewport Units — Sizzy](https://sizzy.co/blog/css-viewport-units/),
  [모바일 뷰포트 단위 가이드](https://medium.com/@tharunbalaji110/understanding-mobile-viewport-units-a-complete-guide-to-svh-lvh-and-dvh-0c905d96e21a))
- 다만 `dvh` 는 툴바가 접히고 펴질 때마다 **재계산 → 레이아웃/리페인트**를 유발한다. 실무 권장은
  **대부분 `svh`, 꼭 필요한 곳만 `dvh`**. ([modern-css — dvh/svh/lvh](https://modern-css.com/mobile-viewport-height-without-100vh-hack/))

> **시사점(중요)**: 우리 무대는 **매 프레임 캔버스를 그린다.** `100dvh` 로 잡으면 스크롤·툴바 변화마다
> 무대 높이가 흔들려 캔버스 리사이즈가 연쇄한다. → **`100svh` 로 잡고 페이지 스크롤 자체를 없앤다**(스크롤이
> 없으면 툴바가 접힐 일도 없어 `dvh` 이점도 사라진다). 이것이 §6-1 의 기술적 근거다.

- 바텀시트(정보 패널)의 표준 문법: **Standard(persistent)** = 본문과 공존하며 동시에 조작 가능,
  **Modal** = 배경을 딤 처리하고 닫아야 본문 조작 가능, **Expanding** = 접힌 손잡이에서 펼침.
  ([Material — Sheets: bottom](https://m2.material.io/components/sheets-bottom))

> **시사점**: 통계·로그는 **Standard(경기 계속 보임)**, 후반 사전입력(폼 입력·집중 필요)은 **Expanding →
> 필요 시 Modal 승격**이 맞다. 관전 중 정보 패널이 경기를 딤 처리하면 안 된다.

---

## 6. 결론 — 우리 화면에 그대로 적용할 6개 규칙

| # | 규칙 | 근거 |
|---|---|---|
| **R1** | **페이지 세로 스크롤 0.** 매치 화면은 `100svh` 고정 3행 그리드(헤더/무대/컨트롤). 스크롤은 **패널 내부에만** 존재. | §5(100vh 함정·svh 권장), §2.1(고정 프레임+내부 위젯) |
| **R2** | **무대는 절대 사라지지 않는다.** 어떤 패널을 켜도 경기 캔버스는 화면에 남는다(면적만 줄어듦). | §2.2(팝업 오버레이·펼침 카드), §3(가운데는 항상 경기) |
| **R3** | **기본 = 무대만.** 통계/로그/지시는 전부 꺼진 상태로 시작. 유저가 켠 것만 보인다. | §2.1(기본 접힘), §3(관전자가 표시여부 선택) |
| **R4** | **정보는 쌓지 말고 갈아끼운다.** 패널 여러 개를 켜면 세로로 누적하지 말고 **한 시트 + 세그먼트 탭**. | §4(FotMob 탭), §2.2(data cards) |
| **R5** | **통계는 표가 아니라 좌/우 대칭 막대.** 홈·어웨이 대칭 바 + 큰 숫자, 스캔 0.5초. | §2.3(FM Mobile zone bars/stats panel) |
| **R6** | **뷰 컨트롤은 무대 모서리의 작은 버튼 + 선택 기억.** 카메라(Auto/Fix)·배속은 디버그 행이 아니라 무대 위. | §2.4(Top Eleven 카메라 토글·선택 저장) |

### 6.1 우리에게만 있는 제약(리서치가 답을 주지 않는 부분)

- **재생 = 결정론 로그의 재생**이지 실시간 중계가 아니다 → "따라잡기(seek-to-now)"는 W3(#170) 서버시계가
  결정한다. 무대는 시계의 **소비자**로 설계해야 한다(무대가 시간을 소유하면 W3 과 충돌).
- **캔버스가 iframe 안에** 있다(QA 뷰어 임베드). 위 R1~R6 중 R3·R4·R5 는 호스트가 패널을 **직접 소유**해야
  깔끔하다 → 이것이 D3(뷰어 SoT 수렴)이 레이아웃 과제와 한 웨이브인 이유. 상세 = 짝 문서 §4.

---

## Sources

- [FM24 매뉴얼 — The User Interface](https://community.sports-interactive.com/sigames-manual/football-manager-2024/the-user-interface-r4951/)
- [FM26 — Where Storytelling Evolves: Match Day Experience](https://www.footballmanager.com/fm26/features/where-storytelling-evolves-fm26s-match-day-experience)
- [FM Mobile 26 매뉴얼 — Match Day](https://community.sports-interactive.com/sigames-manual/football-manager-mobile-2026/match-day-r5263/)
- [FM Mobile 2023 매뉴얼 — Matchday](https://community.sports-interactive.com/sigames-manual/football-manager-mobile-2023/matchday-r4945/)
- [Nordeus Help — Top Eleven 2D/3D 전환](https://nordeus.helpshift.com/hc/en/3-top-eleven-be-a-soccer-manager/faq/1128-can-i-switch-between-2d-and-3d-matches/)
- [Top Eleven 3D — What's new](https://forum.topeleven.com/top-eleven-general-discussion/84304-%5Bofficial%5D-top-eleven-3d-whats-new-march-27th.html)
- [LHM.gg — Dota 2 Ultra HUD](https://lhm.gg/features/ultra-hud/dota-2)
- [LHM.gg — Ultra LoL HUD](https://lhm.gg/features/ultra-hud/league-of-legends)
- [Design Critique: FotMob (Android) — Pratt IXD](https://ixd.prattsi.org/2021/09/design-critique-fotmob-android-app/)
- [FotMob 앱 리뷰 — PerfectionGeeks](https://www.perfectiongeeks.com/blogs/fotmob-app-review)
- [When 100vh Lies: Fixing Mobile Viewport Issues](https://blog.openreplay.com/fix-100vh-mobile-viewport/)
- [New Viewport Units — ishadeed](https://ishadeed.com/article/new-viewport-units/)
- [CSS Viewport Units: vh, vw, dvh, svh — Sizzy](https://sizzy.co/blog/css-viewport-units/)
- [Understanding Mobile Viewport Units: svh, lvh, dvh](https://medium.com/@tharunbalaji110/understanding-mobile-viewport-units-a-complete-guide-to-svh-lvh-and-dvh-0c905d96e21a)
- [modern-css — CSS dvh, svh, lvh](https://modern-css.com/mobile-viewport-height-without-100vh-hack/)
- [Material — Sheets: bottom](https://m2.material.io/components/sheets-bottom)
