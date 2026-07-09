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

## 구조 (S3b 진입점)
- `src/coach.ts` — `promptToTacticalInput(req)` **계약만 확정, 미구현**. ← 서버 트랙이 여기 채움:
  `@anthropic-ai/sdk` `client.messages.parse` + `zodOutputFormat(TacticalInput)`(structured output 강제),
  model `claude-sonnet-5`, 결과 `clampTacticalInput`. (PoC `packages/engine/poc` 가 같은 계약 검증 완료.)
- `src/pipeline.ts` — 코치 → `runMatch` (서버 권위 파이프라인).
- `src/index.ts` — `node:http` 엔트리 (`GET /health`, `POST /tactical`).

## 소유 경계 (병렬 개발)
- **서버 트랙**: `packages/server/**`, `Dockerfile`, 인프라. (이 패키지)
- **엔진 QA 트랙**: `packages/engine/**`. 서로 안 밟음.
- 공유 계약 `packages/shared/**` 변경은 두 트랙 조율(프리즈 권장) — 계약이 바뀌면 양쪽 다 영향.
