# 배포 기록 (deploy-log) — append-only

> **정책(P4-D5 / #171)**: 배포할 때마다 이 파일 맨 위(최신순)에 항목을 append 하고 커밋한다.
> "언제 무슨 버전이 배포됐나"의 SoT. AI·사람이 repo에서 바로 조회. `infra/version-manifest.sh` 산출을 여기에 옮겨 적는다.
> 항목 형식: 배포시각(UTC) · git SHA/브랜치 · 모듈별 버전(engine/server-java/web/servants) · 이미지 다이제스트 · tunnel/URL · 배포자 · 결과/비고.

---

## 2026-07-30T23:24Z — **배포 v3.04** (태그 `deploy-3.04`) — 원정 복수(V34) + 랭킹보드·전적 API(#319) + 404 위생(#335) + viewer-core(#324/#334) + web 다수

- **git**: **`0d0b7a5`**(태그 `deploy-3.04`). 변경 = `packages` 30 · `server-java` 22 · `apps` 19 · `tools` 3 · docs 3.
- **모듈 버전**: engine **`@0.23.0`**(버전 무변경 — `packages/engine/src` 는 손대지 않았고 dev-viewer e2e·inline-core 만 바뀌었다) · server-java `0.1.0` · web `0.0.0` · servants `0.0.1`
- **이미지**: `hmb-java` `sha256:5e81a4bee72a…`(**신규**) · `hmb-runner` `sha256:7f73d3154d1f…`(**신규** — `packages/shared` 변경 반영차 재빌드)
- **executor**: `packages/server`(prompt/gates·coach)·`packages/shared` 가 바뀌어 **재기동**(PID only, 새 워커 12913).
- **DB**: Flyway **v33 → v34**, 1건 — `V34__away_revenge`. **§0.5-2/7 성격**: `.conf` 없음(트랜잭션 내) · **파괴적 구문 0** · 내용은 `away_reports` **ADD COLUMN ×3**(`revenge_attempts`·`revenge_state`·`from_revenge`) + `away_challenges` **ADD COLUMN ×1** + 인덱스 1 = **순수 additive**. 백업 `pre-deploy304-20260730T232109Z.db`(421,175,296 B · sha256 `f97766eb00b4ef6e8b290e42e62326683b4a91d20b3dbae4b9301019f5c679d4` · integrity ok · users 187 · away_reports 7). 적용 후 신규 컬럼 4개 확인 · away_reports **7행 보존** · integrity ok.
- **✅ §0.55 첫 적용(#310)**: 경기 완주 스모크를 **고정 계정 `deploy-smoke`** 로 돌렸다(로그인 `isNew:false` 확인). 가입 확인용은 새 계정으로 하되 **경기를 시키지 않았다** → 이번 배포로 리더보드에 **새로 쌓인 스모크 계정 0**.
- **결과**: ✅ GREEN (JS 에러 0)
  - **#319 랭킹보드·전적(W5 4구역)** — `/me` 화면에서 **실데이터**로 확인: ①프로필/전적(디비전·원정 레이팅·승률·연승) ②**🏅 리그 순위**(미자격이면 "아직 순위에 오르지 않았습니다") ③**🏅 원정 순위 — 시즌 1** 리더보드(햄춘 20 · 전기석 10 · 별희 10 · 축구왕여르 −20·1연승 …) ④경기/트레이드/랭킹 탭 + 전체·연습·리그 필터. API 도 전부 200(`/api/rankings` leaderboard 20 + me + personalRecords · `/api/away/season` seasonNo 1 · `/api/me/away-reports` · `/api/me/matches`).
  - **원정 복수(V34)**: **`GET /api/away/revenge` 200**(`entries: []` · `remainingToday: 10`) — `deploy-smoke` 는 피습 이력이 0이라 목록이 비는 게 정상이고, 서버가 V34 컬럼(`revenge_attempts`·`revenge_state`)을 실제로 읽는 것까지 확인(`AwayService`). *복수 매치 실행까지는 피습 이력이 필요해 이번엔 미실행 — 다음 열차나 hero 실플레이 대상.*
  - **#324 경기 재생 — 포지션 겹침 0**: `deploy-smoke` 진행 매치를 실화면으로 확인, **양 팀 토큰 22개가 전부 분리 렌더**(겹침 없음). 덤으로 **#322b 사이드 라벨**도 확인 — 헤더가 `deploy-smoke [내 팀] 0 : 0 그린 밸런스`.
  - **#335 404 위생**: `/api/nope` · `/api/matches/BOGUS` · `/api/notices/<없는ULID>` · `/api/mails/BOGUS` **전부 404 + JSON 에러 바디**(과거 `500 "No static resource"` 였던 자리).
  - **메시지함 무회귀**: `GET /api/mails` 200.
  - `version.json` = **`0d0b7a5`**.
- **📌 발견 — `matches → bots` FK 위반 11건(이번 배포 무관, 선행 상태)**: 배포 후 `PRAGMA foreign_key_check` 가 **11건**을 보고했다. **배포 전 백업에서도 동일하게 11건** — 즉 V34 가 만든 것이 아니다. 원인은 **리그 시즌 롤오버**: 봇 팀이 시즌 ULID 접두(`01KYTNA47…-T1` …)로 새로 생성되고 지난 시즌 봇 행은 사라지는데, 그 시즌의 `matches.bot_id` 는 남아 고아가 된다. 지금은 조회에 영향이 없지만 **`matches` 를 재작성하는 마이그레이션(V8·V19·V21 계열)이 또 오면 위험**하다(그 계열은 `foreign_keys=OFF` 로 우회해 통과해 왔다). → **후속 이슈 권고**: 시즌 롤오버 시 봇 행을 지우지 말고 비활성화하거나, 매치가 참조하는 봇은 보존.
- **비고**: 스모크 중 `/api/matches/{id}` 한 건이 `NETFAIL`(터널 간헐) — 재시도 정상. 배포 자체와 무관.

---

## 2026-07-30T23:00Z — **배포 v3.03** (태그 `deploy-3.03`) — 메시지함(#323, V33) + OG 업로드 자산 오리진 픽스(#320)

- **git**: **`4dae827`**(태그 `deploy-3.03`). 변경 = `apps/web` 43 + `server-java` 15 + `infra` 3(Pages Function #320) + docs 6.
- **모듈 버전**: engine `@0.23.0`(무변경) · server-java `0.1.0`(#323) · web `0.0.0` · servants `0.0.1`(무변경 — `packages/**`·`data/**` 접촉 0)
- **이미지**: `hmb-java` `sha256:096cd7ba90b2…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(무변경)
- **DB**: Flyway **v32 → v33**, 1건 — `V33__mailbox`. **§0.5-2/7 성격 확인**: `.conf` 없음(트랜잭션 내) · **파괴적 구문 0** · 내용은 **신규 표 2개(`mail_campaigns`·`user_mails`) + 인덱스 4개 = 순수 additive**. 백업 `pre-deploy303-20260730T225809Z.db`(421,138,432 B · sha256 `e60f62698dbab452d2f3f6a5f36fe2ba9e17697a0d593dbc31609914fc5fd8f8` · integrity ok · users 185). 적용 후 FK 0 · integrity ok · 신규 표 2개 확인.
- **③ override**: 발행물 변경 0 → 유지.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **#323 발송→수령 왕복(스모크 계정)**: `POST /api/admin/mails` **201**(`audience=USERS` · targetCount 1 · applied true) → 유저 `GET /api/mails` **200 1통**(첨부 `points 100 / gems 10`) → **`claim` 200 `applied:true`**, 지갑 `3,000/12,000 → 3,100/12,010` → **재수령 멱등 확인**(200 이지만 `applied:false`, granted 0 = 중복 지급 없음) → **젬 원장==지갑 불일치 0** · integrity ok.
  - **홈 헤더 A안(#323)**: 헤더가 `● 3,100 G · 💎 12,010 Z · 로그아웃` 으로 **닉네임 제거**됐고, 버튼은 `공지 — 안 읽음 2건` · **`우편함`** · `로그아웃`. 우편함 열면 `[제목] · 운영팀 · 날짜 · **100 G** · **10 Z** · 수령 완료` — 첨부 표기도 **G/Z 통일**.
  - **정리(산출물 원복)**: 스모크 캠페인 **revoke 200**(`unclaimed: 0` — 이미 수령분은 건드리지 않는 설계 그대로). 대상은 프로브 계정 1명뿐이라 실유저 영향 0.
  - **무회귀**: 홈 5탭·지갑 표기·공지 팝업·가입 동선.
  - `version.json` = **`4dae827`**(직후 첫 조회는 또 CDN 캐시로 옛 SHA — `?cb=` 로 확인).
- **📌 #320 은 코드 레벨까지만 확인**: OG Function 의 `absolutize()` 가 **`/api/` 로 시작하면 `apiBase`(백엔드 오리진)를 붙이고**, 그 외 `/` 경로는 web 오리진, `apiBase` 를 모르면 빈 문자열로 기본 이미지 폴백 — 업로드 자산이 Pages 오리진으로 잘못 절대화되던 것을 고치는 로직이 맞다. 다만 **현재 활성 공지 2건이 모두 baked 이미지**(`/notice/hero-kyeongnicius.webp`)를 쓰고 업로드 자산 2건은 비활성이라, **업로드 자산으로 end-to-end 실증은 하지 않았다**(프로덕션 공지를 만들지 않기 위해). 업로드 이미지를 쓰는 공지가 올라가는 시점에 `og:image` 가 백엔드 오리진으로 나오는지 확인하면 된다.

---

## 2026-07-31 — [결정] **named tunnel 승격 중단** (hero 확정, 배포 아님)

- **결정**: 상시 고정 URL(named tunnel + `hmb-online.com`) 승격을 **하지 않는다**. **현행 quick tunnel + 워치독 + 런타임 config 전파 구성을 유지**한다. 플레이북 §6 을 "중단" 기록으로 대체했고, **다시 제안하지 않는다**.
- **경위**: 도메인 구매·계획 수립(단절 0 병행 전환)까지 갔으나 전제인 `cloudflared tunnel login` 이 **약 8분 폴링 타임아웃**이라 "URL 을 올려두고 나중에 승인" 방식이 **3회 연속 만료**됐다(로그 실측: `Waiting for login...` 52초 간격 9회 후 포기). 대시보드 연결 토큰 대안까지 제시한 뒤 hero 가 중단을 확정했다.
- **정리**: login 프로세스·임시 파일(`/tmp/cf-login.*`) 전부 정리, `~/.cloudflared` 는 **빈 디렉토리**(cert 미생성). 인프라·서비스 변경 **0**.
- **남은 전제(그대로 유효)**: 터널 URL 은 바뀐다 → web 은 `/config.json` 을 읽고 워치독이 그 파일만 갱신, 수동 복구는 `publish-backend-url.sh <새URL>` 한 줄. **2026-07-30 반쪽 치유 갭 2·3(전파 결과 미확인 · 치유 직후 생존 미검증)은 열린 채로 남는다** — 재발 시 §3 수동 절차로 복구한다(갭 1은 `grep -a` 로 닫음).

---

## 2026-07-30T16:44Z — **배포 v3.02** (태그 `deploy-3.02`) — 리그 어웨이 라운드 좌우/점수 반전 픽스(#322) + 워치독 하드닝

- **git**: **`c3bef56`**(태그 `deploy-3.02`). 변경 = `apps/web` 8 + `server-java` 3(본체 1: `MatchService`) + `infra` 2(어제 반쪽치유 하드닝, 이미 적용분) + docs.
- **모듈 버전**: engine `@0.23.0`(무변경) · server-java `0.1.0` · web `0.0.0` · servants `0.0.1`(무변경 — `packages/**`·`data/**` 접촉 0 → runner·executor 무관)
- **이미지**: `hmb-java` `sha256:e8a0bf3ee3c3…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(무변경)
- **DB**: **신규 마이그레이션 0**(Flyway **v32** 유지). 표준 백업 — `pre-deploy302-20260730T164106Z.db`(421,138,432 B · sha256 `c06981958e0cb5d62cd49b841f81d8b076961403e43ed3102db1299902ce9f71` · integrity ok · users 185).
- **결과**: ✅ GREEN
  - **#322 픽스 검증(임퍼소네이션 없이 2단 증빙)**:
    1. **응답 계약 신설 확인** — `GET /api/matches/{id}` 가 이제 `homeName`/`awayName` 을 **사이드 라벨 그대로** 내려준다(내 프로브 연습 매치: `ownerName=d301r…` · `homeName=d301r…` · `awayName=그린 밸런스`).
    2. **문제 매치의 사이드 근거** — 라이브 DB 에서 hero 가 지목한 케이스를 직접 확인: `01KYS2QM76…`(1:5, **result=WIN**)·`01KYR0PNQZ…`(0:4, **WIN**) 둘 다 `league_fixtures.home_team = 봇팀(…-T6/-T8)`, **`away_team = USER`** → **유저가 away 사이드**. 즉 **데이터는 처음부터 맞았고**(그래서 result=WIN) 옛 web 이 `homeName = ownerName` 으로 박아 **표시만** 뒤집혔던 것. 새 응답은 home=봇/away=유저로 내려가므로 과거 매치도 **재배포만으로 표시가 즉시 정상화**된다.
    - 📌 **화면(좌우 배치) 최종 확인은 남겨 뒀다** — 그 매치는 테스터 `축구왕여르` 소유라 재생하려면 그 계정 세션이 필요하다. 남의 계정에 로그인하지 않고 위 2단으로 갈음했다. **소유자(hero)가 그 경기를 한 번 열어보는 것이 가장 정확한 최종 확인**이고, 지시하면 즉시 대신 확인한다.
  - **원인 문서화가 인상적** — 서버 주석이 *"ownerName 을 '(홈)'이라고 적지 마라 — 이 문장이 실제로 버그를 만들었다"* 로 바뀌었다(계약 문구가 web 을 잘못 인도한 사례, 라이브 리그 20경기 중 7건·유저 3/3).
  - **무회귀**: 가입·홈 5탭·매치 진입·지갑 표기.
  - `version.json` = **`c3bef56`**.
- **비고**: 이 배포는 **현행 quick tunnel 위에서** 진행했다(main 조율 순서 — 다음 단계가 named tunnel 승격). 백엔드 `record-houston-learners-airplane`(5/5 정상).

---

## 2026-07-30T15:05Z — [운영 조치] ↩️ **오시야스 오픈 철회** — P182 비활성 + 합류 공지·이미지 내림 (배포 아님)

- **지시**: hero — *"오시야스 비활성화 해두고 공지도 잠시 내리자. 아직 오픈할때가 아니야."* 세션 `hmb:osinotice`. 바로 위 14:25Z 항목의 **철회**다. 전말 = **#246 코멘트**.
- **전부 되돌릴 수 있는 형태로만 내렸다 — 삭제한 것 0**:
  | 대상 | 액션 | 결과 |
  |---|---|---|
  | 공지 `오시야스 합류!` `01KYSPMF7SEMJA7K98D5ZMGYBX` | `POST …/active {"active":false}` | 200 · `status OFF` · rev 1 유지 |
  | 유닛 `P182` | `POST /api/admin/units/P182/deactivate` | 200 · `auditId 01KYSQTYW622TRB2AEYS5S0GCD` |
  | 히어로 이미지 `01KYS71M3DHHP6J1SY52M69X9E` | `POST …/assets/{id}/active {"active":false}` | 200 · 공개 GET **404** 전환 확인 |
- **이미지까지 내린 건 지시에 없지만 같이 했다** — 미공개 캐릭터 히어로 이미지가 공개 URL 로 계속 받아지고 있었다. V30 설계상 자산 비활성은 **서빙만 404 이고 바이트·행은 보존**이라 되돌리는 비용이 0 이다.
- **검증**(라이브 실측): 활성 공지 **1건**(업데이트 안내 p=5 뿐) · `P180 활성 · P181 비활성 · P182 비활성` · `/api/players` **165 → 164**(P182 미노출) · 획득 가능 LEGEND **FW 3 · MF 3**(GK **0** 으로 복귀) · 히어로 이미지 공개 GET **404**. 뽑기 풀은 `loadPools()` 가 `WHERE active=1` 을 뽑기마다 재조회하므로 재시작 없이 즉시 빠졌다.
- **다시 열 때 = 3번 뒤집으면 끝**(재작업 0): `units/P182/activate` + `notices/assets/{id}/active true` + `notices/{id}/active true`. ⚠️ **자산과 공지는 같이 켜라** — 공지만 켜면 본문 이미지가 404 다. 문안·이미지·우선순위(10, 팝업 1장째)는 그대로 보존돼 있다.
- **그대로 둔 것**: 패치노트 공지(p=5)는 유닛 오픈과 무관해 **유지**(현재 유일한 활성 공지). 경니시우스 공지는 내려간 채 유지. **#320**(V30 이미지 OG 썸네일 깨짐)·**#321**(GK 능력치 미반영)은 이 철회와 무관하게 유효 — 특히 **#320 은 다시 열 때 같은 문제가 그대로 재현된다**.

---

## 2026-07-30T14:25Z — [운영 조치] 오시야스(P182) 오픈 + 공지 2장 교체 (배포 아님 — 코드·이미지 변경 0)

- **지시**: hero — *"오시야스 공지 만들자. 경니시우스 공지 내리고 오시야스로 올리고, 패치내용도 지금 것 닫고 새 패치내용 한 장. 순서는 오시야스가 더 앞쪽으로."* 세션 `hmb:osinotice`. 전말 = **#246 코멘트**.
- **전부 admin API**(무배포·무중단): 컨테이너·이미지·git SHA 무변경, 재시작 0, Flyway 무변경(v32 유지). **배포 v3 의 V30(공지 이미지 업로드)을 실제 운영에 처음 태운 건**이다 — 이미지까지 배포 없이 나갔다.
- **① 유닛**: `POST /api/admin/units/P182/activate` **200**(사유 기입, `auditId 01KYS6XBCX…`). 검증 — `/api/players` **164 → 165건**(P182 노출 · **P181 미노출**), 획득 가능 LEGEND = FW 3 · MF 3 · **GK 1**(오픈 전 GK **0**). 뽑기 풀은 `GachaService.loadPools()` = `WHERE active=1` 이고 **뽑기마다 재조회**(캐시 없음) → 재시작 없이 즉시 반영. **P181 석다이크는 `active=false, adminLocked=true` 유지**(hero 지시대로 미오픈).
- **② 이미지**: #248 템플릿(`make-notice-hero.py`) + 발행물 아트 `art-osiyas.png`(manifest `forPlayer:"P182"` ↔ `player-chars.v2.json` **양방향 대조**). `POST /api/admin/notices/assets` **201** → `01KYS71M3DHHP6J1SY52M69X9E` · 89,122 B · `image/webp`. 공개 GET **200** + **sha256 업로드본과 동일**(`1ee8eaca…`) · `usedBy 1`.
- **③ 공지 게시**(hero 문안 컨펌 후): `오시야스 합류!` **priority 10** `01KYSPMF7SEMJA7K98D5ZMGYBX` · `업데이트 안내 — 홈 화면 개편·감독시간·공지 공유` **priority 5** `01KYSPMN62PWTNYB66H5V3BCS5`. 둘 다 `endsAt 2026-08-06T14:25:05Z`(+7일) · rev 1. 정렬 `priority DESC` = **오시야스가 팝업 1장째**. 패치 내용은 **v2.02~v3 유저 체감분**(홈 5탭 #286 · 감독시간 선발 배치 #276 · 정보탭 상시 #284 · 공지 장분리/공유 #292·#293 · 아이콘 정책 #285 · 랭킹/원정 자격 필터 #296).
- **④ 구 공지 2건 비활성**(삭제 아님): `경니시우스 합류!`(rev 3) · `업데이트 안내 — 원정·시즌 보상·강화 개선`(rev 1) → `POST …/active {"active":false}` 각 **200**, `status OFF`. **삭제하지 않았다** — #263(undelete 부재)로 삭제는 비가역. 되살리기 = 같은 API 에 `active:true`.
- **검증**: `GET /api/notices/active` **2건**, 순서 오시야스(10) → 패치(5). **실팝업**(hmb-online.pages.dev · iPhone 390×844 실터치) 페이저 **1/2 → 2/2** 전환, 히어로 이미지 **실제 로드**(`naturalWidth 1080×1180`, alt 폴백 아님), 콘솔 에러 0. 본문은 게시 전 **실제 렌더러 파서**(`parseNoticeBody`) AST 검사 — 미파싱 잔여 토큰 0 · 288자/534자(상한 2000). 공개 단건 API 미인증 **200**.
- **📌 상대경로 설계가 실전에서 증명됐다**: 작업 중 터널이 `headline-teddy-…` → `record-houston-…` 로 회전했으나(워치독 HEAL_OK), 본문이 `/api/notices/assets/{id}` 라 **공지를 손대지 않고 그대로 살아남았다**. 절대 URL 을 구웠으면 이 시점에 그림이 깨졌다.
- **⚠️ 남긴 것 2건**:
  - **#320 (infra)** — **V30 업로드 이미지는 공유 카드(OG) 썸네일이 깨진다.** OG Function 의 `absolutize()` 가 `/api/...` 에 **web 오리진**을 붙여 `hmb-online.pages.dev/api/notices/assets/…` = **SPA index.html(200 · text/html · 463 B)** 을 가리킨다(404 가 아니라 200 이라 `OG_DEFAULT_IMAGE` 폴백도 안 탄다). 정적 경로를 쓰는 경니시우스는 정상이었다. **hero 판단 = 무배포 유지, 그대로 게시하고 이슈로 남긴다**(팝업·공지센터·공유 카드의 제목/본문은 정상, 이미지만 안 뜸). 고치려면 Pages 재배포 + #299 Function 스냅샷 경로.
  - **#321 (engine, #25 산하)** — **골키퍼 능력치가 선방에 전혀 반영되지 않는다**(골/선방은 슈터 `shooting`·xG 로만 갈리고 `goalkeeperOf` 는 기록용). LEGEND GK 첫 오픈으로 드러난 갭이라 공지 문안에서 **선방 성능 약속을 배제**했다.
- **상태**: `P180 활성 · P181 비활성 · P182 활성` · 활성 공지 2건 · 배포 없음.

---

## 2026-07-30T12:16Z — [장애] 워치독 **반쪽 치유** — 프로세스는 살고 URL 전파가 멈춰 테스터 단절 (배포 아님)

- **증상**: 12:11:15Z 워치독이 `UNHEALTHY`(구 URL `pubs-lauderdale-…` DNS 전부 실패 + curl 000) → 12:11:18Z `HEAL_START` → 12:16:19Z **`HEAL_OK`(new=`selective-blast-municipal-lanes`)** 를 기록했다. **그런데 `config.json` 은 `pubs-lauderdale-…`(10:56Z, source=manual) 그대로**였고 그 호스트는 **DNS 에서 사라진 상태**(`dig` 빈 응답) → **테스터 실접속 단절**. `status.sh` 는 터널 URL 칸이 **빈칸**으로 보였다.
- **조치(순서대로)**:
  1. 워치독이 살린 URL(`selective-blast-…`)을 직접 검증 → **0/8 실패**(그 터널도 이미 죽어 있었다).
  2. **PID only 터널 회전**(47063 종료 → 신규 55311) → 새 URL `record-houston-learners-airplane`.
  3. 새 URL 이 로컬 curl 로는 `http=000`(`dns=0.000s`)인데 **`dig` 로는 해석되고 `--resolve` 우회로 401** → **터널은 정상, 이 머신의 리졸버만 실패**로 판정.
  4. `publish-backend-url.sh` 로 전파 → `config.json` = **`record-houston-…`(12:16:48Z)** 확인(`cache-control: no-store`, 첫 조회만 CDN 캐시로 옛 값이 보였다).
  5. **실브라우저 왕복**(크로미움 `--host-resolver-rules` 우회): `/api/config 200` · `/api/auth/login 200` · `/api/me/starter-grant 200` · `/api/me/active-match 200` · `/api/me 200`, 실패 0 — 스타터 리빌까지 정상.
  6. `status.sh` **전 항목 ✓**(터널 URL 표시·터널 경유 401·web→백엔드 결선 일치·워치독 가동).
- **📌 워치독 갭 3건(#183 후속)** — 왜 "반쪽"이 됐는지:
  1. **URL 캡처가 바이너리에 취약했다(→ 이번에 고쳤다)**: `current_url()` 이 `grep -oE … "$TUNNEL_LOG"` 였다. cloudflared 로그에 제어문자가 섞이면 grep 이 **바이너리로 판정**해 매치 대신 `"Binary file … matches"` 를 돌려준다. **실제 오염 전례가 로그에 남아 있다** — 07:53:36Z `HEAL_OK old=Binary file /tmp/hmb-cf-tunnel.log matches`(같은 문자열이 tunnel-heal.log 에 3회). URL 자리에 그 문자열이 들어가면 전파가 조용히 어긋난다. → **`grep -a` 로 하드닝**(`infra/tunnel-heal.sh` `current_url()` + `infra/status.sh` 2곳). `--check` 정상 동작 확인. **status.sh 의 빈 URL 칸도 이 원인으로 설명된다.**
  2. **전파 성공 판정이 결과를 재확인하지 않는다**: `heal()` 은 publish 스크립트의 **종료코드만** 보고 `HEAL_OK` 를 남긴다. 배포된 `config.json` 을 **되읽어 새 URL 인지 확인**하지 않으므로, 이번처럼 "HEAL_OK 인데 config 는 옛 URL" 이 성립한다. → 권고: `HEAL_OK` 직전에 `config.json` 재조회 검증(불일치면 `HEAL_FAIL`).
  3. **치유 직후 새 URL 의 생존을 재검증하지 않는다**: 12:16:19Z 에 `HEAL_OK` 로 기록된 `selective-blast-…` 는 몇 분 뒤 **0/8** 이었다. 새 터널이 등록만 하고 곧 죽는 케이스를 다음 60초 순회까지 방치한다. → 권고: 치유 후 N회 프로브(예: 3/3)로 승격, 실패 시 즉시 재회전.
- **범위 확인(테스터 무관 증빙)**: `google.com` 은 정상 해석(`dns=0.014s`), **신규 `*.trycloudflare.com` 만** 로컬에서 `dns=0.000s` 즉시 실패. 즉 리졸버 전반 장애가 아니고 **이 머신·이 도메인 국한**이다 — 다른 네트워크의 테스터에게는 영향이 없다(그래서 배포 검증에 `--resolve`/`--host-resolver-rules` 우회를 계속 쓴다).
- **최종 상태**: 백엔드 `https://record-houston-learners-airplane.trycloudflare.com` · web `30faddd`(v3.01) 무변경 · Flyway v32 · 이미지 무변경. **코드·DB 변경 0**(인프라 스크립트 하드닝 1건만).
- ⏳ **고정 URL 승격은 hero 결정 대기** — 이 사이클에서 터널을 **4번** 갈았고(v3 2회 · v3.01 1회 · 이번 1회) 그중 한 번은 실제 단절로 이어졌다. 플레이북 §6(named tunnel / ngrok 유료)이 근본 해결이다.

---

## 2026-07-30T10:44Z — **배포 v3.01** (태그 `deploy-3.01`) — **웹 단독**: 덱 없는 [게임 시작] 차단 3층 가드 + 덱 셋업 워크스루(#286 W3.5) · 팀프롬프트 가림 회귀 복구(p244) · e2e 증거 플래그(#314)

- **git**: **`30faddd`**(태그 `deploy-3.01`). hero 가 homeui 세션에서 지시한 라이브 버그 수정 건.
- **⚠️ 웹 단독 — 직접 재확인**: 라이브(`2a4992e`)`..30faddd` 변경은 **`apps/**` 35개 + `docs/**` 1개뿐**이고 `server-java`·`packages`·`data`·`infra` **접촉 0**, **마이그레이션 0**. → **이미지 재빌드·DB 마이그레이션·executor 재기동 전부 생략**. 배포 후 이미지 digest 무변경 확인(`hmb-java sha256:8bc0f664…` · `hmb-runner sha256:5dd6bc19…`), Flyway **v32** 유지. (`deploy-pages.sh` 의 CORS 단계가 java 컨테이너만 recreate — 부팅 후 override 재확인 `OVERRIDE`.)
- **결과**: ✅ GREEN (JS 에러 0 · API 실패 0)
  - **#286 W3.5 3층 가드 — 실제 동선으로 확인**: 튜토리얼 미완(=덱 없음) 신규 계정으로 `/home` → 팀 카드가 `덱을 구성해 팀을 만드세요` 로 뜨고, **[게임 시작] 누르면 모달 차단** — `현재 덱이 없습니다 / 덱을 구성하러 가시겠습니까? / [아니오] [예]`. **[예] → `/deck?setup=1`** 워크스루 진입(`선발이 비어 있습니다 · 슬롯을 눌러 선수를 고르거나, 아래 [Auto 배치로 시작]` + **[Auto 배치로 시작]** 버튼). 독립검증 FAIL 이었던 "안내가 모달이 아니었다"가 해소된 상태다.
  - **p244 팀프롬프트 가림 회귀 복구 — 결정적으로 확인**: 감독시간 화면에서 팀 프롬프트 `textarea` 가 **뷰포트 안**(top 379 · bottom 494 / viewport 900)이고, **클릭 → 타이핑까지 성공**(입력값 회수 확인). *처음엔 `elementFromPoint` 가 조상 DIV 를 돌려줘 "가림"처럼 보였는데, 그 DIV 는 textarea 의 **조상**(스크롤 컨테이너)이었다 — 판정식이 틀렸던 것이고 실제 입력은 정상이다. 가림 판정은 좌표 추론이 아니라 **실제 타이핑**으로 해야 한다.*
  - **홈 5탭 무회귀**: `/home` 5탭(게임 시작·덱 구성·영입·내 정보·선수 도감 보유 15/**165**) + 하단 내비 정상. 감독시간 헤더 `4 : 0 · 45'` 정상.
  - `version.json` = **`30faddd`**.
- **📌 기록**:
  - **#318(덱 롱프레스 드래그 간헐)**: 이번 스모크에서 드래그 조작을 하지 않았으므로 **재현도 반증도 아님**(비차단 판정 존중). 확인이 필요하면 실터치 이벤트 기반 별도 검증이 맞다(memory `e2e-touch-not-mouse`).
  - **배포 중 터널 문제 재발 — 브라우저만 실패하는 구간**: `headline-teddy-…` 이 curl 로는 7/8 정상인데 **크로미움은 `/api/config`·`/api/auth/login` 에서 `net::ERR_FAILED`** 로 연속 실패했다(로컬 리졸버의 부정 캐시 패턴, v8.01 과 동일). **PID only 터널 회전 + `publish-backend-url.sh` 재전파**로 해소(`pubs-lauderdale-stands-brunswick`, 8/8 · 실브라우저 정상). 이 배포 사이클에서만 터널을 **3번** 갈았다(직전 v3 에서 2번). quick tunnel 의 구조적 불안정이라 상시 고정 URL 승격(플레이북 §6)을 다시 검토할 시점이다.
  - 검증 계정: `nodeck*` 3건(가드 확인용, 덱 없음) · `d301r*` 1건(감독시간 확인용).

---

## 2026-07-30T07:43Z — **배포 v3** (태그 `deploy-3`) — 홈 5탭 IA(#286) + 운영 컨텐츠 무배포화(#309 V30·V31·**V32 감사표 재작성**) + #210 흡수

> 🆕 **앞자리 범프 = 배포 v3**(hero 확정 — '2.04' 아님). 릴리스 태그 `v1`~`v8` 축과는 여전히 별개다.

- **git**: **`2a4992e`**(태그 `deploy-3`). 배포 중 픽스 없음.
- **모듈 버전**: engine `@0.23.0`(무변경) · server-java `0.1.0`(#309 W1/W2 + #210) · web `0.0.0`(#286 홈 5탭 IA) · servants `0.0.1`(무변경 — `packages/**` 접촉 0 → runner 재빌드·executor 재기동 생략) · 발행물 4종 무변경(players `v2.4` 등)
- **이미지**: `hmb-java` `sha256:8bc0f6645cdd…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(무변경)
- **DB 마이그레이션**: Flyway **v29 → v32**, 3건 — `V30 notice_assets` · `V31 char_bundles` · **`V32 catalog_audit_purge_action`(파괴적: `admin_catalog_audit` 12단계 재작성)**. `.conf` 없음 = **전부 트랜잭션 내**(V32 는 원자적, SQLite DDL 롤백에 의존).
  - **백업**: `pre-deploy3-20260730T073925Z.db`(372,625,408 B · sha256 `be8341bf290c6b5ef05aa5e10eb9c2bfc4e3bb82a770383324cdfb7fb1944b4a` · integrity ok · users 177 · audit 5).
  - **사전 상태 박제(V32 대상)**: `admin_catalog_audit` **5행**(unit_activate 3 · unit_deactivate 2), 명시 인덱스 **4개**(`idx_..actor`·`idx_..player`·`uq_..create_idem`·`uq_..idem`), `admin_ops_audit` 에 purge 3행.
  - **리허설(백업 사본)**: V30~V32 success · 부팅 성공 · FK 0 · integrity ok.
  - **§0.7 사후검증 2줄 — 리허설·라이브 둘 다 통과**:
    | 검증 | 사전 | 리허설 | 라이브 |
    |---|---|---|---|
    | `admin_catalog_audit` 행수 | 5 | **5** | **5** |
    | 명시 인덱스 수 | 4 | **4** | **4** |
    인덱스 4개 이름까지 대조했다 — 과거 독립검증 BLOCKER-1(이 재작성이 `uq_catalog_audit_idem` 을 빠뜨렸고 계약이 "3개"로 그 손실을 박제했던 사건) 이 재발하지 않았음을 확인. `action` CHECK 에 `unit_purge` 포함(**YES**), V30 `notice_assets`·V31 `char_bundles` 생성 확인, 주요 표 행수 보존(users 177 · matches 56 · user_players 2854).
- **③ override**: 발행물 변경 0 → 유지, java recreate 후 재확인(`OVERRIDE`).
- **결과**: ✅ GREEN (JS 에러 0)
  - **#286 홈 5탭 IA**: 로그인 후 **`/home`** 착지, **5탭** = `⚽ 게임 시작`(디비전 10 · 원정 레이팅) · `📋 덱 구성`(4-3-3 · 지시 0/11) · `✨ 영입`(뽑기 · 트레이드) · `🙋 내 정보`(전적 · 디비전) · `👥 선수 도감`(보유 15 / **164**). **`/lobby` → `/home` 리다이렉트** 확인. 상단에 팀 카드(레이팅 뱃지)와 지갑 `3,000 G / 12,000 Z`.
  - **#309 공지 이미지 업로드(V30) 왕복**: `POST /api/admin/notices/assets`(multipart) **201** → 응답 `url` 이 **상대경로**(`/api/notices/assets/{id}`) → 그 경로로 **200 `image/png` 69B** 서빙 → 그 이미지를 본문에 넣은 공지를 만들자 자산 **`usedBy 1`** 로 갱신, `/api/notices/active` 에 노출(페이저 1/3). **정리 완료**(공지·자산 모두 비활성 → active 공지 2건으로 원복).
  - **#309 유닛 등록(V31 계열) 왕복**: `POST /api/admin/units` **200 → 서버 채번 `P183`**, 조회 200(`dataVersion=admin`), DB 반영 확인 → **`POST /{id}/purge` 200 으로 회수**(카탈로그 행 0). **그 회수가 `admin_catalog_audit.action='unit_purge'` 로 남았다(1행, 총 5→7)** — V32 가 노린 "회수 이력을 카탈로그 원장에 통합"이 실제로 성립함을 확인.
  - **OG Function 생존(#299)**: 워치독 경로(`publish-backend-url.sh`)로 **두 번** 재배포된 뒤에도 `/share/notice/{id}` **200** — Function 스냅샷 복원 배선이 실전에서 작동.
  - **무회귀**: 가입 스타터·튜토덱·지갑·공지 팝업(히어로 이미지 1080×1180 로드)·Z/G.
  - `version.json` = **`2a4992e`**.
- **📌 기록해 둘 것**:
  - **`GET /api/chars/index` 404 는 결함이 아니다** — "활성 아트 번들 없음"의 **설계된 신호**이고 web 은 그때 **구운 `/chars` 폴백**을 쓴다(계약 = `char-bundle-base.test.ts`). 스모크 콘솔에 404 가 2건 보이는 게 정상이다.
  - **배포 중 터널이 두 번 죽었다**: 스모크 시작 시 `meant-basename-…` 이 **530 8/8** 로 응답 불가(워치독 BLIP 만 남고 미치유) → **PID only 회전**(`brooklyn-deeply-feel-voting`, 8/8 정상) + `publish-backend-url.sh`. 그 뒤 워치독이 다시 `headline-teddy-anatomy-telescope` 로 HEAL_OK 하면서 web 이 한 박자 뒤처져 있었고(`status.sh` 가 불일치로 경고) **즉시 재전파**해 `config.json` 을 현재 터널로 맞췄다. 최종 상태 전 항목 ✓.
  - 프로덕션에 검증 계정 `d3p*` 1건. 스모크로 만든 유닛·공지·자산은 **전부 회수/비활성**했다.

---

## 2026-07-30T00:49Z — **배포 v2.03** (태그 `deploy-2.03`) — 공지 팝업 장 분리·본문 스크롤(#292) + 공유 딥링크·OG(#293) + 랭킹/원정 자격 필터(#296·#300)

- **git**: **`9e4a71c`**(태그 `deploy-2.03`). 앞자리 유지 = **배포 v2.03**. #309 W1/W2 는 미머지로 이번 열차 제외.
- **모듈 버전**: engine `@0.23.0`(무변경) · server-java `0.1.0`(공개 단건 공지 API·자격 필터) · web `0.0.0`(#292·#293) · servants `0.0.1`(무변경) · **infra(#299 Pages Function 배선 신규)** · 발행물 4종 무변경
- **이미지**: `hmb-java` `sha256:1ad3131b9284…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(**무변경** — `packages/**` 접촉 0 → runner 재빌드·executor 재기동 생략)
- **DB**: **신규 마이그레이션 없음**(Flyway **v29** 유지). 표준 백업만 — `pre-deploy203-20260730T004750Z.db`(316,108,800 B · sha256 `228a295372a1566fcff75ad5660cda7b3d8a9a5b73473540343dd1a2d75aefcd` · integrity ok · users 173).
- **③ override**: 발행물 변경 0 → 유지. java recreate 후 재확인(`OVERRIDE`·`initialGems=12000`).
- **🆕 배포 절차가 바뀌었다 — Pages Function(#299)**: 이번 열차가 `infra/**`(내 owned-glob)를 고쳤다. `wrangler pages deploy` 는 **`--functions-directory` 플래그가 없고 `cwd/functions` 만** 본다 → `infra/pages/build.sh` 가 `stage-functions.sh` 로 `infra/pages/functions/` → **리포 루트 `functions/`**(생성물·gitignore)로 스테이징하고, `deploy-pages.sh` 가 **`$CACHE.functions` 로 스냅샷을 보존**하며 `publish-backend-url.sh` 가 재배포 전 그것을 복원한다. **이 스냅샷이 없으면 워치독(#183)의 config 재배포가 OG Function 을 조용히 삭제한다.** 이번 배포 로그에서 스테이징·스냅샷 둘 다 확인(`functions/share/notice/[id].js` · `~/.cache/hmb/dist-current.functions/`). **내 절차 변경은 없다** — `deploy-pages.sh` 한 줄이 그대로 처리한다.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **공개 단건 공지 API(#293)**: `GET /api/notices/{id}` **인증 없이 200**(title·revision·body), 없는 id **404**.
  - **OG 썸네일 Function(#293/#299)**: `GET https://hmb-online.pages.dev/share/notice/{id}` **200 `text/html`** + 메타 실측 — `og:type=article` · `og:title=경니시우스 합류!` · `og:description`(본문 발췌) · `og:url`(정규 공유 URL) · **`og:image=/notice/hero-kyeongnicius.webp`** · `twitter:card=summary_large_image`.
  - **미로그인 딥링크 복귀(#293)**: 미로그인으로 `/share/notice/{id}` 진입 → **`/login?returnTo=%2Fshare%2Fnotice%2F{id}`** 로 유도 → 로그인 완료 후 **`/share/notice/{id}` 로 복귀**하며 공지 본문 렌더.
  - **공지 장 분리(#292)**: 로비 팝업 페이저 **`1 / 2`**(활성 공지 2건 — 경니시우스 priority 10, 업데이트 안내 priority 5) 실측.
  - **랭킹·원정 자격 필터(#296/#300)**: `GET /api/away/candidates` = **후보 2명**(전체 유저 **173명** 중) — "게임 한 판 한 유저만" 필터가 실제로 걸려 있음(필터 없으면 170+ 명이 후보로 나온다).
    - ⚠️ **정정(2026-07-30, hmb:awaypts 라이브 실측)**: 이 줄에 원래 `GET /api/rankings` = **0건** 이라고 적혀 있었으나 **사실이 아니다**. 0 이었던 건 `leaderboard` 건수가 아니라 **스모크 계정 자신의 `me.rank`(=null, 미등록)** 다. 리더보드는 요청자와 무관한 **전역 목록**이라 자격자가 있는 한 비지 않는다. **같은 스모크 계정 세션(`d203q23745`·`d203m19426`·`d203m19889`)으로 재호출 = 셋 다 HTTP 200 · `leaderboard` 20건**(기본 limit), `?limit=100` = **25건**, 터널 경유도 **25건**, 테스터 사이트 실브라우저 = **리더보드 20행 렌더 · 에러 토스트 0**. DB 자격자(완료경기≥1) **25명**과 정확히 일치. 근거·대조표 = **#296 코멘트**, 캡처 = `evidence/active-only-ranking-away/live-v203-rankings.png`.
    - 📌 실화면에서 드러난 **별건**: 리더보드 4·14~20위가 **우리 배포 스모크 계정**(`d202p7393`·`v8probe4605`·`d2p1434`·`pw3426`·`v7probe25`·`v802p19738`·`v803p9347`·`ev24352`)이고 `-1000` 이 그대로 노출된다. 스모크가 **매 배포마다 새 계정을 만들고 경기를 한 판 돌려서** 자격 필터를 통과하기 때문 — 필터는 "한 판도 안 한 계정"을 막지 "우리 계정"을 막지 않는다. 게다가 레이팅 차감은 **일회성 패치**(hero 확정 2026-07-30)라 사후 차감으로 누르는 방식은 반복할 수 없다. → **고정 예약 계정 재사용**(인프라 절차, 코드 0) 또는 **테스트 플래그로 랭킹·원정 제외**(server-java) 필요. hero 판단 대기.
  - **무회귀**: 가입 스타터·튜토덱·지갑 `3,000 G / 12,000 Z`·로비/육성/상점 정상.
  - `version.json` = **`9e4a71c`**.
- **📌 미검증으로 남긴 것(정직 표기)**:
  - **본문 스크롤(#292)** — 현재 활성 공지 2건의 본문이 **모바일 390×844 에서도 넘치지 않아** 스크롤 영역이 발동하지 않았다(`overflowY` 스크롤 후보 0개). 긴 본문 공지가 올라가면 확인 가능하며, 계약은 web e2e 소관.
  - **카카오톡 등 실제 SNS 미리보기** — OG 메타는 위와 같이 실측했지만 **크롤러가 실제로 그리는 카드는 hero 몫**(noticepg 가 #293 에 남긴 4스텝 중 이 항목).
- **비고**: 스모크 중 활성 공지가 1건 → 2건으로 늘어나 있었다(다른 곳에서 추가). 경니시우스 공지는 이제 **revision 3**.

---

## 2026-07-29T14:24Z — **배포 v2.02** (태그 `deploy-2.02`) — 하프타임 포메이션·배치(#276) + 아이콘 정책(#285) + 정보탭 상시·후반지시 미리작성(#284)

- **git**: **`abba231`**(태그 `deploy-2.02`). 앞자리 유지 = **배포 v2.02**.
- **모듈 버전**: engine **`@0.23.0`**(무변경) · server-java `0.1.0`(#276 서버몫) · web `0.0.0`(#276·#284·#285) · servants `0.0.1`(무변경) · 발행물 4종 무변경(players `v2.4`·economy `v3`·bots `v3`·league `v2`)
- **이미지**: `hmb-java` `sha256:46ae893e6d1f…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(**무변경** — `packages/**` 접촉 0 이라 재빌드·executor 재기동 모두 생략)
- **DB**: Flyway **v28 → v29**, 1건 — `V29__halftime_shape`. **§0.5-2/7 로 성격 확인**: `.conf` 없음(트랜잭션 내) · 파괴적 구문 0 · 본문은 **`ALTER TABLE matches ADD COLUMN h2_shape_json TEXT` 한 줄 = 순수 additive**. 백업은 표준대로 수행 — `pre-deploy202-20260729T142146Z.db`(283,652,096 B · sha256 `ce958c9ebc14341325872eae9321f5db5e64b6edb9460c6758cd9ff6b986a80c` · integrity ok). 적용 후 FK 0 · integrity ok · `h2_shape_json` 컬럼 생성 확인.
- **③ override**: 발행물 변경 0 이라 **유지**. java recreate 후 재확인 — `source=OVERRIDE` · `initialGems=12000` · `leagueGemReward[completion=3000…]`.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **#285 아이콘 정책 — 확인**: 브리핑/덱에서 얼굴 아트 에셋이 **1개만** 로드되고(`/chars/units/avatars-64.png`), 슬롯 텍스트상 **춘바페(LEGEND)만 얼굴 · 실버 10명은 전부 이니셜**(GJ·RH·KH·MM·JM·CR·LM·BW·GM·AO). 경기장 토큰도 동일 — **얼굴 1 + 나머지 번호 원**. **브리핑 상단 줄 제거**도 확인(예전 `BRIEFING 2:57 만료돼도 진행 가능` + 상대분석 줄 → `상대 정보 ↗` 로 접힘).
  - **#284 정보 시트 상시 — 확인**: 전반 진행 중 화면에서 `통계 / 로그 / 후반 지시` **탭 바 + 시트가 항상 열린 상태**(여닫는 토글 없음), 로그가 실시간으로 쌓이는 것 확인.
  - **#284 후반 지시 미리작성 — 부분 확인**: [후반 지시] 탭 = `후반 지시 (미리 작성) · ⏱ 전반 진행 중` + **팀 전체 + 선수별 15명** 탭, `팀 전체에게 (후반) · AI가 읽는다 · 0/500 · 적으면 자동으로 저장됩니다`. 전반 중 팀 지시를 입력하니 **서버에 저장됨**(`match_prompts` 에 `phase=halftime, scope=team` 행 생성 확인).
  - **#276 감독시간 배치 — 서버 몫 확인**: `POST /api/matches/{id}/halftime` 에 `formation`+`starters` 제출 → **`h2_shape_json` 저장**, 후반 t0 좌표에 **슬롯 재배치가 실제 반영**(P176·P108 위치가 전반과 다름). 가드도 동작 — 교체 없이 벤치 선수를 선발에 넣자 **400 `SHAPE_INVALID`(missing P108)** 로 거부.
  - **기존 무회귀**: 공지 팝업 노출(아래 비고) · 원정/리그 진입 · 매치 완주(`FINISHED 1:0 WIN`) · 가입 젬 12,000 · Z/G.
  - `version.json` = **`abba231`**(직후 조회는 또 CDN 캐시로 옛 SHA — `?cb=` 로 확인).
- **⚠️ 스모크에서 나온 관측 2건(둘 다 이번 배포로 깨진 것은 아님 — 후속 판단 필요)**:
  1. **감독시간 프리필이 비어 있었다(#284)**. 전반 중 쓴 팀 지시가 **서버(`match_prompts`)에는 저장돼 있는데**, 감독시간 화면의 `팀 전체에게 (후반)` 은 `0 / 500` 으로 비어서 떴다(새 브라우저 세션에서 확인 — 서버 값이라면 세션 무관하게 떠야 한다). **infotab 독립검증 트랙(#284)에 넘길 후보 blocker.** → **등록됨: #287 코멘트**(저장분 읽기 API 부재가 프리필이 비는 실제 구멍 — main 이 실측으로 확인).
  2. **감독시간에서 `4-4-2` 를 골라도 후반 좌표 골격은 4-3-3 이다.** 원인은 web·server 가 아니라 **엔진**이다 — `packages/engine/src/config.ts` 의 `formations` 에 **`"4-3-3"` 하나만 등록**돼 있다. 서버는 스냅샷에 `formation` 을 정확히 기록하고 슬롯도 반영하지만, 엔진에 그 포메이션 좌표가 없다. 실측: 후반 t0 = GK1/DF4/**MID3(40,40,42)**/**FW3(76,79,79)** 로 전반과 같은 4-3-3 골격. → **"고를 수 있는데 반영되지 않는" UX 불일치**로 남는다(엔진 무변경 열차라 이번 범위 밖). → **등록됨: #295**(engine+web).
- **비고**: 배포 전에 게시한 공지(id `01KYPNMXAMWC…`)가 **다른 곳에서 편집돼 revision 2 · 제목 "경니시우스 합류!" · 기한 08-05 · priority 5** 로 바뀌어 있었다(내 "이번 업데이트" 본문은 유지). 로비 팝업에서 정상 노출 확인.
---

## 2026-07-29T13:31Z — [운영 조치] 원정 레이팅 일괄 차감 — 허수/무성의 철자 **148계정 −1000** (무배포·무중단)
- **지시**: hero — "원정 포인트 조정할건데 지금 허수 아이디가 너무 많아. 무성의하게 철자로 지은 아이디들 다 1000점씩 깎자." 세션 `hmb:awaypts`. 전말·근거 = **이슈 #288**.
- **실사 보고 후 hero 컨펌**(명단·값 모두 hero 결정): 원정 포인트 스케일이 **±10**(승 +10/패 −10)이라 1000점이 100연패분임을 보고 → **−1000 유지**. 대상 = **실활동 0**(경기 0·뽑기 0·카드 15장=스타터 그대로, `hmbadmin` 제외) + **원정 실주행 무성의 철자 3**(`eee` 당시 1위 +10 · `afasdf` −10 · `d201b29310` −10) + **개발/배포 계정 14**(`fullplay v7probe25 v8probe4605 v80*p* pw3426 ev* d2p1434 d2b20908 cur20042 gacha*`).
- **실행**: 백업 선행(`~/hmb-db-backups/20260729T133017Z-awaypts/`) → 볼륨 `hmb-p3-db` 에 단일 트랜잭션(`BEGIN IMMEDIATE`), **`RatingService.apply` 와 동형**(원장 먼저 → 잔액 upsert): `rating_ledger` 148행(`reason='ops_purge_fake_ids'`, `ref_id='ops-2026-07-29-awaypts'`) + `user_ratings` upsert + `admin_ops_audit`(`away_rating_purge_fake_ids`). 유니크 인덱스 `uq_rating_ledger_reason_ref` 가 재실행 이중차감을 막는다. 컨테이너에서 `su-exec 10001:999` 로 써서 볼륨 소유권 `10001:ping` 유지. **프로세스 종료·재배포 없음**(java/runner 무중단, 이미지·버전 전부 무변경).
- **조회 규율**: 전 과정 라이브 DB **read-only 볼륨 복사본**으로만 실사. 원본 직접 조회 0.
- **검증**(라이브 `GET /api/rankings` 실응답): 1~12위가 실유저(햄춘 +10 · 별희 · 우보긴 · 이원재 · hmbadmin · ㄱㅅㅇ · ㄷㄹㅁㄴㅇ · ㅁㄴㅇㄹㅁ · ㅇㅁㄹ · 전기석 · 축구왕여르 · 혁혁), 13위부터 −990/−1000. **원정 상대 후보 풀 40명 → 11명**(전원 카드 14~51장 = 실플레이 흔적). 이름이 자판 난타여도 실플레이한 `ㄱㅅㅇ`·`ㅁㄴㅇㄹㅁ`·`ㄷㄹㅁㄴㅇ`·`ㅇㅁㄹ` 은 **활동 기준으로 보호**.
- **후속 복구(같은 날 13:39Z, hero 지시)**: 부수 피해 2건 — `현현`·`홍수몬`(실유저형 이름, 가입·덱만 있고 경기 0·뽑기 0)이 기준에 걸려 −1000 됐던 것을 **+1000 복구**. 백업 선행(`~/hmb-db-backups/20260729T133850Z-revert/`) 후 동형 트랜잭션(`rating_ledger` 2행 `reason='ops_purge_revert'`/`ref_id='ops-2026-07-29-awaypts-revert'` + `user_ratings` upsert + `admin_ops_audit`). 라이브 API 검증 = 현현 13위 `0` · 홍수몬 14위 `0`. **차감 상태 148 → 146계정.**
- **비고**: **근본 해결은 코드였다** — `RankingService.rankedUsers()`·`AwayService.candidatesInBand()` 가 가입 계정 전량을 랭킹·원정 후보에 실었다(덱은 가입 시 자동 지급이라 활동 증거가 아님). → **에픽 #296 / PR #300 으로 자격 필터 구현·머지 완료**("완료 경기 1판 이상"만 노출). ⚠️ 다만 **이 차감을 되돌리면 안 된다** — 자격 통과 23명 중 13명이 개발/허수 계정이다(우리 스모크는 대개 한 판을 돌린다). **필터는 미래를, 차감은 과거를 막는다**(hero 확정 D4).

---

## 2026-07-29T09:58Z — [운영 조치] 신규 LEGEND 2종 **비활성 전환** — `P181`·`P182` (미오픈, 배포 아님)
- **지시**: hero 긴급 — **P181 석다이크·P182 오시야스는 아직 미오픈**. 배포 v2 에서 활성화한 두 건을 되돌린다. **P180 경니시우스는 활성 유지.**
- **실행**: `POST /api/admin/units/{P181,P182}/deactivate` 각 **200**, 사유 `"미오픈 — hero 지시 비활성 전환"` — **무배포·무재시작**(어드민 API 만), 진행 중이던 배포 v2.01 과 독립.
- **검증**: DB `P180 active=1 / P181 active=0 / P182 active=0` · 활성 카탈로그 **166 → 164** · `GET /api/players`(도감·뽑기 풀의 소스) **164건**이고 **P181·P182 미노출, P180 노출** · 감사 기록 `admin_ops_audit` 에 `unit_deactivate`(사유 포함) 적재 — 직전 `unit_activate` 와 함께 이력으로 남음.
- 되돌리려면 같은 API 의 `/activate`(사유 필수). **발행물(`players.v2.4`)은 손대지 않았다** — 활성 여부는 DB 상태이므로 다음 배포가 덮어쓰지 않는다.

---

## 2026-07-29T09:54Z — **배포 v2.01** (태그 `deploy-2.01`) — **웹 단독** (#244 프롬프트 1급 UI + #248 공지 히어로 템플릿)
- **git**: **`48eb185`**(= `deploy-2`(96ea877) + `#244`·`#248` + 직전 배포 기록 커밋). 태그 `deploy-2.01` push 완료.
- **⚠️ 웹 단독 — 백엔드 산출물 무변경**: `96ea877..48eb185` 를 직접 검증했다 — 변경은 **`apps/**` 56개 + `docs/**` 2개뿐**, `server-java`·`packages`·`data`·`infra` **접촉 0**. 그래서 **이미지 재빌드 없음**(`hmb-java` `80015ea6…` · `hmb-runner` `5dd6bc19…` 그대로), **DB 마이그레이션 없음**(Flyway **v28** 유지), **executor 재기동 없음**(코드 무관), 발행물·엔진 무변경(`engine@0.23.0`).
  - 단 `deploy-pages.sh` 의 CORS 재결선 단계가 **`hmb-java` 컨테이너를 recreate** 한다(이미지는 동일). 부팅 후 economy override 재적용 확인 — `source=OVERRIDE` · `initialGems=12000` · `leagueGemReward[completion=3000…]` 유지.
- **터널**: 기존 URL 유지(`https://ebony-aus-fat-soul.trycloudflare.com`), `config.json` 동일 값으로 재발행.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **프롬프트 1급 골격(#244) — 3화면 전부 확인**:
    - **덱**: `선수 = 프롬프트 · 빈 자리 = 선수 고르기` · `TEAM 팀 지시 / 팀 전체에게 / **AI가 읽는다** / 0 / 500` · `⚙ 팀 세부 조정 — 라인·압박·템포·폭`
    - **브리핑**: `경기 전 브리핑 | BRIEFING | 2:57 | 만료돼도 진행 가능` · 상대 분석 + `상대 정보 ↗` · 팀파워 `우리 691 / ≈630` · 같은 프롬프트 골격
    - **감독시간**: **`감독` / `경기장면` 탭 분리**(신규) · `감독시간 2:01 — 지나면 전반 지시로 시작됩니다` · `감독의 한마디` · 교체 0/3 · `팀 전체에게 (후반)` · `후반 선수 지시 0명` · [후반 시작]
  - **#248 공지 에셋**: `https://hmb-online.pages.dev/notice/hero-kyeongnicius.webp` **200 (81,806 B)**.
  - **로비 정상**: 지갑 `● 3,000 G / 💎 12,000 Z` · 레이팅 표시 · 모드 선택에 **원정** 노출 · 진행 중 매치가 있으면 `이어하기 / 경기 포기` 카드(브리핑은 강제 리다이렉트 대상이 아님 — #217 설계대로).
  - **기존 무회귀**: 가입 스타터·튜토덱·매치 생성→킥오프→`FIRST_HALF`(420s/180s)·Z/G 표기.
  - `version.json` = **`48eb185`**. *(배포 직후 첫 조회는 CDN 캐시로 `96ea877` 이 보였다 — 캐시 무효화 후 `48eb185` 확인. 다음 배포자도 같은 착시를 볼 수 있으니 `?cb=` 를 붙여 확인할 것.)*
- **비고**: 이 배포는 hero 가 promptui 창에서 요청한 "웹 배포도 해서 테스터 화면에 반영" 건이다. 배포 v2 의 백엔드(V28·players v2.4) 위에 web 만 얹은 형태.

---

## 2026-07-29T09:46Z — **배포 v2** (태그 `deploy-2`) — 원정/시즌·디비전 · 다이스 구매 제거 · 팀프롬프트 · 신규 LEGEND 3종
> 🆕 **버전 체계가 바뀌었다**: 이번부터 배포 버전은 **`배포 v2`(태그 `deploy-2`)** 다. 앞자리는 hero 가 명시할 때만 올린다.
> 구 `v8.03` 의 다음이지만 `v8.04` 가 아니며, **릴리스 태그 `v1`~`v8`**(엔진/뷰어 안정 스냅샷, CLAUDE.md §6)과는 **다른 축**이다 — 태그명을 `deploy-*` 로 분리한 이유가 그것.

- **git**: **`96ea877`** = 태그 `deploy-2` **그대로**(배포 중 픽스 없음). ⚠️ 배포 시점 main HEAD 는 `8253fae`(#244 프롬프트 UI·#248 공지 템플릿)로 **앞서 있었고, 이번 열차엔 포함하지 않았다**.
- **모듈 버전 매니페스트**: engine **`@0.23.0`**(**무변경** — #241 구 resumeState 거부 이슈 무해당) · server-java `0.1.0`(V21~V28 · 원정/시즌·디비전·공지·팀프롬프트·하프타임 전술) · web `0.0.0` · servants `0.0.1` · **발행물: players `v2.4`(182명) · economy `v3`(갱신) · bots `v3` · league `v2`**
- **이미지**: `hmb-java` `sha256:80015ea64755…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(**무변경** — 엔진 동일)
- **DB 마이그레이션**: Flyway **v20 → v28**, **8건**(`V21 away_raid`[**non-transactional**] · `V22 away_season` · `V23 deck_team_prompt` · `V24 halftime_tactics` · `V25 dice_purchase_removed`[**파괴적**] · `V26 notices` · `V27 away_forfeit_isolation` · `V28 league_division`), 41ms.
  - **백업**: `~/.local/state/hmb/db-backups/pre-deploy2-20260729T094152Z.db` (251,301,888 B · sha256 `2271e5fcf682e7032a6c9b9ef34f1a036b53e60aa55b5775f0807e7db2e4e029` · integrity ok). 롤백 이미지 `prev-live` = v8.03 세대(`c05a09c1…`/`5dd6bc19…`).
  - **리허설(백업 사본, 라이브 무접촉)**: 8건 전부 success · 부팅 성공 · **182 players from v2.4** · `foreign_key_check` **0** · 행수 보존(matches 40 · match_prompts 18 · match_halves 62 · ai_jobs 195 · point_ledger 298 · growth_applied 448 · user_players 2415) — **V21 의 `matches` 12단계 재작성이 자식 테이블을 다치지 않음**을 여기서 확인하고 라이브에 적용.
  - **V25 다이스 소각(비가역) — 실행 전후 대조**: 사전 실측 = 보유 유저 **2명**(normal 합 **1**, cash 합 **2**). 리허설·라이브 모두 `dice_burned` 에 **2행(normal 1 / cash 2)** 박제 + `user_dice` **0/0** 소각. **복원 근거 = `dice_burned` 표 + #247 코멘트의 SQL**(보상 요구가 오면 이 표가 유일한 근거).
  - **V27 forfeit 백필**: `away_reports` 가 비어 있어 **0건** 표시(신규 기능이라 정상).
  - 적용 후 라이브: `foreign_key_check` 0 · `integrity_check=ok` · Flyway **v28** · players **182** · users 157.
- **✅ §0.5 체크리스트 + §0.7 pending 소진**:
  ①②마이그레이션 8건·비원자 1건 확인 → 백업·리허설 수행 ③**발행물 핀 4개 모두 yml·Dockerfile 일치**(`players.v2.4`·`economy.v3`·`bots.v3`·`league.v2`) — **과거 v2.1 핀 사고의 재발 없음**, 부팅 로그로 `Imported 182 players … (version=v2.4)` 재확인 ④override **§0.6 2-B 재작성**(아래) ⑤web 빌드 통과 ⑥executor 재기동(PID only `9834`→`9823`→`9803`→`9801`, 새 워커 **80023**) ⑦**비가역 마이그레이션 = V25**(체크7 신설 후 첫 적용) — 소각 대상·규모·복원 근거를 배포 전에 확인.
- **economy override 재작성(§0.6 2-B, 삭제 아님)**: 새 발행물을 컨테이너에서 꺼내(`economy.v3.json`) **운영 조정 `initialGems=12000` 만 다시 얹어** 재배치 → `reload` 200. 확인: 새 발행물 대비 차이 **`initialGems` 한 키뿐**, 그리고 **구 override 가 가리고 있던 키 = `initialGems` + `league`** — 즉 **그대로 뒀으면 #251 신규 리그 젬 보상이 조용히 무시될 뻔했다**(구 `gemReward{maxRank,min,max}` → 신 `{completion:3000, rankBonus:{1:6000,2:3000,3:1000}}`). 부팅 로그로 `initialGems=12000` + `leagueGemReward=LeagueGemReward[completion=3000…]` **공존** 확인.
- **신규 LEGEND 3종 활성화(hero 승인)**: 발행물엔 `active:false` 로 실려 있어 어드민 카탈로그 API 로 활성화 — `POST /api/admin/units/{P180,P181,P182}/activate` **각 200**(사유 기입, `admin_ops_audit` 기록). DB 확인 `P180 경니시우스 / P181 석다이크 / P182 오시야스 active=1`, 활성 카탈로그 **163 → 166**.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **신규 매치**: 생성 → 킥오프 → `GEN1`(대기 중계멘트 정상) → **`FIRST_HALF`**(`halfRealMs 420000` · `halftimeMs 180000`).
  - **디비전 뱃지(V28)**: 리그 화면 우상단 **`디비전 10`** 뱃지 + "다음 시즌 **디비전 10** 에서 시작합니다".
  - **시즌 보상**: 서버가 새 보상 스키마를 로드한 것까지 확인(`completion=3000` + `rankBonus`). *보상 카드 UI 는 시즌을 완주해야 떠서 이번 스모크 범위 밖 — 다음 열차나 hero 실플레이에서 확인 필요.*
  - **다이스 구매 제거(V25)**: 상점에서 **[다이스] 탭이 사라지고 뽑기만** 남음. 롤 직접 결제는 `POST /api/growth/dice` 가 **`POTENTIAL_LOCKED`(2★부터 해금)** 로 막혀 신규 계정에선 결제까지 도달하지 못했다 — **지갑 차감 실검증은 미완**(2★ 카드가 필요). 상점 경로 제거는 확인됨.
  - **팀 프롬프트 저장(V23)**: `GET /api/deck` 에 **`teamPrompt` 필드 신설**, `PUT` 후 재조회에서 값 유지.
  - **뽑기 이펙트/결제**: 단뽑 실행 → 지갑 `12,000 Z → 11,700 Z`, 리빌 카드 정상.
  - **기존 무회귀**: 가입 스타터(젬 **12,000**) · 튜토덱 · 409 잠금 · Z/G 표기.
  - `version.json` = **`96ea877`** / `engine@0.23.0`.
- **비고**:
  - 배포 후 워치독이 터널을 교체했다 — 현재 백엔드 `https://ebony-aus-fat-soul.trycloudflare.com`(config.json 갱신 확인, `status.sh` 전 항목 ✓).
  - 프로덕션에 검증 계정 3건(`d2p*`·`d2b*` 등) 생성. `d2p*` 는 GEN1 중 포기가 막혀 매치 종료까지 잠금 — 프로브 계정이라 무해.
  - **다음 소배포 예고**: htform(#276 하프타임 포메이션)은 이번 열차에 없다 — 리베이스 후 **배포 v2.01** 예정.
  - §0.7(pending) 은 이 배포로 **소진**했다 — 플레이북에서 해당 절을 비운다.

---

## 2026-07-28T09:52Z — **릴리스 태그 `v8.03`** (#232 재화 표기 통일 — 다이아=Z · 골드=G, 서버 주도)
- **git**: **`06468e2`** = 태그 `v8.03` **그대로**(배포 중 픽스 없음). 브랜치 `deploy/v7`.
- **모듈 버전**: engine `@0.23.0`(**변경 0**) · server-java `0.1.0`(표기 메타를 economy 스냅샷에 싣고 `GET /api/config` 로 공개) · web `0.0.0`(클라 하드코딩 전수 제거 — `<Amount>`·`useCurrency`) · servants `0.0.1`
- **이미지**: `hmb-java` `sha256:c05a09c12d83…`(**신규**) · `hmb-runner` `sha256:5dd6bc199603…`(**무변경** — engine 동일)
- **마이그레이션**: **없음**(`7f33583..06468e2` 에 `db/migration` 변경 0, 라이브 Flyway **v20** 유지). 백업만 수행 — `pre-v8.03-20260728T094606Z.db` (243,224,576 B · sha256 `da2edb8e4283249647f63451fe820fc7c745edf5b4f9c0c1bab382505203e3ba` · integrity ok · users 152).
- **executor**: `06468e2` 재기동(PID only `58680`→`58634`→`58535`→`58533`, 새 워커 **9834**), 미완 잡 0 에서 교체.
- **✅ 체크리스트(§0.5/§0.6) 적용 — 특히 ④가 이번엔 실제 리스크였다**:
  #232 는 표기를 **economy 스냅샷의 `currencies` 블록**에서 읽는다. 우리 override 는 **구 `economy.v3` 복사본**이라 그 블록이 없다 → "override 가 새 표기를 가리는가?"를 배포 전에 코드로 확인했다. 결론 = **가리지 않는다**: `parseCurrencies` 가 노드 부재/빈 배열이면 **`DEFAULT_CURRENCIES`(POINT→`G`·GEM→`Z`)를 반환**하고, 발행물 `economy.v3.json` 에도 `currencies` 가 없어 **baked·override 모두 같은 폴백**을 쓴다. → **override 유지**(발행물 변경 0)로 진행하고 배포 후 `source=OVERRIDE` + `/api/config` 의 Z/G 를 재확인. ①②마이그레이션 없음 ③발행물 핀 yml·Dockerfile 일치 ⑤web 빌드 통과 ⑥executor 재기동.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **`GET /api/config` (인증 없이 200)**: `currencies=[{POINT, symbol **G**, 골드, ●}, {GEM, symbol **Z**, 다이아, 💎}]` · `grants={initialPoints:3000, **initialGems:12000**}`(= 무배포 override 값이 클라 표기까지 관통) · `shop.gacha={single:GEM 300, ten:GEM 3000}` · `shop.dice={normal:POINT 5000, cash:GEM 10}`.
  - **지갑**(로비·상점·트레이드 헤더): `● 3,000 **G**` · `💎 12,000 **Z**` — 전 화면 동일.
  - **뽑기**: 단뽑 `300 **Z**` · 10연뽑 `3,000 **Z**`. **실결제 검증** — 단뽑 실행 후 지갑 `12,000 Z → 11,700 Z`(정확히 −300). *과거엔 "300 P" 라 쓰고 젬을 빼던 자리다(#213 계열).*
  - **다이스**: 노말 `5,000 **G** 로 구매`(POINT) · 캐시 `💎 10 **Z** 로 구매`(GEM) — **재화별로 다른 심볼**이 정확히 갈린다.
  - **트레이드**: 헤더 재화 표기 `● 3,000 G` 일관.
  - **기존 무회귀**(축약 확인): 가입 스타터 리빌 · 튜토덱 지급 · 매치 생성 → 킥오프 → `GEN1` · **새 매치 409 잠금** · 성장 화면. *풀매치 완주는 이번 변경이 표기 레이어라 생략했다 — 직전 v8.02 에서 완주·정산까지 확인됨.*
  - `version.json` = **`06468e2`** / `engine@0.23.0`.
- **📌 눈에 띌 변화 1건(회귀 아님)**: 상점의 **[충전] 탭이 사라졌다**. 원인은 서버 플래그 `shop.gemTopup.enabled=false` 를 web 이 **이제 따르기 때문**이고, 그 값은 baked `economy.v3.json` 과 override **양쪽 모두 `gems.topupEnabled=false`** 다 — 즉 **데이터는 원래 비활성인데 옛 화면이 하드코딩으로 탭을 그리고 있던 것**. 켜려면 무배포로 가능: override 의 `gems.topupEnabled` 를 `true` 로 바꾸고 `POST /api/admin/economy/reload`(§0.6 절차).
- 프로덕션에 검증 계정 3건(`cur*` 2, `v803p*` 1) 생성. `v803p*` 는 GEN1 중 포기가 막혀(설계상 `stuck-grace` 전 포기 불가) 매치가 끝날 때까지 잠금 상태로 남는다 — 프로브 계정이라 무해.

---

## 2026-07-28T08:14Z — **릴리스 태그 `v8.02`** (점수판·경기시간 #233/#226 + GK 데드볼 이탈 #230 + 중복 playerId 영구정지 #231)
- **git**: **`7f33583`** = 태그 `v8.02` **그대로**(이번엔 배포 중 픽스 커밋 없음). 브랜치 `deploy/v7`.
- **모듈 버전**: engine **`@0.23.0`**(0.22.0 #230 GK 데드볼 이탈 + 0.23.0 #231 중복 playerId) · server-java `0.1.0`(**변경 0**) · web `0.0.0`(#233 점수판·경기시간, #226 헤더) · servants `0.0.1`
- **이미지**: `hmb-runner` `sha256:5dd6bc199603…`(**신규** — engine 0.23.0) · `hmb-java` `sha256:2147c1a03d3c…`(**무변경** — `server-java/**` diff 0 이라 compose 가 recreate 하지 않았고, 그래서 economy override 스냅샷도 그대로 유지됐다)
- **마이그레이션**: **없음**(`bd00b07..7f33583` 에 `db/migration` 변경 0, 라이브 Flyway **v20** 유지). 그래도 백업은 수행 — `pre-v8.02-20260728T081158Z.db`(235,102,208 B · sha256 `37d1d1e8b656c3cdf91eba9c53ea68b694ee174c061c327d81aaa80f019de032` · integrity ok · users 151 / matches 32).
- **executor**: `7f33583` 로 재기동(PID only `84740`→`84738`→`84720`→`84718`, 새 워커 **58680**). 미완 잡 0 상태에서 교체.
- **✅ 신설 체크리스트(§0.5/§0.6) 첫 적용** — 6항목 전부 통과:
  ①마이그레이션 없음 ②비원자 파일 없음 ③**발행물 핀 yml·Dockerfile 일치**(players v2.3 / economy v3) ④**economy override 유지 판단**: `data/players/**` 변경 0 → §0.6 의 2-A/2-B 어느 쪽도 불필요, 유지가 맞다고 판단하고 배포 후 `source=OVERRIDE · initialGems=12000` 재확인(java 재시작 후에도 유지) ⑤web 빌드 통과 ⑥executor 재기동.
- **결과**: ✅ GREEN (실패 요청 0 · JS 에러 0)
  - **점수판·경기시간(#233/#226)**: 경기 중 헤더 `v802p19738 **0 : 0** Crimson Vanguard` + 우측 **`3'`** + `전반 진행 중`.
  - **감독시간 헤더**: `**3 : 0**` + `**45'**` — **v8.01 항목에 비블로커로 적어둔 "감독시간에 0:0 / 0' 로 보인다"가 이번 배포로 해소**됐다.
  - **#231 중복 playerId 실조건 재현·통과**: 상대 덱과 **`P096` 이 양 팀에 동시 존재**하는 매치를 골라(매치 생성→중복 스캔→비중복은 포기, 반복) 킥오프 → **데드볼 영구정지 없이 완주**(`FINISHED 7:1`, 전반 3:0). 픽스 전이라면 데드볼 재시작에서 멈췄을 조건이다.
  - **#230 GK 데드볼 이탈 — 라이브 로그로 계량 검증**: 그 경기 `match_halves.match_log_json`(`configVersion=engine@0.23.0`) 을 직접 분석. 재시작(kickoff/free_kick) **64틱**에서 GK 가 자기 골라인에서 떨어진 거리 = **P074 p50 4.6m / max 5.9m**, **P075 p50 4.2m / max 5.0m**. 전 구간(2,700틱)에서도 **max 6.0m / 7.8m** 로 **박스 깊이 16.5m 를 한 번도 넘지 않았다**(버그 시절 골킥 36.7m·스로인 22.1m 전진과 대조).
  - **기존 무회귀**: 가입(젬 **12,000** — override 적용 확인) · 튜토덱 · 프리웜 킥오프 · E2 클록 완주 · 성장 리포트 15건 · 보상 500P · 잠금 해제.
  - `version.json` = **`7f33583`** / `engine@0.23.0`.
- **⚠️ 진행 순서 기록(중요)**: 배포 도중 hero 의 **HOLD**(“currency #232 까지 포함해 배포, 전환 착수 말고 준비만”)가 도착했는데, **그 시점엔 이미 전환이 끝난 뒤**였다(백업 08:12 → 백엔드 08:13 → executor 08:13 → web 08:14 → 스모크 08:17~ → HOLD 수신). 마이그레이션이 없어 되돌리기는 이미지·web 만의 문제였고, **hero 판단으로 v8.02 를 유지**하기로 했다 — 롤백하면 #230/#231 실관전 버그가 라이브로 되돌아오기 때문. 이후 추가 전환(pull·재빌드·재배포)은 중단했고, currency(#232)는 **다음 열차 `v8.03`** 에서 처리한다.
- 프로덕션에 검증 계정 `v802p19738` + 중복 스캔 중 생성·포기한 매치 몇 건(전부 `ABANDONED`).

---

## 2026-07-28T06:56Z — [운영 조치] **가입 젬 지급액 6,000 → 12,000** (economy 무배포 override, #209 리로드)
> hero 지시. 04:11Z 일괄 지급이 **일회성 백필**이라 이후 가입자가 못 받는 문제를 정식 경로로 해소한 것. **재배포·재빌드·컨테이너 재시작 0.**

- **경로**: `hmb.data.economy-override-file` = **`/var/lib/hmb/economy.override.json`**(DB 볼륨 — 이미지에 구워진 발행물 경로는 쓰기 불가라 볼륨이 기본값) → `POST /api/admin/economy/reload`.
- **override 의 의미(중요)**: **부분 병합이 아니라 문서 통째 교체**다(`EconomyService.loadSnapshot`: override 가 존재하고 파싱되면 그게 스냅샷 전체). 그래서 발행물 `economy.v3.json` 을 **컨테이너에서 그대로 꺼내 `initialGems` 한 필드만 6000→12000 으로 바꿔** 올렸다 — 베이크 대비 **달라진 키는 `initialGems` 하나**임을 diff 로 확인.
- **파일 배치**: `docker cp` → `.tmp` → `chown 10001:999` → **`mv`(원자적 교체)**. 앱과 같은 uid 소유로 맞춰 이후 운영 API 가 이 파일을 다시 쓸 수 있게 했다.
- **적용**: `POST /api/admin/economy/reload` **200** — `source=**OVERRIDE**` · `overrideApplied=true` · `effectivePath=/var/lib/hmb/economy.override.json`. 서버 로그 `Loaded economy v3 … (initialPoints=3000, **initialGems=12000**, starterPack=14 …)`. 사유 필수 인자로 남긴 감사 기록이 `admin_ops_audit`(V18)에 적재됨 — `GET /api/admin/economy/history` 에 `action=economy_reload · result=ok · reason='hero 지시 — 가입 젬 지급 6,000 → 12,000 (무배포 override)'`.
- **검증**: 신규 게스트 가입 → `/api/me` **`{points:3000, gems:12000}`** · 원장 `initial_gems **+12000**` 1행 · 기존 유저 잔액 무변동 · **전 유저 원장합==지갑 불일치 0** · `integrity_check=ok` · 앱 정상(`status.sh` ✓, 터널 경유 401=경로 정상).
- **롤백(무배포)**: `DELETE /api/admin/economy/override` (또는 볼륨에서 파일 삭제 후 `reload`) → 즉시 발행물(BAKED, 6,000)로 복귀.
- **⚠️ 트랩 — 이 override 는 앞으로의 발행물 변경을 가린다**: override 파일이 존재하는 한 **베이크 파일(`economy.v3.json`, 또는 다음 배포가 싣는 `economy.v4…`)은 읽히지 않는다**. 즉 다음 배포에서 economy 를 바꿔도 **조용히 무시된다**. economy 발행물을 바꾸는 배포를 할 때는 **①override 를 지우고 새 발행물을 쓰거나 ②새 발행물 기준으로 override 를 다시 만들어야** 한다. 배포 체크리스트에 넣을 것.

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
