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
| 비활성 LEGEND 14 / DIA 25 | `characters` | 현행 원화(1:1 / 포지션 풀) |
| 아트 미입고 LEGEND 3 (P174·P178·P180) | — | **미매핑 = 이니셜 폴백**(의도) |
| GOLD·SILVER·BRONZE 133 | `units` | `default-unit` 공용(도트, `pixelArt`) |

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
- **경기장(`viewer-skins`)은 `characters` 축만 태운다.** 셀이 없는 선수는 뷰어가 팀색 원으로
  그리므로 "빼는 것"이 곧 U-D8(GOLD 이하 = 팀색 원)이다. 활성 LEGEND 실아트는 페이로드가
  단일 아틀라스라 아직 못 싣는다 — **viewer-core 변경이 필요한 알려진 갭**(테스트로 박제).
- 얼굴 아이콘은 `iconBackground` 를 존중한다(`opaque-dark` = 원형 마스크 금지, 글로우가 잘린다).

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

## 규칙
- Playwright E2E(AC-W1 풀 시나리오)가 주 게이트. 시각/연출 판정은 **독립 QA 서브에이전트**로만(자기검수 금지, 루트 §2-2).
- **e2e 전체 실행 금지** — `league-season`·`match-flow`·`w3-viewer-smoke` 는 :8080 라이브 데모에 붙는다.
  목 기반 스펙만 지정하고 `CI=1` + 빈 포트(`WEB_E2E_PORT=…`)로 돌려라(`reuseExistingServer` 가
  다른 세션 dev 서버를 주워 쓴다).
- 모바일 우선 반응형. 상태는 TanStack Query, 전역 스토어 도입 금지(PoC).
- 커밋 `[Spider] type(web): ...`.
