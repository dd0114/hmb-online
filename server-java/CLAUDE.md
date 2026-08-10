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
  - 🟢 **이제 계약이 막는다**(#450 W2): `DataVersionParityTest` 가 두 파일의 텍스트를 읽어 4종
    (`players`·`economy`·`bots`·`league`)을 **파일명 단위로 대조**하고, 한쪽만 올리면 red 다.
    "둘 다 구버전에 머무는 것"은 대조로는 안 잡히므로 **소비 중인 파일명을 상수로 못 박는다**
    (`consumedVersionsAreTheOnesCoveredBySeedTests`) — 다음 스위치는 대응 SeedTest 추가 + 그 상수
    갱신을 함께 해야 통과한다. Spring 프로퍼티로 재면 **yml 쪽만** 보이므로(Dockerfile 은 테스트
    JVM 에 없다) 관측 지점은 두 파일 텍스트여야 한다.
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
- **`short_name` (#411, V41)** — 카탈로그의 **표시용 짧은 이름**. 밀집 UI(덱 행·전술보드 슬롯·경기
  토큰·로그줄)가 한글 풀네임을 못 담아서 data 가 발행물 필드(`shortName`)로 내고, 서버는 그것을
  풀네임과 **같은 채널**(카탈로그 응답)로 흘린다. **NULL 이 정상값**이다 — ①구 발행물(v2.5 이하)엔
  필드가 없고 ②`admin_locked=1` 행은 시드 upsert 를 안 받는다. 폴백("없으면 풀네임")은 **web 이
  소유**하고 서버는 대신 채우지 않는다(채우면 클라가 유무를 구분 못 하고 규칙이 두 벌이 된다).
  - ⚠️ **알려진 갭(W2 밖)**: `AdminCatalogService` 는 이 필드를 다루지 않는다 — PATCH 로 이름을 바꿔도
    `short_name` 은 옛값 그대로이고(스테일), 어드민이 만든 유닛은 NULL 이며, `export()` 가 이 키를
    빼므로 **export → 다음 시드 승격 왕복에서 소실**된다. 손대려면 `UnitRow`·감사 diff·멱등 비교까지
    같이 움직여야 해서 별도 웨이브다.
  - ⚠️ `openapi.yaml` 의 `CatalogPlayer` 스키마엔 아직 없다(`docs/**` 는 이 모듈 밖) — `active` 와 같은
    additive·비필수로 편입 요청 필요.
- ⚠️ **무배포로 되는 것과 안 되는 것**(과장 금지): 되는 것 = `economy.starterTop`(스타터 최상위 후보).
  **여전히 배포가 필요** = 선수 스탯·등급·신규 유닛(`players.v2.1.json` → players 테이블 부팅 임포트),
  그리고 gacha 확률·rewards 등 나머지 economy 블록(파일에는 있으나 **API 가 없다** — 볼륨
  손편집 + 리로드만 가능). 유닛 카탈로그의 무배포 운영은 #207 파트 A 소관이다.
  - ⚠️ **`growth` 는 이 목록에서 빠졌다**(#405 W2a): 성장 계수는 이제 `GrowthTuning` + `V38`
    오버레이 원장 + `/api/admin/growth-config` 로 **무배포 조정된다**(아래 절). economy 의
    `growth`/`star` 블록은 그 **기본값의 출처**로만 남는다.

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

## 재화 표기 메타 (#232)

- **표기는 데이터다.** `EconomyService.Currency`(code·symbol·name·icon·position·separator)가 economy
  스냅샷에 실리고 `GET /api/config`(`meta/ConfigController`)로 나간다. 표기 변경 = economy override +
  `POST /api/admin/economy/reload` — **web·server 재배포 0**.
- **내부 코드는 바뀌지 않았다**: `wallets.points/gems` · `point_ledger`/`gem_ledger` ·
  `INSUFFICIENT_POINTS`/`INSUFFICIENT_GEMS` · `gacha.currency="POINT|GEM"` 그대로. 바뀐 건 표기 레이어뿐이다.
- **기본값 = 폴백층**(`DEFAULT_CURRENCIES`). 발행물(`economy.*.json#currencies`)이 이기고, 없거나 일부만
  있으면 **필드 단위로** 메운다(부분 override 성립 — 심볼 하나만 올려도 나머지는 유지). 발행물에 실린 뒤에도
  이 상수는 지우지 않는다(업계 표준 3층 중 last-known-good).
- **서버가 만드는 문구에도 재화 이름을 박지 마라** — 클라는 4xx `message` 를 그대로 토스트로 띄운다.
  `economyService.currency(code).name()` + `Josa`(이/가·을/를·은/는)로 만든다. 이름이 데이터가 됐으므로
  조사도 이름을 따라가야 한다("다이아이 부족합니다" 방지).
- **가격은 재화 코드와 함께 내려간다**(`ConfigController.Price` · `TradeSlot.speedupCurrency`).
  떼어 놓으면 클라가 단위를 추측하고, 그게 #213(화면 "300 P" / 실제 다이아 300 차감)의 형태였다.
- **`/api/config` 는 `AuthInterceptor` 제외 대상**(`WebMvcConfig`) — 클라가 부팅 시 한 번 부르는 값이라
  401 을 내면 그 세션 전체가 표기 없이 굴러간다(독립검증 BL-1). 유저 데이터 0 인 공개 카탈로그다.
  계약 = `CurrencyConfigApiTest.configIsReachableWithoutAuth`(인증 제외를 되돌리면 실제로 깨진다).
- **재화를 정하는 쪽이 그 재화의 잔액도 준다** — `TradeSlot.speedupCurrency` 를 서버가 정하므로
  `TradeSlotsResponse.wallet` 에 `gems` 를 같이 싣는다(#232 additive). 안 그러면 클라가 유상재화 비용을
  무료재화 잔액으로 잰다.
- 계약 = `CurrencyMetaTest`(로더 성질) + `CurrencyConfigApiTest`(**변이체 킬** — 발행물 표기를 `Ω/Ξ` 로
  바꿔 두고 API 응답·에러 문구가 따라오는지). 심볼 값 자체는 단언하지 않는다(값은 언제든 바뀐다).
## 원정(피침공)·레이팅 (#245)

- **원정 = 실유저 팀을 상대로 하는 비동기 대전.** 그 전까지 이 서버엔 "한 유저의 팀이 남의 상대가
  되는" 경로가 **아예 없었다**(matches.bot_id 는 bots FK, bots 출처는 시드 3종 + 리그 생성 봇팀뿐).
  새 대전 파이프라인을 만드는 대신 **리그 패턴을 재사용**한다 — 수비자의 덱 스냅샷을 `bots` 행으로
  구워 `matches.bot_id` 로 물린다(`AwayService.bakeGhost`). 그래서 매치 생성·AI 잡·시뮬·정산 경로는
  **변경 0**이고, `buildBotContext` 가 봇 덱의 `promptText` 를 이미 읽으므로 **수비자가 써둔 선수별
  지시가 그대로 상대 AI 인풋**이 된다.
- **고스트 bot id 는 덱 해시를 포함한다**(`GHOST_<userId>_<hash12>`). 덱이 바뀌면 같은 행을 덮는 게
  아니라 새 행이 생긴다 — 시뮬은 매 하프마다 봇 덱을 다시 읽으므로, 덮어썼다면 진행 중인 매치의
  상대가 전·후반 사이에 바뀌고 재현이 깨진다. upsert 가 갱신하는 건 `name`(닉 변경) 뿐이다.
- **상대가 없으면 매치를 만들지 않는다**(404 `NO_OPPONENT`). 봇 폴백은 "원정 갔는데 사실 봇"이고,
  그러면 피원정이 발생하지 않아 리포트·레이팅이 영원히 빈 화면이 된다.
- **소유권**: 매치는 **공격자**의 것(`matches.user_id`). 수비자 귀속은 `away_challenges` 가 소유하고,
  정산 시 `away_reports`(match_id UNIQUE = 멱등)로 옮겨진다. 매치 INSERT 와 도전장 INSERT 는
  **한 트랜잭션** — 갈라지면 "수비자 없는 원정"이 되어 정산이 조용히 건너뛴다.
- **레이팅은 `wallets.points` 와 다른 축**이다(포인트는 소비되는 재화라 실력을 말하지 못한다).
  hero 확정 = **초기 0 · 하한 없음**(그래서 `user_ratings` 엔 `CHECK(rating >= 0)` 이 **없다** —
  wallets 와의 의도적 차이). 값은 `hmb.away.rating.{win,draw,loss}`(현재 **±10, 공격자·수비자 대칭**),
  멱등은 `rating_ledger` 유니크가 point_ledger 와 동형으로 보장. 적용값은 `away_reports.rating_delta`
  에 **박제**한다 — 정책을 바꿔도 과거 리포트가 뒤늦게 다른 말을 하면 안 된다.
- **관전자 응답은 allow-list 로 깎는다**(`toDetailFor`) — 지울 것을 열거하면 필드가 늘 때마다 조용히
  샌다. 실제로 초판이 `userDeckSnapshot` 만 지우고 `conditions`(공격자 **선발 11 + 벤치 2 playerId 전량
  + 선수별 컨디션**)를 그대로 내보냈다(3R MAJOR-1). 계약도 "문자열 부재"가 아니라 **허용 키 집합**으로
  건다 — 그래야 새 필드가 기본으로 막힌다.
- **몰수 정산은 ABANDONED CAS 와 같은 트랜잭션**이다(3R MAJOR-2). 밖에 두면 매치는 터미널인데 정산만
  실패하는 창이 생기고, ABANDONED 는 어느 스위퍼도 다시 고르지 않아 **재시도 경로가 없다** — 수비자는
  리포트를 영영 못 받고 공격자는 −10 을 면제받는다(= D1 이 막으려던 리롤이 그대로 열린다).
- **수비자 관전은 읽기 전용**(hero Q5): `MatchService.getViewable` = 소유자 OR `away_reports.defender_id`.
  ⚠️ **GET 3개**(`/api/matches/{id}`, `/halves/{half}/log`, `/result`)에만 쓴다. 쓰기는 전부 `getOwned`
  그대로 — 관전 권한이 조작 권한으로 새면 남의 경기를 남이 끝낼 수 있다. 권한 근거인 리포트 행은
  **터미널 상태에서만** 생기므로(FINISHED 정산 또는 D1 몰수의 ABANDONED) **수비자가 여는 매치는
  언제나 이미 끝난 경기**다 — 진행 중인 남의 매치는 어느 시점에도 열리지 않는다.
  - ⚠️ 이 문장은 원래 "FINISHED 정산에서만"이었고 D1(몰수)이 그걸 **깨뜨렸다**(독립검증 2R blocker).
    몰수 리포트가 가리키는 매치는 ABANDONED 라 하프 로그가 없어서, 그 행을 열면 수비자에게
    "포기한 경기입니다"가 뜬다(포기한 건 공격자인데). → web 이 **몰수 행을 열지 못하게** 막는다.
    안전성 논증이 "FINISHED" 같은 좁은 사실에 매달려 있으면, 나중에 상태를 하나 늘릴 때 조용히 거짓이
    된다. 근거는 **"터미널이다"** 로 잡아라.
- ⚠️ **권한 확대는 "읽기냐 쓰기냐"만이 아니라 "무엇을 읽느냐"도 좁혀야 한다**(독립검증 BL-1).
  `getViewable` 만 넣었을 때 응답의 `userDeckSnapshot` 이 **공격자의 선수별 지시·팀 전술을 통째로**
  넘겼다 — 반대 방향은 `buildOpponent` 가 `hasPrompt` 불리언뿐이라 **수비자만** 상대 전술을 읽는
  일방적 스카우팅이 됐다. 프롬프트가 이 게임의 차별점인 이상(루트 §1) 레이팅이 걸린 대전에서 이건
  정보 유출이다. → `toDetailFor(viewerId, row)` 가 비소유자에게 스냅샷을 뗀다.
  계약 = `AwayRaidTest.watchingDoesNotLeakTheAttackersPrompts`.
- **고스트는 수비자의 성장·강화 유효스탯을 "얼려서" 싣는다**(`withFrozenAttributes` → 덱 JSON 의
  `slot.attributes`, 시뮬은 `MatchOrchestrator.frozenAttributesOf` 로 그 값을 우선 사용).
  - **왜 싣나**: 봇 로스터는 카탈로그 원본으로 선다(`growthUserId=null`). 그대로 두면 "상대는 실유저
    팀"이라면서 **그 유저가 키운 게 빠진 약화판**이 서고, 그 결과로 수비자가 −10 을 먹는다.
  - **왜 조회가 아니라 박제인가**: 수비자는 이 매치에 잠기지 않는다(#217 growth 잠금은 **자기** 매치
    한정). 시뮬 때 현재 스탯을 읽으면 전·후반 사이 강화가 후반 스탯만 올린다 — #217 이 잠금으로 막는
    바로 그 버그이고 재현도 깨진다. 값이 덱에 들어가면 **해시가 그 값까지 덮으므로** 강화는 "다음
    고스트"를 만들 뿐이다. 시드 봇·리그 봇팀엔 이 필드가 없어 그대로 원본(무회귀).
- ⚠️ **상대 지목은 공개 API 에 없다**(독립검증 MAJ-4). ±10 이 경쟁 축인 이상 클라가 상대를 고르면
  부계정을 반복 지목해 레이팅을 무한 생성할 수 있다. **다만 이게 파밍을 막지는 못한다**(5R MIN-4) —
  후보 풀이 작으면(오픈베타 초기·부계정 몇 개만 활성 덱) 무작위가 사실상 지목과 같아진다.
  쿨다운·동일 상대 재도전 제한은 **아직 없다**(hero 미결정 항목). 지목 원정은 쿨다운·중복 제한·상대 동의를 정한
  뒤에 여는 기능이다. `AwayService#start(attacker, defenderId)` 의 지목 인자는 **테스트 시임**이다.
- ⚠️ **내 덱 검증은 후보 루프 밖(맨 앞)이다.** 루프 안에 두면 공격자 자기 덱 오류가 후보마다 터지고
  루프가 그걸 삼켜 **404 `NO_OPPONENT`** 으로 뒤집힌다 — 덱이 문제인데 "상대가 없다"고 말하는, 유저가
  할 수 있는 게 0인 막다른 토스트다(#217 이 금지한 형태). 게다가 실패 1회가 **후보 수만큼 고스트
  INSERT** 를 남긴다(실측 14행, 회수 경로 없음). 루프가 삼키는 것은 **`bakeGhost` 실패뿐**이고,
  내 매치 생성 실패는 그대로 올린다(4R blocker). 계약 = `ownDeckProblemIsReportedAsDeckProblemNotNoOpponent`.
- **후보는 여러 명 시도한다**(`start` 의 shuffle + 루프). 한 명만 뽑으면 그 사람의 덱이 검증에 걸릴 때
  (트레이드로 넘긴 선수가 `deck_slots` 에 남는 등) 공격자에게 **남의 덱 오류**가 "덱이 유효하지
  않습니다"로 표시된다.
- ⚠️ **계약이라 부르려면 변이체로 확인해라**(독립검증 BL-2). 초판의 "고스트 박제" 테스트는 `PUT /api/deck`
  만 호출해 **어차피 참인 명제**를 검증했고(박제를 통째로 제거해도 통과), "정산 멱등"은 `clockSweeper`
  가 FINISHED(`phase_ends_at IS NULL`)를 고르지 않아 **단언이 no-op** 였다(멱등 제거해도 전 스위트
  통과). 지금은 재-bake 경로와 `settle` 재호출을 각각 실제로 태운다.
- ⚠️ **`/api/away/*` 와 `/api/me/away-reports*` 는 openapi 에 아직 없다** — `docs/**` 가 이 세션의
  owned-glob 밖이라 매니저 조율 대기(`/api/growth/*` 와 같은 상태). 그때까지 **계약 SoT 는 이 문서**다:
  - `POST /api/away/matches` **바디 없음**(상대는 서버가 고른다) → 201 MatchDetail · 404 `NO_OPPONENT` ·
    409 `MATCH_IN_PROGRESS`. ⚠️ 클라가 `defenderId` 를 보내도 Spring 기본이 미지 필드를 무시하므로
    **에러 없이 무작위 상대**가 나온다 — 문서에 `{defenderId?}` 라고 적으면 그게 먹히는 줄 안다(3R m6).
  - `GET /api/me/away-reports?status=unseen|all` → `{reports[], summary{matches,opponents,wins,draws,
    losses,goalsFor,goalsAgainst,ratingDelta}, rating, unseen}` (**집계는 서버가 계산** — 클라 복제 금지)
  - `POST /api/me/away-reports/ack` `{ids?}` → `{acked}` (멱등: `seen_at IS NULL` 로 대상을 좁힌다)
  - additive: `GET /api/me` 에 `rating`, `MatchDetail` 에 `ownerName`(**매치 생성자** 닉 — 관전자가
    양 팀을 자기 기준으로 오인하지 않게)
    - ⚠️ **`ownerName` 은 "홈"이 아니다**(#322). 한때 여기에 *"홈=매치 생성자 닉"* 이라고 적혀
      있었고 web 이 그 말을 계약으로 믿어 `homeName = ownerName` 을 박았는데, **리그 어웨이
      라운드는 생성자가 away 사이드**다(`MatchOrchestrator.userIsHome` — 픽스처 `home_team` 이
      계약, 2026-07-19). 그래서 어웨이 라운드 화면이 통째로 뒤집혔다(스코어·로그 팀 라벨·좌우.
      라이브 리그 20경기 중 7건 · **어웨이 라운드를 치른 유저 3명 전원**). 문서 한 줄이 만든 버그다.
    - 사이드가 필요하면 **`MatchDetail.homeName`/`awayName`**(#322 additive) — 사이드 라벨 그대로다.
      불리언 하나(`userWasHome`)만 주지 않는 이유: 클라가 이름을 다시 배치해야 하고 그 해석이
      관전자 경로(홈이 공격자다)에서 또 갈린다. **이름을 배치해서** 보내면 추론할 것이 남지 않는다.
      계약 = `MatchSideNamesTest`(연습 무회귀 + **어웨이 픽스처 표본** — 기존 매치 테스트는 전부
      유저=홈이라 이 결함을 구조적으로 관측할 수 없었다).
### 원정 v2 (hero 3차 컨펌 2026-07-29, V22)

- **상대 2택**(E2): `GET /api/away/candidates` 가 레이팅 비슷한 **2명**을 제시하고 그 목록을
  `away_offers`(유저당 1행)에 **서버가 저장**한다. `POST /api/away/matches {defenderId}` 는 그 안에서만
  수락한다. ⚠️ 이 저장이 없으면 "2택"이 곧 **지목**이고, 부계정 반복 지목 = 레이팅 무한 생성이다
  (4R MAJ-4 가 막은 경로). 새로 뽑으면 이전 제시는 무효 — 리롤로 후보를 쌓지 못한다. TTL 있음.
- **밴드 매칭**(E3): 내 레이팅 ±`rating-band` 에서 먼저 고르고 **부족하면 단계적으로 넓힌다**.
  인원이 적을 때 밴드만 고집하면 "상대 없음"이 되는데 그게 매칭 실패보다 나쁘다.
- **연승**(E4): 승 +1 · 패 0 · **무는 유지**. ⚠️ **내가 친 경기에만 걸린다**(hero 확정, 구 대칭 규칙
  대체) — 방어는 내가 고른 플레이가 아니므로 방어 성공이 연승을 올리지도, **방어 실패가 연승을 깨지도**
  않는다. 자는 사이 남이 쳐서 연승이 끊기면 그건 유저가 어쩔 수 없는 이유로 잃는 것이다.
  보너스도 공격자에게만 붙는다(방어 레이팅은 ±10 그대로).
  보너스 = `(streak-1) × bonus-per-win`, 상한 있음(없으면 장기 연승이 밴드를 뚫고 달아난다).
- ⚠️ **시각은 전부 ISO-8601 로 쓴다.** V22 가 SQLite 기본 `datetime('now')`(`2026-08-04 16:07:20`)로
  시즌을 심었더니 `Instant.parse` 가 터지고, 스위퍼가 그 예외를 삼켜 **시즌이 영원히 안 닫혔다**
  (보상 0·초기화 0·다음 시즌 0인데 500 도 안 난다 — 독립검증 blocker). 읽기는 두 포맷 다 받되
  (`AwaySeasonService.parseTime`) 쓰기는 ISO 로 통일한다.
  그리고 **시각 비교를 문자열로 하지 마라** — ISO 는 소수초가 붙으면(`…00.123Z`) 안 붙은 값(`…00Z`)
  보다 작게 정렬된다('.' < 'Z'). SQL 에선 `datetime()` 으로 정규화해 비교한다.
- **주간 시즌**(E5): `away_seasons` 가 **행으로** 존재한다. "지금이 몇 주차인가"를 시각에서 파생하면
  서버가 꺼져 있던 주가 통째로 건너뛰어 보상이 사라진다 — 마감은 `ends_at` 지난 ACTIVE 행을 닫는
  방식이라 늦게 켜도 **밀린 시즌이 순서대로** 정산된다. 마감 = 순위 스냅샷(`away_season_results`,
  PK 가 멱등) → 보상 → **레이팅·연승 0** → 다음 시즌 오픈, 전부 한 트랜잭션.
- **보상**(E6/E7): 금액 곡선은 **리그 한 판과 같다**(`hmb.away.reward.mode: league`).
  ⚠️ economy 에 `away` 키를 새로 만들지 않고 리그 곡선을 **참조**한다 — `data/**` 는 이 모듈 소유가
  아니고, "리그와 같게"는 값 복제가 아니라 참조로 표현해야 값이 바뀔 때 같이 따라간다.
  **수비자도 받는다**(hero: "덱 세팅 잘해두면 돈이 들어오고, 지면 남 좋은 일만") — 패배는 0
  (`defender-on-loss: false`). 공격자 보상은 매치 정산이 이미 주므로 `settle` 에서 또 주면 이중 지급이다.
- **담합 방어는 밴드 매칭 자체다**(hero 4차 판정). 수비자도 돈을 받으므로 두 계정이 서로 원정을
  주고받으면 양쪽이 이득 같지만, 매 판 **20점씩 벌어져**(승 +10 / 패 −10) 몇 판 만에 서로의 후보에서
  사라진다 — 담합이 진행될수록 담합이 불가능해진다.
  ⚠️ 이 논증은 **밴드가 유효할 때만** 성립한다. `rating-band` 를 크게 키우거나 "부족하면 전체" 폴백이
  상시화되면 이 방어가 사라진다. 밴드 값을 만질 땐 이 문장을 같이 봐라.
- **하루 원정 횟수 제한**(hero 결정, 세부는 세션 자율 확정 — hero 부재 중): `daily-limit: 10` ·
  리셋 **KST 자정** · 초과 시 **429 `AWAY_DAILY_LIMIT`**(used/limit 을 detail 에) · 남은 횟수는
  `GET /api/away/candidates.remainingToday` 로 **누르기 전에** 화면에 보인다(눌렀는데 거부 = 나쁜 UX).
  - **되돌리는 법**: `hmb.away.match.daily-limit: 0`(또는 env `HMB_AWAY_MATCH_DAILYLIMIT=0`) = 무제한.
    코드 변경·마이그레이션 없음. `-1` 을 받으면 web 이 표시를 생략한다.
  - **왜 KST 자정**: 컨디션 날짜(`hmb.match.condition.zone`)와 같은 기준. 다르면 "어제 것"의 의미가
    화면마다 달라진다.
  - ⚠️ 카운트는 **인스턴트로** 센다. `matches.created_at`(UTC)을 'yyyy-MM-dd' 와 문자열 비교하면
    경계가 UTC 자정이 되어 **한국 새벽 원정이 어제로** 세어진다(같은 종류의 시각-문자열 버그를 이
    세션에서 두 번 잡혔다).
- ⚠️ **참가도 순위도 같은 창으로 자른다.** 참가만 자르고 순위를 `user_ratings`(창 없는 누적)로
  매기면 밀린 주에서 **1주차 순위를 2주차 경기가 정하고**, 앞 시즌 마감이 레이팅을 0 으로 지운 뒤엔
  전원 동점이라 tie-break(`user_id` = ULID = **가입 순**)가 1등을 정한다 — 실측에서 **3패한 유저가
  1위, 3승한 유저가 2위**였다. 시즌 점수 = **그 시즌 창 안의 `rating_ledger` 합**.
  (참가는 `away_reports`, 점수는 `rating_ledger` — 무승부는 원장 행이 없으므로 참가하되 0점이다.)
- **몰수는 시즌·연승·재화에서 전부 빠진다**(hero A-1, V25 `away_reports.forfeit`). 경기가 열리지도
  않았는데 리포트가 남는다는 이유로 시즌 참가·연승이 되면, 두 계정이 서로 만들고 무르기만 해도
  **시뮬 0회·AI 0회로** 주간 순위 보상(1위 30k + 2위 20k)을 가져간다(레이팅은 상쇄돼 밴드 방어도
  안 걸린다). **레이팅 ±10 은 그대로** — 그게 무르는 쪽의 벌칙이고 hero D1 이다.
  ⚠️ 판정은 컬럼으로 한다. "0:0 인데 무승부 아님"이라는 **역추론은 화면 라벨용**이지, 보상 판정을
  파생 규칙에 걸면 결과가 하나 늘 때 조용히 오분류된다.
- **시즌 마감의 레이팅 리셋은 0 이 아니라 "다음 시즌 몫"**이다(독립검증 MAJ-1). 스윕이 5분 주기라
  `ends_at` 이후~마감 사이에 끝난 원정이 있고 그 델타는 다음 시즌 것이다 — 통째로 0 으로 밀면 그
  판이 **라이브 레이팅에서만** 사라져(보상 금액은 맞다) 시즌 축과 영구히 어긋나고 복구 경로가 없다.
- **몰수는 재화를 만들지 않는다**(`settle(..., payDefender=false)`). 경기가 열리지도 않았는데 리그
  승리 보상을 찍으면 두 계정이 서로 만들고 무르기만 해도 **시뮬 0회로 돈이 발행**되고, 레이팅은 서로
  상쇄돼 밴드 방어도 안 걸린다. 레이팅 −10 이 무르는 쪽의 벌칙이다(hero D1).
- **연승 갱신은 멱등 게이트 뒤**다. 앞에 두면 같은 매치 재정산이 연승을 1→4 로 부풀리고(리포트·원장은
  멱등이라 기존 계약이 못 잡는다) 그 오염이 **다음 진짜 승리의 보너스로 샌다**. 보너스는 미리 계산만
  하고(`peekStreakBonus`) 갱신은 기록이 실제로 새로 생겼을 때만(`commitStreak`).
- **참가 판정의 출처 = `away_reports` 를 시즌 창으로 자른 것**(공격자·수비자 양쪽, 상·하한 모두).
  ⚠️ 이걸 `rating_ledger` 로 물으면 **두 결함이 동시에** 생긴다 — 실제로 그렇게 만들었다가 두 번
  잡혔다:
  - **상한이 없으면** 밀린 시즌(창이 과거)을 닫을 때 그 뒤에 생긴 원장까지 참가로 잡혀 **아무도 안 논
    주에도 1~3위 보상**이 나간다(실측: 1판이 20만 포인트를 발행). 하필 "밀린 주를 순서대로 정산한다"가
    시즌을 행으로 둔 **존재 이유**인데 그 경로에서 금액이 틀렸다.
  - **무승부는 원장 행을 안 남긴다**(delta 0) → 비기기만 한 유저가 시즌에서 통째로 사라진다
    (참가상·스냅샷·히스토리 전부 0).
  둘 다 "레이팅이 움직였는가"로 "원정을 했는가"를 대신 물어서 생겼다. **묻는 것을 그대로 물어라.**
- **제시는 소모된다**(한 제시 = 한 경기). 남겨두면 TTL 동안 같은 상대를 반복 수락할 수 있고, 승패로
  레이팅이 벌어져 밴드를 벗어난 뒤에도 계속 고를 수 있다 = 밴드 방어의 두 번째 입구(MAJ-7).
- **후보 선정 출처는 `bandPool` 하나다.** 예전엔 "바디 없는 POST" 경로만 밴드 없는 별도 쿼리를 써서
  레이팅 10만짜리 상대가 걸렸다(MAJ-1) — 담합 방어의 근거인 밴드에 우회로가 있었다. 그 쿼리는
  **삭제**했다(남겨두면 다음 사람이 다시 쓴다).
- **제시는 세울 수 있는 팀만.** 2택은 폴백이 없으므로(고른 건 유저다) 덱이 깨진 상대를 제시하면
  유저가 고르는 순간 "선발이 11명이 아닙니다"가 뜨고 화면은 그걸 **자기 덱 오류**로 그린다(MAJ-8).
- **리포트의 `rating_delta` = 실제 적용값**(연승 보너스 포함). 기본 ±10 만 박제하면 "적용값을 박제한다"는
  선언을 처음부터 어기고 팝업의 레이팅 합계도 틀린다(MAJ-3).
- 계약 = `AwayV2Test`(2택·제시 밖 거부·제시 소모·TTL·리롤 무효화·밴드·연승 3절[무 유지/상한/수비 대칭]·
  적용값 박제·수비 보상 유무·시즌 마감 멱등[같은 시즌 재마감]·연승 초기화) + `AwayRaidTest`(리그 보상 곡선).
- 계약 = `AwayRaidTest`(상대가 실유저인지 · 고스트 박제 · 정산/멱등 · 팝업 조회/ack · **수비자는 읽기만**).

## 홈 개편 W4 — 복수 큐 · 랭킹보드 2종 · 모드별 전적 (#286 / #319)

계약 SoT = `docs/plan-v5/home-nav.md` §4~§5 + **`apps/web/src/api/hooks-p286.ts`**(web W5 가 먼저
머지돼서 실제 소비자 타입이 정본이다). openapi = `docs/plan-v3/api/openapi-v2.yaml`(이번에 편입).

### ⚠️ 복수는 V22 가 닫아 둔 문을 좁혀서 다시 여는 기능이다

`away_offers` 주석이 지목 원정을 **어뷰징 경로**로 명시하며 닫았다 — 클라가 상대를 고르면 부계정을
반복 지목해 레이팅을 무한 생성할 수 있다(4R MAJ-4). 복수는 그 문을 세 조건으로 좁혀 연다:
**①그가 실제로 나를 쳤다는 원장 행이 있을 때만 ②기록당 2회 ③최근 5건만 산다.**

- **세 조건 전부 POST 경로에서 검사한다**(`AwayService.startRevenge`). 특히 ③ — "최근 5건"을 표시
  상한으로만 두면 목록에서 밀려난 오래된 부계정 침공까지 되살려 지목할 수 있다(→ 410 `REVENGE_EXPIRED`).
- **`from_revenge` 컬럼(V34)이 "복수의 복수는 없다"를 구조적으로 지킨다.** 내가 갚아서 이기면
  **상대 쪽에 새 `away_reports` 행**이 생긴다(그가 수비자) — 표식이 없으면 그게 그의 복수 큐에
  들어가 둘이 무한히 주고받는다. 큐 필터(`from_revenge = 0`)는 **LIMIT 앞에** 건다: 이 행들이
  슬롯을 먹으면 핑퐁 한 번에 진짜 침공 기록이 창 밖으로 밀린다.
- **소모는 생성이 아니라 정산 시점**이다(승=`AVENGED` · 패=시도+1 · **무=횟수 안 씀**, hero 확정).
  그래서 `away_challenges.revenge_report_id` 로 매치→기록을 역참조하고, `settle` 의 **멱등 게이트
  뒤**에서 깎는다. 앞에 두면 재정산이 유저가 치지도 않은 판을 뺏는다(#245 가 연승에서 당한 형태).
  ⚠️ 몰수는 `attackerResult=LOSS` 라 **시도를 소모한다** — 만들고 무르기로 판정을 피하지 못한다.
- 에러 코드가 계약보다 3개 많다(`REVENGE_DEFENDED` 409 · `REVENGE_CHAINED` 409 · `REVENGE_EXPIRED` 410).
  §5 가 열거하지 않은 상태들이고, **각각 유저가 취할 행동이 다르다** — 합치면 "왜 안 되지"에서 멈춘다.
  없는 `reportId` 는 **403 `REVENGE_NOT_OWNED`** 로 합류시킨다(404 로 가르면 id 실재가 새어 나간다).
- 상대 덱이 지금 깨져 있으면 그 사유를 그대로 올리지 않고 **404 `NO_OPPONENT`** 로 바꾼다 —
  복수는 폴백이 없어서(상대가 정해져 있다) 남의 덱 오류가 화면에서 **내 덱 오류**로 그려진다
  (일반 원정이 `offerCandidates` 에서 미리 거르는 것과 같은 함정, MAJ-8).

### 원정 랭킹 = "지금 마감하면 나올 표"

`AwaySeasonService.standings(from, to)` **한 함수**를 시즌 마감(보상)과 라이브 보드가 같이 쓴다.
따로 집계하면 "1등으로 보였는데 보상은 3등"이 되고 그건 원장이 있어도 복구가 안 된다.

- 점수 = 시즌 창 안의 `rating_ledger` 합 · 참가 = 창 안의 **비-몰수** `away_reports`.
  ⚠️ `user_ratings`(창 없는 누적)로 매기면 참가 축과 어긋난다 — 실측에서 **3패한 유저가 1위**였다(MAJ-1).
  계약이 이걸 잡으려면 **창 밖 원장 행을 픽스처에 심어야** 한다(안 그러면 두 값이 우연히 같아
  누적으로 되돌리는 변이체가 살아남는다 — 실제로 그렇게 만들었다가 강화했다).
- 참가자가 아니어도 **404 를 내지 않는다**(`me.rank = null`). 신규 유저가 탭을 여는 순간 에러
  토스트를 보게 된다(#296 이 `/api/rankings` 에서 같은 결함을 고쳤다).

### 리그 랭킹 = 유저별 최신 시즌의 `computeStandings` 유저 행

정렬 = **디비전 asc → 승점 desc**(hero Q2) → 골득실 → userId. 승점을 SQL 로 다시 집계하지 않는다 —
`computeStandings` 가 승점·tie-break 의 SoT 인데 보드가 자기 집계를 가지면 **순위표와 랭킹보드가
다른 승점**을 말한다. 유저 수만큼 도는 대신 정의가 하나다(오픈베타 규모에서 수용 가능한 비용).
한 판도 안 치른 유저는 `entries` 에서 빠지되 `me` 는 **언제나** 자기 값을 받는다.

### `GET /api/me/record` — 출처는 `matches` 한 곳

⚠️ **`byMode.away` 는 내가 친 원정만이다.** 피침공(방어)은 `matches` 에 없다(그건 상대의 매치다).
섞으면 `overall ≠ Σ byMode` 가 되어 같은 화면이 두 말을 한다 — 방어 전적의 주인은 이미
`GET /api/me/away-reports.summary` 다. 승률은 **서버가 계산**한다(`wins / played`, 무승부는 승이
아니다 — `RankingService.winRate` 와 **같은 규칙**이라 두 화면이 다른 승률을 말하지 않는다).

### 리그 라운드 진행 (`season.currentRound` / `totalRounds`)

`currentRound` = 다음 SCHEDULED 유저 픽스처의 라운드(없으면 `totalRounds`). `totalRounds` =
**그 시즌 픽스처의 실제 최대 라운드** — 상수 18 을 싣지 말 것(디비전·시즌 구성이 바뀌면 어긋난다).
둘 다 이미 조회한 `fixtures` 에서 세므로 쿼리가 늘지 않는다. **web 은 둘 다 있을 때만 그린다**
(폴백 `?? 18` 을 두지 않기로 한 계약이라, 하나만 빠뜨리면 진행바가 조용히 사라진다).

### `DECK_REQUIRED` — 매치 생성 경로 **전용**

⚠️ **`DeckService.getActiveDeck` 을 고치지 마라.** 그 메서드는 `GET /api/deck` 도 지나가는데
거기서의 404 는 **정상**(새 유저 = 빈 덱)이고 web 의 `useDeck` 은 404 만 `null` 로 정규화한다 —
공용 조회를 400 으로 바꾸면 "덱이 없다"가 "아직 모른다"로 읽혀 **덱 없는 유저 가드 3층이 통째로
뒤집힌다**. 전용 메서드 `requireActiveDeck` 이 매치 생성 3경로(+ 원정/복수의 자기 덱 게이트)에서만
`400 DECK_REQUIRED` 를 던진다. 계약 = `DeckRequiredCodeTest`(**양방향** — 생성은 새 코드, 조회는 무회귀).

### ⚠️ 시도는 **생성 시점에 원자적으로 예약**한다 (독립검증 BL-1)

앞의 검사들은 전부 read-then-act 라, 예약이 없던 판에서는 같은 `reportId` 로 **동시에 6번 POST 하면
6판이 전부 생성됐다**(실측). "기록당 2회"가 통째로 뚫린 것이고, 복수는 **내가 상대를 고르는 유일한
경로**라 경합 한 번이 곧 약한 부계정 상대로 1버스트 N판이 된다.

- 자물쇠 = `UPDATE away_reports SET revenge_attempts = revenge_attempts + 1
  WHERE id=? AND revenge_attempts < ? AND revenge_state <> 'AVENGED'` 의 **갱신 행 수**.
  0행이면 다른 요청이 이미 마지막 시도를 가져갔다 → 429.
- **무승부는 정산에서 환불**한다(`refundRevenge`). 예약을 미루면 원자성이 사라지고, 예약을 안 하면
  자물쇠가 없다 — "먼저 잠그고 무승부면 돌려준다"가 hero 확정 Q3-① 과 원자성을 **둘 다** 지키는
  유일한 순서다. 매치 생성이 실패해도 환불한다(예약은 자물쇠지 벌칙이 아니다).
- 정산에 도달하지 못한 매치는 **경로에 따라 갈린다**: 자발적 무르기(BRIEFING)는 몰수 정산이 돌아
  소모되고, **사고 회수는 돌려준다**(아래 불릿). ⚠️ 한때 여기 "사고도 소모된 채 남는다, 그게 옳다"고
  적혀 있었고 그 문장이 **서버 장애가 유저의 도전 기회를 먹는 동작을 정당화**하고 있었다(2R BLOCKER-1).
- **예약과 매치 생성은 한 트랜잭션**이다(3R minor-3). 갈라 두면 예약만 커밋된 채 프로세스가 죽는 창이
  남는데, 그 상태엔 도전장 행이 없어 사고 환불조차 회수하지 못한다 = **복구 경로 없는 시도 손실**.
  `TxRunner` 가 PROPAGATION_REQUIRED 라 안쪽 `createAwayMatch` 가 합류한다(쓰기 락은 둘 → 하나).
- ⚠️ **사고 회수는 시도를 돌려준다**(`refundAccidentalRevenge`, 2R BLOCKER-1). 예약이 생성 시점이라
  정산이 돌지 않는 경로(FAILED · 멈춘 생성 · 시계 멈춤 · 스톨 스윕)에서는 유저가 **한 판도 못 치른 채**
  기록이 소진된다. 같은 함수가 바로 그 자리에서 레이팅은 면제하면서(*"서버 장애가 유저 레이팅을 깎으면
  안 된다"*) 도전 기회만 청구하면 자기모순이다. 리롤 우려는 없다 — 자발적 무르기는 **BRIEFING 뿐**이고
  그건 몰수 정산이 돌아 정당하게 소모된다. 멱등 장치 = 환불 후 도전장의 복수 링크를 끊는 것.
- ⚠️ **플랫폼 잠금 자체는 아직 샌다**(#333) — `MatchLockService.assertCanCreateMatch` 도
  read-then-act 라 연습·리그·일반 원정은 동시 요청에서 여전히 여러 판이 생긴다. 그래서 계약도
  "성공 1건"이 아니라 **"상한 이하"** 로 건다(남의 결함으로 거짓 실패하지 않게).

### ⚠️ 창은 AVENGED 필터 **앞에서** 자른다 (독립검증 MAJ-1)

`AVENGED` 를 제외한 뒤 LIMIT 을 걸면 **갚을 때마다 슬롯이 하나 비어** 더 오래된 기록이 되살아난다 —
부계정이 20번 쳐 뒀으면 5개가 아니라 20개 전부가 순차적으로 지목 대상이 되고, 그러면 "최근 5건"은
창이 아니라 **필터**일 뿐이다. 실측으로 잡혔다(최신 1건을 갚으니 창 밖이던 가장 오래된 기록이
410 → 201). `revengeWindow(userId, includeAvenged)` — POST 의 조건 ③ 검사는 창 전체를, 화면 목록은
거기서 AVENGED 를 뺀 것을 쓴다.

### 랭킹보드는 남의 데이터 사고에 격리돼 있어야 한다 (독립검증 MAJ-2)

`GET /api/league` 는 자기 시즌만 파싱해 블라스트 반경이 1명이었는데, 랭킹보드는 **전 유저를
순회**하므로 남의 `teams_json` 이 깨져 있으면 **내** 요청이 500 이 됐다(실측). 루프 안
`try/catch → skip + warn`. 전 유저 팬아웃 코드를 새로 쓸 땐 이걸 먼저 봐라.

### 계약
`AwayRevengeTest`(25) · `HomeNavBoardsTest`(14) · `DeckRequiredCodeTest`(4). **규칙 하나당 표본 하나**로
태운다 — 축이 다른 규칙을 한 픽스처에 겹치면 앞 분기가 뒤를 덮어 계약이 공허하게 통과한다(web W5 가
`WIN` + `AVENGED` + `attemptsUsed:1` 을 한 행에 뭉개 실제로 당했다). 변이체 **30종** 확인(사망 29 · **등가 1**).

⚠️ **등가 변이 1건을 숨기지 않고 적어 둔다**: `refundRevenge` 의 `<> 'AVENGED'` 조건은 지워도
아무 테스트가 죽지 않는다 — `AVENGED` 가 조회·POST·표시 세 곳 모두에서 시도 수보다 **먼저** 단락돼
관측이 안 되기 때문이다. 방어적으로 남겼고 그 사실을 해당 javadoc 에 명시했다. **"변이체가 죽었다"와
"이 줄이 계약으로 지켜진다"는 다른 말**이고, 후자를 주장할 수 없을 땐 그렇게 적어야 한다.

⚠️ **독립검증이 잡은 "공허한 계약" 3건을 기록해 둔다** — 같은 함정이 다음에도 온다:
- **hero 확정 규칙에 표본이 없었다.** 리그 랭킹의 "디비전 우선"(hero Q2)은 픽스처의 두 유저가
  **같은 디비전**이라 1차 키가 한 번도 관측되지 않았다 → 디비전 비교를 상수 0 으로 바꿔도 전
  스위트가 통과했다. 지금은 **승점이 반대로 가는** 표본(상위 디비전이 승점은 더 낮다)을 쓴다.
- **폴백 분기에 계약이 없었다.** `currentRound` 의 "시즌 완주 시 = totalRounds" 와 `me.total` 의
  "전체 인원 ≠ 페이지 크기" 둘 다 픽스처가 그 조합을 안 만들어 변이체가 살아남았다.
- **우연한 일치가 계약을 덮었다.** 원정 랭킹은 갓 시작한 시즌에선 누적과 시즌 창 합이 같아서,
  창 밖 원장 행을 픽스처에 심어야만 변이체가 죽는다.
- **수습이 계약을 공허하게 만들었다**(2R MAJOR-1). 소모를 정산 → 생성으로 옮기자 `settle` 의 LOSS
  분기가 no-op 이 됐는데, "재정산해도 두 번 깎이지 않는다" 테스트는 그대로 남아 **아무것도 하지 않는
  코드를 두 번 부르고** 통과했다. 구현을 옮길 땐 **그 구현을 태우던 계약이 아직 뭘 태우는지** 다시 봐라.
- **멱등을 "한 번 더 불러 본다"로 검사하면 안 된다**(2R 후속). 스위퍼는 ABANDONED 를 다시 고르지
  않으므로 두 번째 호출이 **일어나지 않았다** — 멱등 장치를 통째로 지워도 통과했다. 장치를 태우려면
  **직접 두 번** 불러라.
- **안전 논거가 걸려 있는 자리에 표본이 0이었다**(3R major-1). "복수는 리롤 문을 열지 않는다"는
  결국 `forfeitIfVoluntaryAwayAbandon` 안에서 **사고 환불이 BRIEFING 검사 뒤에 있다**는 순서 하나에
  걸려 있는데, 그 한 줄을 앞으로 옮기는 변이체가 **121 테스트를 통과**했다(무한 리롤 + 복수의 복수
  체인이 동시에 열리는데도). **문서에 "이래서 안전하다"고 쓴 문장마다 그 문장을 깨는 표본이
  있는지 확인해라** — 논거는 주석이 아니라 계약이 지킨다.

## 잠재 리롤 — 구매 단계 없음 (#247)

- **다이스는 사는 물건이 아니다.** `POST /api/growth/dice` 가 롤과 **같은 트랜잭션에서** 지갑을
  직접 깎는다(`GrowthService.chargeRoll`). 검사 순서 = **잠금(2★) → 잔액 → 결제** — 못 하는 일에
  먼저 돈을 받지 않는다. 실패는 항상 둘 다 없던 일이 된다(돈만 나가는 상태가 없다).
- **은퇴한 것**: `POST /api/shop/dice`(구매) · `GET /api/growth/dice`(재고 잔액) · `INSUFFICIENT_DICE`.
  부족 코드는 이제 `INSUFFICIENT_POINTS`/`INSUFFICIENT_GEMS` 이고 문구는 `economyService.currency(...).name()`
  + `Josa` 로 만든다(#232). 응답의 `diceLeft` 자리는 `wallet{points,gems}` 가 대신한다.
- **가격 SoT 는 그대로** `economy.dice.{normalCost,cashGemCost}` → `/api/config#shop.dice`.
  **키·값 무변경**이라 기존 economy override 는 재작성 없이 유효하다. 값 조정은 무배포(override+reload).
- **원장 사유는 `'dice'` 유지** — 소비의 의미(잠재 리롤)는 안 바뀌었다. 갈아치우면 기존 원장과 집계가 갈라진다.
- 기보유 재고는 **소각**(hero 확정). 되돌릴 수 없으므로 **V25 `dice_burned` 에 소각 시점 잔량을 박제**했다
  — 보상 요구가 오면 그 표가 유일한 근거다(가격은 override 로 바뀔 수 있어 사후 재계산이 성립하지 않는다,
  `starter_grants` 와 같은 원칙). `user_dice`/`dice_rolls` 는 **드롭하지 않았다**(V10 선례, 코드 참조만 제거).
- ⚠️ `packages/shared/src/growth.ts` 의 `DiceBalance`·`DiceBuyResult`·`DiceRollResult.diceLeft` 는
  **아직 구 계약**이다(shared 는 프리즈 조율 대상이라 이 웨이브에서 손대지 않았다). 런타임 소비자는
  없지만(Java 서버·web 손미러) 그걸 읽고 `diceLeft` 를 되살리지 마라 — 은퇴가 정본이다.
## 시즌 종료 보상 (#251)

- **젬(Z)은 완주하면 전원 받는다** — `league.gemReward` = `{completion, rankBonus{1,2,3}}` 고정액,
  `amountFor(rank)` = 완주 기본 + 순위 보너스(1등 9,000 / 2등 6,000 / 3등 4,000 / 4등 이하 3,000).
  #212 의 "우승만 [min,max] 랜덤"을 **대체**했다(hero 컨펌) — 얹으면 1등 총액이 요구와 어긋난다.
  랜덤이 없어졌으니 시즌 seed RNG 도 쓰지 않는다(고정액 = 그 자체로 결정론).
- **P(G) 보상 경로는 무변경** — `point_ledger 'league_reward'`(league.v1 rewards) 그대로.
- **소급이 없는 이유가 곧 멱등의 이유다**: 원장 reason(`league_gem_reward`)·ref(`seasonId`)를 그대로 뒀다.
  이미 지급된 시즌은 행이 있어 재진입해도 아무 일도 안 일어난다 = 구 금액이 그대로 남는다(의도).
- ⚠️ **`rankBonus` 는 순위표 통짜 교체다** — 순위별 병합이 아니다(currencies 의 코드별 병합과 다르다).
  `{"1":7000}` 만 적으면 2·3등 보너스는 **사라진다**. 표는 한 덩어리 곡선이라 **전체를 적어라**.
  계약 = `EconomyLegacyFallbackTest.rankBonusTableIsReplacedWholesaleNotMergedPerRank`.
- ⚠️ **override 트랩**(#232 에서 겪은 형태): 운영 override 는 무배포로 얹힌 **구 스냅샷**이라 새 필드가
  없다. 그래서 파싱이 **두 필드 단위 폴백**(`DEFAULT_LEAGUE_GEM_REWARD`)이고,
  소비도 `economyService.leagueGemReward()`(economy 파일 자체가 없어도 값을 준다)로 읽는다.
  "모르면 0원"이면 override 가 깔린 환경**에서만** 보상이 조용히 사라진다 — 테스트 환경에선 안 보인다.
  계약 = `EconomyLegacyFallbackTest`(구 모양 블록 무시 + 폴백 + 발행값), 경계 =
  `LeagueApiTest.seasonGemRewardMatchesRankBonusAcrossRankBoundaries`(1/2/3/4/5등).
- ⚠️ **테스트 픽스처(`fixtures/economy.v1.json`)의 금액은 발행물과 일부러 다르다.** 같게 두면 지급이
  config 를 읽든 코드 폴백 상수를 쓰든 관측값이 같아서 **"config 를 무시하는" 변이체가 전 스위트를
  통과한다**(독립검증 MAJOR-1 — 실제로 지급점을 상수로 바꿔도 654/654 green 이었다). 발행값 검증은
  `publishedEconomyCarriesTheConfirmedSeasonGemAmounts` 가 따로 한다 — **"config 를 읽는가"와 "폴백이
  도는가"를 서로 다른 파일로 분리**해라. economy 에 새 수치를 넣을 때마다 같은 함정이 재발한다.
- ⚠️ **순위 경계 테스트는 표를 직접 세운다**(`buildFinishedTableWithUserRank`). 유저 승수를 훑어
  원하는 순위가 나오길 기다리면 봇 전력이 시즌 seed 에 달려 있어 **실행마다 결과가 달라진다**
  (실제로 rank 2 가 안 나와 깨졌다). 경계 검증을 우연에 기대지 마라.

## 리그 디비전 난이도 사다리 (#252)

상대 강도의 **유일한 결정 지점**은 `MatchOrchestrator.buildSelectData` 가 만드는 봇팀 `attributes` 다
(엔진은 `card.attributes` 만 읽는다). 그래서 난이도는 **엔진 무접촉**으로 정한다.
설계·실측 전문 = `docs/plan-v5/opponent-balance.md`.

- **사다리 = data 발행물이 SoT** (`league.v2.json divisions[]`): 디비전마다 봇 **선발 XI 등급 슬롯**
  (slot 0 = GK)과 미세 배율. 코드에 등급·파워를 적지 마라. 규칙(승급/강등 컷·디비전 수)만
  `application.yml hmb.league.division.*`.
- **시즌에 박제한다**(`league_seasons.division`). `users.division` 을 그때그때 읽으면 시즌 도중
  승급/강등이 반영돼 이미 치른 라운드와 남은 라운드의 상대 강도가 달라진다 = 순위표가 뜻을 잃는다.
- **표시 파워 = 실제 파워**: `teams_json.power` 와 `LeagueTeam.power` 는 **배율 적용 후** 값이다.
  봇전 간이결과(`expectedGoals`)도 같은 값을 쓰므로 두 경로가 자동 정합한다.
- **포지션은 포메이션대로** 채운다(`startingPositions`). 등급만 보고 뽑으면 선발 XI 의 평균 GK 수가
  디비전마다 1.11~**2.00** 으로 흔들려 **사다리가 단조롭지 않았다**(D2 승률 47.6% > D3 33.7%).
  골키퍼 둘이 필드에 선 팀은 등급과 무관하게 약하다 = 난이도가 로스터 추첨 운에 좌우된다.

### ⚠️ 사다리 끝에서는 컷을 **null 로 잘라** 보낸다 (독립검증 BL-1)

`nextDivision` 이 클램프하므로 **입문 디비전엔 강등이, 최상위엔 승급이 없다.** config 상수를 그대로
DTO 에 실으면 클라가 **서버가 하지 않는 전이를 화면에 단언**한다 — 신규 유저(전원 입문)가 18라운드
내내 없는 강등 위협을 보고, 최상위에서 우승하면 "한 단계 위로 갑니다"라는 거짓말을 본다.
`effectivePromoteCut`/`effectiveRelegateCut` 이 그 지점이다. **클라가 "1이나 10이면 끝이겠지"로
추측하게 만들지 마라** — 경계를 아는 쪽이 잘라 보내는 것이 계약이다.
계약 = `reportedCutsMatchWhatNextDivisionActuallyDoes`(사다리 전 구간에서 광고 == 실제 전이).

### 연습 봇 풀 — `bots.kind` (BL-1)

`bots` 표에는 **세 종류**가 산다: `seed`(bots.v*.json 임포트) · `league`(시즌 생성이 만든 봇팀) ·
`away`(원정 고스트 #245). **연습 매칭은 `seed` 만** 뽑는다(`pickRandom`) — 예전엔 표 전체에서 뽑아
라이브가 이미 **리그팀 45행 : 시드봇 3행**이었고(설계된 입문 상대가 뽑힐 확률 6.25%, 시즌마다 0으로
수렴) 원정 고스트(성장 스탯 박힌 실유저 덱)까지 섞였다.
명시 `botId` 우회는 `BotService.getSeed`(없는 봇과 같은 404)로 막는다.
⚠️ **`bots` 에 쓰는 경로를 추가하면 `kind` 를 명시해라** — 기본값 `'seed'` 는 연습 풀에 들어간다는 뜻이다.

### 승급/강등

시즌 FINISHED CAS 통과 경로에서 보상과 **같은 지점**(`awardSeasonRewards`)에 선다:
`walletService.apply`(G) → `awardSeasonGems`(#251, Z) → `applyPromotion`(#262).
`users.division` 이동은 **CAS**(`WHERE division = from`) — 유저가 이미 더 나아간 뒤 옛 시즌 훅이
늦게 돌면 진행도를 되돌리기 때문이다(단순 재호출은 `from` 이 시즌에 박제돼 있어 CAS 없이도 안전하다).
**롤백은 기능이 꺼지는 것**이다 — 사다리 표가 없으면 승급도 강등도 하지 않는다(예전엔 강등만 걸려
전 유저가 입문 디비전으로 흘러내렸다). 계약 = `LeagueDivisionRollbackTest`.

### 봇전 간이결과 — `power-divisor`

`120` 은 봇 파워 산포(라이브 실측 sd 126)에 비해 너무 작아 **봇 한 팀이 16경기에 승점 44점(2.75 ppg)**
을 쓸어갔다(실제 리그 우승은 2.2~2.4). 유저가 매치 승률 65% 를 찍어도 **우승 확률 14.6%** —
유저 경기를 아무리 쉽게 해도 리그 우승이 구조적으로 막혀 있었다. **400** 에서 2.19/0.63 ppg.
⚠️ 이 값은 봇 파워 **산포**와 짝이다. 사다리가 디비전 내 산포를 sd 25~60 으로 줄였으므로,
산포를 다시 키우면(등급 혼합 복귀 등) 이 값도 같이 봐야 한다.

## 공지 공개 API — 피드 + 단건 (#248 · #297)

공개(인증 불필요) 엔드포인트가 **둘**이다: `GET /api/notices/active`(홈 팝업 피드) ·
`GET /api/notices/{id}`(공유 딥링크 단건, #293). 응답 모양이 다르다 — 피드는 `{"notices":[…]}`
**객체**, 단건은 공지 **그 자체**(클라가 한 건을 그대로 팝업에 넘긴다).

- **인증 제외는 `WebMvcConfig.excludePathPatterns` 한 곳이 SoT이고, 엔드포인트 단위로 열거한다.**
  ⚠️ `/api/notices/**` 로 **뭉치지 마라** — 나중에 유저 스코프 하위경로(`/api/notices/{id}/read` 같은)가
  생기면 **조용히 공개된다**. 공개 목록이 길어지는 불편이 그 사고보다 싸다.
- 공개로 두는 근거(#232 `/api/config` 와 동일): 유저별 데이터 0 + **점검 공지는 로그인이 안 될 때
  가장 필요하다**. 공유 링크는 정의상 미로그인이 먼저 본다.
- **노출 경계는 `NoticeService.PublicNotice` 레코드 하나**를 피드·단건이 **공유**한다. 필드를 하나
  얹으면 두 계약이 **동시에** 깨진다 — 한쪽만 새는 길이 없다.

### 상태 → HTTP 코드는 **결정표**다 (hero 확정)

| 상태 | 코드 | |
|---|---|---|
| LIVE | **200** + 본문 | |
| EXPIRED · OFF | **410** | 앱이 "기간이 지난 공지입니다" 안내 후 로비 |
| SCHEDULED · DELETED · 없는 id | **404** | 존재 자체를 숨긴다 |

- ⚠️ **예약(SCHEDULED)이 410 이 아니라 404 인 이유**: 410 은 *"그 id 는 실재한다"* 를 흘린다.
  아직 공개 안 한 점검 일정·이벤트가 링크 한 줄로 먼저 퍼진다. 그래서 **없는 id 와 응답이
  바이트 단위로 같아야** 하고(404 메시지에 id 를 넣지 않는다), 계약이 그 **동등성**을 단언한다
  (`NoticeByIdStatusTest.scheduledIsIndistinguishableFromAbsent`). 코드만 404 로 맞추고 문구로
  존재를 흘리면 아무 소용이 없다.
- **판정은 `Notices.status(...)` 에서 파생시켜라.** 컨트롤러에서 기간·스위치를 다시 계산하면
  규칙이 피드·admin·딥링크로 갈라진다.
- 표를 `EnumMap` 으로 두고 **없는 키는 404 로 떨어뜨린다** — 분기문으로 흩으면 새 상태가
  `default` 로 흘러 **200 이 샌다**. "아직 아무도 판단하지 않은 상태"가 공개 응답이 되면 안 된다.
  계약 = `NoticeByIdStatusTest.everyStatusHasADecision`(상태를 추가하면 깨진다).
- ⚠️ **단건은 SQL 로 거르지 않는다.** 피드(`active()`)는 "보일 것만" 주면 되지만 단건은 *왜* 못 보는지를
  구분해 내려줘야 한다(끝남 410 vs 없음 404). 행을 그대로 읽고 판정만 위임한다.

> ⚠️ **자산 서빙도 이 목록의 일원이다**(#309): `GET /api/notices/assets/{id}` 가 세 번째 공개
> 엔드포인트다. `{id}` 패턴이 `assets` 세그먼트도 매칭하므로 `/api/notices/assets`(id 없이)는
> **없는 공지와 같은 404** 를 받는다 — 존재를 흘리지 않아 그대로 둔다. 자산 패턴도 `assets/**` 가
> 아니라 `assets/{id}` 로 적는다(위 "엔드포인트 단위로 열거" 규칙과 같은 이유).

## 공지 이미지 업로드 — 무배포 운영 (#309 W1)

공지 **텍스트**는 #248 로 이미 무배포였는데 **그림만 웹 배포에 묶여** 있었다(`apps/web/public/notice/`
커밋 → CF Pages 재배포). 이제 admin 이 올리면 서버 볼륨에 저장되고 공개 경로로 서빙된다.
설계·결정표 = `docs/plan-v5/ops-content.md`.

- **바이트는 볼륨, 메타는 DB**(V30 `notice_assets`). 보관소 기본값이 **SQLite 파일 옆**
  (`hmb.notice.asset.dir` 비우면 `dirname(hmb.db.path)/notice-assets`, 도커 = `/var/lib/hmb`).
  볼륨을 하나로 유지해 **백업 대상이 하나**가 되게 한다 — 갈라 놓으면 DB 만 복구된 상태에서
  공지 본문은 멀쩡히 남아 깨진 그림을 가리킨다.
- ⚠️ **삭제가 없다. 내리기는 `active` 스위치뿐**(hero 확정 2026-07-30). 삭제는 오조작이 곧 영구
  소실이고 참조하던 공지의 그림을 되살릴 방법이 없다. 끄면 서빙 404, 켜면 같은 바이트가 돌아온다.
  "정리 기능"을 이유로 DELETE 를 추가하지 마라 — 계약이 그 문을 막는다
  (`NoticeAssetApiTest.thereIsNoDeleteEndpoint` + e2e `p309`).
- ⚠️ **타입 판정은 매직바이트다**(`NoticeAssetTypes`). 파일명 확장자도 클라 `Content-Type` 도
  업로드하는 쪽이 정하는 값이라, 확장자만 보는 구현은 **스크립트를 `.png` 로 이름만 바꾼 파일**을
  통과시킨다. **SVG 는 화이트리스트 밖**(`<img>` 로도 XSS 표면). 방어는 조합으로 성립한다 —
  고정 `Content-Type` + `nosniff` + SVG 제외. 매직바이트 단독은 polyglot 을 못 막는다(정직한 한계).
- ⚠️ **저장 파일명은 `{ULID}.{ext}`** — 업로드 이름이 경로에 도달하지 않는다. 경로 탈출을 차단
  규칙이 아니라 **구조**로 막는 방식이고, 원본 이름은 표시용으로 DB 에만 남는다.
- ⚠️ **응답 `url` 은 상대경로다**(`/api/notices/assets/{id}`). 절대 URL 을 주면 운영자가 본문에
  붙여넣고, 백엔드가 quick tunnel 뒤라 **주소가 바뀌는 순간 과거 공지 이미지가 전부 깨진다**
  (실적: deploy-log 2026-07-22·07-25). 서버가 자기 외부 URL 을 조립하려 들지 마라.
- **읽기/쓰기 빈이 갈라져 있다**: `NoticeAssetService`(공개) vs `AdminNoticeAssetService`(운영).
  `AdminRouteGuard` 가 admin 빈 의존 핸들러를 게이트 밖에서 **부팅 실패**로 막으므로, 공개 서빙
  컨트롤러가 admin 쪽을 한 번이라도 참조하면 서버가 안 뜬다. 방향은 항상 **admin → notice** 한 방향.
  새 admin 서비스는 `ADMIN_ONLY_BEANS` 에 시드해야 한다(`AdminGateTest` 가 누락을 잡는다).
- **공개 경로 인증 제외**: `/api/notices/assets/**` 는 `/api/notices/active` 와 같은 이유로 공개다 —
  여기에만 401 을 두면 **점검 공지가 글은 뜨고 그림만 깨진다**.
- 상한은 `hmb.notice.asset.max-bytes`(기본 2MB, env 로 무배포 조정). ⚠️ `spring.servlet.multipart`
  상한은 **더 넉넉하게** 둔다 — 그게 먼저 걸리면 요청이 우리 검증에 닿기도 전에 튕겨 운영자가
  이유를 모르는 에러를 본다.
- 계약 = `NoticeAssetApiTest`(바이트 왕복·공개 도달·이름 무관 저장·SVG/위장PNG/상한 거절·부수효과 0·
  스위치 왕복·삭제 부재·usedBy·원장).

## 유닛 아트 핫로드 + 회수 (#309 W2 · #210)

### ⚠️ 먼저: 유닛 **등록**은 이미 무배포였다

#309 실사 표는 "유닛 카탈로그 등록 = 재배포 필요"라고 적었지만 **사실이 아니다**. #207 파트 A 가
`POST /api/admin/units`(채번·스탯) · `PATCH` · `activate/deactivate` · `DELETE /override` ·
`GET /export` 를 이미 만들어 뒀고, `admin_locked` 가 부팅 시드 재임포트로부터 운영 변경을 지킨다.
**남아 있던 배포 의존은 아트뿐**이다 — 새 유닛을 등록해도 그림이 없으면 이니셜 폴백으로 뜬다.

### 아트 번들 (`/api/admin/chars/**` · 공개 `/api/chars/**`)

- **통짜 zip 1개**(V31 `char_bundles`). 아트는 셋이 서로를 참조한다 — 아틀라스 PNG · 매니페스트
  3종 · player-chars 매핑. 파일 단위로 올리면 "매니페스트는 새것, PNG 는 옛것"인 중간 상태가
  생기고 그때 화면은 **깨진 그림이 아니라 좌표가 어긋난 그림**을 그린다(아무도 못 알아챈다).
- **파이프라인은 로컬 유지, 산출물만 올린다**(#57 재발명 금지 — 이슈 명시 요구).
- **업로드 ≠ 활성화.** 올려서 요약(유닛 수·매핑 버전)을 확인한 뒤 켠다. 잘못된 아트가 확인 전에
  라이브로 나가면 되돌리는 동안 유저가 틀린 그림을 본다.
- **롤백이 기능이다.** 리비전을 쌓고 활성 포인터만 옮긴다. `revisionId=null` = 전부 끄기 =
  web 이 **웹 빌드에 구운 `/chars`** 로 돌아간다(= 이 기능이 없던 상태). 삭제 동사는 없다.
- ⚠️ **활성 최대 하나는 DB 가 강제한다**(V31 부분 유니크 인덱스). 코드로만 지키면 동시 활성화
  두 건이 "둘 다 active" 를 만들고, 그러면 서빙이 조회 순서에 달려 **새로고침마다 아트가 바뀐다**.
- ⚠️ **서빙이 `/api/chars/**` 인 이유는 CORS 다.** 매니페스트는 `<img>` 가 아니라 `fetch` 로 읽으므로
  CORS 가 실제로 필요한데, `CorsConfig` 는 `/api/**` 에만 등록돼 있다. `/chars/**` 로 내면 CORS 를
  새로 열어야 하고 그 결정이 조용히 잊힌다.
- ⚠️ **활성 번들이 없으면 `GET /api/chars/index` 는 404 다**(`200 {}` 아님). 성공 껍데기를 주면
  목·프록시·구 서버의 빈 객체와 구분이 안 돼 web 이 "아트 0개"를 정상으로 받아들이고 전 화면이
  **조용히** 이니셜 폴백이 된다.
- ⚠️ **`index()` 는 DB 만 믿지 않는다 — 파일 존재를 확인한다**(독립검증 MAJOR-2). 볼륨을 잃고
  DB 만 복원하면 행은 "REV2 서빙 중"인데 파일이 없다. 그때 200 을 주면 web 이 서버 base 를
  채택하고 매니페스트가 전부 404 가 되어 **구운 폴백으로 돌아갈 경로가 사라진다**(화면이 통째로
  이니셜). web 쪽에도 백스톱이 있지만(빈 번들이면 재폴백) **두 층 다 둔다**.
- ⚠️ **장기 캐시를 걸지 않는다**(5분). URL 에 리비전이 없어서(구운 폴백과 경로 모양을 맞춰야
  web 의 `assetUrl` 이 한 벌로 돈다) 장기 캐시는 "갈아끼워도 안 바뀐다"를 되살린다.
- zip 검증 = 경로탈출(`..`) 거부 **두 층**(이름 검사 + 해제 경로 재확인) · 해제 **후** 총 바이트/
  엔트리 수 상한(zip bomb 은 압축 크기로 못 잡는다) · 확장자 화이트리스트 + 이미지 매직바이트 ·
  매니페스트 4종 존재 **+ JSON 파싱까지** 전부 1단계(`CharBundleStorage.read` + 서비스의 `summarize`).
  통과한 뒤에야 `write` 가 디스크에 쓴다.
  - ⚠️ **파싱을 쓰기 뒤로 옮기지 마라**(독립검증 BLOCKER-1 이 정확히 그 상태였다): JSON 이 깨진
    번들이 "다 쓴 뒤 400" 이 되며 **최대 64MB 고아 디렉토리**를 볼륨에 남겼다. 회수 동사가 없는
    보관소라 영구 누수이고, **zip 을 몇 번 고쳐 올리는 것이 정상 사용 패턴**이라 드문 경로가 아니었다.
    계약은 DB 행이 아니라 **디렉토리 수**로 건다(`everyRejectionLeavesNothingOnDisk`).
  - ⚠️ 두 층이라 **한 층을 지워도 API 테스트가 통과한다**(변이체로 실측). 그래서 첫 번째 층에
    단독 계약(`chars/CharBundleEntryNameTest`)이 따로 있다.
- 계약 = `CharBundleApiTest`(서빙 왕복·공개 도달·리비전 교체·전부 끄기·zip-slip·zip bomb·위장 PNG·
  확장자·매니페스트 누락·JSON 깨짐·경로조작·게이트·원장) + `chars/CharBundleEntryNameTest`.

### 유닛 회수 — `POST /api/admin/units/{id}/purge` (#210)

- **거의 항상 409 다.** `players(id)` 를 참조하는 표가 여덟(`REFERENCING_TABLES`) — 누군가 한 번이라도
  뽑았으면 못 지운다(지우면 그 유저의 카드가 사라진다). 실질 범위 = **방금 만들어 아무도 손대지
  않은 유닛**. 그 밖에는 `deactivate` 가 정답이고, 409 문구가 그렇게 안내한다.
- **조회와 삭제가 한 트랜잭션**이다. 밖에서 세면 "0건 확인 → 그 사이 누가 뽑음 → 삭제"가 가능하다.
- **이력은 다른 액션과 같은 원장**(`admin_catalog_audit`, action=`unit_purge`) — `before` 스냅샷이
  남아 "무엇을 지웠나"에 답한다. 행이 남을 수 있는 근거는 그 표의 `player_id` 에 **FK 가 없다**는
  것이고 V14 가 일부러 그렇게 만들었다.
  - ⚠️ 처음엔 `admin_ops_audit`(V18)에 남겼다 — CHECK 확장이 **테이블 재작성**을 요구해서였다.
    그러면 **한 유닛의 이력이 두 곳으로 갈리고** 회수만 유닛 감사 조회에 안 나온다. hero 지시로
    **V32 가 CHECK 를 넓혀** 합쳤다. 재작성이 안전한 근거(데이터 무변환·트랜잭션 원자성·참조 표
    없음·**인덱스 4개 재생성**)는 V32 주석에 있다.
  - ⚠️⚠️ **인덱스는 넷이다**(V14 셋 + V15 하나). 초판이 V14 를 "둘"로 오독해
    `uq_catalog_audit_idem`(대상별 멱등)을 빠뜨렸고, **계약이 그 손실을 `containsExactly(3개)` 로
    박제**하고 배포 확인 커맨드가 "3이면 정상"이라 보고했다(독립검증 BLOCKER-1) — 고치려 하면
    테스트가 막는 상태였다. **인덱스를 세는 계약은 원본 마이그레이션을 직접 읽고 세라.**
    그 인덱스는 `update`·`deactivate`·`activate`·`override_reset` **4개 액션의 유일한 DB 백스톱**이다
    (앱의 `findAudit` 는 check-then-act 라 경합을 못 막는다). 빠지면 같은 멱등키 동시 PATCH 가
    감사 원장에 중복 행을 만들고 두 번째 행의 `before` 스냅샷은 이미 바뀐 상태라 **"무엇이
    바뀌었나"가 거짓이 된다**.
- ⚠️ **`players` 를 참조하는 표를 추가하면 `REFERENCING_TABLES` 에도 넣어라.** 빠뜨리면 회수가 그
  참조를 못 보고 지운다. `AdminUnitPurgeTest.referencingTablesListMatchesTheSchema` 가
  **스키마를 직접 읽어** 대조한다(코드가 아니라 — 구현과 검증이 같은 목록을 공유하면 둘 다 틀려도 통과).
- **회수한 번호는 다시 발급되지 않는다** — 회수가 `meta_kv.unit_id_high_water` 를 올리고
  `insertWithNextId` 가 그 수위를 함께 본다. 안 그러면 `MAX(players)+1` 이 비운 번호를 재사용해
  **새 유닛 상세에 회수된 유닛의 이력이 섞여 보인다**(이력을 한 원장에 합친 뒤엔 더 눈에 띈다).
  - ⚠️ **수위를 올리는 곳은 회수 한 곳뿐**이다(생성은 안 올린다 — 살아 있는 번호는 `players` 가
    이미 갖고 있다). 그래서 "이 키가 있다 = 회수된 번호가 있다"가 성립한다.
  - ⚠️ 채번은 여전히 **한 문장**이다(수위 조회가 INSERT 안의 서브쿼리). 별도 SELECT 로 떼면
    읽기→쓰기 승격이 되살아나 `SQLITE_BUSY_SNAPSHOT` 에 노출된다(#207 B1 이 그 문제였다).

## 우편함 — 배포 없이 보상 보내기 (#323)

운영이 **재배포 없이** 보상(카드·G·Z)+텍스트를 보내고, 유저가 [받기]를 누를 때 지급된다.
설계·운영 런북 = `docs/plan-v5/mailbox.md`(§8 이 curl 절차).

- **표는 둘, 원장은 0개 신설**(V33): `mail_campaigns`(발송 1건 = 본문·첨부·대상·만료가 여기 하나에)
  + `user_mails`(유저×캠페인, **상태만**). 지급은 기존 경로가 한다 — G=`point_ledger` ·
  Z=`gem_ledger` · 카드=`user_players`. 우편함이 자기 원장을 가지면 "이 유저의 골드가 왜 늘었나"의
  답이 두 곳이 된다. **여기에 새 지갑/멱등 메커니즘을 만들지 마라.**
- **수령 멱등은 2겹**: 상태 CAS(`claimed_at IS NULL`) + 원장 유니크(`ref_id = user_mails.id`,
  `reason='mail_claim'`). CAS 가 미래의 리팩터로 뚫려도 **돈은 두 번 나가지 않는다**.
  ⚠️ 유저의 더블탭은 **200 `applied:false`** 다(409 아님) — 같은 의도의 재전송이고, 실패로 보이면
  "받았는데 에러가 났다"가 된다. admin 멱등키 충돌(같은 키 다른 내용)만 409 다.
- **`has_attachments` 는 발송 시 확정되는 파생값**이다(payload 가 이후 안 바뀐다). 뱃지 수를
  **순수 SQL**로 만들기 위해 둔다 — 없으면 카운트 한 번에 전 행을 읽어 JSON 을 파싱해야 한다.
- **"아직 할 일"의 정의는 `MailService.ACTIONABLE` 문자열 하나**다. 뱃지 COUNT 와 목록이 같은
  조각을 쓴다 — 두 곳에 따로 적으면 "뱃지엔 1인데 열어 보면 할 게 없다"가 되고, 그 순간 유저는
  뱃지를 믿지 않게 된다(계약 = `MailboxApiTest.badgeMatchesTheList`).
- **만료는 유저 행에 스냅샷**한다(본문·첨부와 반대). 캠페인 만료를 나중에 당기면 이미 받아 든
  사람의 마감이 소급으로 짧아진다. 만료·회수는 **410**, 목록에는 `EXPIRED` 로 **남는다**(hero 확정 —
  놓쳤다는 사실이 보여야 한다) 대신 뱃지에는 세지 않는다.
- **회수는 미수령분만** 막는다. 이미 받은 지갑을 되감지 않는다 — 그건 `admin points` 차감 경로가
  할 일이고, 우편함이 두 번째 경로가 되면 "왜 줄었나"의 답이 갈라진다.
- **브로드캐스트 = 발송 시 팬아웃**(`hmb.mail.fanout-max` 넘으면 **거부**, 조용히 자르지 않는다).
  지연 구체화를 안 쓴 이유 = 목록·뱃지·수령의 읽기 경로가 두 소스로 갈라져 서로 다른 답을 낼 수
  있고, 보상 도메인에서 그 불일치는 곧 CS 다. 규모가 커지면 유저 API 형태 그대로 교체 가능.
- `audience='ALL'` = **발송 시점에 존재하는 유저 전원**(이후 가입자는 대상 아님).
- ⚠️ `AdminMailService` 는 `AdminRouteGuard.ADMIN_ONLY_BEANS` 에 시드돼 있다 — 게이트 밖으로 나가면
  **아무나 자기에게 재화를 발행**할 수 있다(이 목록에서 가장 직접적인 경제 표면).
- ⚠️ `/api/mails/**` 를 `WebMvcConfig` 인증 제외 목록에 넣지 마라. 공지는 유저 데이터 0인 방송이라
  공개지만 우편함은 정의상 **내 것**이다.
- ⚠️ **멱등 판정은 `request_hash`(요청 원문 해시) 하나다.** 필드를 하나씩 비교하면 **빠뜨린 필드가
  곧 구멍**이다 — 독립검증이 두 개를 뚫었다: ①대상을 인원 "수"로 비교 → 같은 키로 **수신자만 바꾼**
  요청이 200 으로 삼켜져 "보냈다고 믿는데 아무도 못 받는" 상태 ②만료를 **파생 절대시각**으로 비교
  → `expiresInDays` 재전송이 1초 차이로 409, 안내대로 새 키를 쓰면 **이중 지급**. 그래서
  `AdminMailService.requestHash` 는 **요청에 적힌 값**만 넣고(정렬된 userIds · 정규화한 expiresAt ·
  ALL 은 'ALL' 문자열), 무엇을 비교하는지가 그 함수 한 곳에만 있다.
- ⚠️ **`hmb.mail.campaign-list-max` 가 config 인 이유는 튜닝이 아니라 계약**이다. 상수로 박으면
  "단건 조회가 목록 창에 갇히지 않는다"를 검증하려고 캠페인 101건을 만들어야 하고, 그 비용 때문에
  결국 **어차피 참인 명제**를 검증하게 된다 — 2차 독립검증이 정확히 그 상태(`detail()` 을 목록
  스캔으로 되돌려도 841건 통과)를 blocker 로 잡았다. 테스트는 이 값을 1 로 낮춰 실제 조건을 만든다.
- ⚠️ **수령의 판정 조건은 전부 CAS UPDATE 안에 있다**(`claimed_at IS NULL` + 만료 + 회수).
  앞에서 미리 걸러 주면 ①더블탭 계약이 선검사만 태워 CAS 변이가 살아남고 ②"이미 받은 우편이
  나중에 만료"가 410 이 된다(이미 받은 사람에게 실패를 보이는 것은 설계 위반). 못 가져간 이유는
  **행을 다시 읽어** 구분한다.
- 계약 = `MailboxApiTest`(수령 4중 단정: 지갑·원장·보유풀·상태 / 더블탭 / 뱃지 관계식 / 만료 /
  수령 후 만료도 200 / 격리 404) · `AdminMailSendTest`(멱등 200·409 / **수신자만 바뀌면 409** /
  **상대 만료 재전송은 200** / 수신자 순서 무관 / 거절 부수효과 0 / 회수 / 회수 후 유저 목록 EXPIRED /
  감사(성공·실패·검증실패) / 목록 창 밖 단건 조회 / 게이트) · `MailFanoutCapTest`.

## 원정 데일리 미션 (#408)

하루(KST) 2개 · 14종 균등 추첨(중복만 금지) · **전부 원정 경기로만 판정** · 티어별 다이아
(쉬움 100 · 보통 200 · 어려움 300) · 미션당 리롤 1회. 설계·근거 = `docs/plan-v5/away-daily-mission.md`
(hero 확정 2026-08-02 §7 — **게임 수치·한글 문구는 hero 산출물이라 임의 변경 금지**).

- **표는 둘(V40), 원장은 0개 신설**: `daily_missions`(그날 미션 1개 = 1행) + `daily_mission_progress`
  (경기 × 미션의 진행 델타). 돈은 `gem_ledger`(`reason='daily_mission'`, `ref_id`=미션 행 id)로 나간다 —
  **여기에 새 지갑/멱등 메커니즘을 만들지 마라**(V33 우편함 규율: "왜 다이아가 늘었나"의 답이 두 곳이 되면 안 된다).
- ⚠️ **행 하나만 읽어도 표시·판정·지급이 완결돼야 한다.** 그래서 `title`·`rule` 까지 박제한다 —
  §6.3 이 "달성했는데 안 받은 보상은 **기한 없이** 남는다"이고 §9 롤백이 카탈로그를 줄이는 것이라,
  **카탈로그에서 사라진 미션의 미수령 행**이 반드시 생긴다. 그때 문구를 카탈로그에서 조회하면 빈 제목이
  뜨고, 판정 규칙을 조회하면 그날 남은 경기에서 진행도가 안 오른다.
- **리롤은 제자리 UPDATE 가 아니라 은퇴 + 새 행**이다(`rerolled_at` + **부분** 유니크 인덱스).
  UPDATE 로 하면 진행도 원장이 가리키는 행의 미션이 사후에 바뀌어 **지난 경기 결과 화면이 "그 경기가
  밀지도 않은 미션"을 그린다**. 리롤 소진은 별도 카운터가 아니라 **그 슬롯의 은퇴 행 수**로 센다.
- ⚠️ **훅은 `MatchOrchestrator.finishMatch` 에만 있다** — 그게 §6.5("포기는 진행도를 올리지 않는다")를
  **구조적으로** 보장한다. 자발 포기는 `forfeitIfVoluntaryAwayAbandon` 경로라 `finishMatch` 를 지나지
  않는다. 훅을 `awayService.settle` 안으로 옮기면 몰수도 세어져 "원정 3회"를 **만들고 무르기 3번**으로
  끝낼 수 있다(계약 = `MissionMatchFlowTest.abandoningAnAwayMatchInBriefingDoesNotAdvanceAnyMission`,
  변이체로 실측 사망).
- **금액은 economy(`mission.reward`), 카탈로그는 `application.yml hmb.mission.daily.*`.** 값의 성격이
  다르다 — 금액은 override+reload 로 **무배포** 조정하는 경제 곡선이고, 카탈로그(id·티어·판정규칙·목표·
  문구)는 게임 규칙의 **구조**라 판정 코드(`MissionRule`)와 같이 움직인다(#245 의 `away.reward.mode` 와
  같은 갈라짐). ⚠️ `mission.reward` 는 `rankBonus`/`bigSlots` 와 달리 **티어 단위 병합**이다 — 표가
  곡선이 아니라 독립된 세 가격이라, 쉬움만 올리려고 한 줄 적었을 때 나머지가 0 원이 되면 그건
  §9 가 금지한 "보상이 사라지는" 상태다. 폴백 = `DEFAULT_DAILY_MISSION_REWARD`(override 트랩).
- **롤백 = `hmb.mission.daily.count: 0`**(env `HMB_MISSION_DAILY_COUNT=0`). 설계 §9 의 "카탈로그를
  비우면"은 **YAML 리스트를 env 로 비울 수 없어서** 실제로는 재배포를 요구한다 = 롤백 수단이 아니다.
  금액을 0 으로 내리는 방식은 쓰지 않는다(미션은 뜨는데 보상이 0 = 고장으로 읽힌다).
- ⚠️ **결과 화면 `missions` 는 보는 사람으로 좁힌다.** `GET /api/matches/{id}/result` 는 원정 수비자
  에게도 열려 있어서(#245 `getViewable`) 매치 축으로만 조회하면 **공격자의 미션 진행도가 상대에게 샌다**
  ("권한 확대는 읽기냐 쓰기냐만이 아니라 무엇을 읽느냐도 좁혀야 한다" — #245 BL-1).
  ⚠️ #368 의 `dailyReward` 는 "원정 매치엔 칸 행이 없어 현재는 안전하다"였는데, **미션은 원정 축이라
  그 논거가 성립하지 않는다** — 좁은 사실에 안전성을 매달지 마라.
- **미션 생성은 조회 *또는* 정산 시점**(설계 §6.4 의 "첫 조회"를 넓혔다). 안 그러면 앱을 안 켜고 원정만
  친 유저의 진행도가 통째로 사라진다. 추첨이 시드 결정론(`sha256(userId:day:slotN)`)이라 어느 쪽이 먼저
  만들어도 같은 두 미션이다. **리셋 잡은 없다**(#368·#245 와 같은 lazy 원칙).
- 에러 코드가 계약보다 둘 많다: 410 `MISSION_EXPIRED`(지난 날짜 리롤 — `REROLL_USED` 로 뭉치면 거짓말) ·
  409 `MISSION_REROLL_UNAVAILABLE`(후보 고갈, 현행 config 에선 도달 불가). 없는 미션과 **남의 미션**은
  같은 404 다.
- ⚠️ **`/api/missions/**` 를 `WebMvcConfig` 인증 제외 목록에 넣지 마라** — 우편함과 같은 이유로 정의상 내 것이다.
- ⚠️ **마이그레이션 번호 이력**: V39 → **V40**. main 이 V38 을 #405 에, V39 를 #408 에 배정했는데
  #405 가 머지되며 **V38·V39 를 둘 다** 가져가서 옮겼다(아직 배포되지 않은 마이그레이션이라
  리넘버가 안전하다 — #248 이 V23→V25→V26 으로 두 번 옮긴 것과 같은 상황).
  그동안 `FlywayVersionContinuityTest` 에 두었던 **예약 목록**(`RESERVED_BY_OTHER_BRANCH`)은
  **제거했다** — 결번이 없어졌으므로 연속성 검사가 제 힘으로 선다. 예외 목록은 그 자체가
  사각지대라 필요가 끝나면 바로 지운다.
- ⚠️ **`data/players/economy.v3.json` 은 생성기와 갈라져 있다**(#408 이 만든 문제 아님). `generate.ts` 의
  `economyV3` 는 v2 를 복사할 뿐이라 **재생성하면 #251(`gemReward`)·#368(`dailyReward`)·#408(`mission`)이
  통째로 사라진다** — 그래서 `data.test.ts` 바이트 동일성 목록에도 economy.v3 이 없다. data 도메인 이슈 필요.
- ⚠️ **`claimableCount` 를 독립 쿼리로 세지 마라 — `daily()` 의 화면 데이터에서 파생시킨다.** W3 에서
  실제로 터진 갭이 이것이다: 합계는 **전 기간**인데 목록(`missions`)은 **오늘 것뿐**이라, 어제 달성하고
  안 받은 유저는 홈에서 "받을 보상 1건"을 보는데 원정 화면엔 받을 카드가 없었다 = §6.3(달성분 무기한)이
  **화면에서 도달 불가능**했다. 이제 `pendingClaims[]`(지난 날짜 달성·미수령, 오래된 것부터)가 같이
  나가고 합계는 `missions` 의 COMPLETED + `pendingClaims` 에서 **파생**한다 — 원본이 하나면 어긋날 수 없다.
  오늘 것은 `pendingClaims` 에 **넣지 않는다**(이미 `missions` 에 COMPLETED 로 있다 — 넣으면 같은 보상이
  두 장 그려지고 하나 받은 뒤 나머지가 409 를 뱉는다). 수령은 **같은 엔드포인트** — `claim` 은 날짜를
  보지 않는다(날짜를 보는 건 리롤뿐, 지난 미션은 410 `MISSION_EXPIRED`).
- ⚠️ **결과 화면 미션의 `state` 는 필수다.** 없으면 web 이 `progress >= target` 으로 재계산해야 하고
  **수령한 뒤에도 "받기"가 계속 보인다** — 실제로 W3 가 그래서 결과 화면 수령 버튼을 포기하고 안내
  문구로 우회했다. `settle()` 이 만드는 것과 `progressOf()` 가 읽는 것 **둘 다** 싣고, 판정은
  `stateOf()` 한 곳이 소유한다(조회·정산·결과 화면이 같은 규칙).
- ⚠️ **훅 계약은 "미션이 밀렸다"만으로 부족하다 — 호출부가 넘기는 *인자*까지 태워라**(독립검증
  minor-1/2). `MissionDailyTest` 는 `finishedAt`·`userHome` 을 **서비스에 직접 넘기므로** 호출자를
  한 번도 검사하지 않는다. 그래서 두 변이가 미션 계약 **55건 전부를 통과**했다: ①`clockService.now()`
  → `Instant.parse(match.createdAt())` — §6.1 이 **이름 붙여 경계한 버그**(자정을 넘겨 끝난 경기가
  어제 미션을 채운다)를 한 줄로 되살린다. 하루를 **빼는** 변이는 죽었으니 **"그럴듯하게 틀린 값"만**
  통과하는 상태였다 ②`userHome` → `!userHome` — 선제골 기준 사이드가 뒤집힌다.
  → `MissionFinishHookWiringTest` 가 **생성일 ≠ 종료일** 표본(주입 Clock 을 KST 자정 너머로 이동)과
  실제 경기의 선제골로 호출부를 태운다. **서비스에 아무것도 직접 넘기지 않는 것**이 이 클래스의 규율이다.
- ⚠️ 짝이 되는 서비스 계약도 같이 둔다 — `settleAnchorsToTheGivenFinishTimeNotToWhateverTimeItIsNow`.
  없으면 `dateOf(finishedAt)` → `today()` 변이가 **아무것도 죽이지 않는다**(유일 호출자가 `now()` 를
  넘겨 값이 같다) = **파라미터가 장식**인 상태이고, 재정산 도구·백필 같은 두 번째 호출자가 생기는
  순간 조용히 오늘 미션을 민다. "호출자가 무엇을 넘기나"와 "서비스가 그걸 쓰나"는 **다른 계약**이다.
- 계약 = `MissionDailyTest`(35: 카탈로그·추첨 커버리지·KST 경계·규칙 7종·멱등·박제·수령 4중·리롤 4종·
  발행값·경제 서열) · `MissionMatchFlowTest`(6: **훅**·포기·연습 무영향·수비자 미노출·인증·HTTP 모양) ·
  `MissionFinishHookWiringTest`(2: **호출부 인자** — 종료일 앵커·사이드) · `MissionRollbackOffTest`(2) · `EconomyLegacyFallbackTest`(폴백·티어 병합). **변이체 W1~W2 21/21 · W4 11/12 사망(등가 1 — 합계를 의미가 같은 독립 쿼리로 되돌리는 변이는 안 죽는다. 파생형의 값어치는 지금 값이 아니라 **드리프트 차단**이고, 드리프트를 실제로 만드는 변이 3종은 전부 죽는다) · W5 3/3 사망(호출부 시각·사이드 + 파라미터 권위 — **W4 의 등가 1건과 달리 이 셋은 계약을 더해 전부 죽였다**).**
  ⚠️ 초판에서 **3건이 살아남았다** — ①금액 계약이 테스트 헬퍼가 심은 행을 읽어 **생산 경로를 안 탔다**
  ②"달성 후 동결"이 DB 가드에 가려 응답의 틀린 값이 관측되지 않았다 ③"리롤 티어가 셋 다 나온다"가
  **어차피 참**이었다(원래 미션 티어가 이미 셋). 셋 다 계약을 고쳐 죽였고, 이 세 형태는 이 리포에서
  반복된다.

## 없는 경로는 404 다 (#335)

매핑 안 된 요청은 Spring 이 **정적 리소스 조회로 흘리고**, 거기서 난 `NoResourceFoundException` 이
포괄 핸들러에 걸려 **500** 이 됐다(실측 `GET /api/mails/{id}` → `500 "No static resource api/mails/…"`).
`GlobalExceptionHandler.handleNoRoute` 가 404 `NOT_FOUND` 로 매핑한다.

- **폭발 반경은 `/api` 가 아니라 전역이다**(독립검증 minor-5): `/` · `/favicon.ico` · `/index.html` ·
  `/actuator/health` 도 500 → 404 가 됐다. 전부 바람직한 방향이고, springdoc 은
  `api-docs.path=/internal/openapi-generated` + `swagger-ui.enabled=false` 라 실 서빙 경로가 없다.
- ⚠️ **아직 남은 것**: 405(메서드 불일치)·415·400(깨진 JSON)은 **여전히 500** 이고 포괄 핸들러가
  `ex.getMessage()` 를 그대로 싣는다(비-admin 도메인). admin 경로만 `AdminErrorHandler` 가 소독한다.
  → 별도 이슈. "없는 경로는 404" 는 **절반의 배달**이라는 사실을 여기 적어 둔다.

- **왜 위생이 아니라 계약인가**: 이 서버는 "없는 것"과 "못 보는 것"을 **구분 불가능**하게 만드는 데
  공을 들여 왔다(예약 공지 404 #297 · 남의 우편 404 #323). 그런데 정작 **오타는 500** 이라 다르게
  보였다 — 클라는 재시도·알림을 걸고, 5xx 대시보드엔 잡음이 섞인다.
- ⚠️ **예외 메시지를 그대로 흘리지 마라** — `"No static resource api/…"` 는 내부 구현(정적 폴백)을
  노출하고 요청 경로를 되비춘다. 도메인 404 와 같은 코드·같은 톤으로 답한다.
- **인증 게이트가 먼저다** — 미지 경로라고 401 을 건너뛰지 않는다(계약이 그것도 본다).
- 정적 리소스 디렉토리가 **아예 없는** 앱이라(자산은 전부 컨트롤러가 디스크에서 서빙) 이 매핑이
  삼킬 정상 경로가 없다. 나중에 `src/main/resources/static` 을 만들면 이 전제를 다시 봐라.
- 계약 = `ApiRouteNotFoundTest`(미지 경로 3종 404 + 메시지 누출 0 + 인증 우선 + 도메인 404 무회귀).
  변이체 킬 검증: 핸들러에서 `NoResourceFoundException` 제거 / 500 반환 / `ex.getMessage()` 노출 —
  셋 다 죽는다.
- ⚠️ **경로 반사 단언은 선행 슬래시를 뗀 형태로 걸어라.** 누출 문자열이 `"No static resource api/nope."`
  (슬래시 없음)라 `doesNotContain("/api/nope")` 는 **아무것도 잡지 못했다** — 독립검증이 변이체로
  실증했다(문구만 바꾸고 경로는 노출하는 구현이 통과). 프레임워크 문구는 버전마다 바뀌므로
  **경로 반사**가 남는 축이다.

## 성장 계수 무배포 — `GrowthTuning` + V38 (#405 W2a)

설계 SoT = `docs/plan-v5/growth-redesign.md` §2.8. **AC-G0(hero 하드 AC): 성장 개편이 만드는 계수 중
admin API 로 조정 불가한 것이 0개.** 하드코딩 잔존 = FAIL.

- **계수의 SoT 는 `GrowthTuning` 하나**다(`online.hmb.growth`). 등급 밴드는 `GrowthService.GRADE_BAND`
  **하드코딩이었고 삭제됐다** — 밴드 한 칸 바꾸는 데 배포가 필요했던 것이 개편의 출발점이다(설계 §1.3).
- **기본값의 출처가 둘**이다: 코드 기본값(`CODE_DEFAULTS`, 설계 §2.8.1 표) ⊕ **발행물 승계**
  (`positionBaseline` · `star.copies` · `xp.minutesMult` 만 — 설계가 "현행 승계"로 표시한 항목).
  ⚠️ **`xp.gradeMult` 는 승계하지 않는다** — economy 현행(레전드 3배)을 **뒤집는 것**이 개편 내용이다(Q5).
- **유효값 = 기본값 ⊕ 최신 리비전**(경로 단위 병합). 원장 = `growth_config_revisions`(V38, **V37 동형**:
  `seq AUTOINCREMENT` append-only · `overrides_json` 전체 스냅샷 · `reason` 필수 · `idem_key` 부분 유니크
  + `request_hash` 409). "현재 = 마지막 삽입"의 근거는 V37 javadoc 과 같다(ULID·`created_at` 정렬은
  동률에서 깨져 **롤백이 반반 확률로 무시된다**).
- **매치 pin 은 하지 않는다**(#383 엔진 계수와 다른 점). 성장은 매치 **종료 후** 한 번 계산되므로 진행 중
  매치가 도중에 값이 바뀌어 깨지는 #241 형태의 위험이 없다. 대신 `currentRevisionId()` 를 노출한다 —
  정산이 쓴 리비전을 리포트에 박제하는 것은 W2b.
- **검증은 서버 내부**다(#383 은 러너 위임). 성장 계수는 **이 서버가 소비자**라 위임할 대상이 없다:
  경로 화이트리스트(`GrowthTuning.KNOBS`) + 타입 + 범위. **무효 노브는 항목별 이유를 `detail.issues[]`
  로 한 번에** 돌려준다(첫 오류에서 끊으면 10개 고치는 데 10번 왕복).
- API: `GET/PUT /api/admin/growth-config` · `GET .../history` · `GET .../knobs` · `POST .../validate`.
  PUT 은 **전체 교체**(기본값 복귀 = `overrides:{}`), 성공·**실패 모두** `admin_ops_audit` 기록.
- **star 의 역할이 바뀌었다**(설계 §2.6): `starFrac` 천장 게이트 제거 — 1★ 도 등급 천장까지 성장한다.
  천장 = `bands[grade].growCeil + star.ceilBonus[star]`. `economy.star.starFrac` 은 발행물에 남아 있지만
  **더 이상 읽지 않는다**. 전역 `attrHardCap`(99)은 **잠재 적용 후** 최종 클램프다(잠재가 100 을 넘길 수
  있던 선존 결함).
- ⚠️ **계약 3종이 AC-G0 을 집행한다** — `GrowthTuningRegistryTest`(모든 노브가 실제로 오버레이되는가 ·
  레지스트리를 빠져나간 잎이 없는가) · `GrowthHardcodeGuardTest`(성장 소스의 숫자 리터럴 **화이트리스트**) ·
  `GrowthTuningLiveTest`(**서버가 그 값을 실제로 쓰는가** — 계수 객체가 바뀌는 것과 화면 값이 바뀌는 것은
  다른 명제다). 새 계수를 추가하면 `KNOBS` 에 등록하기 전까지 두 번째 테스트가 깨진다.
- ⚠️ **"노브가 340개인데 왜 안 먹지"의 답** — 오버레이가 저장·병합되는 것과 **누가 그 값을 읽는가**는
  다른 문제다. 축이 둘이다.
  ⚠️ **정확한 수는 `GrowthTuning.KNOBS.size()` 로 확인해라 — 문서 숫자는 낡는다.**
  (이 에픽에서만 330 → 339 → 340 으로 세 번 틀렸다. 그래서 개수를 리터럴로 박는 테스트도 두지 않는다 —
  노브가 늘 때마다 깨지는 무의미한 계약이 된다.)
  - **`KnobSpec.scope`**(`RUNTIME` | `PUBLISH`) = 구조적 구분. `PUBLISH` 는 **`bands.primaryBias` ·
    `bands.traitBias` · `bands.<GRADE>.startHi`(×5)** 이고, 카드 스탯은 `players.v*.json` 발행물에 이미
    구워져 있어 **이미 발행된 카드는 안 바뀐다**(#412 어드민 선수 등록 API 가 승계할 인터페이스).
    `/knobs` 응답의 `scope` · `appliesWhen` 이 그 사실을 운영자에게 보낸다. 계약 = `GrowthTuningLiveTest.
    publishScopedKnobsDoNotMoveAnyRuntimeNumber`(표기가 사실임을 기계로 박는다).
    - ⚠️ `startHi` 는 원래 RUNTIME 이었는데 **런타임 소비자가 0**이었다(독립검증). 런타임이 읽는 밴드
      값은 `startLo`(유효스탯 하한 클램프 + 감쇠 비율 `r` 의 분모)와 `growCeil` 뿐이다.
    - 🚨 **그 구멍을 막는 것이 `GrowthConsumerGuardTest`** 다: `GrowthMath`·`GrowthCandidates` 순수
      함수 전부를 고정 격자에 태워 **노브 하나만 바꾼 tuning 의 지문이 달라지는지** 본다
      (`everyKnobIsOverridable` 과 같은 모양, **대상만 소비자**). 소비자 없는 RUNTIME 노브 = FAIL.
      서비스 레이어에서만 읽히는 것(`star.copies.*` · `legacy.levelGrantCap`)은 **근거를 적은
      allowlist** 로 뺀다 — **그 목록이 길어지면 그 자체가 경고**다.
    ⚠️ 두 노브의 기본값은 설계 §2.8.1 표(5/6)가 아니라 **발행 실적 3/4** 다 — 밴드 폭이 16→11 로 줄어
    5+6 = 폭 전체가 되면 주스탯∩trait 가 상한에 박혀 **롤과 무관한 상수**가 되기 때문(클램프 100% →
    76.5%, v2.4 의 79.4% 복원). 표가 낡았고 발행물이 맞다.
  - **웨이브 진행도** = 시간 축. `RUNTIME` 노브 중 W2a 가 실제로 소비하는 것은 **`bands.*` ·
    `attrHardCap` · `star.ceilBonus`/`star.copies` · `positionBaseline` · `xp.minutesMult`** 뿐이다.
    `decay.*` · `xp.*`(나머지) · `candidate.*` · `legacy.*` 는 **`GrowthMath` 순수 함수까지만** 도달하고
    정산·3지선다 소비는 **W2b** 가 붙인다. 그래서
    `GrowthTuningRegistryTest.everyKnobIsOverridable` 은 **값이 바뀌는 것**을 증명하지 소비자 존재를
    증명하지 않는다 — 소비 여부는 `GrowthTuningLiveTest` 가 종목별로 따로 본다.
- ⚠️ **감쇠는 설계값이 아니라 재보정값이다** — `decay.gainMax 6.5` · `decayPow 0.8`(설계 §2.3 은
  4.0/1.4). `growCeil`·`maxLevel` 은 hero 확정값이라 못 건드리고(천장은 99 로 올려도 안 된다 — 4스탯만
  밀면 나머지 5스탯이 시작값에 남아 OVR 을 끌어내린다), 남은 자유 축이 감쇠였다.

  ### 🚨 "2단계 역전" 판정 — **확정 기준을 먼저 본다**

  **확정 기준 = OVR · 발행물 실측 · 실제 3지선다 추첨 · 39픽 · 1★ · 매 레벨 OVR 최선 선택.**
  이 기준으로 **세 쌍 전부 통과**한다 — **B>G +3.51 · S>D +2.34 · G>L +1.08**.
  가드 = **`GrowthShippedProgressionTest`**(발행물을 `application.yml` 의 `players-file` 로 따라가고,
  매 레벨 `GrowthCandidates.draw` 를 실제로 돌린다). **헤드라인 목표의 판정은 이 테스트다.**
  - ⚠️ **성립 전제 = "매 레벨 OVR 최선을 고른다"**. 화면이 유도하기 쉬운 **gain 최대** 선택이면
    G>L **−0.64**, **무작위 선택은 더 나쁘다**(G>L **−1.11** · S>D **−0.13** 로 함께 깨진다).
    그래서 서버가 후보를 OVR 기여 내림차순으로 **정렬해 내리고** `core` 배지를 붙인다(W3c) — 그 UX 가
    이 전제를 지탱하는 장치이지 장식이 아니다. 계약 = `theTargetOnlyHoldsForOvrFirstPicking`.
  - **대가**: 9스탯 총상승 97.5 → 168.2(**약 1.7배 인플레**). 구조적으로 불가피하다 — 탐색공간 하한이
    총량 1.53배다. 몰빵 효율비는 오히려 30% → **17%** 로 강화된다(1스탯 총상승은 천장에 묶여 29.0 고정).

  ### 대조군 — **폐기된 배분 가정**(밴드중앙 + 핵심4 균등)

  `GrowthProgressionContractTest` 는 **밴드 중앙 ↔ 밴드 중앙 + 핵심 4스탯 균등 배분**으로 재는
  **구조 가드**다(감쇠를 되돌리면 즉시 깨진다). 그 배분 가정은 설계 §2.2 가 **"배분 가정이 틀렸다"며
  폐기**한 것이고 — 유저는 매 레벨 뽑힌 3개 중에서 고르지 핵심 4스탯에 균등 배분하지 않는다 —
  같은 계산기로 재면 마진이 훨씬 얇다: **B>G +2.80 · S>D +1.57 · G>L +0.22**(포지션 평균),
  포지션별로는 **MF 가 음수**(가장 평평한 baseline). **지우지 않고 남기는 이유**는 그 차이 자체가
  정보이기 때문이다 — 배분 가정 하나가 마진을 1~2 OVR 씩 깎는다. **미달의 근거로 인용하지 마라.**
  - ⚠️ **수치를 인용할 땐 어느 계산기인지 반드시 같이 써라.** 이 에픽에서 같은 혼동이 **세 번** 났다:
    ①설계 §2.2 초판의 좌변 4스탯 / 우변 9스탯 ②성장쪽은 발행물(바이어스 포함) / 미성장쪽은 밴드중앙
    ③폐기된 배분 가정의 수치를 확정 기준으로 오독.
- ⚠️ **W2a 는 계수와 인프라까지다.** 정산·3지선다·소급 백필·보상 API 는 W2b 이고, **V38 은
  `user_players` 를 건드리지 않는다**(스키마 변경은 백업·백필과 한 세트여야 한다 — 계약 =
  `FlywayMigrationTest.v38DoesNotTouchUserPlayers`). 그래서 상승분 `add_i` 는 아직 기존
  `stat_levels_json` 의 정수 `lv` 를 그대로 읽는 **어댑터**였다(W2b 가 교체했다 — 아래 절).

## 성장 로직 본체 — 카드 XP · 3지선다 · 이관 · 보상 봉투 (#405 W2b, V39)

- **정산이 스탯을 올리지 않는다.** `GrowthService.settleMatch` 는 이제 **카드 XP** 만 적립하고
  (`matchXp = xp.matchBase × minutesMult × resultMult × gradeMult × (1 + perfBonus)`), 레벨업마다
  `growth_level_choices` 1행을 남긴다. 스탯이 오르는 유일한 경로는 **유저의 선택**
  (`POST /api/growth/choices/{id}`)이다. 구 모델(스탯별 XP 자동 레벨업)은 통째로 은퇴했다 —
  계약 = `GrowthCardLevelSettlementTest.settlementAloneRaisesNoStat`(두 모델이 동시에 도는
  "스탯 두 배" 사고를 이 한 줄이 막는다).
- **상승분의 자리가 `stat_levels_json` → `stat_add_json`(소수) 으로 옮겼다.** 구 컬럼은 **남긴다** —
  ①소급 이관의 입력 ②롤백 근거. `compute()` 는 이제 `stat_add_json` 만 읽는다(어댑터 은퇴).
  ⚠️ 테스트에서 "키운 카드"를 만들 땐 `stat_add_json` 에 넣어라. 구 컬럼에 넣으면 **아무 일도
  일어나지 않는데 테스트는 통과할 수 있다**(실제로 `AdminUnitCatalogTest` 의 등급 하향 영향
  계산이 그렇게 0 이 됐다).
- **3지선다는 프롬프트를 키워드 매칭하지 않는다.** AI 가 이미 변환해 `match_halves.*_input_json`
  에 박제한 `PlayerBehavior` 9 파라미터를 쓴다(`GrowthCandidates.behaviorScore`). 유저 사이드는
  `userIsHome(match)` 로 고르고, 이벤트는 `event.team` 필터가 필수다(봇과 `playerId` 가 겹친다).
  - **결정론**: `seed = sha256(matchId + userId + playerId + ":" + level)`. `Math.random`·시계 금지.
    같은 키는 몇 번을 재계산해도 같은 3개 + 같은 gain 이다 — 그 성질이 없으면 "박제"가 성립하지 않는다.
  - **후보와 gain 을 둘 다 박제**한다. 미루는 동안 다른 픽으로 스탯이 오르면 gain 이 줄어
    "화면엔 +2.9 였는데 +2.1 이 들어왔다"가 된다.
  - ⚠️ **설계 §2.5 공식과의 편차 하나**: `eventScore`·`behaviorScore` 를 **최대성분 1 로 정규화**한다.
    원값은 스케일이 다르다(이벤트는 횟수라 패스 300회면 항이 60, behavior 는 0..1) — 정규화하지
    않으면 `wBase`·`wPosition` 이 통째로 삼켜져 **모든 카드가 패스만 뽑는다**. 순위는 보존되고
    절대량만 떨어진다.
  - **천장에 닿은 스탯은 후보에서 제외**(`candidate.excludeAtCeiling`). 전부 천장이면 **선택권을
    만들지 않는다** — 빈 대기 뱃지는 유저가 지울 수 없다.
- **선택은 CAS 로 한 번만**(`WHERE chosen_stat IS NULL`) + `UNIQUE(user_id, player_id, level)`.
  `MatchLockService.assertNotLocked(userId, "growth.choice")` 를 반드시 건다 — `growth.star`·
  `growth.dice` 와 **같은 이유**(`buildSelectData` 가 시뮬 시점에 유효스탯을 읽어 전·후반 사이
  강화가 후반만 올린다).
- **소급 이관**(`GrowthLegacyBackfillService`, `@Order(50)` = 카탈로그 임포트 0 뒤 · 부트스트랩 100 앞):
  기존 **스탯 레벨 합 = 선택권 수**(상한 `legacy.levelGrantCap`·만렙−1), `card_level = 1 + 지급수`.
  후보 가중은 매치 컨텍스트가 없으므로 `positionBaseline` + 그 카드의 스탯 XP 분포다.
  - ⚠️ **하향분 Δ 를 `stat_add_json` 으로 되메우지 않는다.** 그건 설계가 이름 붙여 기각한 **안 A**
    (무손실 백필)이고, Δ 를 채우면 그 카드는 감쇠 곡선 꼭대기에 앉아 앞으로의 gain 이 영원히
    `gainMin` 이 된다 = **기존 유저만 성장이 멈춘다**. 갚는 수단은 **선택권**이다(1장이 낮은
    스탯에서 +3 이상 = 구 모델 1레벨 +1 보다 크다). 계약 =
    `GrowthLegacyBackfillTest.theLegacyBaseSnapshotIsNeverBackfilledIntoStatAdd`.
  - `growth_legacy_base`(V39 가 채운다)의 쓸모는 **감사·롤백**이다. **Flyway 는 ApplicationRunner
    보다 먼저 돈다** → 스냅샷은 *직전 부팅이 임포트한* 값이다: 원자 배포면 v2.4(하향 전),
    v2.5 가 먼저 나갔으면 현재값과 같다(= 설계 §2.7 "배포 원자성" 사고 신호 → **WARN 로그**).
    두 경우 모두 **지급 수는 같다**.
  - **멱등은 두 겹**: `meta_kv` 완료 마커 + `UNIQUE(user,player,level)`. 마커만 믿으면 마커 쓰기
    직전에 죽은 배포가 두 배로 지급한다.
- **보상 봉투**(`RewardBundleService`, 설계 §2.9)는 매치 전용이 아니라 **공용 계약**이다 —
  E5 미션·리그·우편이 `source` 만 바꿔 쓴다. `GET /api/matches/{id}/result` 에 **additive**
  (`rewardBundle`, #368 선례라 openapi 무변경) · `POST /api/rewards/{id}/ack` 는 멱등이고
  **확인 시각을 덮지 않는다**. ⚠️ 재화는 **코드만** 싣는다(`{"code":"POINT","amount":N}`) —
  이름·심볼을 서버 응답에 넣으면 표기 변경(#232)이 곧 배포가 된다.
- ⚠️ **`players` 를 참조하는 표가 둘 늘었다**(`growth_level_choices`·`growth_legacy_base`) →
  `AdminCatalogService.REFERENCING_TABLES` 에 등록했다. 빠뜨리면 유닛 회수가 깔끔한 409 대신
  생 FK 위반으로 떨어진다(계약 = `AdminUnitPurgeTest.referencingTablesListMatchesTheSchema`).
### W3(web) 소비용 additive 3종 (목업 복원)

hero 가 승인한 목업 요소 3개가 "서버에 그 데이터가 없다"는 이유로 web 에서 빠졌다. 셋 다 서버가
채운다 — **계수는 하나도 늘지 않았다**(전부 이미 계산하고 버리던 값이다).

- **후보 `reason`** — `{"kind":"EVENT|BEHAVIOR|POSITION|RESULT|LEGACY|BASE","detail":{…}}`.
  그 스탯의 가중을 가장 크게 밀어올린 축 하나 + **원자료**(`{"type":"shot","count":4}` ·
  `{"param":"shootTendency","value":0.82}`). **gain 과 같이 박제**한다(재계산하면 다음 경기를 치른
  뒤 이유가 바뀐다). 동점은 `EVENT → BEHAVIOR → POSITION → RESULT` **고정 순서**로 깬다 —
  맵 순회에 맡기면 같은 시드가 실행마다 다른 이유를 말한다.
  - ⚠️ **서버는 구조만 내리고 문장을 만들지 않는다**(재화 표기 #232 와 같은 이유 — 문안이 코드에
    박히면 문구 하나 고치는 데 배포가 필요하다).
  - `LEGACY` = 소급 지급분(매치 컨텍스트 없음) · `BASE` = 어느 축도 기여 안 함(= `wBase` 만).
    기본 계수에선 `positionBaseline` 이 9종 모두 >0 이라 `BASE` 는 실질적으로 안 나오지만,
    가중을 0 으로 오버레이하면 나온다 — **그때 POSITION 이라고 말하면 거짓**이라 자리를 비워 둔다.
  - ⚠️ W2b 초판에 만들어진 행에는 `reason` 이 **없다**(필드가 나중에 붙었다). `readReason` 이 null
    을 돌려주고 클라는 이유 줄을 생략한다 — 없는 것을 지어내지 않는다.
- **봉투 GROWTH 엔트리 `cardXp`·`xpToNext`·`minutes`** — 행 XP 진행바와 미투입/교체 구분.
  ⚠️ **`xpToNext` 를 클라가 미러하면 안 된다**: `xp.lvBase`/`lvPow` 를 무배포로 돌리는 순간
  화면만 옛 곡선으로 그려진다(§2.8 이 막으려는 상태). 그래서 정산 시점에 서버가 계산해 스냅샷에
  박는다. 만렙은 `xpToNext=0`(“다음까지 100”이라고 하면 영영 안 차는 바가 그려진다).
- **카드 응답 `growCeil`·`starCeilBonus`·`attrHardCap`** — "천장 73 = 72 + ★2 보너스 1" 라벨.
  `caps` 는 이미 `min(growCeil + starCeilBonus, attrHardCap)` 로 합쳐진 값이라 **셋을 다 줘야**
  라벨이 거짓말을 안 한다. 계약도 값이 아니라 그 **관계식**으로 건다.
- ⚠️ **박제 계약은 응답끼리 비교하면 안 된다**(실측으로 잡혔다). "미뤄도 안 바뀐다"를 before/after
  응답으로만 걸었더니 `readReason` 이 **항상 BASE 를 돌려주게** 만든 변이체가 살아남았다 —
  before == after 라 관측이 안 된다. 지금은 응답을 **`candidates_json` 바이트와 대조**한다.

### 후보 정렬·`core`·`startLo` (BL-1 후속 UX 갭)

독립검증이 BL-1(2단계 역전)을 닫으면서 **UX 갭 하나**를 남겼다: 화면에서 가장 크고 눈에 띄는
숫자는 `+3.82` **gain 배지**인데, 판단 근거인 `positionBaseline` 은 화면에 **전혀 없다**. 감쇠 특성상
gain 이 큰 쪽은 **낮은 스탯**이라 화면이 유도하는 선택(gain 최대)이 OVR 로는 **지는 선택**이다.

⚠️ **성립 전제를 정확히 적는다 — "정보를 갖춘 선택"이 아니라 "매 레벨 OVR 최선을 고른다"** 이다.
선택 규칙별 GOLD>LEGEND 마진(발행물·실제 추첨·39픽·1★ 실측):

| 선택 규칙 | G>L | S>D |
|---|---|---|
| **OVR 최선**(1번 후보) | **+1.08** | **+2.34** |
| gain 최대 | −0.64 | +0.30 |
| **무작위** | **−1.11** | **−0.13** |

**최악은 gain 최대가 아니라 무작위**다(무작위는 S>D 까지 함께 깨진다). 즉 이 목표는 유저가
아무렇게나 눌러도 성립하는 성질이 아니라 **화면이 올바른 선택을 보여 줘야 성립**한다.
`gainMax` 를 7.5 로 더 올려 덮을 수도 있었지만 성장 인플레가 168→185 로 커지고 밸런스 스윕 부담이
늘어난다 — **판단 근거를 화면에 노출하는 쪽**으로 갔다. 계약 =
`GrowthShippedProgressionTest.theTargetOnlyHoldsForOvrFirstPicking`.

- **후보 3개를 `positionBaseline[pos][stat] × gain` 내림차순으로 서버가 정렬해 내린다.**
  클라는 순서대로 그리면 된다. 각 후보에 **`core: boolean`**(그 포지션 baseline 상위
  `candidate.coreStatCount` 스탯인가).
- ⚠️ **가중치 값 자체를 클라에 내리지 않는다.** 무배포 조정 대상이라 클라가 미러하면 노브를 돌리는
  순간 화면만 옛 기준으로 정렬한다(§2.8). 서버가 정렬·판정한 **결과만** 준다.
- **순서·`core` 도 박제 대상**이다(`gain`·`reason` 과 같은 이유). 동점은 `GrowthTuning.STATS` 순서로
  깬다 — 값에만 맡기면 같은 시드가 실행마다 다른 순서를 낸다.
  ⚠️ **읽기 경로에서 다시 정렬하지 마라**(`readCandidates`) — 그러면 계수를 돌린 뒤 과거 선택권의
  순서가 소급으로 바뀐다. 구 박제분(`790dfc2` 이전)은 `core` 가 없어 **null** 이고 순서는 저장된
  그대로 쓴다.
- **카드 응답에 `startLo`** — 후보 막대의 **좌측 앵커**. 감쇠가 `r = (v − startLo)/(ceiling − startLo)`
  라 앵커가 이 값이어야 세 후보의 gain 차이가 막대 길이로 읽힌다. web 이 쓰던 근사치
  (`min(base) − 5`)에 "시작 50" 이라는 정확한 라벨을 붙이면 **화면이 거짓말**을 한다.
- **새 계수 하나 더**: `candidate.coreStatCount`(기본 **4**). 설계 §2.2 가 "2단계 역전"을 계산한 축이
  4스탯 집중이라, 화면의 "핵심" 표시가 밸런스 근거와 같은 수를 써야 한다. KNOBS 등록 완료.
- 🚨 **정렬이 `GrowthConsumerGuardTest` 의 해상도를 깎았다.** 후보가 정렬된 채 나오면서 추첨
  **순서**가 지문에서 사라져 관측 가능한 것이 "뽑힌 집합"뿐이 됐고, `candidate.wPosition` 이
  **고아로 잘못 잡혔다**(mutate 는 +0.25 라 집합을 잘 안 뒤집는다). 시드 격자를 12 → **120** 으로
  넓혀 복구했다 — **그 숫자를 줄이지 마라**(주석에 근거를 적어 뒀다).

- **새 계수 하나**: `candidate.resultTilt.<stat>`(승리 가중 벡터). 설계가 값 표를 남기지 않아
  `perfEventWeight` 와 같은 자리의 **첫 기본값**이다(mental 1.0 / positioning 0.4 / stamina 0.2).
  역할 축(shooting·tackling…)과 겹치지 않게 고른 이유: 겹치면 `wResult` 가 `wPosition` 의
  그림자가 되어 **운영자가 따로 조정할 수 없는 노브**가 된다.

## 비즈니스 이벤트 보드 (#492, V42)

계약 SoT = **이슈 #492 §Plan 확정 코멘트**(`docs/**` 는 이 모듈 밖 → openapi 편입은 매니저 경유,
`/api/growth/*`·`/api/away/*` 와 같은 상태). 목적은 종류별 총량이 아니라 **유저별 도달 지점**이다
(hero: *"심사위원들이 게임을 어디까지 플레이해봤나"*) — 그래서 1급 화면이 `/funnel` 이다.

- **이벤트 7종 · 매치는 쪼개지 않는다.** `user_signup` · `tutorial_complete` · `deck_save` ·
  `gacha_pull` · `match_start` · `match_finish` · `league_season_start`. 연습·리그·원정은 전부
  `match_start`/`match_finish` + `props.mode` 다 — 별도 이벤트로 쪼개면 원정 1건이 두 번 세어져
  총량과 퍼널이 서로 다른 말을 한다. 열거의 SoT = `events/BusinessEvent`(DB CHECK 없음).

- 🚨 **"best effort" 는 try/catch 로 성립하지 않는다.** 이 리포엔 `@Transactional` 이 **0개**고
  트랜잭션은 `common/TxRunner`(TransactionTemplate, **PROPAGATION_REQUIRED**)로 명시적이다.
  `txRunner.run(...)` 람다 **안**에서 이벤트 INSERT 가 실패하면 예외를 삼켜도 **바깥 트랜잭션이
  같이 롤백**되고 SQLite 트랜잭션이 오염된다 = 계측이 가입·저장·뽑기·정산을 되돌린다.
  → 무영향은 **훅 위치라는 구조**로 보장한다:
  - **훅은 전부 비-tx 경계**다. 그래서 대부분 **컨트롤러**에 있다 — 서비스에 두면 안 되는 이유가
    경로마다 있다: `UserOnboardingService.createUser`·`OnboardingService.complete`·
    `GachaService.pull`·`LeagueService.startSeason/nextMatch` 는 **메서드 전체가 tx** 이고,
    `DeckService.replaceDeck` 은 튜토리얼 덱 지급의 tx 안에서도 불리며,
    `MatchService.createAwayMatch` 는 `AwayService.startRevenge` 의 tx(예약+생성 원자성)에 합류한다.
  - **예외는 매치 종료 하나** — 결과·득점·지급 포인트가 tx 안에서만 확정되므로
    `MatchOrchestrator.finishMatch` 가 `FinishOutcome` sink 로 값을 넘기고,
    `settleFinishedIfDue` 가 **커밋 후**에 기록한다. 이 훅을 람다 안으로 옮기면 보상·리그 픽스처·
    레이팅·성장이 통째로 롤백된다.
  - 3층 방어 = ①훅 위치(소스 스캔 `BusinessEventHookPlacementTest`) ②런타임 게이트(recorder 가
    `isActualTransactionActive()` 면 **쓰지 않고 warn**) ③예외 봉인(`record`·`probe` 가 전부 삼킨다).
    ②가 발화하면 그 이벤트는 **영영 안 남는다** — 그래서 ①이 1차이고 ②는 백스톱이다.
  - **props 조립도 봉인 안**이다(`record(event, userId, Supplier<Map>)`). 호출부가 값 하나
    조회하다 던지면 그것만으로 본 동작이 깨진다. 본 동작 **전**에만 알 수 있는 값
    (덱이 새로 생겼나 · 시즌이 새로 생겼나)은 `recorder.probe(read, fallback)` 로 감싼다.

- **재진입·재사용 분기는 이벤트가 아니다.** `POST /api/league/start` 의 재진입(이미 ACTIVE 인 시즌
  반환)과 `POST /api/league/next-match` 의 픽스처 재사용(진행 중 매치로 재입장)은 0건이어야 한다 —
  세면 "몇 판 시작했나"가 새로고침 횟수를 센다. 두 멱등 메서드는 응답만으로 구분이 안 되므로
  호출 **전** 상태를 읽는다(`LeagueService.activeSeasonIdOrNull` ·
  `activeNextFixtureMatchIdOrNull` — 후자의 살아있음 판정은 `MatchService.ACTIVE_STATES` 로,
  `FINISHED 아님`이 아니다. #217 이 그 형태로 물렸다).
  ⚠️ 반대로 `POST /api/me/tutorial-complete` 는 **부를 때마다 1행**을 남긴다(멱등이지만 "완료를
  눌렀다"가 이벤트다). 퍼널의 tutorial 칸은 "1건 이상"이라 영향받지 않는다.

- **admin API 2종** — `GET /api/admin/events?event=&userId=&mode=&limit=&offset=`(props 는 **파싱된
  객체**로 · 미지 `event` 400 · limit 기본 50/최대 200 = `hmb.events.*` config) ·
  `GET /api/admin/events/funnel`(유저 1행 × 단계 도달 boolean, 정렬 `lastSeenAt DESC`).
  `mode` 필터와 퍼널의 practice/league/away 는 **`json_extract(props_json,'$.mode')`** 다(sqlite-jdbc
  JSON1). 기간 필터(`from`/`to`)는 스코프에서 **뺐다**(hero 승인안 B 축소) — 넣으려면 web 과 함께
  계약을 다시 얼려야 한다. 퍼널은 파라미터가 없어 상한을 서버가 쥔다(`funnel-max-users` 500).
  ⚠️ **쓰기(`BusinessEventRecorder`)와 조회(`BusinessEventQueryService`)는 일부러 별개 빈**이다 —
  조회 빈만 `AdminRouteGuard.ADMIN_ONLY_BEANS` 에 있고, 합치면 훅이 붙은 덱·상점·매치·리그·원정
  컨트롤러가 전부 게이트 위반이 되어 **부팅이 죽는다**.
  새 admin 컨트롤러 필수 3등록(`AdminErrorHandler.assignableTypes` · `ADMIN_ONLY_BEANS` ·
  `FlywayMigrationTest` 인벤토리) 완료. 401/403 은 `AdminGateTest` 가 자동 커버한다.

- **롤백 스위치** = `hmb.events.enabled: false`(env `HMB_EVENTS_ENABLED`). 훅은 남고 아무 것도 쓰지
  않으며 `probe` 의 사전 조회도 돌지 않는다(오버헤드 0).
- **V42 는 CHECK·FK 를 일부러 안 건다** — 둘 다 "기록 실패 = 본 동작 실패"가 되는 경로다. append-only.
- 실측 지연(콜드): 훅 1건 **0.12 ms** vs `POST /api/matches` 7.9~9.2 ms · 정산 5.2~5.3 ms
  → **시작 +1.3~1.6% · 종료 +2.3~2.4%**(계약 = `BusinessEventFlowTest` 가 매 실행 로그로 남긴다).
- ✅ **롤백 경로(`hmb.match.clock.enabled=false`)도 `match_finish` 를 남긴다.** 이 경로는 후반 진입이
  곧 종료라 정산이 `simulateAndStore` 의 **tx 안**에서 끝난다 — 한때 그 자리에 커밋 후 훅이 없어
  **시계를 끄면 이 이벤트만 조용히 사라졌다**(퍼널이 `match_start` 까지만 찍힌 유저를 "경기를 끝내지
  못한 사람"으로 그렸다). 훅은 예고대로 `finishMatch` **안**이 아니라 **호출부의 커밋 경계**에 있다:
  `simulateAndStore` 가 `FinishOutcome[] finishSink` 를 `enterSecondHalf` 로 내려보내고,
  `txRunner.run(...)` 이 **반환된 뒤** 기록한다(시계가 켜져 있으면 sink 가 비어 no-op).
  props 조립은 `recordMatchFinish` **한 곳**이 소유한다 — 갈라 두면 같은 이벤트인데 롤백 경로에서만
  `mode` 필터·퍼널이 다르게 동작한다.
  ⚠️ 계약 = `MatchClockDisabledTest.matchFinishIsRecordedEvenWhenTheClockIsDisabled`
  (**건수 1건 + props 값**까지 본다). **변이체 킬 확인** — sink 를 `null` 로 되돌리면 죽는다.
  이 갭이 오래 살아남은 이유는 시계를 끈 채 **종료까지 태우는 계약이 없었기 때문**이다.

## 규칙
- 테스트 먼저(전이표·검증 매트릭스), `./gradlew test` green이 웨이브 완료 조건. JPA 금지(JdbcClient).
- 상태 전이는 CAS(`WHERE state=?`), 보상·원장은 멱등(유니크 인덱스). 트랜잭션 경계는 서비스 메서드.
- 커밋 `[Spider] type(server-java): ...`, gh 계정 dd0114, **gh auth switch 금지**(fleet 규칙).
