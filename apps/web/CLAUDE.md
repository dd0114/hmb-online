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
| 밀집 UI — 리스트 행·전술보드 슬롯·매치 토큰·도감 그리드 | `common/CharAvatar` (얼굴 타일) | **기본** |
| 큰 화면 — 뽑기 결과·덱 지시 레일 헤드·도감 확장·트레이드 영입 대상 | `common/FullArtCard` (풀아트 + 등급 프레임) | hero 확정 자리에만 |

경계는 의견이 아니라 **계약**이다 — `e2e/p3-card-art.spec.ts` 가 밀집 UI 에 풀아트가 0개임을 강제한다.
새 화면에 카드를 넣을 땐 그 스펙에도 자리를 추가해라.

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
