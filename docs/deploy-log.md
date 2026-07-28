# 배포 기록 (deploy-log) — append-only

> **정책(P4-D5 / #171)**: 배포할 때마다 이 파일 맨 위(최신순)에 항목을 append 하고 커밋한다.
> "언제 무슨 버전이 배포됐나"의 SoT. AI·사람이 repo에서 바로 조회. `infra/version-manifest.sh` 산출을 여기에 옮겨 적는다.
> 항목 형식: 배포시각(UTC) · git SHA/브랜치 · 모듈별 버전(engine/server-java/web/servants) · 이미지 다이제스트 · tunnel/URL · 배포자 · 결과/비고.

---

## 2026-07-28T04:11Z — [운영 조치] 젬 **전원 일괄 지급** — 138명 × +6,000 (배포 아님, 코드·이미지 변경 0)
> 03:02Z 단건 지급과 같은 절차의 배치판. hero 승인. admin 젬 지급 API 가 없어 수동(갭 이슈 등록됨).

- **대상 산정**: 실행 시점 users **139** = wallets 139(지갑 없는 유저 0). 이미 `admin_grant` 를 받은 **`축구왕여르` 1명 제외** → **138명**. (hero 지시: 전원이 "6,000 지급받은 상태"가 되게 — 중복 지급 아님. 중복이 필요하면 별도 지시.)
- **실행**: 단일 트랜잭션 배치(`PRAGMA busy_timeout=8000; BEGIN IMMEDIATE; INSERT…SELECT; UPDATE…; COMMIT;`), java 재시작 0. 직후 `chown 10001:999` 로 db/-wal/-shm 소유권 복원.
  - 원장: `INSERT INTO gem_ledger SELECT u.id, 6000, 'admin_grant: hero 지시, 전원 6000', 'admin-grant-all-20260728-' || u.id, …` — `WHERE NOT EXISTS (admin_grant 기수령)` 로 제외, **ref_id 에 userId 를 접미해 유저별 멱등**(`uq_gem_ledger_reason_ref`).
  - 지갑: `UPDATE wallets SET gems = gems + 6000 WHERE user_id IN (이번 배치 ref_id 집합)` — **원장에 실제로 들어간 유저에만** 반영(두 문의 대상 집합이 같도록).
- **사전 백업**: `~/.local/state/hmb/db-backups/pre-gemgrant-all-20260728T041047Z.db` (186,486,784 B · sha256 `583f1981…` · integrity ok).
- **검증**: 원장 삽입 **138행** · `admin_grant` 수령 유저 **139/139** · **2회 이상 받은 유저 0** · 전 유저 **원장합==지갑 불일치 0건** · 젬 총합 **795,000 → 1,623,000**(정확히 +828,000 = 138×6,000) · 음수 잔액 0 · `integrity_check=ok` · 앱 정상(`status.sh` ✓, 신규 로그인 200).
  - DB 경합 없음: java 로그의 `SQLITE_BUSY`(clock sweeper) 는 **04:07:51 단 1건으로 이번 쓰기(04:11:07) 이전**이고, 이후 발생 0.
- **📌 결과 해석 주의 2건**:
  1. **지급은 균일하지만 잔액은 균일하지 않다** — 사후 분포 `12,000` 131명 / `9,000` 1명 / `6,000` 8명. 6,000 인 유저는 지급 전에 이미 젬을 쓴 사람들(가챠 `-6,000`)이라 지급 자체는 정상적으로 1회 들어갔다(`admin_grant` 1행). "전원 같은 잔액"이 목표였다면 별도 지시가 필요하다.
  2. **일회성 백필이다** — 04:11 이후 가입자는 이 보너스를 못 받는다(가입 지급 `initial_gems` 6,000 만). 신규 가입자에게도 계속 주려면 `economy` 의 가입 지급액을 올리는 쪽이 맞다(재배포 없이 admin economy override 로 가능).
- **후속 권고(재확인)**: admin 젬 지급 API(사유 필수 + `admin_ops_audit`) · `/api/admin/users/{id}` 응답에 `gems` 추가.

---

## 2026-07-28T03:02Z — [운영 조치] 젬 수동 지급 — `축구왕여르` +6,000 (배포 아님, 코드·이미지 변경 0)
> 배포 기록이 아니라 **프로덕션 데이터 조작 기록**이다. admin API 에 젬 지급 엔드포인트가 없어(갭 이슈 등록됨) hero 승인 하에 이번만 수동 실행했다. 같은 일이 반복되면 API 로 승격할 것.

- **대상**: `축구왕여르` (`01KYJRPRMFNJA8YYBD22WN5ZNH`, `mock:google`, 가입 2026-07-27T21:46Z)
- **지시**: hero — 젬(다이아) **6,000** 지급
- **사전 상태**: `wallets.points=3000` · `wallets.gems=**0**` (원장 = `initial_gems +6000`, `gacha_ten -3000` ×2 → 합 0, 지갑과 일치)
- **스키마 확인**(조작 전): 잔액은 **원장 파생이 아니라 컬럼**이다 — `wallets.gems INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0)`. `gem_ledger(id, user_id, delta, reason, ref_id, created_at)` 는 감사 원장이고 멱등 키는 `uq_gem_ledger_reason_ref(user_id, reason, ref_id) WHERE ref_id IS NOT NULL`. 앱(`WalletService.applyGems`)도 **원장 INSERT + `wallets.gems` UPDATE 2문**을 한 트랜잭션에서 수행한다 → **같은 순서·같은 2문으로** 조작했다.
- **실행**: 단일 트랜잭션(`PRAGMA busy_timeout=8000; BEGIN IMMEDIATE; INSERT INTO gem_ledger…; UPDATE wallets SET gems = gems + 6000 …; COMMIT;`), 컨테이너 무중단(java 재시작 없음).
  - 원장 행 `id=141` · `delta=+6000` · `reason='admin_grant: hero 지시, 축구왕여르 6000'` · `ref_id='admin-grant-20260728T030252Z'`(멱등 키) · `created_at='2026-07-28T03:02:52.000000000Z'`
  - ⚠️ 파일 소유권: 볼륨에 쓰기 위해 root 컨테이너를 썼으므로 **직후 `chown 10001:999` 로 `hmb.db`/`-wal`/`-shm` 소유권을 복원**했다. 이 단계를 빠뜨리면 java(uid 10001)가 쓰기를 잃고 서비스가 죽는다.
- **검증**: 지갑 `gems 0 → **6,000**` · 대상 유저 **원장합 6,000 == 지갑 6,000** · **전 유저 정합 불일치 0건**(`wallets.gems <> SUM(gem_ledger.delta)` 인 유저 수) · `PRAGMA integrity_check=ok` · 조작 후 앱 정상(`status.sh` 전 항목 ✓, 신규 로그인 200, java 로그 SQLITE_BUSY/lock 0건).
  - 📌 앱 응답으로의 확인은 하지 않았다 — 젬 잔액은 `/api/me`(그 유저 세션)에서만 보이고 `/api/admin/users/{id}` 는 **`points` 만 반환하고 gems 가 없다**. 남의 계정에 로그인하지 않기 위해 DB 검증(+ `WalletService.gems()` 가 `wallets.gems` 를 그대로 읽는 코드 경로 확인)으로 갈음했다. **admin 유저 상세에 gems 누락 = 별도 갭**.
- **후속 권고**: ①admin 젬 지급 API(사유 필수 + `admin_ops_audit` 기록, V18 있음) ②`/api/admin/users/{id}` 응답에 `gems` 추가 — 둘 다 있으면 이런 수동 조작이 필요 없다.

---

## 2026-07-27T15:52Z — **릴리스 태그 `v8.01`** (재생·시계정합·감독 180s #216 + 매치잠금 #217 V19 + 프리웜 #215 V20 + 아이콘 #218/#184)
- **git**: **`bd00b07`** = **태그 `v8.01`(`fcb9a02`) + 배포 blocker 픽스 1건**(web 빌드 실패, 아래 ⚠️). 브랜치 `deploy/v7`.
- **모듈 버전**: engine **`@0.21.0`**(변경 0) · server-java `0.1.0`(#216 서버시계 정합·감독시간 **180s**·하프 실시간 **420s** · #217 매치잠금/포기/방치 스윕 · #215 덱 저장 프리웜) · web `0.0.0`(하이라이트 단일모드 · `MatchLockGate` 8라우트 · LEGEND 아이콘) · servants `0.0.1` · 데이터 players `v2.3` / economy `v3`
- **이미지**(라이브 digest): `hmb-java` `sha256:2147c1a03d3c…`(신규) · `hmb-runner` `sha256:5453f13811c1…`(신규)
- **executor**: v8.01 코드로 재기동 — PID only(`18414`→`18411`→`18393`→`18387`) 종료 후 spider13 에서 동일 env 재기동(새 워커 **84740**). 종료 시점 미완 잡 0.
- **DB 마이그레이션**: Flyway **v18 → v20** (`V19 match abandon` [**non-transactional**, V8 이후 두 번째] · `V20 deck prewarm`) — success, 66ms.
  - **백업**: `~/.local/state/hmb/db-backups/pre-v8.01-20260727T154454Z.db` (113,565,696 B · sha256 `4c4f60786b70bcc8cfd0467a103e1675085836a97d95c25902540121f3eed15a` · `integrity_check=ok` · Flyway v18 · users 120 / matches 16 / user_players 1737).
  - **리허설(라이브 무접촉)**: 백업 사본 + 새 이미지 → V19·V20 success · `foreign_key_check` 0 · 전 테이블 행수 보존(match_prompts 6·match_halves 28·ai_jobs 72·point_ledger 243·growth_applied 167) · 기존 유저 로그인/지갑 정상 · `GET /api/me/active-match` 200 · 새 매치 201 → 두 번째 **409 `MATCH_IN_PROGRESS`**(detail.matchId 포함).
  - **V19 롤아웃 정합 별도 검증(#217 경고 지점)**: 실 데이터는 미완 매치가 2건뿐(각각 다른 유저)이라 회수 대상이 0 이었다 → **합성 데이터로 SQL 의미를 직접 확인**: U1(1건)·U2(1건)은 유지, U3(2건)은 **최신만 유지·오래된 것만 ABANDONED**. 즉 "유저별 최신 1건만 남긴다"가 실제로 유저별로 동작한다(전역 최신 1건이 아님). 별개로 리허설에서 6일 된 FAILED 1건이 ABANDONED 로 바뀐 것은 V19 가 아니라 **방치 백스톱 `sweepStale`**(`stale-after-min=720`)이 부팅 후 회수한 것 — 둘을 혼동하지 말 것.
  - **라이브 적용 후**: `foreign_key_check` 0 · `integrity_check=ok` · users 120 / matches 16 / user_players 1737 **전건 보존**.
  - 롤백 이미지: `hmb/server-java:prev-live`·`hmb/servants:prev-live`(= v7 세대). ⚠️ **v8 이미지로는 되돌릴 수 없다** — DB 가 v20 이라 v18 까지만 아는 이미지는 Flyway validate 에서 부팅 실패한다. 되돌리려면 **DB 를 pre-v8.01 백업으로 복원 + 그 세대 이미지**를 함께 써야 한다.
- **tunnel/URL**: web=Pages **https://hmb-online.pages.dev** · backend=quick tunnel **`https://stayed-earth-toddler-distribute.trycloudflare.com`**(워치독이 13:19 HEAL_OK 로 세운 것, 배포 전 가용성 8/8 확인) · CORS 무변경.
- **배포자**: hero(GO) + hmb:deploy(실행)
- **결과**: ✅ GREEN — 요청 스모크 전 항목 통과(실패 요청 0 · JS 에러 0).
  - **프리웜(#215)**: 덱 지급/저장 시 BASE 잡이 백그라운드 선실행(`deck_prewarm` 행 생성, BASE 잡 **19초** — v8 실측 65초) → **킥오프가 `GEN1` 을 건너뛰고 즉시 `FIRST_HALF`, 응답 0.86초**. 킥오프 시 매치 잡 4건 전부 `attempts=0`·0초(AI 호출 0).
  - **감독시간 180초(#216)**: `clock.halftimeMs=**180000**` · 화면 `감독시간 2:14 남음 — 시간이 지나면 전반 지시로 후반이 시작됩니다` + 교체 0/3 + [후반 시작]. 하프 실시간은 `halfRealMs=420000`(7분).
  - **매치 잠금·재입장(#217)**: 로그인 직후 `/match/:id` 로 착지 · 메타 **8개 라우트 전수**(`/lobby /deck /shop /growth /codex /trade /logs /league`)가 전부 `/match/:id` 로 강제 복귀 · 두 번째 매치 생성 **409**(`detail.matchId` = 이어가기 링크) · 종료 후 잠금 해제(`locked:false`) → 새 매치 201 · **포기 200 → ABANDONED**(탈출구 AC3).
  - **하이라이트 단일모드(#216)**: 경기 화면 컨트롤에서 `🎬 하이라이트 켜짐/꺼짐` 토글이 사라지고 통계/로그/후반지시만 남음 — 단일 모드 통합 확인.
  - **LEGEND 아이콘(#218/#184)**: 경기장 토큰이 **등번호 1~11**(v8 에서 보이던 `P0xx` id 노출 해소) + 활성 LEGEND 만 실아트 얼굴 토큰으로 렌더, 나머지 등급은 팀색 원(발행물 `forGrades` 정책대로).
  - **기존 무회귀**: 신규가입 스타터 리빌(춘바페 레전드 + 15명 + 3,000P) · 육성 그리드/상세 · E2 클록 `FIRST_HALF`→정시 `HALFTIME`→자동 `SECOND_HALF`→`FINISHED 1:8` · 성장 리포트 15건 · 보상 100P.
  - `version.json` = **`bd00b07`** / `engine@0.21.0` · `status.sh` 전 항목 ✓.
- **비고**:
  - ⚠️ **배포 blocker 1건 — main(`fcb9a02`)에서 web 빌드가 깨져 있었다**: `apps/web/src/match/live-clock.test.ts(9,3) TS6133 'MS_PER_TICK' is declared but its value is never read`. 빌드가 `tsc --noEmit && vite build` 라 **테스트 파일의 미사용 import 하나가 배포 전체를 막는다**(런타임 영향 0). 백엔드는 이미 v8.01 로 전환된 뒤라 web 만 옛 버전으로 두면 매치 잠금 409 UX 가 깨진 채 라이브가 되므로, 배포 세션이 **그 import 한 줄만** 제거하고(`live-clock.test.ts` 18/18 통과) 배포를 이어갔다 — 그래서 라이브 SHA 가 `fcb9a02` 가 아니라 **`bd00b07`**. **경계 밖(apps/web) 최소 수정**이며, 웹 빌드가 게이트를 통과해 머지된 경위는 web 세션 소관(재발 방지 = 머지 게이트에 `npm run build --workspace=@hmb/web` 포함).
  - 관찰(비블로커, #216 후속 후보): **감독시간 화면 헤더가 `0 : 0` · `0'` 로 보인다** — 같은 시점 API 는 `scoreH1 0:4`. 전반을 4실점하고 하프타임에 들어온 유저에게 0:0 으로 보이는 건 오해를 부른다(재생 위치가 0으로 리셋되면서 헤더 점수도 따라간 것으로 보임). 최종 결과·정산에는 영향 없음(FINISHED 1:8 정상).
  - 프로덕션에 검증 계정 `v801p15243`(잠금·포기·완주 프로브) + 메타 화면 프로브 1건 생성.
  - 롤백 스위치(재배포 불필요): `hmb.prewarm.enabled=false`(#215 이전 동작) · `hmb.match.clock.enabled=false` · `hmb.match.delta.enabled=false`.

---

## 2026-07-27T08:08Z — v8 후속: **AI 실행기(executor)를 v8 코드로 재기동** (#215 prewarm 진단, 코드 변경 0)
- **무엇이 문제였나**: v8 배포(06:36) 당시 java·web 은 `0f14def` 로 갈렸지만, **호스트 프로세스인 AI 실행기는 01:53 에 뜬 그대로**였다 — 그 시점 spider13 체크아웃은 v7(`dc24665`)이라 **#193 servants 최적화(`--effort low` · 델타 프롬프트 · 게이트)가 미적용**. 도커 서비스와 달리 executor 는 배포 스크립트가 건드리지 않으므로 **배포 때마다 별도 재기동이 필요**하다(플레이북 §2-3).
- **조치**: PID 로만 종료(`89753`→`89731`→`89707`→`89705`, 패턴킬 금지) 후 동일 env 로 재기동 — `AI_EXECUTOR=claude-code AI_MODEL=sonnet AI_CONCURRENCY=1 AI_JOB_TIMEOUT_MS=240000`, cwd=`spider13`(`23e3d94`), 로그 `/tmp/hmb-executor.log`(직전 로그는 `/tmp/hmb-executor-v7code.log` 로 보존). 새 워커 pid **18414**. 다른 세션 executor(`:28080`·데모 `:8080`)는 무접촉. 재기동 시점에 queued/leased 잡 0 = 유실 없음.
- **검증(실측)**:
  - **`--effort low` 실린 것 확인** — 잡 실행 중 자식 프로세스 args 직접 포착: `claude -p --output-format json --model sonnet **--effort low** --json-schema {...}`.
  - **프롬프트 캐시 적중 시작** — 재기동 후 잡 usage 에 `cacheRead=30501`(재기동 전 최근 잡들은 `cacheRead=0`).
  - **잡 소요(초, attempts>0 인 실제 AI 호출만)**

    | | 재기동 전(v7 코드) | 재기동 후(v8 코드) |
    |---|---|---|
    | 매치 전술 잡 | 142 · 121 · 190 · 114 | **40 · 10 · 40 · 16** |
    | BASE(team-input) 잡 | 51 · 70 · 294 | **65** (표본 1) |
  - **체감 최대 변화** = 프롬프트를 안 쓴 매치는 **AI 호출 자체가 0**(잡 4건 전부 즉시 `done`, 0s) → **kickoff 이 `GEN1` 을 건너뛰고 바로 `FIRST_HALF`**. 프롬프트를 쓴 매치만 `GEN1` 을 거치고 그마저 10~40초.
- **⚠️ 목표 대비 미달 1건(과장 금지)**: 기대치였던 **BASE 잡 51~91s → 23~37s** 는 **재현되지 않았다** — 유일한 사후 표본이 **65s**. 표본 1개이고 측정 중 이 머신에서 다른 Claude 세션이 다수 돌고 있어(경합) 단정할 수 없다. 매치 전술 잡의 개선(114~190 → 10~40)은 뚜렷하다. BASE 경로 재측정은 #215 트랙에서 표본을 더 쌓을 것.
- **결과**: ✅ 정상 — 라이브 매치 정상 처리(잡 완료·매치 진행), 코드·이미지·DB·web 변경 0. 라이브 버전은 `0f14def` 그대로.

---

## 2026-07-27T06:36Z — **오픈베타 — 릴리스 태그 `v8`** (mstart #193 + units #207 + economy #212 + starter #209, **마이그레이션 V13~V18**)
- **git**: **`0f14def`** = **태그 `v8`(`b3dbd01`) + 배포 전 blocker 픽스 1건**(아래 ⚠️ 참조). 브랜치 `deploy/v7`. v7(`dc24665`) 대비 mstart(#193)·유닛 카탈로그(#207)·재화 리스케일(#212)·스타터 개편(#209)·캐릭터 프롬프트.
- **모듈 버전**: engine **`@0.21.0`** — v7 과 동일(엔진 변경 0) · server-java `0.1.0`(#193 스태틱 선행+대기 중계 · #207 어드민 유닛 카탈로그 · #209 스타터/튜토덱 · #212 재화 리스케일) · web `0.0.0` · servants `0.0.1` · **데이터 발행물 players `v2.3`(180명) · economy `v3`**
- **이미지**(라이브 컨테이너 digest): `hmb-java` `sha256:87057f83fc4d…`(**신규**) · `hmb-runner` `sha256:0cfbfc8557de…`(**신규**)
- **DB 마이그레이션**: Flyway **v12 → v18** (`V13 ai job effective` · `V14 admin unit catalog` · `V15 catalog create idem backstop` · `V16 economy rescale` · `V17 starter rework` · `V18 admin ops audit`) — 전부 success, 15ms. **V8 과 달리 전부 트랜잭션 안**(`.conf` 없음).
  - **백업**: `~/.local/state/hmb/db-backups/pre-v8-20260727T063046Z.db` (32,927,744 B · sha256 `40b8e32b27703667d7d97b4a72a10b3ad4f6e7f80aab71d42be46bc4fd6c8e40` · `integrity_check=ok` · Flyway v12 · users 102 / matches 5 / user_players 1431). v7 배포 이후 **테스터 4명 신규 가입분 포함**.
  - **리허설(라이브 무접촉)**: 백업 사본 + 새 이미지로 18081 기동 → V13~V18 success · `foreign_key_check` 위반 0 · 행수 보존 · **기존 유저 지갑 리스케일 확인**(3,500 → 35,000 P + 6,000 gems) · `tutorial_done` 102명 전원 1 백필 · 신규 가입 최상위 지급 동작.
  - **라이브 적용 후**: `foreign_key_check` 0 · `integrity_check=ok` · users 102 / matches 5 / user_players 1431 **전건 보존** · players **180**(active 163 / inactive 17).
  - 롤백 이미지 고정: `hmb/server-java:prev-live`(v7 `e5c44e2e…`) · `hmb/servants:prev-live`(v7 `57acd096…`).
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev**(고정) · backend=quick tunnel — 배포 시 `ebooks-oriented-shakira-continuous`, **스모크 중 DNS 불안정으로 회전** → 최종 **`https://submission-relates-sites-geography.trycloudflare.com`**(아래 ⚠️). CORS `WEB_ORIGINS=https://hmb-online.pages.dev` 무변경.
- **배포자**: hero(GO) + hmb:deploy(실행)
- **결과**: ✅ GREEN — 요청된 스모크 전 항목 통과.
  - **신규가입 스타터(#209)**: 리빌 연출(카드 뒤집기) → **"춘바페 · 레전드 영입! 선수 15명과 3,000P가 지급되었습니다"** = 최상위 1장 + 기본팩 14장. `GET /api/me/starter-grant` 200(다른 계정은 P177 덕브라이너·P173 보날두 — `sha256(userId)` 결정론 배정 확인). 신규 지갑 **3,000 P + 6,000 gems**.
  - **튜토덱(#209)**: 가입 직후 `/api/deck` **404**(정상) → `POST /api/me/tutorial-complete` **200 `deckGranted:true`** → 4-3-3 **선발 11 + 벤치 4**. 실경기 라인업에 스타터 최상위(덕브라이너)가 선발로 반영됨.
  - **재화 리스케일(#212)**: 기존 유저 `v7probe25` 3,500 P → **35,000 P + 6,000 gems**, `tutorialDone=true`(V17 백필). 승리 보상 **500 P**.
  - **어드민 유닛 API(#207)**: `/api/admin/units` **200**(total **180** = 비활성 포함 전체) · `/api/admin/units/P176` 200(`active=true`, **`dataVersion=v2.3`**, holdings owners 4/copies 4) · `/api/admin/economy` 200(v3 · BAKED · override 미적용) · **비어드민 403**(가드 동작).
  - **LEGEND 8종(#207)**: 카탈로그에 **P173~P180 8종 전부 존재**. 그중 **5종 활성**(P173 보날두·P175 열라도나·P176 춘바페·P177 덕브라이너·P179 욱링엄 = `economy.starterTop` 풀), **3종 비활성**(P174 권씨·P178 석신·P180 경니시우스). 비활성 17종 = 신규 8종 중 3 + **기존 실명 LEGEND 14종** — `players.v2.3.json` 이 `active:false` 로 **발행물에서 선언**한 값(정책이지 결함 아님). 도감/가챠 노출은 활성 163명.
  - **게임시작 대기(#193)**: 킥오프 직후 화면 = `전반 준비 / GEN1 / **AI 감독이 전반 작전 반영 중…** / 경과 0:03…0:25 / 감독의 지시가 선수들에게 전달되고 있습니다 (보통 10초 안팎, 전술을 크게 바꾼 경우 1~2분)` — 경과 타이머 + 기대치 안내 정상.
  - **E2 서버 시계**(v7 무회귀): `FIRST_HALF`(+240s) → **06:54:10 정시 `HALFTIME`**(감독시간 60s, 화면에 `감독시간 0:36 남음` 카운트다운 + 교체 0/3 + 팀/선수 프롬프트) → **06:55:10 만료 자동** `SECOND_HALF` → **`FINISHED 2:1 WIN`**(06:59:15).
  - **성장(#179 무회귀)**: 경기 후 `/api/growth/report/{id}` **200**, entries **15**(선수별 stat XP — 예: Cristian Romero 413).
  - **풀아트(#187 무회귀)**: 스타터 리빌·뽑기 리빌 모두 프레임+풀아트 렌더.
  - `version.json` = **`0f14def`** / `engine@0.21.0` · `status.sh` 전 항목 ✓ · 실패 요청 0 · JS 에러 0.
- **비고**:
  - ⚠️ **배포 전 blocker 1건 발견·수정(`0f14def`)** — `server-java/Dockerfile` 의 `HMB_DATA_PLAYERSFILE` 이 **`players.v2.1.json`** 에 고정돼 있어 `application.yml`(v2.3)을 **덮어쓰고** 있었다. 그대로 올렸으면 컨테이너가 **172명/LEGEND 14**로 떠서 **#207 신규 LEGEND 8종이 프로덕션에 아예 임포트되지 않았다**(무증상 — 에러 없이 조용히 구파일). 리허설에서 잡아 v2.3 으로 고치고 재빌드 → 180명/LEGEND 22 확인. `server-java/CLAUDE.md` 가 경고하던 "yml·Dockerfile 두 곳을 같이 올려라"의 실제 사례라 Dockerfile 주석으로 박제했다. **발행물 버전이 오르는 배포에서는 이 두 곳을 항상 대조할 것.**
  - ⚠️ **hero 로그인 실패 제보 → 원인 = 터널 호스트명 DNS 불안정(앱·CORS·#209 회귀 아님)**. 실측: `ebooks-oriented-…` 은 시스템 리졸버로 **12회 중 9회 즉시 실패**(`http=000`, `time_namelookup=0.000s`)인데 `dig` 로는 정상 해석 — 로컬 리졸버 레벨의 간헐 실패다. 브라우저는 한번 붙으면 자체 DNS 캐시로 유지돼 "새로고침하니까 되네"가 설명된다. 조치 = **터널 회전(PID only) + `publish-backend-url.sh` 로 config.json 재전파**(재빌드 0, CORS 무변경): 새 호스트 `submission-relates-…` 는 같은 조건 **10/10 성공**, 실브라우저 신규가입 login/me/starter-grant 200.
    - 📌 이 때문에 **`version.json` 의 `tunnel.apiUrl` 은 옛 URL 로 남아 있다**(publish 는 `config.json` 만 갱신). 런타임 SoT 는 `config.json` — 앱 동작에는 영향 없지만 조회 시 혼동 주의.
  - v7 에서 넣은 운영 완화(`HMB_MATCH_LEASESEC=300` / `HMB_MATCH_AIJOBTIMEOUTSEC=600`) 유지 — 이번 매치도 AI 잡 완주(#166 은 여전히 열려 있음, #193 이 대기시간 축을 개선).
  - ⚠️ **admin 계정 신규 활성화**: `/api/admin/**` 이 admin 0명이라 전부 막혀 있어(스모크 항목 불가) `HMB_ADMIN_NICKNAME=hmbadmin` + 랜덤 32자 비번을 `infra/.env`(gitignore)에 넣고 java 재기동 → `admin bootstrap: admins=1`. **비번은 리포에 없다**(`infra/.env` + `~/.local/state/hmb/admin-pw-v8.txt`, 600). 로테이션 = 값 교체 후 `docker compose up -d java`.
  - 관찰(비블로커): 감독시간 화면의 피치 선수 토큰이 캐릭터 스킨 대신 ID 칩으로 보였다 — #184(skinBtn hidden 회귀)와 관련 가능성. QA 트랙 확인 대상.

---

## 2026-07-26T16:53Z — v7 대규모 배포 — engine v6(0.18~0.21) + E2 감독시간/서버시계 + 성장 시스템 + 카드 풀아트 (백엔드+web 동시 전환, **마이그레이션 V8~V12**)
- **git**: `dc24665` (브랜치 `deploy/v7` = origin/main) — `Merge pull request #204 from dd0114/card-art/base`. 직전 배포(`79358c0`) 대비 **215 files, +29,012 / −826**.
- **모듈 버전**: engine **`@0.21.0`(릴리스 태그 v6)** — 0.18.0 마크 진동(#178)·0.19.0 공 휨(#181)·0.20.0 코너 전원전진(#182)·0.21.0 데드볼 접근금지(#176) · server-java `0.1.0`(**P4-E2 서버 권위 시계 + 감독시간** #170, **성장/젬/다이스** #179) · web `0.0.0`(E1 S2/S3 뷰어 SoT 수렴 · 육성 화면 · **카드 풀아트 #187**) · servants `0.0.1`
- **이미지**(라이브 컨테이너 digest — 태그 아님, 아래 ⚠️ 참조): `hmb-java` `sha256:e5c44e2e05ab…`(**신규**, 직전 `522996d8…`) · `hmb-runner` `sha256:57acd09620a6…`(**신규**, 직전 `abc37a61…`, runner `/health` → `engine@0.21.0` 확인)
- **DB 마이그레이션**: Flyway **v7 → v12** (`V8 p4 match clock`[**non-transactional**] · `V9 growth` · `V10 maple growth` · `V11 gems` · `V12 growth report snapshot`) — 전부 success, 실행 29ms.
  - **백업(선행조건 이행)**: 볼륨 무중단 온라인 `.backup` → `~/.local/state/hmb/db-backups/pre-v7-20260726T165149Z.db` (24,797,184 B · sha256 `4d3efe7611bda4c3f8efe7fcba7a03de68eee3dc71a936381925082fe25c0834` · `integrity_check=ok` · Flyway v7 · users 98 / matches 4 / user_players 1373). 동일 내용의 1차 사본 `hmb-20260726T151726Z.db` 도 보존.
  - **리허설(라이브 무접촉)**: 백업 사본 + 새 이미지로 18081 에 별도 기동 → V8~V12 전부 success·부팅 성공·`foreign_key_check` 위반 0·자식행(match_prompts/match_halves/ai_jobs) 수 동일·기존 유저 로그인 `isNew:false`·레거시 매치 판독 200. **그 다음에** 라이브 적용.
  - **라이브 적용 후**: `foreign_key_check` 위반 0 · `integrity_check=ok` · users 98 / matches 4 / match_prompts 1 / match_halves 6 / ai_jobs 20 / user_players 1373 — **전건 보존**.
  - 롤백 이미지 고정: `hmb/server-java:prev-live`(`522996d8…`) · `hmb/servants:prev-live`(`abc37a61…`).
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev**(고정) · backend=quick tunnel **`https://farms-medicare-brings-sees.trycloudflare.com`**(워치독이 13:17 에 HEAL_OK 로 세운 터널을 그대로 사용, 이번 배포로 교체하지 않음) · CORS `WEB_ORIGINS=https://hmb-online.pages.dev`
- **executor**: 남의 워크트리(spider10, 07-21 시점 코드)에서 돌던 프로세스를 **PID 로만**(13004/13023/13024) 종료하고 **배포 체크아웃(spider13)에서 재기동** — `AI_EXECUTOR=claude-code AI_MODEL=sonnet AI_CONCURRENCY=1 AI_JOB_TIMEOUT_MS=240000`, 로그 `/tmp/hmb-executor.log`. 다른 세션 스택의 executor(`:28080` 2개, 데모 `:8080` 1개)는 **무접촉**.
- **배포자**: hero(지시) + hmb:deploy(실행)
- **결과**: ✅ GREEN — 실브라우저 왕복 스모크 전 항목 통과(실패 요청 0 · JS 에러 0).
  - **로그인·로비**: 게스트 가입 → 로비 렌더(3,000 P + **💎 0 = V11 젬 지갑**), 사이드바 7탭(홈·덱·**육성**·상점·트레이드·로그·도감)
  - **E2 서버 권위 시계**(API 실측, 화면 없이도 진행): `FIRST_HALF`(`kickoffAt`·`phaseEndsAt`=+240s·`serverNow`·`halfRealMs=240000`·`halftimeMs=60000`·`seekForwardBlocked`) → **17:05:58 정시에 `HALFTIME`**(deadline +60s) → **17:06:58 만료 → 자동 후반** `SECOND_HALF` → `FINISHED` **3:0 WIN**. 전 구간 서버가 시각을 소유.
  - **게임화면**(라이브 매치 실캡처): 캔버스 1050×680 실렌더 · **iframe 0개**(S3 viewer-core 수렴) · 페이지 스크롤 0(S1 고정 셸) · 헤더 `45' 후반 진행 중` 서버시계 · 통계/로그/후반지시 토글
  - **성장(#179)**: `/growth` 보유 14장 그리드 · 카드 상세 = **풀아트 + 성★승급 + OVR/완성도 + 레이더 + 잠재능력** · 경기 후 `GET /api/growth/report/{matchId}` **200**(선수별 stat XP·ovrBefore/After = V12 스냅샷) · 승리 보상 3,000→3,500 P · 전적 1승
  - **카드 풀아트(#187)**: 상점 단뽑 300P → 리빌 모달에 **프레임(`/chars/frame-BRONZE.png`) + 풀아트(`/chars/characters/card-bella.png`)** 정상 로드
  - `https://hmb-online.pages.dev/version.json` = `dc24665` / `engine@0.21.0` / apiUrl=현재 터널 · `/config.json` 동일 오리진 · `bash infra/status.sh` 전 항목 ✓
- **비고**:
  - ⚠️ **운영 완화 1건 적용(config-only, `infra/.env`)** — 라이브 AI 풀매치가 **#166** 으로 처음 FAILED 했다. 실측 원인: claude(sonnet) 전술생성 1건이 **90~180s** 인데 `lease-sec=120` 이 그보다 짧아 작업 중 리스가 만료되고, 실행기가 complete 할 때 **409 not leased** → 재시도 → `ai-job-timeout-sec=240` 초과 → 매치 FAILED. 브리핑 잡(≈91s)이 concurrency=1 에서 앞을 막아 예산을 더 깎았다. → **`HMB_MATCH_LEASESEC=300` · `HMB_MATCH_AIJOBTIMEOUTSEC=600`** 으로 두 창만 넓혀 재시도 → 매치가 끝까지 완주(위 3:0). **코드·이미지 변경 0**, 되돌리기 = `.env` 3줄 삭제 + `docker compose up -d java`. 근본해결은 **#166 / #193**(대기시간 단축) 소관. 이 실패는 v7 회귀가 아니다 — `JobLeaseSweeper`·`ai-job-timeout-sec`·`lease-sec` 는 `79358c0..dc24665` 에서 **무변경**.
  - ⚠️ **이미지 태그가 크로스 세션 공유다**: `hmb/server-java:p3`·`hmb/servants:p3` 를 **`hmb-growth` 스택(`spider8/hmb-growth`, 포트 19080/19790, 별도 볼륨 `hmb-growth-db`)** 도 쓴다. 배포 직전 확인 시 그쪽 빌드가 태그를 점유하고 있었다(라이브 컨테이너는 옛 digest 라 영향 없었음). 이번 배포로 태그는 다시 이쪽 빌드가 됐다 — **그쪽이 recreate 하면 이 빌드를 집어간다.** "라이브에 뜬 것"의 SoT 는 태그가 아니라 컨테이너 digest(위에 기록).
  - 백엔드·web 을 **같은 창에서 전환**했다(옛 web 은 `FIRST_HALF` 등 E2 신규 state 를 모른다). 백엔드 recreate → web 빌드·배포 → CORS 재결선까지 약 3분.
  - 플레이북에 **§8 DB 백업·복원** 절 신설(백업·검증·리허설·복원·태그 공유 주의) — 다음 마이그레이션 배포부터 이 절을 따른다.
  - 프로덕션 DB 에 검증 계정 `v7probe25`(게스트, 덱·완주 매치 1건 보유) + 뽑기 프로브 게스트 2건 생성됨.

---

## 2026-07-25T18:30Z — 터널 자가복구(#183) 배포 — web only(런타임 config) + 워치독 설치
- **git**: `099d0c2` (브랜치 `infra/tunnel-heal`, base main `79358c0`) — `[Spider] feat(infra): 터널 자가복구 — 런타임 config + launchd 워치독 (#183)`
- **모듈 버전**: engine **`@0.17.0`(v5.01)** — **변경 0** · server-java `0.1.0` · web `0.0.0`(**런타임 config 배선**: 부팅 시 `/config.json` 에서 백엔드 오리진을 읽고 빌드타임 `VITE_API_BASE` 는 폴백으로 강등) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:522996d8…`(무변경) · `hmb/servants:p3` `sha256:abc37a61…`(무변경) — **도커 재빌드 없음**, 컨테이너 무접촉
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev**(고정) · backend=quick tunnel — **검증 중 의도적으로 여러 번 교체됨**(kill 테스트 2회 + F2 1회 + 자발적 사망 2회), 최종 `alternate-members-loc-tulsa.trycloudflare.com` · CORS `WEB_ORIGINS` 무변경(Pages URL 고정)
- **배포자**: hero(승인) + hmb:infra(실행)
- **결과**: ✅ GREEN.
  - **자가복구 실측(사람 개입 0)**: 터널 강제 kill → **MTTR 98초** · 프로세스 생존+터널 사망(F2, 07-22 패턴) → **53초** · 백엔드 사망 시 터널 재기동 보류(스래시 가드) 확인 · 터널 정상+web 스테일 → `PUBLISH_ONLY` 자동 전파(실전 발동)
  - **실브라우저 왕복**(Playwright, Pages→치유된 터널): 게스트 가입 → 스타터팩 **3,000P 지급** 렌더, **실패 요청 0건**
  - 게이트: `npm test` **1126 passed / 0 failed**(결정론 80회 desync 0) · `client.test.ts` 36/36(런타임 config 계약 7건 신규)
  - `https://hmb-online.pages.dev/config.json` = 현재 백엔드(워치독이 갱신) · `Cache-Control: no-store`
- **비고**:
  - **운영 방식이 바뀌었다**: 터널 URL 이 바뀌어도 **재빌드/재배포 불필요** — `bash infra/publish-backend-url.sh <새URL>`(≈10초) 또는 워치독이 자동 처리. 플레이북 §3·§3.5.
  - 워치독 = launchd `online.hmb.tunnel-heal`(60초, **Claude 호출 0**). 설치/해제 = `infra/install-tunnel-heal.sh`. 이벤트 로그 `~/.local/state/hmb/tunnel-heal.log`.
  - 부수 설치: `wrangler` 전역(`npm i -g`) — `npx -y` 가 실행마다 수 분 걸려 MTTR 을 잡아먹었다(전파 4분 → 10초).
  - 마지막 배포 dist 스냅샷을 `~/.cache/hmb/dist-current` 에 보존한다(워치독이 config 만 갈아끼워 재배포하는 원본). **다른 워크트리에서 배포하면 이 스냅샷이 갱신된다** — 항상 "마지막에 배포한 코드" 를 유지하는 설계.
  - ⚠️ 검증 중 launchd 전용 버그 4건이 드러나 수정됨(프로세스 그룹 회수·wrangler cwd·API 행·시도 카운트) — 상세 = `docs/plan-v4/tunnel-resilience.md` §7.2.

---

## 2026-07-25T17:14Z — 🚨 백엔드 터널 사망 → 즉시복구 재배포 (코드 변경 0, 터널 URL 만 변경)
- **사건**: 직전 배포의 백엔드 quick tunnel `enhanced-metal-portsmouth-thanks.trycloudflare.com` 이 **글로벌 DNS 에서 NXDOMAIN = 죽음**. `cloudflared` 프로세스(pid 50613)는 살아 있었으나 **호스트명 등록만 유실** — 로그가 `2026-07-25T17:10Z` 까지 `control stream encountered a failure while serving` → `Retrying connection in up to 1m4s` 무한 루프(재등록 실패). 배포된 web(Pages)은 빌드타임에 이 죽은 URL 이 인라인돼 있어 **테스터 전원 API 실패**(`Failed to fetch`).
- **git**: `79358c0` (`p4dep/fix` = main 내용 동일) — `[Spider] docs(deploy): 2026-07-25 재배포 기록 — E1 게임화면 S1+S2+S3 (web only, #171)`. **직전 배포와 코드 동일** — 이번 배포는 순수 인프라 복구.
- **모듈 버전**: engine **`@0.17.0`(릴리스 태그 v5.01)** · server-java `0.1.0` · web `0.0.0` · servants `0.0.1` — **전부 직전과 동일**
- **이미지**: `hmb/server-java:p3` `sha256:522996d8…`(무변경) · `hmb/servants:p3` `sha256:abc37a61…`(무변경) — **재빌드 0**. `hmb-runner` 는 무접촉(3일 연속 가동 유지), `hmb-java` 만 CORS 재결선으로 recreate.
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel **`https://confidential-yoga-book-demand.trycloudflare.com`** (신규, pid 85315, `location=icn01 protocol=quic`)
- **CORS**: `WEB_ORIGINS=https://hmb-online.pages.dev` **만** — 직전까지 누적돼 있던 스테일 quick-tunnel 오리진(`towers-flights-chemistry-scheme…`) **제거**. (`deploy-pages.sh` 는 콤마로 append 하는 구조라 죽은 오리진이 계속 쌓였다.)
- **배포자**: hero(지시) + hmb:p4dep(실행)
- **결과**: ✅ GREEN — 즉시복구 완료.
  - 복구 절차: pid **50613 만** kill(패턴킬 금지·PID only) → `cloudflared tunnel --url http://localhost:18080` 재기동 → 새 URL 확보 → `infra/deploy-pages.sh <새URL>`.
  - **DB 볼륨 `hmb-p3-db` 보존**(`down -v` 미사용). `hmb.db` **24.79MB** 유지, java recreate 후 동일 유저 재로그인 시 `isNew:false`+동일 `user.id` → 테스터 데이터 무손실 확인. Flyway `schema version=7` 그대로, 마이그레이션 없음.
  - **터널 왕복(DNS 우회 필수)**: `curl --resolve <host>:443:104.16.231.132` → `POST /api/auth/login` **200** · preflight `OPTIONS` **200** + `access-control-allow-origin: https://hmb-online.pages.dev`. 시스템 DNS 그대로도 **200**(아래 비고).
  - **실브라우저 스모크**(Playwright chromium `--host-resolver-rules=MAP <host> 104.16.231.132`, Pages→새 터널): 게스트 로그인 → **`/api/auth/login 200` · `/api/me 200` · `/api/relations 200`**, 로비 렌더(지갑 **3,000 P**, 사이드바 5탭), **실패 요청 0건 · JS 에러 0건**.
  - `https://hmb-online.pages.dev/version.json` = `79358c0` / `engine@0.17.0` / `apiUrl=https://confidential-yoga-book-demand.trycloudflare.com`. 배포 번들(`/assets/index-DmRDe44n.js`)에 **옛 URL(`enhanced-metal-…`/`towers-flights-…`) 잔존 0건**.
  - `bash infra/status.sh` — java/runner healthy · 로컬 health 200 · 터널 200 · Pages 200 · CORS 결선 ✓.
- **비고**:
  - 🔧 **DNS 정정**: 직전 기록의 "이 머신 ISP DNS 가 `*.trycloudflare.com` 을 전부 NXDOMAIN" 은 **부정확**. 실제로는 **죽은 터널 호스트만** NXDOMAIN 이고, 새 터널 호스트·`trycloudflare.com` apex 는 시스템 리졸버(121.88.255.50)로 정상 해석된다. 즉 **NXDOMAIN = 터널 사망의 증상**이지 리졸버 정책이 아니다. 다만 전파 지연 대비로 검증은 `--resolve` / `--host-resolver-rules` 우회를 병행했다(위 결과 = 우회·비우회 모두 200).
  - ⚠️ **재발 예상**: quick tunnel 이 유휴 중에도 재등록에 실패해 조용히 죽는 것이 **이번이 3회 연속**(`insured-stakeholders…` → `editors-hopes…` → `enhanced-metal…`). 이번 터널도 등록 커넥션이 **1개(connIndex=0)** 뿐이라 단일 장애점. **도메인 없는 자동치유(런타임 config + 정적 감시자)는 별도 세션·에픽으로 분리** — 본 세션 스코프 밖.
  - 📦 **배포 소유 체크아웃 이동**: compose 실행 위치가 `spider9/…/infra` → **`spider13/…/infra`**(p4dep 세션). compose 프로젝트명은 파일에 고정(`name: hmb-p3`)이고 볼륨도 `name: hmb-p3-db` 라 **동일 스택·동일 볼륨**을 그대로 이어받았다. `infra/.env`(gitignore)만 복사, `SERVANT_TOKEN` 동일 확인.
  - AI 실행기(모드 A)는 기존 호스트 프로세스(spider10, pid 13024) 계속 가동 — java recreate 10초 구간에만 `fetch failed` 재시도, 이후 정상 롱폴링 복귀. (`status.sh` 의 executor 판정은 `pwd` 로 프로세스를 매칭해 **다른 체크아웃에서 띄운 executor 를 못 잡는 오탐** — 스크립트 한계, 실 프로세스는 확인됨.)
  - 검증 계정 `deploy-probe`(게스트)가 프로덕션 DB 에 생성됨 — 왕복 증빙용 프로브.

---

## 2026-07-25T09:45Z — E1 게임화면 S1+S2+S3 완료본(뷰어 SoT 수렴) 배포 — web only
- **git**: `39eded4` (main = `p4dep/base`) — `[Spider] feat(dev-viewer): QA 뷰어 캐릭터 스킨 토글 (#169 S3, hero)`
- **모듈 버전**: engine **`@0.17.0`(릴리스 태그 v5.01)** — **직전 배포와 동일, 엔진 변경 0** · server-java `0.1.0` · web `0.0.0`(**P4-E1 S1+S2+S3** 고정 셸·정보 토글 + 재생 컨트롤 web 소유 + **iframe 제거 → web 이 `@hmb/viewer-core` 직접 마운트**) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:522996d8…`(무변경) · `hmb/servants:p3` `sha256:abc37a61…`(무변경) — **도커 재빌드 없음**(엔진 무변경). 컨테이너는 2일 연속 가동분 유지, java 만 CORS 재결선으로 recreate.
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel **`enhanced-metal-portsmouth-thanks.trycloudflare.com`** (직전 터널 `editors-hopes-…` 이 등록 만료 — cloudflared 프로세스는 살아 있었으나 호스트명이 NXDOMAIN·`control stream failure` 재시도 루프 → PID 로 종료 후 재기동, URL 변경) · CORS `WEB_ORIGINS=towers-flights-…,hmb-online.pages.dev`
- **배포자**: hero(지시) + hmb:p4dep(실행)
- **결과**: ✅ GREEN.
  - 백엔드: runner `engineVersion=engine@0.17.0` · java/runner 둘 다 healthy · **DB 볼륨 `hmb-p3-db` 보존**(`down -v` 미사용, hmb.db 24.8MB — 직전 24.7MB 대비 증가 = 테스터 데이터 유지). 컨테이너는 이 체크아웃(`spider9/…/infra`, compose project `hmb-p3`) 소유로 확인.
  - 왕복(실브라우저 Playwright, Pages→터널): 게스트 로그인 → 로비 지갑 **3,000P** 렌더, **실패 요청 0건** · 터널 직접 `POST /api/auth/login 200`
  - **게임화면 S1+S2+S3**(배포 번들 + /api 목킹 캡처): **iframe 0개**(S3 수렴 확인 — web 이 viewer-core 직접 마운트) · 캔버스 1050×680 실렌더(고유색 307, 빈 픽셀 0 — 피치·선수·트레일·`TACKLE` 자막 육안 확인) · 데스크탑 1280×800 페이지 스크롤 **0**, 정보 시트 **208px**(=26svh) 불변, 토글(통계·로그) 켜도 무대 유지·탭 3개 · 모바일 390×844 스크롤 0, 로그 시트 열어도 무대 유지
  - `https://hmb-online.pages.dev/version.json` = `39eded4` / `engine@0.17.0` / apiUrl=새 터널
- **비고**:
  - 이번 배포는 **web 전용**(엔진·server-java·servants 산출물 무변경). 백엔드는 상태 점검 + 터널 재기동만.
  - 락파일은 이미 동기화돼 있어 `npm ci` 무사통과(직전 배포의 `@hmb/viewer-core` 누락 이슈 재발 없음).
  - AI 실행기(모드 A)는 기존 호스트 프로세스(spider10, pid 13024) 계속 가동 — 이번 스모크 범위엔 라이브 AI 매치 미포함.

---

## 2026-07-22T16:11Z — engine v5.01(시야·파울) + E1 S1 게임화면 개편 배포
- **git**: `d5b55d5` (main = `p4dep/base` ff) — S1 머지 `5853dcd` + 로그 시트 26svh `09bdc04` 포함
- **모듈 버전**: engine **`@0.17.0`(릴리스 태그 v5.01)** — 오프더볼 시야 인지·판단 + 파울/옐로 벤치 복원 · server-java `0.1.0` · web `0.0.0`(**P4-E1 S1** 고정 셸·정보 토글·viewer-core, 정보 시트 26svh) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:522996d8…`(무변경 — 5853dcd~d5b55d5 에 server-java 변경 없음, 캐시 전체 히트) · `hmb/servants:p3` `sha256:abc37a61…`(**신규** — 엔진 0.17.0 반영, runner `/health` 로 확인)
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel `editors-hopes-chance-dozen.trycloudflare.com` (직전 터널이 죽어 있어 재기동 → URL 변경) · CORS `WEB_ORIGINS=towers-flights-…,hmb-online.pages.dev`
- **배포자**: hero(지시) + hmb:p4dep(실행)
- **결과**: ✅ GREEN.
  - 백엔드: runner `engineVersion=engine@0.17.0`(재빌드 전 0.16.0) · java/runner healthy · **DB 볼륨 `hmb-p3-db` 보존**(`down -v` 미사용, hmb.db 24.7MB — 직전 16.7MB 대비 증가 = 테스터 데이터 유지)
  - 왕복(실브라우저 Playwright, Pages→터널): 게스트 로그인 → 지갑 3,000P 렌더, 실패 요청 0건 · API 직접 `login 200 / me 200 / deck 404`(새 유저 = 정상)
  - **S1 게임화면**: 데스크탑 1280×800 — 페이지 스크롤 **0**, 셸=뷰포트 높이 800, 정보 시트 **208px = 26svh 정확 일치**(로그 토글), 통계 추가 후에도 시트 높이 불변(무대 보호) · 모바일 390×844 — 페이지 스크롤 0, 탭 3개(결과/통계/로그) 정상. 실캡처 확인(무대·자막·토글바 렌더 OK)
  - `https://hmb-online.pages.dev/version.json` = `d5b55d5` / `engine@0.17.0`
- **비고**:
  - ⚠️ **락파일 동기화 커밋 포함**: PR #169 이 `packages/viewer-core` 워크스페이스를 추가하면서 `package-lock.json` 을 갱신하지 않아 `npm ci` 가 `Missing: @hmb/viewer-core@0.1.0` 로 실패 → **Pages 빌드가 막혔다**. 루트 `npm install` 로 동기화(워크스페이스 링크 2개, 8줄, 의존성 버전 변동 0). 워크스페이스 추가 시 락파일 동반 커밋 = apps/web 세션 위생 이슈로 레이즈 필요.
  - 매니페스트 `git.dirty=true` 는 위 락파일 수정분(배포 후 커밋됨).
  - 이 머신의 ISP DNS(168.126.63.1)가 `*.trycloudflare.com` 을 전부 NXDOMAIN — 로컬 curl/브라우저만 영향(외부 테스터 무관). 스모크는 Chromium `--host-resolver-rules` 로 CF IP 고정해 수행.
  - AI 실행기(모드 A)는 기존 호스트 프로세스가 계속 가동 중(spider10, pid 13024) — java 재생성 후에도 동일 토큰/포트라 재연결.

---

## 2026-07-21T17:16Z — web 스킨 재배포 (main 정합)
- **git**: `bfb3b16` (main) — 직후 `8adfaab`(W4 문서)까지 포함 main
- **모듈 버전**: engine `@0.16.0` · server-java `0.1.0` · web `0.0.0`(main 빌드, 스킨 #145·트레이드·matchui 포함) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:bc39c33d…` · `hmb/servants:p3` `sha256:bc249f7e…`
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel `insured-stakeholders-laid-silicon.trycloudflare.com`
- **배포자**: hero(토큰) + hmb:p3dep(실행)
- **결과**: ✅ GREEN. 스킨 렌더 확인, 로그인→왕복 200, DB 볼륨(hmb-p3-db 16.7MB) 보존.
- **비고**: 초기 배포(2026-07-21T15:53, `8aa1da0` p3dep/base)는 스킨 누락 → main 재빌드로 복구. **미포함**: qa `#147` 엔진 시야(engine/base 미머지, hero sign-off 대기) → 이 배포 엔진은 `@0.16.0`.

---
<!-- 새 배포는 이 줄 위에 최신순으로 추가 -->
