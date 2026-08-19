## 2026-08-19T08:28Z — **서버 이사 컷오버 (맥 → 윈도우 랩탑)** — #489 / 런북 #472

- **성격**: 배포가 아니라 **호스트 이전**이다. 코드는 라이브와 같은 SHA 로 고정했고(`d76c6c68`),
  바뀐 것은 **어느 기계가 응답하느냐** 뿐이다.
- **git**: `d76c6c68ee03292f81a20d854403f403a967d1bf` (= 라이브 java 이미지가 빌드된 v3.29 SHA, detached)
- **모듈 버전**: engine 0.1.0(무접촉) · server-java 0.1.0(**새 머신에서 재빌드**) ·
  web 0.0.0(**무접촉 — 맥의 `dist-current`(`git=c938c6d7`) 를 그대로 이송해 발행**) · servants 0.0.1
- **이미지**(새 머신 빌드): java `sha256:e0e571c8007b1d2a659c4b3683dba103f8302389454f0a6b2ae9bc4ee3f22759`
  / runner `sha256:8076738c7ddf983cd1f45d6d5ff0d769fad7e5037eac73791ff29a60b938bc36`
- **DB**: `hmb-p3-db` 737,316,864 B · sha256 `f5b5a2aadd8efb993fe5f27dfd15641913e8a0de16f5ce48d2f05907682bd974`
  (양측 대조 일치) · Flyway **44 validated** · users 226 / matches 131 · `integrity_check ok`
- **URL**: web `https://hmb-online.pages.dev` (고정) → apiBase
  `https://physicians-imported-summit-helpful.trycloudflare.com` (랩탑 quick tunnel)
- **다운타임**: `08:14:59Z` → `08:28:02Z` = **13분 03초**
- **AI**: 모드 A 유지하되 **`~/.claude` 이송 안 함**(3.9GB) — 랩탑에서 `claude setup-token` 재로그인.
  실행기 기동 로그 `AI 모드 live — 구독 로그인 확인됨(claude-code)`.

### 왜 13분이나 걸렸나 — 전송이 아니라 **두 건의 사고 수습**이다

DB 전송 자체는 **16초**였다(warm 복사 + `rsync --inplace` delta: 737MB 중 실제 전송 **425KB**,
speedup 1199x). 정지 창을 먹은 것은 다음 둘이다.

1. ⚠️ **런북 P2-12 가 정지 상태에서 실패한다** — `docker run -v hmb-p3-db:/data:ro … 'file:…?mode=ro'`
   가 `unable to open database file` 로 죽는다. WAL 의 `-shm` 을 만들 수 없어서인데, **라이브일 땐
   그 파일이 이미 있어 통과하고 정지하면 사라진다** = *런북이 쓰라고 지정한 바로 그 상태에서만 실패*.
   → rw 마운트로 `.backup`(소스는 읽기만 한다). 소요 1분 49초.
   ⚠️ 이 실패는 **조용했다** — 직전 백업 파일이 남아 있어 그 다음 `integrity_check`·`shasum` 이
   **옛 파일에 대해 통과**했다. 해시를 새로 찍지 않았다면 낡은 DB 를 이송할 뻔했다.
2. ⚠️ **wrangler 가 macOS AppleDouble 찌꺼기에서 죽는다** — 이송 팩이 맥에서 만들어져
   `dist-current`/`.functions` 에 `._*` 파일이 **224개** 딸려왔고, esbuild 가
   `functions/share/notice/._[id].js:1:0: ERROR: Unexpected "\x00"` 로 실패했다.
   그 결과 `PUBLISH_FAIL` → 라이브가 **죽은 옛 터널을 계속 가리키는 상태로 3분** 더 머물렀다.
   → `find … \( -name '._*' -o -name '.DS_Store' \) -delete` 후 재발행 성공.

### 검증 (전부 컷오버 후 실측)

```
config.json   apiBase=physicians-imported-… · updatedAt 2026-08-19T08:27:40Z
백엔드        /internal/health 401 · 0.158s          (토큰 있으면 200 JSON)
runner        /health 200
web           pages.dev 200
CORS          preflight 200 · allow-origin https://hmb-online.pages.dev
admin         admin bootstrap: nickname='hmbadmin' — admins=1
워치독        active · 터널 정상 · DEGRADED 없음 · 라이브 프로젝트로 전환 완료
실행기        폴링 시작(claude-code:sonnet, concurrency=1)
```

### 구 머신(맥) 상태 — **롤백 자산으로 남긴다**

컨테이너 정지 · 터널 정지 · 실행기 정지 · **워치독 해제**(P0-7 — 안 끄면 두 머신이 같은 Pages 를
서로 덮는다. 배포 락은 머신 간 공유되지 않는다). DB·이미지는 그대로 있다. 지우지 않는다.

⚠️ **시크릿 팩(`hmb-move.tar.gz`)은 양쪽에서 삭제했다.**

---

## 2026-08-14T10:13Z — **배포 v3.30 — web 단독** — 터널 사망 긴급 복구 + admin 서브탭(#498)·공지(#473)

- **git**: `739f6b13787ba78ff2a70f534a6c7e53834b233e` (`origin/main`, `dirty: false`) ← 라이브 `d76c6c68`(v3.29)
- **모듈 버전**: engine **0.43.0 (무접촉)** · server-java 0.1.0(**무접촉 — 이미지·컨테이너 그대로**) ·
  web 0.0.0(**재빌드 + 재배포 — 아래 §web**) · servants 0.0.1(**무접촉**)
- **이미지**: java `sha256:68c90a8548dec85f18817fdd91eaf34f9aa7b2f64ff9953fb67d903f957e1831`(**무변경**)
  / runner `sha256:97a82f3f362b2864eb95f2e9b002816090d75bd177d5c028f9511a41657648d1`(**무변경**)
  · 롤백 핀도 v3.29 그대로(이번 배포는 도커를 만들지 않았다)
- **컨테이너 재기동 0회**(실측): `hmb-java` `StartedAt = 2026-08-13T14:01:31Z`(=v3.29 전환 시각) 그대로,
  `hmb-runner` `2026-08-13T13:08:17Z` 그대로. `deploy-web.sh` 는 `WEB_ORIGINS` 를 만지지 않으므로
  v3.29 노트가 경계한 **CORS 재결선용 java recreate 경로를 아예 타지 않는다**.
- **Flyway**: **무접촉** — server-java diff 0건 · 재기동 0회. 백업도 뜨지 않았다(DB 를 건드리는 단계가 없다).
- **배포시각**: 터널 기동 `2026-08-14T10:13:21Z` → 등록 `10:13:28Z`(7초) → web `/config.json` `10:13:44Z`
- **URL**: web `https://hmb-online.pages.dev` (Pages 배포 `https://0b49d507.hmb-online.pages.dev`)
  / 백엔드 터널 `https://translation-sellers-rounds-corn.trycloudflare.com` (pid 83512, **회전함**)
- **스코프** `1dd9c4a3..739f6b13`: `apps/web/**` **24건** · `server-java/**` **0건** · `packages/**` **0건** ·
  `data/**` **0건** · `infra/**` **0건** → **web 만 재배포하면 되고, java/runner 는 만질 이유가 없다**.
- **무엇이 올라갔나**: PR **#503**(#498 admin 서브탭, merge `1c71f3be`) · PR **#476**(#473 공지 히어로 이미지 +
  닫기=1주 억제, merge `739f6b13`).

**§web — 이번엔 재배포했다 (v3.29 와 반대인 이유)**

v3.29 는 `apps/web/**` diff 가 **0건**이라 "재빌드해도 같은 바이트"였고 재배포에 실비용(java recreate)만
있어서 **안 했다.** 이번엔 두 축이 다 뒤집혔다:
1. **`apps/web/**` 24파일이 실제로 바뀌었다**(#498 admin 서브탭 · #473 공지) — 재배포하지 않으면 그 두 PR 이
   테스터에게 도달하지 않는다.
2. **터널 URL 이 회전했다** — `VITE_API_BASE` 가 빌드 인라인이고 `/config.json` 이 런타임 결선이라,
   URL 이 바뀌면 web 재배포는 **선택이 아니라 복구 그 자체**다(그게 이 배포의 시작점이다).

**미오픈 캐릭터 유출 게이트(§0.7)**: **PASS** — 두 PR 의 `apps/web` diff 에 **신규 캐릭터 아트 0건**.
공지 히어로 이미지는 `scripts/notice-hero/make-notice-hero.py` 생성물이고 `.gitignore` 에 들어갔다.

**⚠️ 이 배포는 계획된 것이 아니라 장애 복구였다**

- 증상: `status.sh` 에서 **터널 ✗** = 테스터 접속 불가. 백엔드·runner·executor·web 은 **내내 정상**이었다.
- 워치독(#183/#497)이 `09:59:50Z` · `10:04:57Z` **두 번 치유를 시도해 두 번 다 실패**했고
  (`HEAL_FAIL 새 URL 획득 실패`), 사람이 `10:13:21Z` 에 `bash infra/start-tunnel.sh` 로 살렸다.
- **다운타임 09:59:49Z → 10:13:28Z = 13분 39초.** 규명·후속 = 아래 §워치독 + **#505**.

**검증(콜드 실측)**

| 축 | 결과 |
|---|---|
| `status.sh` | **10/10 ✓** (java·runner·executor·로컬 18080·터널 pid 83512·터널경유 401·web 200·CORS 결선·워치독 심박·web→백엔드 결선) |
| 터널 경유 백엔드 | `/internal/health` **401**(토큰 없음 = 경로 정상) |
| web | `https://hmb-online.pages.dev` **200** |
| `/config.json` | `apiBase` = 새 터널 URL · `source: build` · `updatedAt 2026-08-14T10:13:44Z` |
| 워치독 추적 | `--check` = `✓ 터널 정상 — translation-sellers-rounds-corn…` · 심박 갱신 중 · `DEGRADED` 마커 **없음** · 설치본(`~/.local/bin/hmb-tunnel-heal.sh`)은 `origin/main` 판과 **SYNCED**(자동설치 배너 2줄만 차이) |
| 스트레이 프로세스 | `cloudflared` **1개뿐**(pid 83512) — 실패한 치유가 남긴 좀비 없음 |

**⚠️ 발견 — 이 배포물에는 `version.json` 이 없다 (라이브 버전 오독의 함정)**

`start-tunnel.sh` → **`deploy-web.sh`** 경로는 `version-manifest.sh` 를 **부르지 않는다**(부르는 것은
`deploy-pages.sh` 뿐이다). 그래서:
- 새 배포물 `https://0b49d507.hmb-online.pages.dev/version.json` = **SPA 폴백 index.html**(463B).
- 그런데 apex `https://hmb-online.pages.dev/version.json` 은 **200 에 740B 를 준다** — CF 엣지 캐시가
  `cache-control: s-maxage=604800`(7일)로 **v3.28 시점 매니페스트**(`b851bdcc` · java `5043de47`)를
  물고 있다(`cf-cache-status: HIT`, `age: 79625` ≈ 22시간).
- ⇒ **`version.json` 을 라이브 버전의 SoT 로 읽으면 두 세대 전을 읽는다.** 라이브 결선의 SoT 는
  `/config.json` + 이 로그이고(v3.29 노트와 같은 결론), 버전 식별은 **이 항목**이 SoT 다.
- 후속(코드 수정 제안) = **#506**.

---

## 2026-08-14T10:00Z — **장애 기록(무배포)** — 워치독 자동복구 2회 연속 실패 → 사람이 손으로 복구

배포가 아니라 **위 v3.30 을 유발한 장애**의 규명 기록이다. 조치는 `start-tunnel.sh` 1회뿐.

**타임라인(전부 `~/.local/state/hmb/tunnel-heal.log` 실측)**

| 시각(UTC) | 사건 |
|---|---|
| 09:56:59 | `BLIP` — 1차 실패 `http:530`, 재확인에서 회복 → 치유 안 함 |
| 09:59:49 | `UNHEALTHY` — 2회 연속 `http:530`(CF 엣지가 오리진에 못 닿음) |
| 09:59:50 | `HEAL_START` — 기존 터널 pid 71748 종료, 새 cloudflared pid 75065 기동 |
| 10:00:23 | cloudflared: **`failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host`** |
| 10:02:27 | `HEAL_FAIL 새 URL 획득 실패` |
| 10:04:57 | `HEAL_START`(reason=`url-unknown`) — pid 77018 기동 |
| 10:13:16 | `HEAL_FAIL 새 URL 획득 실패` |
| 10:13:21 | **사람**이 `start-tunnel.sh` 실행 (2차 FAIL 로부터 **5초 뒤**) |
| 10:13:28 | 새 터널 등록 성공 — 요청→등록 **7초** |

**규명된 것 — 1차 실패의 원인은 cloudflared 의 DNS 다.** 워치독이 매달리거나(#391) 락을 굶긴 것이
**아니다**: 두 번 다 정직하게 시도하고 정직하게 실패했으며, `DEGRADED` 도 서지 않았고 좀비도 안 남겼다.
실패한 것은 `cloudflared` 가 **자기 등록 엔드포인트를 해석하지 못한 것**이다(`no such host`).
`10:13:21Z` 사람 실행은 **같은 명령이 6초 만에 성공**했다 = 그 시점엔 DNS 가 돌아와 있었다.

**규명 못 한 것(추정하지 않는다)**
- **2차 시도(10:04:57)의 실패 사유는 증거가 없다.** cloudflared 로그는 `/tmp/hmb-cf-tunnel.log` **단일
  파일**이고 회전은 치유가 새로 뜰 때 `.prev` 로 한 번뿐이라, 사람이 `10:13:21Z` 에 실행한
  `start-tunnel.sh` 가 그 로그를 **덮어썼다**(`.prev` 는 1차 시도분 = mtime `10:00Z`). 원인 소실.
- **왜 한 시도가 벽시계로 그렇게 오래 걸렸나**: URL 획득 루프는 공칭 `30 × sleep 2` = **60초**인데
  실측은 1차 **157초**, 2차 **499초**다. `HEAL_START 09:59:50` → cloudflared 첫 로그줄 `10:00:23`
  = 기동에만 **33초**가 걸린 것까지가 관측이고, 그 지연의 원인은 **규명하지 않았다**(당시 부하 기록
  없음. 참고로 사후 `10:18Z` 실측 `load average 50.61` — 같은 시각의 값이 아니므로 근거로 쓰지 않는다).

**패턴 — 첫 치유는 4/4 로 실패한다**(같은 로그, 최근 4개 장애 전수)

| 장애 | 1차 | 2차 | 3차 | 회복 |
|---|---|---|---|---|
| 08-13 02:01:59 | FAIL 02:05:06 | **OK 02:09:09** | — | 자동, 7분 10초 |
| 08-13 12:09:26 | FAIL 12:13:33 | FAIL 12:16:54 | **OK 12:18:57** | 자동, 9분 31초(**상한 3/h 에 정확히 닿음**) |
| 08-14 02:03:35 | FAIL 02:05:47 | **OK 02:08:49** | — | 자동, 5분 14초 |
| 08-14 09:59:50 | FAIL 10:02:27 | FAIL 10:13:16 | (사람이 5초 먼저) | **수동, 13분 39초** |

즉 **복구를 실제로 만드는 것은 재시도**이고 상한은 `MAX_HEALS_PER_HOUR=3`(`heal.conf` 없음 = 기본값)이라
**여유가 한 번뿐**이다. 그리고 §11 이 광고하는 **MTTR 98초는 최근 실측(5~10분)과 맞지 않는다.**

⇒ 이슈 **#505**(#497·#391 링크). 이번 배포는 재기동·재배포 외 조치를 하지 않았다.

---

## 2026-08-13T14:01Z — **배포 v3.29 — java 단독** — 멱등 튜토리얼 호출의 이벤트 중복 (#496)

- **git**: `d76c6c68ee03292f81a20d854403f403a967d1bf` (`origin/main`, `dirty: false`) ← 라이브 `b851bdcc`(v3.28)
- **모듈 버전**: engine **0.43.0 (무접촉)** · server-java 0.1.0(재빌드) · web 0.0.0(**무접촉 — 재배포 안 함, 아래 §web**) · servants 0.0.1(**무접촉**)
- **이미지**: java **`sha256:68c90a8548dec85f18817fdd91eaf34f9aa7b2f64ff9953fb67d903f957e1831`**
  / runner `sha256:97a82f3f362b2864eb95f2e9b002816090d75bd177d5c028f9511a41657648d1`(**무변경**)
  / 롤백 핀 `hmb/server-java:prev-live` = `sha256:5043de472c20…`(v3.28) · `hmb/servants:prev-live` = `sha256:97a82f3f…`
- **Flyway**: **V44 유지 — 새 마이그레이션 0건.** 부팅 로그 `Current version of schema "main": 44`(적용 0).
- **배포시각**: java 전환 `2026-08-13T14:01:31Z` → healthy 30초
- **URL**: web `https://hmb-online.pages.dev` / 백엔드 터널 `https://pack-pipe-python-madrid.trycloudflare.com` (pid 3562, **회전 없음**)
- **스코프**: `b851bdcc..d76c6c68` 에서 `apps/web/**` **0건** · `packages/**` **0건** · `data/**` **0건** ·
  `application.yml`/`Dockerfile` 발행물 핀 **무변경** → **runner 재빌드·executor 재기동·web 재배포 전부 불필요**.
  실질 코드 변경은 **server-java 2파일**(`BusinessEventRecorder`·`OnboardingController`)뿐이다.

**무엇이 올라갔나**: **#496** — `POST /api/me/tutorial-complete` 는 **멱등**이라 여러 번 불리는데(모달 재닫기·
건너뛰기 재시도) 그때마다 `business_events` 에 1행을 남겨 **이벤트 보드 스트림 상단이 같은 "튜토리얼 완료"로
도배**됐다. 새 `BusinessEventRecorder.recordOnce` 가 **유저당 1행**으로 좁힌다. 게이트를 `users.tutorial_done`
플래그가 아니라 **스트림에 그 행이 있는가**로 둔 것이 설계의 핵심 — `record` 는 예외를 삼키는 best-effort 라
첫 기록이 실패하면 플래그 방식은 **영영 결손**되고 퍼널이 그 유저를 "튜토리얼 미도달"로 오독한다(스트림을 보면
자가 치유한다). 실패는 **fail-open**(중복 검사가 던지면 그냥 기록 — 잡음 제거보다 이벤트 보존이 우선).

**동승 — infra (PR #501, `#497`/`#489`)**: **라이브에는 이미 적용돼 있었다.** 워치독은 리포가 아니라 설치 사본
(`~/.local/bin/hmb-tunnel-heal.sh`)이 도는데, #497 세션이 이미 재설치를 끝냈다 — 이번 배포에서 **동기 확인만** 했다
(`diff` 로 `origin/main` 판과 **SYNCED**, plist 의 `WorkingDirectory` **부재**, 심박 `last-tick` 갱신 중).
새 `status.sh` 가 그 사실을 처음으로 화면에 보여준다: `자가복구 워치독: 가동 중 (심박 39초 전, exit=0)`.

**§web — 재배포하지 않았다(판단 근거)**

`b851bdcc..d76c6c68` 의 `apps/web/**`·`packages/**` diff 가 **0건**이라 재빌드해도 **바이트가 같은 번들**이 나오고,
바뀌는 것은 `version.json` 의 git SHA 각인뿐이다. 반면 재배포에는 실비용이 있다 — `deploy-pages.sh` 가 CORS
재결선으로 **java 를 한 번 더 recreate** 한다(v3.28 에서 `.env` 함정이 두 번 발화한 그 경로다). 얻는 것 0 · 위험 >0
이라 **하지 않았다.** 그래서 **라이브 `version.json` 은 `b851bdcc` 로 남아 있고 그게 정상이다** — 라이브 결선의
SoT 는 `version.json` 이 아니라 `/config.json` 이며(`{"apiBase": "https://pack-pipe-python-madrid…", "source":"heal"}`
= 12:18Z 치유값 그대로), `status.sh` 의 `web→백엔드 결선` 항목이 그것을 본다.
⇒ **미오픈 캐릭터 유출 게이트(§0.7)는 발화 자체를 안 한다** — 배포물을 만들지 않았으므로.

**절차**: §0.5 체크리스트 → 백업 → 롤백 핀 → 이미지 전환 → 검증. (마이그레이션 0건이라 §8 리허설은 불요.)
- **백업**(마이그레이션이 없어도 떴다 — 라이브 **Flyway 44 시점의 복원점이 아직 없었다**):
  `~/.local/state/hmb/db-backups/pre-v496-20260813T135841Z.db` (729,063,424 B)
  `sha256 493d11a3f54e528da06d77a8a3d4a3ebaddfcf95e4e0c7560b7f8940d87a2c0a`
  검증 = `integrity_check: ok` · flyway `max(CAST(version AS INTEGER))` **44**
  ⚠️ 검증 시 `?mode=ro` 는 **에러 14 로 죽는다** — `.backup` 산출물이 WAL 모드 헤더를 물고 있어 `-shm` 생성이
  필요한데 마운트가 읽기전용이다. **`?immutable=1`** 로 열어야 한다(v3.28 이 남긴 함정이 그대로 재발화).
- **재기동 안전성**: 진행 중 매치(state ∉ {FINISHED,FAILED,ABANDONED}) **0건** 확인 후 전환. 엔진·`resumeState`
  무접촉이라 #241 축 무관. **recreate 는 1회뿐**(web 재배포를 안 했으므로) — `admins=1` 확인도 1회.

**검증(전부 콜드 실측)**

| 축 | 결과 |
|---|---|
| `.env` 함정(§0.7) | 이번엔 **발화 안 함** — `spider18` 에 `.env` 존재, 라이브 생성 워크트리 `spider2` 와 **md5 동일**(`0ba73623…`) · `HMB_ADMIN_NICKNAME` 존재 |
| AdminBootstrap | `admin bootstrap: nickname='hmbadmin' … — **admins=1**` |
| Flyway | `Current version of schema "main": 44` · 적용 **0건** |
| economy | `Loaded economy v4 from /var/lib/hmb/economy.override.json (initialGems=12000)` — **OVERRIDE 유지**(§0.6 무처리) |
| 이미지 내용물 | 전환 **전에** jar 바이트코드 확인 — `BusinessEventRecorder.recordOnce` 존재 · `OnboardingController` 가 그것을 **호출** |
| **#496 실동작** | 신규 프로브 계정으로 `/api/me/tutorial-complete` **4회** 호출(1회차 `deckGranted:true`, 2~4회차 `false`) → `business_events` 에 `tutorial_complete` **정확히 1행** |
| **#496 전수** | 라이브 전체 `tutorial_complete` **9행 / 9유저** · **`rows_per_user > 1` 인 유저 0명**. 대조군으로 `deck_save` 는 같은 유저에 **2행**이 그대로 남아 있다(반복이 의미를 갖는 이벤트엔 안 걸렸다 = 과적용 아님) |
| 이벤트 보드 API | 미인증 `/api/admin/events` **401** · admin `?event=tutorial_complete&size=50` → **9행, 중복 유저 NONE** |
| 퍼널 무회귀 | 프로브 계정이 `reached.tutorial: true` 로 **정상 계상** · `eventCount: 2`(signup+tutorial_complete, 4회 호출에도 2) — 중복 제거가 **계측을 죽이지 않았다** |
| 무회귀 스모크 | `/api/config` `/api/players` `/api/deck` `/api/me` `/api/league` `/api/league/rankings` `/api/away/candidates` `/api/away/season` `/api/me/record` `/api/me/matches` `/api/presets` `/api/modes` `/api/me/starter-grant` — **로컬 13/13 200 · 터널 경유 13/13 200** |
| 튜토리얼 계약 | `/api/config` → `tutorial.starterCardId: "P122"` (로컬·터널 양쪽) |
| 워치독(#497) | `status.sh` 신판이 **심박**을 보여준다 — `가동 중 (심박 39초 전, exit=0)`. 설치본 = `origin/main` 판과 SYNCED |
| `status.sh` | **전 항목 ✓** (10/10) |

⚠️ **§0.55 준수** — 경기 완주 스모크는 **고정 계정 `deploy-smoke`** 로 돌았다(`isNew: false` = 재사용, 랭킹에
새 줄 안 생김). #496 프로브 계정(`dep0813v496*`)은 **가입 + 튜토리얼 완료까지만** 밟았고 경기를 완주하지 않아
#296 자격 필터로 랭킹·원정 풀에 잡히지 않는다.

## 2026-08-13T11:58Z — **배포 v3.28 — 풀스택(java + web)** — 온레일 튜토리얼 (#493) + 이벤트 보드 (#492)

- **git**: `b851bdcc0f710daf89fa85b123f4dfe9c1017646` (`origin/main`, `dirty: false`)
  — v3.27 과 달리 **커밋된 트리에서 발차**했다. PR #495 머지분(11:47:43Z) + #492 는 이미 main(PR #494).
- **모듈 버전**: engine **0.43.0 (무접촉)** · server-java 0.1.0(재빌드) · web 0.0.0(재배포) · servants 0.0.1(**무접촉**)
- **이미지**: java **`sha256:5043de472c208f8bb9c12f6aaeb2e27a3db4c3fcf4d70eec2177084bfae27806`**
  / runner `sha256:97a82f3f362b2864eb95f2e9b002816090d75bd177d5c028f9511a41657648d1`(**무변경**)
  / 롤백 핀 `hmb/server-java:prev-live` = `sha256:1c1f281e4864…`(v3.27) · `hmb/servants:prev-live` = `sha256:97a82f3f…`
- **Flyway**: **V42 → V44** (V43 `user_coupons` · V44 `matches.is_tutorial`). additive only · `.sql.conf` 없음 · UPDATE/DELETE/DROP **0**.
- **배포시각**: java 전환 `11:58:07Z` · web `deployedAt 2026-08-13T11:59:54Z`
- **URL**: web `https://hmb-online.pages.dev` / 백엔드 터널 = 발차 시 `smtp-statements-tomorrow-awards…`
  → **12:09Z 회전**(아래 §터널) → 현재 `https://pack-pipe-python-madrid.trycloudflare.com` (pid 3562)
- **스코프**: `21b95629..b851bdcc` 에서 `packages/**` **0건** · `data/**` **0건** → 엔진 무접촉이라
  **runner 재빌드·executor 재기동 불필요**(§0.5-6 자동 충족) · 발행물 핀 무변경(`players.v2.8.1`/`economy.v4`/`bots.v4`/`league.v2`,
  yml·Dockerfile 양쪽 일치) · economy `source: OVERRIDE` 유지(§0.6 처리 불필요).

**무엇이 올라갔나**: **온레일 튜토리얼(#493)** — 신규 유저를 22스텝으로 안내하는 스포트라이트 코치마크
(`apps/web/src/onrail/**`, `data-testid` 로 대상을 겨눈다). 덱(자동채우기→선수→한마디→저장) → 경기 전 브리핑 →
경기화면 투어 6종 → 결과 → 성장 → 영입. 서버는 `matches.is_tutorial`(V44)로 튜토리얼 매치를 구분하고
`user_coupons`(V43)가 보상 지급 키를 잡는다. **이벤트 보드(#492)** 는 PR #494 로 이미 main 에 있었고 이 빌드에 동승.

**절차**: §0.5 체크리스트 → §8 백업·검증·**리허설** → 이미지 전환 → 검증.
- **백업**: `~/.local/state/hmb/db-backups/pre-v493-20260813T115431Z.db` (724,869,120 B)
  `sha256 00db0387ff51ddbe1b9c4bf7489b014c1170231298d815a4bcc663c94f5dda25`
  검증 = `integrity_check: ok` · flyway `max(CAST(version AS INTEGER))` **42** · users **216** · user_players **3626** · matches **128** · `foreign_key_check` **11**(선행 상태 그대로)
- **리허설**(별도 볼륨 `hmb-rehearsal-db` + 포트 18085): `Current version: 42` → `Successfully applied 2 migrations … now at version v44`.
  무손실 = users 216 · user_players 3626 · matches 128 **전부 동일** · `user_coupons` 신설 0행 · 기존 128 매치 `is_tutorial=0` 기본값 ·
  fk_check 11 · integrity ok · **기존 유저 로그인 `isNew:false`** · `/api/config` 200 · `/api/me/matches` 200(20행).
- **재기동 안전성**: 진행 중 매치(state ∉ {FINISHED,FAILED,ABANDONED}) **0건** 확인 후 전환. 엔진 무접촉이라 #241 축은 무관.

**⚠️ §0.7 함정이 또 발화했다 — `infra/.env`**: 이 워크트리(`spider18`)에도 `.env` 가 **없었다**(v3.27 `spider22` 와 동일).
라이브 컨테이너를 만든 `spider2` 의 `.env` 를 복사하고 **라이브 컨테이너 env 와 값 해시 대조**로 4키
(`SERVANT_TOKEN`·`HMB_ADMIN_NICKNAME`·`HMB_ADMIN_PASSWORD`·`WEB_ORIGINS`) 전부 MATCH 확인 후 발차했다.
⚠️ **recreate 가 두 번 일어난다** — 이미지 전환 1회 + `deploy-pages.sh` 가 CORS 재결선으로 1회. **두 번 다 `admins=1`** 확인
(최종 `12:00:10Z AdminBootstrap … admins=1`). 리허설 컨테이너는 admin env 가 없어 `admins=0 (revoked=1)` — 함정의 실물 증거.

**검증(전부 콜드 실측)**

| 축 | 결과 |
|---|---|
| Flyway | `Current version: 42` → `Successfully applied 2 migrations … now at version v44` |
| 무회귀 스모크 | `/api/config` `/api/players` `/api/deck` `/api/me` `/api/league` `/api/league/rankings` `/api/away/candidates` `/api/away/season` `/api/me/record` `/api/me/matches` `/api/presets` `/api/modes` `/api/me/starter-grant` **13/13 200** |
| 튜토리얼 계약 | `/api/config` → `tutorial.starterCardId: "P122"` (로컬·터널 양쪽) |
| 이벤트보드 API | `/api/admin/events` · `/api/admin/events/funnel` 미인증 **401** / admin **200** |
| `version.json` | 배포본이 로컬 `dist/version.json` 과 **완전 동일**(CDN 스테일 아님) · `git.dirty: false` |
| CORS | `access-control-allow-origin: https://hmb-online.pages.dev` |
| **① 튜토리얼 진입**(실브라우저) | 신규 가입 → 스타터 팩(**선수 15명 · 3,000 G · 12,000 Z**) → 홈 온보딩 7스텝 → **"같이 한 판 해볼까요?"** 제안 → 수락 시 온레일 **[1/22] deck-auto** 진입 |
| **② 브리핑 + [킥오프]**(W11 회귀 자리) | **[6/22] `match-brief`** 말풍선 *"경기 전 브리핑 … [킥오프]를 누르면 경기가 시작돼요"* + `kickoff-button` **링 하이라이트**(딤 뚫림) — 실캡처로 눈 확인 |
| **③ 경기화면 투어 · [스킵] 잠김** | `[7/22]`①스코어보드 → `[8]`②경기장면 → `[9]`③타임라인 → `[10]`④재생·배속 → `[11]`⑤통계 → **`[12]`⑥건너뛰기에서 `match-skip` `disabled = true`** |
| ④ 이벤트 보드 화면 | admin 로그인 → `/event-board` **정상 렌더** — 퍼널 표(가입/튜토리얼/덱/뽑기/연습/리그/원정 도달) + 이벤트 스트림(종류 필터·페이지네이션). 신규 가입·튜토리얼 진입이 **즉시 계상**(probe 계정이 `튜토리얼까지`로 표시) |
| `status.sh` | **전 항목 ✓** (10/10) |

⚠️ **§0.55 준수** — 실브라우저 검증은 **경기를 완주하지 않았다**(`match-skip` 스텝에서 중단). 온레일은 그 뒤
`result-view → growth → trade` 로 이어지지만 그건 경기 종료를 요구하므로 랭킹 오염 방지를 위해 밟지 않았다.
가입 확인용 계정 3개(`dep0813*`)는 미완 매치만 남고 #296 필터로 랭킹에 안 잡힌다.

**§터널 — 배포 후 quick tunnel 이 회전했다(배포물과 무관)**

`12:09:26Z` 워치독이 `http:530` 감지 → 자가치유 시작. 발급이 **3회 실패**(1차 = 맥 웨이크 직후
`lookup api.trycloudflare.com: no such host`, 2·3차 = `Post https://api.trycloudflare.com/tunnel: context deadline exceeded`)
후 `12:18:57Z` **HEAL_OK** — 새 URL `pack-pipe-python-madrid`. **MTTR 9분 31초, 수동 개입 0.**
web 은 재배포하지 않았다 — 런타임 config(#183)가 `config.json` 을 `{"apiBase": …, "source": "heal"}` 로 갱신해
**빌드 없이 결선이 따라간다**(`status.sh` 의 `web→백엔드 결선` 항목이 이걸 본다).
⚠️ 그래서 **배포본 `version.json` 의 `tunnel.apiUrl` 은 낡는다**(빌드 시점 각인). 라이브 결선의 SoT 는
`version.json` 이 아니라 **`/config.json`** 이다.
⚠️ **오늘 하루 URL 회전 2회 · 발급 실패 3회** — quick tunnel 상시 취약점 정리와 고정 URL 승격 권고는 #122 코멘트에 남겼다(결정은 hero).

**⚠️ 운영자 함정(이 머신 한정, 테스터 무관)**: 회전 직후 이 맥의 `getaddrinfo` 가 새 터널 호스트를
못 풀었다(mDNSResponder 가 AAAA 만 캐시 → `curl`/`ping` 은 `Could not resolve host`, `dig`/`host` 는 정상).
`status.sh` 는 `dig +short` → `curl --resolve` 로 **시스템 리졸버를 우회**해서 영향을 안 받는다.
같은 이유로 **운영자가 `curl <터널>` 로 확인할 때만** 실패한다 — `--resolve` 로 핀하거나 `status.sh` 를 믿어라.
mDNSResponder 플러시는 머신 전역 상태라 **하지 않았다**(다른 fleet 세션과 공유).

## 2026-08-12 23:34 KST — [장애] Docker 데몬 사망 → 백엔드 전체 다운, 수동 복구
- 증상: Docker Desktop 프로세스 종료(원인: 업데이트/크래시 추정) → hmb-java·hmb-runner 다운, 백엔드 405. 워치독은 BACKEND_DOWN 기록만 가능(터널 전용). 웹은 점검 안내(#477) 노출.
- 복구: Docker Desktop 재기동(6s) → compose up java runner → healthy 12s → status 전항목 ✓. DB 볼륨 무손상.
- 재발 방지: usage-guard 사이클에 docker 데몬 liveness 체크 추가(죽으면 매니저 세션 통지) — 이번 커밋.
## 2026-08-10T07:53Z — **배포 v3.27 — 풀스택(java + web)** — 비즈니스 이벤트 원장 + `/event-board` (#492)

- **git**: `21b95629` (브랜치 `feat/492-event-board`) **+ uncommitted feat/492-event-board (#492)**
  ⚠️ **미커밋 워킹트리에서 발차했다** — `version.json.git.dirty: true`. 머지는 매니저 소관이고,
  이 배포물은 `21b95629` + 미커밋 diff(server-java `events/**`·V42 · apps/web `eventboard/**`)다.
  라이브에 뜬 것의 SoT 는 SHA 가 아니라 **이미지 digest**(아래).
- **모듈 버전**: engine **0.43.0 (무접촉)** · server-java 0.1.0(재빌드) · web 0.0.0(재배포) · servants 0.0.1(**무접촉**)
- **이미지**: java **`sha256:1c1f281e4864d2e9c0f4e16bd8ecba19b7e50c64ff09f19ba5ae8690d283176b`**
  / runner `sha256:97a82f3f362b2864eb95f2e9b002816090d75bd177d5c028f9511a41657648d1`(**무변경**)
  / 롤백 핀 `hmb/server-java:prev-live` = `sha256:2bd0958c78e8…`(v3.26)
- **Flyway**: **V41 → V42** (`business_events`). additive only · `.sql.conf` 없음 · UPDATE/DELETE/DROP **0**.
- **터널**: `https://peninsula-rules-postcard-telephony.trycloudflare.com` (pid 3948, **회전 없음**)
- **web**: `https://hmb-online.pages.dev` 재배포(`69874f30`). `version.json` = 로컬 `dist/version.json` 과 **동일**(CDN 스테일 아님).
- **배포자**: 배포 실행 세션(#492 AC7 선결). hero 승인 = *"같이올려 케릭터 공개 상관없어 배포해"*.

**무엇이 올라갔나**: 유저 행동을 기록하는 원장(`business_events`) + 운영자 조회 API
(`GET /api/admin/events` · `/api/admin/events/funnel`) + 운영자 전용 화면 `/event-board`.
계측 훅은 가입·튜토리얼·덱저장·뽑기·매치·리그·원정 컨트롤러에 붙는다. 롤백 스위치 =
`HMB_EVENTS_ENABLED=false`(**재배포 없이** 계측 전량 정지).

**동승분(라이브에 처음 올라가는 것)** — `c24dbba8..21b95629` 범위. 마이그레이션 0건 · `data/**` 0건:
- **AI 모드 표시**(server-java `AiModeService`/`InternalAiModeController` · web `/api/config` aiMode 안내) — #472 계보
- #471 로컬 스택 원커맨드(`scripts/local-stack.sh`)·README·infra 이사 스크립트 = **런타임 무영향**
- ⚠️ `packages/server/src/executor/ai-mode.*` 가 같이 들어왔으나 **executor 는 재기동하지 않았다**
  (호스트 프로세스, `spider12` 체크아웃 소유 · 4 proc 정상 가동 중). 서버 쪽은 additive 라 미재기동이
  기존 동작을 깨지 않는다 — AI 모드 배선의 executor 절반만 **미반영**이다(§0.5-6 미충족, 의도적).

**절차**: §0.5 체크리스트 → §8 백업·검증·**리허설** → 이미지 전환 → 검증.
- **백업**: `~/.local/state/hmb/db-backups/pre-v492-20260810T074443Z.db` (708,366,336 B)
  `sha256 a4233e1da314a7dab04f3f29f7a316df0dc967c2bb7eca76429b16d0bdce599b`
  검증 = `integrity_check: ok` · `flyway max: 41` · users **213**
- **리허설**(별도 볼륨 + 포트 18085 — 18081 은 타 세션 점유): V42 적용 성공, 무손실 확인
  (users 213 · user_players 3580 · matches 124 · `foreign_key_check` **11** = §8 기재 선행 상태와 동일)
- **재기동 안전성**: 진행 중 매치(state ∉ {FINISHED,FAILED,ABANDONED}) **0건** 확인 후 전환.
  엔진 무접촉이라 #241 `resumeState` 축은 애초에 무관.

**⚠️ §0.7 함정이 실제로 발화했다 — `infra/.env`**: 이 워크트리(`spider22`)에 `.env` 가 **아예 없었다**.
그대로 `compose up` 했으면 `SERVANT_TOKEN` 미설정으로 죽거나 admin 이 회수됐다. 라이브 컨테이너를
만든 `spider15` 의 `.env` 를 복사했고, **해시 대조로 동일 확인**(servant token · admin password 둘 다
라이브 컨테이너 env 와 일치). 리허설 컨테이너는 admin env 가 없어 `admins=0 (revoked=1)` 이 찍혔다 —
**이 함정이 실재한다는 실물 증거**다. 라이브는 전환 후·web 재배포 후 **두 번 다 `admins=1`** 확인.

**검증(전부 콜드 실측)**

| 축 | 결과 |
|---|---|
| Flyway | `Current version: 41` → `Successfully applied 1 migration … now at version v42` |
| `GET /api/admin/events` | 미인증 **401** / admin **200** `{"items":[],"total":0,…}` |
| `GET /api/admin/events/funnel` | 미인증 **401** / admin **200** `{"generatedAt":…,"users":[]}` |
| 터널 경유 동일 | config 200 · events 미인증 401 · events admin **200** · CORS `access-control-allow-origin: https://hmb-online.pages.dev` |
| **계측 실발화 ①** | 신규 가입(`ev492p21902`) → `user_signup` 즉시 기록, 퍼널에 `reached.signup: true` |
| **계측 실발화 ②** | `deploy-smoke` 덱 재저장(PUT 200, 동일 덱 왕복) → `deck_save` `{created:false, formation:"4-4-2", slotCount:15}` |
| `/event-board` 화면 | admin 로그인 후 **정상 렌더** — 퍼널 표(가입/튜토리얼/덱/뽑기/연습/리그/원정) + 이벤트 스트림 2행. 미인증은 `/login` 리다이렉트(404 아님) |
| 무회귀 스모크 | `/api/config` `/api/players` `/api/deck` `/api/me` `/api/league` `/api/league/rankings` `/api/away/candidates` `/api/away/season` `/api/me/record` `/api/me/matches` `/api/presets` `/api/modes` **전부 200** |
| `status.sh` | **전 항목 ✓** |

- ⚠️ **§0.55 준수**: 가입 확인은 **새 계정**(`ev492p21902`, 경기 **미완주** → #296 자격 필터로 랭킹 밖),
  게임 행동 스모크는 **고정 계정 `deploy-smoke`**(`isNew:false`). 랭킹 오염 **0줄**.
- **economy**: `source: OVERRIDE` 유지(`initialGems=12000`) — economy 발행물 무접촉이라 §0.6 처리 불필요.
- **미검증**: 매치 완주 경로의 `match_start`/`match_finish`, 뽑기(`gacha_pull`), 리그 시즌 시작 훅은
  **라이브에서 발화시키지 않았다**(경기 완주는 §0.55 오염 축, 뽑기는 젬 소모). 컨트롤러 훅 배치는
  브랜치 계약(`BusinessEventHookPlacementTest`·`BusinessEventFlowTest`) 소관으로 남긴다.

## 2026-08-09T17:40Z — **배포 v3.26 — 백엔드 단독** — 개명 캐리오버 수리 v2.8.1 (#483 / 패널 blocker A)

- **git**: `c24dbba8` (브랜치 `data/483-fictional-rename`)
- **모듈 버전**: players **v2.8 → v2.8.1** · server-java(동일 코드, 소비 경로만 스위치) · engine 무접촉 · web **무배포** · runner **무접촉**
- **이미지**: java `sha256:2bd0958c78e8c8fc1308d5874c4ead3b70905dc1e50dc9b5069dbd58cf9192af` / runner 무변경
- **터널**: 변경 없음 (`wise-symposium-webmaster-brick.trycloudflare.com`)
- **web**: 재배포 없음 — 표시명은 서버 카탈로그 응답으로만 흐른다(#483 R F4, 프로덕션 번들에 이름 0건)

**왜**: v2.8(v3.25) 출하분에서 tier:H 스켑틱 패널이 작명 결함을 잡았다 — `P135 앙헬 고메스 → "앙헬로 킨타"`
(성만 바뀌고 given 이 한 음절만 덧붙음). 같은 계약이 프리즈된 v2.7 활성 카드에서 `P096 알렉시스
맥 알리스터 → "알렉 페르잔"` 을 하나 더 잡아 함께 수리했다(**보유자 212명**). minor 2건 동반(P084·P082).

**재기동 안전성**: 직전 진행 중 매치(state ∉ {FINISHED, FAILED, ABANDONED}) **0건** 확인 후 `docker compose up -d java`.

| 축 | 재기동 전 | 재기동 후 |
|---|---|---|
| `meta_kv.players_version` | v2.8 | **v2.8.1** |
| `user_players` (유저 보유 행) | 3565 | **3565** (무손실) |
| `players` 행수 | 182 | 182 |
| 수리 전 이름 4종 잔존 | 4 | **0** |
| v2.6 실명 잔존(name/short, 표본 301) | 0 | **0** (유지) |
| 표시명·shortName 전역 중복 | 0 | 0 |

**공개 경로 E2E**(신규 가입 → `GET /api/players`): 62행 · P096 `네스토르 페르잔` · 실명 잔존 0 · 수리 전 이름 0.
**보유자 축**: P096 212명 · P082 5명 · P084 2명 · P135 3명 전부 새 이름으로 조회된다.

⚠️ **미해결(분리)**: `reward_bundles.sections_json` 이 매치 종료 시점 이름을 박제해 재조인 없이
`GET /api/matches/{id}/result` 로 내보낸다(라이브 15/21행, 미확인 7/10행) → **#485**(server-java 소관).
현재 그 경로가 실제로 구실명을 보이는 유저는 0명이지만 구조적 방지가 아니다.

## 2026-08-09 21:59 KST — [운영] 터널 다운 복구 (수동)
- 증상: quick tunnel 사망(워치독 DEGRADED, 힐 한도 소진 추정) → 테스터 접속 불가. 컨테이너·Pages 는 정상.
- 조치: `bash infra/start-tunnel.sh` — 새 터널 URL=wise-symposium-webmaster-brick.trycloudflare.com, web 재배포·결선 완료, status 전항목 ✓.
- 참고: usage-guard 조회 실패 6회는 같은 시간대 네트워크 계열 — 복구 후 정상(weekly 32%).

# 배포 기록 (deploy-log) — append-only

> **정책(P4-D5 / #171)**: 배포할 때마다 이 파일 맨 위(최신순)에 항목을 append 하고 커밋한다.
> "언제 무슨 버전이 배포됐나"의 SoT. AI·사람이 repo에서 바로 조회. `infra/version-manifest.sh` 산출을 여기에 옮겨 적는다.
> 항목 형식: 배포시각(UTC) · git SHA/브랜치 · 모듈별 버전(engine/server-java/web/servants) · 이미지 다이제스트 · tunnel/URL · 배포자 · 결과/비고.

---

## 2026-08-09T17:10Z — **배포 v3.25 — 백엔드 단독** — 은퇴 120종 표시명 가상화 (#483 / PR #484)

- **git**: **`39c3fe3f`**(main, merge of #484). 범위 = `data/players/**` **3** + `server-java/**` **4**
  (`application.yml` · `Dockerfile` · `DataVersionParityTest` · `PlayerCatalogV28SeedTest` 신설)
  + `epics/`·`evidence/` 문서. **`apps/web`·`packages/**`·`infra/**` 전부 0** — Flyway 무접촉.
- **탑재**: `players.v2.7` → **`players.v2.8`**. #450 이 은퇴시키며 실명으로 남겨 둔 **120종**의
  표시명을 가상 인물명으로 교체. `active=0` 은 **획득만** 막고 도감·덱 편성은
  `WHERE p.active = 1 OR 보유수 > 0`(#207 U-D7) 이라 **보유분은 계속 보였다** —
  라이브 실측 유저 **210명 중 207명**이 실명 카드 보유(106종·726행), P081·P092 는 스타터팩.
- **이미지**: java **`sha256:f0afb687…`**(재빌드) · runner `sha256:97a82f3f…`(**무변경**).
- **web**: **재배포 없음.** 프로덕션 번들 전수 grep 실명 **0건**(실명이 있는 파일은
  `import.meta.env.DEV` 게이트 라우트라 빌드에서 제거) ⇒ 미오픈 캐릭터 프리즈 리스크를 경로에서 제거.
- **터널**: `https://wise-symposium-webmaster-brick.trycloudflare.com` (pid 79390, **회전 없음**).
- **절차**: `docker compose build java` → `up -d java`. 재기동 직전 **진행 중 매치 0건** 확인 후 실행
  (매니저 지시 조건). runner·executor·web 무접촉.
- **배포자**: hmb:rename 세션(#483). 머지 = hmb:main 매니저.

### 라이브 검증 (재기동 전/후)

| 축 | 전(v2.7) | 후(v2.8) |
|---|---|---|
| `meta_kv.players_version` | v2.7 | **v2.8** |
| players 행 / active·inactive | 182 / 62·120 | 182 / 62·120 |
| **실명 잔존**(v2.6 축 301종 대조) | **120건** | **0건** |
| `user_players` 행 | 3535 | **3535**(무손실) |
| users | 210 | 210 |
| `admin_locked` | 0 | 0 |
| 은퇴카드 보유 유저/행 | 207 / 726 | 207 / 726 |
| 전역 중복 표시명 / shortName | — | 0 / 0 |
| 이름 빈칸 행 | — | 0 |

E2E(터널): `POST /api/auth/register` → `GET /api/players` → 62행 · 실명 **0건**.
`playerId` 불변이라 보유·성★·잠재·전적·덱 편성 **전부 무손실**. 증빙 = `evidence/483/`.

---

## 2026-08-09T06:51Z — **배포 v3.24 — web 단독** — 첫 진입 스플래시 (#479 / PR #481)

- **git**: **`32f675ab`**(main, squash merge of #481). 범위(`e05a58ce`..`32f675ab`) = **167 files**
  = `apps/web` **167** / `packages/**`·`server-java/**`·`data/**`·`infra/**` **전부 0** — 발행물 핀·Flyway·이미지 무접촉.
  ⚠️ **매니페스트의 SHA 는 `db4b4db1`(브랜치 HEAD)로 찍혀 있다** — 빌드를 머지 직후 `web/479-splash`
  워크트리에서 돌렸기 때문이고, 그 트리는 `git diff origin/main` **빈 출력**이라 내용은 `32f675ab` 과 동일하다.
  (다음부터는 배포 전 `git checkout main` 을 먼저 한다 — 매니페스트가 헷갈릴 이유가 없다.)
- **탑재**: PR **#481**(#479). `/login` **첫 진입에 15초 연출**(#475 동결본 `v1-final-20260809`) →
  **[게임 시작]** → 현행 로그인 폼. **로그인 후 동선 무변경.**
- **에셋**: `apps/web/public/splash/` **137 파일 · 4.5MB**(시퀀스 136 프레임 + 뽑기 실화면 1). 전량 신규.
- **이미지**: java `sha256:ab9d3735…` · runner `sha256:97a82f3f…` — **v3.21 이후 무변경**(web 단독).
- **web 번들**: `index-DY6sqW-L.js`(직전 `index-C5uJx1QC.js`). 라이브 index.html 이 이 이름을 참조함을 확인.
- **터널**: `https://breaking-treasures-gold-mrna.trycloudflare.com` (pid 43660, **회전 없음**).
- **배포자**: hmb:splash 세션(#479 자율주행). hero 지시 = "메인에 머지하고 마무리하자".

### 노출 규칙 (hero 확인)

세션당 1회(`sessionStorage`)이고, **이미 로그인된 사람에겐 안 뜬다** — 도메인 진입은 `/` → 토큰 있으면
`/home` 직행이라 스플래시 자리를 지나가지 않는다(`App.tsx` 루트 라우트). hero 컨펌: *"로그인한 사람은
안 보여줘도 돼."* 공유 딥링크(`?returnTo=`)에도 안 띄운다 — 그 사람의 목적지는 그 링크다(#298 보존).
규칙은 `apps/web/src/splash/splash-gate.ts` 한 곳이 소유하므로 정책 변경은 그 함수 하나.

### 배포 전 프리즈 체크 (미오픈 캐릭터) — **통과**

1. **이 열차가 추가한 public 에셋 137개가 전부 `splash/` 아래** — `chars/`·`data/chars` **빈 diff**.
2. **연출에 구워진 카드 아트 3종이 이미 라이브에 있다** — 뽑기 실화면(`shots/76-reveal-all.webp`)에
   실아트로 찍힌 P010(보날두 LEGEND)·P032(Mbappé DIA)·P036(Lautaro DIA) → `card-natzt.png` **200/10,713B** ·
   `card-ragna.png` **200/10,441B** · `units/art-*.png` **10/10 200**. 로컬 `chars/stamp.json` = 라이브와 바이트 동일.
   ⇒ **이 배포로 새로 열리는 캐릭터 0.**
   ⚠️ 측정은 **에셋 HTTP 코드 + 바이트 수**로 했다 — v3.23 이 밟은 `401→빈 배열` 오탐(표본 0)이 원리적으로 안 생기는 축이다.
   ⚠️ 중간에 `git diff main...HEAD` 가 **낡은 로컬 `main`(=`57e91e08`)** 을 머지베이스로 잡아 #477 의 QR 이미지를
   내 것으로 셌다. `git fetch origin main` 후 재측정. **배포 delta 는 항상 `origin/main` 으로 잰다.**

### 라이브 스모크 — **배포된 번들로** (목킹 아님)

`https://hmb-online.pages.dev/` 에 실제로 붙어 폰(iPhone 13)·데스크탑 두 뷰포트:

| 확인 | 폰 | 데스크탑 |
|---|---|---|
| 도메인 → `/login` 스플래시 등장 | +0.7s | +0.2s |
| [게임 시작] 클릭 → `provider-choose`(현행 로그인 폼) | +1.0s | +0.3s |
| **같은 세션 2회차 재진입 → 안 뜸**(로그인 폼 직행) | ✓ | ✓ |
| 137파일 프리로드 완료 → 연출 실제 재생(2.2초 간격 두 프레임 픽셀 상이) | ✓ ~1s | ✓ ~1s |

⚠️ **[게임 시작]은 처음부터 떠 있다**(연출 종료를 기다리지 않는 상시 조작점) — 위 "+0.7s" 는 CTA 컷 시각이
아니라 **버튼이 조작 가능해진 시각**이다. 4.5MB 가 버튼을 늦추지 않는다는 뜻이고, 그게 이 스모크가 답한 질문이다.
(다만 **광대역 + CF 엣지 기준**이다 — 실제 모바일 회선 스로틀링은 재지 않았다.)

### 게이트

`apps/web` 유닛·e2e·`npm run build` = PR #481 에서 콜드 통과(#479 Q 단계). 배포 후 확인은 위 라이브 스모크.
CDN 전파는 **파일별로 시차**가 있었다 — 배포 직후 apex 가 `version.json`·`shots/*` 를 구버전으로 주다가
15초 내 수렴(직접 배포 URL `7835438b.` 은 처음부터 신규). 판정은 **에셋 바이트 수**로 했다(SPA fallback 이
`index.html` 463B 를 200 으로 돌려주므로 **HTTP 200 만으로는 존재 증명이 안 된다**).

---

## 2026-08-08T16:14Z — **배포 v3.23 — web 단독** — 백엔드 다운 시 점검 안내 화면 (#477 / PR #478)

- **git**: **`d0924dd`**(main, squash merge of #478). 범위(`ef11361`..`d0924dd`) = **28 files** =
  `apps/web` **13** + evidence/docs/infra **15**. **`packages/**`·`server-java/**`·`data/**` 무접촉**(빈 diff)
  — 발행물 핀·Flyway·이미지 전부 v3.22 그대로.
- **탑재**: PR **#478**(#477). 백엔드에 못 닿을 때 앱 대신 뜨는 **점검 안내 화면**
  (오탐 방지 확인 프로브 · [다시 시도] · 자동 재확인 15s · **카카오 오픈채팅 QR + 링크**).
- **이미지**: java `sha256:ab9d3735…` · runner `sha256:97a82f3f…` — **둘 다 v3.21 이후 무변경**(web 단독).
- **web 번들**: `index-C5uJx1QC.js`(직전 `index-zHMNRi65.js`). CDN 전파 = 배포 직후 3회 조회 중 2회 신규 —
  index.html 이 `max-age=0, must-revalidate` 라 잔여 엣지 사본은 재검증으로 수렴(§0.8 판정법 그대로).
- **터널**: `https://breaking-treasures-gold-mrna.trycloudflare.com` (pid 43660, **회전 없음** — 도착 시점에 살아 있었다).
- **배포자**: hmb:maint 세션(#477 자율주행). hero 지시 = "머지하고 배포해봐".

### 오픈채팅 = **실코드로 출하**(placeholder 아님)

hero 가 QR 이미지를 줬고, 그 QR 을 디코드해 `https://open.kakao.com/o/gfI71WHi` 임을 확인한 뒤
상수(`apps/web/src/common/support-contact.ts`)를 `hmbonline-temp` → **`gfI71WHi`** 로 교체했다.
QR 이미지와 링크가 **서로 다른 방**을 가리키는 것이 이 기능의 가장 그럴듯한 사고라 둘을 같이 맞췄다.

- QR 은 **웹 오리진 정적 에셋**(`/support/kakao-openchat-qr.jpg`). `/api/` 뒤에 두면 **백엔드가 죽은
  바로 그 순간** QR 만 깨져 PC 유저의 유일한 연락 수단이 사라진다 → 계약 3건이 그 경로를 막는다.
- 교체 절차는 그 파일 머리말이 SoT(코드 1줄 + 이미지 덮어쓰기 + 재배포).

### 배포 전 프리즈 체크 (미오픈 캐릭터) — **통과**

1. **이 열차의 에셋 delta = 0** — `git diff ef11361..HEAD -- apps/web/public/chars/ data/chars` **빈 diff**.
2. **매핑된 캐릭터 전원이 오픈 상태** — 빌드 산출 `dist/chars/units/manifest.json` 의 `forPlayer` 9종
   (P173·P174·P175·P176·P177·P179·P180·P181·P182)이 **라이브 DB 에서 9/9 `active = 1`**.
   ⚠️ 이 축을 `GET /api/players` 로 재려다 **401 이 빈 배열로 정규화돼 "위반 0"** 이 나왔다 —
   그건 통과가 아니라 **표본 0**이다(루트 계약함정 #6). 그래서 컨테이너 DB 사본을 직접 읽어
   **9/9 행이 실제로 조회됨**을 같이 확인했다. 다음에도 행 수를 먼저 봐라.

### 라이브 스모크 — **배포된 번들로 양방향 확인**

목킹이 아니라 실제 `hmb-online.pages.dev` 에서 백엔드 오리진만 차단해 두 상태를 다 태웠다:

| 상태 | 결과 |
|---|---|
| 백엔드 정상 | 점검 화면 **0개** (8초 대기 후) — 오탐 없음 ✓ |
| 백엔드 차단 | 점검 화면 노출 · 링크 `https://open.kakao.com/o/gfI71WHi` · **QR `naturalWidth=800`**(실제로 그려짐) ✓ |

`/support/kakao-openchat-qr.jpg` → HTTP 200 · image/jpeg · 83,962 B. 증빙 = `evidence/477/p477-LIVE-maintenance-390.png`.
⚠️ QR 은 `toBeVisible()` 로 재지 않는다 — 깨진 이미지도 통과한다. 라이브에서도 `naturalWidth` 로 잰다.

### 게이트 (콜드)

`apps/web` 유닛 **2418 passed / 8 skipped** · e2e `p477-maintenance` **8 passed** · 캡처 **2 passed** ·
`npm run build` ✅. 신설 계약 3건은 **변이로 사망 확인**(QR 경로를 `/api/` 로 옮기면 unit 2 + e2e 1 이 죽는다).
---

---

## 2026-08-07T09:14Z — **운영 조치(무배포)** — 공지 노출 토글 3건 (hero 지시)

- **배포 아님**: 코드·이미지·재빌드 0. `POST /api/admin/notices/{id}/active` **3회**뿐.
- hero 지시: *"권씨공지사항 올리고 업데이트 관련 공지사항은 내리자"* (재확인 *"권씨 공지사항 다시
  활성화해줘. 업데이트 공지사항은 내리고"*).

| 공지 | id | 조치 |
|---|---|---|
| 신규 레전더리 선수 권씨 등장! | `01KZ366VARXGRY8SC38P5M5RBX` | **OFF → ON** |
| 로스터 개편 안내 — 선수 이름 변경 · 선수풀 정리 | `01KZ9N4Z822ZMC9HYW1WY9ZDA5` | **ON → OFF** |
| 경기 엔진 대규모 업데이트 | `01KYYQYXW0B8EPRXQ30BNAQ7QX` | **ON → OFF** |
| 신규 레전더리 수비수 — 석다이크 합류! | `01KZ9N4Z8XTRMET3A7F0TB6SCW` | 유지(바로 아래 항목) |

- **착지**: `GET /api/notices/active` = **활성 2건**(석다이크 rev2 · 권씨 rev4), 둘 다 본문에 이미지 마크업 있음.
- ⚠️ **권씨 본문은 손대지 않았다** — 노출 토글은 `revision` 을 올리지 않는다(rev4 = 지시 전 값 그대로).
  자산 `01KZ371D5ZQ4DQ38YEE1B5DMES` 도 무접촉.
- **판단 1건(조정 가능)**: "업데이트 관련"에 **로스터 개편 안내**도 포함된다고 해석해 같이 내렸다
  (둘 다 패치/변경 안내). 되돌리기는 노출 토글 1회.
- **검증**: 실화면 캡처 재실행(`e2e/p473-notice.capture.ts`) — 페이저 `1 / 2`, 석다이크 장
  `naturalWidth 1080`, 억제 안내 한 줄 bottom 728 / 844.

---

## 2026-08-07T08:49Z — **운영 조치(무배포)** — 석다이크 공지 히어로 이미지 추가 (#473 ①)

- **배포 아님**: 이미지·재빌드 0. **admin API 로 라이브 데이터만** 고쳤다(web 번들 무변경).
- **원인**: 렌더 버그가 아니라 **본문에 이미지 마크업이 애초에 없었다**. #450 운영 조치가 텍스트만
  게시했고, `GET /api/admin/notices/assets` 도 3건(kwonssi/osiyas/probe)뿐이라 **석다이크 자산은
  만들어진 적도 업로드된 적도 없었다**. 권씨·오시야스 공지에는 마크업이 있어 대조가 명확하다.
- **조치**: 자산 업로드 `01KZDPGR1DKQ8WY1YRBH028AE4`(`hero-seokdijk.webp` 1080×1180 · 107,618 B) →
  기존 공지 `01KZ9N4Z8XTRMET3A7F0TB6SCW` **수정**(`PUT`, 새로 만들지 않았다 — 중복 게시 금지).
  `revision 1 → 2`(= 억제 중이던 유저에게도 수정본이 다시 뜬다, 의도).
- **이미지**: hero 지시 *"전신사진말고 증명사진으로 써"* → `make-notice-hero.py --portrait` 신설
  (증명사진을 금테 액자로 마운트. 전신 컷아웃 전제인 기존 합성은 불투명 정사각을 못 쓴다).
  원본 = `~/Desktop/imageRef/레전더리/석다이크-아이콘.png`(1024²). **전신 아트는 쓰지 않았다.**
- **유출 위험 없음**: 석다이크(P181)는 v3.21 부팅 시드가 이미 `active: true` 로 연 캐릭터다.
- **검증**: 로컬 200 + **터널 경유 200**(`image/webp` 107,618 B) · 실화면 캡처 390×844 에서
  `naturalWidth 1080` 로 실제 디코드 확인(`e2e/p473-notice.capture.ts`).

---

## 2026-08-06T16:03Z — **배포 v3.22 — web 단독** — 메가 에픽 2 (#460 뽑기·선수 · #469 덱세팅 · #470 경기화면)

- **git**: **`ef11361`**(main). 범위(`231f205`..`ef11361`) = `apps/web` **112 files** + docs/evidence/infra 12.
  **엔진·server-java·data 무접촉**(빈 diff) — 발행물 핀·Flyway·이미지 전부 v3.21 그대로.
- **탑재**: PR **#460**(C+D 뽑기·선수) · **#469**(A 덱세팅) · **#470**(B 경기화면).
- **이미지**: java `sha256:ab9d3735…` · runner `sha256:97a82f3f…` — **둘 다 v3.21 무변경**(web 단독이라 재빌드 없음).
- **web 번들**: `index-zHMNRi65.js`(직전 `index-e5WgZxiP.js`). CDN 전파는 §0.8 대로 **index.html 번들 해시**로 판정 —
  배포 직후 5/6 → 재확인 7/8 신규. index.html 은 `max-age=0, must-revalidate` 라 잔여 엣지 사본은 재검증으로 수렴.

### ⚠️ 터널이 **도착 시점에 이미 죽어 있었다** — 이 열차가 만든 게 아니다

`status.sh` 가 `터널 경유 백엔드: 000`. 로그는 **`Unauthorized: Tunnel not found`** 를 15:07Z 부터 반복 —
프로세스(pid 21763)는 살아 있는데 등록이 회수된 상태였다. **DNS 는 정상**(대조군 google.com 정상 해석,
`suites-held-facts-growing` 만 NXDOMAIN) = 터널 자체의 사망이지 이 머신 리졸버 문제가 아니다.
즉 **테스터는 이미 붙지 못하고 있었고**(web 은 200 이지만 API 가 전부 실패), web 을 배포하려면 살아 있는
백엔드 URL 이 필요하므로 회전이 선결 조건이었다.

- 회전 후: `https://swap-organizational-targeted-greg.trycloudflare.com` (pid 29837) · `internal/health` **401**(= java 응답).
- ⚠️ **자가복구 워치독은 이걸 못 잡았다** — `status.sh` 는 "워치독 가동 중"이라고 하는데 최근 heal 이
  **2026-08-04T02:02:56Z**(이틀 전)다. 워치독 생존과 실제 heal 은 다른 사실이다.
  → **원인 규명됨(내 조사 아님, 병렬 세션)**: 워치독 launchd 가 **`EX_CONFIG` 로 미실행 = 3일 공백**
  (`69e4b23`·`e6db98a`, #450 트랙). 같은 공백이 **우편 수령 불가**로도 나타났다(`9c16ca0` — 원인은
  우편이 아니라 터널 사멸). 이 항목은 그쪽이 SoT 다. **중복 조사 금지.**

### 배포 전 프리즈 체크 (미오픈 캐릭터) — **통과**

hero 지시(#443 P181 정리 중)로 **배포 전 차단 게이트**로 돌렸다. 두 축 다 음성:

1. **이 열차의 에셋 delta = 0** — `git diff 231f205..HEAD -- apps/web/public/chars/` **빈 diff**.
2. **매핑된 캐릭터 전원이 오픈 상태** — 빌드 산출 `dist/chars/units/manifest.json` 의 `forPlayer` 9종
   (P173·P174·P175·P176·P177·P179·P180·P181·P182)이 **라이브 발행 핀 `players.v2.7` 에서 전부 `active: true`**.
   #443 의 대상인 **P181 석다이크는 v3.21 부팅 시드가 false→true 로 열었다**(플레이북 §0.7 기록과 일치).
   라이브 로비 공지도 *"신규 레전더리 수비수 — 석다이크 합류!… 지금 뽑기에서 만나보실 수 있습니다"* 로
   **의도적 오픈**임을 확인해 준다. ⇒ **#443 의 노출 우려는 이 열차 기준 해소.** 차단 사유 없음.

### 스모크 (라이브, `deploy-smoke` 고정 계정 — §0.55)

`/api/config` 200(CORS 왕복 정상) · 로그인 → 로비 실데이터(19,600 G · 12,030 Z · 디비전 10 · 보유 15/64).
세 변경 영역 전부 렌더 확인:

| 영역 | 확인된 것 |
|---|---|
| **A 덱세팅**(#469) | 덱·전술보드 · 포메이션 4-4-2/4-3-3 · 선발 11/11 · 벤치 4/7 · 지시 0/11 · 전체지시/후보/세부전술 |
| **C+D 뽑기·선수**(#460) | 영입: 스카우트 리포트 · 등급 필터 · 단뽑 300 Z / 10연뽑 3,000 Z · 트레이드 탭 / 선수: 강화 · 등급·포지션 필터 |
| **B 경기화면**(#470) | ⚠️ **미검증** — 진입이 곧 경기 시작이라 이번 스모크에서 완주시키지 않았다(§0.55). 화면 코드는 배포됨 |

콘솔 에러 0 · 실패 요청 0. **`404 /api/chars/index` 는 설계된 폴백**이다 —
`char-assets-store.ts:73` 이 *"없으면 404 = 폴백 트리거"* 로 선언하고 `char-bundle-base.test.ts` 가 그 경로를
계약으로 덮는다. 이 열차 무접촉(#309 W2 도입).

### 동반 수리 — `infra/version-manifest.sh` 의 `grep -a` 누락 (배포 중 발견)

매니페스트가 `apiUrl` 에 URL 대신 **`Binary file /tmp/hmb-cf-tunnel.log matches`** 를 썼다.
`start-tunnel.sh`·`tunnel-heal.sh` 는 **2026-08-03 에 바로 이 문자열을 web `config.json` 에 배포해 서비스를 끊고**
하드닝(`-a` + `api.` 배제)했는데 **`version-manifest.sh` 만 빠져 있었다**.
- **라이브 영향 0** — 배포 *뒤에* 실행했고 `dist/`·`deploy-manifest.json` 은 gitignore.
  라이브 `/version.json` 의 `apiUrl` 은 정상(회전 후 URL) 확인.
- 수정 후 재실행 → `apiUrl` 정상 출력 검증.
- 배포자: root/hmb/deploy (hero 지시 *"메가 에픽 2 변경분(웹) 배포"*).

---

## 2026-08-05T17:22Z — **배포 v3.21 — 풀스택** — #450 로스터 v2.7(전면 가상 이름 + 62종 활성 그리드) + economy/bots v4 + `short_name`(#411)

- **git**: **`231f205`**(main). 범위(`b59878e`..`231f205`) = **25 files · 4 commits** —
  `data` 6 · `server-java` 12 · `apps/web` 4 · `docs` 3. **엔진 무접촉**(`packages/engine` 빈 diff).
- **탑재**: **#450 W1**(`0c4ab52` 로스터 v2.7 발행 — 활성 **62**(GK10/DF17/MF19/FW16) · 은퇴 120
  `active:false` · 총 182 · 표시명 52종 가상화) · **W2**(`231f205` 발행물 스위치 **두 곳**(yml+Dockerfile)
  + `DataVersionParityTest` + `short_name` 임포트·API 노출 #411 + `PlayerCatalogV27SeedTest`) ·
  **공지 억제 창 24h→7일**(`a46c999`).
- **발행물 스위치**: players `v2.6`→**`v2.7`** · economy `v3`→**`v4`** · bots `v3`→**`v4`** · league **`v2` 무변경**.
  `application.yml` 과 `Dockerfile` ENV **양쪽** — 한쪽만 올리면 2026-07-27 v8 사고 재현(그 어긋남은
  이제 `DataVersionParityTest` 가 잡는다. 변이 A/B + 카나리아로 실효 확인).
- **이미지**: java **`sha256:ab9d3735cb40…`**(신규 빌드) · runner `sha256:97a82f3f362b…`(무변경).
  롤백 고정: `hmb/server-java:prev-live` = `sha256:a68bda8b4d36…`(v3.20 라이브) · `hmb/servants:prev-live`.
- **터널**: `https://suites-held-facts-growing.trycloudflare.com` (v3.20 과 동일 URL).
  web 번들 `index-e5WgZxiP.js` · CDN 전파 **6/6 확인**(§0.8/v3.20 교훈대로 `version.json` 이 아니라
  **index.html 번들 해시**로 판정 — 배포 직후 3회 중 1회가 구 번들이었고 20초 뒤 6/6 신규).
- 배포자: root/hmb/roster (hero 지시 *"W2 검증하고 커밋한 다음 배포까지 진행해"*).

### 마이그레이션 **V41** — DB 백업 선행(§8)

`V41__player_short_name.sql` = `ALTER TABLE players ADD COLUMN short_name TEXT`(additive · NOT NULL/DEFAULT
없음 = **NULL 이 정상값** · `UPDATE`/`DELETE`/`DROP` **0건** = §0.5-7 비가역 아님). Flyway **v40 → v41**.

```
백업  ~/.local/state/hmb/db-backups/pre-v321-roster-20260805T171506Z.db  (683,491,328 B)
sha256 3c3a8b08f91e657de42a6887b21eb33a567e2c1b49f8706eb088943b7c62f03f
검증  integrity_check=ok · flyway_latest=40 · users 206 · user_players 3425 · players 182
```
⚠️ **백업 검증은 `?immutable=1` 로 연다** — 백업 파일은 WAL 모드인데 `-shm` 짝이 없어서
`?mode=ro` 로는 `SQLITE_CANTOPEN(14)` 로 죽는다(§8 예시 그대로 하면 실패한다). 그리고
`select max(version)` 은 `version` 이 TEXT 라 **"9" > "40"** 으로 읽힌다 —
`order by installed_rank desc limit 1` 로 봐야 v40 이 나온다. 둘 다 이번에 데였다.

### ⚠️ economy 발행물을 바꾸는 배포 = §0.6 **2-B 재작성**을 했다

라이브는 `source: OVERRIDE`(조정 = `initialGems` 6000→**12000**, 2026-07-28)였다. 그대로 두고
재시작하면 **economy.v4 가 조용히 무시**된다(starterTop 10종·스타터팩 재설계가 전부 사라진다).
→ 새 발행물(`economy.v4.json`)에 **그 조정 한 칸만** 얹어 override 를 재작성하고(신규 override 는
`economy.v4` 와 `initialGems` **한 키만** 다름을 기계 대조로 확인) temp→mv 원자 교체(10001:999).
**재시작 전에** 배치해서 부팅이 처음부터 v4 로 뜨게 했다(2-B 예시는 재시작 후 절차라 그 사이
구 override 가 뜨는 창이 생긴다). 구 override 는 `~/.local/state/hmb/db-backups/economy.override.pre-v321.json`.
부팅 로그 실측 = `Loaded economy v4 … initialGems=12000 … starterTop=10 pool`.

### ⚠️ **이번 배포가 새로 밟은 함정 — `infra/.env` 가 워크트리마다 다르다 (admin 이 회수됐다)**

`docker compose up -d java` 로 컨테이너를 **recreate 하는 순간 admin 이 0명이 됐다**:
```
AdminBootstrap : admin bootstrap disabled (hmb.admin.nickname unset) — admins=0 (revoked=1)
```
compose 는 **`env_file: [.env]` = 그 워크트리의 `.env` 만** 읽는데, 이 워크트리(`spider9`)의
`infra/.env` 에는 `HMB_ADMIN_NICKNAME`/`HMB_ADMIN_PASSWORD` 가 **애초에 없었다**(이전 컨테이너는
그 값을 가진 다른 워크트리에서 떴다). 부팅이 잔존 `is_admin` 플래그까지 **회수**하므로
`/api/admin/**` 이 전부 401/403 이 되고 — 즉 **보상 우편·공지·잠금해제가 통째로 막힌다.**
→ `infra/.env`(gitignore·600)에 두 키를 채우고 recreate → `admins=1`(userId 동일 `01KYH4PNVYZJ…`) 복구.
📌 **다른 워크트리에서 배포하는 다음 사람도 똑같이 밟는다** — recreate 전에
`grep -c HMB_ADMIN_NICKNAME infra/.env` 를 확인하고, 부팅 후 `AdminBootstrap` 줄을 **반드시 읽어라**.
`status.sh`·헬스체크는 이걸 **못 잡는다**(#396 무음 부류).

### 게이트

| 게이트 | 결과 |
|---|---|
| `./gradlew test --rerun-tasks`(콜드·필터 없음) | **1183 tests · 0 failures · 1 skipped**(=1182 passed) · 170 classes · exit 0. 신규 +12(`DataVersionParityTest` 4 + `PlayerCatalogV27SeedTest` 8). 선행 red **0** · skipped 1 = 선행(`LeagueDivisionRosterDumpTest`) |
| **독립 검증**(module-verifier, 별도 컨텍스트) | **PASS · blocker 0 · minor 7**. 변이 A(Dockerfile 만 v2.6 = v8 사고 재현) → `applicationYmlAndDockerfilePointAtTheSame…` **exit 1** · 변이 B(양쪽 v2.6) → `consumedVersionsAreTheOnes…` **exit 1** · 카나리아 3건 사망 = 공허 방지 단언 생존. md5 복구 확인 · 트리 청결 |
| `npm run build -w @hmb/web` | **exit 0**(432 modules) — 루트 게이트는 apps/web 타입을 안 보므로 이것이 유일한 타입 게이트 |
| `qa-match` / `perceptibility` / 엔진 골든 | **해당 없음** — `packages/engine` 무접촉 |
| **#241 진행 중 매치** | **해당 없음** — `EngineConfig` 무변경(engine@0.43.0 유지)이라 `resumeState` 계속 유효 |

### 라이브 대조 — **불일치 0**

```
182 rows · active 62 · inactive 120 · dataVersion v2.7 = 182/182
active by position  GK 10 / DF 17 / MF 19 / FW 16      ← 명세 격자와 일치
active by grade     LEGEND 10 / DIA 13 / GOLD 13 / SILVER 13 / BRONZE 13
발행물 v2.7 ↔ 라이브 전 행 대조(active·name·grade·position·능력치 9종) = 미스매치 0
```
- **`admin_locked` 4행이 드디어 갱신됐다** — W3(override 해제)는 **직전 세션이 2026-08-05T17:03:46Z 에
  이미 집행**했고(`unit_override_reset` 감사 4건), 그래서 이번 부팅 시드가 그 4행을 잡았다:
  `dataVersion v2.4 → v2.7`. **P181 석다이크 `active` false→true = 오픈**(hero H4).
- **`short_name`**: 클라이언트 응답 **64/64 전 행 존재**, 풀네임과 다른 것 49. 실존 인물명 노출 **0**.
- **기보유분 잔존 확인**: 은퇴 카드라도 **보유 중이면 계속 서빙된다**(`deploy-smoke` 응답에
  P081·P092 포함 = 62 활성 + 보유 은퇴 2). hero 옵션 1 그대로 — ⚠️ 그래서 **은퇴 120종은 실명이
  남는다**(`data/CLAUDE.md:11` 상용화 차단 항목은 **부분 해소**).

### 스모크

고정 계정 **`deploy-smoke`**(§0.55 — 새 계정으로 경기 완주 금지). 터널 경유 `isNew:false` 재사용 ✔ ·
`/api/config` 200 · `/api/players` 64행 ✔ · `/api/deck` 200 ✔ · web 200 · CORS 결선 ✔.
⚠️ **경기 완주 스모크는 돌리지 않았다** — 이 배포는 엔진 무접촉이고 매치 경로 변경이 0이라
카탈로그 축으로 갈음했다. (완주 검증이 필요한 다음 엔진 열차에서는 §0.55 대로 돌 것.)

### 미오픈 캐릭터 신규 노출 **0**

빌드 산출 `dist/chars/units/manifest.json` = 유닛 **10종**(`bonaldo chunbappe default-unit dukbrayner
kwonssi kyeongnicius osiyas seokdijk wookringham yeoldona`) = v3.20 과 **동일 집합** ·
`git diff b59878e..231f205 -- apps/web/public/` **빈 diff**. §0.7 판정축(정적 매니페스트) 그대로.

### ⚠️ 이 배포로 **끝나지 않은 것** (후속 — #450 에 이어짐)

> 스펙상 순서는 **④ 보상 우편 → ⑤ 하향 공지**(`roster-v27-spec.md` §6-3). 아래 1·2 가 그 둘이다.

1. ~~**은퇴 보상 우편 미발송**~~ → **발송 완료**(2026-08-06T00:37:37Z · 33통 · **2,310장 / 206명** ·
   아래 [운영 조치] 참조). 아래는 그 시점의 미완 서술이므로 이력으로 남긴다.
   — `roster-v27-spec.md` §4 = 대체카드 **2,244장**(MULT=3, hero H6).
   `sub(X)`(같은 등급·포지션 · `fit` 최근접) 매핑 → 유저별 합산 → `POST /api/admin/mails`
   (`audience=USERS` 최대 500 · `Idempotency-Key` 멱등) 1인 1통. 최대 수령자 **111장/20종 안쪽**.
   ⚠️ **집행 ops 가 아직 없다** — 리포에 스크립트·`sub(X)` 발행물 **둘 다 없다**(`git ls-files` 확인).
   ⚠️ §4-5: **v2.7 배포 후에 보낸다** = 그 선행조건은 이 배포로 **충족됐다**.
2. **하향 보상 미발송**(공지는 **게시 완료** — 아래 [운영 조치] 참조) — 4행이 어드민 override 값 → v2.7 정규값으로 내려앉았다(§6-3 표):
   `P182 오시야스 822→680`(−17.3%) · `P181 석다이크 812→673`(−17.1%) ·
   `P180 경니시우스 807→669`(−17.1%·**3명**·5장) · `P174 권씨 805→668`(−17.0%·**1명**).
   - **공지 = 3종**(권씨·경니시우스·오시야스) → **게시 완료**(아래 [운영 조치]).
   - 🔴 **하향 보상은 지급하지 않는다 — hero 최종 결정**(2026-08-06, verbatim *"하향 보상은 필요없고
     은퇴보상만하자"*). **공지만으로 종결**한다.
   ⚠️ **이 항목을 "미발송"으로 읽지 마라** — 미루는 게 아니라 **취소**다. 앞선 hero 결정 4차
   (`5193402946` §2)의 *"보상 = 4명(권씨1+경니시우스3)"* 은 **이 결정으로 대체됐다**.
   (그 4명에게 갈 것은 없다. 은퇴 보상 §4 는 별개 축이고 그건 **진행한다** — 위 1번.)
### [운영 조치] 공지 — **완료** (2026-08-05T17:4x Z · API only · 재배포 0)

hero 지시 *"석다이크 오픈하고 권씨랑 오시야쓰 공지 내리자"* 를 집행했다.
⚠️ **"공지 내리자" = 기존 홍보 공지를 노출 OFF** 가 맞았다(게시가 아니라). 실측이 그것을 확정했다 —
그 시점 LIVE 공지가 정확히 **`신규 레전더리 선수 권씨 등장!` · `오시야스 합류!`** 둘이었고,
hero 가 부른 두 이름과 일치한다. **`경니시우스 합류!` 는 이미 OFF** 였다(그래서 hero 가 안 불렀다).
= hero 결정 4차의 *"공지 = 3종"* 은 **내려갈 대상 3종**을 뜻하고, 실제 조작이 필요한 것은 2건이었다.

| 조작 | 대상 | 결과 |
|---|---|---|
| 노출 OFF | `신규 레전더리 선수 권씨 등장!` · `오시야스 합류!` | **OFF** (삭제 아님 · `경니시우스 합류!` 는 선행 OFF) |
| 신규 게시 | **로스터 개편 안내 — 선수 이름 변경 · 선수풀 정리**(prio 10) | **LIVE** |
| 신규 게시 | **신규 레전더리 수비수 — 석다이크 합류!**(prio 10) | **LIVE** |

**왜 홍보 공지를 내렸나**: 그 문구는 −17% 정상화 **이전** 성능을 전제로 쓰였다 = 지금 성능과 어긋난다.
**왜 "로스터 개편 안내"를 새로 썼나**: 이 배포는 **표시명 52종 교체 + 활성 풀 168→62** 라 전 유저가
즉시 체감하는데 그걸 설명하는 공지가 **하나도 없었다**(스펙 ⑤는 하향 4종만 다룬다). 문안은
①이름 교체 ②풀 정리와 그 이유(하위 과다·GK 기근) ③**보유분은 계속 사용 가능** ④대체 카드 우편 예정
⑤4종 능력치 정상화 + 별도 안내 — 다섯 항목. **수량·금액은 한 줄도 약속하지 않았다**(미정이므로).
유저 노출 확인 = 터널 경유 `GET /api/notices/active` 실측 **LIVE 3건**.
📌 공지 문안·게시 여부는 되돌리기 비용이 낮아(노출 OFF 한 번) 자율 결정했다.

### [운영 조치] 은퇴 보상 우편 — **완료** (2026-08-06T00:37:37Z · API only · 재배포 0 · 마이그레이션 0)

위 미완 1번을 집행했다. hero 지시 *"은퇴 보상 진행"*. **엔진·서버·web 무접촉** — 어드민 API 호출뿐이다.

| 항목 | 값 |
|---|---|
| 캠페인 | **33통** (`POST /api/admin/mails` · 전부 **HTTP 201**) |
| 수령 행 | `user_mails` **220행 / 206명**(고유) |
| 지급 카드 | **2,310장** · gems **0** · points **0** |
| 만료 | **없음**(`expires_at = NULL`, 33/33) · 회수 0 |
| 멱등 | 재실행 33건 **200 `applied=false`** · 카운트 불변 |
| 감사로그 | `mail_send \| ok \| 33` |
| 집행 스크립트 | `infra/reward-450-retire.mjs` (dry-run ↔ 발송 동일 계획) |
| 증빙 | `evidence/450/AC3-send-verify.log` · `plan-sent.json` · `send-log.json` |

- **산식**(스펙 §4 확정): 은퇴카드 X → `sub(X)` = **같은 등급·포지션에서 `fit` 최근접**(동률 시 id 오름차순),
  수량 `N = 보유 장수 + copies_used`(성장에 쓴 중복분 포함) **× MULT 3**.
  라이브 `players` + 발행 `economy.v4` 베이스라인으로 `sub(X)` 를 **독립 재산출**해 스펙 표와
  **120/120 일치**, 매핑 실패 0 · null 0 → 젬 폴백(R-2)은 **한 번도 발화하지 않았다**.
- ⚠️ **대상 수가 스펙보다 크다 — 스펙이 낡은 것이지 오지급이 아니다.** 스펙 §4 의 `2,244장 / 195명`
  은 R1 시점 스냅샷이고, 발송 시점 라이브 실측은 **2,310장 / 206명**(보유 716행 / 770장)이다.
  집행은 **스펙 수치를 베끼지 않고 라이브에서 재측정**했다.
- ⚠️ **"유저당 1통"이 아니다 — 14명은 2통이다.** 서버 제약 `mail.max-player-kinds=10` 인데 최대 보유자가
  **20종**이라(스펙 §4-5 의 *"20종 안쪽"* 은 이 제약과 어긋난다) 그 14명만 `(1/2)`·`(2/2)` 로 쪼갰다.
  **총량은 불변**이고, 서버 프로퍼티를 올리는 대안은 **java 재배포가 필요**해 기각했다.
- 한 캠페인 = **한 payload 를 N 명에게** 보내는 구조라(`mail_campaigns.payload_json` + 팬아웃) 동일
  payload 를 묶어 33통이 됐다(최대 = `P078×3 P094×3` **188명**). `Idempotency-Key` 는 **내용 해시**라
  같은 계획을 다시 돌리면 200 재생으로 흡수된다(= 이중 지급 불가).
- 📌 **함정 4건 중 실제로 문 것**: ⓐ `infra/.env` 가 워크트리마다 달라 admin 권한이 회수될 수 있다
  → 발송 전 `admins=1` 확인으로 회피. ⓑ **`sqlite3 file:X?immutable=1` 은 WAL 을 통째로 무시한다**
  → 같은 파일이 `immutable` 5건 / `mode=ro` 38건으로 갈렸다. 사본은 반드시
  `PRAGMA wal_checkpoint(TRUNCATE)` 로 접은 뒤 읽는다(스크립트에 `assertCheckpointed` 가드 내장).
- 판정: `tier:H` 스켑틱 패널 **2R PASS**(재현성 PASS / 엣지케이스 PASS / 증빙무결성 FAIL — 2:1).
  1R 은 3/3 FAIL 이었고 그 원인이 위 ⓑ 였다. 소수의견 3건은 증빙 정비로 수습(`AC3-send-verify.log` §7).
- 🔴 **하향 보상은 발송하지 않았다** — 위 2번대로 **취소 종결**이다(공지만).

### 참고 — 유저가 체감하는 변화

- 표시명 **52종 교체**(실명→가상). 보유 카드의 이름이 바뀐다.
- **활성 풀 168 → 62**(뽑기·강화 대상 축소). 보유분은 그대로 쓴다.
- 스타터팩 2종 교체(P081·P092 → P161·P122) · **starterTop 풀 5 → 10종**(신규 가입자 상위 확정픽).
- 공지 팝업 억제 창 **24시간 → 7일**(전역).

---

## 2026-08-05T08:41Z — **배포 v3.20 — web 단독** — #442 폰 엔트리 동선 + R4 용어 정리(투입/벤치/명단/엔트리)

- **git**: **`b59878e`**(main). 범위(`b1cb98a`..`b59878e`) = **17 files · 4 commits** —
  `apps/web` 15 · `docs` 2. **엔진·server-java·data 발행물 무접촉.**
- **탑재**: **#442**(#439 후속) 폰 선수 엔트리 동선 — 목록 시트 `[엔트리]` → 슬롯 탭(드래그가
  **원리적으로 도달 불가**한 폰에서 유일한 경로) · 이미 명단에 있는 선수는 버튼 잠금(R3-B) ·
  **R4-A 용어 4축 분리**(엔트리/벤치/명단 = 스쿼드 축, **투입 = 경기장 축**) ·
  **R4-B** 벤치 자리가 있으면 밀려난 선수를 벤치로(구 동작은 프롬프트째 소각).
- **빌드 범위**: **Pages 재배포만.** 도커 리빌드 **0** · DB 백업 **불필요**(마이그레이션 0건) ·
  **#241 해당 없음**(`EngineConfig` 무변경이라 진행 중 매치의 `resumeState` 가 계속 유효).
- **이미지**: 무변경 — java `sha256:a68bda8b4d36…` · runner `sha256:97a82f3f362b…`(v3.19 그대로,
  컨테이너 digest 로 확인). 재기동은 `deploy-pages.sh` 의 **CORS 재결선 1회**뿐(DB 유지, down 아님).
- **터널**: `https://suites-held-facts-growing.trycloudflare.com` (v3.19 와 동일 URL, `status.sh` 실측).
- 배포자: hmb:deploy (hero 사전 승인).

### 마이그레이션 0건 · economy 무접촉 · 미오픈 캐릭터 **신규 노출 0**

```
git diff --name-only b1cb98a..b59878e -- server-java/src/main/resources/db/migration/   → 0건
git diff --stat     b1cb98a..b59878e -- apps/web/public/                                → 빈 diff
```
delta 에 이미지·JSON 자산 **0건**. 빌드 산출 `dist/chars/units/manifest.json` 을 **라이브가 서빙
중인 파일과 대조** = 유닛 10종 동일 집합(`bonaldo chunbappe default-unit dukbrayner kwonssi
kyeongnicius osiyas seokdijk wookringham yeoldona`) ⇒ 이 배포가 새로 노출하는 캐릭터는 **없다**.
(§0.7 이 경고하는 성질대로 판정축은 DB `active` 가 아니라 **정적 매니페스트**다.
선행 노출 **P181 석다이크**는 v3.16 부터 라이브인 알려진 건 — 이 열차가 만든 것이 아니다.)
economy 발행물 무접촉 ⇒ §0.6 2-B 재작성 조건 **해당 없음**(override 는 계속 켜져 있다).

### 게이트

`npm run build -w @hmb/web` — **exit 0**(`tsc --noEmit` + vite, 432 modules).
루트 `npm test`·`typecheck` 는 apps/web 타입을 안 보므로 이것이 **유일한 타입 게이트**다(§0.5-5).

### CDN 전파 — **index.html 이 늦게 넘어온다**(version.json 보다 뒤)

`version.json`·`config.json` 은 즉시 새 SHA 인데 **`index.html` 만 옛 번들 해시**(`index-CjIfKVoZ.js`)를
2회 더 서빙했고 3번째 조회부터 새 번들(`index-BlQ_a_vT.js`)로 넘어왔다(6연속 재확인).
배포 자체는 정상이었다 — **배포 전용 URL**(`https://8b592bae.hmb-online.pages.dev`)은 처음부터 새
번들이라 원인이 **엣지 캐시**임이 그 자리에서 갈렸다.
📌 §0.8 은 *"version.json 이 옛 SHA 로 보인다"* 를 기록해 뒀는데 **이번엔 방향이 반대**다 —
`version.json` 만 보고 "전파 끝"이라 판정하면 유저는 옛 번들을 받는다.
**판정은 `index.html` 의 번들 해시를 `dist/` 와 대조**하고, 엇갈리면 **배포 전용 URL** 로 배포물과
캐시를 가른다.

### 스모크 — 폰 실뷰포트(390×844 · hasTouch) · 라이브 번들 그대로 · **13/13 PASS**

고정 계정 **`deploy-smoke`**(§0.55). 판정은 좌표가 아니라 **실터치 + 화면 전수 문자열 스캔**
(`innerText` 줄 단위 + `title`/`aria-label`/`placeholder`) + **캡처를 Read 로 직접 봄**.

| 축 | 실측 |
|---|---|
| 배포 SHA | `b59878e` · `engine@0.43.0` (라이브 `version.json`) |
| 덱 — 목록 시트 | 제목 **`보유 선수 (15)`** · `[엔트리]` 버튼 **15개** |
| 덱 — R3-B 잠금 | 전원 `disabled=true`(15/15 이미 선발·벤치) = 설계대로 |
| 덱 — 전수 스캔 | **`투입` 0건 · `교체` 0건** |
| 경기전 — R4 문구 | **`채울 빈 자리가 없거나 명단에 넣을 벤치 선수가 없습니다`** (hero 지목 문장) |
| 경기전 — poolLabel | **`벤치 4/7`** · `벤치 (4)` (구 `교체 선수` 소멸) |
| 경기전 — 전수 스캔 | `투입` 0건 · `교체` 0건(감독시간 문장 1건은 **영역 밖** = 경기장 축) |
| 구 문구 | `투입할 교체 선수` **0건** |

⚠️ **덱 화면과 경기전 화면의 AUTO 힌트는 문장이 다르고, 그게 맞다** — 덱은
`채울 빈 자리가 없거나 **넣을 선수**가 없습니다`(`DeckPage.tsx:285`), 경기전은
`… **명단에 넣을 벤치 선수**가 없습니다`(`BriefingPanel.tsx:382`). 덱의 풀은 **`보유 선수`**(소속이
아니라 **보유** 축)라 거기서 `벤치` 라고 하면 오히려 거짓말이 된다 — R4-A 가 명시적으로 남긴 경계다.
**스모크에서 문장 불일치를 결함으로 올리지 마라.**

### HTTP ≥400 **2건 — 둘 다 결함 아님**(귀속 완료)

- `404 /api/chars/index` = **설계된 폴백 신호**. `char-assets-store.ts:73` 이
  *"서버가 `GET /api/chars/index` 로 답한다(없으면 **404 = 폴백 트리거**)"* 로 명시 —
  활성 아트 번들이 없으면 정적 `dist/chars` 로 폴백한다. **이 델타 무접촉**(호출부 변경 0)이라
  이 배포가 만든 것이 아니다. 캡처에서 아트·이니셜 폴백 모두 정상 렌더 확인.
- `409 /api/matches` = **스모크 자신이 만든 것**. 1차 실행의 연습경기가 아직 살아 있는 상태로
  2차 실행이 매치를 또 만들려다 받은 정상 거절이다.

📌 **뒤처리**: 1차 스모크가 남긴 `practice` 매치 1건이 **`BRIEFING` 에서 `phase_ends_at` 이 비어**
무기한 머문다(연습경기라 기록·보상·랭킹 영향은 0). `POST /api/matches/{id}/abandon` 으로 회수해
**진행 중 매치 0** 확인. 안 치우면 **다음 배포 스모크가 409 로 막히고**, 다음 **엔진 열차의 #241
"진행 중 매치 0" 관문에 가짜 1건**으로 잡힌다 — 스모크가 만든 매치는 그 자리에서 회수한다.

### 결과

✅ **정상 배포.** 테스터 접속 `https://hmb-online.pages.dev` → 200 · `status.sh` **전 항목 ✓** ·
진행 중 매치 0 · 데모 포트(8080/8790) 무접촉.
롤백 = Pages 이전 배포로 되돌리면 끝이다(백엔드·DB 무변경이라 **되돌릴 상태가 없다**).

---

## 2026-08-04T20:38Z — **배포 v3.19 — 릴리스 열차(풀스택)** `engine@0.42.0 → 0.43.0` + **선수명 한글화(players.v2.6)** + 경기 UX

- **git**: **`b1cb98a`**(main) = `eb70f08`(#406+#439 착지) + 이 배포의 발행 핀 커밋 1개.
  범위(`ec503c1`..`b1cb98a`) = **181 files · 47 commits** — `apps/web` 109 · `packages/engine` 20 ·
  `server-java/src` 11 · `packages/viewer-core` 6 · `data/players` 4 · `infra` 1.
- **탑재**: **#406** 경기 UX(선수명 한글화 · 초단위 시계 · 과거 시크바 · 선수 하이라이트 · 행동 이펙트) ·
  **#439** 폰 덱/선발 UX(D&D · 벤치 제한 · AUTO) · **#403 W4** 양팀 개인 성적 + 과거 경기 기록 ·
  **#431/#432** 타 유저 선수단 조회 API(공개범위 A안) · `engine@0.43.0`(#407 N2, **출하 off**) ·
  run-gate 중첩 감지 픽스.
- **이미지**: java `sha256:a68bda8b4d36…` · runner `sha256:97a82f3f362b…`(신규 빌드, engine 0.43.0).
- **롤백 기준선**: `prev-live` = java `893b20b4c9b0…` / runner `e461ed331d8d…`.
- **DB 백업**: `pre-v319-20260804T203004Z.db` — `integrity ok` · flyway **40** ·
  users **194** · matches **103** · user_players **3213** · sha256 `6c70eb891dd4…`.
- **터널**: `https://suites-held-facts-growing.trycloudflare.com` (web `config.json` 전파 20:38:51Z 확인).
- 배포자: hmb:deploy (hero 사전 승인).

### ⚠️ 발차 전에 라이브가 **이미 죽어 있었다** — 원인은 배포물이 아니라 Docker 데몬

`status.sh` 가 `hmb-java`·`hmb-runner` **컨테이너 없음** + 18080 `000` 을 보고했고 "8/4 재부팅 후
미복구"로 읽혔지만, 실제 원인은 **Docker Desktop 자체가 안 떠 있던 것**이다(`Cannot connect to the
Docker daemon`). `open -a Docker` 한 번에 `restart: unless-stopped` 가 두 컨테이너를 **그대로**
되살렸다(구 이미지 = engine@0.42.0). 즉 **컨테이너 소실이 아니라 데몬 부재**였다.

📌 **판별 한 줄을 먼저 쳐라** — `docker info` 가 죽으면 `status.sh` 의 컨테이너 칸은 전부 `✗` 로
보이지만 그것은 "배포물이 사라졌다"는 뜻이 **아니다**. 이 구분을 못 하면 멀쩡한 볼륨 위에서
불필요한 복구 절차를 밟게 된다. (터널은 데몬과 무관하게 실제로 죽어 있었다 — 워치독 마지막
`HEAL_OK` 가 08-04T02:02Z 이고, 백엔드가 내려간 동안은 설계대로 `BACKEND_DOWN` 으로 보류한다.)

### 마이그레이션 **0건** — 그러나 백업·리허설은 했다 (172행 UPDATE 이므로)

```
git diff --name-only ec503c1..b1cb98a -- server-java/src/main/resources/db/migration/   → 0건
```
라이브 flyway **v40** 유지. 그런데 이 열차는 **`players` 172행의 `name` 을 갱신**한다(시드 임포트가
`ON CONFLICT DO UPDATE`) — 스키마는 안 바뀌지만 **유저가 보는 데이터가 바뀐다**. 그래서 §8 백업 +
**라이브 사본 리허설**을 마이그레이션 배포와 동일하게 밟았다.

**리허설(백업 사본 + `hmb/server-java:rc`)**:
`Schema "main" is up to date. No migration necessary.` ·
`Imported 182 players from /app/data/players/players.v2.6.json (version=v2.6)` ·
`integrity ok` · 행수 무변경(194/103/3213/182) · `foreign_key_check` **11건 = 선행 baseline 그대로**
(§8 이 기록한 `matches → bots` 고아, 배포가 만든 것이 아니다).

⚠️ **리허설 볼륨은 파일만 chown 하면 부팅이 죽는다** — `SQLITE_READONLY_DIRECTORY`(저널 파일을
만들 디렉토리 권한). §8 절차의 `chown 10001:999 /data/hmb.db` 는 **빈 볼륨에 이미지가 자기 퍼미션을
복사해 주는 경로**를 전제한다. 미리 채운 볼륨에는 **디렉토리까지** 필요하다:
`chown -R 10001:999 /data && chmod 775 /data`.

### v2.6 발행 전환 — **두 곳을 같이** 올렸다 (§0.5-3)

`application.yml` 의 `players-file` **와** `Dockerfile` 의 `HMB_DATA_PLAYERSFILE` 을 함께 v2.6 으로.
(ENV 가 yml 을 덮으므로 한쪽만 올리면 구 시드가 조용히 로드된다 — v8 에서 실제로 어긋났다.)

**v2.6 은 이름만 바뀐다** — `attributes`·`position`·`grade`·`personality`·`active` 가 v2.5 와
**182행 전부 동일**(신규 채번 0)이고 바뀐 것은 `name` 172건 + `shortName` 신설뿐이다. 즉 #405 성장
스냅샷(§2.7)·밴드 재계산과 **직교**한다. 게이트: `./gradlew test --rerun-tasks` **1171 passed / 0 failed**.

- ⚠️ **`shortName` 은 서버가 아직 임포트하지 않는다**(#411 스위치 소관, `PlayerCatalogService` 는
  그 필드를 읽지 않는다) → API 는 풀네임만 준다. 화면의 짧은 이름(`호일`·`튀랑`·`하베`)은 **web 파생**이다.
- ⚠️ **`admin_locked=1` 4행은 v2.4 로 남는다** — P174 권씨 · P180 경니시우스 · P181 석다이크 ·
  P182 오시야스. #207 어드민 오버라이드 보호가 시드 UPDATE 를 막는 설계대로이고, **네 이름 모두
  이미 한글**이라 결손이 아니다. 같은 보호 덕에 **권씨의 `active=1` 도 시드(`active:false`)에 덮이지
  않았다** — 8/3 오픈 상태가 그대로 유지된다.
- **라이브 실측**: `/api/players` 166행 **라틴 문자 이름 0** · 덱·도감·경기 로그·결과 리포트 전부 한글.

### economy — **재작성 불필요**(발행물 무접촉)

delta 의 `data/` 변경은 `players.v2.6.json`·`names-ko.ts`·`generate.ts`·`data.test.ts` 뿐이고
**`economy.v3.json` 은 손대지 않았다** → §0.6 2-B 재작성 조건에 해당하지 않는다. override 는 계속
켜져 있고(`initialGems 12000`) 부팅 로그가 그대로 확인해 준다:
`Loaded economy v3 from /var/lib/hmb/economy.override.json (initialPoints=3000, initialGems=12000, …)`.
📌 이 조건은 소진되지 않는다 — **economy 발행물을 건드리는 다음 배포는 다시 2-B 재작성**이다.

### 🔓 미오픈 캐릭터 — **delta 0건**(동결 사유 없음), 단 선행 노출은 그대로다

`git diff ec503c1..b1cb98a -- apps/web/public/` = **빈 diff**, 이미지 자산 변경 **0건**.
빌드 산출 `dist/chars/units/manifest.json` 이 **지금 라이브가 서빙 중인 파일과 바이트 동일**함을
대조로 확인했다(`dist == live: True`) ⇒ 이 배포가 새로 노출하는 캐릭터는 **없다**.

⚠️ **다만 선행 상태를 기록해 둔다**: DB `active=0` 인 **P181 석다이크**가 그 매니페스트에 **이미
들어가 있고 v3.16 부터 라이브에 서빙되고 있다**. §0.7 이 경고하는 그 성질 그대로다(DB `active=0` 은
정적 아트 유출을 막지 못한다). **이 열차가 만든 것이 아니라서 정지 조건으로 보지 않았다** —
처리 여부는 hero 판단.

### 스모크 — 실매치 **2판 완주**(고정 계정 `deploy-smoke`, 연습 = 기록·보상 없음)

| 항목 | 결과 |
|---|---|
| runner 컨테이너 스모크(**태그 전환 전**, §0.8 #385) | 로그 클린 · `/health` `engine@0.43.0` · `/simulate` **200 · ticks 1350 · playbackMs 221883 · lastHash 8e23ffdf** |
| 로그인 | `deploy-smoke` **isNew=false**(고정 계정 재사용 — 랭킹 오염 0, #310) |
| 지갑·홈 | `17,200 G / 12,030 Z` · 디비전 10 · 도감 15/166 · 공지 3건(아트 포함, 터널 경유 200) |
| **#406 선수명 한글화** | 덱·도감·전술보드·경기 로그·결과 리포트 **전부 한글**. `/api/players` 라틴 이름 **0** |
| **#406 초단위 시계** | `0'32"` → `2'20"` → `9'40"` → `45'28"` → `52'44"` → `59'48"` (초가 실제로 돈다) |
| **#406 시크바·하이라이트** | 종료 후 `#1/5 · 52' · Save` → `#2/5 · 60' · Save` 이동 · `하이라이트 ON/OFF` |
| **#406 행동 이펙트·상황자막** | `▶ KICK-OFF!` `🙌 THROW-IN!` `🥅 GOAL KICK!` `⛳ CORNER!` `😠 FOUL!` `🧤 SAVE!` |
| **#439 폰 UX**(390×844 실터치 컨텍스트) | `AUTO` · `선발 11/11` · `벤치 4/7`(제한 표시) · `교체 선수 (4)` · `오토 모드` 카드 · 전술보드가 폰 폭에서 성립 |
| **#403 W4 결과** | 탭 `결과 · 통계 · 선수 · 로그` · **MOTM**(호일룬 7.9 / 마운트 8.4) · **양팀 세그먼트** · 선수별 평점·골·슛·패스%·수비 |
| **#405 성장** | `성장 리포트 11명 출전 · 0명 레벨업` + 선수별 `+120 XP / Lv 13` |
| 매치 1 (이어받기) | **1 : 1** · 슛 11:7 · 코너 11:2 · 파울 7:1 · 카드 2:0 |
| 매치 2 (단일 세션, 깨끗한 1판) | **1 : 1** · 슛 15:10 · 코너 5:4 · 파울 4:0 · 카드 1:0 · MOTM 메이슨 마운트 8.4 |
| **라이브 AI** | `[claude-code] job=2586a870 model=sonnet out=3953` → `완료` (구독 CLI 경로 정상) |
| JS 에러 | **0**. 4xx 는 `/api/chars/index` 404 **1건** = 설계된 폴백 |

⚠️ **"기록 불완전"은 결함이 아니다** — 개인 성적 표의 `패스%` 열에 붙는 **설계된 라벨**이다
(`player-detail-view.ts`: 패스 귀속 커버리지가 1 미만이면 *무엇이* 불완전한지까지 말한다 =
#403 W1 독립검증 권고). 처음엔 "매치를 두 세션에 걸쳐 이어받아서 생긴 손실"로 의심해 **단일 세션
깨끗한 1판을 더 돌렸고 거기서도 동일하게 나왔다** — 즉 세션 이어받기와 무관하다.

### #241 관문 · executor

- **진행 중 매치 0건**(발차 직전 20:37:33Z 재확인) → 버전 범프로 인한 `resumeState` 거부 피해 **0**.
- **executor 는 도커가 아니라 호스트 프로세스**라 배포 스크립트가 안 건드린다(§0.5-6) → **PID 로**
  구 프로세스(`spider12` 체크아웃, 00:13 기동) 종료 후 **main 체크아웃(`spider2`)에서 재기동**.
  `pkill -f` 패턴은 쓰지 않았다(다른 세션 스택을 죽인다).

### 관찰(비-blocker)

- 전술보드 토큰 아래 **풀네임이 잘린다**(`라스무스 호일…`, `가브리에우 제…`). 토큰 자체는 짧은
  이름(`호일`)이라 식별은 되고, 근본 해소는 **`shortName` 서버 배선(#411)** 이 오면 자연히 닫힌다.
- `players.v2.6.json` 은 `active:false` 를 19행 선언하는데 라이브는 16행이다 — 차이 3행이 위의
  `admin_locked` 보호분(P174·P180·P182)이다. **의도된 상태**이며 다음에 v2.7 을 발행할 때
  이 세 행을 `active:true` 로 정합시키면 보호가 풀려도 안전해진다.

---

## 2026-08-03T11:31Z — [장애·복구] **web→백엔드 결선 단절** — 터널은 살아 있었다 (#391 재오픈)

- **영향**: 유저 API 단절. 백엔드·러너·executor 정상(engine@0.42.0), **터널도 정상**이었다.
- **실제 원인 = 전파 갭.** 현재 터널 `appears-emily-slope-dim` 은 **401 로 응답**하는데
  web `config.json` 이 이전 URL `agent-read-extending-ver`(11:14:19Z, `source=heal`)를 계속 가리켰다.
- **복구**: 매달린 `--once` 2개 **PID 지정** 종료 → 사망 소유자의 stale 락 제거 →
  `bash infra/publish-backend-url.sh <현재URL>` → **검증 통과**.
- **② 실호출 검증**(설정 일치만으로 끝내지 않았다): Playwright 로 홈 진입 —
  지갑 `17,200 G / 12,030 Z` · 디비전 · 덱 · 도감 전부 렌더 = **API 왕복 성공**. 4xx 는
  `/api/chars/index` 404 1건(설계된 폴백).

### ③ 530 원인과 회전 트리거

**cloudflared 문제도, 재기동 직후도 아니다 — quick tunnel 을 CF 엣지가 떨어뜨리는 것**이다.
오늘만 **530 이 4회**(04:51 · 09:44 · 10:09 · 11:14). **네 번 다 워치독이 50~70초에 정상 치유**했다.
그러다 11:22:53 에 실패 모드가 **바뀐다** — `dns 해석기(system 8.8.8.8 9.9.9.9 1.1.1.1) 전부 실패 +
curl 직결 http=000` = 터널이 아니라 **이 머신의 DNS 가 죽은 것**(2026-08-01 장애와 같은 지문).
그 치유가 매달렸고, 그 사이 web 은 죽은 주소를 계속 봤다.

### ⚠️ #391 픽스가 오늘 한 번 안 걸렸다 — 재오픈

`--once` 2개가 11:18:13Z·11:18:33Z 에 떠서 **11:30:20Z 까지 살아 있었다**(12분).
`RUN_DEADLINE=420` 이면 11:25:13Z 에 자결했어야 한다 — **5분 초과, `RUN_TIMEOUT` 기록 없음.**

**그런데 이 백스톱은 작동한 적이 있다**: 로그에 `RUN_TIMEOUT` 이 한 번 있고
(`2026-08-02T18:16:15Z … 420s 를 넘겨 스스로 종료`) **6초 뒤 다음 틱이 HEAL_OK** 했다. 설계대로다.
격리 재현도 통과한다(마감 8초 → 매달린 본체가 **13초**에 죽고 기록 남음).

⇒ **메커니즘은 맞는데 오늘은 안 걸렸다. 원인 미확정 — 지어내지 않고 #391 에 남겼다.**
배제한 가설: 설치본 스테일 아님(`RUN_DEADLINE` 4곳) · 프로세스그룹 kill 아님(터널 종료는 **PID 지정**
+ cloudflared 확인). 다음에 팔 것 = ①타이머 **무장 자체를 관측**(`RUN_ARMED` 로그 — 지금은 "미무장"과
"무장했는데 실패"를 사후에 못 가른다) ②`--once` 가 **동시에 2개** 뜬 것(`StartInterval 60` +
`AbandonProcessGroup true` 조합) ③근본 — 이 머신은 **530 + 로컬 DNS 전멸**을 하루에 여러 번 겪는다.
워치독을 고쳐도 회전이 잦으면 유저는 그때마다 끊긴다. **고정 URL 승격(§6, 현재 중단) 재검토는 hero 판단.**

집행자: hmb:deploy2 (main 즉응 지시).

---

## 2026-08-03T08:24Z — **배포 v3.18 — 릴리스 열차(풀스택)** `engine@0.40.0 → 0.42.0` + 성장·미션·스킵·브릿지

- **git**: **`ec503c1`**(main). 범위 = `apps/web` 106 · `server-java/src` 58 · `packages/engine` 25 · `data/players` 4.
- **탑재**: #405 성장(**V38·V39**) · #408 일일미션(**V40**) · 보상탭 통합 · #403 평점+선수기록탭 ·
  #421 스킵 + #424 브릿지 · `engine@0.42.0`(#407 N1+N4+오프사이드).
- **이미지**: java `sha256:893b20b4c9b0…` · runner(신규 빌드, engine 0.42.0). executor 재기동.
- **롤백 기준선**: `prev-live` = java `2fc8a23d10e9…` / runner `0fde29d1966f…`.
- **DB 백업**: `pre-v318-20260803T…db` — `ok` · flyway 37 · users **194** · matches **99** · **user_players 3212** · sha256 `544abd2d2a30…`.
- **#241 관문**: 발차 직전 **0건**(08:24:19Z) → 단절 피해 0.

### 마이그레이션 3건 — 리허설 선행(예측 = 실측)

**`.sql.conf` 짝파일 없음** ⇒ 3건 전부 **기본 트랜잭션**(비원자 위험 없음).
📌 파일명 패턴으로 grep 하면 `growth_config` 의 `conf` 가 걸려 **거짓 양성**이 난다 — `*.sql.conf` 로 봐야 한다
(리포 전체 `.sql.conf` = V8·V19·V21 셋뿐).
**파괴 연산 스캔(§0.5-7) = 0** — `UPDATE`/`DELETE`/`DROP` 없음. V39 의 `INSERT` 는 신규 표
`growth_legacy_base` 에 **보유 카드 전량을 스냅샷**하는 것(설계 주석: 안 키운 카드도 담아야 "얼마나 깎였나"를
나중에 물을 수 있다).

리허설(라이브 사본): 3건 순서대로 **전부 OK** · `integrity ok` · 행수 무변경 ·
`growth_legacy_base` **3212행 = 보유 카드 전량과 정확히 일치**.
**라이브 실적**: `Migrating … 38 → 39 → 40` → `Successfully applied 3 migrations … (00:00.015s)` · 재기동 0.

### ⚠️ economy override — §0.6 함정을 정확히 밟을 뻔한 자리

라이브는 **`source: OVERRIDE`** 였다. 이 파일은 **부분 병합이 아니라 문서 통째 교체**라, 그냥 뒀으면
새 발행물의 **`mission.reward` 가 조용히 무시**되고(=#408 보상이 안 나옴), 지웠으면 **가입 젬 12,000**
(2026-07-28 운영 조정)이 날아간다. 그래서 §0.6 2-B 대로 **재작성**했다.

발차 전 override ↔ 새 발행물 **전 키 diff** 로 범위를 확정했다:
- override 에만 있는 키: **0**
- 새 발행물에만: **`mission.reward.{EASY:100, NORMAL:200, HARD:300}`**
- 값이 다른 것: **`initialGems` override 12000 vs 발행물 6000** ← 유일한 운영 조정

⇒ 새 override = **새 이미지의 구운 발행물 + `initialGems: 12000`**. temp→mv 원자 교체(uid 10001:999) →
`POST /api/admin/economy/reload`(사유 필수, 감사 이력). 검산: `initialGems 12000` · `mission.reward` 존재.

### 스모크 — 실매치 완주(스킵 2회) 2:4

| 항목 | 결과 |
|---|---|
| runner | `engine@0.42.0` · 재기동 0 |
| **컨테이너 모듈 스모크**(태그 전환 **전**) | `/simulate` 200 · ticks 1350 · playbackMs 221883 · **`configOverrides` 가 해시를 바꾼다 ✓** |
| **#421 스킵** | `GEN1` 에서는 **409 INVALID_STATE**(정상 — CAS 가드) · `FIRST_HALF` → **즉시 `HALFTIME`**(0초, H1 1:1 확정) · `SECOND_HALF` → **즉시 `FINISHED`** |
| **보상 시트** | 실화면 렌더 — **재화/성장 2탭** · `골드 +100 G` · 확인 버튼 |
| **#405 성장** | `reward_bundles` 1건(`CURRENCY`+`GROWTH` 섹션, `xpGained/levelBefore/levelAfter` 포함) · `card_xp>0` 10장 · 결과화면 `성장 리포트 11명 출전` + 선수별 XP |
| **#403 선수기록** | 결과 화면 탭 `결과 · 통계 · 선수 · 로그` 노출 · `playerStats` 응답에 선수별 pass/shot/goal |
| **#408 미션** | `GET /api/missions/daily` → **2건 발급**(EASY **100 GEM** · HARD **300 GEM**) = **재작성한 override 값이 그대로 나온다**(이 열차 economy 처리의 종단 증거) |
| 시계 | 헤더 `78'`·`81'` = 0~90 축(#388 무회귀) |
| JS 에러 | **0**. 4xx 는 `/api/chars/index` 404 1건 = 설계된 폴백 트리거 |

배포자: hmb:deploy2 (hero 발차, main 조립 지시).

---

## 2026-08-03T07:10Z — [운영 조치] **권씨 공지 문안 확정** (hero verbatim, 무배포) — revision 4

앞부분을 hero 확정 문안으로 교체. **문구 임의 수정 0**(글자·문장부호 그대로), 이미지 유지.

```
![권씨](/api/notices/assets/01KZ371D5ZQ4DQ38YEE1B5DMES)

From 유류관리중대 통제반. 그의 코에는 특별함이 있다! 지금 뽑기에서 레전드 공격수 권씨를 만나보세요.

최전방을 지배하는 특급 공격수입니다.
```

⚠️ **지시의 "현재 공지의 스펙 설명 부분은 그대로 유지"에 해당하는 블록이 이 공지엔 없었다.**
수정 전 본문은 이미지 + **한 단락**이 전부였다(오시야스 공지에 있는 능력치·불릿 같은 **스펙 섹션이
애초에 없다**). 그래서 새 문안이 대체하지 **않는** 서술 문장 `최전방을 지배하는 특급 공격수입니다.`
하나만 뒤에 남겼다. **수치를 지어내지 않았다** — #256 규율(문안의 수치는 `players.v2.4.json` 실값만).

📌 **종결(2026-08-03, hero 확정): 스펙 블록은 넣지 않는다 — 현행 문안 유지.**
그래서 이 공지의 최종형은 revision 4 다. *(참고로 물어봤던 실값은 `shooting 95 · mental 95 ·
technical 92 · passing 90 · pace 89 · positioning 89 · tackling 86 · stamina 86 · physical 83` —
쓰지 않기로 했다.)*

**검증 — 실화면(폰 430×932)**: 팝업 `1/3` 에 이미지(`1080×1180 · complete · 표시폭>0`) + 새 문안 렌더.
`GET /api/notices/active` 에서 verbatim 문자열 완전 일치 확인. JS 에러 **0**.

집행자: hmb:deploy2 (hero 지시, main 전달).

---

## 2026-08-03T07:05Z — [운영 조치] **권씨 공지에 이미지 추가** (무배포)

hero 제보 "사진이 빠졌다". 오시야스와 **같은 경로·같은 규격**으로 넣었다.

**이미지 = 새로 합성했다.** 라이브 web 의 `art-kwonssi.png` 는 **투명 배경 전신 카드 아트**이고,
오시야스 공지 이미지는 그걸 그대로 쓴 게 아니라 **배너로 합성한 것**이었다(1080×1180 webp — 남색
그라디언트 + 중앙 블루 글로우 + 좌우 금색 셰브론 + 바닥 금색 아크 + `HERE WE GO!` 워드마크).
그 템플릿이 리포에 있다 → `apps/web/scripts/notice-hero/make-notice-hero.py`.

```bash
python3 make-notice-hero.py <캐릭터PNG> <출력> --wordmark herewego-wordmark.png
```
📌 **왜 이미지에 굽나**(스크립트 주석): 공지 본문 렌더러는 HTML 주입을 막아 서식이 5가지뿐이라
(굵게·기울임·목록·링크·이미지) 색·프레임·타이포를 본문으로 표현할 방법이 없다. 그래서 디자인을
이미지 안에 넣고 **캐릭터만 갈아끼우는 템플릿**으로 만들어 뒀다. 규격 대조: 오시야스 1080×1180
WEBP 89.1KB ↔ 권씨 **1080×1180 WEBP 86.7KB**.

**절차(AC3 ③ 순서 규칙 준수 — 자산을 공지보다 먼저)**
1. `POST /api/admin/notices/assets` (multipart, 파트명 `file`) → **201** ·
   `id 01KZ371D5ZQ4DQ38YEE1B5DMES` · `active:true` · 88788 bytes.
2. **자산 서빙 확인 먼저** — `GET /api/notices/assets/{id}` → 200 · `image/webp` · 1080×1180.
   *(반대로 하면 본문 이미지가 404 인 창이 생긴다.)*
3. `PUT /api/admin/notices/{id}` → **revision 3**. 본문 맨 앞에 `![권씨](/api/notices/assets/{id})` +
   빈 줄 — 오시야스와 **같은 배치**. ⚠️ 경로는 **상대경로**다(절대 URL 을 구우면 터널이 회전할 때
   과거 공지 이미지가 전부 깨진다 — 업로드 응답의 `url` 도 상대경로로 준다).

**검증 — 실화면(폰 비율 430×932)**
- 공지 팝업 `1/3` 에 **이미지가 실제로 렌더**된다: `img` `naturalWidth 1080 · naturalHeight 1180 ·
  complete true · 표시폭 > 0`. 캡처로도 눈으로 확인(배너 → 본문 → 닫기 순서, 잘림 없음).
- 본문 텍스트도 그대로: `… 특급 공격수입니다. 그의 코에는 특별함이 있습니다!`
- 에러 0. 4xx 는 `/api/chars/index` 404 1건뿐 = 설계된 폴백 트리거.

⚠️ 알고 가는 것: 업로드 자산은 **#320**(공유 카드 OG 썸네일 깨짐)이 그대로 재현된다 — 이번 건으로
새로 생긴 문제가 아니라 선행 결함이다.

집행자: hmb:deploy2 (hero 지시, main 전달).

---

## 2026-08-03T07:02Z — [운영 조치] **권씨 공지 문안 추가 + '이게팀이야' 에게 권씨 카드 1장 지급** (무배포)

hero 지시 2건. 둘 다 어드민 API — 배포 없음.

**① 공지 문안 추가** — `PUT /api/admin/notices/01KZ366VARXGRY8SC38P5M5RBX` → **revision 2**.
hero verbatim 문장 `그의 코에는 특별함이 있습니다!` 를 본문 끝에 붙였다. 나머지(제목·priority 10 ·
`endsAt 2026-08-10`)는 그대로. 유저 노출 경로(`GET /api/notices/active`)에서 반영 확인.
📌 수정 바디에 **`active` 를 실으면 400** 이다(생성에서만 유효 — 조용히 무시하지 않는 설계, MAJ-1).

**② 카드 지급** — 지급 전 **read-only 사본으로 닉네임 정확 일치 확인**: `이게팀이야` =
`01KZ329W45BGW4DPPW5S7TV8BK` **1명, 유일**(부분일치 후보도 이 한 명뿐 → 오지급 위험 없음).

`POST /api/admin/mails` · `Idempotency-Key: kwonssi-grant-igetimiya-20260803` · **HTTP 201**(=이번에 보냄) ·
campaign `01KZ36W6JGB6F1HH0HWHDS9JW2` · 첨부 `players:[{playerId:"P174",count:1}]` · 만료 30일.
대조 결과 첨부·문안 일치 · `targetCount 1` · **`claimedCount 0`**.

⚠️ **카드 직접 지급 경로는 없다 — 메일이 유일하다.** `/api/admin/users/{id}/points` 는 재화 전용이고
카드 첨부는 `AdminMailService` 만 지원한다(발송 시점에 `SELECT COUNT(*) FROM players WHERE id=?` 로
카탈로그 존재를 막는다 — 여기서 놓치면 "보냈는데 안 왔다"가 된다).

**⇒ "보유 확인"은 지금 시점에 성립하지 않는다.** `user_players` 에 P174 **없음**(= 미보유),
`user_mails` 에 해당 메일 **도착·미수령**(`claimed_at` NULL). **수령은 유저가 눌러야 보유로 바뀐다** —
§0.7 보상 프로토콜대로 **대신 누르지 않는다**(별희 선례). 유저가 수령하면 그때 보유로 잡힌다.
정정이 필요하면 **수령 전에만** 가능(`/revoke` 후 재발송, ⚠️ 재발송은 **멱등키를 새 값으로**).

📌 **지급 메일 문안은 hero 위임 문장이 없어 이 세션이 작성했다**(제목 `권씨 카드 선물` / 본문
`신규 레전더리 선수 권씨 카드 1장을 보내드립니다. 최전방을 지배하는 특급 공격수입니다.`).
바꾸고 싶으면 **수령 전에** 회수·재발송하면 된다.

집행자: hmb:deploy2 (hero 지시, main 전달).

---

## 2026-08-03T06:50Z — [운영 조치] **권씨(P174) 오픈** — 유닛 활성화 + 공지 게시 (무배포)

hero 지시. **배포 없음** — 어드민 API 토글 2회다(#389 AC3 절차 그대로).

**① 선행조건(아트 도달) 충족 확인** — `v3.16` 에 이미 실렸다:
`/chars/units/manifest.json` 에 `kwonssi` 있음 · `/chars/units/art-kwonssi.png` → **`image/png`**.
*(AC3 가 경고한 순서다 — 아트 없이 켜면 도감·뽑기에서 이니셜 폴백으로 뜬다.)*

**② 활성화** — `POST /api/admin/units/P174/activate`, reason 필수. 응답 `applied:true` ·
`changedFields:["active","adminLocked"]` · `auditId 01KZ364Q21V23TT68D01D2SC7K`.
`admin_locked=1` 이라 **재배포해도 안 덮인다**. 되돌리기 = `/deactivate` 1콜.

**③ 공지** — `POST /api/admin/notices` · id `01KZ366VARXGRY8SC38P5M5RBX` · priority **10**(오시야스와 동일) ·
`endsAt 2026-08-10T06:50:32Z`(7일) · `status LIVE`. **문안은 hero/main 초안 그대로**(무수정) —
제목 `신규 레전더리 선수 권씨 등장!` / 본문 `새로운 레전더리 선수 권씨가 합류했습니다. 지금 뽑기에서
만나보세요. 최전방을 지배하는 특급 공격수입니다.` 이미지 없음 → 자산 업로드 단계 불필요.

**④ 검증**

| 항목 | 결과 |
|---|---|
| 공개 카탈로그 | **165 → 166**, `P174 권씨 FW LEGEND` 노출 |
| 획득 가능 LEGEND FW | **3 → 4** (`P173·P174·P176·P180`) — AC3 기대치와 일치 |
| 뽑기 풀 | `players.active=1` · 활성 LEGEND **8종**. `loadPools()` 가 뽑기마다 `WHERE active=1` 재조회 → **재시작 없이 즉시 반영** |
| 공지 노출 | 비인증 `GET /api/notices/active` 3건 중 **1순위** · 실화면 팝업 `1/3` 로 제목·본문 그대로 렌더 |
| **이니셜 폴백 아님** | 도감 실화면 — 카드가 **`art-kwonssi.png`(512×768) 를 실제로 로드**한다. 미보유라 잠금 실루엣으로 마스킹되지만, 폴백 카드였다면 그 `img` 자체가 없다(아트 없는 선수는 `AO`·`RV` 같은 **이니셜 원**이다) |

**⑤ #397 은 이걸로 해소되지 않는다** — 권씨는 이제 `active=1` 이라 그 이슈의 대상에서 빠지지만,
**비활성 유닛이 16종 남아 있다**(P001 Lev Yashin … 역사적 이름 자리표). #397 이 지적한 두 경로
(강화 카드 조회 스탯 유출 · 리그 봇 로스터 편성)의 위험은 **그대로 유지**된다 — server-java 트랙 소관.

**⑥ 후속(AC3 ⑤, 이 세션 밖)**: 다음 시드 발행 때 `players.v2.x` 의 P174 를 `active: true` 로 승격하고
`gen-chars.ts` 의 `ACTIVATION_PENDING` · `chars-map.test.ts` 의 `PENDING_ACTIVATION_UNITS` 에서 빼야 한다.
**안 하면 새 환경·새 DB 에서 다시 비활성으로 시작한다**(P180 경니시우스가 실제로 그랬다).

집행자: hmb:deploy2 (hero 지시, main 전달). 문안 다듬기는 hero 가 하면 `PUT /api/admin/notices/{id}` 로 수정.

---

## 2026-08-02T10:54Z — **배포 v3.17 — server-java 단독** — #402 경기 시작 대기시간 개선

- **git**: **`25883d7`**(main). **server-java 단독** — `git diff 80e25a8..25883d7` = `server-java/src` 18 ·
  `evidence/402` 13 · docs 2. **엔진·러너·web·shared 무접촉**, **마이그레이션 0건**.
- **이미지**: `hmb/server-java:p3` = `sha256:2fc8a23d10e9…` (**java 만 리빌드**).
  runner digest 배포 전후 **동일**(`0fde29d1966f…`) · executor 무접촉(기동시각 배포 이전 유지).
- **롤백 기준선**: `hmb/server-java:prev-live` = `sha256:d053b40a8d12…`.
- **DB 백업**(마이그레이션 없어도 습관대로): `pre-v317-20260802T105306Z.db` — `ok` · flyway **37** ·
  users **191** · matches **88** · sha256 `d04b1601ce3e…`. Flyway 실적 = `No migration necessary`.
- **진행 중 매치**: 재기동 전 **0건** 확인.

### 게이트 — `./gradlew test --rerun-tasks` 콜드 **982 tests / 1 failed**

유일 실패 = `MatchClockShippedDefaultsTest.shippedHalfRealMsMatchesMeasuredPlaybackLength`
(`half-real-ms` **220000** vs 기대 156000~207000) = **#409 선행 결함**. 인계 코멘트를 믿지 않고
**정적 대조로 직접 확인**했다: 이번 SHA 는 그 테스트도 `application.yml` 도 **건드리지 않았고**,
라이브 SHA `80e25a8` 에도 `half-real-ms: 220000` + 같은 임계가 그대로 있다 ⇒ **base 부터 red**, 이번 변경 무관.
📌 실제 운영 창은 러너 `playbackMs` 라(v3.14~v3.15 실측) 이 값은 **폴백 전용**이다 — 그래서 라이브 영향 없음.

### 스모크 — 매치 3종 완주 + **대기시간 실측** (#402 의 개선 목적)

| 축 | 대기시간 | AI 잡 | 판정 |
|---|---|---|---|
| 연습 | **2초** | +4 | 정상 |
| 리그(기존 시즌) | **54초** | +3 | ⚠️ 아래 참조 |
| **원정 — 미스** | 25초 | +5 | 개선(기준선 p50 60초 · 최악 347초) |
| **원정 — 히트** | **0초** | +4(백그라운드) | ✅ **수비자 인풋 재사용 발화 = 개선 축 ① 확인** |

경기는 3판 모두 완주(2:0 · 1:0 · 0:1 · 1:1). java 로그 `error|exception` **0줄**.

### ⚠️ **리그 축은 이 시즌엔 안 나타난다 — 소급 적용이 아니다** (결함 아님, 설계상 귀결)

리그 54초를 "개선 안 됐다"로 읽으면 안 된다. #402 의 리그 축은 봇 팀 id 를 **디비전 고정**
(`LEAGUE-D{n}-T{i}`)으로 바꿔 같은 디비전 유저가 봇 A 를 공유하게 만드는 것인데,
그 id 는 `LeagueService.buildTeams()` = **시즌 생성 시점**에 박힌다. 라이브 DB 확인 결과
현재 시즌 fixtures 의 봇 id 는 여전히 **구 형식(시즌 파생)** `01KYTNA47235…-T2` 다 —
이 시즌이 배포보다 먼저 만들어졌기 때문이다. `LEAGUE-D%` 행은 **0건**.

⇒ **리그 개선은 다음 시즌부터** 관측된다. 지금 시즌은 라운드마다 봇별 최초 1회 비용을 그대로 낸다.
동일하게 **1덱 1시드 축**(`GET /api/deck` 상시 보증)도 각 유저가 **다음에 접속할 때** 해소되므로,
휴면 유저가 상대일 때는 당분간 미스가 남는다(원정 25초 사례가 그 경우다).

📌 다음 시즌이 열린 뒤 `sqlite3 … "SELECT COUNT(*) FROM league_fixtures WHERE home_team LIKE 'LEAGUE-D%'"`
가 **0 이 아니게 되는지**로 리그 축 발화를 확인할 수 있다.

배포자: hmb:deploy2 (hero 최우선 지시, main 조립 지시).

---

## 2026-08-02T07:55Z — **배포 v3.16 — web 단독** — 권씨 아트 입고(#389) + 웹픽스 2건(#386·#388). **web 배포 동결 해제**

- **git**: **`80e25a8`**(main). **백엔드 무접촉** — java·runner digest 배포 전후 **동일**
  (`d053b40a8d12…` / `0fde29d1966f…`, `engine@0.40.0`). *(`hmb-java` 는 재기동됐지만 `deploy-pages.sh`
  의 CORS 재결선 단계라 **이미지는 그대로**다 — digest 로 확인했다.)*
- **URL**: web `https://hmb-online.pages.dev` → 백엔드 `https://accept-legislation-loose-ryan.trycloudflare.com`.
- **실린 것**(라이브 `8a0352d` → `80e25a8`, apps/web 축): `00a2511` 권씨(P174) 아트 입고(#389) ·
  `6601d17` #388 헤더 시계 · `0ab43ee` #386 공지 미노출/스크롤.

### 🔓 **web 배포 동결 해제 — hero 확정 "배포하고 비활성 유지"**

동결(#389, 2026-08-01 등록)은 **"비활성이어도 web 배포하면 아트·이름이 공개된다"**는 것이었다.
발차 전 **빌드 산출물로 사실을 확인해 hero 에게 소명**했다 — 추정이 아니다:

- `dist/chars/units/manifest.json` 에 `"kwonssi": {"name":"권씨","position":"FW", card: art-kwonssi.png}`
- `dist/chars/player-chars.json` 에 `P174 → kwonssi` (**어느 선수인지까지**)
- `art-kwonssi.png` 300KB · `face-kwonssi.png` 82KB
- ⚠️ 게다가 **URL 을 아는 사람만 보는 게 아니다** — `apps/web/src/common/char-assets-store.ts:56` 이
  **앱 부팅 때 `units/manifest.json` 을 무조건 fetch** 한다. 접속하는 모든 브라우저가 받는다.
- **DB `active=0` 은 이걸 하나도 막지 못한다**(막는 건 "게임에서 뽑히거나 쓰이는 것"이고,
  아트·이름·매핑은 **web 정적 파일**이라 서버를 안 거친다).

**hero 판단 = 그대로 배포하고 비활성 유지**(권씨 AC). 소명 후 확정이라 그대로 발차했다.
⇒ **이후 web 열차는 이 제약 없이 간다**(메가 에픽 web 열차 기준선).

### 검증

| 항목 | 결과 |
|---|---|
| 앱 로드 | `/home` 정상 — 지갑 `12,600 G / 12,030 Z` · 덱 · 도감 · **공지 `1 / 2 오시야스 합류!`** 렌더 |
| **권씨 아트 서빙** | `/chars/units/art-kwonssi.png` · `face-kwonssi.png` → **`content-type: image/png`** |
| 판별 대조군 | 없는 파일 `art-nonexistent-xyz.png` → **`text/html`**(SPA 폴백). ⚠️ v3.15 에 적어 둔 그 판별법 — **상태코드는 둘 다 200 이라 content-type 으로만 갈린다** |
| **P174 비활성 유지** | 라이브 DB **read-only 사본** 조회: `P174 권씨 LEGEND active=0`. 대조 `P182 오시야스 active=1`. **활성화 조작 0**(오픈은 hero 별도 진행) |
| **#388** | **해소 확인.** 같은 순간 헤더/로그줄이 **48/48 · 49/49 · 50/50 · 51/51** 로 일치(구 버그 = 정확히 2배 차이). 리플레이 헤더 `52'` = 0~90 축 |
| **#386** | 홈에 공지 노출(`공지 1 / 2`) 확인 — 세부 QA 는 noticeux 트랙 |
| JS 에러 | **0**. 4xx 는 `/api/chars/index` 404 **1건뿐이고 설계된 폴백 트리거**(`char_bundles` 0행) |

배포자: hmb:deploy2 (hero 확정 — 유출 소명 후 "배포하고 비활성 유지", main 조립 지시).

---

## 2026-08-02T07:07Z — **배포 v3.15 — 백엔드 온리** `engine@0.34.0 → 0.40.0` + **#383 무배포 계수(V37)**

- **git**: **`e2ca113`**(main) — hero 발차 확정. **web 재빌드 없음**(🚫 권씨 #389 유출 동결, §0.7).
- **버전**: engine **`engine@0.40.0`** · server-java 0.1.0 · servants 0.0.1 · **web 은 `8a0352d` 그대로**.
- **이미지**: `hmb/server-java:p3` = `sha256:d053b40a8d12…` · `hmb/servants:p3` = `sha256:0fde29d1966f…` (둘 다 재빌드).
- **롤백 기준선**: `prev-live` = java `sha256:8cc6d23449f5…` / runner `sha256:c47df9167cb1…` (= engine@0.34.0).
- **URL**: web `https://hmb-online.pages.dev`(무접촉) → 백엔드 `https://accept-legislation-loose-ryan.trycloudflare.com`.
- **DB 백업**: `~/.local/state/hmb/db-backups/pre-v315-20260802T070503Z.db` — `integrity_check ok` ·
  flyway **36** · users **191** · matches **86** · sha256 `fb7261d6c08d…`.
- **#241 관문**: 발차 직전 진행 중 매치 **0**(07:06:51Z) → 단절 피해 **0**. (축구왕여르 진행분은 소진 완료 상태였다.)

### V37 — 리허설을 먼저 하고 갔다 (예측 = 실측)

`V37__engine_config_overrides.sql` = 신규 표 1 + 부분 UNIQUE 인덱스 1 + `ADD COLUMN` 5. **파괴 연산 0**,
`.sql.conf` 짝파일 없음(= 기본 트랜잭션). **8/2 사전 리허설**(라이브 사본 544MB): DDL OK · `integrity ok` ·
행수 무변경 · 신규 컬럼 전부 NULL. **라이브 실적**: `Migrating schema "main" to version "37"` →
`Successfully applied 1 migration … (execution time 00:00.008s)` → `Started Application`. 재기동 **0**.

📌 **롤백 계획에 스키마 되돌리기는 넣지 않았다** — 근거를 추론이 아니라 **실측**으로 잡았다. V37 적용 DB +
`flyway_schema_history` 37 행에 **구 java 이미지**를 실제로 붙여 띄워 보니 `validated 37 migrations` →
`WARN: version (37) newer than latest available (36)` → **`Started Application`**. 경고만 내고 뜬다.

### 발차 전 컨테이너 스모크 (#385 재발 방지 — v3.14 에서 승격한 절차)

태그 전환 **전에** 새 러너 이미지를 버려도 되는 컨테이너로 별도 포트에 띄워 확인했다:

| | |
|---|---|
| 모듈 로드 / 재기동 | 정상 / **0** (v3.14 1차 발차를 죽인 그 실패 모드) |
| `/health` | `engine@0.40.0` |
| `/simulate` 기본 | `200 · ticks 1350 · events 317 · playbackMs 217683 · hash 9244334d` |
| **`/simulate` + `configOverrides`** | `200 · hash fe119448 · effectiveConfigHash 2fff3c434ec49ca2` |
| **오버레이가 경기를 실제로 바꾸나** | **✓** 기본과 **해시가 다르다**(참조만 있고 무효인 경우를 배제) |

이번 열차엔 `src/runner/dockerfile-workspaces.test.ts`(전이 의존 대조) 회귀 가드도 실렸다 —
사람 기억이 아니라 계약이 #385 부류를 막는다.

### 스모크 — 실계정 `deploy-smoke` 연습 1경기 완주 (4:2)

- `configVersion` **`engine@0.40.0`**(전·후반 둘 다) · 하프 창 **195867 / 178817 ms**(러너 `playbackMs`, 폴백 아님)
- 이벤트: pass 467 · shot 32 · **goal 6** · clearance 3 · foul 3 · free_kick 3 · save 2 · 오토모드 감독시간 자동 스킵
- ⑤ **골 5.65→6.45(+14%)는 hero 컨펌된 상태**(트랙 T 재보정 전) — **이상 아님.** 이 경기 6골도 그 밴드다.

**#383 계약이 라이브에서 실제로 발화한다**: `match_halves.effective_config_hash` 가 전·후반 **둘 다
`d0357c20661c61fd` 로 동일**(= 무음 desync 가드 작동) · `config_overrides_json`·`dropped_overrides_json`
= NULL(오버레이 미설정 = 기본값, 원장 비어 있음). `GET /api/admin/engine-config` → **200**
`{"revisionId":null,"overrides":{},…}`.

### #396 러너 롤백 관문 — 라이브에서 판정 확인

`bash infra/preflight-runner-rollback.sh` → **exit 0 (롤백 가능)**: `라이브 오버레이 = {}` · `진행 중 매치 0`.
사전에 만들 때는 API 가 없어 404 경로로만 검증했는데, **이제 실제 200 응답 형태로 EMPTY 분기가 검증됐다.**

### 🚫 권씨 동결 준수 — 확인까지 했다

`deploy-pages.sh` 미실행. 서빙 번들 `index-CzxOp5Y0.js` = 배포 전 스냅샷과 **동일**.
⚠️ **`/chars/units/art-kwonssi.png` 이 `200` 을 낸다 — 그런데 유출이 아니다.** `content-type: text/html`
= **SPA 폴백**이고, 존재하지 않는 `art-nonexistent-xyz.png` 도 똑같이 200/text/html 이다(실물은
`frame-LEGEND.png` 처럼 `image/png`). **상태코드만 보면 유출로 오판한다 — content-type 으로 갈라야 한다.**

배포자: hmb:deploy2 (hero 발차 확정, main 조립 지시).

---

## 2026-08-01T15:07Z — **[장애·복구] 터널 58분 다운** — 워치독 치유가 매달려 재시도를 굶겼다 (#391)

- **영향 창**: **14:08:06Z ~ 15:07Z (약 58분)** 테스터 접속 불가. **백엔드·러너·executor 는 내내 정상**
  (engine@0.34.0 유지) — 죽은 건 터널 하나다. DB·이미지·배포물 무변경.
- **복구**: 매달린 워치독 `--once`(PID 98936, 85분 경과) **PID 지정** 종료 → `bash infra/start-tunnel.sh`
  → 새 URL **`pole-maine-honey-spirits.trycloudflare.com`** + Pages 재배포.
- **검증**: `status.sh` 전항목 ✓ · 터널 경유 `internal/health 401` · `api/config 200`(Origin 포함) ·
  Pages `config.json` = 새 URL.
  - 📌 `config.json` **첫 조회는 옛 URL 이었다**(CDN 캐시, §0.8 이 경고하는 그 함정). 캐시버스터로
    재조회해 확인했다 — 이걸 안 하면 "복구 실패"로 오판한다.

### 왜 워치독이 58분간 아무것도 안 했나 — 결함 3겹 (#391, 이번에 전부 수정)

1. **`current_url` 이 cloudflared 의 등록 엔드포인트 `https://api.trycloudflare.com` 을 터널 주소로
   착각**한다(정규식이 그것까지 먹는다). 우리 터널이 아닌 주소를 프로브하니 영원히 안 산다.
   **같은 방식으로 하루에 두 번** 죽었다 — `09:28:45Z→10:49:06Z` · `14:08:06Z→15:05:55Z`, 둘 다
   `HEAL_FAIL … url=https://api.trycloudflare.com`.
2. **"120초 상한"이 상한이 아니었다 — 실측 3469초.** 대기 루프가 `sleep` 합계만 누적하는데
   한 바퀴의 실제 비용은 `probe`(dig 4개 + curl)가 지배한다. 해석기 전멸 장애에서 상한의 **29배**.
3. **살아서 매달린 실행은 락 회수 규칙에 안 걸린다**(죽은 소유자만 훔쳐온다) → 60초마다 오는
   후속 틱이 전부 "다른 치유 진행 중"으로 되돌아간다. **워치독이 존재하지 않는 것과 같아진다.**
   ⇒ 이게 58분의 실체다. 1·2 를 고쳐도 *모르는* 지점에서 매달리면 재현되므로 별도로 막아야 한다.

**수정**(`infra/tunnel-heal.sh`): ①`api.` 배제(배정 전이면 **빈값** → 60초 안에 정직하게 실패하고
다음 틱이 재시도) ②**벽시계 마감**으로 교체 + 실패 기록에 `실경과=<초>` 병기 ③**실행 자기 마감**
`HMB_RUN_DEADLINE`(기본 420초) — 어디서 매달리든 `RUN_TIMEOUT` 기록 후 자결, 락 해제.

⚠️ ③의 감시자는 stdout/stderr 를 **/dev/null 로 갈아끼워야 한다**. 안 하면 부모 fd 를 물려받아
파이프 호출(`… | tail`)에서 본체가 끝나도 호출자가 매달린다 — 넣자마자 자기 `--selftest` 가 4분+
매달려 바로 걸렸다. **워치독을 고치다 워치독을 매달 뻔했다.**

**검증**: `--selftest` 9/9(3.3초) · `--check` ✓ · `current_url` 케이스 3종 · **재설치 후 리포와 동기
확인**(⚠️ 리포만 고치면 워치독은 안 고쳐진다) · 새 스크립트로 워치독 틱 정상 재개.

담당: hmb:deploy2 (main 즉응 지시).

---

## 2026-08-01T12:44Z — **배포 v3.14 — 엔진 열차** `engine@0.23.0 → 0.34.0` (**main 직행**, 롤백 이후 첫 엔진 배포)

- **git**: **`8a0352d`**(`main`) = **`f7d26be`**(hero 확정 머지 SHA = `release/engine-v2@44dd3e3` + #382 정경 문구 `2fa9923`) **+ Dockerfile 픽스 1커밋**(#385, 아래).
- **버전**: engine **`engine@0.34.0`** · server-java 0.1.0 · servants 0.0.1 · web `8a0352d`.
- **이미지**: `hmb/server-java:p3` = `sha256:8cc6d23449f5…`(f7d26be 빌드 재사용 — server-java 코드 무변경) · `hmb/servants:p3` = `sha256:c47df9167cb1…`(**재빌드**).
- **롤백 지점**: `prev-live` = java `sha256:4c1deafe4b55…` / runner `sha256:f724f3fd5e1a…`(= engine@0.23.0).
- **URL**: web `https://hmb-online.pages.dev` → 백엔드 `https://proceeds-micro-praise-sorts.trycloudflare.com`.
- **DB 백업**: `~/hmb-db-backups/pre-enginetrain2-20260801T124259Z.db` — `integrity_check ok` · flyway **36** · users **189** · matches **78** · sha256 `cab5a67273e7…`.
- **마이그레이션 0건**(발차 직전 재스캔). java 기동 로그 = `Successfully validated 36 migrations` / `No migration necessary`.
- **#241 관문**: 발차 직전 진행 중 매치 **0건** → 단절 피해 **0**. (12:44:32Z 확인 → 12:44:39Z 태그 전환.)

### ⚠️ 이 열차는 한 번 실패하고 되돌아왔다 — 그게 이 항목의 핵심 교훈이다

**1차 발차(12:31Z)에서 러너가 크래시루프로 죽었다**: `Cannot find package '@hmb/viewer-core' imported from
/app/packages/server/src/runner/simulate.ts` (재기동 8회). ~60초 만에 `prev-live` 로 롤백, **피해 0**
(그 창에 생성된 매치 0 · 진행 중 매치 0 · web 미배포 · DB 무변경). 원인·픽스 = **#385**.

원인은 코드가 아니라 **이미지 조립 목록**이었다 — `packages/server/Dockerfile` 이 shared·engine·server
세 워크스페이스만 `COPY` 하는데 러너가 `@hmb/viewer-core/playback`(`autoPaceDurationMs`)을 새로 import 한다.
**로컬은 워크스페이스 심볼릭링크로 해석되므로 vitest·typecheck·러너 로컬 기동이 전부 green** 이었고,
결손은 **컨테이너 안에서만** 드러났다.

📌 **그래서 이번엔 발차 전에 컨테이너 스모크를 넣었다**(신설 절차 — 플레이북 §0.8 에 승격):
새 이미지를 **버려도 되는 컨테이너로 별도 포트에 띄워** ①모듈 로드 ②`/health` ③**실제 `/simulate` 왕복**까지
확인하고 나서 태그를 전환했다. 실측: `status 200 · ticks 1350 · events 330 · playbackMs 202767 · lastHash 987c5789`
— `playbackMs` 가 나왔다는 건 **문제의 `autoPaceDurationMs` 호출부까지 실행됐다**는 뜻이라 이 스모크가
1차 실패를 정확히 잡는다.

### 동승분 (0.23.0 → 0.34.0 사이 전부 — "엔진만 올린다"가 아니다)

0.26(공 물리 속도벡터·행동 계층·`clearance`) · 0.28(사슬 코어 — **v3.09 로 나갔다 롤백된 그 버전**) ·
0.29(**파울 복구** 2.15→11.55) · 0.30(#365 경기 45분·표기 0~90·재생 1.2x) · 0.31(데드볼 룰 정합) ·
0.32(입력 소생 — 피로 경제·죽은 슬라이더 배선) · 0.33(데드볼 유동 재시작) · 0.34
\+ **#365 후속 재생 방식**(`7e3a134` — 하프 창 = 매치별 실제 재생 길이 `playbackMs` · 고정 배속.
*v3.12 로 단독 발차하려다 HOLD 했던 그 변경* — 엔진이 같이 올라가는 이 열차에서만 옳다) + #382 정경 문구.

### 스모크 — 실계정 `deploy-smoke` 연습 1경기 완주(BRIEFING → FIRST_HALF → SECOND_HALF → FINISHED, 2:0)

| 항목 | 결과 |
|---|---|
| 러너 엔진 | `{"engineVersion":"engine@0.34.0"}` · 재기동 **0** |
| 서빙된 하프 로그 | `configVersion=engine@0.34.0` (전·후반 둘 다) |
| **하프 창 = `playbackMs`** | **189017ms · 187633ms** — 폴백 `half-real-ms: 220000` **아님** ⇒ #365 후속이 실제로 산다 |
| 재생 완주 | 1350틱을 189s 창 안에서 완주(헤더 22분 ≈ 1320틱) |
| **되감기** | **0** (2초 간격 107 샘플, 전 구간 단조) |
| 최장 정체 | 10s |
| **파울 복구** | **4 : 4** (v3.09 의 2.15 퇴보 해소 = 0.29 복구분 확인) |
| 카드 / 프리킥 | **1** / **8** |
| `clearance` | **6** (0.26 신설 행동이 라이브에서 발화) |
| 슛 / 골 | 20 : 12 / 2 : 0 |
| 오토모드 | ✅ 감독시간 자동 스킵(전반 종료 즉시 후반) |
| 메시지함 / 리그(V36) | ✅ 200 / ACTIVE — **마이그레이션 diff 0 이라 무변경** |
| JS 콘솔 에러 | **0**. 4xx 는 `/api/chars/index` 404 **1건뿐이고 설계된 폴백 트리거**다(`char_bundles` 0행 → web 이 구운 `/chars` 사용) |

### ⚠️ 스모크에서 **새 결함 1건 발견 — 롤백하지 않고 라이브 유지**: 헤더 시계가 0~44' (#388)

같은 순간에 **헤더 25'** / **로그줄 48'~51'** — 정확히 2배. #365 가 하프를 1350틱으로 줄이고 표기를
`displayMinutes: 90` 으로 분리했는데 `apps/web` 헤더(`stage-state.ts:clockLabel`)만 **엔진 틱을 그대로
분으로 읽는다**(`tick/60`). 엔진은 `minute` 을 제대로 구워 보낸다(실측 `half_whistle tick=1350 minute=45`).

**직전 라이브 0.23.0 은 하프 2700틱이라 `tick/60` 이 우연히 0~90 과 일치했다 — 이 열차가 그 우연을 깼다.**
표시 전용이고 스코어·보상·재생 속도·하프 창은 전부 정상이라 **롤백 사유로 보지 않았다**. 픽스는
`apps/web` 소유 → **#388**. (viewer-core `clockScaleOf` 주석이 이 결함을 정확히 예고해 뒀는데도 났다.)

### 실행 기록

executor 는 **main 체크아웃**(`/Users/peter.park/spider2/hmb-online`)에서 재기동 — 구 프로세스는 릴리스
워크트리에서 돌고 있었다(PID 지정 종료, `pkill -f` 금지). web 은 `dist` 삭제 후 **콜드 빌드** → Pages 배포.
`status.sh` 전 항목 ✓ (java·runner healthy · executor · 터널 · CORS 결선 · web→백엔드 결선).

배포자: hmb:deploy2 세션 (hero GO — "배포해", main 조립 지시).

---

## 2026-07-31T17:10Z — **배포 v3.13** — **웹 단독**: 데스크톱 레이아웃 2건(#354 감독시간 입력칸 · #355 결과 CTA 화면 밖)

- **git**: **`27249c3`**(`release/3.13`) = **`deploy-3.11` 계보 + `cherry-pick -m 1 36e7e85`**(본체 3커밋 `5449020`·`5d84eb9`·`f0f4da9`). 충돌 0.
  - ⚠️ `36e7e85` 의 **parent1 이 `7e3a134`(=HOLD 한 v3.12 재생 변경)** 이라 끌려올까 확인했는데, `-m 1` 은 parent1→머지 diff 라 **레이아웃 변경만** 넘어온다. 조립 후 재검증: `deploy-3.11..HEAD` = **`apps/web` 11개뿐**.
- **엔진·서버 무접촉 재검증**(내 쪽에서 독립 확인): `packages/engine` **0** · `packages/server` **0** · `packages/shared` **0** · `server-java` **0** · `data` **0** · `infra` **0**. 트리 `config.version` = **`engine@0.23.0`**.
- **백엔드 무접촉 확인**: 배포 전후 digest **동일** — `hmb-java sha256:4c1deafe4b55…` · `hmb-runner sha256:f724f3fd5e1a…` · `:18790/health` = `engine@0.23.0`. 이미지 빌드·마이그레이션 **0**.
- **web**: 콜드 빌드(dist 삭제 후) 통과 → Pages 배포. `version.json` = **`27249c3` / engine@0.23.0**.

### 스모크 — ✅ 4개 데스크톱 뷰포트 전부 통과(**1280×600 넓고 낮은 창 포함**)
판정은 `toBeVisible()` 로 하지 않았다 — 그건 **뷰포트 밖도 통과**시킨다(이 열차의 capture 계약이 같은 이유로 금지한다). **박스 + 중심점 히트테스트**, 그리고 **실제 클릭·타이핑**으로 쟀다.

**#355 결과 CTA(`to-lobby`)** — 스크롤 밖 고정 구조가 실제로 작동한다:

| 뷰포트 | CTA y~bottom | 뷰포트 안 | 중심점 히트 |
|---|---|---|---|
| 1280×800 | 728~780 (vh 800) | ✓ | ✓ |
| **1280×600** | **528~580 (vh 600)** | **✓** | **✓** |
| 1440×900 | 828~880 (vh 900) | ✓ | ✓ |
| 1920×1080 | 1008~1060 (vh 1080) | ✓ | ✓ |

- 어느 비율에서도 **바닥에서 ~20px 위에 고정**된다(스크롤 길이와 무관) = `.scroll` 밖으로 뺀 구조가 살아 있다.
- **클릭도 실제로 눌러 확인**: `로비로` → `/home` 이동. 📌 처음엔 "이동 안 함"으로 읽혔는데 **오독이었다** — `/home` 이 `MatchLockGate` 때문에 **진행 중이던 스모크 매치로 다시 라우팅**된 것이다. 버튼은 정상이고, 진행 중 매치가 없을 때는 로비로 간다.

**#354 감독시간 입력칸** — 실제 하프타임 창(고정 계정 `deploy-smoke`, `auto` 끔)에서:

| 뷰포트 | halftime-panel | textarea | 클릭→타이핑→값 회수 |
|---|---|---|---|
| 1280×800 | y134~790 (vh 800) | 374~483 ✓ | ✓ |
| **1280×600** | **y134~590 (vh 600)** | **374~483 ✓** | **✓** |
| 1440×900 | y134~890 (vh 900) | 379~494 ✓ | ✓ |
| 1920×1080 | y134~1070 (vh 1080) | 379~494 ✓ | ✓ |

- 패널 하단이 **모든 창에서 뷰포트 안에 들어온다**(600 창에서도 bottom 590 < 600). textarea 도 전부 뷰포트 안이고 **실제로 글자가 들어갔다**.
- **JS 에러 0**(4개 뷰포트 전부).

### ⚠️ 배포 중 라이브 장애 2회 — 워치독 "반쪽 치유"가 재현됐다(§6 갭 2·3)
- 이 열차 동안 quick tunnel 이 **두 번 죽었다**(`fax-vertex…` → `plains-real…` → `chronicle-allowance…`). 이 머신 uplink 가 불안정한 시간대였고(로컬 백엔드는 내내 200), github·cloudflare.com 은 정상이라 **터널만의 문제**였다.
- **문제는 죽은 것 자체가 아니라 전파다**: 워치독이 `HEAL_OK`(새 URL 기동)까지는 갔는데 **`config.json` 은 죽은 URL 그대로**였다 — `source:"build"` · `updatedAt` 이 내 배포 시각에 멈춰 있었다. 그동안 **테스터는 로그인 자체가 안 됐다**(웹이 죽은 백엔드를 호출, 530).
- 두 번 다 **`publish-backend-url.sh` 로 수동 전파**해 복구했다(재빌드 없음). 이게 플레이북 §6 이 "갭 2·3은 여전히 열려 있다(전파 결과 재확인 없음)"고 적어둔 바로 그 상태다 — **이번에 실제 유저 영향으로 나타났으니 워치독에 전파 검증·재시도를 넣는 걸 후속으로 올린다.**
- 📌 **판별 요령(§0.8 보강)**: `curl` 이 **530** 이면 터널이 실제로 죽은 것(전파 필요), **000 + `dig` 는 정상**이면 배포 머신의 로컬 리졸버 문제(테스터는 멀쩡)다. 이번 건은 **530 = 진짜 장애**였다.

---

## 2026-07-31T12:16Z — **배포 v3.11** (태그 `deploy-3.11`) — 리그 매판 일일 다이아 보상(#368, **V36**) + 승급2/강등2 컷

- **git**: **`f2ef9b4`**(태그 `deploy-3.11`) = **`deploy-3.10` 계보 + #368**. 계보 검산: `deploy-3.10` 조상 **YES** · main 엔진(`8ac6245`) 포함 **NO** · `packages/engine` diff **빈 diff** · 트리 `config.version` **`engine@0.23.0`**.
- **변경 범위**: `apps/web` 11 · `server-java/src` 10 · `data/players` 1 · docs 1. **`packages/**` 접촉 0** → **runner 재빌드·executor 재기동 생략**(runner digest `f724f3fd…` 무변경 유지).
- **이미지**: `hmb-java` **`sha256:4c1deafe4b55…`**(신규) · `hmb-runner` `sha256:f724f3fd5e1a…`(무변경). 롤백 고정 = `prev-live`(java `af3e0bcb…` · runner `f724f3fd…`).
- **⚠️ 엔진 가드**: 배포 후 `:18790/health` → **`{"engineVersion":"engine@0.23.0"}`**. release 계보 유지.
- **DB — V36 적용**: 백업 `pre-deploy311-20260731T121546Z.db`(449,073,152 B · sha256 `ae3fcdf1f7b9225749feee10efabd4a4d3676543611245e0bbade588ab0a7638` · integrity **ok** · flyway 35 · users 189).
  **§0.5-2/7 성격**: `.sql.conf` **없음**(트랜잭션 원자적) · **파괴적 구문 0** · 내용은 **`league_daily_rewards` 신규 표 + 인덱스 2개 = 순수 additive**. 적용 후 **Flyway 35 → 36**(`Successfully applied 1 migration`) · 표 생성 확인 · **users 189 보존**.

### ⚠️ 이 배포의 진짜 함정 — §0.6 economy override (안 잡았으면 기능이 죽은 채 배포됐다)
- `#368` 은 보상 노브를 **`economy.v3.json` 을 새 파일로 발행하지 않고 제자리 수정**(+10줄 `league.dailyReward`)했다. 발행물 핀(yml·Dockerfile)은 둘 다 `economy.v3.json` 이라 **§0.5-3 불일치는 없다**.
- 그런데 라이브는 **`source: OVERRIDE` · `overrideFilePresent: true`** 였다. §0.6 대로 override 가 있으면 서버는 **구운 발행물을 쳐다보지 않는다** → 그냥 배포했으면 **`dailyReward` 가 조용히 무시**되고, 로그는 정상처럼 보이며 보상 트랙만 죽은 채 떴을 것이다.
- **처리(§0.6 2-B)**: 먼저 override 가 무엇을 바꾸고 있었는지부터 실측 — 구 발행물 대비 **`initialGems` 6000→12000 단 한 줄**(= deploy-log 2026-07-28 운영 조정, SoT 일치). 그래서 **새 발행물을 컨테이너에서 꺼내 그 한 줄만 다시 얹어** override 를 재작성했다. 검산: **구 override 대비 diff = `dailyReward` 블록뿐**(운영값 전부 보존). 소유권 `10001:999` · temp→mv 원자 교체 · `POST /api/admin/economy/reload`(사유 필수) **200**.
- 결과 확인은 값이 아니라 **출처와 실효값**으로: `GET /api/league` 가 `slotsPerDay 18` · `slot 9/18 = 300 GEM(big)` · 나머지 `30 GEM` 을 돌려준다. 지갑도 `gems 12000`(override 유지분).

### 스모크 — ✅ 리그 1판 승리 → 보상·원장·표기 전부 정합
고정 계정 `deploy-smoke`(§0.55) · 리그 시즌 생성(seasonNo 1, ACTIVE) → 리그 매치 **2:0 WIN**(mode=league, 오토모드).

| 확인 | 결과 |
|---|---|
| 지갑 | gems **12000 → 12030**(+30 = 1번 칸 소량) · points **6200 → 11200**(+5000) |
| **기존 보상 위에 얹기**(hero 확정) | 포인트 보상이 **그대로 유지**된 채 다이아가 **추가**됐다 — 골드 사이클 제거·중복지급 없음 |
| 원장 `league_daily_rewards` | `slot_no 1 · GEM · 30 · WIN · awarded 1 · big 0 · opponent "Granite Guardians" · day 2026-07-31`(**KST**) |
| 지갑 원장 `gem_ledger` | `reason=league_daily_gem · delta=+30 · ref_id=01KYW21VXJTDJ4AWYSPC8SP8WQ`(매치 id = 멱등 키) |
| 화면 표기 API | `consumed 1 · awardedCount 1 · earned 30 GEM` · **slot1 `WON`**(상대명 표기) · **slot2 `PENDING`**(다음 상대 `Onyx Harbor` 미리 표기) |
| 승급/강등 컷 | `promote-rank-max: 2` · `relegate-rank-min: 9`(=9~10위 강등 → **승급2/강등2**). API 가 `relegateRankMin: null` 인 것은 **정상** — `division >= bottom ? null` 이라 최하위 D10 은 강등이 없다(deploy-smoke 가 D10). |
| 무회귀 | `/api/mails` 200 · `/api/rankings` 200 · `/api/away/revenge` 200 · 오토모드 `HALFTIME` 스킵 정상 |

- **📌 미검증(정직 표기) — 패배 시 소멸**: `deploy-smoke` 파워 6218 vs 리그 봇 4646~4671 이라 **라이브에서 패배를 만들 수 없었다**. 코드·스키마상 경로는 있다(`awarded` 컬럼 + `result` 박제, 표 주석이 "소멸분도 얼마였는지 남긴다"고 명시). 승리 경로만 실측했다.

### 📌 웹 배포가 5회 연속 실패했다 — 우리 문제가 아니었다
- `wrangler` 가 **CF API 에서 522/525**(`Received a malformed response from the API`)를 5회 연속 반환. 확인해 보니 **`api.cloudflare.com` 직결도 522**인데 **github.com 은 200** — 즉 토큰·번들·스크립트가 아니라 **Cloudflare API 도달 문제**였다. 60초 간격 재시도로 **6번째에 성공**.
- 그동안 **백엔드만 v3.11, web 은 v3.08 번들**인 부분 배포 상태였다(보상은 서버가 주므로 지급은 정상, 새 UI 만 없음). 최종 정렬 확인: `version.json` = **`f2ef9b4` / engine@0.23.0 / java `4c1deafe…`**.
- 교훈: **웹 배포 실패를 코드 탓으로 돌리기 전에 `curl https://api.cloudflare.com/client/v4` 를 한 번 때려라.** 522/525 면 기다렸다 재시도하는 게 유일한 조치다.

---

## 2026-07-31T09:20Z — **배포 v3.10** (태그 `deploy-3.10`) — **runner 단독**: 포메이션 게이트 G4 + 스텁 실행기 좌표 픽스(#367 / #295 server 축)

- **git**: **`763b8a2`**(태그 `deploy-3.10`) = **`deploy-3.08`(4782f54) 계보 + #367 체리픽**. ⚠️ **[롤백] 항목이 세운 규칙을 처음 적용한 열차다** — `main` 을 쓰지 않았다.
  - **계보 검산 2줄**(추측 금지): `git merge-base --is-ancestor deploy-3.08 deploy-3.10` → **YES** · `git merge-base --is-ancestor 8ac6245 deploy-3.10` → **NO**(main 의 엔진 0.28/0.29 머지 **미포함**).
  - **엔진 무접촉 확인**: `git diff --stat 4782f54..deploy-3.10 -- packages/engine` → **빈 diff** · 트리의 `config.version` = **`engine@0.23.0`**.
- **변경 범위**: `packages/server` 7(`executor/executors/stub.ts` · `prompt/{coach,gates}.ts`+테스트 · CLAUDE.md) · `tools` 2 · docs 1. **`server-java`·`apps/web`·`data`·`infra`·`packages/shared`·`packages/viewer-core` 전부 0** → **java 재빌드·웹 재배포·마이그레이션 생략**(지시대로). 마이그레이션 **0건**, Flyway **v35 유지**.
- **이미지**: `hmb-runner` **`sha256:f724f3fd5e1a…`**(신규) · `hmb-java` `sha256:af3e0bcb247d…`(**무변경** — 배포 후 digest 로 재확인).
- **⚠️ 이 열차의 핵심 가드 — 엔진이 다시 올라오지 않았는가**: 배포 직후 `GET :18790/health` → **`{"engineVersion":"engine@0.23.0"}`**. release 계보 빌드라 롤백 상태가 유지됐다. (main 에서 빌드했다면 여기서 0.29.0 이 떴을 것이다.)
- **executor 재기동**: `packages/server` 변경이라 필수. **release 계보 워크트리 `~/spider2/hmb-release`(= `deploy-3.10`)에서** 기동 — worker `ts-executor-5330` · claude-code/sonnet · concurrency=1 · 구독(정액제).
  - ⚠️ **함정 기록**: 처음엔 워크트리 `node_modules` 를 **메인 체크아웃으로 심링크**했는데, 그러면 `node_modules/@hmb/*` 워크스페이스 링크가 **main(엔진 0.28/0.29)을 가리킨다** — executor 가 되돌린 엔진을 다시 로드할 뻔했다. 워크트리에서 **`npm install` 을 제대로 돌려** 링크가 `../../packages/*`(release 트리 안)로 잡히는 것을 확인하고 기동했다. **release 계보로 프로세스를 띄울 땐 node_modules 를 공유하지 마라.**
- **📌 web `version.json` 은 `4782f54` 로 남는다**: v3.10 은 `apps/web` 변경이 0이라 웹을 재배포하지 않았다(지시). 그래서 화면이 보고하는 SHA(`4782f54`)와 실제 runner 계보(`763b8a2`)가 다르다 — **의도된 상태**다. 다음 웹 열차에서 자연 정렬된다.

### 스모크 — ✅ 포메이션이 실효 반영된다
- **설계**: 판정을 절대 임계로 하지 않고 **G4 와 같은 상대비교**로 했다(절대 임계는 감독 지시로 인한 정상 조정까지 잡는다). 슬롯은 배열 순서가 아니라 **`playerId`→`slotIndex`** 로 잡았다(G4 주석: 라이브 산출 19.4%가 순서가 다르다).
- **절차**: 고정 계정 `deploy-smoke` 덱을 **4-3-3 → 4-4-2** 로 바꾸고(PUT `/api/deck` 200) 신규 매치 생성 → 라이브 AI 전술 생성(claude-code, 홈/원정 2잡) → 킥오프.
- **결과(tick 0 실측)**: 포메이션 적합도(정규화 평균거리, 작을수록 적합) — **`4-4-2` 0.0129** · `4-3-3` 0.1246 · `5-3-2` 0.1522 · `4-2-3-1` 0.1620.
  **선언한 포메이션이 최적이고 2위와의 여유가 0.1118** = G4 의 `formationFitMargin`(0.02)의 **5배 이상**. x밴드 분포도 **수비 5(GK+4) · 중원 4 · 전방 2** = 4-4-2 그대로.
- **실화면 확인**: 라이브 사이트에서 `deploy-smoke` 로그인 → 매치 재생 → `window.__viewer.pause()/seek(0)` 로 **킥오프 프레임**을 세워 캡처. 화면에서도 **GK+4DF / 4MF / 2FW** 가 눈으로 확인된다(좌표만 보고 판정하지 않았다 — §0.8). **pageerror 0**.
- **무회귀**: 매치 완주 **0:1** · 슛 17 · 골 1 · 파울 10 · 프리킥 10 · 카드 3 · **PK 1** · 패스 990 — 롤백 직후 0.23.0 스모크(슛 31·골 1·파울 10)와 같은 밴드. 오토모드(HALFTIME 스킵) 정상.

### 배포 중 발견·수정한 것 (이 열차와 별개지만 라이브 가용성에 직결)
- **⚠️ 워치독 설치본이 낡아 있었다(잠복)**: 워치독은 리포가 아니라 **설치 사본 `~/.local/bin/hmb-tunnel-heal.sh`** 를 돈다. 그 사본에 **`grep -a` 픽스가 빠져 있었다** — 플레이북 §6 이 "갭 1은 `grep -a` 로 닫았다"고 적어둔 그 픽스가 **프로덕션에는 반영돼 있지 않았다**(로그가 바이너리로 판정되면 URL 자리에 `Binary file … matches` 가 들어가 전파가 깨진다). **`install-tunnel-heal.sh` 재실행으로 동기화**했다. → 교훈: **리포를 고쳤다고 워치독이 고쳐진 게 아니다. 반드시 재설치하고 설치본을 grep 으로 확인한다.**
- **터널 QUIC 문제 → `--protocol http2` 기본화**: 09:40~09:53Z **실장애**(라이브 HTTP 000). quick tunnel 기본 QUIC(UDP)이 모바일 핫스팟(당시 `172.20.10.x`)에서 `timeout: no recent network activity`·`datagram manager failure` 를 반복하다 **호스트가 DNS 에서 사라졌고**(dig 무응답), 워치독이 치유해도 **같은 QUIC 로 다시 떠서 새 URL 도 530** 이었다. **http2 로 바꾸자 첫 시도 200.** `tunnel-heal.sh`·`start-tunnel.sh`·`deploy-quicktunnel.sh` 셋 다 `--protocol "${HMB_TUNNEL_PROTOCOL:-http2}"` 로 바꾸고 재설치했다(되돌리기 = 환경변수 `quic`). 무인 복구 경로에서는 "빠름"보다 "붙는다"가 우선이다.
- **📌 헷갈리기 쉬운 오탐 — "curl 000"이 곧 장애는 아니다**: 이후 11:38Z heal 뒤에도 이 머신에서 `curl` 이 000(exit 6)이었지만, **`dig` 는 풀리고 `--resolve` 우회로는 `/api/config`·`/api/auth/login` 둘 다 200** 이었다. 즉 **서비스는 정상이고 배포 머신의 로컬 리졸버(KT 168.126.63.1)만 그 호스트를 못 푸는 상태**였다(§0.8 이 적어둔 그 케이스). **판별법: `dig` 가 풀리는데 `curl` 만 실패하면 로컬 리졸버 문제 → 테스터는 멀쩡하다.** 09:40Z 건은 `dig` 도 빈 응답이었으므로 그건 진짜 장애였다 — 둘을 구분해야 한다.
- **자책 기록**: 위 심링크(`ln -sfn`) 여파로 **메인 체크아웃(`spider2/hmb-online`)의 `node_modules` 가 비었다**. 라이브(컨테이너·release 워크트리)에는 영향 0이고 `npm install` 로 복구했다. 다른 워크트리의 의존성을 심링크로 빌려 쓰지 말 것.

---

## 2026-07-31T07:38Z — [운영 조치] 롤백 피해 유저 **별희**에게 보상 우편 **300 Z** 발송 (미수령)

- **지시**: main 전결(수령 전 revoke 가능 = 복구 가능 축). 대상 = 위 [롤백] 항목의 피해 유저.
- **✅ 발송 완료 — `별희`**(`01KYK05K3JBW3VEQZJPX0B504B`, guest, 전적 6승 0무 **1패** ← 이 1패가 그 FAILED 건)
  - **캠페인 `01KYVHR1EQJQBR35FSC52465ZP`** · `Idempotency-Key: rollback-comp-byeolhui-20260731` · `applied: true` · **201**(targetCount 1)
  - 제목 **`경기 중단 보상`** · 본문 **"점검으로 인해 진행 중이던 경기(5:0 리드)가 중단되어 죄송합니다. 보상으로 300 다이아를 보내드립니다."**
  - 첨부 **`gems: 300`**(points 0 · players []) — **Z = 유상재화**가 맞다(`MailAttachments` 스키마: points=G 무료재화 / gems=Z 유상재화). 만료 **2026-08-30T07:38:14Z**(30일).
  - `reason`(감사 원장) = "v3.09 엔진 롤백(#279 shootXgThreshold 덱 비전이성)으로 진행 중 매치 `01KYVFJ8F390D16QFPDXRTBNB1` 이 resumeState version mismatch 로 FAILED — 피해 보상" · actor `hmbadmin`
  - **검증**: `GET /api/admin/mails/{id}` 로 제목·본문·첨부·만료 대조 → **`claimedCount: 0` · `readCount: 0` · `revokedAt: null`**, DB `user_mails` 행의 `claimed_at`·`read_at` **둘 다 NULL**. **수령은 유저 몫이라 대신 누르지 않았다.**
- **📌 hero 가 금액·문안을 바꾸고 싶으면 지금 가능하다 — 수령 전까지만이다**: `POST /api/admin/mails/01KYVHR1EQJQBR35FSC52465ZP/revoke`(미수령분 회수) 후 새 내용으로 재발송한다. ⚠️ **재발송 때는 `Idempotency-Key` 를 반드시 새 값으로** 바꿔라 — 같은 키에 다른 내용은 **409** 고, 그걸 모르고 넘어가면 "정정에 성공했다고 믿는데 아무 일도 안 일어난" 상태가 된다(openapi 가 admin points 지급에서 실측으로 겪었다고 박아둔 함정). **이미 수령한 뒤에는 본문을 바꾸지 않는다**(원장 성격).
- 코드·이미지·DB 스키마 변경 **0**(어드민 API 호출만). 라이브는 `4782f54`/engine@0.23.0 그대로.

---

## 2026-07-31T07:15Z — **[롤백] v3.09 → v3.08** — engine@0.28.0 **되돌림**(라이브 골 소실, hero 긴급 확정)

- **결정**: hero 긴급 확정. v3.09(engine@0.28.0)가 라이브에서 **골을 죽였다** — 2경기 연속 0:0 · 팀당 슛 3개(구 엔진 대비 슛 27→6). 승인 시 고지된 퇴보는 **파울 축 1건**이었는데 실제 범위가 골·슛까지였다.
- **확정 진단(#279)**: **`shootXgThreshold` 절대컷의 덱 비전이성** — 슛 결정을 **절대 xG 임계**로 자르는 구조라, 벤치마크 덱에서 맞춘 컷이 **다른 능력치의 실덱에는 이전되지 않는다**(약한 덱은 임계를 못 넘어 영원히 안 쏜다). 그래서 60시드 벤치는 골 5.32 인데 라이브는 0 이 나온다. *배포 세션의 라이브 실측이 독립적으로 같은 방향을 가리켰다 — "러너는 항상 `defaultEngineConfig` 라 config 차가 아니고 SelectData 계층"(v3.09 항목).*
- **되돌린 것**: `hmb-java` → `sha256:af3e0bcb247d…` · `hmb-runner` → `sha256:7f73d3154d1f…`(둘 다 `prev-live` 고정분). 러너 헬스 **`{"engineVersion":"engine@0.23.0"}`**. web = **v3.08 번들 `4782f54`** 재빌드·재배포. `version.json` = **`4782f54` / engine@0.23.0 / java `af3e0bcb…`**(3회 캐시버스트 확인).
- **DB 무접촉**: v3.09 가 마이그레이션 0건이었으므로 스키마 복원 불필요 — **Flyway v35 유지**. 배포 전 백업(`pre-deploy309-…`)은 **사용하지 않았다**.
- **executor 재기동 불필요 — 확인하고 넘어갔다**: `git diff 4782f54..8ac6245 -- packages/server/src/executor …` **빈 diff**(두 SHA 의 executor 코드가 동일). v3.09 의 `packages/server` 변경은 `runner/simulate.ts` 뿐이고 그건 **runner 컨테이너**가 갖는다(이미 롤백됨).
- **소요**: 이미지 전환 → java healthy **90초 내**(07:15:15 기동 완료).

### ⚠️ 유저 피해 1건 — 기록 (#241 역방향)
- **유저 `별희`**(`01KYK05K3JBW3VEQZJPX0B504B`) · **매치 `01KYVFJ8F390D16QFPDXRTBNB1`** · 전반 스코어 **5:0**(유저 우세) · `HALFTIME` 중 롤백에 걸림 → **`FAILED`**.
  `fail_reason` = `simulate failed (h2): … runner HTTP 400: {"error":"resumeState config version mismatch: resumeState=engine@0.28.0 runner=engine@0.23.0"}` — **예상한 그 에러 그대로**다(되돌리기도 방향만 반대인 #241).
- **왜 기다리지 않았나**: hero 지시대로 **≤5분 관찰**(07:09~07:14)했으나 그 사이 `FIRST_HALF`→`HALFTIME` 로만 진행했다(auto=0 이라 감독시간 3분 실사용). 완주까지는 감독시간+후반 ≈ **10분 더** 필요해 관찰 창을 넘겼고, 긴급 지시라 #217 회수 안전망 경로로 진행했다.
- **후속**: `FAILED` 는 종결 상태라 이 유저가 **새 매치를 만드는 데 막히지 않는다**(진행 중 0건 확인). **보상은 하지 않았다** — 지급은 hero 판단 영역이라 임의 집행하지 않았다. *5:0 으로 이기던 경기였다는 점만 남긴다.*

### 스모크(고정 계정 `deploy-smoke`, §0.55) — ✅ 정상 범위 복귀
- 신규 매치 **완주**(`01KYVGMPN321CSK6S1WA38DPDG`, 라이브 AI·오토모드 정상) → **1:0 WIN**.
- 하프 로그 `configVersion` **`engine@0.23.0`** · **슛 31**(전 17 / 후 14) · **골 1** · 파울 10 · 프리킥 12 · 태클 63 · 패스 916 · **`clearance` 0건**(0.23.0 엔 없는 타입 — 정상).
- **롤백 직전 0.28.0 값과 대조**: 슛 **6 → 31** · 골 **0 → 1**. **골·슛 축이 돌아왔다.**

### ⚠️⚠️ 다음 열차 규칙 — **main 에서 runner 를 재빌드하지 마라**
- 현재 **`main` 에는 엔진 `0.28.0`·`0.29.0` 이 머지돼 있다**(라이브는 `0.23.0`). 그래서 **main 을 그대로 빌드하면 방금 되돌린 엔진이 다시 올라간다.**
- **다음 웹/서버 열차는 `release/*` 계보로 조립한다** — `deploy-3.08`(`4782f54`)에서 갈라 **필요한 web/server 변경만 체리픽**하고, **`packages/engine` 은 얹지 않는다**. `runner` 이미지는 그 release 계보에서만 빌드한다.
- 엔진을 다시 올리는 건 **`shootXgThreshold` 덱 비전이성이 해소된 뒤 별도 엔진 열차**로 간다.
- *(v3.05 가 같은 이유로 이미 release 계보를 썼다 — "엔진 0.26.0 동반 변경이 섞여 있어 엔진 분리 원칙대로 제외". 그 규칙이 다시 유효해졌다.)*

---

## 2026-07-31T05:51Z — **배포 v3.09** (태그 `deploy-3.09`) — **엔진 열차**: engine@0.23.0 → **0.28.0**(#279 공물리 속도벡터·행동사슬·프리킥 벽·걷어내기) — ⚠️ **07:15Z 롤백됨(위 항목)**

- **git**: **`8ac6245`**(태그 `deploy-3.09`, `main`). 변경 = `packages/engine` 65 · `server-java/src` 3 · `packages/server` 2 · `packages/shared` 1 · docs/research 등. **`apps/web`·`packages/viewer-core` 접촉 0**.
- **모듈 버전**: engine **`@0.23.0` → `@0.28.0`** · server-java `0.1.0` · web `0.0.0` · servants `0.0.1`
- **이미지**: `hmb-java` `sha256:fd99b43cd0fc…`(**신규**) · `hmb-runner` `sha256:4cf27e6798b6…`(**신규**). 롤백 고정 = `hmb/server-java:prev-live`(`af3e0bcb…`) · `hmb/servants:prev-live`(`7f73d315…`).
- **DB**: **마이그레이션 0건** — Flyway **v35 유지**(`Schema "main" is up to date`). 백업은 그래도 떴다: `pre-deploy309-20260731T054710Z.db`(421,175,296 B · sha256 `8941c7d152bb8e7c989b344fe604b2281aa7aefbfde0d7e3df97bef47434c101` · integrity **ok** · users 189 · matches 61).
- **재빌드 범위**: `packages/engine`·`packages/server`·`packages/shared` 가 바뀌어 **runner 재빌드 + executor 재기동 필수**, java 는 계보 정렬차 동반 재빌드. web 은 소스 무변경이지만 `@hmb/shared`(신규 `clearance` enum)를 번들하므로 **재배포해 SHA 를 맞췄다**.

### ⚠️ #241 와이어 포맷 파괴 — **실측으로 창을 열고 들어갔다(절단 0건)**
- 배포 직전 조회: 진행 중 매치 **1건** — `01KYVAG6HS044A0S4N727XWRGA`(유저 **별희** `01KYK05K3JBW3VEQZJPX0B504B`, `SECOND_HALF`, engine@0.23.0), `phase_ends_at` **05:49:16Z** = 조회 시점 기준 **잔여 145초**.
- **즉시 배포하지 않고 기다렸다**(실유저 경기라 #217 ABANDONED 회수보다 완주가 낫다). **05:49:17Z `FINISHED` 0:4 WIN** 정착 확인 → 진행 중 매치 **0건**인 상태에서 컨테이너 교체(05:51Z). **절단된 매치 0건.**
- **영향 범위 확정 — 완료 매치 리플레이는 무영향**: 재생은 `resumeState` 가 아니라 **저장된 하프 로그**를 그대로 서빙한다. 구 엔진(0.23.0) 매치 `…ND5` 의 half1/half2 로그 **HTTP 200 · 3.98 MB · tickSnapshots·events 정상**(pass 365/344, shot 15/18). 즉 **#241 은 "하프 경계에 걸친 진행 중 매치"에만** 걸리고, 과거 전적·리플레이는 계속 열린다.

### 배포 중 정리한 선행 드리프트 2건 (이번에 발견 — 다음 세션이 또 밟지 않게 기록)
- **executor 가 4스택 난립**하고 있었다: `spider10`×2(**7/26 기동**) · `spider13`(v3.04 가 띄운 것) · `spider2`(**7/22 기동**). 넷 다 같은 잡 API 를 롱폴링 중 — §2 가 경고하는 `AI_CONCURRENCY` 경합의 온상이고, 셋은 **몇 세대 전 코드**였다. **PID 로만** 전부 종료(memory: `no-pattern-kill-in-fleet`) 후 **spider2(=배포 SHA 8ac6245) 단일 인스턴스**로 기동: worker `ts-executor-74661` · `claude-code`/`sonnet`/`concurrency=1`/`timeout=240s` · `ANTHROPIC_API_KEY` 미설정(**구독 정액제**) 확인.
- **이 체크아웃엔 배포용 `infra/.env` 가 없었다**(CF 키 2줄짜리 옛 파일만 있어 `docker compose build` 가 `SERVANT_TOKEN` 보간 실패로 **죽었다** — 빌드가 안 된 채 exit). 정본(`spider13`)을 복사하고 **live 컨테이너 토큰과 sha256 앞 16자리 일치**(`7aab0ab4c9230f02`)를 대조해 확인, 옛 파일은 `~/.local/state/hmb/` 로 백업. ⚠️ `.env` 의 `AI_EXECUTOR=stub`·`AI_CONCURRENCY=2` 는 **쓰지 않는 compose `executor` 서비스용**이다 — 모드 A 는 §2 대로 커맨드라인 env 가 이긴다.

### 결과: ✅ 배포 GREEN (기능·인프라) / ⚠️ **밸런스는 사전 고지분보다 크게 내려갔다**
- **엔진 0.28.0 라이브 확정**: 새 매치 하프 로그 `configVersion: **engine@0.28.0**`.
- **전 플로우 완주**(고정 계정 `deploy-smoke`, §0.55 — 랭킹 신규 오염 0): 매치생성 201 → 프롬프트 200 → 킥오프 202 → `GEN1`(**라이브 AI 실동작** — claude-code/sonnet job `9fd862b3`, in 2 / out 3047 / $0.36) → `FIRST_HALF` → **`HALFTIME` 미관측**(오토 모드 #249 무회귀) → `SECOND_HALF` → **`FINISHED`**. 2경기 모두 완주.
- **걷어내기(#314) ✅ 살아있다**: 매치1 **28건** · 매치2 **35건**(구 엔진 로그는 **0건**). `passOutcome` **미부착** 확인 = 패스 성공률 캘리브레이션 오염 없음(설계대로).
- **프리킥 벽(#307) ✅ 선다 — 단, 판정은 `차는 틱`에서 했다**: award 틱(=`free_kick` 이벤트 틱)에서 재면 taker 가 걸어가는 중이라 아직 아무도 자리를 안 잡는다(처음에 그렇게 재서 "벽 0명"으로 오판할 뻔했다). 공이 스팟을 떠나기 직전 틱으로 다시 재니 — **5개 프리킥 전부 `9.15m 침범 0건`**, 사거리 안(위협거리 30.4m·31.0m) 프리킥에서 **9.2~10.1m 지점에 횡오프셋 0.2~0.7m 로 정렬된 벽 1~2명**(= 스팟→골 회랑 위의 벽 라인). 사거리 밖(위협거리 57.6m·82.7m)은 **설계대로 벽 0~1명**.
- **팀원이 볼 받으러 간다(#314 B) ✅**: 패스 발사 시 **전방 러너 평균 1.63명**(표본 1069) · **패서가 차고 따라 들어감 26.2%**(구 동작은 패서를 그 틱에 **정지**시켜 <1% 였다). *수치 정의가 엔진 `behaviour-probe` 와 달라 그 계약값(4.28명·44.77%)과 직접 비교는 못 한다 — 여기선 "0 이 아니다·구동작과 질적으로 다르다"까지가 증빙이다.*
- **1대1(#357) ⛔ 미관측**: 2경기 **슛 12건 전부** `one_on_one` 라벨 0건. **실패 증거는 아니다**(라벨은 슛의 희소 부분집합이고, 이번 표본은 슛 자체가 너무 적었다). 소스에는 라벨 경로가 살아 있다(`decision.ts:132`). **슛 볼륨이 정상화된 뒤 재확인 대상.**
- **파울 감소 = 고지된 퇴보, 그대로 관측**: 매치1 **3건** · 매치2 **1건** (구 엔진 라이브 3경기 = 17·23·32건). #358 후속 대기.
- **web/뷰어 무회귀**: 라이브 사이트에서 `deploy-smoke` 로그인 → 홈 실데이터(5,600 G · 4승 3무 0패) → **0.28.0 매치 리플레이 실재생**(22 토큰 분리 렌더·공·패스 트레일·결과/통계/로그 3탭). **pageerror 0**. 유일한 4xx 는 `/api/chars/index` **404** = §0.7 이 정상이라고 박아둔 구운 폴백. **신규 `clearance` 타입이 web 을 깨뜨리지 않는다**(#325 는 폴백 표기 이슈로 유효).
- `version.json` = **`8ac6245` / engine@0.28.0**. ⚠️ 배포 직후 첫 조회는 **옛 SHA(`4782f54`)** 였다 — §0.8 의 CDN 캐시 그대로이고, `?cb=` 재조회 3연속 신규 SHA 로 확인.

### ⚠️⚠️ 라이브 밸런스 — **사전 고지(파울 퇴보)보다 범위가 넓다. 엔진 세션 확인 요망**
hero 승인 시 고지된 퇴보는 **파울 축 1건**이었는데, 라이브 실측은 **슛·골까지** 내려갔다. 같은 고정 계정·같은 봇 풀에서 잰 값이다:

| 지표(경기당) | 구 엔진 0.23.0 **라이브 3경기** | 신 엔진 0.28.0 **라이브 2경기** | 엔진 세션 60시드 벤치(0.28.0) |
|---|---|---|---|
| **골** | 1 · 2 · 1 | **0 · 0** | **5.32**(hero 목표 5.0) |
| **슛** | 33 · 22 · 27 | **6 · 6** | 12.93/팀 ≈ **26** |
| 파울 | 17 · 23 · 32 | 3 · 1 | (고지된 퇴보) |
| 태클 | 166 · 167 · 162 | 5 · 16 | — |
| 패스 | 709 · 834 · 705 | **1069 · 1108** | — |
| 걷어내기 | 0 | 28 · 35 | 16.35/팀 |

- **두 경기 연속 0:0**, 팀당 슛 3개. 관객 입장에선 "패스만 1100번 돌고 안 끝나는 경기"다.
- **config 차이가 아니다 — 확인했다**: 러너는 운영 계약상 **항상 `defaultEngineConfig`** 로 호출한다(`simulate.ts:289` 주석 + `runner-main.ts`). 즉 벤치와 라이브가 **같은 config** 를 쓴다. 그렇다면 남는 차이는 **SelectData/`TacticalInput` 계층**(실덱 능력치 + AI 생성 행동 파라미터)이고, 사슬 코어가 그 입력 아래에서 **리사이클을 EV 로 계속 인정**하는 쪽으로 쏠린 것으로 보인다(0.24.0 이 이미 백패스 11.0→24.2 로 예고한 축, "S4 국면별 가중치의 수리 대상"). **여기까지가 실측으로 말할 수 있는 범위** — 어느 파라미터인지까지는 특정하지 않았다.
- **공격적 프롬프트는 먹힌다**(채널 자체는 살아있다): 매치2 에 "과감하게 슈팅" 지시를 주자 전반 슛 4→6. 다만 경기 총합은 6 으로 같았다.
- **롤백은 하지 않았다** — hero 가 이 배포를 명시 승인했고 #358 후속이 진행 중이라, 되돌리기는 hero/main 판단 영역으로 남긴다. 필요하면 **즉시 가능**: `prev-live` 이미지 2개가 고정돼 있고 마이그레이션이 없어 DB 되돌림도 불필요하다(§8 복원 절차의 이미지 태그 2줄 + `deploy-pages.sh` 재배포면 끝).
- **미검증(정직 표기)**: 리그·원정 경로는 이번 스모크에서 돌리지 않았다(연습 매치만). 오토 킬스위치 실토글도 v3.06 과 같은 이유로 미검증.

---

## 2026-07-31T01:22Z — **배포 v3.08** (태그 `deploy-3.08`) — **웹 단독**: 데스크톱 후반지시·감독시간 입력 실종 픽스(#348)

- **git**: **`4782f54`**(태그 `deploy-3.08`) = `release/3.07` + #348 체리픽.
- **⚠️ 웹 단독 — 직접 재확인**: `0f813ab..4782f54` = **`apps/web` 7개뿐**(`StageShell.tsx/.module.css`·`stage-state.ts`+테스트·e2e 2·CLAUDE.md), `server-java`·`packages`·`data`·`infra` **접촉 0**, 마이그레이션 0 → 이미지 재빌드·마이그레이션·executor 재기동 **전부 생략**. 배포 후 **digest 무변경**(`af3e0bcb…`/`7f73d315…`)·**Flyway v35 유지**.
- **결과**: ✅ GREEN (전 뷰포트 JS 에러 0)
  - **전반 중 [후반 지시] — 4개 뷰포트 전부 정상**(고정 계정 `deploy-smoke` 실경기):

    | 뷰포트 | 탭 | textarea 위치 | 뷰포트 안 | 클릭·타이핑 |
    |---|---|---|---|---|
    | 1280×800 | ✓ | h 86 / vh 800 | ✓ | ✓ |
    | 1440×900 | ✓ | 680–772 / vh 900 | ✓ | ✓ |
    | 1920×1080 | ✓ | 843–935 / vh 1080 | ✓ | ✓ |
    | 390×844(모바일) | ✓ | 538–619 / vh 844 | ✓ | ✓ |
  - **감독시간 입력 — 3개 뷰포트 전부 정상**(같은 경기 하프타임): 1920×1080 `379–494` · 1280×800 `374–483` · 390×844 `636–738`, **전부 뷰포트 안 + 클릭→타이핑 성공**. 헤더 `deploy-smoke [내 팀] 1 : 0 레드 스톰 · 45' · 감독시간` 정상.
  - **판정 방식**: 좌표만 보지 않고 **실제 클릭→타이핑→값 회수**까지 했다(v3.01 에서 `elementFromPoint` 만 보고 "가림"으로 오판한 전례가 있어 그 방식은 쓰지 않는다).
  - `version.json` = **`4782f54`**.
- **비고**: 경기 스모크는 §0.55 대로 고정 계정 `deploy-smoke`(리더보드 신규 오염 0). 백엔드·DB 무접촉.

---

## 2026-07-31T00:50Z — [운영 조치] 경니시우스(P180) 2장 **선물 발송** — `축구왕여르` 발송 / `별별` **보류**(계정 없음)

- **지시**: hero — `별별`·`축구왕여르` 두 계정에 P180 ×2 를 메시지함으로 발송.
- **✅ 발송 완료 — `축구왕여르`**(`01KYJRPRMFNJA8YYBD22WN5ZNH`)
  - **캠페인 `01KYTTD1TSP0JBR5FWGFWD580E`** · `Idempotency-Key: gift-p180-x2-chukguwang-20260731`
  - 제목 `경니시우스 선물` · 본문 **"경니시우스 2장을 선물로 보내드립니다. 즐거운 경기 되세요!"**
  - 첨부 `players: [{playerId: "P180", count: 2}]`(points 0 · gems 0) · 만료 **2026-08-30**(30일)
  - 검증: `POST /api/admin/mails` **201**(targetCount 1) → `GET /api/admin/mails/{id}` 로 첨부·문안 확인 → `user_mails` 행 1건 생성(`claimed_at` **NULL**) · **`claimedCount: 0`** — **수령은 유저 몫이라 대신 누르지 않았다.**
  - P180 은 **활성 유닛**(`active: true`)임을 발송 전 확인.
- **✅ 발송 완료 — `별희`**(`01KYK05K3JBW3VEQZJPX0B504B`) — *지시의 `별별` 은 존재하지 않는 계정이었고, hero 가 **"별희한테 보내"** 로 확인해 줘 같은 조건으로 발송했다(2026-07-31T01:37Z).*
  - **캠페인 `01KYTX3W12BVK1JCQCY5Y4XB6W`** · `Idempotency-Key: gift-p180-x2-byeolhui-20260731`
  - 제목·본문·첨부·만료 모두 축구왕여르 건과 **동일**(`players: [{P180, count: 2}]` · 30일 → 2026-08-30)
  - 검증: **201**(targetCount 1) → 상세 조회로 첨부·문안 확인 → **수령 0 · 읽음 0**, `user_mails` **(미수령)** — **대신 누르지 않았다.**
- **⛔ (당시) 보류였던 이유 — `별별`: 그런 계정이 없다**
  - `GET /api/admin/users?q=별별` **0건**. `q=별` 로 전수 조회해도 **`별희`(`01KYK05K3JBW3VEQZJPX0B504B`, 가입 2026-07-27) 하나뿐**이다.
  - 오타로 `별희` 를 의도했을 가능성이 높지만 **추측으로 보내지 않았다** — 카드 지급은 **수령 전에만 회수(revoke)** 가 되므로, 대상을 잘못 지정하면 그 유저가 먼저 수령하는 순간 되돌릴 수 없다.
  - **→ 해소**: hero 가 `별희` 로 확인해 줘 위와 같이 발송했다.
- **📌 문안 수정 가능**: 발송한 본문은 나중에 바꿀 수 있다 — `PUT /api/admin/notices` 가 아니라 **메일은 캠페인 단위**이므로, 문안을 다듬고 싶으면 ①미수령 상태에서 `POST /api/admin/mails/{id}/revoke`(미수령분만 회수) 후 새 문안으로 재발송하거나 ②그대로 두고 다음 발송부터 반영하는 두 갈래다. **이미 수령한 유저의 메일 본문은 바꾸지 않는다**(원장 성격).
- 코드·이미지·DB 스키마 변경 **0**(어드민 API 호출만). 라이브는 `0f813ab`(v3.07) 그대로.

---

## 2026-07-31T00:36Z — **배포 v3.07** (태그 `deploy-3.07`) — **웹 단독**: 운영 화면 유저 목록 공백 픽스(#342)

- **git**: **`0f813ab`**(태그 `deploy-3.07`) = `release/3.06` + #342 체리픽.
- **⚠️ 웹 단독 — 직접 재확인**: `8070f95..0f813ab` = **`apps/web` 7개뿐**(`AdminPage.tsx`·`admin-hooks.ts`·`api/p3.ts`·테스트 3·CLAUDE.md), `server-java`·`packages`·`data`·`infra` **접촉 0**, 마이그레이션 0 → 이미지 재빌드·마이그레이션·executor 재기동 **전부 생략**. 배포 후 **digest 무변경**(`hmb-java af3e0bcb…` · `hmb-runner 7f73d315…`) 확인.
- **결과**: ✅ GREEN (JS 에러 0)
  - **#342 유저 목록 — 라이브에서 실데이터로 표시**: `hmbadmin` 으로 로그인 → `/admin` → **`GET /api/admin/users` 200** 이고 표가 **채워졌다**(닉네임/provider/골드/가입일 — `w5chk9179`·`mail16356`·`deploy-smoke`(4,200 G)·`nodeck*`·`d301r14625` … 실계정). 탭도 전부 렌더(유저 운영·유닛 카탈로그·스타터 지급·공지·유닛 아트·우편). **"항상 비어 있던" 화면이 해소됐다.**
  - **상세**: 유저 행 클릭 → **`GET /api/admin/users/{id}` 200**.
  - **지급 폼**: 필드 3개 확인 — `닉네임 또는 유저 ID`(검색) · `예: 500 또는 -300`(금액) · `예: 충전 요청 수동 처리`(사유). **지시대로 폼까지만 보고 제출은 하지 않았다**(프로덕션 지갑 무변경).
  - `version.json` = **`0f813ab`**.
- **📌 `p342-admin-live.capture.ts` 는 그대로 돌리지 않았다**: 그 스크립트는 **격리 스택**(포트 18993 · 별도 DB · 전용 admin `adm/adm-pw-1234`)을 전제로 한 개발 하네스다. 배포 스모크에서는 그보다 강한 검증 — **실제 배포 번들 + 라이브 백엔드 + 실제 운영자 계정**으로 같은 경로(목록·상세·폼)를 직접 확인했다. 스크립트가 지적한 핵심("이 결함 계열은 목으로 못 막는다, 실서버로 한 번은 봐야 한다")은 이 방식으로 충족된다.
- **비고**: 웹 단독이라 백엔드·DB 무접촉(Flyway **v35** 유지). 목록에 보이는 `w5chk*`·`nodeck*`·`mail*` 등은 이전 배포들의 **가입 확인용** 스모크 계정이다(경기 미완주라 랭킹에는 안 실린다 — §0.55).

---

## 2026-07-31T00:06Z — **배포 v3.06** (태그 `deploy-3.06`) — 오토 모드: 감독시간 스킵·킬스위치(#249, V35)

- **git**: **`8070f95`**(태그 `deploy-3.06`) = `release/3.05` + 오토모드 체리픽. 변경 = `apps` 16 · `server-java` 10 · docs 2. **`packages`·`data` 접촉 0** → runner 재빌드·executor 재기동 생략(엔진·shared 무접촉 검증됨).
- **이미지**: `hmb-java` `sha256:af3e0bcb247d…`(**신규**) · `hmb-runner` `sha256:7f73d3154d1f…`(무변경)
- **DB**: Flyway **v34 → v35**, 1건 — `V35__match_auto_mode`. **§0.5-2/7 성격 확인**: `.conf` 없음(트랜잭션 내) · **파괴적 구문 0** · 내용은 **`matches ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0` 한 줄 = 순수 additive**. 백업 `pre-deploy306-20260731T000554Z.db`(421,175,296 B · sha256 `a8ce0ab0401a5b03552082ef8486f3a07418ae24e1862ce36e386c310a4f85bd` · integrity ok). 적용 후 컬럼 생성 · **matches 44행 보존** · integrity ok.
- **결과**: ✅ GREEN
  - **① 오토 ON → 감독시간 스킵(핵심)** — 고정 계정 `deploy-smoke`: `POST /api/matches/{id}/auto {auto:true}` **200**(DB `auto_mode=1`) → 킥오프 → **전반 종료 예정 `00:16:37`, 20초 간격 폴링에서 `00:16:45` 관측이 이미 `SECOND_HALF`**. **`HALFTIME` 이 한 번도 잡히지 않았다** — 오토가 아니면 감독시간이 180초라 최소 8~9회는 잡혔을 구간이다.
  - **② 중간 해제 → 정상 감독시간(대조군)** — 같은 계정으로 오토 ON 킥오프 후 **전반 진행 중 `{auto:false}` 200**(DB `auto_mode=0`) → **전반 종료 `00:30:39` 시 `HALFTIME` 진입**(감독시간 3분, ends `00:33:39`). ①과 **같은 경계에서 정반대 결과** — 기능이 대조로 증명됐다.
  - **③ 계약 방어**: `auto` 필드를 빼고 호출하면 **400**(openapi `required: [auto]` — "조용히 OFF" 가 아니다).
  - **무회귀**: `/api/away/revenge` 200 · `/api/mails` 200 · `/api/rankings` 200.
  - `version.json` = **`8070f95`**.
- **📌 킬스위치는 계약 확인까지만**: `hmb.match.auto.enabled` 는 라이브에서 **미설정 = yml 기본 `true`**. `false` 로 내리면 *"전반 종료 경계가 `matches.auto_mode` 를 보지 않는다(이미 켠 매치도 정상 감독시간 복귀). **토글 API 는 계속 200** 이라 스위치를 내려도 클라에 에러가 뜨지 않는다"* 가 설계다(application.yml 주석). **실토글 검증은 하지 않았다** — 확인하려면 java 재시작 2회 + 전반 7분을 태우면서 **라이브 게임 규칙을 잠시 바꿔야** 해서, 스모크 목적으로는 비용·리스크가 맞지 않다고 판단했다. 필요하면 조용한 시간대에 별도로 돌린다.
- **비고**: `deploy-smoke` 가 이제 랭킹 **6위(eligible)** 로 올라왔다 — §0.55 가 예고한 "고정 계정 자신은 1줄 남는다" 그대로이고, **이번 배포로 새로 쌓인 스모크 계정은 0**이다.

---

## 2026-07-30T23:47Z — **배포 v3.05** (태그 `deploy-3.05`) — **웹 단독**: 감독시간 실패 안내 가림·벤치 지시 열람(#294) + 복수 무제한 잠김 픽스(#332)

- **git**: **`a837fe0`**(태그 `deploy-3.05`) = **`deploy-3.04` + 웹 픽스 2건 체리픽**(`release/3.05`). **main HEAD 는 쓰지 않았다** — 엔진 `0.26.0` 동반 변경이 섞여 있어 엔진 분리 원칙대로 이번 열차에서 제외(hero 지시).
- **⚠️ 웹 단독 — 직접 재확인**: `0d0b7a5..a837fe0` 변경은 **`apps/web` 9개뿐**(`RevengeQueue.tsx`·`revenge-logic.ts`·`HalftimePanel.tsx/.module.css`·e2e 3·CLAUDE.md), `server-java`·`packages`·`data`·`infra` **접촉 0**, 마이그레이션 0. → **이미지 재빌드·마이그레이션·executor 재기동 전부 생략**. 배포 후 **이미지 digest 무변경**(`hmb-java 5e81a4be…` · `hmb-runner 7f73d315…`) · **Flyway v34 유지** 확인.
- **결과**: ✅ GREEN (JS 에러 0)
  - **#332 무제한(-1) 잠김 픽스 — 배포된 번들로 검증(프로덕션 설정 무접촉)**: 라이브 config 는 `daily-limit: 10` 이라 `-1` 경로가 실제로 나오지 않는다. 그래서 **배포된 번들 그대로 두고 `/api/away/revenge` 응답만 목킹**해 `remainingToday: -1` + AVAILABLE 항목 1건을 주입했다 → **[복수하러 가기] 버튼 `disabled: false`**(눌린다) · **"-1회 남음" 같은 음수 표기 없음** · JS 에러 0. 픽스 전이라면 `-1 ≤ 0` 으로 읽혀 전량 잠기고 표시도 깨지던 자리다.
  - **#294 벤치 지시 열람 — 실화면 확인(모바일 390×844)**: 감독시간에 **`벤치 4명에게도 지시`** 토글이 있고 **기본 접힘**(`aria-expanded=false`), 누르면 `true` 로 펴지며 벤치 목록·`벤치 접기` 노출. 기본 접힘 이유(#276 AC7 세로 예산 보호)까지 코드 주석에 실측 근거가 있다.
  - **무회귀**: 감독시간 헤더 `deploy-smoke [내 팀] 2 : 0 블루 월 · 45' · 감독시간 2:31`, 탭(감독/경기장면/통계/로그)·포메이션·교체 0/3 정상.
  - `version.json` = **`a837fe0`**.
- **📌 미검증 1건(정직 표기)**: **감독시간 "실패 안내"(#294 MAJOR)** 는 **후반 시작 실패 상황을 인위적으로 만들 수 없어 실화면에서 보지 못했다**. 픽스 내용은 코드로 확인했다 — 안내를 스크롤 영역 끝이 아니라 **CTA 와 같은 층(`.ctaAlert`, `flex: none`)** 으로 옮겨 스크롤 위치와 무관하게 보이게 한 것이고(주석의 실측: bottom 875.8 > 뷰포트 844 로 CTA 뒤에 숨었다), 계약은 `e2e/p294-halftime-failure.spec.ts` 가 갖는다.
- **비고**: 경기 스모크는 §0.55 대로 **고정 계정 `deploy-smoke`** 로 돌렸다(리더보드 신규 오염 0). ⚠️ **문서 커밋은 main 계보에 올린다** — `release/3.05` 는 `deploy-3.04` 에서 갈라져 v3.04 기록 커밋이 없어서, 그 위에 append 하면 직전 항목이 사라진다(이번에 실제로 no-op 이 나서 알아챘다).

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
