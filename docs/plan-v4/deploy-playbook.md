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

**등록분 — 열차 없음.** (직전 = `v3.18` 릴리스 열차(풀스택) → **소진**: 2026-08-03 발차.
라이브 engine@**0.42.0** · **Flyway v40** · web `ec503c1`. V38~V40 리허설·economy override 재작성·
스킵 실측은 `deploy-log` v3.18 항목에 남겼다.)

📌 **economy override 는 계속 켜져 있다**(`source: OVERRIDE`, 조정 = `initialGems 12000` 하나).
economy 발행물을 건드리는 다음 배포도 **§0.6 2-B 재작성**이 필요하다 — 이건 소진되지 않는 상시 조건이다.

### 🔓 web 배포 동결 — **해제됨** (2026-08-02, hero 확정)

`#389` 권씨 동결(2026-08-01 등록)은 **`v3.16` 으로 소진**했다. hero 확정 = **"배포하고 비활성 유지"**
(권씨 AC). 지금은 **web 배포에 걸린 제약이 없다** — 이후 web 열차의 기준선이다.

📌 **다음에 미오픈 캐릭터가 또 생기면 다시 등록해야 한다.** 그때 쓸 사실은 이것이다(v3.16 에서 실측):
DB `active=0` 은 유출을 **막지 못한다**. 아트·이름·`playerId` 매핑은 `dist/chars/` 정적 파일이고
`char-assets-store.ts` 가 **앱 부팅 때 `units/manifest.json` 을 무조건 fetch** 하므로, 배포 즉시
**접속하는 모든 브라우저가 받는다**(URL 을 아는 사람만 보는 게 아니다). 판단은 hero 몫이지만
**소명은 이 사실로 한다** — 빌드만 해서(`npm run build -w @hmb/web`) `dist/chars` 를 열어 보면 5초에 확인된다.

### 📌 인계 — 러너 롤백 시 먼저 읽을 것 (#396, main 등록 2026-08-01)

**#396 러너를 롤백하면 오버레이가 무음으로 사라진다**(#383 파생) = `#383` 머지 후 **유일한
관측 불가 위험**. 다음에 **러너 롤백 상황이 오면 조치 전에 이 이슈를 먼저 읽는다.**
(무음 = `status.sh`·헬스체크로는 안 잡힌다는 뜻이다 — 평소 게이트로 걸리길 기대하지 마라.)

<details><summary>소진된 등록분 — 엔진 열차 engine@0.33.0→0.34.0 (v3.14 로 배포됨)</summary>

**등록분 — 엔진 열차 `engine@0.33.0` (hero 확정, 중간 발차 / 조립 GO 는 main 이 머지 SHA 와 함께 준다)**

> ⚠️ 이 열차는 **v3.02 이후 처음으로 `release/*` 계보가 아니라 `main` 직행**이다(엔진 배포 승인 =
> runner 재빌드 허용). 그래서 **main 에 쌓인 웹·서버 변경이 전부 동승한다** — "엔진만 올린다"가 아니다.

**동승분 — 라이브에 처음 올라가는 것(2026-08-01 기준 실측)**
- **엔진 `0.23.0 → 0.33.0`**: 0.26(공 물리 속도벡터·행동 계층) · 0.28(사슬 코어 — **v3.09 로 나갔다 롤백된 그 버전**) ·
  0.29(**파울 복구** 2.15→11.55) · 0.30(#365) · 0.33(engwave 안전값+골든+T1).
- **#365 경기 단축**(`19094b9`) — **하프 3분 · 1.2x · 0-90 표기**. 유저가 체감하는 변화가 엔진 수치보다 크다.
- **#365 후속 재생 방식**(`7e3a134`) — 하프 창 = 매치별 실제 재생 길이(`playbackMs` additive) · **고정 배속**.
  *v3.12 로 단독 발차하려다 **HOLD** 한 그 변경이다*(그때 이유 = `half-real-ms` 가 **engine@0.30.0 실측**으로
  캘리브레이션돼 0.23.0 과 안 맞았다). 엔진이 같이 올라가는 지금은 그 전제가 해소된다 — **이 열차에서만 옳다.**
- 이미 라이브인 것(체리픽으로 먼저 나감, SHA 만 다르다): #354/#355(v3.13) · #368(v3.11) · #367(v3.10) · #348(v3.08) · #342(v3.07).

**마이그레이션 — 현재 0건. 단 GO 시 재스캔이 계약이다.**
```bash
git diff --name-only <라이브SHA>..<머지SHA> -- server-java/src/main/resources/db/migration/
```
2026-08-01 스캔 = **0건**(리포 최신 `V36__league_daily_reward`, 라이브 DB 도 **v36**). engwave 머지가
새 마이그레이션을 들고 올 수 있으므로 **발차 직전 한 번 더** 돌리고, 나오면 §0.5-2/7 성격 판정 + §8 리허설.

**⚠️ #241 — 발차 직전 "진행 중 매치 0" 확인 (이 열차의 필수 관문)**
버전 범프라 진행 중 매치의 `resumeState` 가 거부된다(v3.09 실측: `resumeState config version mismatch`).
`hmb-java` 컨테이너엔 `sqlite3` 가 없으므로 **볼륨을 read-only 로 붙여** 조회한다:
```bash
docker run --rm -v hmb-p3-db:/data:ro alpine:3.20 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 -header 'file:/data/hmb.db?mode=ro' \
   \"SELECT id,user_id,state,engine_version,phase_ends_at FROM matches \
     WHERE state NOT IN ('FINISHED','FAILED','ABANDONED')\""
```
- **0건이면 즉시 발차.**
- **있으면**: `phase_ends_at` 으로 잔여를 계산한다. **`FIRST_HALF` 면 완주까지 감독시간+후반이 남아 ≈10분 이상**이다
  (v3.13 때 5분 관찰로는 못 끝났다). 짧으면 기다리고, 길거나 급하면 **hero 확인 후** 진행한다.
- 강행하면 그 매치는 `FAILED` 가 된다(#217 이 회수 안전망 — 종결 상태라 새 매치 생성은 안 막힌다).
  **유저 id·매치 id·그 시점 스코어를 반드시 기록**한다(보상 판단 근거).
- 📌 **완료된 매치의 리플레이는 무영향**이다 — 재생은 `resumeState` 가 아니라 **저장된 하프 로그**를 서빙한다(v3.09 확인).

**보상 프로토콜 (상비 — 별희 선례 2026-07-31)**
피해가 나면 지급은 **hero/main 판단**이다. 임의 집행하지 않고, 지시가 오면 이 형태로 보낸다:
```bash
curl -s -X POST "$BACKEND/api/admin/mails" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: <유일키>' \
  -d '{"audience":"USERS","userIds":["<userId>"],"title":"경기 중단 보상",
       "body":"...","attachments":{"points":0,"gems":300,"players":[]},
       "expiresInDays":30,"reason":"<사유 — 감사 원장에 남는다>"}'
```
- `gems`=Z(유상) · `points`=G(무료). **201=발송 / 200=같은 멱등키 재전송(추가 발송 0) / 409=같은 키+다른 내용.**
- 발송 후 `GET /api/admin/mails/{id}` 로 첨부·문안 대조 + **`claimedCount: 0` 확인**. **수령은 유저 몫 — 대신 누르지 않는다.**
- 문안·금액 정정은 **수령 전에만** 가능(`/revoke` 후 재발송). ⚠️ 재발송 땐 **멱등키를 새 값으로** — 안 그러면 409 로 조용히 무효가 된다.

**빌드 범위** — runner **재빌드 필수**(엔진), java 재빌드, **web 도 main 에서 재빌드**(viewer-core·shared 동승).
executor 도 `packages/server` 변경이라 **재기동**하고, **release 워크트리가 아니라 main 체크아웃**에서 띄운다
(⚠️ `node_modules` 를 다른 체크아웃에서 심링크하지 마라 — `@hmb/*` 가 남의 트리를 가리킨다, v3.10 실책).

**스모크(이 열차 전용으로 봐야 할 것)** — 엔진 수치만 보지 말 것:
- **하프가 실제로 3분인가** · 재생이 **끊기거나 침묵 없이** 하프 창과 맞는가 · **되감기 없는가**(7e3a134 의 목적).
- 시계 **0-90 표기** · 파울/PK/카드가 **돌아왔는가**(0.29 복구분) · 골·슛이 밴드 안인가.
- 무회귀: 리그 일일보상(V36) · 오토모드 · 메시지함.

**롤백 주의** — 되돌리기도 **방향만 반대인 #241** 이다(0.33.0 → 0.23.0 도 진행 중 매치를 끊는다).
`prev-live` 이미지 2개를 발차 전에 고정하고, 되돌릴 때도 **진행 중 매치 0 을 먼저 확인**한다.

*(직전 등록분 = #309 운영 컨텐츠 무배포화(V30~V32) — **소진**: 라이브 Flyway **v36**, `notice_assets`·`char_bundles` 존재 확인. 그 앞 = `V25`·`V21` = `deploy-2` 에서 소진.)*

</details>

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
- ⚠️ **덮어쓰기는 브랜치 계보 말고 `Edit` 자체로도 난다**(v3.09 에서 실제로 냈다). 새 항목을 넣으려고 `old_string` 에 **직전 항목의 `## 제목` 줄까지 물리고** `new_string` 에 그 줄을 **되돌려 놓지 않으면**, 본문은 남고 제목만 증발해 직전 배포가 내 항목에 흡수된다(파일은 멀쩡해 보인다). 앵커는 `---` 위쪽에서 끊고, **커밋 전에 반드시 두 줄로 검산**하라:
  `grep -c "배포 v<직전>" docs/deploy-log.md` → **1** · `git diff --numstat docs/deploy-log.md` → **삭제 0**(순수 추가여야 한다).

### ⚠️ **이미지를 새로 빌드했으면 태그 전환 전에 컨테이너 스모크를 한다** (#385, v3.14 실패에서 승격)

로컬 게이트는 **워크스페이스 심볼릭링크** 위에서 돈다. 이미지는 `Dockerfile` 이 **명시적으로 COPY 한 것만** 들고 간다.
그래서 **러너가 새 워크스페이스를 import 하기 시작한 날**, vitest·typecheck·러너 로컬 기동이 전부 green 인데
컨테이너만 죽는다 — v3.14 1차 발차가 정확히 그렇게 죽었다(`ERR_MODULE_NOT_FOUND: @hmb/viewer-core`, 재기동 8회).
**라이브 스택을 건드리기 전에** 버려도 되는 컨테이너로 확인하면 이 부류가 전부 걸린다:

```bash
docker build -f packages/server/Dockerfile -t hmb/servants:trial .          # 리포 루트
docker run -d --name runner-smoke --user node -e RUNNER_PORT=8790 \
  -p 18795:8790 hmb/servants:trial npm run runner --workspace=@hmb/server
docker logs runner-smoke | tail -5          # ① 모듈 로드 — 여기서 ERR_MODULE_NOT_FOUND 가 잡힌다
curl -s localhost:18795/health              # ② {"engineVersion":"engine@x.y.z"}
# ③ 실제 왕복 — import 만 통과하고 호출부에서 죽는 경우가 있다. 엔진 픽스처로 한 판 태운다.
docker exec runner-smoke node -e '
import("tsx/esm/api").then(async (api)=>{ api.register();
  const e = await import("/app/packages/engine/src/index.ts");
  const r = await fetch("http://localhost:8790/simulate",{method:"POST",
    headers:{"content-type":"application/json"},
    body: JSON.stringify({seed:e.demoSeed, selectData:e.demoSelect, homeInput:e.demoHome, awayInput:e.demoAway, half:1})});
  const j = await r.json();
  console.log(r.status, j.matchLog?.tickSnapshots?.length, j.playbackMs, j.lastHash); });'
docker rm -f runner-smoke
```

③ 이 핵심이다 — v3.14 의 결손 심볼(`autoPaceDurationMs`)은 `playbackMs` 를 만드는 함수라, **`playbackMs` 가
숫자로 나왔다는 것 자체가 그 호출부까지 실행됐다는 증거**다. `/health` 만 보면 못 잡는 결손이 있다.

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

**⚠️ 리포를 고쳤다고 워치독이 고쳐진 게 아니다.** 워치독이 실제로 도는 건 리포가 아니라 **설치 사본**
(`~/.local/bin/hmb-tunnel-heal.sh`)이다. 실제로 `grep -a` 픽스가 플레이북엔 "닫았다"고 적혀 있는데
**프로덕션 사본엔 없던 적이 있다**(2026-07-31 발견). 고쳤으면 **반드시 재설치하고 설치본을 확인**하라:
```bash
bash infra/install-tunnel-heal.sh
diff <(tail -n +4 ~/.local/bin/hmb-tunnel-heal.sh) <(tail -n +2 infra/tunnel-heal.sh) && echo 동기화됨
```

### 치유 상한 — 회선이 불안정한 날 잠깐 올리기 (`heal.conf`)
1시간에 `HMB_HEAL_MAX_PER_HOUR`(**기본 3**)번을 넘겨 치유하면 `DEGRADED` 로 백오프한다 — 무한 재기동
방지 장치다. 그런데 회선이 계속 끊기는 날엔 상한이 금방 소진되고, 그때부터는 **터널이 죽어도 아무도
안 고친다**. launchd plist 는 `PATH`·`HOME` 만 넘겨서 **env 로는 런타임 조정이 안 되므로**, 워치독이
매 틱 읽는 노브 파일을 둔다:
```bash
printf 'HMB_HEAL_MAX_PER_HOUR=6\n' > ~/.local/state/hmb/heal.conf   # 일시 상향(재설치·재기동 불필요)
rm ~/.local/state/hmb/heal.conf                                     # 회선 안정되면 원복
```
- 구 이름 `HMB_MAX_HEALS_PER_HOUR` 도 계속 받는다(새 이름 우선). **올려두고 잊지 마라** — 상한은
  "터널이 반복해서 죽는다"를 사람에게 알리는 신호이기도 하다.

### DEGRADED 는 `status.sh` 첫 줄에 뜬다
백오프 진입 시 마커(`~/.local/state/hmb/DEGRADED`)가 생기고 **`bash infra/status.sh` 맨 위에 굵게** 뜬다
(치유가 성공하거나 터널이 정상으로 돌아오면 자동으로 지워진다). 예전엔 이 상태가 로그 안에만 있어서
**복구가 멈춰 있는 동안에도 화면은 ✓ 만 보여줬다** — 그래서 첫 줄로 올렸다. 별도 알림 시스템은 두지
않는다(패트롤 크론이 커버).

| 이벤트 | 뜻 | 사람이 할 일 |
|---|---|---|
| `HEAL_OK` | 터널 죽음 → 재기동 → **web 이 새 주소를 서빙하는 것까지 확인** | 없음 |
| `PUBLISH_ONLY` | 터널은 멀쩡한데 web 만 옛 주소 → config 만 재전파(검증됨) | 없음 |
| `PUBLISH_RETRY_OK` | 1차 전파는 실패했지만 **재시도로 성공** | 없음(회선이 느렸다는 신호) |
| `PUBLISH_UNVERIFIED` | 전파를 돌렸는데 **web 이 아직 새 주소를 안 준다**(시도별) | 자동 재시도 중 — 반복되면 `.publish` 로그 |
| `HEAL_UNPROPAGATED` | 터널은 살아났는데 **전파를 끝내 못 했다** | `bash infra/publish-backend-url.sh <새URL>` 수동 폴백 |
| `BACKEND_DOWN` | 로컬 java 가 죽어 터널 재기동을 **보류** | `cd infra && docker compose up -d java runner` |
| `DEGRADED` | 1시간에 3번 넘게 치유 시도 → 백오프 | 반복 사망 원인 확인(로그·네트워크) |
| `HEAL_FAIL` | 재기동 자체가 실패(새 URL 획득·DNS 확인 실패) | `~/.local/state/hmb/tunnel-heal.log.publish` 확인 |

> ⚠️ **`HEAL_OK` 의 뜻이 2026-08-01 에 바뀌었다(강해졌다)**: 예전엔 "publish 명령이 0 을 돌려줬다"였고,
> 지금은 **"워치독이 `config.json` 을 직접 다시 읽어 새 주소를 확인했다"** 이다. 즉 **HEAL_OK = 테스터가
> 접속된다**. 전파를 못 하면 성공으로 안 찍고 `HEAL_UNPROPAGATED` 로 남긴다 — 그래야 쿨다운이 시작되지
> 않아 다음 틱이 곧바로 재전파한다(거짓 HEAL_OK 는 **교정까지 180초 막아** 장애를 스스로 연장했다).

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
  - "반쪽 치유"(프로세스는 살아났는데 URL 미전파) 갭 — **갭 1·2 는 닫혔다**:
    - 갭 1(로그가 바이너리로 판정돼 URL 캡처가 깨짐) = `grep -a` 로 닫음.
    - **갭 2(전파 결과 재확인 없음) = 2026-08-01 닫음.** 워치독이 publish 의 종료코드를 믿지 않고
      **`config.json` 을 직접 다시 읽어** 새 주소를 확인할 때만 `HEAL_OK` 를 찍는다. 못 하면
      백오프 재시도(`HMB_PUBLISH_TRIES` 기본 3, 15s→30s→…) 후 `HEAL_UNPROPAGATED`.
    - 갭 3(치유 직후 새 URL **생존** 재검증)은 **아직 열려 있다** — 새 URL 이 뜬 직후 다시 죽는 경우는
      다음 틱의 `UNHEALTHY`→치유로 흡수된다(즉시 감지는 아니다).
  - **⚠️ 갭 1·2 는 "치유가 끝까지 간다"는 전제 위의 것이었다 — 그 전제가 2026-08-01 에 깨졌다(#391).**
    치유가 **시작만 하고 매달리면** 위의 모든 검증은 도달조차 못 한다. 3겹으로 막았다(§3.5 참조).

## named tunnel 승격 견적 (hero 리뷰 안건 — 2026-08-03 요청)

### 왜 다시 올리나 — 12시간에 터널 사고 3회

| 시각(UTC) | 증상 | 실제 원인 |
|---|---|---|
| 08-03 11:22~11:31 | 유저 API 단절 9분 | 전파 갭(터널은 살아 있었다) + 로컬 DNS 전멸 |
| 08-03 14:28~14:37 | URL 회전 | 530 → 치유(RUN_TIMEOUT 후 재시도로 성공) |
| 08-03 16:00~16:06 | 간헐 530 | **터널 플래핑** — 같은 URL이 `/internal/health` 401 인데 `/api/config` 530 을 섞어 낸다 |

오늘만 **530 계열 이벤트 7건**(UNHEALTHY 4 + BLIP 3). 워치독을 아무리 고쳐도 **회전 자체가 잦으면
유저는 그때마다 끊긴다** — 회전 1회 = 새 URL + web 재배포 = 60~90초 단절이고, 그게 하루 4번이다.

### quick tunnel 의 구조적 한계 (이번에 실측으로 확인)

1. **URL 이 매번 바뀐다** → web `config.json` 재배포가 매 회전마다 필요 = 그 자체가 단절 구간.
2. **플래핑을 헬스체크로 못 잡는다** — 16:00 실측: `/internal/health` 는 **15/15 401**(정상)인데
   같은 순간 `/api/config` 는 **530**. 워치독은 전자만 60초에 한 번 본다 ⇒ **구조적 사각**.
   경로를 늘려도 "어떤 요청은 되고 어떤 요청은 안 되는" 상태 자체는 남는다.
3. SLA 없음. `retry-after: 120` 을 CF 가 그냥 내려보낸다.

### named tunnel 로 바뀌는 것

| | quick | named |
|---|---|---|
| URL | 매 재기동마다 랜덤 | **고정**(내 도메인 서브도메인) |
| web 재배포 | 회전마다 필요 | **불필요** — `config.json` 을 한 번 굽고 끝 |
| 워치독 역할 | URL 캡처·전파·검증(=복잡도의 전부) | **프로세스 살아있나만** — publish/전파 경로가 통째로 사라진다 |
| 인증 | 없음(익명) | 계정 귀속 토큰(자격 유출 관리 필요) |
| 재기동 내성 | URL 바뀜 | 같은 이름으로 복귀 |

⇒ **#381·#391 이 붙잡고 있던 문제(전파 검증·반쪽 치유·URL 오인)가 대부분 소멸한다.** 그게 가장 큰 값이다.

### 요건 — 도메인이 유일한 장벽

1. **도메인 1개**(필수, 지금 없다). 신규 등록 시 `.com` 기준 **연 15,000~20,000원**대.
   CF Registrar 원가 등록 가능. **이미 보유한 도메인이 있으면 비용 0.**
2. 그 도메인의 **네임서버를 Cloudflare 로 이전**(무료 플랜으로 충분). 전파 최대 24h — **hero 계정 작업**.
3. `cloudflared tunnel login` → 인증서(`cert.pem`) — **브라우저 로그인이라 hero 가 직접** 해야 한다.
4. 이후는 내가 한다: `tunnel create hmb` · `tunnel route dns hmb api.<도메인>` ·
   `config.yml`(credentials + ingress) · launchd 등록 · web `VITE_API_BASE`/`config.json` 을 고정 주소로 재배포.

### 작업량·리스크

- **내 작업 2~3시간**(스크립트 개편 + 워치독 단순화 + 문서). **무중단** — 새 터널을 띄워 검증한 뒤
  `config.json` 만 한 번 갈아끼우면 되고, 실패 시 quick tunnel 로 즉시 복귀(현행 경로 유지).
- **hero 작업**: 도메인 확보 + NS 이전 + `tunnel login` 1회. 이게 전체 일정의 대부분(NS 전파 대기).
- **리스크**: 낮다. 되돌리기 = `config.json` 을 quick URL 로 재배포(1분).
- ⚠️ 과거 중단 사유(§6)는 **CF API 토큰 발급이 3회 연속 만료**된 것이었다 — 그건 Pages 배포 토큰 축이고
  named tunnel 은 `cloudflared login` 의 **cert.pem** 을 쓰는 별개 경로다. 같은 벽에 다시 부딪히지 않는다.

### 대안(도메인을 안 사는 경우)

- **ngrok 유료**($8~/월): 고정 도메인 제공, 도메인 불필요. 단 **과거 실측에서 앱 로드 동시요청에 약했다**
  (무료 기준 0/8 vs CF 8/8) — 유료가 그 축을 해결하는지는 **재측정이 필요하고, 검증 안 된 가정이다.**
- **현행 유지 + 워치독 보강**: 오늘 실측대로 **플래핑은 헬스체크로 못 잡는다**. 근본 해결이 아니다.

**권장: 도메인 확보 후 named tunnel.** 이미 보유 도메인이 있으면 비용 0, 없어도 연 2만원 미만이고,
그 대가로 오늘 같은 사고 유형이 **구조적으로** 사라진다.

### 2026-07-31 실장애에서 배운 것 (이 갭이 실유저 영향으로 나타난 날)
- **증상**: 배포 중 터널이 두 번 죽었고, 워치독이 `HEAL_OK` 를 찍었는데 `config.json` 은 **죽은 URL 그대로**여서
  **테스터가 로그인 자체를 못 했다**(530). 두 번 다 사람이 `publish-backend-url.sh` 를 쳐서 복구했다.
- **원인 ①**: `wrangler pages deploy` 가 느린 회선에서 상한에 걸려 **SIGKILL** 됐는데, 스크립트가 `rc=124`(timeout)
  만 안내하고 **`rc=137`(kill) 은 조용히 넘겨** 로그에 `Killed: 9` 한 줄만 남았다 → "왜 전파가 안 됐는지"가 안 보였다.
  ⇒ 137 도 같이 안내하고, 상한을 **150s → 240s** 로 올렸다(`HMB_DEPLOY_TIMEOUT`).
- **원인 ②**: 치유 경로가 **"Pages 가 그 주소를 실제로 서빙하는가"를 스스로 확인하지 않았다.** 게다가 재전파
  쿨다운이 `HEAL_OK` 시각 기준이라 **거짓 HEAL_OK 가 교정을 180초 동안 막았다**(장애 자가 연장).
- **판별 요령(장애냐 내 머신이냐)** — 이걸 먼저 하라:
  - `curl` **530** → 터널이 실제로 죽었다. **전파/재기동 필요**.
  - `curl` **000 인데 `dig` 는 IP 를 준다** → **배포 머신의 로컬 리졸버** 문제다. **테스터는 멀쩡하다** —
    놀라서 재배포하지 마라. 확인은 `curl --resolve <host>:443:<ip>` 로 우회.
  - `dig` 도 **timeout** → 그 머신에 DNS 자체가 없다(회선 문제). 이 상태에선 라이브 판정을 할 수 없다.

### 2026-08-01 실장애 — **터널 58분 다운, 워치독은 그동안 아무것도 안 했다** (#391)

- **증상**: 백엔드·러너·executor 는 내내 정상인데 터널만 죽어 **58분**(14:08:06Z~15:07Z) 테스터 접속 불가.
  `status.sh` = `터널: 없음`, 워치독 로그의 마지막 줄은 `HEAL_START` 하나뿐 — **완주 흔적이 없다.**
- **⚠️ 이 모양(HEAL_START 후 침묵)을 보면 상한 소진(DEGRADED)이 아니라 `--once` 가 매달린 것이다.**
  `heals.tsv` 는 1회뿐이었고 `DEGRADED` 마커도 없었다. 확인·조치는 **PID 로**:
  ```bash
  ps -eo pid,lstart,command | grep "[h]mb-tunnel-heal"   # 시작시각이 수십 분 전이면 그놈이다
  kill <pid>            # ⚠️ pkill -f 금지(다른 세션 스택을 죽인다)
  bash infra/start-tunnel.sh
  ```
  락 회수(`try_lock`)는 소유자가 **죽었을 때만** 훔쳐온다 — **살아서 매달린** 놈은 안 걸리고, 60초마다
  오는 후속 틱이 전부 "다른 치유 진행 중"으로 되돌아간다. **워치독이 존재하지 않는 것과 같아진다.**
- **원인 3겹**(전부 수정): ①`current_url` 이 cloudflared 의 등록 엔드포인트 `api.trycloudflare.com` 을
  터널 주소로 착각(같은 방식으로 **하루에 두 번** 죽었다) ②`DNS_WAIT=120` 이 `sleep` 합계만 세서
  **공칭 120초가 실측 3469초**(해석기 전멸 시 `probe` 한 바퀴가 100초 넘음) → **벽시계 마감**으로 교체
  ③어디서 매달리든 죽는 **실행 자기 마감** `HMB_RUN_DEADLINE`(기본 420초, `RUN_TIMEOUT` 기록 후 자결).
- **복구 후 검증에서 또 속을 뻔한 것**: Pages `config.json` **첫 조회가 옛 URL**이었다(CDN 캐시).
  §0.8 이 경고하는 그 함정 — **캐시버스터로 재조회**해야 한다. 안 하면 "복구 실패"로 오판한다.
- 📌 **워치독 코드를 고쳤으면 `bash infra/install-tunnel-heal.sh` 로 재설치하고 `diff` 로 동기 확인**한다
  (설치본은 `~/.local/bin/hmb-tunnel-heal.sh`, 배너 2줄만 달라야 정상). 리포만 고치면 워치독은 그대로다.

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
