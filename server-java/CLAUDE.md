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

## 규칙
- 테스트 먼저(전이표·검증 매트릭스), `./gradlew test` green이 웨이브 완료 조건. JPA 금지(JdbcClient).
- 상태 전이는 CAS(`WHERE state=?`), 보상·원장은 멱등(유니크 인덱스). 트랜잭션 경계는 서비스 메서드.
- 커밋 `[Spider] type(server-java): ...`, gh 계정 dd0114, **gh auth switch 금지**(fleet 규칙).
