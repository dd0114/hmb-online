# server-java 모듈 가이드 (도메인 세션용 CLAUDE.md)

이 디렉토리는 **권위 게임 서버(Java) 도메인**이다. 이 모듈 세션은 `server-java/**`만 소유한다.

## 필독 (이 순서로)
1. `docs/plan-v2/PRD-v2.md` §3.2~3.5 (요구사항+AC) — 판정 기준
2. `docs/plan-v2/ERD.md` (Flyway V1 그대로) + `docs/plan-v2/LLD-server-java.md` (구현 상세)
3. `docs/plan-v2/api/openapi.yaml` (계약 SoT — 임의 확장 금지, 변경은 web·ts-servants 에픽과 조율)
4. 에픽 이슈(server-java) STATE — 진행 상황 SoT

## 도메인 경계 (위반 금지)
- `packages/engine|shared|server/**`, `apps/web/**`, `data/**` 수정 금지. 필요하면 해당 에픽에 이슈 레이즈(domain-split 원칙).
- 데이터는 `data/players/*.v1.json`을 **읽기만**(부팅 임포트). 수치 하드코딩 금지 — 전부 application.yml 또는 economy.v1.json (AC-S5).
- 서번트(ts-servants)와는 `/internal` 잡 프로토콜 + `/simulate` RPC로만 통신.

## 스타터/온보딩 (#209)
- **가입 지급 = 기본팩(economy.starterPack, SILVER/BRONZE) + 최상위 1장.** 최상위 후보 목록은
  **코드가 아니라 data 발행물**(`economy.starterTop.pool`, 현재 economy.v3.json) — #207 이 랜딩하면
  그 배열만 갈아끼운다. 서버 config/코드에 id 를 적으면 무배포 교체가 깨진다.
- 선택은 `UserOnboardingService.pickStarterTop` = `sha256(userId + ":starterTop") mod pool` — **시드 결정론**
  (`Math.random`·시계 금지, 재현 가능). 지급 사실은 `starter_grants`(user PK)에 **박제**한다:
  후보 목록이 바뀌면 재계산 결과가 과거 지급과 달라지므로 계산으로 답을 만들지 않는다.
- **덱은 가입이 아니라 `POST /api/me/tutorial-complete` 에서 지급**(`OnboardingService`, 멱등 —
  활성 덱이 있으면 절대 덮어쓰지 않는다). 완료 플래그 SoT = `users.tutorial_done`(**V17**, 기존 유저는 1로 백필).
- ⚠️ economy 파일 경로는 `application.yml` **과** `Dockerfile`(HMB_DATA_ECONOMYFILE) 두 곳에 있다 —
  버전을 올릴 땐 둘 다. 한쪽만 올리면 배포에서 조용히 구파일이 로드된다(starterTop 없으면 기본팩만 지급).
- **무배포 운영(#209 B안)**: `EconomyService` 는 생성자 1회 로드가 아니라 **리로드 가능**하다
  (`volatile Snapshot`). 발행물은 이미지에 구워져 불변이므로, 운영 변경은 **override 파일**
  (`hmb.data.economy-override-file`, 기본 = `hmb.db.path` 의 디렉토리 = 도커 영속 볼륨)에 쓰고 그걸
  우선 로드한다. 운영 API = `/api/admin/economy{,/history,/reload,/starter-top,/override}`
  (`AdminEconomyService`, 전부 admin 게이트 뒤 · 사유 필수 · **성공·실패 모두** `admin_ops_audit` V18 기록).
  - 부팅은 손상된 override 에 **관대**(발행물 폴백), 명시적 리로드는 **엄격**(400 + 직전 스냅샷 유지).
    폴백을 리로드에도 적용하면 "200 인데 반영 안 됨"이라는 거짓말이 된다.
  - 쓰기는 temp→ATOMIC_MOVE, 실패 시 직전 파일 복원. 롤백 = override 삭제 한 번.
  - 리로드는 **파싱만이 아니라 의미도** 본다(카탈로그 실재·기본팩 겹침·count) — 손으로 고친 파일을
    그대로 실으면 이후 모든 가입이 FK 로 죽는다(독립검증 BL-2). 그래도 새는 경우를 대비해 지급
    경로가 카탈로그에 없는 id 를 건너뛴다(= 최상위 누락 ≪ 서비스 중단).
- ⚠️ **무배포로 되는 것과 안 되는 것**(과장 금지): 되는 것 = `economy.starterTop`(스타터 최상위 후보).
  **여전히 배포가 필요** = 선수 스탯·등급·신규 유닛(`players.v2.1.json` → players 테이블 부팅 임포트),
  그리고 gacha 확률·rewards·growth 등 나머지 economy 블록(파일에는 있으나 **API 가 없다** — 볼륨
  손편집 + 리로드만 가능). 유닛 카탈로그의 무배포 운영은 #207 파트 A 소관이다.

## 매치 잠금·재입장 (#217)

- **유저당 끝나지 않은 매치는 최대 하나.** 정의는 `MatchService.ACTIVE_STATES`(BRIEFING~FAILED) ·
  `LOCKED_STATES`(= ACTIVE − BRIEFING). 게이트는 전부 `MatchLockService` 한 곳:
  `assertCanCreateMatch`(ACTIVE 면 409) · `assertNotLocked`(LOCKED 면 409, code=`MATCH_IN_PROGRESS`,
  detail={matchId,state,action}). **409 에 matchId 를 반드시 싣는다** — 빈 손 409 는 유저를 막다른 길에 세운다.
- **BRIEFING 은 LOCKED 가 아니다.** 브리핑 중 덱/전술 수정은 `recaptureSnapshotAtKickoff`(AC-B2)가
  지원하는 기존 기능이라 여기서 덱을 잠그면 기능 회귀다. 새 매치 생성만 막힌다.
- **잠그는 쓰기 = 진행 중 매치의 로스터·유효스탯을 바꿀 수 있는 것만**: `PUT /api/deck` ·
  `presets/team/{slot}/apply` · `growth/star` · `growth/dice` · `trade/{slot}/accept`.
  growth 는 취향이 아니라 **버그 차단**이다 — `buildSelectData` 가 시뮬 시점에 `effectiveAttributes` 를
  읽어 전·후반 사이 강화가 후반 스탯만 올린다. trade 는 `accept` 만 `user_players` 를 줄인다.
  뽑기·trade start/propose/decline/speedup 는 **잠그지 않는다**(과잉 409 = stale 탭 복구 불능).
  "경기 보러 가라"는 UX 잠금은 web 라우팅 소관이다.
- **터미널이 둘이다**: `FINISHED` + **`ABANDONED`**(V19). 전이가 전부 CAS(`WHERE state=?`)라
  ABANDONED 가 되는 순간 kickoff/resume/retry/prompts/halftime 이 자동 거부된다(새 가드 0).
  `state != 'FINISHED'` 로 "살아있음"을 판정하던 코드는 전부 `ACTIVE_STATES` 로 바꿔야 한다 —
  실제로 `LeagueService.nextMatch` 의 재사용 조건이 그랬고, 안 고치면 픽스처가 영구 잠긴다.
- **회수 경로(영구 잠금 금지)**: `POST /api/matches/{id}/abandon` — BRIEFING · FAILED ·
  **시계가 멈춘 라이브**(`phase_ends_at + stuck-grace-ms` 경과) · **멈춘 생성**(GEN*, 그 매치 잡의
  마지막 갱신 + `gen-stuck-ms` 경과)에서만 허용. 정상 재생 중 포기를 열면 지고 있는 경기 리롤
  (리그는 픽스처 리롤)이 된다. 백스톱 = `MatchAbandonSweeper`(`stale-after-min`).
  - ⚠️ **"GEN* 은 `JobLeaseSweeper` 가 다 잡는다"는 거짓이다**(독립검증 MAJOR-1). 그 스위퍼는
    `timedOutGenMatches` 의 `status != 'done'` 때문에 **미완 잡이 있을 때만** 잡는다. 잡은 전부
    done 인데 후속 전이가 커밋되기 전에 프로세스가 죽으면(재배포·OOM) 매치는 GEN* 에
    `phase_ends_at IS NULL` 로 남아 **어느 스위퍼에도 안 걸리고** retry 도 FAILED 전용이라 거부된다.
    `gen-stuck-ms` 분기가 그 구멍을 막는다(계약 = `MatchAbandonTest`
    `abandonOpensWhenGenerationIsStuckWithNoOutstandingJobs`).
  - ⚠️ **알려진 창**: 시계가 `stuck-grace-ms` 넘게 멈춘 리그 매치는 포기 → 같은 픽스처 재플레이가
    된다("지고 있으면 서버 지연을 기다린다"). 시계가 실제로 5분 멈춰야 하므로 실현 가능성은 낮지만
    유예를 줄일 땐 이 트레이드오프를 같이 봐라.
- ⚠️ **`/api/growth/*` 는 openapi 에 path 자체가 없다**(선존 갭, #217 이 만든 게 아니다).
  그래서 growth 의 409 계약 SoT 는 이 문서뿐이다 — growth 를 openapi 에 편입할 때 같이 옮겨라.
- 재입장 진입점 = `GET /api/me/active-match` → `{match(MatchDetail 통짜), locked, abandonable}`.
  MatchDetail 통짜인 이유 = web 이 한 요청으로 `clock` 을 받아 seek-to-now 를 태운다.
  `locked`/`abandonable` 판정은 **서버가 SoT** — 클라가 복제하면 규칙이 바뀔 때 조용히 어긋난다.

## 규칙
- 테스트 먼저(전이표·검증 매트릭스), `./gradlew test` green이 웨이브 완료 조건. JPA 금지(JdbcClient).
- 상태 전이는 CAS(`WHERE state=?`), 보상·원장은 멱등(유니크 인덱스). 트랜잭션 경계는 서비스 메서드.
- 커밋 `[Spider] type(server-java): ...`, gh 계정 dd0114, **gh auth switch 금지**(fleet 규칙).
