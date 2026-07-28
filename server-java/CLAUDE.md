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
  - additive: `GET /api/me` 에 `rating`, `MatchDetail` 에 `ownerName`(홈=매치 생성자 닉 — 관전자가
    홈을 자기 이름으로 오인하지 않게)
### 원정 v2 (hero 3차 컨펌 2026-07-29, V22)

- **상대 2택**(E2): `GET /api/away/candidates` 가 레이팅 비슷한 **2명**을 제시하고 그 목록을
  `away_offers`(유저당 1행)에 **서버가 저장**한다. `POST /api/away/matches {defenderId}` 는 그 안에서만
  수락한다. ⚠️ 이 저장이 없으면 "2택"이 곧 **지목**이고, 부계정 반복 지목 = 레이팅 무한 생성이다
  (4R MAJ-4 가 막은 경로). 새로 뽑으면 이전 제시는 무효 — 리롤로 후보를 쌓지 못한다. TTL 있음.
- **밴드 매칭**(E3): 내 레이팅 ±`rating-band` 에서 먼저 고르고 **부족하면 단계적으로 넓힌다**.
  인원이 적을 때 밴드만 고집하면 "상대 없음"이 되는데 그게 매칭 실패보다 나쁘다.
- **연승**(E4): 승 +1 · 패 0 · **무는 유지**(비긴 걸로 연승이 깨지면 방어 성공이 손해가 된다).
  보너스 = `(streak-1) × bonus-per-win`, 상한 있음(없으면 장기 연승이 밴드를 뚫고 달아난다).
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
- **다음 작업(hero 결정, 미착수)**: 하루 원정 횟수 제한 — 목적은 파밍이 아니라 **AI 비용·플레이 페이스**.
  횟수·리셋 시각·초과 문구는 착수 시 확정, 값은 config, 소진 상태는 화면에 보여야 한다.
- 계약 = `AwayV2Test`(2택·제시 밖 거부·리롤 무효화·밴드·연승/끊김·수비 보상 유무·시즌 마감 멱등).
- 계약 = `AwayRaidTest`(상대가 실유저인지 · 고스트 박제 · 정산/멱등 · 팝업 조회/ack · **수비자는 읽기만**).

## 규칙
- 테스트 먼저(전이표·검증 매트릭스), `./gradlew test` green이 웨이브 완료 조건. JPA 금지(JdbcClient).
- 상태 전이는 CAS(`WHERE state=?`), 보상·원장은 멱등(유니크 인덱스). 트랜잭션 경계는 서비스 메서드.
- 커밋 `[Spider] type(server-java): ...`, gh 계정 dd0114, **gh auth switch 금지**(fleet 규칙).
