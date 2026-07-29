# infra/ — HMB 배포 (Phase 3, 에픽 #122)

**전체 런북은 [`../docs/plan-v4/deploy.md`](../docs/plan-v4/deploy.md)** — 이 파일은 빠른 참조만.

## 빠른 시작 (백엔드 3프로세스)

```bash
cd infra
cp .env.example .env          # SERVANT_TOKEN 등을 채운다 (.env 는 커밋되지 않음)
docker compose up -d --build
docker compose ps             # java/runner/executor 3개 healthy 확인
```

| 서비스 | 컨테이너 포트 | 호스트 포트 | 헬스체크 |
|---|---|---|---|
| `java` (server-java) | 8080 | **18080** | `GET /internal/health` + `X-Servant-Token` |
| `runner` (엔진 러너) | 8790 | **18790** | `GET /health` |
| `executor` (AI 실행기) | — (롱폴링) | — | Java 도달성 |

> ⚠️ 데모가 호스트 **8080·8790** 을 native 로 쓰고 있어 **무접촉**. 여기선 18080·18790 으로만 노출한다.
> 바꾸려면 `.env` 의 `JAVA_HOST_PORT`·`RUNNER_HOST_PORT`.

## 파일

| 파일 | 용도 |
|---|---|
| `docker-compose.yml` | 3프로세스 + SQLite named volume(`hmb-p3-db`). 기본 `AI_EXECUTOR=stub` |
| `docker-compose.ai-live.yml` | **모드 B** override — 컨테이너에서 구독 claude CLI(`~/.claude` 마운트) |
| `executor-live.Dockerfile` | 모드 B 전용 이미지(서번트 + claude CLI) |
| `.env.example` | 환경변수 템플릿. **실토큰 금지** — `.env` 로 복사해 채운다 |
| `healthcheck-executor.mjs` | executor 헬스체크(워커 프로세스 상태 + Java 도달성). 컨테이너에 ro 마운트 |
| `cloudflared/config.example.yml` | named tunnel 설정 **템플릿**(자격증명 JSON 은 커밋 금지) |
| `pages/build.sh` | Cloudflare Pages 빌드 커맨드(리포 루트에서 실행) |
| `pages/_redirects`·`_headers` | SPA 폴백 + 보안/캐시 헤더. build.sh 가 `apps/web/dist/` 로 복사 |
| `pages/functions/**` | **Pages Function 소스**(#299 공유 URL OG 썸네일). SoT — 여기서만 고친다 |
| `pages/stage-functions.sh` | 위를 **리포 루트 `functions/`** 로 배치(build.sh 가 부른다). 왜 거기인지는 그 파일 주석 |
| `pages/e2e/*` | OG Function 로컬 계약(`wrangler pages dev` + curl + 실브라우저). 배포 없이 돈다 |
| `../server-java/Dockerfile` | Boot3 멀티스테이지(JDK21 빌드 → JRE21 런타임, 비루트) |

## web (Cloudflare Pages)

```
Build command    : bash infra/pages/build.sh
Build output dir : apps/web/dist
Root directory   : (비움 = 리포 루트 — prebuild 가 모노레포 전체를 필요로 함)
환경변수         : VITE_API_BASE = https://api.<your-domain>
```

> 🚫 **현재 미동작**: `apps/web` 이 아직 `VITE_API_BASE` 를 읽지 않고(#129), server-java 에 CORS 가
> 없다(#128). 빌드 파이프라인은 검증됐지만 API 왕복은 두 이슈 해소 후 가능하다. deploy.md §6.

## 공유 URL OG 썸네일 (Pages Function, #299)

`/share/notice/{id}` 를 카톡·슬랙에 붙이면 공지 제목·요약·이미지가 미리보기로 뜬다.
구현 = **route 기반 Pages Function** 하나(`pages/functions/share/notice/[id].js`).

```bash
# 로컬 검증(배포 없음) — wrangler pages dev + curl + 실브라우저
VITE_API_BASE=https://example.invalid bash infra/pages/build.sh   # 산출물 1회
bash infra/pages/e2e/og-function.e2e.sh        # AC1~AC4 계약
bash infra/pages/e2e/deploy-wiring.e2e.sh      # 배치·워치독 배선 계약
```

운영자가 알아야 할 3가지:

1. **Function 은 `apps/web/dist` 안이 아니라 리포 루트 `functions/` 에서 읽힌다**
   (wrangler 는 `process.cwd()/functions` 만 본다 — 근거는 `pages/stage-functions.sh` 주석,
   실측 대조군은 `pages/e2e/deploy-wiring.e2e.sh` W1). `build.sh` 가 배치하므로 **배포 전 build.sh 를
   반드시 거쳐야 한다**. 루트 `functions/` 는 생성물(.gitignore) — 거기서 고치면 다음 빌드가 덮는다.
2. **워치독(#183)이 Function 을 지우지 않게** `deploy-pages.sh`/`deploy-web.sh` 가
   `~/.cache/hmb/dist-current.functions` 스냅샷을 남긴다. 그게 없으면 `publish-backend-url.sh` 가
   경고를 남기고 OG 없이 배포한다 → **정상 배포 1회**(`bash infra/deploy-pages.sh <백엔드URL>`)로 복구.
3. **백엔드 주소는 굽지 않는다** — Function 이 `/config.json` 을 요청 시각에 읽는다. 터널이 바뀌어도
   따라간다. 미리보기가 빈 채로 뜨면 먼저 `curl https://hmb-online.pages.dev/config.json` 을 본다.

## AI 실행기 모드

- **모드 A (권장)**: `docker compose up -d java runner` + 호스트에서 executor 실행
  ```bash
  JAVA_URL=http://localhost:18080 SERVANT_TOKEN=... AI_EXECUTOR=claude-code \
    npm run executor --workspace=@hmb/server
  ```
- **모드 B**: `docker compose -f docker-compose.yml -f docker-compose.ai-live.yml up -d`
- **기본(stub)**: claude CLI 불필요. 오프라인 검증용.

비교·경고는 deploy.md §AI 실행기.

## 주의

- **시크릿은 `.env` 에만.** 리포에는 `.env.example`(자리표시자)만 커밋한다.
- `ANTHROPIC_API_KEY` 를 넣지 말 것 — 구독이 아닌 **종량 과금**으로 전환된다.
- 상태는 전부 `hmb-p3-db` 볼륨의 SQLite. 초기화 = `docker compose down -v` (**전 데이터 삭제**).
