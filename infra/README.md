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
| `../server-java/Dockerfile` | Boot3 멀티스테이지(JDK21 빌드 → JRE21 런타임, 비루트) |

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
