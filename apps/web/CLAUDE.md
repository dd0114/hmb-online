# apps/web 모듈 가이드 (도메인 세션용 CLAUDE.md)

이 디렉토리는 **웹 클라이언트(React SPA) 도메인**이다. 이 모듈 세션은 `apps/web/**`만 소유한다.

## 필독 (이 순서로)
1. `docs/plan-v2/PRD-v2.md` §2(유저 여정)·§3.7(AC-W1~W5)
2. `docs/plan-v2/LLD-web.md` (화면·구조·웨이브)
3. `docs/plan-v2/api/openapi.yaml` (서버 계약 SoT — 타입은 openapi-typescript 생성물 사용)
4. 에픽 이슈(web) STATE

## 도메인 경계 (위반 금지)
- 서버·엔진·뷰어 코드 수정 금지. API가 부족하면 server-java 에픽에 이슈 레이즈.
- **경기 캔버스 재생을 자체 구현하지 말 것** — QA 뷰어 소비(R1 이슈)만. R1 전에는 텍스트 타임라인까지만(LLD-web §3). 재발명 실패 사례 있음(#57).

## 캐릭터 아트 — 아이콘 / 풀아트 두 축 (#145 · #187)

| 자리 | 컴포넌트 | 언제 |
|---|---|---|
| 밀집 UI — 리스트 행·전술보드 슬롯·매치 토큰·로비·**도감 그리드/확장** | `common/CharAvatar` (얼굴 타일) | **기본** |
| 뽑기 결과 그리드 | `FullArtCard` (프레임 통짜 — 이름·별·등급이 카드 안 밴드에 앉는다) | `variant="card"` |
| **강화/카드 상세**(`CardGrowthDetail`) · 덱 지시 레일 헤드 · 트레이드 영입 대상 | `FullArtCard` (**아트만**) | `variant="art"` |

- **도감은 어느 상태에서도 풀아트가 아니다.** `#179` 로 흐름이 바뀌어 보유 선수 탭은 **강화 상세 모달**로
  가고, 인라인 확장은 **미보유(잠금) 전용**이 됐다 — 잠긴 카드에 원색 전신 일러스트를 띄우면 잠금 표현과
  어긋난다. 풀아트가 필요한 자리는 강화 상세다.
- **`variant="art"` 를 쓰는 기준**: 이름·등급·별을 카드 **밖**에서 이미 보여주는 자리. 프레임 통짜를 쓰면
  에셋이 그려둔 하단 밴드가 **빈 검은 띠**로 남는다(트레이드에서 카드 높이의 22%였다).
- **포지션 뱃지는 항상 선수 값으로 덮는다** — 아트에 구워진 건 **캐릭터의** 포지션이라 교차 매핑 선수
  (`player-chars.v1.json` 의 `crossPosition`, 현재 P012 1명)에서 틀린 값이 노출된다. 계약 표본에 그 선수를
  넣어야 검사가 성립한다.

### 아트 축이 **셋**이다 (#207 W3-D) — 매핑이 어느 manifest 를 볼지 정한다

`player-chars.v2.json` 의 값은 문자열이 아니라 **`{axis, id}`** 다. `charRefFor` 가 정규화하고
`char-manifest` 가 축별 접근자를 준다. 등급별 배정(U-D5·U-D8·U-D9):

| 대상 | 축 | 아트 |
|---|---|---|
| 활성 LEGEND 5 (P173·P175·P176·P177·P179) | `units` | 유닛별 고유 실아트 1:1 |
| **활성화 대기 LEGEND 1 (P180 경니시우스)** | `units` | 실아트 1:1 — **아트는 있고 시드는 아직 `active:false`** |
| 비활성 LEGEND 14 / DIA 25 | `characters` | 현행 원화(1:1 / 포지션 풀) |
| 아트 미입고 LEGEND 2 (P174·P178) | — | **미매핑 = 이니셜 폴백**(의도) |
| GOLD·SILVER·BRONZE 133 | `units` | `default-unit` 공용(도트, `pixelArt`) |

- ⚠️ **"활성"과 "아트 있음"은 별개 축이다**(3차 입고 2026-07-29). 운영 순서가 "아트 머지 → 배포 →
  어드민 API 로 활성화"(#207 파트 A)라서 **비활성인데 아트가 있는 중간상태가 정상**이다. web 은
  아트를 **매핑 유무로** 그린다(활성 여부로 분기하지 마라) — 활성화 토글이 켜지는 순간 아트가
  같이 떠야 하기 때문. 도감의 `off` 뱃지만 `active` 를 본다.
- 발행물에 `pendingCatalog:true` 인 유닛(현재 `seokdijk`)은 **대응 선수가 카탈로그에 없어** 매핑이
  없다 — web 에서 그려지는 자리가 아예 없다. 채번되면 매핑만 붙으면 된다.

- ⚠️ **`units[id].card.kind` 가 분기 권위다. 유닛명을 코드에 하드코딩하지 마라** — 에픽 초기
  인벤토리가 "완성 카드 3종"으로 잘못 적혔다가 2종으로 정정됐고, 그 뒤 재발행으로 **0종**이 됐다.
  이름을 박아 뒀다면 매번 깨졌을 자리다.
  `complete` = 프레임이 **이미 구워진** 통짜 → `frame-<GRADE>.png` 를 깔면 **프레임이 두 겹**이
  된다. `frameless-art` = 기존 합성 경로 그대로.
  **현재 발행 구성 = `frameless-art` 6종 / `complete` 0종**(#207 재발행: 보날두·욱링엄의 구워진
  숫자·별이 실데이터와 어긋나고 종횡비가 튀어서 프레임리스로 재발행). `complete` 분기는 **지우지
  않는다** — 발행측이 언제든 다시 실을 수 있고, 실물이 0종이라 실 manifest 기반 단언은 공허해지므로
  **픽스처 manifest 로 계약을 태운다**(`full-art.test.ts`·`FullArtCard.test.ts`·`char-manifest.test.ts`).
- ⚠️ **`fit:"fill"`(프레임리스 아트) 컨테이너는 아트 창이다, 카드 통짜가 아니다.** 통짜(`inset:0`)에
  `object-fit: contain` 을 걸면 2:3 아트가 226×425 카드 안에서 세로로 남아 **네임플레이트를 덮는다**
  (실측 침범 12~34px, #207 재발행 실화면에서 발·공이 이름을 가렸다). `variant="art"`·완성 카드만
  통짜가 맞다(그 박스 자체가 아트 박스라서). 계약 = `FullArtCard.test.ts` "아트 창 안에 갇힌다".
- **경기장(`viewer-skins`)은 두 축을 다 태운다(#218).** 페이로드가 `atlases:[{url,tile}]` + 셀의
  `atlas` 인덱스라 축마다 자기 시트를 싣는다(viewer-core 멀티 아틀라스). 그래서 활성 LEGEND
  실아트가 덱·도감뿐 아니라 **경기장에도** 뜬다.
  - 안 태우는 것은 **등급 공용 디폴트**뿐이다 — 판정은 발행물 `forGrades` 선언(`unitIsSharedDefault`,
    유닛명 하드코딩 금지). 셀이 없는 선수는 뷰어가 팀색 원으로 그리므로 "빼는 것"이 곧 U-D8이다.
  - **등번호(`nums`)는 아트 유무와 무관하게 전원 싣는다.** 안 실으면 코어가 `playerId` 에서 번호를
    파생해 실경기 id("P173")가 토큰을 덮는다 — #218 제보("아이콘 안 보임")의 절반이 이거였다.
  - 계약 = `e2e/p218-legend-arena.spec.ts`(픽셀 판정: 폴백 가시성 · 얼굴 렌더 · bg 클립/부분 열화)
    + `viewer-skins.test.ts` + `packages/engine/dev-viewer/qa-skin.test.ts`.
  - ⚠️ **경계**: 이 배선의 절반은 `packages/viewer-core/**`(QA 도메인)에 있다. 위 "뷰어 코드 수정 금지"의
    예외는 **이슈로 승인된 스코프일 때만** 이다 — #218 이 owned-glob 에 `packages/viewer-core/**` 를
    명시해 코어 스킨 계약(`setSkin` 페이로드·토큰 렌더)을 여기서 고쳤다. 승인 없이 코어를 고치지 말고
    이슈를 레이즈해라(#57 원칙). 코어를 건드리면 루트 `npx playwright test`(뷰어 계약)도 같이 돌린다.
- 얼굴 아이콘은 `iconBackground` 를 존중한다. **해석은 자리마다 다르다 — 같은 플래그, 다른 결론**:
  - **정적 UI**(`CharAvatar`, 32~96px): `opaque-dark` = **원형 마스크 금지**, 라운드 사각(`.opaqueBg`).
    크게 보이는 자리라 원형으로 자르면 배경 전제로 번진 글로우 링·수염선이 잘린 게 눈에 띈다.
  - **경기장 토큰**(viewer-core, 지름 ~32px): `opaque-dark` = **원형 클립**(`cell.bg`). 여긴 팀색 링
    안에 앉는 자리라 안 자르면 불투명 배경이 **사각 덩어리**로 링을 뚫고 나온다. 글로우 손실보다
    토큰 형태가 우선(#218 실화면 판정 — 독립 QA PASS).
  - 새 소비자를 만들면 어느 쪽인지 **여기에 적어라**. 플래그만 보고 한쪽 규칙을 복사하면 반대쪽이 깨진다.

경계는 의견이 아니라 **계약**이다 — `e2e/p3-card-art.spec.ts` 가 밀집 UI 에 풀아트가 0개임을 강제하고,
아트 변형은 `expectArtCrop`(프레임 요청 0 + 아트 종횡비)로 지킨다.
새 화면에 카드를 넣을 땐 **이 표와 그 스펙을 같이** 갱신해라 — 표만 남으면 다음 사람이 표를 근거로
계약을 깨는 방향으로 되돌린다(실제로 그런 모순이 한 번 생겼다).

**갈아끼우기**(hero 요구): 이미지·규격·크기·색을 `apps/web` 코드 수정 없이 바꿀 수 있게 해놨다 —
전부 `src/common/full-art.ts` 상단 주석 §② 참조.
- 에셋 교체 = `design/characters/dist/**` 재발행 → `npm run build:chars` (경로는 manifest 에서 읽는다)
- 카드 규격 = 발행 manifest 의 `cardGeometry` 가 기본값을 이긴다(`resolveCardGeometry`)
- 크기 = `FULL_ART_SIZES` 토큰 한 곳 / 색·폰트비 = `FULL_ART_DESIGN` + `FullArtCard.module.css` 변수
- ⚠️ **모바일 하단 독의 카드 크기(`railCompact`)는 #106 R3a 세로 예산과 묶여 있다** — 키우면
  `e2e/deck-teamsheet.spec.ts` 가 깨진다(리스트가 덮인다). 숫자만 올리지 말 것.

## 스타터/온보딩 (#209)

| 자리 | 컴포넌트 | 비고 |
|---|---|---|
| 뽑기 결과 카드 1장 | `common/RevealCard` | GachaReveal 에서 **추출**(#209) — 뒤집기·풀아트·NEW 뱃지 |
| 가입 지급 연출 | `auth/StarterReveal` | 같은 `RevealCard` 를 쓴다(모양이 갈라지지 않게) |

- 가입 직후 `GET /api/me/starter-grant` 로 **최상위 유닛 1장**을 받아 덮인 카드로 연출한다.
  지급이 없으면(구 계정·조회 실패) 카드 없이 문구만 — **연출이 없다고 가입 동선이 막히면 안 된다.**
- 튜토리얼 완료/건너뛰기 저장은 `persistTutorialDone` **한 곳**이 `POST /api/me/tutorial-complete` 를 친다.
  이 호출이 서버에서 **덱 지급**을 트리거하므로 TutorialProvider 가 `["deck"]`·`["me"]` 캐시를 무효화한다
  (안 하면 유저가 빈 덱 화면에 남는다). 완료 SoT 는 이제 서버(`user.tutorialDone`), localStorage 는 폴백.
- **admin economy 패널**(`admin/EconomyOpsPanel` + `economy-logic`): 재배포 없이 스타터 최상위 후보를
  교체·리로드·롤백한다. 화면 계약의 핵심은 값이 아니라 **출처 뱃지**(BAKED/OVERRIDE) — 서버가
  override 파일로 갈아끼우는 구조라 출처 없이는 "반영됐나"에 답할 수 없다. 운영 액션은
  **성공·실패 모두** 캐시를 무효화한다(`onSettled`) — 실패가 화면에서 사라지면 원장의 의미가 없다.
  형태 검증은 클라(`economy-logic`), 데이터 검증(카탈로그 실재·기본팩 겹침)은 서버가 한다 —
  클라가 흉내 내면 데이터가 바뀔 때 조용히 어긋난다.
- ‘다시 보기’는 **로컬만** 되돌린다 — 서버 플래그를 false 로 되돌리는 경로를 만들면 지급 경로를 반복해
  두드리는 문이 된다. 계약 = `e2e/p4-starter-onboarding.spec.ts` + `src/auth/StarterReveal.test.ts`.

## 매치 잠금·재입장 (#217)

- 진행 중 매치가 있으면 메타 라우트 8개(`/lobby /deck /shop /growth /codex /trade /logs /league`)가
  `MatchLockGate` 로 감싸여 `/match/:id` 로 되돌린다. 목록 SoT = `common/match-lock.ts` 의
  `LOCKED_ROUTES`, 계약 = `common/match-lock.test.ts` + `e2e/p4-match-lock.spec.ts`.
- ⚠️ **강제 이동 조건은 `locked` 가 아니라 `locked && !abandonable`**(`shouldForceResume`).
  회수 가능한 사고 매치(생성 실패·시계 멈춤)까지 붙잡으면 **탈출구인 로비의 포기 버튼에 영영 못 간다** —
  AC3(영구 잠금 금지)이 리다이렉트 루프로 되살아난다. 이 한 줄을 `locked` 로 "단순화"하지 말 것.
- 상태 집합·포기 가능 여부는 **서버가 판정**한다(`GET /api/me/active-match` → `{match, locked,
  abandonable}`). web 은 그 두 불리언을 화면 동작으로 옮기기만 한다 — 규칙을 클라에 복제하면
  서버가 바뀔 때 조용히 어긋난다.
- 409 `MATCH_IN_PROGRESS` 는 **에러 문구가 아니라 이어가기 안내**다. `matchInProgressIdOf(err)` 로
  `detail.matchId` 를 뽑아 그 매치로 이동한다(로비 [연습 경기] 경로가 그 예).
- `/match/:id` 와 `/login`·dev 하니스(`/design/*`·`/qa/*`)는 잠그지 않는다 — 자기 자신을 막으면 루프다.
- ⚠️ **게이트는 App.tsx 에서 라우트마다 손으로 감싼다** — 하나를 빠뜨려도 유닛 테스트는 green 이다
  (`LOCKED_ROUTES` 는 상수 배열일 뿐 강제력이 없다). 구멍을 잡는 건 `e2e/p4-match-lock.spec.ts` 의
  **8개 라우트 전수 루프**뿐이니, 라우트를 추가하면 상수·App.tsx·그 루프를 **셋 다** 갱신해라.
- 409 를 이어가기로 처리하는 진입점은 **둘**이다: 로비 [연습 경기](`LobbyPage`)와 리그
  [다음 경기](`LeaguePage`). 새 매치를 만드는 버튼을 추가하면 여기에도 `matchInProgressIdOf` 를 붙여라 —
  안 붙이면 이동 링크 없는 막다른 토스트가 된다(독립검증 MAJOR-3 이 그 상태였다).

## 재화 표기 — 서버 주도 (#232)

**화면에 재화 심볼·이름·아이콘·가격을 적지 마라.** 전부 `GET /api/config` 에서 온다.

| 쓸 것 | 자리 |
|---|---|
| `<Amount code={...} value={n} icon? />` (`common/Amount.tsx`) | 금액을 그리는 **모든** 자리 |
| `useCurrency(code)` → `{symbol,name,icon,...}` | 문장 안에 이름/심볼이 필요할 때 |
| `formatAmount` · `shortageMessage` · `withIga/withEulReul/withEunNeun` (`common/currency.ts`) | 순수 문자열이 필요할 때(원장·테스트) |
| `useAppConfigValue()` (`common/AppConfigContext.tsx`) | 가격·플래그(`shop.gacha`·`shop.dice`·`shop.gemTopup.enabled`) |

- **코드 상수는 `CURRENCY_POINT`/`CURRENCY_GEM` 둘뿐이고 그건 표기가 아니라 키다.** `"P"`·`"💎"`·
  `"포인트"`·`"젬"` 을 다시 적는 순간 서버 주도가 깨진다.
- **가격 미러를 만들지 마라.** `growth-config.ts` 에 `DICE_BUY_COST = 500` 이 있었고 서버가 5,000 으로
  바뀐 뒤에도 남아 화면이 "500 P 로 구매"를 그렸다 — 눌러 성공하면 지갑이 10배로 줄었다(#213).
  뽑기도 같은 방식으로 "300 P" 라고 쓰면서 다이아 300 을 뺐다.
- **금액과 재화는 항상 같이 온다**(`Price{currency,cost}` · `TradeSlot.speedupCurrency`). 클라가 단위를
  추측하는 자리를 만들면 위 사고가 재발한다.
- **잔액 게이팅은 결제 재화 기준.** 무료재화 잔액으로 유상재화 상품을 잠그면 유저가 살 수 있는데도 잠긴다.
- **순수 모듈은 표기를 주입받는다** — `seasonRewardView(reward, formatPoints)`(기본값 = **단위 없는
  숫자**라 주입을 잊어도 틀린 단위가 새 나가지 않는다) · `formatPoints(value, unit)`(unit **필수** —
  타입이 강제한다).
- **폴백**: config 를 못 받으면 `<Amount>` 는 **코드를 그대로** 노출한다(`POINT 300`). 흰 화면도, 하드코딩
  "P" 복귀도 아니다. provider 밖(단위 테스트)도 같은 경로를 탄다 — 그래서 컴포넌트가
  QueryClientProvider 를 요구하지 않는다.
- ⚠️ **`골드`/`다이아` 는 카드 등급 이름이기도 하다**(hero 확정 C1: 재화는 심볼 `G`/`Z` 우선, 등급 라벨은
  현행 유지). 재화 문자열을 지운다고 `GRADE_LABELS` 까지 건드리지 마라 — 계약이 그걸 잡는다.
- **`/api/config` 는 공개 엔드포인트다(인증 불필요).** 앱 부팅 시 **한 번** 부르는 값이라 로그인 전에
  401 을 맞으면 재조회 트리거가 없어 **그 세션 전체**가 코드 폴백으로 굴러갔다(독립검증 BL-1 —
  신규·세션만료 유저의 첫 진입이 전부 그 경로). 그래서 ① 서버에서 인증 제외 ② 이 경로의 401 은
  **세션을 파기하지 않는다**(`isSessionNeutralEndpoint` — 공개 응답 하나가 로그인 유저를 튕겨내면 안 된다)
  ③ 쿼리에 재시도·포커스 갱신을 열어 뒀다. 셋 다 계약이 있다.
- **가입 지급액도 서버에서 온다**(`grants.initialPoints/initialGems`). 클라 상수 3,000 이 박혀 있었고
  유상재화 지급은 **표기조차 없었다** — 운영이 무배포 override 로 지급액을 올린 뒤에도 화면은 그대로였다.
- 계약 = `e2e/currency-display.spec.ts`. **값이 아니라 "데이터를 따라오는가"를 본다** — config 를 `Ω/Ξ` 로
  목킹해 전 화면이 따라오지 않으면 실패한다(하드코딩을 되돌리면 실제로 7/10 이 깨진다). 목 헬퍼 =
  `e2e/app-config-mock.ts` — **새 목 스펙이 상점/지갑을 그린다면 이걸 실어라**(캐치올 `{}` 면 가격을
  모르는 폴백 화면을 보게 된다).
## 원정 리포트 팝업 (#245)

- 로비 진입 시 **미확인 피원정 결과**가 있으면 모달 1회(`lobby/AwayReportModal`). 확인(ack)하면
  다시 뜨지 않는다 — **미확인 상태의 SoT 는 서버**(`away_reports.seen_at`)이지 localStorage 가 아니다.
- **숫자를 클라가 다시 세지 않는다.** 승/무/패·득실·레이팅 합은 서버 `summary` 를 그리기만 한다
  (`lobby/away-report-logic.ts` 는 그 숫자를 문장으로 바꾸는 순수 함수뿐). 다시 세면 규칙이 바뀔 때
  화면과 서버가 조용히 어긋난다.
- ⚠️ **응답 형태를 믿지 않는다** — 이 엔드포인트가 없는 구 서버가 200 `{}` 를 주면
  `data.reports.length` 가 던져 **로비 전체가 흰 화면**이 된다(실제로 `p4-match-lock` 회귀 스펙이 이걸
  잡았다). `shouldShowAwayPopup` 이 배열·요약 존재까지 확인한 뒤에만 연다. 부가 기능이 앱 진입점을
  죽이면 안 된다.
- ⚠️ **#217 잠금과 충돌 금지**: 강제 이동(`locked && !abandonable`) 중에는 조회조차 하지 않는다 —
  로비를 스쳐 지나가는 사이 팝업이 떠 ack 이 소진되면 **결과를 영영 못 본다**.
- ack 실패해도 모달은 닫는다(StarterReveal 선례 — 연출 실패가 동선을 막지 않는다). 미확인은 서버에
  남아 다음 진입에 다시 뜬다.
- ⚠️ **리포트 행 클릭은 "확인"이 아니다.** 예전엔 클릭이 그 행을 ack 해서, 경기를 보러 간 순간
  리포트가 목록에서 사라졌다 — 이 앱엔 **지난 리포트를 볼 화면이 없으므로**(`status=all` 소비처 0)
  그건 영구 소실이다(독립검증 2R blocker). 확인은 [확인] 버튼만 한다.
- **몰수(0:0 + 비무승부) 행은 열 수 없다** — 상대가 브리핑에서 무른 경기라 재생할 하프가 없다.
  열면 수비자에게 "포기한 경기입니다"가 뜬다(포기한 건 상대인데). 판정 = `isForfeit`.
- **`/match/:id` 는 이제 관전자도 연다** — 홈 이름은 `match.ownerName` 이 먼저다(`me.nickname` 폴백).
  "홈 = 나" 로 되돌리면 수비자 관전 화면이 양 팀 이름을 바꿔 부른다. 쓰기 액션은 서버가 소유자에게만
  허용하므로 관전자가 눌러도 404다.
- **팝업 트리거 = [게임 시작] 클릭**(hero E1, 로비 진입 즉시가 아니다). 경기를 하러 온 순간에
  "자리를 비운 사이 이런 일이 있었다"를 보여주는 게 맥락이 맞고, 로비를 스쳐 지나갈 때 소진되지도
  않는다. 조회는 **미리** 해둔다(누른 뒤 받아오면 한 박자 늦게 뜬다). 팝업을 닫으면 원래 가려던
  모드 선택으로 **이어준다** — 한 번 더 누르게 하지 않는다.
- **원정은 상대 2택**(hero E2): [원정] → 서버가 제시한 2명 카드 → 택1. 후보는 **누른 뒤에** 받아온다 —
  미리 받아두면 모드 창을 열기만 해도 서버의 제시가 갱신돼 앞서 받은 목록이 조용히 무효가 된다
  (제시는 유저당 1개다). 캐시도 두지 않는다(`staleTime:0, gcTime:0`).
- 계약 = `e2e/p245-away-report.spec.ts` + `src/lobby/away-report-logic.test.ts`.

## 잠재 리롤 — 상점을 거치지 않는다 (#247)

- **상점에 [다이스] 탭은 없다.** 잠재 리롤은 강화 상세(`CardGrowthDetail`)의 두 버튼
  `잠재 재설정`(무료재화) / `고급 재설정`(유상재화)이고, 누르면 **서버가 지갑에서 바로 결제**한다.
  `DicePanel`·`useBuyDice`·`useDiceBalance`·`INSUFFICIENT_DICE` 는 전부 은퇴 — "보유 n개"를 다시 그리지 마라.
- **가격은 `useAppConfigValue()?.shop?.dice`** 하나뿐이다(#232). 미러 상수를 만들면 #213 이 재발한다.
  잔액 게이팅은 `balanceFor(price.currency, …)` = **결제 재화 기준**이고, 모르는 재화면 잠그지 않는다.
- **잔액 갱신은 `useDiceRoll` 의 `["me"]` 무효화가 한다.** 빼면 화면이 방금 쓴 돈을 계속 보여준다.
- **확인 다이얼로그는 "이 상세를 연 뒤 첫 롤"에서만**(hero 확정). 매번 물으면 천장까지 25~84회를
  누르는 흐름을 막고, 아예 안 물으면 오조작으로 한 판 값이 날아간다. `다시 묻지 않기` 는
  `growth/roll-confirm.ts`(localStorage, 예외를 삼키고 **확인을 띄우는 쪽**으로 폴백).
- **유상재화 충전(목업)은 [충전] 탭으로 옮겼다**(`GemTopupPanel`) — 원래 `DicePanel` 안에 있었지만
  충전은 다이스와 무관하고 게이팅 플래그(`shop.gemTopup.enabled`)도 원래 같았다.
- 계약 = `e2e/growth-mock.spec.ts`(구매 없이 차감·첫 1회 확인·클라 가드/서버 권위 2층·다이스 탭 0)
  + `e2e/currency-display.spec.ts`(리롤 비용이 서버 config 를 따른다).
## 시즌 종료 보상 화면 (#251)

- **status 이름은 서버가 정한다: `PENDING | GRANTED | NONE`**(openapi `SeasonReward.status`).
  클라가 지어낸 `AWARDED|FAILED` 만 알던 탓에 **종료된 시즌 전부가 "보상이 지급되지 않았습니다"로
  떴다** — e2e 목이 서버가 보내지 않는 `AWARDED` 를 쓰고 있어 계약이 green 으로 덮고 있었다.
  판정은 `isGranted()` 한 곳(구 별칭은 호환으로만 유지). **목을 서버 형상에 맞추는 것이 계약의 절반이다.**
- 시즌 젬은 이제 **완주 전원**(1등 9,000 / 2등 6,000 / 3등 4,000 / 4등 이하 3,000 Z, 금액 SoT = 서버
  economy config)이라 종료 화면은 항상 **G·Z 병기**다. 표기는 `<Amount>`·주입 포매터로만
  (`seasonRewardView(reward, formatPoints, formatGems)`) — 심볼을 코드에 적으면 #232 가 깨진다.
- 계약 = `league-logic.test.ts`(GRANTED/NONE 수용·병기·표기 주입) + `e2e/p3-league-reward.spec.ts`
  (서버 enum 4종 + 구 별칭) + `e2e/currency-display.spec.ts`(문장까지 서버 표기를 따르는지).

## 규칙
- Playwright E2E(AC-W1 풀 시나리오)가 주 게이트. 시각/연출 판정은 **독립 QA 서브에이전트**로만(자기검수 금지, 루트 §2-2).
- **e2e 전체 실행 금지** — `league-season`·`match-flow`·`w3-viewer-smoke` 는 :8080 라이브 데모에 붙는다.
  목 기반 스펙만 지정하고 `CI=1` + 빈 포트(`WEB_E2E_PORT=…`)로 돌려라(`reuseExistingServer` 가
  다른 세션 dev 서버를 주워 쓴다).
- 모바일 우선 반응형. 상태는 TanStack Query, 전역 스토어 도입 금지(PoC).
- 커밋 `[Spider] type(web): ...`.
