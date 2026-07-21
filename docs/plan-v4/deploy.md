# 배포 런북 — HMB 온라인 내부 테스터 오픈 (Phase 3)

> SoT: PRD-v4 §G(AC-G1·G2) / 에픽 #122. 대상 = **내부 테스터 배포**(프로덕션 아님).
> 소유: `infra/**` + `server-java/Dockerfile`. 작성: hmb:p3dep 세션.
>
> **실배포는 hero 가 실행한다** — `cloudflared login`·Cloudflare 계정 연동·도메인 설정은
> 사람 게이트다. 이 문서는 그 절차를 재현 가능하게 적고, 자동 검증 가능한 부분은 검증까지 마친 상태다.

---

## 1. 아키텍처

```
  테스터 브라우저
        │
        ├──────────────► https://<project>.pages.dev        (Cloudflare Pages — web 정적)
        │                        │
        │                        │  VITE_API_BASE 로 주입된 절대 오리진
        │                        ▼
        └──────────────► https://api.<domain>                (Cloudflare Tunnel)
                                 │
                                 ▼  cloudflared (hero 머신에서 실행)
                          localhost:18080
                                 │
    ┌────────────────────────────┴─────────────────────────────┐
    │  docker compose (infra/docker-compose.yml)               │
    │                                                          │
    │   java 8080 ──► runner 8790   (엔진 시뮬 RPC)             │
    │     ▲                                                    │
    │     └── executor (롱폴링, AI 잡)                          │
    │                                                          │
    │   volume hmb-p3-db : SQLite (유일한 상태)                  │
    └──────────────────────────────────────────────────────────┘
                                 │
                 AI 실행기가 호스트 구독 claude CLI 사용 (§4)
```

**호스트 포트**: java `18080`, runner `18790`.
⚠️ 데모가 **8080·8790** 을 native 로 점유 중 → **무접촉**. 겹치지 않게 대체 포트를 쓴다.

---

## 2. 사전 요구

| 항목 | 확인 |
|---|---|
| Docker + Compose v2 | `docker compose version` (검증 환경: 24.0.2 / v2.19.1) |
| cloudflared | `cloudflared --version` (없으면 `brew install cloudflared`) |
| Cloudflare 계정 | Pages + Tunnel 사용 권한. **named tunnel 은 CF 에 등록된 도메인 필요** |
| 구독 claude CLI | 라이브 AI 용. `claude --version` (모드 A/B, §4) |

---

## 3. 백엔드 기동 (AC-G1)

```bash
cd infra
cp .env.example .env
# .env 편집 — 최소한 SERVANT_TOKEN 은 반드시 교체
#   openssl rand -hex 32
docker compose up -d --build
docker compose ps        # java / runner / executor 3개 healthy
```

### 검증 (실측 완료)

```bash
# java — 토큰 필요
curl -fsS -H "X-Servant-Token: $SERVANT_TOKEN" http://localhost:18080/internal/health
#   → {"queueDepth":0,"leasedCount":0}

# 토큰 없으면 차단
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:18080/internal/health
#   → 401

# runner
curl -fsS http://localhost:18790/health
#   → {"engineVersion":"engine@0.14.0"}

# 로그인 왕복
curl -fsS -X POST http://localhost:18080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"smoke","provider":"guest"}'
#   → {"token":"...","user":{...},"isNew":true}
```

첫 부팅 시 Flyway 가 마이그레이션 3개를 적용하고 시드(선수 172 · 봇 3 · economy · league)를 임포트한다.
재기동 시엔 `Schema "main" is up to date` 만 뜨고 데이터는 볼륨에 남는다(컨테이너 재생성 후에도 기존 세션 토큰이 그대로 인증됨을 실측 확인).

---

## 4. AI 실행기 — 호스트 구독 CLI 접근

AI 실행기는 `spawn("claude", ...)` 로 **PATH 의 claude CLI** 를 부르고, 인증은 **호스트 구독 세션(`~/.claude`)** 에 의존한다
(`packages/server/src/executor/executors/claude-code.ts`). 컨테이너화의 유일한 난점이 여기다. 두 방식 모두 지원한다.

### 모드 A — 호스트 실행 (**권장**)

```bash
cd infra && docker compose up -d java runner    # executor 는 띄우지 않음
docker compose stop executor                    # 이미 떠 있다면

# 호스트에서 (리포 루트)
JAVA_URL=http://localhost:18080 \
SERVANT_TOKEN=<infra/.env 와 동일> \
AI_EXECUTOR=claude-code \
  npm run executor --workspace=@hmb/server
```

| 장점 | 단점 |
|---|---|
| 구독 세션을 **있는 그대로** 사용 — 인증 이슈 0 | 프로세스 1개가 compose 밖에 남음(수동 기동·감시) |
| CLI 갱신·재로그인이 평소와 동일 | 호스트 재부팅 시 자동복구 없음 |
| 세션 파일 경합 없음 | |

### 모드 B — 컨테이너 + `~/.claude` 마운트

```bash
cd infra
# ① 베이스 서번트 이미지를 **먼저** 빌드한다.
#    executor-live.Dockerfile 이 `FROM hmb/servants:p3`(로컬 태그, 레지스트리에 없음)를 쓰고,
#    compose 는 서비스를 동시에 빌드하므로 이 단계를 건너뛰면 pull access denied 로 실패한다.
docker compose build runner

# ② 그 다음 라이브 오버레이 기동
docker compose -f docker-compose.yml -f docker-compose.ai-live.yml up -d
```

`infra/executor-live.Dockerfile` 이 서번트 이미지에 claude CLI 를 얹고,
override 가 호스트 `~/.claude` 를 컨테이너 `/home/node/.claude` 로 마운트한다.

| 장점 | 단점 |
|---|---|
| 3프로세스가 전부 compose 안 — 기동/재시작 일원화 | `~/.claude` 는 **쓰기 공유** — 컨테이너의 토큰 갱신이 호스트 세션에 반영됨 |
| 호스트 재부팅 후 `restart: unless-stopped` 로 자동복구 | 호스트에서 claude 를 동시 사용하면 세션 경합 가능 |
| | 구독 세션에 머신 바인딩 요소가 있어 **컨테이너에서 거부될 수 있음** — hero 실검증 필요 |

> **권장 = 모드 A.** 자동복구가 꼭 필요하면 모드 B 를 쓰되, 첫 라이브 검증을 hero 가 직접 하고
> 실패 시 A 로 되돌린다.

### 기본값 = stub

override 없이 띄우면 `AI_EXECUTOR=stub` — claude CLI 없이 동작한다(AI 대기 0초).
AC-G1 검증·오프라인 E2E·CI 는 이 모드로 충분하다.

> ⚠️ **`ANTHROPIC_API_KEY` 를 주입하지 말 것.** 설정되면 구독이 아니라 **종량 과금**으로 청구된다.
> executor 가 기동 시 강제로 지우지만(`prepareExecutorEnv`), 애초에 넣지 않는 것이 원칙이다.

---

## 5. Cloudflare Tunnel

백엔드는 hero 머신의 도커에 있다. 공인 IP·포트포워딩 없이 외부에 노출하는 수단이 Tunnel 이다.

### 5.1 빠른 터널 (도메인 불필요 — 1회성 데모용)

```bash
cloudflared tunnel --url http://localhost:18080
#  → https://<무작위>.trycloudflare.com 발급
```

| 장점 | 단점 |
|---|---|
| 로그인·도메인 불필요, 즉시 | **재시작마다 URL 이 바뀐다** |
| | URL 이 바뀌면 web 의 `VITE_API_BASE` 도 바꿔 **Pages 재배포** 필요 |
| | CF 의 무보장 서비스 — 테스터 오픈 상시 운영엔 부적합 |

→ **연결 확인용으로만.** 실제 테스터 오픈은 5.2.

### 5.2 named tunnel (권장 — 안정 URL)

**hero 게이트**: 아래 1·2 는 브라우저 로그인이 필요해 사람이 실행한다.

```bash
# 1) CF 계정 로그인 (브라우저 열림 — hero)
cloudflared tunnel login

# 2) 터널 생성 (자격증명 JSON 이 ~/.cloudflared/<ID>.json 로 생성됨)
cloudflared tunnel create hmb-api

# 3) 설정 파일
cp infra/cloudflared/config.example.yml ~/.cloudflared/config.yml
#    <TUNNEL_ID>, <YOU>, <api.your-domain.com> 치환

# 4) DNS 라우팅
cloudflared tunnel route dns hmb-api api.your-domain.com

# 5) 실행
cloudflared tunnel run hmb-api
#    상시화: cloudflared service install  (macOS launchd)
```

### 5.3 확인

```bash
curl -fsS -X POST https://api.your-domain.com/api/auth/login \
  -H 'Content-Type: application/json' -d '{"nickname":"tunnel-smoke","provider":"guest"}'
```

### 5.4 노출 범위 (보안)

터널은 java 18080 **전체**를 공개하며 여기엔 `/internal/**` 도 포함된다.
토큰으로 보호되지만 공개할 이유가 없다.

- **필수**: `SERVANT_TOKEN` 을 `change-me` 에서 교체(`openssl rand -hex 32`).
- **권장**: Cloudflare Access 로 `/internal/*` 차단.

---

## 6. web — Cloudflare Pages

### 6.1 Pages 프로젝트 설정

```
Build command     : bash infra/pages/build.sh
Build output dir  : apps/web/dist
Root directory    : (비움 = 리포 루트)
환경변수          : VITE_API_BASE = https://api.<your-domain>
```

`infra/pages/build.sh` 가 `npm ci` → `npm run build --workspace=@hmb/web` → `_redirects`·`_headers`
복사까지 한다. **빌드 자체는 검증 완료** (아래 6.3).

- ⚠️ **Root directory 를 `apps/web` 으로 좁히면 깨진다** — `prebuild`(`ensure-viewer.mjs`)가
  `packages/engine` 에서 뷰어를 생성하므로 모노레포 전체가 필요하다.
- ⚠️ **`VITE_API_BASE` 는 빌드 타임에 인라인**된다(런타임 설정 아님) → 백엔드 오리진이 바뀌면
  **재빌드·재배포** 필요. quick tunnel(§5.1)이 상시 운영에 부적합한 이유다.

### 6.2 🚫 미해결 — 현재 이 설정만으로는 동작하지 않는다

두 가지가 빠져 있고, **둘 다 `infra/` 밖 도메인** 소유다.

| # | 문제 | 이슈 |
|---|---|---|
| 1 | `apps/web` 이 `VITE_API_BASE` 를 **읽지 않는다**. `client.ts:118` 이 상대경로로 fetch → 요청이 Pages 오리진으로 나가 404 | **#129** |
| 2 | `server-java` 에 **CORS 가 없다**(0 hits) → 교차 오리진 요청이 브라우저에서 전부 차단 | **#128** (오픈 blocker B1) |

**"코드 변경 0" 우회는 존재하지 않는다**: Pages `_redirects` 의 200 rewrite 는 자기 사이트
상대경로만 지원하고 **외부 도메인 프록시가 불가**하다
([CF 문서](https://developers.cloudflare.com/pages/configuration/redirects/)).

### 6.2.1 ⚠️ `_redirects` 함정 — SPA 폴백을 직접 쓰지 말 것

`/*  /index.html  200` 은 SPA 폴백처럼 보이지만 **사이트를 죽인다**:

> "Redirects are always followed, **regardless of whether or not an asset matches the incoming
> request**." — [Pages · Redirects](https://developers.cloudflare.com/pages/configuration/redirects/)

- `/assets/index-*.js`·`.css` 까지 index.html 로 rewrite → **백지 화면**
- `/viewer-embed.html` 도 index.html 을 반환 → 앱이 자기 iframe 안에서 재귀 렌더, `viewerReady` 미수신
- 리다이렉트가 **헤더보다 우선**하므로 `_headers` 전체가 무력화

**필요 없다.** 산출물에 top-level `404.html` 이 없으면 Pages 가 SPA 로 간주해 자동 폴백한다
([Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)). 현 산출물이 그 조건을 만족한다.
→ `infra/pages/_redirects` 는 **규칙 없이 주석만** 두었다(의도적).

### 6.3 검증 상태 (실측 — #129 머지 후 재검증 완료)

```bash
VITE_API_BASE=http://localhost:18080 bash infra/pages/build.sh
```

| 항목 | 결과 |
|---|---|
| 빌드 성공 | ✅ exit 0 (prebuild 뷰어 생성 → tsc → vite build) |
| 산출물 | ✅ `index.html` · `assets/*` · `viewer-embed.html`(88KB) · `favicon.svg` · `_redirects` · `_headers` |
| `_redirects`·`_headers` | ⚠️ **파일 복사만 확인**. Pages 런타임 적용은 **미검증**(실 배포 필요) |
| **API base 주입** | ✅ **번들에 인라인됨** — 미설정 빌드와 번들 해시가 **달라지고**(설정 시 `index-BILcWrfu.js`, 미설정 시 상이한 해시), 주입 오리진 문자열이 설정 빌드에만 존재(미설정 빌드엔 0회). (`"/api/me"` 등 상대 리터럴은 잔존 — 클라이언트가 런타임에 `apiUrl()` 로 base 를 붙인다) |

→ **AC-G1 web 반쪽 충족.** #129(web `VITE_API_BASE`) + #128(server CORS) 머지로 이전 미충족이 해소됐다.

---

## 7. 왕복 스모크 (AC-G2)

### 7.0 CORS ↔ 오리진 결선 (필수 이해)

web(Pages)과 백엔드(Tunnel)는 **다른 오리진**이라 브라우저가 CORS 를 집행한다. 두 값이 **짝**이어야 왕복이 성립한다:

- web 빌드: `VITE_API_BASE = <백엔드 오리진>`  (요청이 그리로 나감)
- 백엔드: `WEB_ORIGINS = <web 오리진>`  (그 오리진의 요청만 허용 → `infra/.env` → `HMB_CORS_ALLOWEDORIGINS`)

한쪽만 맞으면 실패한다. quick tunnel(§5.1)은 재시작마다 URL 이 바뀌므로 **양쪽 다** 갱신해야 한다.

### 7.1 로컬 왕복 검증 (터널 제외 — 실측 완료)

터널은 전송 계층일 뿐이고, 터널이 새로 들이는 실패요인은 **교차 오리진(CORS)** 이다. 그 부분은
실제 chromium 으로 검증했다 — web dist 를 오리진 A(`localhost:4321`)에서 서빙하고 백엔드를
오리진 B(`localhost:18080`)에 두고, 브라우저가 CORS 를 실집행하는 상태로:

| 단계 | 결과 |
|---|---|
| CORS preflight (허용 오리진) | ✅ 200 + `Access-Control-Allow-Origin` |
| CORS preflight (미허용 오리진) | ✅ **403**, ACAO 없음 |
| `/internal/**` preflight | ✅ **CORS 헤더 없음**(서번트 전용, 의도적 미노출) |
| 브라우저 교차오리진 로그인 | ✅ 200, 유저 생성 |
| 브라우저 교차오리진 `GET /api/me` (Authorization → 진짜 preflight) | ✅ 200, wallet 3000 |
| `POST /api/matches` | ⚠️ 404 `활성 덱이 없습니다` — **CORS 통과**(응답 본문이 교차오리진으로 읽힘). 매치 생성은 덱 구성이 선행돼야 하는 **앱 플로우**라 7.3(hero 실플레이)에서 다룬다 |

→ **브라우저 왕복 메커니즘 검증 완료.** 남은 것은 터널 전송뿐(7.2, hero 게이트).

### 7.2 터널 왕복 (quick tunnel — **실측 완료**)

quick tunnel(§5.1)은 로그인이 필요 없어 p3dep 가 직접 검증했다. 배포 실행(hero 승인) 시 실측:

- 터널: `cloudflared tunnel --url http://localhost:18080` → `https://<rand>.trycloudflare.com`
  (QUIC 커넥션 icn05 등록)
- `WEB_ORIGINS=http://localhost:4321` 로 java 재시작, web 을 `VITE_API_BASE=<터널 URL>` 로 빌드

| 단계 | 결과 |
|---|---|
| curl 로그인 through 터널 | ✅ 200 + token |
| `/internal/**` through 터널, 토큰 없이 | ✅ **401**(노출돼도 보호됨) |
| `/internal/**` through 터널, 교체된 토큰 | ✅ 200 |
| **브라우저 풀체인**: 로컬 web(오리진 A) → **공개 터널** → java, 브라우저 CORS 집행 → 로그인 | ✅ 200, 유저 생성 |
| 브라우저 풀체인 `GET /api/me`(Authorization → 진짜 preflight) | ✅ 200, wallet 3000 |

→ **AC-G2 의 터널 전송 + 브라우저 CORS 풀체인 검증 완료.** quick tunnel URL 은 재시작마다 바뀌므로
상시 오픈은 named tunnel(§5.2, hero 로그인 게이트)이 필요하다. Pages **호스팅**도 hero 게이트(§6.1 대시보드).

절차(재현):
```bash
curl -fsS -X POST https://<TUNNEL>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"nickname":"tunnel-smoke","provider":"guest"}'
#   → {"token":...}  이면 터널 전송 OK

# 브라우저 왕복: 배포된 Pages URL 접속 → 로그인 → 개발자도구 Network 에
#   /api/auth/login 200 + Access-Control-Allow-Origin 확인
```

### 7.3 hero 실플레이 (오픈 직전)

1. 배포 Pages URL 접속 → 로그인
2. 덱 구성 → **매치 생성** → 결과까지 (7.1 의 404 를 여기서 해소)
3. `docker compose logs -f executor` 로 AI 잡 처리 확인
4. 모바일 실기기 1대 이상
5. `docs/plan-v4/open-checklist.md` 병행

---

## 8. 운영

```bash
docker compose logs -f java          # 로그
docker compose restart executor      # 개별 재시작
docker compose down                  # 정지 (데이터 유지)
docker compose down -v               # ⚠️ 볼륨 삭제 = 전 데이터 소멸
```

**백업** (테스터 데이터 보존):
```bash
docker compose exec java sh -c 'cp /var/lib/hmb/hmb.db /tmp/backup.db' \
  && docker compose cp java:/tmp/backup.db ./hmb-backup-$(date +%Y%m%d).db
```
> WAL 모드라 단순 파일 복사는 최신 트랜잭션을 놓칠 수 있다. 정확한 백업은 **정지 후** 복사한다.

**데이터 리셋**(테스터 초기화): `docker compose down -v && docker compose up -d`
→ 마이그레이션·시드가 처음부터 다시 실행된다.

---

## 9. 롤백

| 상황 | 조치 |
|---|---|
| 백엔드 이상 | `docker compose down` → 직전 이미지 태그로 `docker compose up -d` |
| web 이상 | Pages 대시보드에서 이전 배포로 **Rollback** |
| 터널 이상 | `cloudflared tunnel run` 재시작. URL 불변(named tunnel) |
| 데이터 손상 | 정지 → 백업 db 를 볼륨에 복사 → 기동 |

---

## 10. 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| java 가 healthy 안 됨 | `.env` 의 `SERVANT_TOKEN` 미설정 → compose 가 즉시 실패. 로그 확인 |
| executor 가 잡을 못 잡음 | java 와 **토큰 불일치**. `.env` 하나로 양쪽에 주입되는지 확인 |
| 포트 충돌 | 데모가 8080/8790 점유 중. `.env` 의 `JAVA_HOST_PORT`·`RUNNER_HOST_PORT` 조정 |
| 브라우저 CORS 에러 | §6 미해결 사항. server-java CORS 필요 |
| 라이브 AI 실패 | 모드 B 세션 거부 가능성 → 모드 A(호스트 실행)로 전환 |
| 빌드 실패 (main class) | `server-java/Dockerfile` 의 COPY dest 는 **절대경로**여야 한다(WORKDIR 상대면 중첩됨) |
