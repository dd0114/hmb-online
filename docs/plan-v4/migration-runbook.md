# 서버 이사 런북 — 구 머신 → 새 머신 (#472)

> **이 문서 하나만 보고 이사할 수 있어야 한다**가 기준이다. 각 스텝은 **명령 · 기대 출력 · 실패 시 조치** 셋을 갖는다.
> 상태 SoT = 이슈 **#472**. 배포 일반 절차는 `deploy-playbook.md`(이 문서는 그것을 대체하지 않고 **이사 경로만** 다룬다).

---

## 0. 읽기 전에 — 이 이사의 성질

| 사실 | 그래서 |
|---|---|
| DB 는 **named volume `hmb-p3-db` 하나**다(659MB). 업로드 자산·`economy.override.json` 도 같은 볼륨 | 백업 대상이 하나 — 설계 의도다(`NoticeAssetStorage.java:15`) |
| 라우터 스왑 = **web 이 보는 백엔드 URL 만 바꾸는 것**(`pages.dev/config.json`) | web 재배포 없이 ≈10초. 다운타임을 여기서 끝낸다 |
| 정지 창에 들어가는 것은 **DB 전송뿐**이다 | 이미지 빌드·시크릿 이송·이미지 스모크는 **전부 P0(서비스 살아있는 채로)** 로 뺀다 |
| 구 머신은 **지우지 않는다** | 롤백 자산은 거기 있다. 그래서 이송 팩이 `db-backups/`(8.9GB)를 안 옮긴다 |

### ⛔ 시작 전 게이트 2개 (사람 결정)

1. **정지 창 시점** — P1~P4 사이 서비스가 멈춘다. 실측 기반 예상 **DB 전송 시간 + 5~10분**.
   hero 와 시점을 합의하기 전에는 P1 로 넘어가지 않는다.
2. **EC2 AI 모드** — 모드 A(호스트 구독 CLI)를 새 머신에서도 쓸 것인가.
   이 결정이 **이송 규모를 두 자릿수로 가른다**:

   ```
   bash infra/pack-move.sh --dry-run                # 모드 A 유지  → 약 3,438 MB (~/.claude 3.4GB)
   bash infra/pack-move.sh --dry-run --no-claude    # 모드 A 아님 → 약     6 MB
   ```
   (실측 2026-08-09. `~/.claude` 를 옮겨도 새 머신에서 구독 세션이 그대로 산다는 보장은 없다 — §④ 미해결.)

---

## P0 — 사전 준비 (구 머신·새 머신, **서비스 살아있는 채로**)

다운타임 밖이다. 여기서 최대한 많이 끝낸다.

### P0-1. 새 머신 도구 확인

```bash
docker --version && docker compose version && git --version && node -v \
  && command -v cloudflared && command -v curl && command -v rsync
```
- **기대**: 전부 출력. node 는 **20.19.6 이상**.
- **실패 시**: 없는 것만 설치. `cloudflared` 는 `deploy.md:183-204` 참조.
- **OS 분기**: EC2(리눅스)면 `wrangler` 전역 설치도 지금 해 둔다(`npm i -g wrangler`) — 없으면 워치독 첫 치유가 `npx` 레지스트리 확인으로 **수 분**을 태운다(실측 ~4분).

### P0-2. 리포 클론 + 배포 SHA 체크아웃

```bash
git clone <origin> hmb-online && cd hmb-online
git log --oneline -1                       # 구 머신의 라이브 SHA 와 맞춘다
```
- **기대**: 구 머신 `infra/deploy-manifest.json` 의 SHA 와 동일.
- **실패 시**: `git checkout <그 SHA>`. **main 최신을 쓰지 마라** — 이사는 배포가 아니다. 한 번에 하나만 바꾼다.

### P0-3. 이미지 선빌드 + 컨테이너 스모크

```bash
cd infra && docker compose build java runner
```
- **기대**: 두 이미지 빌드 성공(수 분).
- **이어서** 컨테이너 스모크(`deploy-playbook.md:244-270`) — `ERR_MODULE_NOT_FOUND` 부류를 다운타임 **밖에서** 잡는다.
- **실패 시**: 여기서 고친다. 정지 창 안에서 빌드 실패를 만나면 롤백 외에 답이 없다.

### P0-4. 이송 팩 만들기 (구 머신)

W1 이 목록을 기계에 넘겼다 — 사람이 6종을 기억하지 않는다.

```bash
# 구 머신에서
bash infra/pack-move.sh --dry-run                    # 무엇을 옮길지 먼저 본다
bash infra/pack-move.sh --out ~/hmb-move.tar.gz      # 리포 밖으로만 (안이면 거부한다)
```
- **기대**: 6종 전부 `✓`, 마지막 줄 `OK`. 산출물 = `~/hmb-move.tar.gz` + `.manifest`(권한 600).
- **실패 시**: `✗` 로 표시된 항목이 **이사에서 잃을 것**이다. 그 항목을 복구하기 전에는 진행하지 않는다.
- ⚠️ **이 파일은 시크릿 덩어리다**(SERVANT_TOKEN·admin 평문·CF 토큰·구독 세션). 리포 안에 두지 않는다. 커밋하지 않는다. 이슈에 붙여넣지 않는다. **이사 후 양쪽에서 삭제**한다.
- `--no-claude` 는 위 게이트 2의 결정에 따른다. 제외해도 **조용하지 않다** — 매니페스트에 기록된다.

### P0-5. 이송 팩 전송 + 복원 (새 머신)

```bash
scp ~/hmb-move.tar.gz ~/hmb-move.tar.gz.manifest <새머신>:~/     # 매니페스트도 같이
# 새 머신에서
cd hmb-online && bash infra/unpack-move.sh --in ~/hmb-move.tar.gz
```
- **기대**: `N 개 파일 shasum 일치` → 항목별 복원 → `OK`.
- **실패 시**: 매니페스트 불일치면 **아무것도 복원되지 않았다**(설계상 그렇다 — 부분 복원이 파손보다 나쁘다). 구 머신에서 다시 싸고 다시 보낸다.
- 새 머신에 이미 상태가 있으면 멈춘다. 확인 후 `--force`.

### P0-6. 키셋 대조 (새 머신)

```bash
bash infra/check-env-contract.sh
```
- **기대**: `OK  오류 0`.
- **실패 시**: `req 누락` → 그 키 없이는 java 가 안 뜬다. `계약에 없는 키` → 구 머신에만 있던 키다, `infra/env-contract.txt` 에 등재하고 등급을 매긴다.
- ⚠️ **`.env` 를 `.env.example` 로 재생성하지 마라.** admin 은 `HMB_ADMIN_NICKNAME`(≠USERNAME)이고, 짝 중 하나만 차면 `application.yml:110` 에 걸려 **java 가 안 뜬다**.

### P0-7. 구 머신 워치독 정지 ⚠️

```bash
# 구 머신에서
bash infra/install-tunnel-heal.sh --uninstall
bash infra/install-tunnel-heal.sh --status        # "미설치" 확인
```
- **기대**: 해제 완료.
- **왜 필수인가**: 안 끄면 이사 중 구 머신 워치독이 **터널을 되살리고 `config.json` 을 자기 URL 로 되돌린다**. 배포 락(`~/.local/state/hmb/deploy.lock`)은 **머신 간에 공유되지 않는다** — 두 머신이 같은 Pages 를 서로 덮어쓴다.
- **실패 시**: 프로세스를 **PID 로만** 종료한다(`pkill -f` 금지 — 전역 규칙).

---

## P1 — 서비스 정지 (⏱ 다운타임 시작)

### P1-8. 진행 중 매치 0 확인

```bash
docker run --rm -v hmb-p3-db:/data:ro alpine:3.20 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/data/hmb.db?mode=ro' \
   \"SELECT id,state FROM matches WHERE state NOT IN ('FINISHED','FAILED','ABANDONED')\""
```
- **기대**: 출력 없음.
- **실패 시**: 잔여가 짧으면 끝나길 기다린다(선례: 145초 대기로 절단 0건). 길면 그대로 진행 — `#217` ABANDONED 회수가 안전망이다.

### P1-9. 호스트 executor 종료

```bash
ps ax | grep -i '[e]xecutor-main'          # PID 확인
kill <PID>                                  # ⚠️ PID 로만. pkill -f 금지(다른 세션 스택을 죽인다)
```

### P1-10. 터널 종료

```bash
kill "$(cat /tmp/hmb-cf-tunnel.pid)"
```
- **기대**: 테스터 URL 이 응답 없음이 된다(정상 — 지금부터 다운타임).

### P1-11. 컨테이너 정지

```bash
cd infra && docker compose stop java runner
```
- ⚠️ **`down -v` 금지.** `-v` 는 볼륨을 지운다 = DB 소멸.

---

## P2 — DB 이송

### P2-12. 정지 상태 백업 (WAL 정합)

```bash
mkdir -p ~/hmb-move-db
docker run --rm -v hmb-p3-db:/data:ro -v "$HOME/hmb-move-db:/backup" alpine:3.20 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/data/hmb.db?mode=ro' '.backup /backup/pre-move.db'"
```
- **기대**: `~/hmb-move-db/pre-move.db` 생성(≈660MB).
- **왜 `.backup` 인가**: 파일을 그냥 복사하면 WAL 이 살아 있는 채로 복사돼 **조용히 어긋난다**. 정지 후 `.backup` 이 유일한 정합 경로다.

### P2-13. 업로드 자산 + economy tar

```bash
TS=$(date +%Y%m%d-%H%M%S)
docker run --rm -v hmb-p3-db:/data:ro -v "$HOME/hmb-move-db:/backup" alpine:3.20 \
  sh -c "tar czf /backup/assets-move-$TS.tgz -C /data notice-assets char-bundles economy.override.json 2>/dev/null || echo '(자산 없음)'"
```
- **기대**: tar 생성.
- ⚠️ **`economy.override.json` 이 목록에 있어야 한다.** 이게 빠지면 `initialGems 12000` 운영조정이 소멸하고 구운 발행물로 돌아간다 — 화면은 멀쩡하고 **숫자만 틀리는 무음 장애**다. (플레이북 `:622` 를 #472 AC2.3 이 수리했다. `char-bundles` 는 현재 부재라 `|| echo` 가 받는다.)
- **대안(더 안전)**: 볼륨 통째 tar — `tar czf /backup/volume-$TS.tgz -C /data .` (660MB, 전송량이 두 배가 된다).

### P2-14. 백업 검증

```bash
sqlite3 ~/hmb-move-db/pre-move.db 'PRAGMA integrity_check;'
sqlite3 ~/hmb-move-db/pre-move.db 'SELECT MAX(version) FROM flyway_schema_history;'
shasum -a 256 ~/hmb-move-db/pre-move.db | tee ~/hmb-move-db/pre-move.db.sha256
```
- **기대**: `ok` / flyway 최대 버전(구 머신 값과 대조) / shasum 기록.
- **실패 시**: `integrity_check` 가 ok 가 아니면 **진행하지 않는다.** 컨테이너를 다시 올려 서비스를 복구하고(롤백) 원인을 본다.

### P2-15. 전송 + 무결성 재대조

```bash
rsync -avP ~/hmb-move-db/ <새머신>:~/hmb-move-db/
# 새 머신에서
shasum -a 256 ~/hmb-move-db/pre-move.db          # 구 머신 값과 같아야 한다
```
- **실패 시**: 다르면 재전송. 다른 해시로 적재하면 그 순간부터 원인 불명 장애다.

### P2-16. 새 머신 볼륨 적재 — **디렉토리까지 chown**

```bash
docker volume create hmb-p3-db
docker run --rm -v hmb-p3-db:/data -v "$HOME/hmb-move-db:/src:ro" alpine:3.20 sh -c \
  "cp /src/pre-move.db /data/hmb.db && tar xzf /src/assets-move-*.tgz -C /data 2>/dev/null; \
   chown -R 10001:999 /data && chmod 775 /data"
```
- **기대**: 오류 없음.
- ⚠️ **`chown -R` 의 대상에 `/data` 자신이 들어가야 한다.** 파일만 바꾸고 디렉토리를 빼면 java 가 WAL 을 못 만든다 — v3.19 실패 사례(`deploy-playbook.md:634-638`).
- uid 10001 = `server-java/Dockerfile:51` 의 `hmb` 유저. gid 999 는 실측값(`ping` 그룹으로 표시된다).

---

## P3 — 새 머신 기동

### P3-17. 컨테이너 기동

```bash
cd infra && docker compose up -d java runner
until [ "$(docker inspect -f '{{.State.Health.Status}}' hmb-java)" = healthy ]; do sleep 3; done; echo healthy
```
- **기대**: `healthy`.
- **실패 시**: `docker logs hmb-java --tail 50`. Flyway 버전 불일치 / 권한 오류(P2-16 chown) / `.env` 누락(P0-6) 순으로 본다.

### P3-18. admin 부트스트랩 확인

```bash
docker logs hmb-java 2>&1 | grep AdminBootstrap
```
- **기대**: `admins=1`.
- **실패 시(`admins=0`)**: `.env` 의 `HMB_ADMIN_NICKNAME`/`HMB_ADMIN_PASSWORD` 짝이 안 찼다. `/api/admin/**` 이 전면 차단된 상태다.

### P3-19. economy override 확인

```bash
curl -s -H "Authorization: Bearer <admin>" http://localhost:18080/api/admin/economy | head -c 300
```
- **기대**: `source: OVERRIDE`, `overrideFilePresent: true`.
- **실패 시**: P2-13 의 tar 에 `economy.override.json` 이 빠졌다. `unpack-move.sh` 가 꺼내 둔 사본으로 넣는다:
  ```bash
  docker run --rm -v hmb-p3-db:/data -v "$HOME/.local/state/hmb/move:/src:ro" alpine:3.20 \
    sh -c 'cp /src/economy.override.json /data/ && chown 10001:999 /data/economy.override.json'
  docker restart hmb-java
  ```

### P3-20. AI 실행기 기동 (모드 A일 때만)

```bash
cd "$(git rev-parse --show-toplevel)" && source infra/.env
JAVA_URL=http://localhost:18080 SERVANT_TOKEN="$SERVANT_TOKEN" \
  AI_EXECUTOR=claude-code AI_MODEL=sonnet AI_CONCURRENCY=1 AI_JOB_TIMEOUT_MS=240000 \
  nohup npm run executor -w @hmb/server > /tmp/hmb-executor.log 2>&1 &
```
- **기대**: 로그에 폴링 시작.
- ⚠️ `AI_CONCURRENCY=1` 권장 — 2 는 SQLite lease 경합으로 매치 FAILED 를 유발한다(#166/#72 실측).
- ⚠️ `ANTHROPIC_API_KEY` 를 넣지 마라 — 구독이 아니라 **종량 과금**이 된다.
- **게이트 2가 "모드 A 아님"이면 이 스텝을 건너뛴다** — `AI_EXECUTOR=stub` 로 두고 별도 결정에 따른다.

### P3-21. 로컬 스모크

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18080/internal/health                    # 401 기대
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $SERVANT_TOKEN" \
  http://localhost:18080/internal/health                                                            # 200 기대
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18790/health                              # 200 기대
```
- **401 이 정상이다** — 토큰 없이 401 이 온다는 것 자체가 "경로가 살아있다"는 증거다.

---

## P4 — 라우터 스왑 (⏱ 다운타임 종료)

### P4-22. 새 머신에서 터널 기동

```bash
nohup cloudflared tunnel --url http://localhost:18080 > /tmp/hmb-cf-tunnel.log 2>&1 &
echo $! > /tmp/hmb-cf-tunnel.pid
sleep 8 && grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/hmb-cf-tunnel.log | head -1
```
- **기대**: `https://….trycloudflare.com` URL.
- **대안**: `bash infra/start-tunnel.sh` (터널+URL캡처+web 재배포 원클릭 — 단 **재빌드를 포함**해 느리다).

### P4-23. web 이 보는 백엔드 주소 교체

```bash
bash infra/publish-backend-url.sh <새터널URL>
```
- **기대**: 스크립트가 `pages.dev/config.json` 을 캐시버스터로 10회 폴링해 **일치할 때만** exit 0(≈10초).
- **실패 시(exit 2)**: `~/.cache/hmb/dist-current` 가 없다 → P0-5 이송 팩 복원이 안 됐다.
- ⚠️ 여기서 다운타임이 끝난다. 이 시점 이후 롤백은 **신 DB 의 쓰기를 잃는다**(함정 ④) — 되돌리려면 P1 부터 반대 방향으로 다시 한다.

### P4-24. CORS 확인

```bash
docker exec hmb-java sh -c 'echo $HMB_CORS_ALLOWEDORIGINS'
```
- **기대**: `https://hmb-online.pages.dev` (Pages 는 **고정 오리진**이라 이사해도 안 바뀐다).
- **실패 시**: `.env` 의 `WEB_ORIGINS` 를 고치고 `docker compose up -d java`.

### P4-25. 워치독 설치 (새 머신)

```bash
bash infra/install-tunnel-heal.sh
bash infra/install-tunnel-heal.sh --status
bash ~/.local/bin/hmb-tunnel-heal.sh --selftest
```
- **기대**: 등록 완료 + selftest 8항목 통과.
- **OS 분기**:
  - **mac(드롭인 A안)**: launchd plist 등록. `--status` 가 launchd 출력.
  - **EC2(리눅스)**: systemd user unit(service+timer) 등록 + `loginctl enable-linger`.
    ⚠️ linger 자동설정이 실패하면 **수동으로 해야 한다** — 안 하면 로그아웃/재부팅 후 워치독이 조용히 사라진다:
    ```bash
    sudo loginctl enable-linger "$(id -un)"
    ```
- **실패 시**: selftest 의 `✗` 항목을 먼저 해결한다(`cloudflared`/`dig`/`curl`/`npx`/해석기/`deploy.env`/dist 캐시/publish 스크립트).

### P4-26. 설치본 ↔ 리포 동기 확인

```bash
diff <(tail -n +4 ~/.local/bin/hmb-tunnel-heal.sh) <(tail -n +2 infra/tunnel-heal.sh) && echo SYNC-OK
```
- **기대**: `SYNC-OK`. 워치독은 **리포가 아니라 `~/.local/bin` 사본**을 돌린다 — 리포만 고치면 반영되지 않는다.

---

## P5 — 검증 · 정리

### P5-27. 상태 한 눈에

```bash
bash infra/status.sh
```
- **기대**: 전 항목 `✓`. 워치독 칸도 정상 판정된다(#472 AC1.3 이 OS 중립으로 고쳤다 — 리눅스에서 나던 거짓 "미설치" 경보는 없다).

### P5-28. 브라우저 실왕복

`https://hmb-online.pages.dev` 로그인 → `/api/me` 200 → 덱 확인 → **매치 1판 완주**.
- ⚠️ 스모크는 **기존 계정(`deploy-smoke`)** 으로. 새 계정으로 경기를 돌리면 실유저 통계에 섞인다.

### P5-29. 매니페스트 대조

```bash
curl -s "https://hmb-online.pages.dev/version.json?cb=$RANDOM" -H 'Cache-Control: no-cache'
bash infra/version-manifest.sh
```
- **기대**: web 이 보는 버전과 백엔드가 일치. 이미지 digest 는 **새로 빌드된 값**이라 구 머신과 다른 게 정상이다.
- **캐시 함정**: 캐시버스터 없이 조회하면 CDN 이 옛 값을 준다(`deploy-playbook.md:234`).

### P5-30. 배포 기록 + 구 머신 정리

```bash
# docs/deploy-log.md 맨 위에 [이사] 항목 append 후 커밋·푸시 (P4-D5/#171 — 필수)
```
- 구 머신: 컨테이너 `stop`(삭제하지 않는다). 볼륨은 **N일 보존 후** 삭제.
- ⚠️ 구 머신에서 **배포 스크립트를 돌리지 않는다** — 워치독은 이미 껐지만(P0-7), 수동 실행도 `config.json` 을 되돌린다.
- ⚠️ **이송 팩을 양쪽에서 삭제한다**: `rm -f ~/hmb-move.tar.gz*` (시크릿 덩어리).
- ⚠️ `infra/rollback-309.sh` 는 새 머신에서 **사문화**다 — 그 이미지 다이제스트는 구 머신 로컬에만 있다. 실행하면 그 사실을 명시하고 `exit 2` 한다(장애가 아니다).

---

## 실이사 전에 — 모의 이사 리허설 (#472 W3)

정지 창을 쓰기 **전에** 같은 머신에서 P2~P3 을 실제로 집행해 본다. 라이브는 건드리지 않는다
(별도 포트 28080/28790 · 별도 볼륨 `hmb-rehearsal-db` · 라이브 볼륨은 `:ro` 로만).

```bash
bash infra/rehearse-move.sh --check    # 격리 기준선(아무것도 안 바꿈)
bash infra/rehearse-move.sh --go       # P2~P3 집행 + 스모크 + DB 대조
bash infra/rehearse-move.sh --clean    # 리허설 잔재만 제거
```
- **기대**: 마지막 줄 `OK`. `integrity_check=ok` · flyway 버전 · **행수 src=dst** ·
  `AdminBootstrap admins=1` · 로그인 `isNew=false`(= DB 가 정말 넘어왔다는 증거) ·
  `economy.override.json` 이송 · **라이브 컨테이너 ID·기동시각 완전 동일**.
- **실패 시**: 그 항목이 실이사에서도 실패한다. 정지 창을 잡기 전에 여기서 고친다.
- ⚠️ 라우터 스왑(P4)은 리허설하지 않는다 — 테스터가 보는 URL 을 실제로 바꾸는 일이라
  같은 머신에서 흉내낼 수 없다(흉내내면 그게 라이브를 건드리는 것이다).

---

## 롤백

| 시점 | 되돌리는 법 | 대가 |
|---|---|---|
| P0~P3 (스왑 전) | 구 머신에서 `docker compose start java runner` + 터널 재기동 + 워치독 재설치 | **없다** — 구 머신 DB 가 정본이다 |
| P4 이후 | P1 부터 **반대 방향으로** 다시 한다(신 머신 정지 → DB 를 구 머신으로 → 스왑) | ⚠️ 그 사이 신 DB 에 들어온 **쓰기를 잃는다**. 시간이 지날수록 커진다 |

---

## 부록 — 이 런북이 참조하는 스크립트

| 스크립트 | 역할 | 도입 |
|---|---|---|
| `infra/pack-move.sh` / `unpack-move.sh` | 이송 목록 6종 + 항목별 shasum, 부분복원 방지 | #472 AC1.4 |
| `infra/check-env-contract.sh` | env 키셋 드리프트(권위 = `infra/env-contract.txt`) | #472 AC1.2 |
| `infra/install-tunnel-heal.sh` | 워치독 설치 — launchd/systemd 양쪽 | #472 AC1.3 |
| `infra/status.sh` | 배포 상태 한 눈에(OS 중립 워치독 관측) | #183 / AC1.3 |
| `infra/publish-backend-url.sh` | 라우터 스왑(빌드 없이 config.json 만) | #299 계열 |
| `infra/version-manifest.sh` | 모듈별 버전·이미지 digest | #164→#171 |
| `infra/rehearse-move.sh` | 모의 이사 리허설(별도 포트·볼륨) + 격리 가드 | #472 W3 |
| `infra/check-runbook-sync.sh` | 이 런북 ↔ 스크립트 싱크 | #472 AC2.4 |
