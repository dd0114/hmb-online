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

- **새 마이그레이션 2개**(둘 다 **additive** — 기존 표/데이터 무변경): `notice_assets`(공지 이미지 메타)
  · `char_bundles`(유닛 아트 번들 리비전). ⇒ §0.5 체크 1 에 걸리므로 **§8 백업 필수**.
  ⚠️ 번호는 머지 시점에 재배정될 수 있다(main 이 배정 — 현재 V30/V31 로 작성됨).
- **볼륨에 파일이 추가된다**: `/var/lib/hmb/notice-assets/` · `/var/lib/hmb/char-bundles/`.
  DB 와 **같은 볼륨**이라 일상 배포에는 영향 없지만, **볼륨을 잃을 수 있는 작업 앞에서는
  §8 의 자산 tar 백업도 같이** 뜬다(DB 만 복원하면 공지 그림·아트가 404 가 된다).
- **서블릿 업로드 상한이 8MB → 96MB** 로 올라간다(아트 번들 zip 이 실물 약 6MB). 앱 상한은
  따로다(공지 이미지 2MB · 번들 해제 후 64MB) — 사람에게 보여줄 거절은 항상 앱 상한이 한다.
- **배포 직후 확인 1줄**: `curl -sI <터널>/api/notices/assets/x | head -1` → `404`(정상: 없는 자산),
  `curl -s <터널>/api/chars/index | head -c 80` → `404` 본문(정상: 활성 아트 번들 없음 = 구운 폴백 사용).
  둘 다 **500 이면 배포가 잘못된 것**이다.

*(직전 등록분 = `V25` 다이스 소각 · `V21` matches 재작성 — **배포 v2(`deploy-2`, 2026-07-29)에서 소진**.)*

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

## 6. 상시 고정 URL 로 승격 (선택 — 지금은 불필요)

quick tunnel 은 hero 머신·터널이 살아있는 동안만 URL 유지. 진짜 상시 오픈이 필요해지면:
- **named tunnel**(무료+도메인 ~$10/yr): `cloudflared tunnel login` → deploy.md §5.2. 이후 URL 고정.
- **ngrok 유료**(~$8/mo): 고정 URL + 동시요청 제한 제거.
- 둘 다 하면 `deploy-web.sh <고정URL>` 한 번만 하고 끝(재배포 반복 불필요).

---

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

⚠️ **이미지 태그는 머신 전역 공유다**: `hmb/server-java:p3`·`hmb/servants:p3` 를 다른 워크트리의
스택(예: `hmb-growth`)도 쓴다. 내가 빌드하면 그쪽이 다음 recreate 때 내 빌드를 집어가고, 반대도
성립한다. **"지금 라이브에 뜬 것"의 SoT 는 태그가 아니라 `docker inspect <컨테이너> --format '{{.Image}}'`
digest** 다 — deploy-log 에는 그 digest 를 적는다.

---

## 9. 오픈 GO 전 잔여 (인프라 밖)

- **B3 고지**: 로그인 화면/공지에 "평문 목업 — 실제 비번 입력 금지"
- 도메인별 점검(`open-checklist.md` §1~§9): 계정 무회귀·모바일 실기기·법적 판타지 전환
- hero 실플레이 1회: 덱 구성→매치 생성→결과 (라이브 AI 실동작)
