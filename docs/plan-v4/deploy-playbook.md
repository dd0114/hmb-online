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
cd ~/spider10/hmb-online
source infra/.env
JAVA_URL=http://localhost:18080 SERVANT_TOKEN="$SERVANT_TOKEN" AI_EXECUTOR=claude-code AI_MODEL=sonnet \
  nohup npm run executor --workspace=@hmb/server > /tmp/hmb-executor.log 2>&1 &

# 4) 터널 + web 재배포 (원클릭)
bash infra/start-tunnel.sh

# 5) 확인
bash infra/status.sh
```

> `claude` CLI 가 구독 로그인돼 있어야 AI 매치가 돈다(`claude --version` 확인, `ANTHROPIC_API_KEY` 는 미설정 유지 — 있으면 종량과금).

---

## 3. 터널 URL 이 바뀌었을 때 (quick tunnel 재시작 시)

quick tunnel 은 재시작마다 URL 이 바뀐다. web 이 옛 주소를 가리키면 왕복이 깨진다. 흡수법:

```bash
# 터널까지 새로 띄우고 web 재배포까지 한 번에
bash infra/start-tunnel.sh

# 터널은 살아있고 URL만 새로 알 때
bash infra/deploy-web.sh https://<새-URL>.trycloudflare.com
```
`WEB_ORIGINS`(백엔드 CORS)는 Pages URL(고정)이라 **안 바뀐다** → java 재시작 불필요.

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

## 8. 오픈 GO 전 잔여 (인프라 밖)

- **B3 고지**: 로그인 화면/공지에 "평문 목업 — 실제 비번 입력 금지"
- 도메인별 점검(`open-checklist.md` §1~§9): 계정 무회귀·모바일 실기기·법적 판타지 전환
- hero 실플레이 1회: 덱 구성→매치 생성→결과 (라이브 AI 실동작)
