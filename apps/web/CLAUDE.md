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

## 규칙
- Playwright E2E(AC-W1 풀 시나리오)가 주 게이트. 시각/연출 판정은 **독립 QA 서브에이전트**로만(자기검수 금지, 루트 §2-2).
- **e2e 전체 실행 금지** — `league-season`·`match-flow`·`w3-viewer-smoke` 는 :8080 라이브 데모에 붙는다.
  목 기반 스펙만 지정하고 `CI=1` + 빈 포트(`WEB_E2E_PORT=…`)로 돌려라(`reuseExistingServer` 가
  다른 세션 dev 서버를 주워 쓴다).
- 모바일 우선 반응형. 상태는 TanStack Query, 전역 스토어 도입 금지(PoC).
- 커밋 `[Spider] type(web): ...`.
