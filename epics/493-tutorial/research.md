# W0 조사 — #493 튜토리얼 전면 리뉴얼

브랜치 `epic/493-tutorial` (origin/main `21b95629` 기준). 세션 = root/hmb/tutorial.

## 축 1. 현행 튜토리얼 (완료)

### 스텝 데이터 — `apps/web/src/common/tutorial-steps.ts`
- 타입 `{ id, targetTestId, title, body, enabled, route? }` — 셀렉터는 CSS 가 아니라 **`data-testid`** 로만 지목.
- **온보딩 `TUTORIAL_STEPS` 7개**(전부 enabled): `play`(home-tile-game,/home) · `shop`(home-tile-recruit) · `codex`(home-tile-players) · `league`(home-tile-game 재지목) · `deck`(home-tile-deck) · `deck-board`(tactics-board,/deck) · `deck-save`(save-deck,/deck).
- **덱 셋업 `DECK_SETUP_STEPS` 3개**(별도 시퀀스, 완료 저장 안 함): `setup-auto` · `setup-motto`(editor-team-prompt) · `setup-save`.
- 트레이드 코치마크는 **의도적 부재**(hero 확정 2026-07-30 Q7=A — 영입 탭 미방문 시 `seen` 미충족으로 완료 불가해짐).
- 화면 커버리지 = `/home`, `/deck` **두 곳뿐**. 영입·리그·원정·트레이드 안내 없음.

### 렌더러·엔진
- `TutorialProvider.tsx`(372줄, App.tsx:261 에서 보호 라우트 감쌈) + `TutorialOverlay.tsx`(343줄) + 순수로직 `tutorial-logic.ts` + `Tutorial.module.css` + 컨텍스트 `tutorial-context.ts`(`{active, restart, startDeckSetup}`).
- **코치마크(비-모달)**: 4분할 dim + 하이라이트 링(`tutorial-highlight`), 대상은 뚫려 **클릭 통과**. 말풍선 `tutorial-bubble`/화살표/진행표시 `tutorial-progress`(`n / total`)/버튼 `tutorial-next`(마지막 "시작하기")·`tutorial-skip`.
- `role="dialog"` 이되 **aria-modal·포커스트랩 없음**(비-모달을 거짓말하지 않기 위해). ESC=건너뛰기.
- 대상 추적 = 매 프레임 + 스크롤/리사이즈 `measure()`, 부재 시 `missingGraceMs`(400ms) 유예. 다른 dialog 가 뜨면 코치마크가 **비켜난다**(`hasForeignDialog`).
- 레이아웃 `computeBubbleLayout` = below/above 뒤집기 + 뷰포트 clamp + 화살표 clamp.

### 진행 상태 저장 — 구조적 제약
- **서버 SoT** `GET /api/me → user.tutorialDone`, 저장 `POST /api/me/tutorial-complete`(`apps/web/src/api/p3.ts:81,264`).
- **localStorage 폴백** 키 `hmb.tutorial.done.<userId>` = `"1"`. `resolveTutorialDone = serverDone===true || localDone`(서버 false 가 로컬 true 를 덮지 않음).
- **세션 내 진행 = `seen` 집합**(실제로 그려진 스텝만 `onShown→markSeen`) — **메모리 전용, 리로드 시 소멸**.
- 완료 저장 조건 = `allSeen` 또는 `userDriven`(다음/건너뛰기). **대상 부재 스킵은 저장하지 않는다**. `persistIfOwner` = ownerUserId 일치 시만.
- **⚠️ 영속 진행 상태가 불리언 1개**(`users.tutorial_done`)뿐 — 다단계/보상 있는 튜토리얼로 가려면 여기가 구조적 제약.
- 다시보기: `MePage.tsx:98-109` `tutorial-replay` → **로컬만 지움, 서버 플래그는 되돌리지 않음**(지급 반복 방지).

### 트리거
- 자동시작 = 토큰+userId + 유저별 1회 + 경로가 `autoStartPaths`(`/home`,`/deck`) + `shouldStartTutorial(serverDone,localDone,pending)`.
- `pending` 신호 = 로그인 응답 `isNew`(`LoginPage.tsx:89-100`, 스타터팩 모달 + `/api/me/starter-grant` 동반). **메모리 변수**라 리로드 시 소멸.
- 라우트 변경 시 재개(못 본 스텝 중 그 화면에서 가능한 첫 스텝). 스텝당 `MAX_ATTEMPTS=2`. 계정 전환 시 `resetSession()`.
- 덱 셋업 트리거 = `/deck?setup=1`(`DecklessDialog.tsx:55` → `DeckPage.tsx:99-105`).
- 공지 팝업 경합 방지 = `lobby/tutorial-hold.ts`(`TUTORIAL_SETTLE_MS=600`).

### 현행 보상
- **재화/아이템 보상 없음.** 유일한 보상 = `OnboardingService.complete()`(server-java `meta/OnboardingService.java:108-131`)의 **스타터 덱 자동 생성**(멱등축 = 플래그가 아니라 "활성 덱 존재 여부", 11명 미만이면 warn 후 생략). 컨트롤러가 `deckGranted` 시 `prewarmService.onDeckSaved`.
- 가입 시 최상위 유닛 지급은 별개(연출 조회 `GET /api/me/starter-grant`).

### 기존 테스트 (리뉴얼이 깨뜨릴 계약)
- vitest: `tutorial-logic.test.ts`(209) · `tutorial-flow.test.ts`(777) · `tutorial-storage.test.ts`(132) · `lobby/tutorial-hold.test.ts`.
- playwright: `e2e/p3-tutorial.spec.ts`(**960줄** — AC-B1 온보딩, 키보드, AC-B2 모바일/데스크탑 배치, 유저 이탈 blocker-1, 계정전환 격리 BLK-1, "못 본 스텝이 완료를 막는다" BLK-2, 모달 공존 blocker-2, 대상 부재 스킵, 덱 라우트 넘나듦) · `e2e/p4-starter-onboarding.spec.ts`(245 — 지급 연출 + 완료→덱 지급 정확히 1회).
- server: `StarterReworkTest.java:134,139`.

### #492 접점
- `/event-board`·이벤트 계층은 **apps/web·server-java 에 코드 0**(스코프만 존재). 훅 후보: `OnboardingService.complete()`(완료+덱지급 한 트랜잭션) · `OnboardingController.completeTutorial()` · 클라 `markSeen`(현재 서버 전송 **없음** — 스텝 퍼널 보려면 API 신설 필요) · `LoginPage` `isNew` · `optOut`(이탈률).
- ⚠️ **충돌 주의**: #492 도 server-java Flyway 마이그레이션 + apps/web 을 건드린다 → 구현 시점 최신 마이그레이션 번호 재확인, additive 로만.

## 축 2. 보상 지급 경로·재화 'z' 단위 (완료)

### 'z' 의 정체
- **z = GEM(다이아, 유상재화) 심볼 `Z`** — `server-java .../catalog/EconomyService.java:73-74,101-103`. 무료재화 POINT 심볼 = `G`(골드).
- DB = `wallets.gems`(V11) + `gem_ledger`(유니크 `uq_gem_ledger_reason_ref(user_id,reason,ref_id)`). **users 테이블에 재화 컬럼 없음.**
- 웹 표기는 `common/currency.ts` + `<Amount>` 단일 경로(심볼 하드코딩 금지 규율, #232/#213).
- **경제 위치**: `gacha.singleCost=300`(economy.v4.json) → **300z = 단챠 정확히 1회**. 미션 HARD=300 과 동가. 5종×300z=1,500z = 가입 지급 6,000z 의 25%.

### 지급 경로·멱등 패턴
- 모든 재화 이동 = `WalletService.apply/applyGems`(`meta/WalletService.java:25,52`) — `INSERT OR IGNORE` 원장이 멱등 1차 축.
- 확립된 선례 3종: (a) 원장 유니크만(스타터, ref=userId) (b) 사실 박제 테이블+원장(`starter_grants` V17) (c) 상태행 CAS→지급→원장 백스톱(미션 claim `MissionService.java:341-375`, 메일 claim).
- **Flyway 최신 = V41 → 신규 V42**, `V{n}__snake_case.sql` + additive only(연속성 테스트가 결번·중복 차단).
- admin GEM 지급 경로 없음(POINT 만) — 운영 보정은 우편(`POST /api/admin/mails`)이 유일한 GEM 수단.

### 보상 5종 훅 후보 (file:line 은 에이전트 보고 원문)
| 행동 | 훅 | 비고 |
|---|---|---|
| ①튜토리얼 완주 | `OnboardingService.complete()`(`meta/OnboardingService.java:105`) | ⚠️ `tutorial_done` 플래그는 게이트로 안전하지 않음(설계 주석 :20-27) — 원장 ref=userId 가 축 |
| ②첫 경기 결과 열람 | `POST /api/rewards/{bundleId}/ack`(`RewardBundleService.java:118`, CAS 멱등) | result GET 은 상태 무기록(관전자도 호출) — ack 가 "봤다"의 정본 |
| ③덱 저장(auto) | `PUT /api/deck` → `DeckService.replaceDeck:89` | ⚠️ 서버는 auto 여부를 모름(요청 계약에 필드 없음) — additive 필드 또는 "저장 1회"로 정의 |
| ④첫 뽑기 | `GachaService.pull:74`(txRunner 안) | `gacha_pulls` 사실 원장 존재 |
| ⑤첫 트레이드 | start(`TradeService.java:249`)/propose(:472)/accept(:570) | hero verbatim "걸었을때" = 등록/시도 시점. accept 성공은 확률이라 부적합. `inTxWithBusyRetry` 재실행 주의 → 멱등 필수 |
| ①∩③ 주의 | 완주 경로가 내부적으로 `replaceDeck` 호출(:126) | 동시 발화 가능 |

### 웹 보상 연출 자산
- **정본 = `rewards/RewardSheet.tsx`**(봉투 시트, "앞으로 모든 보상이 이 탭 구조") + 섹션 레지스트리 `rewards/registry.ts`(CURRENCY order 10, 새 섹션 = 등록 한 줄).
- 봉투 조회 GET 엔드포인트 없음 — "봉투는 만든 화면에 additive 로 실려 온다". 매치 밖 보상 봉투는 조회 경로 신설 필요.
- 성공 토스트 시스템 부재(ErrorToast 만). 모달 2겹 금지 규율.
- 기타: StarterReveal(스타터팩 모달) · CelebrationOverlay · GachaReveal · MailCenter.

## 축 3. 화면 인벤토리 (완료)

### 라우트 (App.tsx:81-237, 보호 = RequireAuth+MatchLockGate)
`/login` `/home`(타일 5: game·deck·recruit·me·players, 홈은 nav 미표시) `/game`(mode-league/away/practice) `/away` `/deck` `/players`(도감+강화) `/recruit`(뽑기+트레이드 탭) `/me`(tutorial-replay) `/league` `/match/:id`(상태 기반 패널: briefing→genwait→live→halftime→result) + 구 URL 리다이렉트 + DEV 하니스.

### 코치마크 앵커 가용성
- 있음: `home-tile-*`, `mode-practice`, `save-deck`, `auto-fill`(⚠️ 빈칸 있을 때만 렌더 — 그래서 기존 setup-auto 는 `tactics-board` 지목), `editor-team-prompt`, `gacha-single/ten`, `trade-slot-{n}-start/-accept`, `propose-submit`, `start-league`, `next-match`, `away-start`, `kickoff-button`, `stage-tab-*`, `result-page`, `reward-panel`, `me-page` 등.
- 없음(추가 필요): 홈 로그아웃, `/players` 페이지 루트. `/league` 는 상태별 루트 분기(start-cta/dashboard/season-end), 트레이드는 슬롯 상태별 앵커 분기.

### 첫 진입 감지·오버레이 인프라
- 패턴 선례: `seen` 집합(그린 것만) · sessionStorage 1회(`splash-gate.ts`) · localStorage 영구+userId 격리 필요(공지 억제가 계정 공유되는 기존 결함 notice-logic.ts:149) · `lobby-popup.ts` 팝업 큐+튜토리얼 홀드 게이트.
- `TutorialOverlay` 재사용 가능(비-모달 코치마크, `hasForeignDialog` 자동 양보). **화면별 가이드는 온보딩 시퀀스와 분리된 프로바이더**가 맞음 — 배열 합치면 "n/total" 계약·완료 저장(=덱 지급 트리거) 깨진 전례(tutorial-steps.ts:128-141).
- `/match` 안내는 라우트가 아니라 **상태 전이 감지** — `match/flow/match-flow.ts` 브릿지가 이미 그 관측(첫 관측 prev==null 은 안 연다) 수행.
- 신규 유저 경기 버튼 = 3겹 deckless 가드(L1 홈타일 → DecklessDialog → `/deck?setup=1` → DECK_SETUP_STEPS 3스텝).

## 축 4. 매치로그 자산·실경기 소요시간 (완료 — 실측 포함)

### 웹 경기 재생 구조
- `/match/:id` → `useHalfLog`(GET halves/{h}/log) → `@hmb/viewer-core` `VisualPlayback` 직접 마운트(iframe 無). **apps/web 은 engine 비의존** → 쇼케이스 로그는 정적 자산으로 번들.
- **임의 MatchLog 주입 선례 2건**: QA 콘솔(`QaConsolePage.tsx:379-392`, 임의 JSON → VisualPlayback prop) · e2e 픽스처(2.06MB `engine@0.42.0-showcase` 를 현행 web 이 그대로 재생 = 구버전 로그 호환 실증). 코어 검증은 3필드 존재뿐(`viewer.impl.mjs:933-936`), 클라 zod 파싱·엔진 버전 검증 0건.
- 다시보기 이미 존재: 종료 매치 재입장 시 `clock=null` → 전 구간 시크 개방.

### 페이싱(실측)
- 1x = 2.4틱/s, 크루즈 4x, 하이라이트 1x, 골 홀드 1700ms(`playback.mjs:66-82`).
- **리얼 하프(1350틱) 재생 실측 n=4: 205.9~245.9s, mean 222.4s ≈ 3분40초.** `half-real-ms 220000` 은 폴백, 운영 창 = 러너 `playbackMs`(=autoPaceDurationMs).
- 일반 유저 관전엔 배속 UI 없음(고정 1x, hero 확정). 돌려보기 [1,2,0.5], QA full 6단.

### 쇼케이스 자산(실측)
- `dev-viewer/match-log.json`(gitignore 생성물): `engine@0.43.0-showcase` seed 27706472, 1440틱(24분 게임 → 표기 0~90'), 이벤트 335(골 8·슛 42·선방 11), 4:4, **전체 재생 254.8s / 전반 124.7s**.
- **1분 컷 실측**: autoPace 적분으로 60s 지점 = tick 345(표기 21'). tick≤345 컷 = 스냅 346 · 이벤트 82 · **골 2(5', 8')** · 원본 0.47MB · subsample×2 0.29MB · **gzip 62KB** · **재생 57.8s**. 컷은 JSON 필터로 충분(`finalScore` 를 컷 시점 스코어로 조정 주의).
- 대안: 하이라이트 릴(`buildHighlightReel`+`useHighlightSequencer`, 현재 기본 off 롤백 자산) — 골 8장면 ≈ 50s(계산 추정).

### 연습경기 1판 소요 분해(코드 상수 + 배포로그 실측)
- ①봇 매칭 ~0s ②브리핑 0.9~67s(실측) ③GEN1 정상 6~14s·대변경 1~2분·매치 타임아웃 240s→FAILED ④전반 ≈220s ⑤하프타임 180s(자동 재개) ⑥GEN2 0.3s ⑦후반 ≈220s.
- **합계: 기본 ≈11분20초 / 하프타임 즉시 넘김 ≈8분 / 오토+프롬프트 無 ≈7분30초 / 최악 15분+ 또는 FAILED.**
- ⚠️ 신규 유저 특이: 스타터 덱이 튜토리얼 완주 시점 지급 → 직후 첫 연습은 BASE 프리웜(19~65s) 미적중 창 → 풀생성 폴백 리스크(`DeckPrewarmService.java:17-24` 서술 그대로).

## 축 5. 첫 경험 설계 비교 (W0 종합)

| 축 | A. 강제 연습 1회 | B. 저장 리플레이 1분 미니게임 | C. 하이브리드(B→연습 유도) |
|---|---|---|---|
| 첫 "축구를 보는" 시점 | 가입 후 **7~11분**(덱 셋업+AI 대기 2회 뒤) | 가입 후 **1분 내**(58s, 골 2) | 1분 내 + 이후 진짜 경기 |
| 실패 모드 | GEN1 240s 타임아웃 FAILED·재시도 화면 | **0**(서버 접촉 0, 결정론 재생) | B와 동일하게 첫 인상 무결 |
| 구현 비용 | 0(기존 플로우 강제) | 얇음(정적 62KB + VisualPlayback 주입, 선례 2건) | B + 유도 CTA·보상② 연결 |
| 유저가 배우는 것 | 실플로우 전부(그러나 이해 전에 강제) | 게임의 보상(관전 재미)을 먼저 시연 | 시연 → 이해 후 자발 실행 |
| 리스크 | 첫 세션 이탈(최복잡 플로우 선불 + 실패 가능) | 진짜 경기로 못 넘어갈 수 있음 | 유도 CTA 설계 필요 |
