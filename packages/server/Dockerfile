# @hmb/server 버전핀 이미지 (에픽 #32 · W3 AC3) — 게임외 시스템은 전부 고정 버전으로 재현성 확보.
#   node 20.19.6 (베이스) + lockfile(npm ci) + claude CLI 2.1.208 (정액제 executor 런타임).
#   엔진·shared 는 TS 소스로 소비(tsx 런타임) → 별도 빌드 없음.
#
# 빌드:  docker build -f packages/server/Dockerfile -t hmb-server:0.0.1 .
# 서버:  docker run -p 8787:8787 hmb-server:0.0.1                       # stub(오프라인)
# 워커:  docker run -e AI_EXECUTOR=claude-code \
#          -v hmb-claude-auth:/home/node/.claude \                     # 구독 로그인 볼륨(아래 인증 참고)
#          hmb-server:0.0.1 npm run worker --workspace @hmb/server
#
# ── 인증(정액제 구독) ──────────────────────────────────────────────
#   claude-code executor 는 ANTHROPIC_API_KEY 없이 로컬 `claude` 로그인(키체인/토큰)으로 정액제 과금.
#   → 컨테이너에 API 키를 넣지 말 것(넣으면 메터드 과금으로 샘). 대신 로그인 상태를 볼륨으로 주입:
#     1) 호스트에서 로그인:  docker run -it -v hmb-claude-auth:/home/node/.claude hmb-server:0.0.1 claude /login
#     2) 이후 워커 실행 시 같은 볼륨(-v hmb-claude-auth:/home/node/.claude)을 마운트하면 세션 재사용.
#   CLAUDE_CONFIG_DIR=/home/node/.claude 로 설정 위치를 고정(핀).
# ────────────────────────────────────────────────────────────────
FROM node:20.19.6-bookworm-slim

# claude CLI 버전 고정 — 재현 가능한 정액제 런타임(에픽 §W3, 배포 리스크 대응).
ARG CLAUDE_CLI_VERSION=2.1.208
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
  && claude --version

WORKDIR /app
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

# 1) 매니페스트만 먼저 복사 → 의존성 레이어 캐시.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev

# 2) 소스 복사(엔진·shared·server 는 TS 소스).
COPY packages/shared packages/shared
COPY packages/engine packages/engine
COPY packages/server packages/server

# 큐·캐시·인증 디렉토리 소유권(비루트 node 유저로 실행).
RUN mkdir -p /home/node/.claude /app/packages/server/.data \
  && chown -R node:node /home/node/.claude /app/packages/server/.data
USER node

ENV NODE_ENV=production
EXPOSE 8787

# /health 로 기동 확인(AC3). 컨테이너 오케스트레이터가 준비상태 판정.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 기본 = 게임서버(웹). 워커는 CMD 오버라이드(npm run worker).
CMD ["npm", "start", "--workspace", "@hmb/server"]
