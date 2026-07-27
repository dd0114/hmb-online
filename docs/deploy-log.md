# 배포 기록 (deploy-log) — append-only

> **정책(P4-D5 / #171)**: 배포할 때마다 이 파일 맨 위(최신순)에 항목을 append 하고 커밋한다.
> "언제 무슨 버전이 배포됐나"의 SoT. AI·사람이 repo에서 바로 조회. `infra/version-manifest.sh` 산출을 여기에 옮겨 적는다.
> 항목 형식: 배포시각(UTC) · git SHA/브랜치 · 모듈별 버전(engine/server-java/web/servants) · 이미지 다이제스트 · tunnel/URL · 배포자 · 결과/비고.

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
