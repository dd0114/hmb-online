# HMB 온라인 — UI 컨셉 생성 프롬프트 팩 (S-1)

> **목적**: hero 가 외부 이미지 생성 도구로 **HMB 온라인의 UI 컨셉 이미지**를 뽑을 때 그대로 복사해 쓰는 프롬프트 모음.
> **스타일 중립**이다 — 색·질감·장르 무드는 이 문서가 정하지 않는다. 각 프롬프트의 `[STYLE]` 자리에 hero 가 원하는 스타일 문구를 끼워 넣는다.
> 이 문서가 고정하는 것은 **무엇이 화면에 있고 · 어떻게 배치되고 · 버튼이 어디 있는가**뿐이다.
>
> **근거**: 실제 앱을 격리 풀스택 위에서 띄우고 전 화면을 Playwright 로 조작·캡처·실측했다.
> 요소 위치·구성은 전부 실측값이다 → **`design/screen-inventory.md`** (상세) · **`design/inventory/{mobile,desktop}/`** (캡처 92장).
> ⚠️ 캡처는 **현재 구현의 정보구조 근거**이지 스타일 레퍼런스가 아니다. `design/references/` 3장도 UI 스타일 근거로 쓰지 않는다(캐릭터 포맷 참고용, #104 소관).

---

## 0. 사용법

1. 아래 **§1 [STYLE] 블록**에 원하는 스타일 문구를 채운다(한 번만 정해서 전 화면에 동일하게 적용해야 컨셉이 한 벌로 묶인다).
2. 뽑고 싶은 화면의 **§3 화면 블록**으로 간다.
3. 그 블록의 **EN 프롬프트**를 복사 → `[STYLE]` 을 §1 문구로 치환 → **모바일용/데스크탑용** 중 필요한 쪽 사용.
4. 같은 블록의 **종횡비/해상도**와 **네거티브 프롬프트(§2 공통 + 화면별 추가)** 를 함께 넣는다.
5. 산출 이미지는 `design/concepts/` 에 넣고 알려주면 역공학(S0') 으로 아트 디렉션·토큰을 뽑는다.

**권장 순서**: 먼저 **S02 로비**와 **S03 덱·전술보드** 2장만 뽑아 스타일을 확정하고, 마음에 들면 나머지를 같은 `[STYLE]` 로 일괄 생성한다.
(로비 = 셸·네비·카드 문법이 다 나오고, 덱 = 이 게임에서 가장 정보밀도 높은 화면이라 스타일이 버티는지 여기서 판가름 난다.)

---

## 1. [STYLE] 플레이스홀더 — hero 가 채우는 칸

```
[STYLE] = ______________________________________________
```

채울 때 참고할 축(예시일 뿐 강제 아님):
- 매체/장르 감각 (예: 픽셀 아트 / 플랫 벡터 / 네오브루탈리즘 / 유리질 / 인쇄물 느낌 …)
- 명도 방향 (다크 / 라이트 / 하이컨트라스트)
- 색 성향 (모노톤 + 강조색 1개 / 다색 / 저채도 …)
- 질감·마감 (노이즈, 그레인, 금속, 종이, 발광 …)
- 타이포 성향 (기하학 산세 / 응축 그로테스크 / 세리프 / 도트 …)
- 참고 무드 한 문장

> 프롬프트 본문에는 **색·질감·장르 형용사를 넣지 않았다.** 스타일을 바꾸고 싶으면 `[STYLE]` 만 갈아끼우면 되고, 정보구조는 그대로 유지된다.

---

## 2. 전 화면 공통

### 2.1 공통 셸 (모든 화면 프롬프트에 이미 포함돼 있음 — 참고용)
- **모바일**: 하단 고정 5탭 네비게이션 바(홈·덱·트레이드·로그·도감), 각 탭 = 아이콘 위 + 라벨 아래, 5등분. 콘텐츠는 1열 세로 스택, 좌우 여백 균등, 카드는 라운드 사각 패널.
- **데스크탑**: 좌측 고정 세로 사이드바(워드마크 + 같은 5항목, 아이콘+라벨 가로 배치), 오른쪽이 콘텐츠. 콘텐츠는 **2열 분할**로 재배치.
- 상단 바: 좌측 뒤로가기, 중앙 화면 제목, 우측 상태 배지 또는 포인트 표시.
- 주 CTA 는 화면 **하단 전폭 버튼**.

### 2.2 종횡비 · 해상도 (전 화면 공통 규격)
| 대상 | 종횡비 | 권장 해상도 |
|---|---|---|
| 모바일 화면 1장 | **9:16** | 1080×1920 (실좌표 390×844 의 스케일업) |
| 데스크탑 화면 1장 | **16:9** | 1920×1080 (실좌표 1440×900 기준) |
| 긴 스크롤 화면(덱·브리핑·도감)의 전체 뷰가 필요할 때 | **9:21**(모바일) / **16:12**(데스크탑) | 1080×2520 / 1920×1440 |

> 기본은 **한 화면 = 한 이미지(9:16 또는 16:9)**. 스크롤이 긴 화면은 "상단 화면 1장"으로 뽑고, 하단부가 필요하면 해당 블록의 **분할 지시**를 쓴다.

### 2.3 공통 네거티브 프롬프트 (스타일 무관 — 그대로 복사)
```
gibberish text, garbled letters, misspelled words, unreadable labels, lorem ipsum,
random latin filler, duplicated UI elements, duplicated navigation bars, two navigation bars,
overlapping panels, elements cut off at edges, cropped buttons, misaligned grid, inconsistent margins,
warped rectangles, skewed perspective, 3D tilted phone mockup, device frame, hand holding phone,
desk photo, browser chrome, address bar, OS status bar clutter, watermark, signature, logo of other brands,
stock photo, photo of real people, real footballer faces, real club crests, real league logos,
extra fingers, extra limbs, blurry, low resolution, jpeg artifacts, noise banding on flat panels,
text overflowing its container, tooltips floating with no anchor, unrelated icons, emoji spam
```

### 2.4 텍스트 취급 (중요)
이미지 생성 모델은 한글을 정확히 못 쓴다. 각 프롬프트는 **라벨을 "짧은 한국어 텍스트가 들어갈 자리"로 지정**하되,
글자 정확도가 필요하면 **"레이아웃만 뽑고 텍스트는 자리표시자 블록으로"** 옵션을 함께 넣었다. 둘 중 하나를 선택해 쓴다:
- (A) 한국어 라벨 시도 → 오탈자 감수, 분위기 확인용
- (B) `use neutral placeholder text blocks instead of readable words` 추가 → 레이아웃·위계 확인용 (**권장**)

---

## 3. 화면별 프롬프트

각 블록 구성: **① 한국어 정밀 기술 ② EN 프롬프트(모바일 9:16) ③ EN 프롬프트(데스크탑 16:9) ④ 화면별 추가 네거티브**

---

### S01. 로그인 `/login`

**① 한국어 기술**
세로 화면 상단 1/8 지점에 게임 워드마크(중앙 정렬, 큰 글씨). 그 아래 **전폭 세로 버튼 3개**를 균등 간격으로 — 위에서부터 「구글로 계속」, 「애플로 계속」, 「게스트로 시작」. 앞의 둘은 채워진 판, 세 번째는 외곽선만 있는 약한 버튼. 버튼 하단에 작은 회색 캡션 한 줄(목업 로그인 고지). 화면 하단 2/3 는 **비어 있다**(여백 자체가 구성). 네비게이션 바 없음.
대표 상태 변형: (a) 프로바이더 선택 (b) 동의 목 모달 1장 — 중앙 카드에 제목·설명·「계속」/「취소」 (c) 닉네임 입력 — 프로바이더 pill 배지 + 라벨 + 입력 필드 + 전폭 「계속」 (d) 스타터팩 지급 모달 — 제목·2줄 설명·중앙 작은 「확인」.

**② EN (모바일 9:16)**
```
A mobile app login screen UI design, [STYLE].
Vertical 9:16 screen. Composition top to bottom: a large centered wordmark at the top eighth of the screen;
below it three full-width stacked buttons with equal generous spacing — first two are solid filled buttons,
the third is an outline-only ghost button; under the buttons a single small muted caption line, centered.
The lower two thirds of the screen is intentionally empty negative space.
No bottom navigation bar. Flat straight-on UI, no device frame.
Korean short labels on the buttons. Clean baseline grid, consistent side margins.
```

**③ EN (데스크탑 16:9)**
```
A desktop web app login screen UI design, [STYLE].
Horizontal 16:9 screen. Same content centered in a narrow column (about one third of the width) in the middle
of the viewport: large wordmark, three stacked full-column-width buttons (two solid, one outline),
one small muted caption line. Vast empty space on both sides. No sidebar, no top nav.
Flat straight-on UI, no browser chrome, no device frame. Korean short labels.
```

**④ 추가 네거티브**: `real Google logo, real Apple logo, official OAuth consent screen, brand marks, social media icons`

---

### S02. 로비(홈) `/lobby`

**① 한국어 기술**
상단 헤더: 좌측에 유저 닉네임(굵게) + 그 옆 작은 pill 배지(계정 종류), 닉네임 아래 작은 전적 텍스트 한 줄(`0승 0무 0패`). 우측에 포인트 pill(원형 코인 아이콘 + 금액 + "P")과 그 옆 작은 로그아웃 버튼.
헤더 아래: **팀 사기 위젯 카드**(전폭) — 좌측 라벨, 우측 등급 단어, 그 아래 **가로 진행 게이지**(현재 약 45% 채움), 게이지 아래 작은 캡션 한 줄.
그 아래: **2×2 큰 메뉴 타일 그리드** — 좌상 「게임 시작」, 우상 「덱 구성」, 좌하 「상점」, 우하 「도감」. 타일은 정사각에 가까운 넓은 라운드 사각, 라벨은 중앙 정렬 한 단어.
화면 하단 나머지는 여백. 맨 아래 **고정 5탭 네비게이션 바**.
대표 상태 변형: 「게임 시작」 탭 시 중앙에 **모드 선택 모달** — 세로 3버튼(「연습 경기」+작은 부제 / 「리그」+작은 부제 / 「닫기」), 뒤 배경은 어둡게 눌림.

**② EN (모바일 9:16)**
```
A mobile game lobby / home screen UI design, [STYLE].
Vertical 9:16. Top header row: user nickname in bold on the left with a small pill badge beside it,
a tiny win-draw-loss record line underneath; on the right a rounded pill showing a coin dot and a point amount,
plus a small secondary button at the far right.
Below the header: one full-width card widget — label on the left, status word on the right,
a horizontal progress meter filled about 45% underneath, and a tiny caption line below it.
Below that: a 2x2 grid of four large rounded rectangular menu tiles of equal size,
each with a single short centered Korean label.
The bottom third of the content area is empty negative space.
Fixed bottom navigation bar with exactly five equal tabs, each an icon above a short label.
Flat straight-on UI, no device frame, consistent 16px side margins.
```

**③ EN (데스크탑 16:9)**
```
A desktop web game lobby / home screen UI design, [STYLE].
Horizontal 16:9. A fixed left vertical sidebar occupying about one seventh of the width: wordmark at top,
then five stacked navigation items, each an icon with a label to its right; the active item is highlighted.
Main content area to the right: top header row with nickname, small pill badge, record line,
and on the far right a points pill and a small secondary button.
Below: one full-width card widget with a horizontal progress meter.
Below that: a 2x2 grid of four wide rounded menu tiles filling the content width.
Large empty space below the grid. Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `more than five navigation tabs, three-column tile grid, floating action button`

---

### S03. 덱 · 전술보드 `/deck` — **가장 중요한 화면**

**① 한국어 기술**
게임의 핵심 편집 화면. 정보 밀도가 가장 높다.
상단바: 좌 「← 로비」, 중앙 제목, **우상단 작은 「저장」 버튼**(강조색).
그 아래 세로 스택(모바일 기준):
1. **프리셋 요약 카드** — 안내문 또는 현재 프리셋 요약
2. **프리셋 슬롯 칩 3개**(번호 + 이름, 가로 나열) + 그 아래 「+ 새 프리셋」 점선 칩
3. 팀 사기 카드(가로 게이지)
4. 한 줄 컨트롤: 좌측 **포메이션 드롭다운**(예 4-4-2), 우측 「선발 11/11」 카운터
5. **전술 보드 = 세로 축구 피치**(화면 전폭, 세로로 긴 직사각형, 잔디 줄무늬, 센터서클·라인 마킹). 그 위에 **선수 토큰 11개**가 4-4-2 대형으로 배치 — 토큰은 작은 라운드 사각(가로가 조금 긴), 안에 **선수 이름 1줄 + 포지션 약어 1줄**, 테두리로 포지션 구분. 골키퍼 토큰은 하단 중앙. 토큰은 드래그 가능한 느낌(들린 그림자/집기 어포던스).
6. **벤치 스트립** — 피치 바로 아래 가로 한 줄, 같은 규격 토큰 3개 + 빈 슬롯 `+` 몇 개, 가로 스크롤
7. **팀 파워 바** — 좌 라벨, 아주 큰 숫자, 우 캡션
8. **팀 전술 패널** — 우상단에 「AI에 맡기기」 체크박스, 아래 **슬라이더 4행**(수비 라인·압박·템포·폭). 각 행 = 좌 라벨 / 좌끝 낮은쪽 단어 / 슬라이더 트랙(핸들 중앙) / 우끝 높은쪽 단어 / 우측 숫자값
9. 「팀 전체 지시」 여러 줄 텍스트 입력 박스(플레이스홀더 문장)
10. **보유 선수** 섹션 — 포지션 필터 칩 5개(전체/GK/DF/MF/FW, 첫 칩 활성) + 그 아래 선수 리스트 행들(좌 포지션 약어, 이름, 우측 등급 라벨과 상태 라벨)
11. **프롬프트 프리셋 패널** — 이름 입력 + 본문 여러 줄 입력 + 전폭 「프리셋 만들기」 + 체크박스 선수 리스트 + 하단 드롭다운 + 「일괄 적용」 버튼

**데스크탑에서는 2열로 재배치**: 좌열 = 피치 보드 + 벤치, 우열 = 팀 파워 / 팀 전술 슬라이더 / 지시 입력 / 보유 선수 리스트. 프리셋 패널은 그 아래 전폭.

**② EN (모바일 9:16, 상단부 = 보드까지)**
```
A mobile football manager team-builder screen UI design, [STYLE].
Vertical 9:16. Top bar: small back control on the left, centered screen title, and a small highlighted
"save" button at the top right.
Below, stacked: (1) a full-width summary card with a short message;
(2) a horizontal row of three numbered preset slot chips, plus a dashed "new preset" chip underneath;
(3) a card with a horizontal progress meter;
(4) a control row: a compact dropdown on the left, a small counter text on the right;
(5) the hero element — a VERTICAL football pitch rectangle filling the full content width,
with mown stripe bands, painted boundary lines, a center circle and penalty boxes.
On the pitch, eleven small rounded-rectangle player tokens laid out in a 4-4-2 formation,
each token containing a player name line and a short position abbreviation line,
the goalkeeper token alone at the bottom center. Tokens look draggable.
(6) directly under the pitch, a single horizontal bench strip of three identical tokens plus two empty "+" slots.
Fixed bottom navigation bar with five equal tabs.
Flat straight-on UI, dense but orderly, consistent 16px side margins, no device frame.
```

**③ EN (모바일 9:21, 전체 스크롤 뷰가 필요할 때)**
```
Same as above, but a tall full-page 9:21 screen showing the whole scroll: after the pitch and bench strip,
continue downward with (7) a wide card showing a label, a very large number and a caption;
(8) a settings card with a checkbox at its top right and four slider rows, each row having a left label,
a low-end word, a track with a centered handle, a high-end word and a numeric value at the far right;
(9) a multi-line text input box with placeholder text;
(10) a row of five small pill filter chips (first one active) above a list of player rows,
each row showing a position abbreviation, a name, and two small right-aligned labels;
(11) a bottom card containing a single-line input, a multi-line input, a full-width button,
a checkbox list of players, and a final row with a dropdown and a button.
```

**④ EN (데스크탑 16:9)**
```
A desktop football manager team-builder screen UI design, [STYLE].
Horizontal 16:9. Fixed left vertical sidebar with wordmark and five navigation items.
Main area: top bar with back control, centered title, and a small highlighted save button at the far right.
Above the fold: a full-width summary card, a row of three preset slot chips, a meter card,
then a TWO-COLUMN layout — LEFT COLUMN (about 40% of the content width): a vertical football pitch
rectangle with mown stripes and painted lines, eleven rounded player tokens in a 4-4-2 formation
(goalkeeper at bottom center), and a horizontal bench strip of tokens directly below it.
RIGHT COLUMN (about 60%): stacked cards — a team power card with a very large number,
a tactics card with a checkbox and four labeled slider rows with numeric values,
a multi-line instruction text box, a row of five filter chips, and a scrollable list of player rows.
Flat straight-on UI, no browser chrome.
```

**⑤ 추가 네거티브**: `horizontal pitch, landscape football field, top-down stadium photo, real grass photograph, isometric pitch, tactics arrows scribbled over the pitch, more than eleven players on the pitch, players standing outside the pitch`

---

### S04. 선수 시트 (전술보드 토큰 선택 시 열리는 인라인 패널)

**① 한국어 기술**
피치 아래에 **인라인으로 펼쳐지는 패널**(모달 아님, 좌측에 강조 세로선). 위에서부터:
헤더 행 — 선수 이름(굵게) + 포지션 약어 + 우측 「닫기」.
그 아래 한 줄 — **성격 pill 칩**(예: 유리멘탈) + 「신뢰」 라벨 + **가로 게이지** + 수치.
**전술 지시 블록** — 「역할」 드롭다운(예: 밸런스), 그 아래 **토글 칩 그리드 6개**(마킹·오버랩·침투·롱볼·압박·템포), 일부는 선택 상태.
**「감독의 한마디」 블록** — 자유 문장 여러 줄 입력, 플레이스홀더 예시 문장, 우하단에 글자수 카운터(`0/500`), 우측에 위험 액션 텍스트 버튼(「덱에서 제거」).
핵심은 **위 = 정형 전술 지시 / 아래 = 자연어 주문**의 2레이어가 시각적으로 분리되어 읽히는 것.

**② EN (모바일 9:16, 패널 클로즈업)**
```
A mobile game player detail sheet panel UI design, [STYLE].
Vertical 9:16, showing the bottom edge of a vertical football pitch at the top of the frame and,
directly below it, an inline expanded detail panel with a bold accent rule down its left edge.
Panel content top to bottom: a header row with a bold player name, a short position abbreviation,
and a small "close" control at the right; a row with a small pill chip, a short label,
a horizontal meter and a numeric value; a bordered sub-block containing a dropdown control
and a grid of six small toggle chips, two of them shown in a selected state;
a second clearly separated sub-block containing a multi-line free-text input with placeholder text,
a small character counter at its bottom right, and a small destructive-looking text button at the right.
The two sub-blocks read as two distinct layers. Flat straight-on UI, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same panel as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left sidebar.
The detail panel sits in the right-hand column of a two-column team-builder screen,
with the vertical pitch visible in the left column. The panel keeps the same vertical order:
header row, trait chip + meter row, a tactical sub-block with a dropdown and a six-chip toggle grid,
and a separated free-text sub-block with a character counter and a destructive text button.
Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `bottom sheet overlay, popup modal with dimmed backdrop, player photograph, portrait avatar, character illustration`
> (아바타·초상 슬롯은 이 에픽 스코프 밖 — 캐릭터는 #104. 시트에는 초상을 그리지 않는다.)

---

### S05. 경기 전 브리핑 `/match/:id`

**① 한국어 기술**
상단바: 제목 「경기 전 브리핑」 + 우측 상태 배지(대문자 라벨).
1. **카운트다운 줄** — 굵은 `입력 시간 2:59` + 옆에 작은 보조문구
2. **상대 분석 카드** — 상대 팀명(굵게) + 성향 한 줄 설명 + **11행 테이블**. 컬럼: 포지션 / 이름 / 등급 / 지시 / 마크. 등급 컬럼은 5단계 텍스트 라벨이 서로 다른 색. **각 행 우측 끝에 작은 「마크」 버튼**.
   - 변형: 「마크」를 누르면 테이블 하단에 **마킹 패널**이 열린다 — 활성 대상 칩 + 「맡길 수비수」 드롭다운(자동 배정 기본) + 「이 선수 마크」 버튼. 누른 행의 버튼은 활성 상태로 강조.
3. **선발 컨디션 카드** — 선수 11명 격자(모바일 4열). 각 셀 = **작은 원형 아날로그 시계 아이콘**(바늘 각도와 링 색으로 컨디션 표현) + 아래 선수 이름 작게. 링 색은 좋음/보통/나쁨 3단계로 갈린다.
4. 안내 문구 한 줄(회색, 2줄 감김)
5. **덱 에디터 전체 재사용** — S03 의 피치·벤치·팀파워·전술 슬라이더·지시·보유 선수가 그대로. 단 **팀 파워는 비교 게이지**로 바뀐다: 하나의 가로 바가 좌(내 팀)/우(상대) 두 색으로 나뉘고 양끝에 팀명과 수치.
6. 하단 **전폭 「킥오프」 CTA**

**② EN (모바일 9:16, 상단부)**
```
A mobile pre-match briefing screen UI design, [STYLE].
Vertical 9:16. Top bar with centered title and a small uppercase status badge at the right.
Below: a bold countdown line with a small muted note beside it.
Then a large card: opponent team name in bold, one line of descriptive text, and a data table of eleven rows
with five columns — a short position abbreviation, a player name, a tier label, a dash, and a small
outlined action button at the right end of every row. The tier labels use five visually distinct
color-coded text styles.
Below it another card titled with a short label, containing a grid of eleven cells (four per row);
each cell is a small circular analog clock icon with a visible hand angle and a colored ring,
with a tiny player name underneath. The ring colors vary across three states.
Below that, one small muted two-line note, and the top edge of a vertical football pitch beginning.
Fixed bottom navigation absent; a full-width primary call-to-action button pinned at the very bottom.
Flat straight-on UI, dense table, consistent margins, no device frame.
```

**③ EN (모바일 9:16, 마킹 패널 상태)**
```
Same briefing screen, [STYLE], but focused on the opponent table with a marking panel expanded
directly beneath the last table row: the panel contains a highlighted target chip on the left,
a short label, a wide dropdown control, and a solid confirm button at the right.
One row's action button in the table above is shown in an active filled state while the others are outlined.
```

**④ EN (데스크탑 16:9)**
```
A desktop pre-match briefing screen UI design, [STYLE].
Horizontal 16:9. Fixed left vertical sidebar. Main area centered in a wide column:
countdown line, a wide opponent analysis card with an eleven-row five-column table with a small action
button at the right end of each row, and below it a condition card whose eleven circular clock-icon cells
sit in a single wide row-grid. Below, a two-column team editor: vertical pitch and bench on the left,
a comparison power bar (one horizontal bar split into two differently colored segments with a team name
and number at each end), tactics sliders, an instruction text box and a player list on the right.
A full-width primary button at the bottom. Flat straight-on UI, no browser chrome.
```

**⑤ 추가 네거티브**: `real player photos, club badges, scoreboard graphics overlay, broadcast lower third, stadium background`

---

### S06. AI 대기 (전반/후반 생성 중)

**① 한국어 기술**
거의 빈 화면이 핵심이다. 상단바(제목 「전반 준비」 + 우측 상태 배지 `GEN1`) 아래, 화면 **상단 1/3 지점**에 원형 로딩 인디케이터(굵은 링, 일부만 채워진 형태). 그 아래 굵은 문장 한 줄(「AI 감독이 전반 작전 반영 중…」), 그 아래 경과 시간 한 줄(`경과 0:01`), 그 아래 작은 회색 보조문구 한 줄. 나머지 아래 2/3 는 **완전한 여백**. 네비게이션 바 없음.
후반 변형은 문구와 배지(`GEN2`)만 다르다.

**② EN (모바일 9:16)**
```
A mobile loading / waiting screen UI design, [STYLE].
Vertical 9:16. Top bar with a small back control, a centered title and a small uppercase status badge
at the right. Centered in the upper third: a circular loading indicator ring, partially filled.
Directly below it, a single bold sentence line, then a smaller elapsed-time line,
then one small muted helper line. The entire lower two thirds of the screen is empty negative space.
No bottom navigation, no other UI elements. Flat straight-on UI, extremely minimal, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same waiting screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
The circular loading ring, bold sentence, elapsed-time line and muted helper line are stacked
and centered in the upper-middle of the wide content area, with vast empty space around them.
Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `progress percentage bar, skeleton placeholders, multiple spinners, mascot character, illustration`

---

### S07. 매치 뷰어 (하프타임·결과 화면에 임베드되는 재생기)

**① 한국어 기술**
카드 안에 들어가는 재생기 컴포넌트. 위에서부터:
1. **탭 2개**(「🎬 시각 재생」 / 「📝 타임라인」) — 좌우 반씩, 선택 탭 강조
2. **스코어보드 줄** — 좌 HOME 팀색, 중앙 큰 스코어 `0 : 0`, 우 AWAY 팀색, 오른쪽에 경과 시간(`0'58"`). 모노스페이스 느낌의 숫자 강조
3. **피치 캔버스**(가로로 누운 초록 피치, 줄무늬 + 라인 마킹). 선수는 **아주 작은 컬러 도트/칩**(홈=한 색, 어웨이=다른 색)이고 각각 작은 번호가 붙는다. 공은 아주 작은 점. 상황 발생 시 피치 중앙에 **둥근 자막 필**(예 「스로인」)이 뜬다.
4. **컨트롤 3행** — 1행: 일시정지 / 처음 / 공 따라가기(각각 아이콘+라벨 버튼) · 2행: 선수 잔상 / 하이라이트 토글(활성 상태 강조) + 「수동배속」 라벨 · 3행: 배속 세그먼트 5칸(0.25x·0.5x·1x·2x·4x, 1x 활성)
5. **점프 버튼 행** — 이전 숏 / 다음 숏 / 이전 골 / 다음 골
6. **타임라인 슬라이더** — 밝은 트랙 위에 **이벤트 핀들이 색 눈금으로 박혀 있고** 핸들이 좌측 근처. 아래 `0'58" / 44'59"` 텍스트
7. 하단에 이벤트 로그 한 줄(모노스페이스, 예 `0' · kickoff [home]`)
「타임라인」 탭 변형 = 같은 카드에 시간순 텍스트 이벤트 목록.

**② EN (모바일 9:16)**
```
A mobile match replay player component UI design, [STYLE].
Vertical 9:16, the replay card filling most of the frame.
Top of the card: two equal-width tabs, the left one active.
Then a scoreboard row: a team word on the left, a large numeric score in the middle,
a team word on the right, and an elapsed match time at the far right, all in a monospaced numeric style.
Then a HORIZONTAL football pitch canvas with mown stripes and painted lines,
players rendered as very small colored dots with tiny numbers, one color per team, and a tiny ball dot;
a rounded caption pill floats near the center of the pitch with a short Korean word.
Below the pitch, three rows of controls: three icon-and-label buttons; then two toggle buttons shown active
plus a small label; then a five-segment speed selector with the middle segment active.
Then a row of four small jump buttons.
Then a horizontal timeline slider whose track is studded with small colored event tick marks,
the handle near the left end, with a time-over-total text line underneath.
At the bottom, one monospaced log line. Flat straight-on UI, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same replay player as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
The replay card is wide: tabs across the top, scoreboard row, a wide horizontal pitch canvas
taking the majority of the card, and the control rows arranged in fewer, wider rows beneath it,
with the studded timeline slider spanning the full card width. Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `realistic 3D football players, motion blur action shot, broadcast camera angle, stadium crowd, vertical pitch, photorealistic grass`

---

### S08. 하프타임 `/match/:id`

**① 한국어 기술**
상단바 제목 「하프타임」 + 상태 배지 `H1_BREAK`.
1. 중앙 정렬 한 줄 — `전반 스코어 1 : 1`(굵게)
2. **매치 뷰어 카드 임베드**(S07 그대로, 전폭)
3. **선수 교체 카드** — 제목 「선수 교체 (0/3)」. 한 줄에 좌 `OUT (선발)` 드롭다운 / 중앙 교환 아이콘 `⇄` / 우 `IN (벤치)` 드롭다운 / 맨 오른쪽 작은 「추가」 버튼. 추가된 교체는 아래에 행으로 쌓이고 각 행 우측에 제거 버튼.
4. **팀 전체 프롬프트** 여러 줄 입력 + 우하단 글자수 카운터
5. **선수별 프롬프트 아코디언 리스트** — 행마다 좌 포지션 약어 + 이름 + 우측 `선발`/`벤치` 라벨 + `▼` 펼침 표시. 14행 정도.
6. 하단 **전폭 「후반 시작」 CTA**

**② EN (모바일 9:21, 전체 스크롤)**
```
A mobile half-time screen UI design, [STYLE].
Tall vertical 9:21 full-page view. Top bar with centered title and a small uppercase status badge.
Then a single centered bold score line. Then a large embedded match replay card
(two tabs, a scoreboard row, a horizontal pitch canvas with tiny colored player dots, control rows,
and a studded timeline slider).
Then a substitution card: a heading with a counter in parentheses, and a single row containing
a dropdown, a small exchange icon between them, a second dropdown, and a small solid button at the right.
Then a multi-line text input with a character counter at its bottom right.
Then a list of about fourteen identical accordion rows, each with a position abbreviation, a name,
a small right-aligned status label and a chevron.
A full-width primary call-to-action button at the very bottom. Flat straight-on UI, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same half-time screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
Two-column arrangement: the wide replay card on the left, and the substitution card, team instruction
text box and the accordion list of player rows stacked in the right column.
A full-width primary button pinned at the bottom of the content area. Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `player photos in the substitution rows, drag handles everywhere, more than three substitution rows`

---

### S09. 경기 결과 `/match/:id`

**① 한국어 기술**
상단바 「경기 종료」 + 상태 배지 `FINISHED`.
1. **매치 뷰어 카드**(후반 재생) 전폭
2. **결과 배지** — 중앙 정렬 pill 하나(「승리」/「무승부」/「패배」), 결과에 따라 테두리·글자색이 다름
3. **스코어 줄** — `내 팀 2 : 3 상대팀`, 굵고 크게 중앙 정렬(팀명이 길면 2줄로 감김)
4. **보상 줄** — `보상 +100 P`, 중앙 정렬, 강조색
5. **팀 스탯 카드** — 제목 「팀 스탯」, 그 아래 좌우 팀명 헤더, **6행 3컬럼 비교 테이블**(좌=내 수치, 중앙=항목명, 우=상대 수치). 항목: 골·슛·코너킥·파울·카드·오프사이드. 수치는 크고, 항목명은 작고 회색
6. 하단 **전폭 「로비로」 CTA**

**② EN (모바일 9:16, 스탯 중심)**
```
A mobile match result screen UI design, [STYLE].
Vertical 9:16. Top bar with centered title and a small uppercase status badge.
A small portion of an embedded replay card at the top of the frame, then:
a centered outcome pill badge; below it a large bold centered score line in the form
"TeamA 2 : 3 TeamB"; below it a single small highlighted reward line.
Then a statistics comparison card: a title, a row with the two team names at the left and right,
and six comparison rows — a large number on the left, a small muted stat name centered,
a large number on the right. Perfect vertical alignment across all six rows.
A full-width primary call-to-action button at the very bottom.
Flat straight-on UI, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same result screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
Two-column arrangement: the wide replay card on the left; on the right, stacked — an outcome pill badge,
a large bold score line, a reward line, and a six-row three-column statistics comparison card.
A full-width primary button at the bottom. Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `confetti photo overlay, trophy 3D render, fireworks photo, real stadium celebration`

---

### S10. 상점 · 가챠 `/shop`

**① 한국어 기술**
상단바 좌 「← 로비」 / 중앙 「상점」 / **우측 포인트 pill**.
본문: **2열 카드 그리드 1행** — 좌 「단뽑 / 선수 1명」, 우 「10연뽑 / 선수 11명 · 골드 이상 1명 보장」. 각 카드 = 제목(굵게) + 부제(작은 회색, 2줄까지 감김) + **가격이 적힌 전폭 강조 버튼**(`300 P` / `3,000 P`). 그 아래는 전부 여백. 하단 5탭 네비.
**가챠 결과 모달 상태**: 화면 중앙 큰 모달 — 제목 「뽑기 결과 (11명)」 + **3열 카드 격자**(세로형 카드 슬롯, 미공개는 큰 `?` 만 보이는 빈 카드) + 하단 버튼 2개(전폭에 가까운 주 버튼 「다음 공개 (0/11)」 + 우측 보조 버튼 「모두 공개」). 전체 공개 상태에서는 카드 자리에 선수 카드가 채워지고 등급별로 시각적 위계가 생긴다.

**② EN (모바일 9:16, 기본)**
```
A mobile in-game shop screen UI design, [STYLE].
Vertical 9:16. Top bar: small back control on the left, centered title, and a rounded points pill
with a coin dot on the right.
Body: a single row of two equal rounded cards side by side. Each card has a bold short title,
a smaller muted subtitle wrapping to two lines, and a full-card-width solid price button at its bottom.
Everything below the two cards is empty negative space.
Fixed bottom navigation bar with five equal tabs. Flat straight-on UI, no device frame.
```

**③ EN (모바일 9:16, 가챠 결과 모달)**
```
A mobile gacha reveal modal UI design, [STYLE].
Vertical 9:16 with a dimmed shop screen behind. A large centered modal panel:
a bold title line at the top, then a 3-column grid of eleven identical vertical card slots
(taller than wide) each showing only a large question mark placeholder,
then a bottom row with one wide solid primary button on the left and a smaller outlined button on the right.
Flat straight-on UI, no device frame.
```

**④ EN (데스크탑 16:9)**
```
Same shop screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
Two very wide cards side by side across the content area, each with a bold title,
a muted subtitle and a full-width solid price button. Vast empty space below.
The gacha reveal variant shows a centered modal with a wider grid of vertical card slots.
Flat straight-on UI, no browser chrome.
```

**⑤ 추가 네거티브**: `slot machine, casino chips, loot box 3D render, sparkle photo overlay, real currency symbols, credit card imagery`

---

### S11. 도감 `/codex`

**① 한국어 기술**
상단바 「도감」 + 우측 소장 카운터(`보유 14/172`).
필터 영역 2줄 — 1줄: 등급 칩 6개(전체·브론즈·실버·골드·다이아·레전드, 활성 칩 강조) / 2줄: 포지션 칩 5개(전체·GK·DF·MF·FW). 그 아래 결과 개수 캡션 한 줄.
본문: **3열 카드 격자**가 화면 끝까지 이어진다(총 172셀, 세로로 매우 김). 각 셀 = 작은 카드, 좌상단 포지션 약어 + 우상단 등급 약어, 아래 선수 이름(길면 말줄임). **미보유 셀은 흐리게 눌려 있고 보유 셀은 정상 밝기**로 대비된다 — 이 대비가 화면 전체의 리듬을 만든다.
하단 5탭 네비.

**② EN (모바일 9:16)**
```
A mobile collection index / catalog screen UI design, [STYLE].
Vertical 9:16. Top bar with centered title and a small "owned / total" counter at the right.
Two rows of small pill filter chips (six chips, then five chips), the first chip of each row active.
One small muted count caption below them.
Body: a dense 3-column grid of many small uniform cards running to the bottom edge of the frame,
each card showing a tiny position abbreviation at the top left, a tiny tier abbreviation at the top right,
and a truncated name below. Most cards are visibly dimmed and desaturated,
while a small minority are at full brightness — the contrast between owned and unowned cells
is the dominant visual rhythm of the screen.
Fixed bottom navigation bar with five equal tabs. Flat straight-on UI, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same catalog screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
The filter chip rows span the content width, and the card grid becomes six columns wide,
filling the viewport with many small uniform cards; most dimmed, a minority at full brightness.
Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `real footballer portraits, club crests, national flags of real countries, trading card photo, foil texture photograph`

---

### S12. 트레이드 `/trade`

**① 한국어 기술**
상단바 「트레이드」 + 우측 포인트 pill.
**슬롯 카드 3장.** 모바일은 세로 스택, 데스크탑은 **가로 3열**.
**(a) 대기(WAITING) 상태 카드**: 헤더 좌 「슬롯 N」 / 우 상태 pill 「대기 중」 → 그 아래 **점선 테두리 박스** 안에 작은 라벨 「다음 선수까지」 + **아주 큰 카운트다운 숫자**(`72:00:00`) → 하단 행: 좌 「단축 비용」 + 코인 pill(`3,600 P`) / 우 「포인트로 단축」 버튼. 포인트 부족 시 버튼 아래 붉은 경고 한 줄.
**(b) FA 영입(OPEN) 상태 카드**: 상태 pill 이 「FA 영입」으로 바뀌고 → **영입 대상 선수 박스**(강조 테두리): 작은 라벨 「영입 대상」 + 포지션 약어 + 이름(굵게) + 등급 라벨 + **능력치 5행**(기술·피지컬·패스·슈팅·스피드 각각 **가로 막대 + 우측 수치**) → 중앙 정렬 「선수 가치 1868」 → **제안 빌더 박스**: 「내 선수 제안 (2)」 + 내 선수 **칩 그리드**(칩 = 포지션 약어 + 이름 + 등급, 선택된 칩은 테두리·배경 강조) + 「함께 낼 포인트: 0 P」 + **가로 슬라이더** + 작은 이탤릭 안내문 → **전폭 「제안 보내기」 버튼**.
**(c) 결과 모달**: 성공/실패 결과 표시.

**② EN (모바일 9:21, 혼합 상태)**
```
A mobile trade / transfer screen UI design, [STYLE].
Tall vertical 9:21 full-page view. Top bar with centered title and a points pill at the right.
Three stacked slot cards.
The FIRST card is in an open state: a header row with a slot label on the left and a small status pill
on the right; inside, a strongly outlined highlight box containing a tiny label, a position abbreviation,
a bold player name, a tier label, and five attribute rows — each a short label, a horizontal bar meter
partially filled, and a numeric value at the right; below it a centered value line;
then a sub-box titled with a count in parentheses containing a wrapped grid of small player chips
(each chip showing a position abbreviation, a name and a tier word), two chips visibly selected;
then a points line, a horizontal slider, a small italic note, and a full-width solid button.
The SECOND card is the same open state. The THIRD card is in a waiting state:
a header with a status pill, a dashed-border box containing a small label and a very large countdown
number, and a bottom row with a cost label, a coin pill and an outlined button,
plus a small warning line underneath.
Fixed bottom navigation bar with five tabs. Flat straight-on UI, no device frame.
```

**③ EN (데스크탑 16:9)**
```
Same trade screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
The three slot cards sit side by side as three equal columns across the content width:
one waiting card with a dashed box and a very large countdown number,
and two open cards each with a highlighted target-player box containing five attribute bar rows,
a chip grid offer builder, a slider and a full-width button. Flat straight-on UI, no browser chrome.
```

**④ 추가 네거티브**: `handshake photo, contract paper photo, money stacks, real player photos, auction gavel`

---

### S13. 로그 · 랭킹 `/logs`

**① 한국어 기술**
상단바 「로그」.
**탭 3개**(경기 / 트레이드 / 랭킹) — 균등 폭, 선택 탭 아래 굵은 밑줄.
- **경기 탭**: 세그먼트 필터 3칸(전체·연습·리그, 첫 칸 활성, 한 덩어리 라운드 컨테이너) + 아래 경기 기록 행 리스트(각 행: 날짜·모드 배지·스코어·승패 라벨·재생 링크). 비었을 때는 회색 한 줄 「기록이 없습니다.」와 넓은 여백.
- **트레이드 탭**: 트레이드 이력 행 리스트.
- **랭킹 탭**: **「리더보드」 카드** — 행마다 좌 순위 숫자 + 닉네임 + 우측 `N승` + `승률 %`. **내 행은 테두리로 강조**. 그 아래 **「개인 기록」 카드** — 3행 라벨/값(최다 득점 선수 / 최다 연승 / 총 경기), 값은 굵고 우측 정렬.
하단 5탭 네비.

**② EN (모바일 9:16, 랭킹 탭)**
```
A mobile leaderboard / history screen UI design, [STYLE].
Vertical 9:16. Top bar with centered title.
Below it a row of three equal-width tabs; the third tab is active with a thick underline beneath it.
Body: a card titled with a short label containing five ranking rows —
each row has a rank number on the left, a username, and two right-aligned small metrics;
one row is visibly highlighted with an outline to mark the current user.
Below it a second card with three label-and-value rows, values bold and right-aligned.
Empty space below. Fixed bottom navigation bar with five tabs. Flat straight-on UI, no device frame.
```

**③ EN (모바일 9:16, 경기 탭 · 빈 상태)**
```
Same screen, [STYLE], with the first tab active instead: below the tabs a segmented control of three
options in one rounded container with the first option active, and beneath it a single small muted
"no records" line followed by a large empty area. Emphasize the emptiness as intentional.
```

**④ EN (데스크탑 16:9)**
```
Same logs screen as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
Three wide equal tabs spanning the content width, the active one underlined.
Below, the leaderboard card and the personal-records card sit side by side as two columns.
Flat straight-on UI, no browser chrome.
```

**⑤ 추가 네거티브**: `charts, graphs, pie chart, sparkline, medal icons, podium illustration`

---

### S14. 리그 `/league`

**① 한국어 기술**
상단바 「리그」 + 우측 시즌 배지(`시즌 1`).
**(a) 시즌 없음 상태**: 안내 카드 하나 — 제목 「리그에 도전하세요」 + 설명 2~3줄(봇 9팀과 더블 라운드로빈 18라운드, 승점 3-1-0 …) + **넓은 「리그 시작」 버튼**(카드 안 하단, 좌우 인셋). 아래는 여백.
**(b) 대시보드 상태**:
1. **다음 경기 카드** — 강조 테두리. 좌상단 작은 라운드 배지(`R1`) + `내 팀 (홈) vs 상대팀` + 그 아래 **전폭 「다음 경기」 CTA**(가장 강한 버튼)
2. **순위표 카드** — 제목 「순위표」 + 헤더 행(`# 팀 경기 승 무 패 득실 승점`) + **10행**. 팀명은 좌측 정렬, 수치는 우측 정렬 컬럼, 승점만 굵게. **내 팀 행은 배경 하이라이트**
3. **일정 카드** — 제목 「일정」 + 라운드 섹션(`R1`, `R2`, … 작은 회색 라벨) 각각 아래 5경기 행(`A vs B`, `vs` 는 작고 회색). **내 경기 행은 배경 하이라이트 + 우측 끝에 작은 `나` 마커**
모바일 = 순위표 위 / 일정 아래 세로 스택. **데스크탑 = 순위표(좌) + 일정(우) 병렬 2열**.
**(c) 시즌 종료 상태**: 최종 순위 + 보상 + 「새 시즌」 CTA.

**② EN (모바일 9:21, 대시보드)**
```
A mobile league dashboard screen UI design, [STYLE].
Tall vertical 9:21 full-page view. Top bar with centered title and a small season badge at the right.
First, a card with a distinct highlighted border: a small round-number badge on the left,
a matchup line "my team (home) vs opponent", and a full-width primary call-to-action button below it.
Then a standings table card: a title, a header row of eight short column labels,
and ten data rows — team name left aligned, six numeric columns right aligned,
the final points column in bold; one row has a highlighted background to mark the user's team.
Then a fixture list card: a title, then repeating round sections each introduced by a tiny muted
round label followed by five match rows of "TeamA vs TeamB" with the small connector word muted;
the user's own match row in each round has a highlighted background and a tiny marker at the right end.
Fixed bottom navigation bar with five tabs. Flat straight-on UI, no device frame.
```

**③ EN (모바일 9:16, 시즌 없음)**
```
Same league screen in an empty state, [STYLE]. Vertical 9:16.
A single card below the top bar containing a bold heading line, two to three lines of muted
explanatory text, and a wide solid button inset within the card near its bottom.
The rest of the screen is empty negative space. Fixed bottom navigation bar with five tabs.
```

**④ EN (데스크탑 16:9)**
```
Same league dashboard as a desktop layout, [STYLE]. Horizontal 16:9 with a fixed left vertical sidebar.
A full-width highlighted next-match card with a very wide primary button spans the top of the content area.
Below it a TWO-COLUMN layout: the ten-row standings table card on the left,
the round-by-round fixture list card on the right, both equal width and full height.
The user's team row and the user's fixture rows are highlighted in both columns.
Flat straight-on UI, no browser chrome.
```

**⑤ 추가 네거티브**: `real league logos, real club badges, trophy photo, bracket / knockout tree diagram, calendar widget`

---

## 4. 커버리지 체크

| 요청 화면 | 블록 |
|---|---|
| 로그인 | S01 |
| 로비 | S02 |
| 덱·전술보드 | S03 (+ S04 선수 시트) |
| 브리핑(컨디션·마킹) | S05 |
| AI 대기 | S06 |
| 매치 뷰어 | S07 |
| 하프타임 | S08 |
| 결과 | S09 |
| 상점·가챠 | S10 |
| 도감 | S11 |
| 트레이드 | S12 |
| 로그·랭킹 | S13 |
| 리그(순위표·일정·시즌종료) | S14 |

전 블록에 **모바일 9:16 · 데스크탑 16:9** 프롬프트가 각각 있고, 스크롤이 긴 화면(S03·S08·S12·S14)은 **9:21 전체뷰** 변형을 추가로 제공한다.

## 5. 다음 단계 (S0')
hero 가 `[STYLE]` 을 채워 이미지를 생성 → `design/concepts/` 에 입고 → 이 세션이 **역공학 분석**(픽셀 실측 팔레트·타이포 스케일·격자·컴포넌트 문법) → S0.5 게이트 → S1 `art-direction.md` + `tokens.css` 발행 → S2 화면별 적용 계획.
