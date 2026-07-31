# 배포 운영 플레이북 — HMB 온라인 (테스터 오픈)

> **한 장짜리 운영 매뉴얼.** "지금 살아있나 / 어떻게 띄우나 / 뭐 터지면 어디 보나" 를 여기서 끝낸다.
> 상세 근거·아키텍처는 [`deploy.md`](./deploy.md). 이 문서는 **손 움직이는 절차**만.
> owned: hmb:p3dep 세션. 스크립트는 `infra/**`.

---

## 0. 지금 이거 (요약)

| | |
|---|---|
| 🌐 **테스터 접속** | **https://hmb-online.pages.dev** |
| 구성 | web=Cloudflare Pages(정적) · 백엔드=hero 머신 도커 · 노출=Cloudflare quick tunnel · AI=호스트 구독 CLI |
| 상태 확인 | `bash infra/status.sh` |
| 포트 | java **18080** · runner **18790** (데모 8080/8790 무접촉) |

**왜 이 구성**: ngrok 무료는 앱 로드 동시요청에서 커넥션이 끊김(실측 0/8). CF quick tunnel 은 8/8.
quick tunnel 은 URL 이 바뀌지만 web 재배포 한 줄로 흡수(§3). 상시 고정 URL 은 §6.

---

## 0.5 배포 전 체크리스트 (매 배포 · 5분)

> 전부 **조용히 실패하는** 것들만 모았다 — 안 걸리면 에러 없이 "된 것처럼" 배포되고, 며칠 뒤
> 엉뚱한 증상으로 되돌아온다. 실제로 다 한 번씩 겪은 항목이다.

| # | 확인 | 명령 / 기준 | 안 하면 |
|---|---|---|---|
| 1 | **새 Flyway 마이그레이션 있나** | `git diff --name-only <배포중인SHA>..<새SHA> -- server-java/src/main/resources/db/migration/` | 백업 없이 스키마가 바뀐다. 있으면 **§8 전체**(백업→검증→리허설→롤백 이미지 고정) 필수 |
| 2 | **`.sql.conf`(`executeInTransaction=false`) 딸린 마이그레이션인가** | 위 목록에 `*.sql.conf` 가 있나 | 비원자 마이그레이션이라 중간에 죽으면 테이블이 사라진 DB 로 남는다(V8·V19 가 그랬다) |
| 3 | **발행물 버전 핀이 두 곳 다 올라갔나** | `grep -n "players-file\|economy-file" server-java/src/main/resources/application.yml` **와** `grep -n "HMB_DATA_" server-java/Dockerfile` 가 **같은 파일명**인가 | ENV 가 yml 을 덮으므로 한쪽만 올리면 **구 시드가 조용히 로드**된다(v8 에서 신규 LEGEND 8종이 통째로 안 실릴 뻔했다) |
| 4 | **economy override 가 볼륨에 남아 있나** | `curl -s -H "Authorization: Bearer <admin>" localhost:18080/api/admin/economy` → `overrideFilePresent` | ⚠️ **아래 §0.6** — 새 economy 발행물이 조용히 무시된다 |
| 5 | **web 이 빌드는 되나** | `npm run build --workspace=@hmb/web` (루트 `npm test`·`typecheck` 는 apps/web 타입을 안 본다) | 백엔드만 전환되고 web 이 옛 버전으로 남는다(v8.01 에서 실제로 배포가 중간에 멈췄다) |
| 6 | **executor 도 새 코드로 재기동했나** | `ps -o lstart= -p <executor pid>` 가 배포 시각 이후인가 | executor 는 **도커가 아니라 호스트 프로세스**라 배포 스크립트가 안 건드린다 — 옛 코드로 계속 돈다(§2-3) |
| 7 | **유저 데이터를 지우는(비가역) 마이그레이션인가** | 새 마이그레이션에 `grep -nE "UPDATE|DELETE|DROP TABLE"` — 걸리면 **무엇이 사라지는지**와 **복원 근거가 DB 안에 남는지**를 읽고 확인 | 스키마 변경과 달리 **백업 없이는 되돌릴 수단이 아예 없다**. 복원 근거를 남기지 않는 소각/삭제라면 배포 전에 그 사실을 hero 에게 확인받는다 |
| 8 | **경기 완주 스모크를 고정 계정으로 도나** | 매치·원정 스모크는 **`deploy-smoke`** 로 로그인(§0.55). 새로 만든 가입확인용 계정으로 **경기를 완주시키지 않는다** | 그 계정이 랭킹에 **영구히 남는다** — 배포마다 한 줄씩 쌓인다(#310) |

## 0.55 스모크 계정 — 가입은 새 계정, **경기는 고정 계정** (#310, hero 확정 2026-07-30)

**오염원은 "가입"이 아니라 "경기 완주"다.** #296 자격 필터는 *완료 경기 1판 이상*인 계정만 랭킹·원정
상대 풀에 싣는다. 그래서 가입만 하고 끝나는 계정은 알아서 걸러지지만, 스모크가 **그 계정으로 경기를
완주해 버리면** 필터를 통과해 리더보드에 영구히 남는다 — 필터는 "한 판도 안 한 계정"을 막지
**"우리 계정"을 막지 않는다.**

실측(v2.03 직후): 리더보드 4위 `d202p7393`(v2.02 스모크), 14~20위가 이전 배포들의 스모크 계정
(`v8probe4605 d2p1434 pw3426 v7probe25 v802p19738 v803p9347 ev24352`). **배포할 때마다 한 줄씩 늘었다.**

| 스모크 항목 | 어느 계정으로 |
|---|---|
| 가입 스타터·튜토덱·지갑 | **매번 새 계정** (지금 그대로) — 경기를 안 시키므로 랭킹에 안 남는다 |
| **경기 완주 · 매치 플로우 · 원정** | **고정 계정 `deploy-smoke`** |

```bash
# 고정 계정 로그인 — 게스트 로그인은 닉네임으로 기존 계정을 **이어받는다**(isNew:false).
# 최초 1회만 새로 생기고, 그 다음부터는 계속 같은 계정이다.
curl -s -X POST "$BACKEND/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"nickname":"deploy-smoke"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["token"], d["isNew"])'
```

- ⚠️ **가입확인용 계정으로 경기를 완주시키지 마라.** 이 한 줄이 이 절의 전부다.
- 누적이 **N줄 → 1줄**로 고정된다(배포를 몇 번 하든 늘지 않는다). 코드 변경·마이그레이션 0.
- **알고 넘어가는 한계**: `deploy-smoke` 자신은 경기를 하므로 리더보드에 **1줄 남는다**. 그게 문제가
  되면 그때 판단한다(일회성 처리 또는 `users` 테스트 플래그). 지금 끊는 건 "매번 쌓이는" 쪽이다.
- ⚠️ **레이팅 차감으로 뒤처리하지 마라.** 차감은 상시 정책이 아니라 hero 가 필요할 때 쓰는
  **일회성 패치**다(hero 확정 2026-07-30). 배포마다 사후 차감하는 운영은 성립하지 않는다.

## 0.6 ⚠️ economy 를 바꾸는 배포 — override 를 먼저 처리하라

`hmb.data.economy-override-file`(기본 **`/var/lib/hmb/economy.override.json`**, DB 볼륨)은 **부분 병합이
아니라 문서 통째 교체**다. `EconomyService` 는 이 파일이 **존재하고 파싱되면 그것만** 읽고 이미지에
구워진 발행물(`economy.v3.json`, 다음 배포의 `economy.v4…`)은 **쳐다보지 않는다**.

→ **그래서 economy 발행물을 바꾸는 배포는 에러 없이 무효가 된다.** 로그도 `Loaded economy … from
/var/lib/hmb/economy.override.json` 이라 정상처럼 보인다.

```bash
# 1) 배포 전: override 가 있는지 본다 (있으면 반드시 처리하고 넘어간다)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:18080/api/admin/economy
#    → {"source":"OVERRIDE"|"BAKED", "overrideFilePresent":true|false, "effectivePath":"…"}

# 2-A) 새 발행물을 쓰겠다 → override 제거 (무배포, 즉시 BAKED 복귀)
curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{"reason":"<배포명> 새 economy 발행물 적용"}' \
     http://localhost:18080/api/admin/economy/override

# 2-B) 운영 조정을 유지해야 한다 → **새 발행물 기준으로 override 를 다시 만든다**
#      (옛 발행물 복사본에 조정을 얹은 파일이면 새 발행물의 변경이 전부 사라진다)
docker exec hmb-java sh -c 'cat /app/data/players/economy.v4.json' > /tmp/econ.new.json
#      ↑ 여기에 운영 조정(예: initialGems)만 다시 얹어서 배치 → reload
docker cp /tmp/econ.new.json hmb-java:/var/lib/hmb/.economy.override.json.tmp
docker exec --user root hmb-java sh -c \
  'chown 10001:999 /var/lib/hmb/.economy.override.json.tmp && \
   mv /var/lib/hmb/.economy.override.json.tmp /var/lib/hmb/economy.override.json'
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"reason":"<배포명> 새 발행물 기준 override 재작성"}' \
     http://localhost:18080/api/admin/economy/reload

# 3) 배포 후 확인 — 의도한 쪽이 실렸는지 source 로 본다(값이 아니라 출처가 답이다)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:18080/api/admin/economy
```

- 파일은 **앱과 같은 uid(10001:999)** 로, **temp→mv 원자 교체**로 놓는다. 소유권을 틀리면 이후 운영
  API 가 그 파일을 다시 쓰지 못한다.
- 리로드는 **사유가 필수**고 성공·실패 모두 `admin_ops_audit`(V18)에 남는다 — `GET /api/admin/economy/history`.
- 현재 적용 중인 조정이 무엇인지는 **`docs/deploy-log.md` 의 [운영 조치] 항목**이 SoT다
  (2026-07-28 가입 젬 6,000→12,000 이 그 예).

---

## 0.7 다음 배포에 걸린 주의 (pending — 그 배포가 끝나면 이 절에서 지운다)

> 배포 지시가 오기 전에 **미리 등록해 두는** 자리다. 여기 있는 건 §0.5 를 돌릴 때 **반드시 같이** 확인하고,
> 처리하고 나면 항목을 지우고 `deploy-log` 에만 남긴다.

**등록분 — #309 운영 컨텐츠 무배포화**(브랜치 `issue/285-deck-icon-policy`, 머지 대기):

- **새 마이그레이션 3개** (현재 V30·V31·V32 로 작성 — ⚠️ 번호는 머지 시점 재배정 가능):
  - `notice_assets`(공지 이미지 메타) · `char_bundles`(아트 번들 리비전) — 둘 다 **additive**
  - ⚠️ **`admin_catalog_audit` 테이블 재작성**(CHECK 에 `unit_purge` 추가) — **`DROP TABLE` 이 있다**
    (§0.5 체크 7 이 잡는 항목). SQLite 는 CHECK 를 ALTER 로 못 바꿔 표준 재작성이 유일한 방법이다.
    **데이터는 변환하지 않고 전 컬럼 복사**, `.sql.conf` 없음 = 트랜잭션 원자적(리허설로 실측:
    중간 실패 시 DROP+RENAME 이 롤백되고 flyway 이력에도 안 남아 재시도 안전), 이 표를 FK 로
    참조하는 표 없음, **인덱스 4개 재생성**(V14 셋 + V15 하나 — ⚠️ 한때 셋으로 잘못 적혀 있었다).
    계약 = `FlywayV32CatalogAuditRebuildTest`.
    ⇒ **§8 백업 + 리허설 권장**(감사 원장이라 잃으면 복원 근거가 사라진다).
- **볼륨에 파일이 추가된다**: `/var/lib/hmb/notice-assets/` · `/var/lib/hmb/char-bundles/`.
  DB 와 **같은 볼륨**이라 일상 배포에는 영향 없지만, **볼륨을 잃을 수 있는 작업 앞에서는
  §8 의 자산 tar 백업도 같이** 뜬다(DB 만 복원하면 공지 그림·아트가 404 가 된다).
- **서블릿 업로드 상한이 8MB → 96MB** 로 올라간다(아트 번들 zip 이 실물 약 6MB). 앱 상한은
  따로다(공지 이미지 2MB · 번들 해제 후 64MB) — 사람에게 보여줄 거절은 항상 앱 상한이 한다.
- **배포 직후 확인(재작성 검증 포함)**:
  `docker exec hmb-java sh -c "sqlite3 /var/lib/hmb/hmb.db 'SELECT COUNT(*) FROM admin_catalog_audit'"`
  → **배포 전 값과 같아야 한다**(재작성이 행을 잃지 않았는가). 그리고
  `… 'SELECT COUNT(*) FROM sqlite_master WHERE tbl_name=\"admin_catalog_audit\" AND type=\"index\" AND name NOT LIKE \"sqlite_%\"'`
  → **4**(인덱스 4개 재생성: `idx_catalog_audit_player`·`idx_catalog_audit_actor`·
  `uq_catalog_audit_idem`·`uq_catalog_audit_create_idem`). ⚠️ **3 이 나오면 회귀다** — 대상별 멱등
  인덱스가 빠진 것이고, 그러면 `update`/`deactivate`/`activate`/`override_reset` 의 DB 백스톱이 없다.
- **배포 직후 확인 1줄**: `curl -sI <터널>/api/notices/assets/x | head -1` → `404`(정상: 없는 자산),
  `curl -s <터널>/api/chars/index | head -c 80` → `404` 본문(정상: 활성 아트 번들 없음 = 구운 폴백 사용).
  둘 다 **500 이면 배포가 잘못된 것**이다.

*(직전 등록분 = `V25` 다이스 소각 · `V21` matches 재작성 — **배포 v2(`deploy-2`, 2026-07-29)에서 소진**.)*

---

## 0.8 배포 실행 실무 — 함정과 판정법 (여러 번 데인 것만)

### 실행 위치·확인
- **`deploy-pages.sh` 는 반드시 리포 루트에서 실행한다.** cwd 가 `infra/` 면 `bash infra/deploy-pages.sh …` 가 **exit 127**(파일 없음)로 죽는다. 이 세션에서 3회 겪었다 — 백엔드 빌드를 `cd infra` 로 하고 이어서 웹 배포를 부르면 바로 걸린다. `cd "$(git rev-parse --show-toplevel)"` 를 앞에 붙여라.
- **`version.json` 은 배포 직후 옛 SHA 로 보인다(CDN 캐시).** 거의 매번 그렇다. **`?cb=$RANDOM` + `Cache-Control: no-cache`** 로 다시 읽어라. `apps/web/dist/version.json`(로컬 산출물)과 대조하면 확실하다. `config.json` 은 `no-store` 라 보통 즉시 반영되지만 첫 조회만 어긋나는 경우가 있다.
- **"라이브에 뜬 것"의 SoT 는 태그가 아니라 컨테이너 digest** — `docker inspect <컨테이너> --format '{{.Image}}'`. 이미지 태그(`hmb/server-java:p3`)는 **다른 워크트리 스택과 공유**돼 언제든 덮인다.

### 브랜치·기록 계보 (⚠️ 실제로 기록을 날릴 뻔했다)
- 배포 대상은 **`release/*` 계보의 태그**일 수 있다(엔진 변경을 떼어내려고 main 대신 체리픽 브랜치를 쓴다). 그건 **배포물** 얘기고,
- **`docs/deploy-log.md` 커밋은 항상 `origin/main` 계보에서 한다.** `release/3.05` 처럼 이전 태그에서 갈라진 브랜치에는 **직전 배포 기록 커밋이 없어서**, 그 위에서 append 하면 앵커를 못 찾아 **조용히 no-op** 이 되거나 직전 항목을 덮는다(실제로 no-op 이 나서 알아챘다).
- 절차: 배포는 태그 체크아웃으로 하고, **기록은 `git checkout -B <작업브랜치> origin/main` 후 append → commit → push**. 앵커(직전 항목 제목)가 파일에 있는지 먼저 `grep -c` 로 확인하라.

### 스모크 판정법 (틀린 판정을 부르는 것들)
- **"보인다/가려졌다" 는 좌표로 판정하지 마라 — 실제로 클릭해서 타이핑해 보고 값을 회수하라.** `elementFromPoint` 가 **조상 컨테이너**를 돌려주는 걸 "가림"으로 오독한 적이 있다(v3.01). 뷰포트 판정도 `getBoundingClientRect` + **입력 성공**을 같이 본다(v3.08 에서 4개 뷰포트 그렇게 검증).
- **프로덕션 설정을 바꾸지 않고 배포 번들만 검증하는 법**: 라이브에서 재현되지 않는 분기(예: 서버가 `-1` 무제한 센티널을 줄 때만 나오는 화면)는 **배포된 번들 그대로 두고 Playwright `route` 로 그 API 응답만 목킹**한다. 게임 규칙 config 를 잠깐 바꾸는 것보다 안전하고 빠르다(v3.05).
- **남의 계정에 로그인하지 마라.** 특정 유저의 화면을 봐야 하는 검증은 ①서버 응답 계약을 **내 프로브 계정**으로 확인 + ②그 유저의 데이터 근거를 **DB 읽기**로 확인, 2단으로 갈음하고 "화면 최종 확인은 소유자 몫"이라고 보고한다(v3.02 #322).
- **못 한 검증은 못 했다고 적는다.** 실패 상황을 인위적으로 못 만드는 것(감독시간 실패 안내), 시즌 완주가 필요한 것(시즌 보상 카드), 게임 규칙을 바꿔야 하는 것(오토 킬스위치)은 **미검증으로 남기고 이유를 쓴다**.

### 운영자 계정 · 오탐
- **admin 계정 = `hmbadmin`**(provider `local`). 비번은 `infra/.env`(`HMB_ADMIN_NICKNAME`/`HMB_ADMIN_PASSWORD`)와 `~/.local/state/hmb/admin-pw-v8.txt`(600)에만 있다 — **리포·로그·이슈에 절대 쓰지 않는다.** 없으면 admin 0명이라 `/api/admin/**` 이 전부 막힌다.
- **`status.sh` 의 CORS 칸은 오탐이 난다** — 터널 응답 한 번에 의존해서, quick tunnel 이 순간 502/000 이면 `CORS: ''` 로 보인다. 놀라지 말고 **로컬 직결**로 확인하라: `curl -sD - -o /dev/null http://localhost:18080/api/config -H 'Origin: https://hmb-online.pages.dev' | grep -i access-control`.
- **터널이 "curl 은 되는데 브라우저만 안 되는" 구간이 있다** — 실측: `curl` 7/8 성공인데 크로미움은 `/api/config`·`/api/auth/login` 에서 `net::ERR_FAILED` 연속. `dns=0.000000s` 로 즉시 실패하면 **로컬 리졸버**가 그 호스트를 못 푸는 것이다(`dig` 로는 풀린다). **해결 = 터널 회전(PID only) + `publish-backend-url.sh`.** 검증만 급하면 `--resolve` / 크로미움 `--host-resolver-rules=MAP <host> <ip>` 로 우회한다.

---

## 1. 상태 확인 (제일 자주 쓰는 것)

```bash
bash infra/status.sh
```
전부 `✓` 면 정상. 하나라도 `✗` 면 그 줄이 뭘 하라는지 알려준다:
- **터널 ✗** → `bash infra/start-tunnel.sh` (아래 §3)
- **백엔드 로컬 ✗** → `cd infra && docker compose up -d java runner`
- **executor !** → §2 의 executor 재기동
- **CORS !** → `WEB_ORIGINS` 가 Pages URL 과 다름 → §5

---

## 2. 처음부터 띄우기 / 머신 재부팅 후

```bash
cd ~/spider10/hmb-online/infra

# 1) 시크릿 (최초 1회만 — .env 없으면)
cp -n .env.example .env && sed -i '' "s/^SERVANT_TOKEN=.*/SERVANT_TOKEN=$(openssl rand -hex 32)/" .env

# 2) 백엔드 3프로세스 중 도커 2개 (java + runner)
docker compose up -d --build java runner
until [ "$(docker inspect -f '{{.State.Health.Status}}' hmb-java)" = healthy ]; do sleep 3; done

# 3) AI 실행기 (모드 A — 호스트 구독 CLI). 백그라운드로.
#    ⚠️ AI_CONCURRENCY=1 + AI_JOB_TIMEOUT_MS=240000 권장 — concurrency=2 는 SQLite lease 경합으로
#       매치 FAILED 유발(#166/#72 실측), 전술생성이 120s 넘어 타임아웃되기도. (근본해결은 #166 도메인.)
cd ~/spider10/hmb-online
source infra/.env
JAVA_URL=http://localhost:18080 SERVANT_TOKEN="$SERVANT_TOKEN" AI_EXECUTOR=claude-code AI_MODEL=sonnet \
  AI_CONCURRENCY=1 AI_JOB_TIMEOUT_MS=240000 \
  nohup npm run executor --workspace=@hmb/server > /tmp/hmb-executor.log 2>&1 &

# 4) 터널 + web 재배포 (원클릭)
bash infra/start-tunnel.sh

# 5) 확인
bash infra/status.sh
```

> `claude` CLI 가 구독 로그인돼 있어야 AI 매치가 돈다(`claude --version` 확인, `ANTHROPIC_API_KEY` 는 미설정 유지 — 있으면 종량과금).

---

## 3. 터널 URL 이 바뀌었을 때 (quick tunnel 재시작 시)

> **보통은 아무것도 안 해도 된다 — 워치독이 자동으로 복구한다(§3.5, #183).** 아래는 수동 개입용.

quick tunnel 은 재시작마다 URL 이 바뀐다. web 이 옛 주소를 가리키면 왕복이 깨진다. 흡수법:

```bash
# 터널이 살아있고 URL 만 새로 알릴 때 — **가장 빠름(≈10초, 빌드 없음)**
bash infra/publish-backend-url.sh https://<새-URL>.trycloudflare.com

# 코드까지 새로 배포해야 할 때 (web 변경 반영)
bash infra/deploy-web.sh https://<새-URL>.trycloudflare.com

# 터널까지 새로 띄우고 재배포까지 한 번에
bash infra/start-tunnel.sh
```
`WEB_ORIGINS`(백엔드 CORS)는 Pages URL(고정)이라 **안 바뀐다** → java 재시작 불필요.

---

## 3.5 자가복구 워치독 (터널이 죽어도 사람이 안 가도 된다 — #183)

quick tunnel 은 **유휴 중에도 죽는다**. 그때마다 URL 이 바뀌는데 web 은 부팅 시
`https://hmb-online.pages.dev/config.json` 에서 백엔드 주소를 읽으므로(런타임 config),
워치독이 **터널을 되살리고 그 파일만 갱신**하면 재빌드·사람 개입 없이 복구된다.

```bash
bash infra/install-tunnel-heal.sh              # 설치/갱신 (launchd, 60초마다, Claude 호출 0)
bash infra/install-tunnel-heal.sh --status     # 등록 상태 + 최근 이벤트
bash infra/install-tunnel-heal.sh --uninstall  # 해제
bash infra/tunnel-heal.sh --check              # 지금 상태만 진단(아무것도 안 바꿈)
bash infra/tunnel-heal.sh --selftest           # 도구·해석기·자격증명 사전점검
tail -f ~/.local/state/hmb/tunnel-heal.log     # 이벤트(HEAL_OK / PUBLISH_ONLY / DEGRADED …)
```

| 이벤트 | 뜻 | 사람이 할 일 |
|---|---|---|
| `HEAL_OK` | 터널 죽음 → 재기동 → web 전파까지 완료 | 없음 |
| `PUBLISH_ONLY` | 터널은 멀쩡한데 web 만 옛 주소 → config 만 재전파 | 없음 |
| `BACKEND_DOWN` | 로컬 java 가 죽어 터널 재기동을 **보류** | `cd infra && docker compose up -d java runner` |
| `DEGRADED` | 1시간에 3번 넘게 치유 시도 → 백오프 | 반복 사망 원인 확인(로그·네트워크) |
| `HEAL_FAIL` | 재기동은 됐는데 전파 실패 | `~/.local/state/hmb/tunnel-heal.log.publish` 확인 |

**실측(2026-07-26)**: 터널 강제 kill → **98초**만에 사람 개입 0 으로 복구. 프로세스는 살아있고
터널만 죽은 경우(2026-07-22 실장애 패턴)도 **53초**. 자세한 근거·설계 = `tunnel-resilience.md`.

**주의**: 배포 스크립트와 워치독은 같은 락(`~/.local/state/hmb/deploy.lock`)으로 직렬화된다.
수동 배포 중 "워치독/다른 배포가 진행 중" 이 뜨면 잠깐 기다리면 된다.

---

## 4. 버그 추적 (관측 수단)

| 보고 싶은 것 | 어디서 |
|---|---|
| **프론트↔백엔드 모든 요청/응답**(본문·헤더·재전송) | **Cloudflare 터널 인스펙터**: `cloudflared` 실행 로그 or 로컬 대시보드. (ngrok 쓸 땐 http://localhost:4040) |
| 서버 에러·예외·시드·마이그레이션 | `docker compose -f infra/docker-compose.yml logs java --tail=100` |
| AI 잡 처리 | `tail -f /tmp/hmb-executor.log` |
| 프론트 JS 에러·네트워크 | 브라우저 devtools (테스터 화면) |
| 특정 API 직접 때려보기 | `curl <터널URL>/api/... -H "Authorization: Bearer <token>"` |

**디버깅 원칙**: "안 된다" 는 신고가 오면 → ① `status.sh` 로 인프라부터 배제 → ② 인스펙터로 실제 요청/응답 확인 → ③ 코드 의심은 그 다음. (덱 버그도 이 순서로 "코드 아니라 터널" 이라 15분에 특정.)

**흔한 오해**: `GET /api/deck → 404` 는 **정상**(덱 안 만든 새 유저 = 빈 덱). web 이 이미 처리함.
진짜 실패는 **응답이 아예 안 오는** `Failed to fetch`(=터널/네트워크). 인스펙터에 요청이 안 찍히면 터널 문제.

---

## 5. CORS 결선 (web ↔ 백엔드 짝)

둘이 맞아야 브라우저가 안 막는다:
- web 빌드: `VITE_API_BASE` = 터널 URL  (요청이 나가는 곳)
- 백엔드: `WEB_ORIGINS`(→`HMB_CORS_ALLOWEDORIGINS`) = **Pages URL**  (허용 오리진)

```bash
# 백엔드 허용 오리진 확인
docker exec hmb-java sh -c 'echo $HMB_CORS_ALLOWEDORIGINS'   # → https://hmb-online.pages.dev 여야 함
# 바꿔야 하면
cd infra && sed -i '' 's|^WEB_ORIGINS=.*|WEB_ORIGINS=https://hmb-online.pages.dev|' .env && docker compose up -d java
```

---

## 6. 상시 고정 URL 승격 — **중단(2026-07-31, hero 확정)**

> 🛑 **하지 않는다.** hero 가 named tunnel 승격을 **전면 중단**하기로 확정했다(2026-07-31).
> **현행 quick tunnel + 워치독 + 런타임 config 전파 구성을 그대로 유지**한다.
> 이 절은 "왜 안 하기로 했나"만 남긴다 — **다시 제안하지 않는다.**

- 승격 시도 경위: 도메인 `hmb-online.com` 구매까지 진행했고 계획도 세웠으나(단절 0 병행 전환),
  전제인 `cloudflared tunnel login` 이 **약 8분 폴링 타임아웃**이라 "URL 을 올려두고 나중에 승인"
  방식이 3회 연속 만료됐다. 대안(대시보드 연결 토큰)까지 갔다가 **hero 가 중단을 확정**했다.
- 그래서 남는 운영 전제(그대로 유효):
  - 터널 URL 은 **바뀐다**. web 은 부팅 시 `/config.json` 을 읽고, 워치독이 그 파일만 갱신한다(§3·§3.5).
  - URL 이 바뀌어도 **재빌드는 필요 없다** — `publish-backend-url.sh <새URL>` 한 줄(≈10초).
  - 2026-07-30 "반쪽 치유"(프로세스 생존·URL 미전파) 장애의 갭 2·3은 **여전히 열려 있다**
    (전파 결과 재확인 없음 · 치유 직후 새 URL 생존 미검증). 재발하면 §3 수동 절차로 복구한다.
    갭 1(로그가 바이너리로 판정돼 URL 캡처가 깨지는 것)은 `grep -a` 로 **닫았다**.

## 7. 정지 / 재배포 / 리셋

```bash
# 정지
kill $(cat /tmp/hmb-cf-tunnel.pid)                  # 터널
cd infra && docker compose down                     # 백엔드(데이터 유지)
# executor 는 호스트 프로세스 — pid 로 kill (ps aux | grep executor-main)

# web 만 재배포 (코드 바뀌었을 때)
bash infra/deploy-web.sh <현재 터널 URL>

# 테스터 데이터 전체 리셋 (⚠️ 전 계정·덱·전적 삭제)
cd infra && docker compose down -v && docker compose up -d
```

---

## 8. DB 백업·복원 (마이그레이션 있는 배포의 선행조건)

> **언제 필수인가**: 새 Flyway 마이그레이션이 껴 있는 배포. 특히 **`executeInTransaction=false` 짝
> 파일(`V*.sql.conf`)이 있는 마이그레이션은 원자적이지 않다** — 중간에 프로세스가 죽으면 테이블이
> 사라진 DB + Flyway failed 로 남아 수동 복구가 필요하다(V8 = `docs/plan-v5/LLD-e2-flow-clock.md` §8).
> 배포 직전에 뜬 백업 없이 그런 배포를 진행하지 않는다.

```bash
# 1) 백업 (라이브 무중단 — sqlite 온라인 .backup, hmb-java 무접촉)
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p ~/.local/state/hmb/db-backups
docker run --rm -v hmb-p3-db:/data:ro -v "$HOME/.local/state/hmb/db-backups:/backup" alpine:3.20 \
  sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 'file:/data/hmb.db?mode=ro' '.backup /backup/pre-<태그>-$TS.db'"

# 2) 검증 (여기까지 통과해야 백업으로 인정)
B=~/.local/state/hmb/db-backups/pre-<태그>-$TS.db
sqlite3 "$B" 'PRAGMA integrity_check;'                 # → ok
sqlite3 "$B" 'select max(version) from flyway_schema_history;'
shasum -a 256 "$B"                                     # 기록용 — deploy-log 에 적는다

# 3) 롤백용 현재 이미지 고정 (태그가 다른 세션 빌드로 덮이는 것 대비)
docker tag "$(docker inspect hmb-java   --format '{{.Image}}')" hmb/server-java:prev-live
docker tag "$(docker inspect hmb-runner --format '{{.Image}}')" hmb/servants:prev-live
```

⚠️ **볼륨에는 DB 말고도 있다 — 업로드 파일(#309).** `hmb-p3-db` 볼륨은 이제
`/var/lib/hmb/notice-assets/`(공지 이미지)와 `/var/lib/hmb/char-bundles/`(유닛 아트 번들 리비전)도 담는다. 위 `.backup` 은
**SQLite 파일만** 뜨므로, 그것만 복원하면 **공지 본문은 살아나는데 그림이 전부 404** 가 된다
(자산 표 행은 돌아왔지만 바이트가 없다). 아트 번들도 같다 — DB 는 "리비전 REV2 서빙 중"이라고
말하는데 그 트리가 없는 상태가 된다. 이 경우 서버가 `/api/chars/index` 를 **404 로 답해**(파일
존재를 확인한다) web 이 **구운 폴백**으로 떨어진다 — 화면은 성립하고 운영자가 켠 아트만 사라진다.
⚠️ 이 문장은 한때 거짓이었다(독립검증 MAJOR-2): index 가 DB 만 보고 200 을 주던 시절엔 매니페스트가
전부 404 가 되어 **화면이 통째로 이니셜**이 됐다. 지금은 서버(파일 확인)와 web(빈 번들 재폴백)
두 층이 막는다. 볼륨을 통째로 잃을 수 있는 작업
(볼륨 삭제·머신 교체) 앞에서는 파일도 같이 뜬다:

```bash
# 업로드 자산 백업(있을 때만 — 없으면 빈 tar 가 나온다)
docker run --rm -v hmb-p3-db:/data:ro -v "$HOME/.local/state/hmb/db-backups:/backup" alpine:3.20 \
  sh -c "tar czf /backup/assets-<태그>-$TS.tgz -C /data notice-assets char-bundles 2>/dev/null || echo '(자산 없음)'"

# 복원
docker run --rm -v hmb-p3-db:/data -v "$HOME/.local/state/hmb/db-backups:/backup:ro" alpine:3.20 \
  sh -c "tar xzf /backup/assets-<태그>-$TS.tgz -C /data && chown -R 10001:999 /data/notice-assets /data/char-bundles"
```

**마이그레이션만 있는 일상 배포에는 필요 없다** — 그 배포는 볼륨을 유지하므로 파일이 그대로 있다.

**리허설(권장)** — 라이브를 건드리지 않고 마이그레이션을 미리 돌려본다:
```bash
docker volume create hmb-rehearsal-db
docker run --rm -v hmb-rehearsal-db:/data -v "$HOME/.local/state/hmb/db-backups:/backup:ro" alpine:3.20 \
  sh -c "cp /backup/<백업파일>.db /data/hmb.db && chown 10001:999 /data/hmb.db"
docker build -f server-java/Dockerfile -t hmb/server-java:rc .          # 리포 루트에서
docker run -d --name hmb-java-rehearsal -p 18081:8080 -v hmb-rehearsal-db:/var/lib/hmb \
  -e HMB_DB_PATH=/var/lib/hmb/hmb.db -e HMB_SERVANT_INTERNALTOKEN=rehearsal \
  -e HMB_SERVANT_ENGINERUNNERURL=http://127.0.0.1:9999 hmb/server-java:rc
docker logs hmb-java-rehearsal 2>&1 | grep -E "Migrating|Successfully applied|ERROR"
# 무손실 확인: PRAGMA foreign_key_check(위반 0) · 자식행 수 동일 · 기존 유저 로그인 isNew:false · 레거시 매치 판독 200
docker rm -f hmb-java-rehearsal && docker volume rm hmb-rehearsal-db
```

**복원(배포 실패 시)**:
```bash
cd infra && docker compose stop java
docker run --rm -v hmb-p3-db:/data -v "$HOME/.local/state/hmb/db-backups:/backup:ro" alpine:3.20 \
  sh -c "rm -f /data/hmb.db /data/hmb.db-wal /data/hmb.db-shm && cp /backup/<백업파일>.db /data/hmb.db && chown 10001:999 /data/hmb.db"
docker tag hmb/server-java:prev-live hmb/server-java:p3   # 이미지도 함께 되돌린다
docker tag hmb/servants:prev-live   hmb/servants:p3
docker compose up -d java runner
bash infra/deploy-pages.sh <터널URL>                       # 옛 코드로 web 재배포(백엔드와 짝을 맞춘다)
```

⚠️ **`PRAGMA foreign_key_check` 은 이미 11건이 나온다(2026-07-30 기준, 선행 상태)** — `matches → bots` 고아다. 리그 시즌이 롤오버되면 봇 팀이 시즌 ULID 접두로 새로 생기고 지난 시즌 봇 행이 사라지는데, 그 시즌 매치의 `bot_id` 가 남아서 생긴다. **배포가 만든 게 아니다** — 판별법은 "배포 전 백업에서도 같은 건수가 나오는가"이고, 실제로 그랬다. 다만 `matches` 를 재작성하는 마이그레이션(V8·V19·V21 계열)이 또 오면 위험하다.

⚠️ **이미지 태그는 머신 전역 공유다**: `hmb/server-java:p3`·`hmb/servants:p3` 를 다른 워크트리의
스택(예: `hmb-growth`)도 쓴다. 내가 빌드하면 그쪽이 다음 recreate 때 내 빌드를 집어가고, 반대도
성립한다. **"지금 라이브에 뜬 것"의 SoT 는 태그가 아니라 `docker inspect <컨테이너> --format '{{.Image}}'`
digest** 다 — deploy-log 에는 그 digest 를 적는다.

---

## 9. 오픈 GO 전 잔여 (인프라 밖)

- **B3 고지**: 로그인 화면/공지에 "평문 목업 — 실제 비번 입력 금지"
- 도메인별 점검(`open-checklist.md` §1~§9): 계정 무회귀·모바일 실기기·법적 판타지 전환
- hero 실플레이 1회: 덱 구성→매치 생성→결과 (라이브 AI 실동작)
