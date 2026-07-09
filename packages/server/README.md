# @hmb/server

권위(authoritative) 서버: **감독 자연어 프롬프트 → (Claude) TacticalInput → 결정론 엔진 실행 → MatchLog**.
= PRD 방식1. 엔진(`@hmb/engine`)·직렬화 계약(`@hmb/shared`)을 **같은 프로세스**에서 재사용한다.

## 런타임 (버전 핀)
- Node **20.19.6** (`.nvmrc`), TS 소스 실행 = `tsx`. `packages/server/package.json` 의존 + `package-lock.json` 로 버전 고정, Docker 베이스 이미지 `node:20.19.6-bookworm-slim` 로 재현성 확보.
- 게임외 시스템(서버·인프라)은 이미지/lockfile 로 특정 버전 고정 원칙.

## 로컬 실행
```bash
nvm use                       # 20.19.6
npm install                   # 워크스페이스 전체
npm run dev  -w @hmb/server   # tsx watch (:8787)
curl localhost:8787/health    # {"ok":true,...}
curl -s -XPOST localhost:8787/tactical -d '{"directive":"풀백 오버랩·와이드·하이라인","seed":"4815162342"}'
#  → 현재 501 NOT_IMPLEMENTED (coach.ts 미구현). S3b 에서 Claude 연결하면 200 + MatchLog 요약.
```

## Docker
```bash
docker build -f packages/server/Dockerfile -t hmb-server:0.0.1 .
docker run -p 8787:8787 -e ANTHROPIC_API_KEY=sk-... hmb-server:0.0.1
```

## 구조 (AI 백엔드 추상화)
"AI 가 도는 방식"을 **`CoachBackend` 인터페이스**로 추상화 — 나중에 다른 AI/transport 로 갈아끼운다.
- `src/coach.ts` — 백엔드 무관 코어: `validateCoachOutput`(가드레일: zod+11명/prefix+clamp), `tacticalJsonSchema`, `promptToTacticalInput(req, backend)`.
- `src/coach-backend.ts` — `CoachBackend` 인터페이스(`generate(req) → raw`).
- `src/backends/anthropic.ts` — Claude tool-use(JSON 강제) + 프롬프트 캐싱(system+roster). **기본 모델 sonnet**(`claude-sonnet-5`), `opts.model`/`COACH_MODEL` 로 스왑. 인증: `ANTHROPIC_API_KEY`(메터드) 또는 미설정 시 `claude login` 구독 프로필(정액제).
- `src/backends/stub.ts` — 결정론 스텁(키/네트워크 불필요) — 오프라인·테스트·CI. directive 키워드로 성향만 조정.
- `src/coach-factory.ts` — `defaultCoachBackend()`: `COACH_BACKEND=anthropic|stub`(기본: 자격증명 있으면 anthropic, 없으면 stub).
- `src/pipeline.ts` — 코치(백엔드) → `runMatch`. `src/index.ts` — `GET /health`, `POST /tactical`.

**모델 스왑**: `COACH_MODEL=claude-haiku-4-5 npm run dev -w @hmb/server` (기본 sonnet).
**오프라인**: 키 없이도 `/tactical` 이 stub 백엔드로 200 + 경기를 반환(배선 검증).

## 소유 경계 (병렬 개발)
- **서버 트랙**: `packages/server/**`, `Dockerfile`, 인프라. (이 패키지)
- **엔진 QA 트랙**: `packages/engine/**`. 서로 안 밟음.
- 공유 계약 `packages/shared/**` 변경은 두 트랙 조율(프리즈 권장) — 계약이 바뀌면 양쪽 다 영향.
